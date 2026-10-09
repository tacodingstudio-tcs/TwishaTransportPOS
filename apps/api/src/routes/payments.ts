// apps/api/src/routes/payments.ts
//
// Standalone payment management — advance collections, on-account receipts,
// voiding, allocation, aging, and daily summary.
//
//  GET    /api/payments                  list (partyId / method / type / date / status filters)
//  POST   /api/payments                  create standalone advance / on-account payment
//  GET    /api/payments/summary          period collection summary by method
//  GET    /api/payments/outstanding      party-wise outstanding with 30/60/90-day aging
//  GET    /api/payments/:id              single payment with allocations
//  POST   /api/payments/:id/void         void a payment, reverse all allocations
//  POST   /api/payments/:id/allocate     apply an advance payment against specific invoices

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

// 'tds' = tax deducted at source by the customer: settles part of a bill without any cash arriving
const METHODS = ['cash', 'upi', 'card', 'cheque', 'bank_transfer', 'credit', 'tds'] as const
const TYPES   = ['receipt', 'advance', 'expense'] as const

// Lock an invoice row with SELECT ... FOR UPDATE so that concurrent payment
// requests cannot both read the same stale paidAmt and both pass the
// overpayment check.  Must be called inside a $transaction block.
async function lockInvoice(
  tx: any,
  invoiceId: string,
  branchId:  string,
): Promise<{ id: string; grand_total: number; paid_amt: number; status: string; party_id: string | null }> {
  const rows = await tx.$queryRaw<Array<{
    id:          string
    grand_total: number
    paid_amt:    number
    status:      string
    party_id:    string | null
  }>>`
    SELECT
      id,
      "grandTotal"::float AS grand_total,
      "paidAmt"::float    AS paid_amt,
      status,
      "partyId"::text     AS party_id
    FROM invoices
    WHERE id        = ${invoiceId}::uuid
      AND "branchId" = ${branchId}::uuid
    FOR UPDATE
  `
  if (!rows[0]) {
    throw Object.assign(new Error(`Invoice ${invoiceId} not found`), { statusCode: 404 })
  }
  return rows[0]
}

