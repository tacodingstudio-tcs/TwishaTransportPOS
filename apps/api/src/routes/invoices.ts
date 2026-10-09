// apps/api/src/routes/invoices.ts
// All invoice HTTP endpoints.
// Auth + tenant context is already set by tenantMiddleware before these run.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  createInvoice,
  getInvoiceWithItems,
  listInvoices,
  cancelInvoice,
  recordPayment,
  convertInvoice,
  approveInvoice,
  rejectInvoice,
  requestApproval,
  listPendingApprovals,
  recordAdvancePayment,
  allocateAdvance,
  CreateInvoiceSchema,
  RecordPaymentSchema,
} from '../services/invoice.service.js'
import { DOMAIN_REGISTRY } from '@billing/domain-registry'
import { releaseLrsForInvoice } from '../lib/transport-helpers.js'
import { withIdempotency, IdempotencyConflictError } from '../lib/idempotency.js'
import { createPaymentLink } from '../services/razorpayPayment.service.js'
import { whatsappQueue } from '../lib/queues.js'
import { sendReceiptEmail } from '../services/email.service.js'

export const invoiceRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/invoices ─────────────────────────────────────────────────────
  // List invoices for the current branch with filters and pagination
  app.get('/', async (req) => {
    const TXN_TYPES = ['sale_invoice','purchase_invoice','credit_note','debit_note',
      'sale_return','purchase_return','proforma','quotation','delivery_challan'] as const
    const STATUSES  = ['draft','confirmed','partial','paid','cancelled'] as const
    const query = z.object({
      txnType:  z.enum(TXN_TYPES).optional(),
      status:   z.enum(STATUSES).optional(),
      partyId:  z.string().uuid().optional(),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      search:   z.string().optional(),
      page:     z.coerce.number().int().min(1).default(1),
      limit:    z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query)

    return listInvoices(
      { db: req.db, branchId: req.branchId,
        schemaName: req.schemaName, userId: req.userId, role: req.role },
      query
    )
  })

  // ── POST /api/invoices ────────────────────────────────────────────────────
  // Create and immediately confirm a new invoice
  //
  // Idempotency: every invoice creation MUST carry an idempotency key so that
  // a timed-out or network-dropped request can be safely retried without
  // creating a duplicate invoice, double-deducting stock, or double-crediting
  // the party balance.
  //
  // Accepted sources (first wins):
  //   1. Idempotency-Key HTTP header  — recommended for all API integrations
  //   2. body.aiMeta.localUuid        — the mobile app generates this UUID per
  //                                     invoice before going offline; sending
  //                                     the same body on retry is safe
  //
  // A retried request with the same key returns the ORIGINAL invoice unchanged.
  // The X-Idempotent-Replay: true response header distinguishes a replay from
  // a fresh creation without changing the response shape or status code.
  app.post('/', async (req, reply) => {
    const input = CreateInvoiceSchema.parse(req.body)

    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (input.aiMeta?.['localUuid'] as string | undefined)

    if (!idempotencyKey) {
      return reply.status(400).send({
        error: 'Idempotency-Key required',
        message:
          'Supply a unique UUID in the Idempotency-Key header (or body.aiMeta.localUuid). ' +
          'Resend the same UUID on retries — the server will return the original invoice ' +
          'instead of creating a duplicate.',
      })
    }

    // Fetch branch domain type for the context (needed by invoice service)
    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId },
      select: { domainType: true },
    })

    try {
      const { result: invoice, replayed } = await withIdempotency(
        { branchId: req.branchId, endpoint: 'POST /invoices', key: idempotencyKey },
        () => createInvoice(input, {
          db:              req.db,
          branchId:        req.branchId,
          schemaName:      req.schemaName,
          userId:          req.userId,
          role:            req.role,
          branchDomainType: branch.domainType,
        } as Parameters<typeof createInvoice>[1] & { branchDomainType: string })
      )

      if (replayed) reply.header('X-Idempotent-Replay', 'true')

      return reply.status(201).send(invoice)
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send({
          error: 'Duplicate request',
          message: 'A request with this idempotency key is already being processed. Wait for it to complete before retrying.',
        })
      }
      throw err
    }
  })

  // ── GET /api/invoices/pending-approvals ───────────────────────────────────
  // Static route — must be before /:id to avoid being captured as an id param
  app.get('/pending-approvals', async (req) => {
    const q = z.object({
      page:  z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query)
    return listPendingApprovals(
      { db: req.db, branchId: req.branchId, schemaName: req.schemaName, userId: req.userId, role: req.role },
      q.page,
      q.limit,
    )
  })

  // ── POST /api/invoices/advances ───────────────────────────────────────────
  app.post('/advances', async (req, reply) => {
    const input = z.object({
      partyId:     z.string().uuid(),
      amount:      z.number().positive(),
      method:      z.string(),
      refNo:       z.string().optional(),
      notes:       z.string().optional(),
      paymentDate: z.string().date().optional(),
    }).parse(req.body)

    const adv = await recordAdvancePayment(input, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
    })
    return reply.status(201).send(adv)
  })

  // ── GET /api/invoices/advances ────────────────────────────────────────────
  app.get('/advances', async (req) => {
    const q = z.object({
      partyId: z.string().uuid().optional(),
      page:    z.coerce.number().int().min(1).default(1),
      limit:   z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query)

    const skip = (q.page - 1) * q.limit
    const where = {
      branchId: req.branchId,
      type:     'advance',
      status:   'active',
      ...(q.partyId && { partyId: q.partyId }),
    }

    const [total, advances] = await Promise.all([
      req.db.payment.count({ where }),
      req.db.payment.findMany({
        where,
        include: {
          allocations: { select: { amount: true } },
          party: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: q.limit,
      }),
    ])

    const items = advances.map((a) => {
      const allocated = (a.allocations as any[]).reduce((s: number, x: any) => s + Number(x.amount), 0)
      return {
        ...a,
        allocatedAmt:   allocated,
        unallocatedAmt: Number(a.amount) - allocated,
      }
    })
    return { total, page: q.page, limit: q.limit, items }
  })

  // ── POST /api/invoices/advances/:id/allocate ──────────────────────────────
  // Static prefix 'advances/' prevents capture by /:id
  app.post('/advances/:id/allocate', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { allocations } = z.object({
      allocations: z.array(z.object({
        invoiceId: z.string().uuid(),
        amount:    z.number().positive(),
      })).min(1),
    }).parse(req.body)

    return allocateAdvance(id, allocations, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
    })
  })

  // ── GET /api/invoices/:id ─────────────────────────────────────────────────
  // Get a single invoice with all line items and party details
  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return getInvoiceWithItems(req.db, id, req.branchId)
  })

  // ── POST /api/invoices/:id/cancel ─────────────────────────────────────────
  // Cancel an invoice and reverse stock + party balance
  app.post('/:id/cancel', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const cancelled = await cancelInvoice(id, {
      db:         req.db,
      branchId:   req.branchId,
      schemaName: req.schemaName,
      userId:     req.userId,
      role:       req.role,
    })
    // Freight bills: put their lorry receipts back in the unbilled pool
    await releaseLrsForInvoice(req, id)
    return cancelled
  })

  // ── POST /api/invoices/:id/payment ────────────────────────────────────────
  // Record a payment against an invoice (full or partial)
  //
  // Idempotency matters even more here than on invoice creation: a retried
  // payment request without protection would record the SAME cash/UPI
  // payment twice, reducing the party's balance twice for one real payment —
  // a direct accounting error, not just a duplicate row.
  app.post('/:id/payment', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input  = RecordPaymentSchema.parse({ ...(req.body as object), invoiceId: id })

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined
    if (!idempotencyKey) {
      return reply.status(400).send({
        error: 'Idempotency-Key required',
        message:
          'Supply a unique UUID in the Idempotency-Key header. ' +
          'Resend the same UUID on retries — the server will return the original payment instead of recording a duplicate.',
      })
    }

    try {
      const { result, replayed } = await withIdempotency(
        { branchId: req.branchId, endpoint: 'POST /invoices/:id/payment', key: idempotencyKey },
        () => recordPayment(input, {
          db:         req.db,
          branchId:   req.branchId,
          schemaName: req.schemaName,
          userId:     req.userId,
          role:       req.role,
        })
      )

      if (replayed) reply.header('X-Idempotent-Replay', 'true')
      return reply.status(201).send(result)
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send({
          error: 'Duplicate request',
          message: 'This payment is already being processed.',
        })
      }
      throw err
    }
  })

  // ── POST /api/invoices/:id/payment-link ───────────────────────────────────
  // Generates a Razorpay payment link for the outstanding balance and
  // returns the shareable URL — the cashier sends this via WhatsApp
  // (or copies it manually) for the customer to pay via UPI/card.
  // Actual payment confirmation arrives separately via the webhook at
  // /api/webhooks/razorpay, which calls recordPayment() automatically.
  app.post('/:id/payment-link', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return createPaymentLink(id, {
      db:         req.db,
      branchId:   req.branchId,
      schemaName: req.schemaName,
      userId:     req.userId,
      role:       req.role,
    })
  })

  // ── GET /api/invoices/:id/pdf ─────────────────────────────────────────────
  // Get the PDF URL for an invoice (generated async by worker)
  app.get('/:id/pdf', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    // Check if PDF already exists
    const pdfPath = `/tmp/billing-files/invoices/${id}.pdf`
    const { existsSync } = await import('fs')

    if (existsSync(pdfPath)) {
      return reply.send({ pdfPath: `/invoices/${id}.pdf` })
    }

    // PDF not ready yet — re-queue generation
    const { pdfQueue } = await import('../lib/queues.js')
    await pdfQueue.add('generate-pdf', { invoiceId: id, branchId: req.branchId })

    return reply.status(202).send({
      message: 'PDF is being generated — try again in a few seconds',
      invoiceId: id,
    })
  })

  // ── POST /api/invoices/:id/credit-note ───────────────────────────────────
  // Creates a credit note against an existing sale_invoice.
  // Caller may override items/qty (partial return) or accept all items at full qty.
  // Stock is returned to inventory; party balance is reduced.
  app.post('/:id/credit-note', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      items: z.array(z.object({
        invoiceItemId: z.string().uuid(),
        qty:           z.number().positive(),
      })).optional(),
      notes: z.string().max(500).optional(),
      date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const original = await db.invoice.findFirst({
      where: { id, branchId },
      include: { items: true },
    })
    if (!original)
      return reply.status(404).send({ error: 'Invoice not found' })
    if (original.txnType !== 'sale_invoice')
      return reply.status(422).send({ error: 'Credit notes can only be raised against sale invoices' })
    if (original.status === 'cancelled')
      return reply.status(409).send({ error: 'Cannot raise a credit note for a cancelled invoice' })

    // Build credit note items — full return by default, partial if caller specified items
    const sourceItems = body.items
      ? body.items.map((override) => {
          const orig = original.items.find((i) => i.id === override.invoiceItemId)
          if (!orig) throw Object.assign(new Error(`Invoice item ${override.invoiceItemId} not found`), { statusCode: 422 })
          if (override.qty > Number(orig.qty))
            throw Object.assign(new Error(`Return qty ${override.qty} exceeds original qty ${orig.qty}`), { statusCode: 422 })
          return { ...orig, qty: override.qty }
        })
      : original.items

    const branch = await db.branch.findUniqueOrThrow({
      where: { id: branchId }, select: { domainType: true },
    })

    const creditNote = await createInvoice({
      txnType:         'credit_note',
      partyId:         original.partyId ?? undefined,
      linkedInvoiceId: original.id,
      date:            body.date,
      notes:           body.notes ?? `Credit note for ${original.number}`,
      domainData:      {},
      aiMeta:          {},
      items: sourceItems.map((item) => ({
        productId:   item.productId ?? undefined,
        batchId:     item.batchId   ?? undefined,
        description: item.description,
        qty:         Number(item.qty),
        unit:        item.unit,
        rate:        Number(item.rate),
        discountPct: Number(item.discountPct),
        gstRate:     Number(item.gstRate) as 0 | 5 | 12 | 18 | 28,
        gstExempt:   false,
        hsnSacCode:  item.hsnSacCode ?? undefined,
        itemMeta:    item.itemMeta as Record<string, unknown>,
      })),
    }, {
      db, branchId, schemaName: req.schemaName, userId: req.userId, role: req.role,
      branchDomainType: branch.domainType,
    } as Parameters<typeof createInvoice>[1] & { branchDomainType: string })

    return reply.status(201).send(creditNote)
  })

  // ── POST /api/invoices/:id/return ────────────────────────────────────────
  // Creates a sale_return against a sale_invoice (physical goods return with stock in).
  // Different from credit_note: sale_return affects stock, credit_note is financial only.
  app.post('/:id/return', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      items: z.array(z.object({
        invoiceItemId: z.string().uuid(),
        qty:           z.number().positive(),
      })).optional(),
      notes: z.string().max(500).optional(),
      date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body)

    const original = await req.db.invoice.findFirst({
      where: { id, branchId: req.branchId },
      include: { items: true },
    })
    if (!original) return reply.status(404).send({ error: 'Invoice not found' })
    if (original.txnType !== 'sale_invoice')
      return reply.status(422).send({ error: 'Sale return can only be raised against a sale_invoice' })
    if (original.status === 'cancelled')
      return reply.status(409).send({ error: 'Cannot return a cancelled invoice' })

    const sourceItems = body.items
      ? body.items.map((override) => {
          const orig = original.items.find((i) => i.id === override.invoiceItemId)
          if (!orig) throw Object.assign(new Error(`Item ${override.invoiceItemId} not found`), { statusCode: 422 })
          if (override.qty > Number(orig.qty))
            throw Object.assign(new Error(`Return qty ${override.qty} exceeds original qty ${orig.qty}`), { statusCode: 422 })
          return { ...orig, qty: override.qty }
        })
      : original.items

    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId }, select: { domainType: true },
    })

    const ret = await createInvoice({
      txnType:         'sale_return',
      partyId:         original.partyId ?? undefined,
      linkedInvoiceId: original.id,
      date:            body.date,
      notes:           body.notes ?? `Return against ${original.number}`,
      domainData:      {},
      aiMeta:          {},
      items: sourceItems.map((item) => ({
        productId:   item.productId ?? undefined,
        batchId:     item.batchId   ?? undefined,
        description: item.description,
        qty:         Number(item.qty),
        unit:        item.unit,
        rate:        Number(item.rate),
        discountPct: Number(item.discountPct),
        gstRate:     Number(item.gstRate) as 0 | 5 | 12 | 18 | 28,
        gstExempt:   false,
        hsnSacCode:  item.hsnSacCode ?? undefined,
        itemMeta:    item.itemMeta as Record<string, unknown>,
      })),
    }, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
      branchDomainType: branch.domainType,
    } as Parameters<typeof createInvoice>[1] & { branchDomainType: string })

    return reply.status(201).send(ret)
  })

  // ── POST /api/invoices/:id/debit-note ─────────────────────────────────────
  // Creates a debit note against a purchase_invoice (supplier overcharged / goods not received).
  app.post('/:id/debit-note', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      items: z.array(z.object({
        invoiceItemId: z.string().uuid(),
        qty:           z.number().positive(),
      })).optional(),
      notes: z.string().max(500).optional(),
      date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body)

    const original = await req.db.invoice.findFirst({
      where: { id, branchId: req.branchId },
      include: { items: true },
    })
    if (!original) return reply.status(404).send({ error: 'Invoice not found' })
    if (original.txnType !== 'purchase_invoice')
      return reply.status(422).send({ error: 'Debit note can only be raised against a purchase_invoice' })
    if (original.status === 'cancelled')
      return reply.status(409).send({ error: 'Cannot raise a debit note for a cancelled invoice' })

    const sourceItems = body.items
      ? body.items.map((override) => {
          const orig = original.items.find((i) => i.id === override.invoiceItemId)
          if (!orig) throw Object.assign(new Error(`Item ${override.invoiceItemId} not found`), { statusCode: 422 })
          if (override.qty > Number(orig.qty))
            throw Object.assign(new Error(`Return qty ${override.qty} exceeds original qty ${orig.qty}`), { statusCode: 422 })
          return { ...orig, qty: override.qty }
        })
      : original.items

    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId }, select: { domainType: true },
    })

    const dn = await createInvoice({
      txnType:         'debit_note',
      partyId:         original.partyId ?? undefined,
      linkedInvoiceId: original.id,
      date:            body.date,
      notes:           body.notes ?? `Debit note against ${original.number}`,
      domainData:      {},
      aiMeta:          {},
      items: sourceItems.map((item) => ({
        productId:   item.productId ?? undefined,
        description: item.description,
        qty:         Number(item.qty),
        unit:        item.unit,
        rate:        Number(item.rate),
        discountPct: Number(item.discountPct),
        gstRate:     Number(item.gstRate) as 0 | 5 | 12 | 18 | 28,
        gstExempt:   false,
        hsnSacCode:  item.hsnSacCode ?? undefined,
        itemMeta:    item.itemMeta as Record<string, unknown>,
      })),
    }, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
      branchDomainType: branch.domainType,
    } as Parameters<typeof createInvoice>[1] & { branchDomainType: string })

    return reply.status(201).send(dn)
  })

  // ── GET /api/invoices/:id/linked-docs ────────────────────────────────────
  // Lists credit notes, delivery challans, and converted invoices linked to this one.
  app.get('/:id/linked-docs', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db       = req.db
    const branchId = req.branchId

    const source = await db.invoice.findFirst({
      where: { id, branchId }, select: { id: true, number: true, txnType: true },
    })
    if (!source) return reply.status(404).send({ error: 'Invoice not found' })

    const linked = await db.invoice.findMany({
      where: { linkedInvoiceId: id as string, branchId },
      select: {
        id: true, number: true, txnType: true, date: true,
        status: true, grandTotal: true,
        party: { select: { name: true } },
      },
      orderBy: { date: 'desc' },
    })

    return {
      sourceInvoice: source,
      linkedDocs: linked,
      summary: {
        creditNotes:      linked.filter((l) => l.txnType === 'credit_note').length,
        deliveryChallans: linked.filter((l) => l.txnType === 'delivery_challan').length,
        convertedInvoice: linked.filter((l) => l.txnType === 'sale_invoice').length,
      },
    }
  })

  // ── GET /api/invoices/summary/weekly ─────────────────────────────────────
  // Last 7 days of daily sales — for the revenue bar chart
  app.get('/summary/weekly', async (req) => {
    const rows = await req.db.$queryRaw<Array<{
      day: Date; total_sales: number; invoice_count: number
    }>>`
      SELECT
        "date"                       AS day,
        SUM("grandTotal"::float)     AS total_sales,
        COUNT(*)::int                AS invoice_count
      FROM invoices
      WHERE "branchId" = ${req.branchId}::uuid
        AND "txnType"  = 'sale_invoice'
        AND status     IN ('confirmed','paid','partial')
        AND "date"     >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY "date"
      ORDER BY "date" ASC
    `

    // Fill missing days with zeros so the chart always shows 7 bars
    const result = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dayStr = d.toISOString().slice(0, 10)
      const row = rows.find((r) => new Date(r.day).toISOString().slice(0, 10) === dayStr)
      result.push({
        day:          dayStr,
        totalSales:   row ? Number(row.total_sales)   : 0,
        invoiceCount: row ? Number(row.invoice_count) : 0,
      })
    }

    return result
  })

  // ── POST /api/invoices/:id/send-receipt ──────────────────────────────────
  // Send the invoice receipt to the customer via WhatsApp or email.
  // WhatsApp: queued via BullMQ → whatsapp.worker.ts
  // Email: sent immediately via nodemailer (SMTP env vars required)
  app.post('/:id/send-receipt', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      channel:      z.enum(['whatsapp', 'email']),
      to:           z.string().optional(),  // override phone/email from party
      businessName: z.string().optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const invoice = await getInvoiceWithItems(db, id, branchId)
    if (!invoice) return reply.code(404).send({ error: 'Invoice not found' })

    const party       = (invoice as any).party
    const partyName   = party?.name ?? 'Customer'
    const partyPhone  = body.to ?? party?.phone
    const partyEmail  = body.to ?? party?.email

    // Fetch branch name for business signature
    const branch = await db.branch.findUnique({
      where: { id: branchId }, select: { name: true },
    })
    const businessName = body.businessName ?? branch?.name ?? 'BillBook'

    if (body.channel === 'whatsapp') {
      if (!partyPhone) {
        return reply.code(422).send({ error: 'No phone number on file. Provide one in the `to` field.' })
      }
      // Normalise phone to E.164 Indian format
      const phone = partyPhone.replace(/\D/g, '')
      const e164  = phone.startsWith('91') ? phone : `91${phone}`

      await whatsappQueue.add('invoice_share', {
        type:         'invoice_share',
        invoiceId:    id,
        tenantId:     req.schemaName,
        toPhone:      e164,
        partyName,
        invoiceNo:    (invoice as any).number,
        amount:       Number((invoice as any).grandTotal),
        businessName,
      })

      return reply.send({ ok: true, channel: 'whatsapp', to: e164 })
    }

    // Email channel
    if (!partyEmail) {
      return reply.code(422).send({ error: 'No email address on file. Provide one in the `to` field.' })
    }

    await sendReceiptEmail({
      to:           partyEmail,
      partyName,
      invoiceNo:    (invoice as any).number,
      invoiceDate:  (invoice as any).date,
      grandTotal:   Number((invoice as any).grandTotal),
      paidAmt:      Number((invoice as any).paidAmt),
      businessName,
      items:        (invoice as any).items ?? [],
    })

    return reply.send({ ok: true, channel: 'email', to: partyEmail })
  })

  // ── GET /api/invoices/summary/daily ──────────────────────────────────────
  // Today's sales summary for the Z-report / dashboard header
  app.get('/summary/daily', async (req) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    const [sales, payments] = await Promise.all([
      req.db.invoice.aggregate({
        where: {
          branchId: req.branchId,
          txnType:  'sale_invoice',
          status:   { in: ['confirmed', 'paid', 'partial'] },
          date:     { gte: today, lt: tomorrow },
        },
        _sum:   { grandTotal: true, paidAmt: true },
        _count: { id: true },
      }),
      req.db.payment.groupBy({
        by:    ['method'],
        where: {
          branchId:    req.branchId,
          status:      'active',
          paymentDate: { gte: today, lt: tomorrow },
        },
        _sum: { amount: true },
      }),
    ])

    return {
      date:          today.toISOString().slice(0, 10),
      totalSales:    Number(sales._sum.grandTotal ?? 0),
      totalReceived: Number(sales._sum.paidAmt    ?? 0),
      totalOutstanding: Number(sales._sum.grandTotal ?? 0) - Number(sales._sum.paidAmt ?? 0),
      invoiceCount:  sales._count.id,
      paymentBreakdown: payments.map((p) => ({
        method: p.method,
        amount: Number(p._sum.amount ?? 0),
      })),
    }
  })

  // ── POST /api/invoices/:id/convert ────────────────────────────────────────
  // Convert quotation → sales_order → sale_invoice, proforma → sale_invoice, etc.
  app.post('/:id/convert', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { targetType } = z.object({ targetType: z.string().optional() }).parse(req.body)

    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId }, select: { domainType: true },
    })

    const result = await convertInvoice(id, targetType, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
      branchDomainType: branch.domainType,
    })
    return reply.status(201).send(result)
  })

  // ── POST /api/invoices/:id/request-approval ────────────────────────────────
  app.post('/:id/request-approval', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return requestApproval(id, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
    })
  })

  // ── POST /api/invoices/:id/approve ────────────────────────────────────────
  app.post('/:id/approve', async (req, reply) => {
    if (req.role !== 'owner' && req.role !== 'manager') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only owner or manager can approve invoices',
      })
    }
    const { id }   = z.object({ id: z.string().uuid() }).parse(req.params)
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body)
    return approveInvoice(id, note, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
    })
  })

  // ── POST /api/invoices/:id/reject ─────────────────────────────────────────
  app.post('/:id/reject', async (req, reply) => {
    if (req.role !== 'owner' && req.role !== 'manager') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Only owner or manager can reject invoices',
      })
    }
    const { id }   = z.object({ id: z.string().uuid() }).parse(req.params)
    const { note } = z.object({ note: z.string().min(1).max(500) }).parse(req.body)
    return rejectInvoice(id, note, {
      db: req.db, branchId: req.branchId,
      schemaName: req.schemaName, userId: req.userId, role: req.role,
    })
  })

  // ── POST /api/invoices/:id/generate-irn ───────────────────────────────────
  // Build e-invoice payload and submit to IRP (NIC sandbox).
  // On success stores irnNo, irnAckDate, irnQrCode on the invoice.
  app.post('/:id/generate-irn', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const invoice = await req.db.invoice.findFirst({
      where:   { id, branchId: req.branchId },
      include: { items: true, party: true },
    })
    if (!invoice)                        return reply.status(404).send({ error: 'Invoice not found' })
    if (invoice.txnType !== 'sale_invoice') return reply.status(422).send({ error: 'IRN only for sale_invoice' })
    if (invoice.irnNo)                   return reply.status(409).send({ error: 'IRN already generated', irnNo: invoice.irnNo })

    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId },
      select: { name: true, gstin: true, stateCode: true, address: true },
    })

    if (!branch.gstin) return reply.status(422).send({ error: 'Branch GSTIN not configured' })

    // Build IRP-compatible payload (GST e-invoice schema v1.1)
    const eirPayload = {
      Version: '1.1',
      TranDtls: {
        TaxSch: 'GST',
        SupTyp:  'B2B',
        RegRev:  'N',
        EcmGstin: null,
        IgstOnIntra: 'N',
      },
      DocDtls: {
        Typ:  'INV',
        No:   invoice.number,
        Dt:   new Date(invoice.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      },
      SellerDtls: {
        Gstin:   branch.gstin,
        TrdNm:   branch.name,
        Addr1:   (branch.address as any)?.line1 ?? '',
        Loc:     (branch.address as any)?.city ?? '',
        Pin:     Number((branch.address as any)?.pincode ?? 0),
        Stcd:    branch.stateCode ?? '24',
      },
      BuyerDtls: {
        Gstin:   (invoice.party as any)?.gstin ?? 'URP',
        TrdNm:   (invoice.party as any)?.name  ?? '',
        Pos:     (invoice.party as any)?.stateCode ?? branch.stateCode ?? '24',
        Addr1:   (invoice.party as any)?.address ?? '',
        Loc:     '',
        Pin:     0,
        Stcd:    (invoice.party as any)?.stateCode ?? branch.stateCode ?? '24',
      },
      ItemList: (invoice.items as any[]).map((item, i) => ({
        SlNo:      String(i + 1),
        PrdDesc:   item.description,
        IsServc:   'N',
        HsnCd:     item.hsnSacCode ?? '9999',
        Qty:       Number(item.qty),
        Unit:      item.unit,
        UnitPrice: Number(item.rate),
        TotAmt:    Number(item.qty) * Number(item.rate),
        Discount:  Number(item.discountAmt ?? 0),
        AssAmt:    Number(item.taxableAmt ?? (Number(item.qty) * Number(item.rate))),
        GstRt:     Number(item.gstRate),
        IgstAmt:   Number(item.igstAmt ?? 0),
        CgstAmt:   Number(item.cgstAmt ?? 0),
        SgstAmt:   Number(item.sgstAmt ?? 0),
        TotItemVal: Number(item.total ?? (Number(item.qty) * Number(item.rate))),
      })),
      ValDtls: {
        AssVal:   Number(invoice.subtotal),
        CgstVal:  Number(invoice.cgstTotal ?? 0),
        SgstVal:  Number(invoice.sgstTotal ?? 0),
        IgstVal:  Number(invoice.igstTotal ?? 0),
        TotInvVal: Number(invoice.grandTotal),
      },
    }

    // In production: POST to IRP API with auth token
    // For now: store the payload and simulate a response (sandbox mode)
    const mockIrn = `${branch.gstin}${invoice.number}${Date.now()}`.replace(/[^A-Z0-9]/gi, '').slice(0, 64).toUpperCase()
    const mockAckDate = new Date()

    await req.db.invoice.update({
      where: { id },
      data: {
        irnNo:      mockIrn,
        irnAckDate: mockAckDate,
        irnQrCode:  JSON.stringify({ irn: mockIrn, ackDt: mockAckDate.toISOString(), gstin: branch.gstin }),
      },
    })

    return reply.status(200).send({
      irnNo:      mockIrn,
      irnAckDate: mockAckDate,
      payload:    eirPayload,
      note:       'Sandbox mode — connect IRP credentials in branch settings for live submission',
    })
  })

  // ── POST /api/invoices/:id/generate-eway ──────────────────────────────────
  // Generate e-Way Bill for invoices with goods movement > ₹50,000.
  app.post('/:id/generate-eway', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      transporterId:   z.string().optional(),
      transporterName: z.string().optional(),
      vehicleNo:       z.string().optional(),
      vehicleType:     z.enum(['R','O']).default('R'),        // R = Regular, O = Over Dimensional
      distance:        z.number().int().min(1).optional(),    // km
      transMode:       z.enum(['1','2','3','4']).default('1'), // 1=Road 2=Rail 3=Air 4=Ship
      subSupplyType:   z.number().int().min(1).max(12).default(1),
    }).parse(req.body)

    const invoice = await req.db.invoice.findFirst({
      where:   { id, branchId: req.branchId },
      include: { items: true, party: true },
    })
    if (!invoice) return reply.status(404).send({ error: 'Invoice not found' })
    if (invoice.eWayBillNo) return reply.status(409).send({ error: 'E-Way bill already generated', eWayBillNo: invoice.eWayBillNo })

    if (Number(invoice.grandTotal) < 50000) {
      return reply.status(422).send({ error: 'E-Way bill required only for consignments > ₹50,000' })
    }

    const branch = await req.db.branch.findUniqueOrThrow({
      where:  { id: req.branchId },
      select: { name: true, gstin: true, stateCode: true },
    })

    if (!branch.gstin) return reply.status(422).send({ error: 'Branch GSTIN not configured' })

    // Build NIC e-Way bill payload
    const ewbPayload = {
      supplyType:      'O',  // Outward
      subSupplyType:   body.subSupplyType,
      docType:         'INV',
      docNo:           invoice.number,
      docDate:         new Date(invoice.date).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      fromGstin:       branch.gstin,
      fromTrdName:     branch.name,
      fromStateCode:   Number(branch.stateCode ?? 24),
      toGstin:         (invoice.party as any)?.gstin ?? 'URP',
      toTrdName:       (invoice.party as any)?.name ?? '',
      toStateCode:     Number((invoice.party as any)?.stateCode ?? branch.stateCode ?? 24),
      totalValue:      Number(invoice.grandTotal),
      cgstValue:       Number(invoice.cgstTotal ?? 0),
      sgstValue:       Number(invoice.sgstTotal ?? 0),
      igstValue:       Number(invoice.igstTotal ?? 0),
      transporterId:   body.transporterId ?? '',
      transporterName: body.transporterName ?? '',
      transDocNo:      '',
      transMode:       body.transMode,
      distance:        body.distance ?? 0,
      vehicleNo:       body.vehicleNo ?? '',
      vehicleType:     body.vehicleType,
      itemList: (invoice.items as any[]).map(item => ({
        productName:  item.description,
        hsnCode:      item.hsnSacCode ?? '9999',
        quantity:     Number(item.qty),
        qtyUnit:      item.unit,
        taxableAmount: Number(item.taxableAmt ?? (Number(item.qty) * Number(item.rate))),
        sgstRate:     Number(item.gstRate) / 2,
        cgstRate:     Number(item.gstRate) / 2,
        igstRate:     0,
      })),
    }

    // Simulate NIC response (sandbox)
    const mockEwbNo   = String(Math.floor(100000000000 + Math.random() * 900000000000))
    const ewbDate     = new Date()
    const ewbValidTo  = new Date(ewbDate)
    ewbValidTo.setDate(ewbValidTo.getDate() + Math.max(1, Math.ceil((body.distance ?? 100) / 200)))

    await req.db.invoice.update({
      where: { id },
      data: {
        eWayBillNo:      mockEwbNo,
        eWayBillDate:    ewbDate,
        eWayBillValidTo: ewbValidTo,
      },
    })

    return reply.status(200).send({
      eWayBillNo:      mockEwbNo,
      eWayBillDate:    ewbDate,
      eWayBillValidTo: ewbValidTo,
      payload:         ewbPayload,
      note:            'Sandbox mode — connect NIC credentials in branch settings for live submission',
    })
  })

}
