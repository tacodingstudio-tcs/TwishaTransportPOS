// =============================================================================
// apps/api/src/services/invoice.service.ts
//
// The heart of the billing platform.
// Every operation here is an atomic Postgres transaction.
// If ANY step fails, ALL steps roll back — no partial invoices, no
// stock deducted without an invoice, no party balance updated mid-air.
//
// Flow for createInvoice:
//   1. Validate domain_data via Zod (domain registry)
//   2. Fetch products to get HSN codes and GST rates
//   3. Determine inter-state vs intra-state (IGST vs CGST+SGST)
//   4. Calculate ALL amounts via gst-engine (deterministic, no AI)
//   5. BEGIN TRANSACTION:
//      a. Check stock availability
//      b. Generate invoice number (advisory lock)
//      c. INSERT invoice header
//      d. INSERT invoice line items
//      e. INSERT stock_ledger entries (debit for sales, credit for purchases)
//      f. UPDATE party.balance
//   6. COMMIT
//   7. Queue PDF generation job (outside transaction — non-critical)
// =============================================================================

import { Prisma } from '@billing/db'
import type { PrismaClient } from '@billing/db'
import { calculateInvoice, type GSTRate } from '@billing/gst-engine'
import { DOMAIN_REGISTRY } from '@billing/domain-registry'
import { nextInvoiceNumber } from '../lib/invoice-number.js'
import { pdfQueue } from '../lib/queues.js'
import { z } from 'zod'

// ── Input validation schemas ──────────────────────────────────────────────────

export const CreateInvoiceItemSchema = z.object({
  productId:   z.string().uuid().optional(),
  batchId:     z.string().uuid().optional(),
  description: z.string().min(1).max(500),
  qty:         z.coerce.number().positive(),
  unit:        z.string().default('pcs'),
  rate:        z.coerce.number().nonnegative(),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  gstRate:     z.coerce.number().min(0).max(100).default(0),
  gstExempt:   z.boolean().default(false),
  hsnSacCode:  z.string().nullable().optional().transform(v => v ?? undefined),
  itemMeta:    z.record(z.unknown()).default({}),
})

export const INVOICE_TXN_TYPES = [
  'sale_invoice', 'purchase_invoice', 'sale_return',
  'purchase_return', 'quotation', 'sales_order',
  'delivery_challan', 'proforma', 'credit_note', 'debit_note',
] as const

// Types that must carry a linkedInvoiceId referencing a parent document
const LINKED_REQUIRED = new Set(['credit_note', 'debit_note'])
// Delivery challan links to parent sale_invoice (optional but recommended)

export const CreateInvoiceSchema = z.object({
  txnType:         z.enum(INVOICE_TXN_TYPES),
  partyId:         z.string().uuid().nullable().optional().transform(v => v ?? undefined),
  linkedInvoiceId: z.string().uuid().nullable().optional().transform(v => v ?? undefined),
  date:            z.string().datetime().or(z.string().date()).optional(),
  dueDate:         z.string().datetime().or(z.string().date()).optional(),
  notes:           z.string().max(1000).optional(),
  domainData:      z.record(z.unknown()).default({}),
  aiMeta:          z.record(z.unknown()).default({}),
  items:           z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required'),
}).refine(
  (d) => !LINKED_REQUIRED.has(d.txnType) || !!d.linkedInvoiceId,
  { message: 'credit_note and debit_note must reference a linkedInvoiceId', path: ['linkedInvoiceId'] }
)

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>

