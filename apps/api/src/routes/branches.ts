// apps/api/src/routes/branches.ts
//
// Branch management — create, list, update, deactivate branches, cross-branch
// rollup analytics, and inter-branch stock transfers.
//
// All writes are owner-only. Reads allow manager+ to see their accessible branches.
//
//  GET    /api/branches             list branches accessible to this user
//  POST   /api/branches             create new branch (owner only)
//  GET    /api/branches/summary     cross-branch revenue rollup (owner only)
//  GET    /api/branches/:id         single branch detail
//  PATCH  /api/branches/:id         update name / address / gstin / domainConfig
//  POST   /api/branches/:id/deactivate
//  POST   /api/branches/:id/activate
//  POST   /api/branches/:id/stock-transfer   move stock to another branch

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'


export const branchRoutes: FastifyPluginAsync = async (app) => {

  // ── GET / — list branches ─────────────────────────────────────────────────
  // owner: sees all branches
  // manager/cashier: sees only their assigned branches (branchIds array)
  app.get('/', async (req) => {
    const db   = req.db
    const user = await db.user.findUnique({
      where:  { id: req.userId },
      select: { role: true, branchIds: true },
    })
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 401 })

    const where = user.role === 'owner' || user.branchIds.length === 0
      ? { isActive: true }
      : { isActive: true, id: { in: user.branchIds } }

    return db.branch.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })
  })

  // ── POST / — disabled: one tenant = one business = one branch ───────────────
  // The branch row is created once, at tenant registration (routes/tenants.ts).
  // Additional branches are intentionally not supported in this product.
  app.post('/', async (_req, reply) =>
    reply.status(403).send({
      error: 'Single-business account',
      message: 'This account runs as a single business — additional branches cannot be created.',
    }))

  // ── GET /summary — cross-branch revenue rollup ────────────────────────────
  // Owner-only: aggregate sales, collections, and outstanding across all branches.
  app.get('/summary', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can see cross-branch summaries' })

    const q = z.object({
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      period:   z.enum(['today', '7d', '30d', 'mtd', 'ytd']).default('30d'),
    }).parse(req.query)

    const db  = req.db
    let from: Date
    let to: Date = new Date()

    if (q.fromDate) {
      from = new Date(q.fromDate)
      to   = q.toDate ? new Date(q.toDate + 'T23:59:59') : to
    } else {
      to   = new Date()
      switch (q.period) {
        case 'today': from = new Date(to); from.setHours(0,0,0,0); break
        case '7d':    from = new Date(to.getTime() - 7  * 86400000); break
        case 'mtd':   from = new Date(to.getFullYear(), to.getMonth(), 1); break
        case 'ytd': {
          const apr = to.getMonth() >= 3
            ? new Date(to.getFullYear(), 3, 1)
            : new Date(to.getFullYear() - 1, 3, 1)
          from = apr
          break
        }
        default:      from = new Date(to.getTime() - 30 * 86400000); break
      }
    }

    const branches = await db.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, domainType: true },
    })

    const rows = await db.$queryRaw<Array<{
      branch_id:     string
      total_sales:   number
      total_paid:    number
      invoice_count: number
      outstanding:   number
    }>>`
      SELECT
        "branchId"                          AS branch_id,
        SUM("grandTotal"::float)            AS total_sales,
        SUM("paidAmt"::float)               AS total_paid,
        COUNT(*)::int                       AS invoice_count,
        SUM(("grandTotal" - "paidAmt")::float) AS outstanding
      FROM invoices
      WHERE "txnType" = 'sale_invoice'
        AND status IN ('confirmed','paid','partial')
        AND "date" BETWEEN ${from} AND ${to}
      GROUP BY "branchId"
    `

    const branchMap = new Map(branches.map((b) => [b.id, b]))
    const rowMap    = new Map(rows.map((r) => [r.branch_id, r]))

    const branchSummaries = branches.map((b) => {
      const r = rowMap.get(b.id)
      return {
        branchId:     b.id,
        name:         b.name,
        domainType:   b.domainType,
        totalSales:   Number(r?.total_sales   ?? 0),
        totalPaid:    Number(r?.total_paid     ?? 0),
        outstanding:  Number(r?.outstanding    ?? 0),
        invoiceCount: Number(r?.invoice_count  ?? 0),
      }
    })

    return {
      period:  q.period,
      from:    from.toISOString().slice(0, 10),
      to:      to.toISOString().slice(0, 10),
      totals: {
        totalSales:   branchSummaries.reduce((s, b) => s + b.totalSales,   0),
        totalPaid:    branchSummaries.reduce((s, b) => s + b.totalPaid,    0),
        outstanding:  branchSummaries.reduce((s, b) => s + b.outstanding,  0),
        invoiceCount: branchSummaries.reduce((s, b) => s + b.invoiceCount, 0),
      },
      branches: branchSummaries,
    }
  })

  // ── GET /:id — single branch detail ──────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    // Non-owner users can only see their own branches
    if (req.role !== 'owner') {
      const user = await db.user.findUnique({
        where:  { id: req.userId },
        select: { branchIds: true },
      })
      if (user && user.branchIds.length > 0 && !user.branchIds.includes(id))
        return reply.status(403).send({ error: 'No access to this branch' })
    }

    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return reply.status(404).send({ error: 'Branch not found' })
    return branch
  })

  // ── PATCH /:id — update branch ────────────────────────────────────────────
  app.patch('/:id', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can update branch details' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      name:         z.string().min(2).max(200).trim().optional(),
      gstin:        z.string().max(15).optional().nullable(),
      stateCode:    z.string().length(2).regex(/^\d{2}$/).optional().nullable(),
      address:      z.record(z.unknown()).optional(),
      domainConfig: z.record(z.unknown()).optional(),
    }).parse(req.body)

    const db = req.db
    const existing = await db.branch.findUnique({ where: { id } })
    if (!existing) return reply.status(404).send({ error: 'Branch not found' })

    // Merge domainConfig — don't wholesale replace
    const mergedConfig = body.domainConfig
      ? { ...(existing.domainConfig as object), ...body.domainConfig }
      : undefined

    return db.branch.update({
      where: { id },
      data:  {
        ...(body.name      !== undefined && { name:      body.name }),
        ...(body.gstin     !== undefined && { gstin:     body.gstin }),
        ...(body.stateCode !== undefined && { stateCode: body.stateCode }),
        ...(body.address   !== undefined && { address:   body.address as never }),
        ...(mergedConfig   !== undefined && { domainConfig: mergedConfig as never }),
      },
    })
  })

  // ── POST /:id/deactivate ──────────────────────────────────────────────────
  app.post('/:id/deactivate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can deactivate branches' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return reply.status(404).send({ error: 'Branch not found' })

    const activeBranches = await db.branch.count({ where: { isActive: true } })
    if (activeBranches <= 1)
      return reply.status(409).send({ error: 'Cannot deactivate the last active branch' })

    return db.branch.update({ where: { id }, data: { isActive: false } })
  })

  // ── POST /:id/activate ────────────────────────────────────────────────────
  app.post('/:id/activate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can activate branches' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) return reply.status(404).send({ error: 'Branch not found' })

    return db.branch.update({ where: { id }, data: { isActive: true } })
  })

  // ── POST /:id/stock-transfer — inter-branch stock movement ────────────────
  // Creates two StockLedger entries: one OUT from source (this branch in JWT),
  // one IN at the destination branch. Validates stock availability at source
  // before committing. Does not affect party balances or generate invoices.
  app.post('/:id/stock-transfer', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required for stock transfers' })

    const { id: toBranchId } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      items: z.array(z.object({
        productId: z.string().uuid(),
        qty:       z.number().positive(),
        notes:     z.string().max(200).optional(),
      })).min(1),
      reason: z.string().max(300).optional(),
    }).parse(req.body)

    const db           = req.db
    const fromBranchId = req.branchId

    if (fromBranchId === toBranchId)
      return reply.status(422).send({ error: 'Source and destination branch cannot be the same' })

    const toBranch = await db.branch.findUnique({ where: { id: toBranchId }, select: { id: true, name: true, isActive: true } })
    if (!toBranch)        return reply.status(404).send({ error: 'Destination branch not found' })
    if (!toBranch.isActive) return reply.status(409).send({ error: 'Destination branch is not active' })

    // Validate stock availability at source branch for each product
    const stockChecks = await Promise.all(
      body.items.map(async (item) => {
        const result = await db.$queryRaw<Array<{ qty_on_hand: number }>>`
          SELECT COALESCE(SUM(qty), 0)::float AS qty_on_hand
          FROM stock_ledger
          WHERE "branchId" = ${fromBranchId}::uuid
            AND "productId" = ${item.productId}::uuid
        `
        return { productId: item.productId, onHand: Number(result[0]?.qty_on_hand ?? 0), requested: item.qty }
      })
    )

    const insufficient = stockChecks.filter((s) => s.onHand < s.requested)
    if (insufficient.length > 0) {
      return reply.status(422).send({
        error: 'Insufficient stock',
        items: insufficient.map((s) => ({
          productId: s.productId,
          available: s.onHand,
          requested: s.requested,
        })),
      })
    }

    // Fetch product names for description
    const productIds = body.items.map((i) => i.productId)
    const products   = await db.product.findMany({
      where:  { id: { in: productIds } },
      select: { id: true, name: true },
    })
    const productMap = new Map(products.map((p) => [p.id, p]))

    // Atomic transaction: debit source, credit destination
    await db.$transaction(async (tx) => {
      const notes = body.reason ?? 'Inter-branch transfer'

      await tx.stockLedger.createMany({
        data: body.items.flatMap((item) => [
          {
            // Outgoing from source
            branchId:  fromBranchId,
            productId: item.productId,
            txnType:   'transfer_out',
            qty:       -item.qty,
            rate:      null,
            refType:   'stock_transfer',
            refId:     null,
          },
          {
            // Incoming to destination
            branchId:  toBranchId,
            productId: item.productId,
            txnType:   'transfer_in',
            qty:       item.qty,
            rate:      null,
            refType:   'stock_transfer',
            refId:     null,
          },
        ]),
      })
    })

    return reply.send({
      success:        true,
      fromBranchId,
      toBranchId,
      toBranchName:   toBranch.name,
      reason:         body.reason ?? null,
      itemsTransferred: body.items.map((item) => ({
        productId:   item.productId,
        productName: productMap.get(item.productId)?.name ?? item.productId,
        qty:         item.qty,
      })),
    })
  })
}