export const paymentRoutes: FastifyPluginAsync = async (app) => {

  // ── GET / — list payments ─────────────────────────────────────────────────
  app.get('/', async (req) => {
    const q = z.object({
      partyId:  z.string().uuid().optional(),
      method:   z.enum(METHODS).optional(),
      type:     z.enum(TYPES).optional(),
      status:   z.enum(['active', 'voided']).default('active'),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page:     z.coerce.number().int().min(1).default(1),
      limit:    z.coerce.number().int().min(1).max(100).default(20),
    }).parse(req.query)

    const skip = (q.page - 1) * q.limit

    const where = {
      branchId: req.branchId,
      status:   q.status,
      ...(q.partyId && { partyId: q.partyId }),
      ...(q.method  && { method:  q.method  }),
      ...(q.type    && { type:    q.type    }),
      ...((q.fromDate || q.toDate) && {
        paymentDate: {
          ...(q.fromDate && { gte: new Date(q.fromDate) }),
          ...(q.toDate   && { lte: new Date(q.toDate)   }),
        },
      }),
    }

    const [total, items] = await Promise.all([
      req.db.payment.count({ where }),
      req.db.payment.findMany({
        where,
        include: {
          party:       { select: { id: true, name: true, phone: true } },
          allocations: { select: { invoiceId: true, amount: true } },
        },
        orderBy: { paymentDate: 'desc' },
        skip,
        take: q.limit,
      }),
    ])

    return { total, page: q.page, limit: q.limit, items }
  })

  // ── POST / — create standalone payment ────────────────────────────────────
  // Use this for:
  //   - advance payments (type='advance'): customer pays before invoice is raised
  //   - on-account collection: partial bulk payment against multiple invoices
  //   - expense (type='expense'): petty cash out, supplier payment
  //
  // For allocating an advance to a specific invoice after the fact, use
  // POST /:id/allocate. For recording payment at invoice creation time,
  // use POST /api/invoices/:id/payment instead.
  app.post('/', async (req, reply) => {
    const body = z.object({
      partyId:     z.string().uuid().optional(),
      amount:      z.number().positive(),
      method:      z.enum(METHODS),
      type:        z.enum(TYPES).default('receipt'),
      refNo:       z.string().max(100).optional(),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes:       z.string().max(500).optional(),
      // Optional: allocate immediately to one or more invoices
      allocations: z.array(z.object({
        invoiceId: z.string().uuid(),
        amount:    z.number().positive(),
      })).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // Validate allocations sum ≤ payment amount
    const allocTotal = (body.allocations ?? []).reduce((s, a) => s + a.amount, 0)
    if (allocTotal > body.amount + 0.01)
      return reply.status(422).send({ error: `Allocation total ₹${allocTotal} exceeds payment amount ₹${body.amount}` })

    const result = await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          branchId,
          partyId:     body.partyId ?? null,
          amount:      body.amount,
          method:      body.method,
          type:        body.type,
          refNo:       body.refNo ?? null,
          paymentDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
          notes:       body.notes ?? null,
          status:      'active',
          createdBy:   req.userId,
        },
      })

      // Process allocations if provided
      if (body.allocations && body.allocations.length > 0) {
        // Sort by invoiceId before locking to prevent deadlocks with concurrent requests
        const sortedAllocs = [...body.allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
        for (const alloc of sortedAllocs) {
          const inv = await lockInvoice(tx, alloc.invoiceId, branchId)
          if (inv.status === 'cancelled')
            throw Object.assign(new Error(`Invoice ${alloc.invoiceId} is cancelled`), { statusCode: 409 })

          const maxPayable = inv.grand_total - inv.paid_amt
          if (alloc.amount > maxPayable + 0.01)
            throw Object.assign(
              new Error(`Allocation ₹${alloc.amount} exceeds outstanding ₹${maxPayable.toFixed(2)} on invoice ${alloc.invoiceId}`),
              { statusCode: 422 }
            )

          await tx.paymentAllocation.create({
            data: { paymentId: payment.id, invoiceId: alloc.invoiceId, amount: alloc.amount },
          })

          const newPaid   = inv.paid_amt + alloc.amount
          const newStatus = newPaid >= inv.grand_total - 0.01 ? 'paid' : 'partial'
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data:  { paidAmt: newPaid, status: newStatus },
          })
        }
      }

      // Update party balance
      // advance/receipt from customer → reduce what they owe (decrement balance)
      // expense going out → increase what supplier is owed (or just track, no party balance change if no party)
      if (body.partyId) {
        const balanceDelta = body.type === 'expense' ? body.amount : -body.amount
        // Scope update to branchId to prevent cross-branch balance corruption if a
        // cashier supplies a partyId from a different branch within the same tenant.
        const partyUpdateResult = await tx.party.updateMany({
          where: { id: body.partyId, branchId },
          data:  { balance: { increment: balanceDelta } },
        })
        if (partyUpdateResult.count === 0) {
          throw Object.assign(new Error('Party not found in this branch'), { statusCode: 404 })
        }
      }

      return payment
    })

    return reply.status(201).send(result)
  })

  // ── GET /summary — period collection summary ──────────────────────────────
  // Daily totals and method breakdown for a date range — for end-of-day Z-report
  // and cashier handover.
  app.get('/summary', async (req) => {
    const q = z.object({
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      groupBy:  z.enum(['day', 'method']).default('method'),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    // Default to today
    const from = q.fromDate ? new Date(q.fromDate) : (() => { const d = new Date(); d.setHours(0,0,0,0); return d })()
    const to   = q.toDate   ? new Date(q.toDate + 'T23:59:59') : new Date()

    if (q.groupBy === 'method') {
      const byMethod = await db.payment.groupBy({
        by:    ['method'],
        where: { branchId, status: 'active', paymentDate: { gte: from, lte: to } },
        _sum:  { amount: true },
        _count: { id: true },
      })

      const total = byMethod.reduce((s, r) => s + Number(r._sum.amount ?? 0), 0)
      return {
        fromDate: from.toISOString().slice(0, 10),
        toDate:   to.toISOString().slice(0, 10),
        total,
        byMethod: byMethod.map((r) => ({
          method: r.method,
          amount: Number(r._sum.amount ?? 0),
          count:  r._count.id,
          pct:    total > 0 ? Math.round((Number(r._sum.amount ?? 0) / total) * 100) : 0,
        })).sort((a, b) => b.amount - a.amount),
      }
    }

    // groupBy = 'day'
    const rows = await db.$queryRaw<Array<{
      day: string; total: number; cash: number; digital: number; count: number
    }>>`
      SELECT
        TO_CHAR("paymentDate", 'YYYY-MM-DD')                       AS day,
        SUM(amount::float)                                          AS total,
        SUM(CASE WHEN method = 'cash' THEN amount::float ELSE 0 END) AS cash,
        SUM(CASE WHEN method != 'cash' THEN amount::float ELSE 0 END) AS digital,
        COUNT(*)::int                                               AS count
      FROM payments
      WHERE "branchId" = ${branchId}::uuid
        AND status = 'active'
        AND "paymentDate" BETWEEN ${from} AND ${to}
      GROUP BY TO_CHAR("paymentDate", 'YYYY-MM-DD')
      ORDER BY day ASC
    `

    return {
      fromDate: from.toISOString().slice(0, 10),
      toDate:   to.toISOString().slice(0, 10),
      total:    rows.reduce((s, r) => s + r.total, 0),
      days: rows.map((r) => ({
        day:     r.day,
        total:   Number(r.total),
        cash:    Number(r.cash),
        digital: Number(r.digital),
        count:   Number(r.count),
      })),
    }
  })

  // ── GET /outstanding — party-wise outstanding with aging ──────────────────
  // Shows how much each party owes and buckets by 0–30, 31–60, 61–90, 90+ days.
  // Customer: balance > 0 (they owe us). Supplier: balance < 0 (we owe them).
  app.get('/outstanding', async (req) => {
    const q = z.object({
      type:  z.enum(['customer', 'supplier', 'all']).default('customer'),
      // limit applied after JS type-filter so callers get the right number of rows
      // regardless of which party types appear in the raw SQL result
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    // Run aging SQL — balance sign filter done in JS to avoid dynamic SQL
    const rows = await db.$queryRaw<Array<{
      party_id:            string
      party_name:          string
      party_type:          string
      phone:               string | null
      balance:             number
      bucket_0_30:         number
      bucket_31_60:        number
      bucket_61_90:        number
      bucket_90plus:       number
      oldest_invoice_date: string | null
    }>>`
      SELECT
        p.id::text                                                              AS party_id,
        p.name                                                                  AS party_name,
        p.type                                                                  AS party_type,
        p.phone,
        p.balance::float                                                        AS balance,
        COALESCE(SUM(
          CASE WHEN (CURRENT_DATE - i."date") BETWEEN 0 AND 30
               AND i.status IN ('confirmed','partial')
               THEN (i."grandTotal" - i."paidAmt")::float ELSE 0 END
        ), 0)                                                                   AS bucket_0_30,
        COALESCE(SUM(
          CASE WHEN (CURRENT_DATE - i."date") BETWEEN 31 AND 60
               AND i.status IN ('confirmed','partial')
               THEN (i."grandTotal" - i."paidAmt")::float ELSE 0 END
        ), 0)                                                                   AS bucket_31_60,
        COALESCE(SUM(
          CASE WHEN (CURRENT_DATE - i."date") BETWEEN 61 AND 90
               AND i.status IN ('confirmed','partial')
               THEN (i."grandTotal" - i."paidAmt")::float ELSE 0 END
        ), 0)                                                                   AS bucket_61_90,
        COALESCE(SUM(
          CASE WHEN (CURRENT_DATE - i."date") > 90
               AND i.status IN ('confirmed','partial')
               THEN (i."grandTotal" - i."paidAmt")::float ELSE 0 END
        ), 0)                                                                   AS bucket_90plus,
        TO_CHAR(MIN(
          CASE WHEN i.status IN ('confirmed','partial') THEN i."date" END
        ), 'YYYY-MM-DD')                                                        AS oldest_invoice_date
      FROM parties p
      LEFT JOIN invoices i
             ON i."partyId"  = p.id
            AND i."branchId" = ${branchId}::uuid
            AND i."txnType"  = 'sale_invoice'
      WHERE p.balance != 0
        AND p."branchId" = ${branchId}::uuid
      GROUP BY p.id, p.name, p.type, p.phone, p.balance
      ORDER BY ABS(p.balance) DESC
    `

    // Apply type filter in JS then cap with limit — doing LIMIT in SQL before the
    // type-filter would return fewer rows than requested when the result is mixed types.
    const filtered = rows
      .filter((r) => {
        if (q.type === 'customer' && r.balance <= 0) return false
        if (q.type === 'supplier' && r.balance >= 0) return false
        return true
      })
      .slice(0, q.limit)

    const totalOutstanding = filtered.reduce((s, r) => s + Math.abs(r.balance), 0)

    return {
      type:  q.type,
      total: totalOutstanding,
      count: filtered.length,
      aging: {
        '0_30':   filtered.reduce((s, r) => s + Number(r.bucket_0_30),   0),
        '31_60':  filtered.reduce((s, r) => s + Number(r.bucket_31_60),  0),
        '61_90':  filtered.reduce((s, r) => s + Number(r.bucket_61_90),  0),
        '90plus': filtered.reduce((s, r) => s + Number(r.bucket_90plus), 0),
      },
      parties: filtered.map((r) => ({
        partyId:   r.party_id,
        name:      r.party_name,
        type:      r.party_type,
        phone:     r.phone,
        balance:   Math.abs(r.balance),
        direction: r.balance > 0 ? 'receivable' : 'payable',
        aging: {
          '0_30':   Number(r.bucket_0_30),
          '31_60':  Number(r.bucket_31_60),
          '61_90':  Number(r.bucket_61_90),
          '90plus': Number(r.bucket_90plus),
        },
        oldestInvoiceDate: r.oldest_invoice_date,
      })),
    }
  })

  // ── GET /:id — single payment with allocations ────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db       = req.db
    const branchId = req.branchId

    const payment = await db.payment.findFirst({
      where: { id, branchId },
      include: {
        party: { select: { id: true, name: true, phone: true, gstin: true } },
        allocations: {
          include: {
            invoice: { select: { id: true, number: true, date: true, grandTotal: true, paidAmt: true, status: true } },
          },
        },
      },
    })
    if (!payment) return reply.status(404).send({ error: 'Payment not found' })

    const allocated   = payment.allocations.reduce((s, a) => s + Number(a.amount), 0)
    const unallocated = Number(payment.amount) - allocated

    return { ...payment, allocated, unallocated }
  })

  // ── POST /:id/void — void a payment, reverse all invoice allocations ───────
  app.post('/:id/void', async (req, reply) => {
    if (req.role !== 'owner' && req.role !== 'manager')
      return reply.status(403).send({ error: 'Only owner or manager can void payments' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      reason: z.string().min(1).max(300),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // Fast pre-flight outside tx — avoids locking for obvious rejects
    const check = await db.payment.findFirst({ where: { id, branchId }, select: { status: true } })
    if (!check)           return reply.status(404).send({ error: 'Payment not found' })
    if (check.status === 'voided') return reply.status(409).send({ error: 'Payment is already voided' })

    await db.$transaction(async (tx) => {
      // Lock payment row inside tx — get fresh state and prevent concurrent void
      const locked = await tx.$queryRaw<Array<{
        id: string; amount: number; party_id: string | null; type: string; status: string
      }>>`
        SELECT id, amount::float, "partyId"::text AS party_id, type, status
        FROM payments
        WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
        FOR UPDATE
      `
      if (!locked[0]) throw Object.assign(new Error('Payment not found'), { statusCode: 404 })
      if (locked[0].status === 'voided')
        throw Object.assign(new Error('Payment is already voided'), { statusCode: 409 })

      // Re-fetch allocations inside tx (stale pre-tx snapshot misses concurrent allocations)
      const allocations = await tx.paymentAllocation.findMany({ where: { paymentId: id } })

      // Sort invoice IDs before locking to prevent deadlocks with concurrent payment requests
      const sortedAllocs = [...allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))

      for (const alloc of sortedAllocs) {
        let inv: { paid_amt: number; grand_total: number } | undefined
        try {
          inv = await lockInvoice(tx, alloc.invoiceId, branchId)
        } catch {
          continue  // Invoice deleted concurrently — skip
        }

        const newPaid   = Math.max(0, inv.paid_amt - Number(alloc.amount))
        const newStatus = newPaid <= 0 ? 'confirmed' : 'partial'

        await tx.invoice.update({
          where: { id: alloc.invoiceId },
          data:  { paidAmt: newPaid, status: newStatus },
        })
      }

      await tx.paymentAllocation.deleteMany({ where: { paymentId: id } })

      if (locked[0].party_id) {
        const balanceDelta = locked[0].type === 'expense'
          ? -locked[0].amount   // expense was +balance, reverse is -
          : +locked[0].amount   // receipt/advance was -balance, reverse is +
        await tx.party.update({
          where: { id: locked[0].party_id },
          data:  { balance: { increment: balanceDelta } },
        })
      }

      await tx.payment.update({
        where: { id },
        data:  { status: 'voided', voidedAt: new Date(), voidReason: body.reason },
      })
    })

    return reply.send({ success: true, paymentId: id, reason: body.reason })
  })

  // ── POST /:id/allocate — apply advance payment against invoices ───────────
  // Used when a customer has paid in advance (type='advance') and invoices
  // are raised later. Caller specifies which invoices to allocate against
  // and how much to apply to each.
  app.post('/:id/allocate', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      allocations: z.array(z.object({
        invoiceId: z.string().uuid(),
        amount:    z.number().positive(),
      })).min(1),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const payment = await db.payment.findFirst({
      where:   { id, branchId },
      include: { allocations: { select: { amount: true } } },
    })
    if (!payment)
      return reply.status(404).send({ error: 'Payment not found' })
    if (payment.status === 'voided')
      return reply.status(409).send({ error: 'Cannot allocate a voided payment' })

    const newAllocTotal = body.allocations.reduce((s, a) => s + a.amount, 0)

    const allocatedInvoices: Array<{ invoiceId: string; amount: number; newStatus: string }> = []

    await db.$transaction(async (tx) => {
      // Lock payment row first — definitive available-balance check happens here,
      // not outside the tx where a concurrent allocation could sneak in between.
      const lockedPayment = await tx.$queryRaw<Array<{ amount: number; status: string }>>`
        SELECT amount::float, status
        FROM payments
        WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
        FOR UPDATE
      `
      if (!lockedPayment[0]) throw Object.assign(new Error('Payment not found'), { statusCode: 404 })
      if (lockedPayment[0].status === 'voided')
        throw Object.assign(new Error('Cannot allocate a voided payment'), { statusCode: 409 })

      const currentAllocs = await tx.paymentAllocation.findMany({
        where:  { paymentId: id },
        select: { amount: true },
      })
      const alreadyAllocatedLocked = currentAllocs.reduce((s, a) => s + Number(a.amount), 0)
      const availableBalanceLocked = lockedPayment[0].amount - alreadyAllocatedLocked

      if (newAllocTotal > availableBalanceLocked + 0.01)
        throw Object.assign(
          new Error(`Allocation total ₹${newAllocTotal} exceeds available balance ₹${availableBalanceLocked.toFixed(2)}`),
          { statusCode: 422 }
        )

      // Sort invoice IDs before locking to prevent deadlocks
      const sorted = [...body.allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))

      for (const alloc of sorted) {
        const inv = await lockInvoice(tx, alloc.invoiceId, branchId)
        if (inv.status === 'cancelled')
          throw Object.assign(new Error(`Invoice ${alloc.invoiceId} is cancelled`), { statusCode: 409 })

        const maxPayable = inv.grand_total - inv.paid_amt
        if (alloc.amount > maxPayable + 0.01)
          throw Object.assign(
            new Error(`Allocation ₹${alloc.amount} exceeds outstanding ₹${maxPayable.toFixed(2)} on invoice ${alloc.invoiceId}`),
            { statusCode: 422 }
          )

        await tx.paymentAllocation.create({
          data: { paymentId: id, invoiceId: alloc.invoiceId, amount: alloc.amount },
        })

        const newPaid   = inv.paid_amt + alloc.amount
        const newStatus = newPaid >= inv.grand_total - 0.01 ? 'paid' : 'partial'

        await tx.invoice.update({
          where: { id: alloc.invoiceId },
          data:  { paidAmt: newPaid, status: newStatus },
        })

        allocatedInvoices.push({ invoiceId: alloc.invoiceId, amount: alloc.amount, newStatus })
      }
    })

    return reply.send({
      paymentId:        id,
      totalAllocated:   newAllocTotal,
      allocatedInvoices,
    })
  })
}