export interface RequestCtx {
  db:               PrismaClient
  branchId:         string
  userId:           string
  role:             string
  schemaName:       string
  branchDomainType?: string
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface BranchInfo {
  id:         string
  stateCode:  string | null
  domainType: string
  domainConfig: Record<string, unknown>
}

interface PartyInfo {
  id:         string
  gstin:      string | null
  address:    unknown
}

// =============================================================================
// createInvoice
// =============================================================================
export async function createInvoice(
  input: CreateInvoiceInput,
  ctx: RequestCtx
) {
  // ── Step 1: Validate domain_data against domain-specific Zod schema ──────
  const domainRegistry = DOMAIN_REGISTRY[ctx.branchDomainType as keyof typeof DOMAIN_REGISTRY]
  if (!domainRegistry) {
    throw new Error(`Unknown domain type: ${ctx.branchDomainType}`)
  }

  // Strip common UI-only fields before domain-specific validation, then merge back
  const { is_udhaar, source, payment_splits, ...domainSpecific } = (input.domainData ?? {}) as Record<string, unknown>
  const domainDataParsed = {
    is_udhaar:      is_udhaar      ?? false,
    source:         source         ?? 'pos',
    payment_splits: payment_splits ?? undefined,
    ...domainRegistry.invoiceDataSchema.parse(domainSpecific),
  }

  // ── Step 2: Fetch branch and party info ───────────────────────────────────
  const branch = await ctx.db.branch.findUniqueOrThrow({
    where: { id: ctx.branchId },
    select: { id: true, stateCode: true, domainType: true, domainConfig: true },
  }) as BranchInfo

  let party: PartyInfo | null = null
  let isInterState = false

  if (input.partyId) {
    // A customer belongs to one firm (branch): billing another firm's customer would silently move that
    // firm's balance. (branchId null = legacy rows from before parties were scoped.)
    party = await (ctx.db.party as any).findFirst({
      where: { id: input.partyId, OR: [{ branchId: ctx.branchId }, { branchId: null }] },
      select: { id: true, gstin: true, address: true, balance: true, creditLimit: true } as any,
    })

    if (!party) throw new Error('Party not found')

    // Inter-state if party's state differs from branch's state

    const partyAddress = party.address as Record<string, string> | null
    const partyStateCode = partyAddress?.stateCode ?? null
    isInterState = !!(branch.stateCode && partyStateCode && branch.stateCode !== partyStateCode)
  }

  // ── Step 2b: Validate linkedInvoiceId existence and type compatibility ──────
  if (input.linkedInvoiceId) {
    const linked = await ctx.db.invoice.findFirst({
      where:  { id: input.linkedInvoiceId, branchId: ctx.branchId },
      select: { id: true, txnType: true, status: true },
    })
    if (!linked)
      throw Object.assign(
        new Error(`Linked invoice ${input.linkedInvoiceId} not found`),
        { statusCode: 404 }
      )
    if (linked.status === 'cancelled')
      throw Object.assign(
        new Error('Cannot reference a cancelled invoice'),
        { statusCode: 422 }
      )
    if (input.txnType === 'credit_note' && linked.txnType !== 'sale_invoice')
      throw Object.assign(
        new Error(`credit_note must reference a sale_invoice (got ${linked.txnType})`),
        { statusCode: 422 }
      )
    if (input.txnType === 'debit_note' && linked.txnType !== 'purchase_invoice' && linked.txnType !== 'sale_invoice')
      throw Object.assign(
        new Error(`debit_note must reference a purchase_invoice or a sale_invoice (got ${linked.txnType})`),
        { statusCode: 422 }
      )
  }

  // ── Step 3: Fetch product details for each line item ──────────────────────
  const productIds = input.items
    .filter((i) => i.productId)
    .map((i) => i.productId!)

  // Lines without a product (every transport / service bill) need no lookup — and a lean tenant has no products table at all.
  const products = productIds.length === 0 ? [] : await ctx.db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, hsnSacCode: true, gstRate: true, gstExempt: true, unit: true, domainAttrs: true, trackStock: true },
  })

  const productMap = new Map(products.map((p) => [p.id, p]))

  // ── Step 4: Enrich items with product data + calculate GST ───────────────
  const enrichedItems = input.items.map((item) => {
    const product = item.productId ? productMap.get(item.productId) : null

    return {
      ...item,
      description: item.description || product?.name || 'Item',
      hsnSacCode:  item.hsnSacCode  || product?.hsnSacCode  || null,
      gstRate:     item.gstRate     ?? Number(product?.gstRate ?? 0),
      gstExempt:   item.gstExempt   ?? product?.gstExempt   ?? false,
      unit:        item.unit        || product?.unit         || 'pcs',
      trackStock:  product?.trackStock ?? true,
    }
  })

  // GST calculation — deterministic rule engine, never AI
  const calc = calculateInvoice(
    enrichedItems.map((item) => ({
      qty:         item.qty,
      rate:        item.rate,
      discountPct: item.discountPct,
      gstRate:     item.gstRate as GSTRate,
      gstExempt:   item.gstExempt,
      isInterState,
      // a trading firm's goods bill (and a note against one) rounds CGST and SGST separately, like its paper invoice
      eachTaxRounded: (input.domainData as Record<string, unknown> | undefined)?.['bill_kind'] === 'goods_sale'
        || (input.domainData as Record<string, unknown> | undefined)?.['parent_kind'] === 'goods',
    }))
  )

  // ── Step 4b: Credit limit pre-flight (fast rejection before tx overhead) ───
  // Uses the balance read at step 2 — not the race guard, just a quick check
  // for obviously over-limit requests. The definitive locked check is at 5h.
  if (input.txnType === 'sale_invoice' && party) {
    const p           = party as any
    const creditLimit = Number(p.creditLimit ?? 0)
    if (creditLimit > 0) {
      const currentBalance = Number(p.balance ?? 0)
      if (currentBalance + calc.grandTotal > creditLimit) {
        const err: any = new Error(
          `Credit limit exceeded. Limit: ₹${creditLimit}, ` +
          `Current balance: ₹${currentBalance.toFixed(2)}, ` +
          `Invoice amount: ₹${calc.grandTotal.toFixed(2)}`
        )
        err.statusCode = 422
        err.code = 'CREDIT_LIMIT_EXCEEDED'
        throw err
      }
    }
  }

  // ── Step 5: Atomic transaction ────────────────────────────────────────────
  const invoice = await ctx.db.$transaction(
    async (tx) => {
      // 5a. Stock availability check — only for outgoing stock movements
      if (input.txnType === 'sale_invoice' || input.txnType === 'delivery_challan') {
        await checkStockAvailability(tx, enrichedItems, ctx)
      }

      // 5b. Generate invoice number (uses advisory lock inside)
      const number = await nextInvoiceNumber(tx, ctx.branchId, input.txnType)

      // 5c. Status: proforma and quotation are not financially confirmed
      const status = (input.txnType === 'proforma' || input.txnType === 'quotation')
        ? 'draft'
        : 'confirmed'

      // 5d. Create invoice header
      const createdInvoice = await tx.invoice.create({
        data: {
          branchId:        ctx.branchId,
          partyId:         input.partyId ?? null,
          linkedInvoiceId: input.linkedInvoiceId ?? null,
          createdBy:       ctx.userId,
          txnType:         input.txnType,
          number,
          date:        input.date ? new Date(input.date) : new Date(),
          dueDate:     input.dueDate ? new Date(input.dueDate) : null,
          status,
          subtotal:    calc.subtotal,
          discountAmt: calc.discountTotal,
          taxableAmt:  calc.taxableTotal,
          cgstTotal:   calc.cgstTotal,
          sgstTotal:   calc.sgstTotal,
          igstTotal:   calc.igstTotal,
          roundOff:    calc.roundOff,
          grandTotal:  calc.grandTotal,
          paidAmt:     0,
          notes:       input.notes ?? null,
          domainData:  domainDataParsed as never,
          aiMeta:      input.aiMeta as never,
        },
      })

      // 5e. Create line items
      await tx.invoiceItem.createMany({
        data: calc.lines.map((line, idx) => {
          const item = enrichedItems[idx]!
          return {
            invoiceId:   createdInvoice.id,
            productId:   item.productId ?? null,
            batchId:     item.batchId   ?? null,
            description: item.description,
            hsnSacCode:  item.hsnSacCode ?? null,
            qty:         item.qty,
            unit:        item.unit,
            rate:        item.rate,
            discountPct: item.discountPct,
            discountAmt: line.discountAmt,
            taxableAmt:  line.taxableAmt,
            gstRate:     line.gstRate,
            cgstAmt:     line.cgstAmt,
            sgstAmt:     line.sgstAmt,
            igstAmt:     line.igstAmt,
            total:       line.total,
            sortOrder:   idx,
            itemMeta:    (item.itemMeta ?? {}) as never,
          }
        }),
      })

      // 5g. Update stock ledger
      // proforma / quotation / sales_order = commitment only, no physical movement
      const skipStock = ['proforma', 'quotation', 'sales_order'].includes(input.txnType)
      if (!skipStock) {
        await updateStockLedger(tx, createdInvoice.id, enrichedItems, input.txnType, ctx)
      }

      // 5h. Update party balance — with definitive locked credit-limit check
      //   proforma/quotation: no financial commitment yet
      //   delivery_challan: parent sale_invoice already charged the party
      const skipBalance = ['proforma', 'quotation', 'delivery_challan'].includes(input.txnType)
      if (input.partyId && !skipBalance) {
        // Lock the party row for the duration of this transaction.
        // Two concurrent sale_invoices for the same party can both read
        // balance = 9500 (limit 10000) at step 2, both compute 9900 < 10000,
        // both pass the pre-flight, and both commit — net balance 10300.
        // FOR UPDATE serialises them: the second waits until the first commits,
        // then reads the already-updated balance before checking the limit.
        const partyRows = await tx.$queryRaw<Array<{
          balance:      number
          credit_limit: number
        }>>`
          SELECT
            "balance"::float                        AS balance,
            COALESCE("creditLimit", 0)::float       AS credit_limit
          FROM parties
          WHERE id = ${input.partyId}::uuid
          FOR UPDATE
        `
        const p = partyRows[0]
        if (p && p.credit_limit > 0 && input.txnType === 'sale_invoice') {
          if (p.balance + calc.grandTotal > p.credit_limit) {
            const err: any = new Error(
              `Credit limit exceeded. Limit: ₹${p.credit_limit}, ` +
              `Current balance: ₹${p.balance.toFixed(2)}, ` +
              `Invoice amount: ₹${calc.grandTotal.toFixed(2)}`
            )
            err.statusCode = 422
            err.code = 'CREDIT_LIMIT_EXCEEDED'
            throw err
          }
        }
        await updatePartyBalance(tx, input.partyId, calc.grandTotal, input.txnType)
      }

      return createdInvoice
    },
    {
      maxWait: 5000,  // ms to wait for a connection from pool
      timeout: 10000, // ms before transaction is killed
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    }
  )

  // ── Step 6: Handle split payments if provided in domainData ─────────────
  const paymentSplits = (domainDataParsed as Record<string, unknown>).payment_splits as
    Array<{ method: string; amount: number }> | undefined
  if (paymentSplits?.length && invoice.txnType === 'sale_invoice') {
    const validMethods = new Set(['cash', 'upi', 'card', 'cheque', 'bank_transfer', 'credit'])
    const totalSplit = paymentSplits.reduce((s, p) => s + p.amount, 0)
    const paidMethods = paymentSplits.filter(p => p.method !== 'credit' && p.amount > 0 && validMethods.has(p.method))
    if (paidMethods.length > 0) {
      for (const split of paidMethods) {
        const payment = await ctx.db.payment.create({
          data: {
            branchId:    ctx.branchId,
            partyId:     invoice.partyId ?? null,
            amount:      split.amount,
            method:      split.method,
            type:        'receipt',
            status:      'active',
            paymentDate: new Date(),
            refNo:       null,
            notes:       `Split payment (${split.method})`,
            createdBy:   ctx.userId,
          },
        })
        await ctx.db.paymentAllocation.create({
          data: { paymentId: payment.id, invoiceId: invoice.id, amount: split.amount },
        })
      }
      const paidAmt = paidMethods.reduce((s, p) => s + p.amount, 0)
      const newStatus = paidAmt >= Number(invoice.grandTotal) - 0.01 ? 'paid' : 'partial'
      await ctx.db.invoice.update({
        where: { id: invoice.id },
        data:  { paidAmt, status: newStatus },
      })
      if (invoice.partyId) {
        await ctx.db.party.update({
          where: { id: invoice.partyId },
          data:  { balance: { decrement: paidAmt } },
        })
      }
    }
  }

  // ── Step 7: Queue PDF generation (outside transaction — failure is ok) ────
  await pdfQueue
    .add('generate-pdf', {
      invoiceId:  invoice.id,
      branchId:   ctx.branchId,
      schemaName: ctx.schemaName,
    })
    .catch((err) => console.warn('[PDF Queue] Failed to queue:', err.message))

  // ── Step 7: Low-stock notifications after sale ────────────────────────────
  // Check if any sold product crossed its reorder point. Non-blocking.
  if (input.txnType === 'sale_invoice' || input.txnType === 'delivery_challan') {
    checkLowStock(ctx, enrichedItems).catch(() => {/* non-critical */})
  }

  // ── Step 7: Return full invoice with items ────────────────────────────────
  return getInvoiceWithItems(ctx.db, invoice.id, ctx.branchId)
}

