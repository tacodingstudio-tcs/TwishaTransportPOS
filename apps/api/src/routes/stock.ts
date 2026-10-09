// apps/api/src/routes/stock.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

export const stockRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/stock ──────────────────────────────────────────────────────────
  // Stock balances for all products in this branch.
  // Returns shape expected by StockLevelsPage: { data: [{ id, productId, currentQty,
  // reservedQty, product: { name, unit, sku, lowStockQty, category: { name } } }] }
  app.get('/', async (req) => {
    const { branchId } = req
    const { q, status } = z.object({
      q:      z.string().optional(),
      status: z.enum(['low', 'out']).optional(),
      limit:  z.coerce.number().int().min(1).max(1000).default(200),
    }).parse(req.query)

    const likePattern = q ? `%${q}%` : null
    const rows = await req.db.$queryRaw<Array<{
      id: string; productId: string; currentQty: number; reservedQty: number
      name: string; sku: string | null; unit: string
      lowStockQty: number; categoryName: string | null
    }>>`
      SELECT
        p.id::text                              AS id,
        p.id::text                              AS "productId",
        COALESCE(SUM(sl.qty), 0)::float         AS "currentQty",
        0::float                                AS "reservedQty",
        p.name,
        p.sku,
        p.unit,
        p."lowStockQty"::float                  AS "lowStockQty",
        c.name                                  AS "categoryName"
      FROM products p
      LEFT JOIN stock_ledger sl
        ON sl."productId" = p.id
        AND sl."branchId" = ${branchId}::uuid
      LEFT JOIN categories c ON c.id = p."categoryId"
      WHERE p."isActive"   = true
        AND p."trackStock" = true
        AND (${likePattern}::text IS NULL OR p.name ILIKE ${likePattern}::text)
      GROUP BY p.id, p.name, p.sku, p.unit, p."lowStockQty", c.name
      ORDER BY p.name ASC
    `

    // Shape into nested form the UI expects
    let data = rows.map(r => ({
      id:          r.id,
      productId:   r.productId,
      currentQty:  r.currentQty,
      reservedQty: r.reservedQty,
      product: {
        name:       r.name,
        sku:        r.sku,
        unit:       r.unit,
        lowStockQty: r.lowStockQty,
        category:   r.categoryName ? { name: r.categoryName } : null,
      },
    }))

    if (status === 'out') data = data.filter(r => r.currentQty <= 0)
    if (status === 'low') data = data.filter(r => r.currentQty > 0 && r.currentQty <= r.product.lowStockQty)

    return { data, meta: { total: data.length } }
  })

  // ── GET /api/stock/ledger/:productId ─────────────────────────────────────────
  // Recent stock ledger entries for one product (used by StockLevelsPage drill-down)
  app.get('/ledger/:productId', async (req) => {
    const { productId } = z.object({ productId: z.string().uuid() }).parse(req.params)
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query)
    const { branchId } = req

    const entries = await req.db.stockLedger.findMany({
      where:   { productId, branchId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    })
    return { data: entries }
  })

  // ── GET /api/stock/low ──────────────────────────────────────────────────────
  // Products currently at or below reorder level
  app.get('/low', async (req) => {
    const { branchId } = req

    const result = await req.db.$queryRaw<Array<{
      productId: string; name: string; sku: string | null; unit: string
      qtyOnHand: number; lowStockQty: number
    }>>`
      SELECT
        p.id::text                       AS "productId",
        p.name,
        p.sku,
        p.unit,
        COALESCE(SUM(sl.qty), 0)::float  AS "qtyOnHand",
        p."lowStockQty"::float           AS "lowStockQty"
      FROM products p
      LEFT JOIN stock_ledger sl
        ON sl."productId" = p.id
        AND sl."branchId" = ${branchId}::uuid
      WHERE p."isActive"   = true
        AND p."trackStock" = true
        AND p."lowStockQty" > 0
      GROUP BY p.id, p.name, p.sku, p.unit, p."lowStockQty"
      HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty"
      ORDER BY (COALESCE(SUM(sl.qty), 0) / NULLIF(p."lowStockQty", 0)) ASC
    `

    return { count: result.length, data: result }
  })

  // ── GET /api/stock/expiry-alerts ────────────────────────────────────────────
  // Batches expiring within ?days (default 90). Sorted by expiry date asc.
  // Designed for pharmacy but works for any domain using batch tracking.
  app.get('/expiry-alerts', async (req) => {
    const { branchId } = req
    const { days = '90' } = req.query as { days?: string }
    const daysAhead = Math.min(Math.max(parseInt(days, 10) || 90, 1), 365)

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + daysAhead)

    const batches = await req.db.$queryRaw<Array<{
      batchId: string; batchNo: string; productId: string; productName: string
      sku: string | null; unit: string; expDate: string; daysToExpiry: number
      qtyRemaining: number; urgency: string
    }>>`
      SELECT
        b.id::text                                          AS "batchId",
        b."batchNo",
        p.id::text                                          AS "productId",
        p.name                                              AS "productName",
        p.sku,
        p.unit,
        TO_CHAR(b."expDate", 'YYYY-MM-DD')                  AS "expDate",
        (b."expDate" - CURRENT_DATE)::int                   AS "daysToExpiry",
        b."qtyRemaining"::float                             AS "qtyRemaining",
        CASE
          WHEN b."expDate" < CURRENT_DATE                           THEN 'expired'
          WHEN b."expDate" <= CURRENT_DATE + INTERVAL '30 days'    THEN 'critical'
          WHEN b."expDate" <= CURRENT_DATE + INTERVAL '60 days'    THEN 'warning'
          ELSE                                                           'notice'
        END                                                 AS urgency
      FROM batches b
      JOIN products p ON p.id = b."productId"
      WHERE p."branchId" = ${branchId}::uuid
        AND b."qtyRemaining" > 0
        AND b."expDate" <= ${cutoff}::date
      ORDER BY b."expDate" ASC
    `

    const grouped = {
      expired:  batches.filter(b => b.urgency === 'expired'),
      critical: batches.filter(b => b.urgency === 'critical'),
      warning:  batches.filter(b => b.urgency === 'warning'),
      notice:   batches.filter(b => b.urgency === 'notice'),
    }

    return {
      daysAhead,
      totalBatches: batches.length,
      summary: {
        expired:  grouped.expired.length,
        critical: grouped.critical.length,
        warning:  grouped.warning.length,
        notice:   grouped.notice.length,
      },
      batches: grouped,
    }
  })
}