// =============================================================================
// getInvoiceWithItems
// =============================================================================
export async function getInvoiceWithItems(db: PrismaClient, invoiceId: string, branchId: string) {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, branchId },
    include: {
      items: { orderBy: { sortOrder: 'asc' } },
      party: { select: { id: true, name: true, phone: true, gstin: true, pan: true, address: true } },
      createdByUser: { select: { id: true, name: true } },
    },
  })

  if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
  // Attach each line's product only when a line has one (a lean tenant has no products table; its bills have none).
  const pids = [...new Set(invoice.items.map((i) => i.productId).filter((x): x is string => !!x))]
  if (pids.length === 0) return { ...invoice, items: invoice.items.map((i) => ({ ...i, product: null })) }
  const prods = await db.product.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, unit: true } })
  const byId = new Map(prods.map((p) => [p.id, p]))
  return { ...invoice, items: invoice.items.map((i) => ({ ...i, product: i.productId ? byId.get(i.productId) ?? null : null })) }
}

// =============================================================================
// listInvoices
// =============================================================================
export async function listInvoices(
  ctx: RequestCtx,
  filters: {
    txnType?:  string
    status?:   string
    partyId?:  string
    fromDate?: string
    toDate?:   string
    search?:   string
    page?:     number
    after?:    string   // cursor: id of the last bill of the previous page (position-based paging)
    limit?:    number
  }
) {
  const page  = Math.max(1, filters.page  ?? 1)
  const limit = Math.min(100, filters.limit ?? 20)
  const skip  = (page - 1) * limit

  const where: Prisma.InvoiceWhereInput = {
    branchId: ctx.branchId,
    ...(filters.txnType  && { txnType: filters.txnType }),
    ...(filters.status   && { status:  filters.status  }),
    ...(filters.partyId  && { partyId: filters.partyId }),
    ...(filters.fromDate || filters.toDate
      ? {
          date: {
            ...(filters.fromDate && { gte: new Date(filters.fromDate) }),
            ...(filters.toDate   && { lte: new Date(filters.toDate)   }),
          },
        }
      : {}),
    // Prefix-only search so Postgres can use the B-tree index on `number`
    // and a standard index on party.name. `contains` generates ILIKE '%q%'
    // which forces a seq-scan on every keystroke; `startsWith` generates
    // ILIKE 'q%' which is index-compatible.
    ...(filters.search && {
      OR: [
        { number: { startsWith: filters.search, mode: 'insensitive' } },
        { party:  { name: { startsWith: filters.search, mode: 'insensitive' } } },
      ],
    }),
  }

  // Position-based paging: with `after` the database jumps to that bill and reads on from there (same speed on any page, no count);
  // without it, the first page / a page number works as before. One extra row tells us whether another page exists.
  const [fetched, total] = await Promise.all([
    ctx.db.invoice.findMany({
      where,
      select: {
        id: true, number: true, txnType: true, date: true,
        status: true, grandTotal: true, paidAmt: true, domainData: true,
        party: { select: { id: true, name: true, phone: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],      // a total order, so pages never repeat or skip a bill
      ...(filters.after ? { cursor: { id: filters.after }, skip: 1 } : { skip }),
      take: limit + 1,
    }),
    filters.after ? Promise.resolve(null) : ctx.db.invoice.count({ where }),
  ])
  const more = fetched.length > limit
  const invoices = fetched.slice(0, limit)

  return {
    data: invoices,
    meta: {
      page, limit, nextCursor: more ? invoices[invoices.length - 1]!.id : null,
      ...(total != null ? { total, totalPages: Math.ceil(total / limit) } : {}),
    },
  }
}

// =============================================================================
// cancelInvoice
// Reverses stock movements and party balance — also in one transaction
// =============================================================================
export async function cancelInvoice(invoiceId: string, ctx: RequestCtx) {
  // Pre-fetch items outside the transaction — they are immutable after creation.
  // Status is re-read inside the transaction under a row lock (see below).
  const invoice = await ctx.db.invoice.findFirst({
    where:   { id: invoiceId, branchId: ctx.branchId },
    include: { items: true },
  })

  if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })

  // Fast pre-flight (definitive check is the FOR UPDATE inside the tx)
  if (invoice.status === 'cancelled')
    throw Object.assign(new Error('Invoice already cancelled'), { statusCode: 409 })
  if (invoice.status === 'paid')
    throw Object.assign(new Error('Cannot cancel a fully paid invoice'), { statusCode: 422 })
  if (invoice.status === 'partial')
    throw Object.assign(
      new Error(
        `Cannot cancel a partially paid invoice ` +
        `(₹${invoice.paidAmt.toNumber().toFixed(2)} already received). ` +
        `Void all payments against this invoice first, then cancel.`
      ),
      { statusCode: 422, code: 'PARTIAL_PAYMENT_EXISTS' }
    )

  // A bill with credit / debit notes against it keeps them honest: cancel those first.
  if (invoice.txnType === 'sale_invoice') {
    const live = await ctx.db.invoice.count({
      where: { linkedInvoiceId: invoice.id, branchId: ctx.branchId, txnType: { in: ['credit_note', 'debit_note'] }, status: { not: 'cancelled' } },
    })
    if (live > 0)
      throw Object.assign(
        new Error(`This bill has ${live} credit / debit note${live === 1 ? '' : 's'} against it — cancel ${live === 1 ? 'that note' : 'those notes'} first.`),
        { statusCode: 409, code: 'NOTES_EXIST' }
      )
  }

  // Whether this txnType created stock or party-balance entries on creation.
  // Mirrors the skipStock / skipBalance guards in createInvoice so we only
  // reverse what was actually written.
  const hadStock   = !['proforma', 'quotation', 'sales_order'].includes(invoice.txnType)
  const hadBalance = !['proforma', 'quotation', 'delivery_challan'].includes(invoice.txnType)

  await ctx.db.$transaction(async (tx) => {
    // Lock the invoice row.
    // Without this, two concurrent cancel requests both read status='confirmed'
    // outside the tx, both pass the pre-flight, both enter here and both run
    // the stock reversal and balance adjustment — doubling the effect.
    // A concurrent recordPayment that commits between our findFirst and here
    // would also be caught: the locked row reveals the updated 'partial' status.
    const locked = await tx.$queryRaw<Array<{
      status:      string
      paid_amt:    number
      grand_total: number
    }>>`
      SELECT status, "paidAmt"::float AS paid_amt, "grandTotal"::float AS grand_total
      FROM invoices
      WHERE id        = ${invoiceId}::uuid
        AND "branchId" = ${ctx.branchId}::uuid
      FOR UPDATE
    `
    const cur = locked[0]
    if (!cur) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
    if (cur.status === 'cancelled')
      throw Object.assign(new Error('Invoice already cancelled'), { statusCode: 409 })
    if (cur.status === 'paid')
      throw Object.assign(new Error('Cannot cancel a fully paid invoice'), { statusCode: 422 })
    if (cur.status === 'partial')
      throw Object.assign(
        new Error(
          `Cannot cancel a partially paid invoice ` +
          `(₹${cur.paid_amt.toFixed(2)} already received). ` +
          `Void all payments against this invoice first, then cancel.`
        ),
        { statusCode: 422, code: 'PARTIAL_PAYMENT_EXISTS' }
      )

    // outstanding = grandTotal - paidAmt (defensive; should be 0 for confirmed/draft)
    const outstanding = cur.grand_total - cur.paid_amt

    // Reverse stock movements — only for types that wrote stock on creation.
    // Stock direction uses stockOutTypes (same set as createInvoice) so the
    // sign is always the exact opposite of what was written.
    //   stockOut (sale/delivery/purchase_return/debit_note) → reversal is +qty (stock back in)
    //   stockIn  (purchase/sale_return/credit_note)         → reversal is -qty (stock goes out)
    if (hadStock && invoice.items.some((item) => item.productId)) {
      await tx.stockLedger.createMany({
        data: invoice.items
          .filter((item) => item.productId)
          .map((item) => ({
            branchId:  ctx.branchId,
            productId: item.productId!,
            batchId:   item.batchId ?? null,
            txnType:   stockOutTypes.has(invoice.txnType) ? 'sale_return' : 'purchase_return',
            qty:       item.qty.toNumber() * (stockOutTypes.has(invoice.txnType) ? 1 : -1),
            rate:      item.rate.toNumber(),
            refType:   'invoice_cancel',
            refId:     invoice.id,
          })),
      })
    }

    // Reverse party balance — only for types that charged the party on creation,
    // and only the outstanding portion (paidAmt was already settled via payments).
    // Uses balanceDeltaSign() to get the exact opposite sign of what createInvoice
    // applied — fixing the old isSale() bug where credit_note/delivery_challan
    // reversals used the wrong sign.
    if (hadBalance && invoice.partyId && outstanding !== 0) {
      const sign = balanceDeltaSign(invoice.txnType)
      if (sign !== 0) {
        await tx.party.update({
          where: { id: invoice.partyId },
          data:  { balance: { increment: -sign * outstanding } },
        })
      }
    }

    // A credit note that was set against its bill's outstanding gives that amount back to the bill.
    if (invoice.txnType === 'credit_note' && invoice.linkedInvoiceId) {
      const applied = Number((invoice.domainData as Record<string, unknown> | null)?.['applied_to_bill'] ?? 0)
      if (applied > 0) {
        await tx.$executeRaw`
          UPDATE invoices
          SET "paidAmt" = GREATEST("paidAmt" - ${applied}::numeric, 0),
              status    = CASE WHEN "paidAmt" - ${applied}::numeric <= 0.01 THEN 'confirmed' ELSE 'partial' END
          WHERE id = ${invoice.linkedInvoiceId}::uuid AND "branchId" = ${ctx.branchId}::uuid AND status <> 'cancelled'
        `
      }
    }

    // Mark cancelled with audit trail
    await tx.invoice.update({
      where: { id: invoiceId, branchId: ctx.branchId },
      data:  {
        status:      'cancelled',
        cancelledBy: ctx.userId,
        cancelledAt: new Date(),
      },
    })
  }, {
    maxWait: 5000,
    timeout: 10000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })

  return { success: true, invoiceId }
}

// =============================================================================
// recordPayment
// Records a payment and allocates it against an invoice
// =============================================================================
export const RecordPaymentSchema = z.object({
  invoiceId:   z.string().uuid(),
  amount:      z.number().positive(),
  method:      z.enum(['cash','upi','card','cheque','bank_transfer','credit','tds']),
  refNo:       z.string().optional(),
  paymentDate: z.string().optional(),
  notes:       z.string().optional(),
})

export async function recordPayment(
  input: z.infer<typeof RecordPaymentSchema>,
  ctx: RequestCtx
) {
  return ctx.db.$transaction(async (tx) => {
    // Lock the invoice row for the duration of this transaction.
    // Without FOR UPDATE, two concurrent payments for the same invoice both
    // read paidAmt = 0, pass the overpayment check independently, and both
    // commit — leaving paidAmt = 2× grandTotal. FOR UPDATE makes the second
    // request wait until the first transaction commits before it can read,
    // so the second request sees the already-updated paidAmt and is rejected.
    const rows = await tx.$queryRaw<Array<{
      id:          string
      grand_total: number
      paid_amt:    number
      status:      string
      party_id:    string | null
      txn_type:    string
      linked_type: string | null
    }>>`
      SELECT
        id,
        "grandTotal"::float  AS grand_total,
        "paidAmt"::float     AS paid_amt,
        status,
        "partyId"::text      AS party_id,
        "txnType"            AS txn_type,
        (SELECT l."txnType" FROM invoices l WHERE l.id = invoices."linkedInvoiceId") AS linked_type
      FROM invoices
      WHERE id        = ${input.invoiceId}::uuid
        AND "branchId" = ${ctx.branchId}::uuid
      FOR UPDATE
    `

    const invoice = rows[0]
    if (!invoice) {
      const err: any = new Error('Invoice not found')
      err.statusCode = 404
      throw err
    }
    if (invoice.status === 'cancelled') {
      const err: any = new Error('Cannot pay a cancelled invoice')
      err.statusCode = 422
      throw err
    }

    const grandTotal  = invoice.grand_total
    const alreadyPaid = invoice.paid_amt
    const maxPayable  = grandTotal - alreadyPaid

    if (input.amount > maxPayable + 0.01) {
      const err: any = new Error(
        `Payment ₹${input.amount} exceeds outstanding balance ₹${maxPayable.toFixed(2)}`
      )
      err.statusCode = 422
      throw err
    }

    // Create payment record
    const payment = await tx.payment.create({
      data: {
        branchId:    ctx.branchId,
        partyId:     invoice.party_id,
        amount:      input.amount,
        method:      input.method,
        type:        'receipt',
        refNo:       input.refNo ?? null,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        notes:       input.notes ?? null,
        createdBy:   ctx.userId,
        status:      'active',
      },
    })

    // Allocate payment to invoice
    await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        invoiceId: invoice.id,
        amount:    input.amount,
      },
    })

    // Update invoice paid amount and status
    const newPaidAmt = alreadyPaid + input.amount
    const newStatus  = newPaidAmt >= grandTotal - 0.01 ? 'paid' : 'partial'

    await tx.invoice.update({
      where: { id: invoice.id },
      data:  { paidAmt: newPaidAmt, status: newStatus },
    })

    // Adjust party balance in the correct direction based on invoice type.
    // sale_invoice: customer paid us → they owe us less → decrement
    // purchase_invoice: we paid supplier → we owe them less → increment (toward 0)
    // sale_return / credit_note: we refund customer → they owe us more again → increment
    // purchase_return / debit_note: supplier refunds us → we owe them more → decrement
    if (invoice.party_id) {
      // A debit note against a customer's SALE bill is money the customer owes us, so a receipt on it
      // lowers the balance like any sale. Only purchase-side debit notes are money out.
      const isPaymentOut    = invoice.txn_type === 'purchase_invoice' || (invoice.txn_type === 'debit_note' && invoice.linked_type !== 'sale_invoice')
      await tx.party.update({
        where: { id: invoice.party_id },
        data:  isPaymentOut
          ? { balance: { increment: input.amount } }
          : { balance: { decrement: input.amount } },
      })
    }

    return { payment, invoiceStatus: newStatus, remainingBalance: grandTotal - newPaidAmt }
  }, {
    maxWait: 5000,
    timeout: 10000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}

// =============================================================================
// Private helpers
// =============================================================================

async function checkStockAvailability(
  tx: Prisma.TransactionClient,
  items: Array<{ productId?: string; qty: number; description: string }>,
  ctx: RequestCtx
) {
  const itemsToCheck = items.filter((i) => i.productId && (i as any).trackStock !== false)
  if (itemsToCheck.length === 0) return

  const productIds = itemsToCheck.map((i) => i.productId!)
  // Sort so every concurrent transaction acquires product locks in the same
  // order — prevents deadlocks when two transactions check overlapping sets.
  const sortedIds  = [...productIds].sort()

  // Lock product rows first. Two concurrent sale_invoice transactions that
  // both read stock_ledger before either commits their INSERT will both see
  // the same on-hand qty and both approve the sale — causing negative stock.
  // The second transaction blocks here until the first commits its
  // stock_ledger entries, then reads the updated aggregate.
  await tx.$queryRaw`
    SELECT id FROM products
    WHERE id = ANY(${sortedIds}::uuid[])
    ORDER BY id
    FOR UPDATE
  `

  const rows = await tx.$queryRaw<Array<{ product_id: string; qty_on_hand: number }>>`
    SELECT
      "productId"::text            AS product_id,
      COALESCE(SUM(qty), 0)::float AS qty_on_hand
    FROM stock_ledger
    WHERE "branchId"  = ${ctx.branchId}::uuid
      AND "productId" = ANY(${productIds}::uuid[])
    GROUP BY "productId"
  `

  const stockMap = new Map(rows.map((r) => [r.product_id, Number(r.qty_on_hand)]))

  for (const item of itemsToCheck) {
    const onHand = stockMap.get(item.productId!) ?? 0
    if (onHand < item.qty) {
      throw new Error(
        `Insufficient stock for "${item.description}": ` +
        `${onHand} available, ${item.qty} requested`
      )
    }
  }
}

async function updateStockLedger(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  items: Array<{ productId?: string; batchId?: string; qty: number; rate: number }>,
  txnType: string,
  ctx: RequestCtx
) {
  const stockItems = items.filter((i) => i.productId)
  if (stockItems.length === 0) return

  // Stock direction:
  //   sale_invoice / delivery_challan → stock out (-1)
  //   purchase_invoice                → stock in  (+1)
  //   sale_return / credit_note       → stock back in (+1) — customer returns goods
  //   purchase_return / debit_note    → stock out   (-1) — we return to supplier
  const qtySign = stockOutTypes.has(txnType) ? -1 : 1
  const ledgerType = stockOutTypes.has(txnType) ? 'sale' : 'purchase'

  await tx.stockLedger.createMany({
    data: stockItems.map((item) => ({
      branchId:  ctx.branchId,
      productId: item.productId!,
      batchId:   item.batchId ?? null,
      txnType:   ledgerType,
      qty:       item.qty * qtySign,
      rate:      item.rate,
      refType:   'invoice',
      refId:     invoiceId,
    })),
  })
}

async function updatePartyBalance(
  tx: Prisma.TransactionClient,
  partyId: string,
  grandTotal: number,
  txnType: string,
) {
  // Party balance semantics: positive = customer owes us, negative = we owe supplier
  //   sale_invoice  → customer owes more        → +grandTotal
  //   credit_note   → we credit the customer     → -grandTotal
  //   purchase_invoice → we owe supplier more   → -grandTotal
  //   debit_note    → supplier owes us           → +grandTotal
  //   sale_return   → reduce what customer owes  → -grandTotal
  //   purchase_return → reduce what we owe       → +grandTotal
  let delta: number
  switch (txnType) {
    case 'sale_invoice':    delta = +grandTotal;  break
    case 'credit_note':
    case 'sale_return':     delta = -grandTotal;  break
    case 'purchase_invoice': delta = -grandTotal; break
    case 'debit_note':
    case 'purchase_return': delta = +grandTotal;  break
    default:                delta = 0;            break
  }

  if (delta !== 0) {
    await tx.party.update({
      where: { id: partyId },
      data: { balance: { increment: delta } },
    })
  }
}

const stockOutTypes = new Set([
  'sale_invoice', 'delivery_challan', 'purchase_return', 'debit_note',
])

// Returns the sign (+1 or -1) that updatePartyBalance applies to party.balance
// for this txnType, or 0 if the type never touches party balance.
// Used in cancelInvoice to apply the exact opposite sign.
function balanceDeltaSign(txnType: string): number {
  switch (txnType) {
    case 'sale_invoice':     return +1
    case 'credit_note':
    case 'sale_return':      return -1
    case 'purchase_invoice': return -1
    case 'debit_note':
    case 'purchase_return':  return +1
    default:                 return  0  // proforma, quotation, delivery_challan etc.
  }
}

// ── Low-stock notification helper ─────────────────────────────────────────────
// Runs outside the invoice transaction. For each sold product that has a
// reorderLevel set, checks if current stock is now at or below that level.
// Creates a Notification row so the owner sees it in the app immediately.
async function checkLowStock(
  ctx:   RequestCtx,
  items: Array<{ productId?: string; description: string }>,
): Promise<void> {
  const productIds = items.filter((i) => i.productId).map((i) => i.productId!)
  if (productIds.length === 0) return

  // Query 1: products that have a low-stock threshold configured
  const products = await ctx.db.product.findMany({
    where:  { id: { in: productIds }, trackStock: true, lowStockQty: { gt: 0 } },
    select: { id: true, name: true, lowStockQty: true },
  })
  if (products.length === 0) return

  // Query 2: on-hand qty for all tracked products in one shot (was N queries)
  const trackedIds = products.map((p) => p.id)
  const stockRows  = await ctx.db.$queryRaw<Array<{ product_id: string; qty_on_hand: number }>>`
    SELECT
      "productId"::text            AS product_id,
      COALESCE(SUM(qty), 0)::float AS qty_on_hand
    FROM stock_ledger
    WHERE "branchId"  = ${ctx.branchId}::uuid
      AND "productId" = ANY(${trackedIds}::uuid[])
    GROUP BY "productId"
  `
  const stockMap = new Map(stockRows.map((r) => [r.product_id, Number(r.qty_on_hand)]))

  const belowThreshold = products.filter(
    (p) => (stockMap.get(p.id) ?? 0) <= Number(p.lowStockQty)
  )
  if (belowThreshold.length === 0) return

  // Query 3: which products already have a notification today (was N queries)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const existingNotifs = await ctx.db.notification.findMany({
    where:  { branchId: ctx.branchId, type: 'low_stock', createdAt: { gte: today } },
    select: { payload: true },
  })
  const notifiedToday = new Set(
    existingNotifs.map((n) => (n.payload as any)?.productId).filter(Boolean)
  )

  const toCreate = belowThreshold
    .filter((p) => !notifiedToday.has(p.id))
    .map((product) => {
      const onHand    = stockMap.get(product.id) ?? 0
      const threshold = Number(product.lowStockQty)
      return {
        branchId: ctx.branchId,
        type:     'low_stock' as const,
        title:    `Low stock — ${product.name}`,
        body:     `Only ${onHand} units remaining (threshold: ${threshold})`,
        payload:  { productId: product.id, onHand, threshold } as any,
      }
    })

  if (toCreate.length > 0) {
    await ctx.db.notification.createMany({ data: toCreate })
  }
}

// =============================================================================
// convertInvoice — Quotation → Sales Order → Delivery Challan → Sale Invoice
//                  Proforma → Sale Invoice
// =============================================================================

const CONVERSION_MAP: Record<string, string> = {
  quotation:        'sales_order',
  sales_order:      'sale_invoice',   // or delivery_challan if shipping first
  proforma:         'sale_invoice',
  delivery_challan: 'sale_invoice',
}

export async function convertInvoice(
  id:         string,
  targetType: string | undefined,
  ctx:        RequestCtx,
) {
  const source = await ctx.db.invoice.findFirst({
    where: { id, branchId: ctx.branchId },
    include: { items: true },
  })
  if (!source) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
  if (source.status === 'cancelled')
    throw Object.assign(new Error('Cannot convert a cancelled document'), { statusCode: 400 })
  if (source.status === 'converted')
    throw Object.assign(new Error('This document has already been converted'), { statusCode: 409 })

  const auto = CONVERSION_MAP[source.txnType]
  if (!auto && !targetType)
    throw Object.assign(new Error(`${source.txnType} cannot be converted`), { statusCode: 400 })

  const newType = targetType ?? auto

  // Idempotency: if a non-cancelled invoice of the target type already exists
  // linked to this source (from a previous attempt that succeeded but whose
  // response was lost), return it rather than creating a duplicate.
  const existingConversion = await ctx.db.invoice.findFirst({
    where: {
      linkedInvoiceId: source.id,
      branchId:        ctx.branchId,
      txnType:         newType,
      status:          { not: 'cancelled' },
    },
  })
  if (existingConversion) {
    return getInvoiceWithItems(ctx.db, existingConversion.id, ctx.branchId)
  }

  // Build new invoice input from source
  const items = source.items.map((i: any) => ({
    productId:   i.productId   ?? undefined,
    batchId:     i.batchId     ?? undefined,
    description: i.description,
    qty:         Number(i.qty),
    unit:        i.unit,
    rate:        Number(i.rate),
    discountPct: Number(i.discountPct),
    gstRate:     Number(i.gstRate),
    gstExempt:   false,
    hsnSacCode:  i.hsnSacCode ?? undefined,
    itemMeta:    (i.itemMeta as Record<string, unknown>) ?? {},
  }))

  // Fetch branch domain type
  const branch = await ctx.db.branch.findUniqueOrThrow({
    where: { id: ctx.branchId }, select: { domainType: true },
  })

  const newInput = {
    txnType:         newType as typeof INVOICE_TXN_TYPES[number],
    partyId:         source.partyId  ?? undefined,
    linkedInvoiceId: source.id,
    date:            new Date().toISOString().split('T')[0],
    dueDate:         source.dueDate?.toISOString().split('T')[0],
    notes:           source.notes    ?? undefined,
    domainData:      (source.domainData as Record<string, unknown>) ?? {},
    aiMeta:          {},
    items,
  }

  const converted = await createInvoice(newInput, {
    ...ctx,
    branchDomainType: branch.domainType,
  })

  // Mark source as converted using updateMany so a concurrent conversion that
  // also passed the existingConversion check cannot double-mark.
  await ctx.db.invoice.updateMany({
    where: { id: source.id, branchId: ctx.branchId, status: { not: 'converted' } },
    data:  { status: 'converted' },
  })

  return converted
}

// =============================================================================
// approveInvoice / rejectInvoice — Approval workflow
// =============================================================================

export async function approveInvoice(
  id:   string,
  note: string | undefined,
  ctx:  RequestCtx,
) {
  // updateMany with approvalStatus = 'pending' in the WHERE is an atomic
  // read-check-write: if two approvers race, only one will match the row
  // (the other sees count = 0) — no separate findFirst needed.
  const { count } = await ctx.db.invoice.updateMany({
    where: { id, branchId: ctx.branchId, approvalStatus: 'pending' },
    data: {
      approvalStatus: 'approved',
      approvedBy:     ctx.userId,
      approvedAt:     new Date(),
      approvalNote:   note ?? null,
    },
  })

  if (count === 0) {
    // Distinguish "not found" from "already actioned" for the client
    const exists = await ctx.db.invoice.findFirst({
      where:  { id, branchId: ctx.branchId },
      select: { approvalStatus: true },
    })
    if (!exists)
      throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
    throw Object.assign(
      new Error(`Invoice is not pending approval (current status: ${exists.approvalStatus})`),
      { statusCode: 409 }
    )
  }

  return ctx.db.invoice.findFirst({
    where:  { id, branchId: ctx.branchId },
    select: { id: true, approvalStatus: true, approvedBy: true, approvedAt: true },
  })
}

export async function rejectInvoice(
  id:   string,
  note: string,
  ctx:  RequestCtx,
) {
  const { count } = await ctx.db.invoice.updateMany({
    where: { id, branchId: ctx.branchId, approvalStatus: 'pending' },
    data: {
      approvalStatus: 'rejected',
      approvedBy:     ctx.userId,
      approvedAt:     new Date(),
      approvalNote:   note,
      status:         'cancelled',
    },
  })

  if (count === 0) {
    const exists = await ctx.db.invoice.findFirst({
      where:  { id, branchId: ctx.branchId },
      select: { approvalStatus: true },
    })
    if (!exists)
      throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
    throw Object.assign(
      new Error(`Invoice is not pending approval (current status: ${exists.approvalStatus})`),
      { statusCode: 409 }
    )
  }

  return ctx.db.invoice.findFirst({
    where:  { id, branchId: ctx.branchId },
    select: { id: true, approvalStatus: true, approvalNote: true },
  })
}

export async function requestApproval(id: string, ctx: RequestCtx) {
  // Guard: do not reset approvalStatus on an already-approved or rejected invoice.
  // The old findFirst + update pattern had no such guard — any user could POST
  // to this endpoint and un-approve an invoice that a manager had already cleared.
  const { count } = await ctx.db.invoice.updateMany({
    where: { id, branchId: ctx.branchId, approvalStatus: { notIn: ['approved', 'rejected'] } },
    data:  { approvalStatus: 'pending' },
  })

  if (count === 0) {
    const exists = await ctx.db.invoice.findFirst({
      where:  { id, branchId: ctx.branchId },
      select: { approvalStatus: true },
    })
    if (!exists) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
    throw Object.assign(
      new Error(`Cannot request approval: invoice is already ${exists.approvalStatus}`),
      { statusCode: 409 }
    )
  }

  return ctx.db.invoice.findFirst({
    where:  { id, branchId: ctx.branchId },
    select: { id: true, approvalStatus: true },
  })
}

// =============================================================================
// recordAdvancePayment / allocateAdvance
// =============================================================================

export async function recordAdvancePayment(
  input: { partyId: string; amount: number; method: string; refNo?: string; notes?: string; paymentDate?: string },
  ctx:   RequestCtx,
) {
  return ctx.db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        branchId:    ctx.branchId,
        partyId:     input.partyId,
        amount:      input.amount,
        method:      input.method,
        type:        'advance',
        refNo:       input.refNo  ?? null,
        notes:       input.notes  ?? null,
        paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        status:      'active',
        createdBy:   ctx.userId,
      },
    })

    // Advance received → customer has pre-paid → decrement their balance.
    // party.balance > 0 means they owe us; receiving advance reduces that.
    await tx.party.update({
      where: { id: input.partyId },
      data:  { balance: { decrement: input.amount } },
    })

    return payment
  })
}

export async function allocateAdvance(
  paymentId: string,
  allocations: Array<{ invoiceId: string; amount: number }>,
  ctx: RequestCtx,
) {
  // Quick pre-flight (the real race guard is the FOR UPDATE inside the tx)
  const pmtCheck = await ctx.db.payment.findFirst({
    where:   { id: paymentId, branchId: ctx.branchId, type: 'advance', status: 'active' },
    include: { allocations: { select: { amount: true } } },
  })
  if (!pmtCheck) throw Object.assign(new Error('Advance payment not found'), { statusCode: 404 })

  const totalNew = allocations.reduce((s, a) => s + a.amount, 0)
  const preCheck = pmtCheck.allocations.reduce((s, a) => s + Number(a.amount), 0)
  if (preCheck + totalNew > Number(pmtCheck.amount) + 0.01)
    throw Object.assign(new Error('Allocation exceeds advance payment amount'), { statusCode: 400 })

  return ctx.db.$transaction(async (tx) => {
    // Lock the payment row and recompute allocated total atomically.
    // Two concurrent allocateAdvance calls that both pass the pre-flight
    // check can together exceed the advance amount without this lock.
    // (FOR UPDATE cannot be combined with GROUP BY, so lock the row first and sum separately.)
    const locked = await tx.$queryRaw<Array<{ amount: number; party_id: string | null }>>`
      SELECT p.amount::float AS amount, p."partyId"::text AS party_id
      FROM payments p
      WHERE p.id        = ${paymentId}::uuid
        AND p."branchId" = ${ctx.branchId}::uuid
        AND p.type      = 'advance'
        AND p.status    = 'active'
      FOR UPDATE OF p
    `
    const allocatedRows = locked.length === 0 ? [] : await tx.$queryRaw<Array<{ already_allocated: number }>>`
      SELECT COALESCE(SUM(pa.amount), 0)::float AS already_allocated
      FROM payment_allocations pa
      WHERE pa."paymentId" = ${paymentId}::uuid
    `
    const pmtRows = locked.map((r) => ({ ...r, already_allocated: allocatedRows[0]?.already_allocated ?? 0 }))
    const pmt = pmtRows[0]
    if (!pmt) throw Object.assign(new Error('Advance payment not found'), { statusCode: 404 })
    if (pmt.already_allocated + totalNew > pmt.amount + 0.01)
      throw Object.assign(new Error('Allocation exceeds advance payment amount'), { statusCode: 400 })

    const results: Array<{ invoiceId: string; amount: number; newStatus: string }> = []

    // Sort by invoiceId before locking to prevent deadlocks with concurrent allocateAdvance calls
    const sortedAllocations = [...allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))

    for (const a of sortedAllocations) {
      // Lock each invoice row — same pattern as recordPayment
      const rows = await tx.$queryRaw<Array<{
        id: string; grand_total: number; paid_amt: number; status: string
      }>>`
        SELECT
          id,
          "grandTotal"::float AS grand_total,
          "paidAmt"::float    AS paid_amt,
          status
        FROM invoices
        WHERE id        = ${a.invoiceId}::uuid
          AND "branchId" = ${ctx.branchId}::uuid
        FOR UPDATE
      `

      const inv = rows[0]
      if (!inv)
        throw Object.assign(new Error(`Invoice ${a.invoiceId} not found`), { statusCode: 404 })
      if (inv.status === 'cancelled')
        throw Object.assign(new Error(`Invoice ${a.invoiceId} is cancelled`), { statusCode: 409 })

      const maxPayable = inv.grand_total - inv.paid_amt
      if (a.amount > maxPayable + 0.01)
        throw Object.assign(
          new Error(`Allocation ₹${a.amount} exceeds outstanding ₹${maxPayable.toFixed(2)} on invoice ${a.invoiceId}`),
          { statusCode: 422 }
        )

      await tx.paymentAllocation.create({
        data: { paymentId, invoiceId: a.invoiceId, amount: a.amount },
      })

      const newPaidAmt = inv.paid_amt + a.amount
      const newStatus  = newPaidAmt >= inv.grand_total - 0.01 ? 'paid' : 'partial'

      await tx.invoice.update({
        where: { id: a.invoiceId, branchId: ctx.branchId },
        data:  { paidAmt: newPaidAmt, status: newStatus },
      })

      results.push({ invoiceId: a.invoiceId, amount: a.amount, newStatus })
    }

    return results
  }, {
    maxWait: 5000,
    timeout: 10000,
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  })
}

// =============================================================================
// listPendingApprovals
// =============================================================================

export async function listPendingApprovals(
  ctx:   RequestCtx,
  page:  number = 1,
  limit: number = 20,
) {
  const take = Math.min(50, Math.max(1, limit))
  const skip = (Math.max(1, page) - 1) * take
  const where = { branchId: ctx.branchId, approvalStatus: 'pending' } as const

  const [data, total] = await Promise.all([
    ctx.db.invoice.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take,
      select: {
        id: true, txnType: true, number: true, date: true,
        grandTotal: true, approvalStatus: true, createdAt: true,
        party:         { select: { id: true, name: true } },
        createdByUser: { select: { id: true, name: true } },
      },
    }),
    ctx.db.invoice.count({ where }),
  ])

  return { data, meta: { page: Math.max(1, page), limit: take, total, totalPages: Math.ceil(total / take) } }
}
