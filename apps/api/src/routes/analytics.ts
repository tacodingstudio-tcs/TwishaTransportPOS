// apps/api/src/routes/analytics.ts
//
// Domain-aware analytics endpoints.
//
//  GET /api/analytics/dashboard?period=7d|30d|90d&compareWith=prev_period|prev_year
//  GET /api/analytics/revenue-trend?period=7d|30d|90d&groupBy=day|week|month
//  GET /api/analytics/gst-summary?month=YYYY-MM
//  GET /api/analytics/payment-methods?period=7d|30d|90d
//  GET /api/analytics/top-customers?period=7d|30d|90d&limit=10
//  GET /api/analytics/margin-report?period=7d|30d|90d

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { cacheKey, getOrSet } from '../lib/cache.js'

// ── Types ──────────────────────────────────────────────────────────────────────

interface KPI {
  key:        string
  label:      string
  value:      number | string
  unit?:      string           // '₹' | 'count' | '%' | 'L' | 'days'
  prev?:      number           // value in comparison period
  delta?:     number           // % change
  trend?:     'up' | 'down' | 'neutral'
  highlight?: 'good' | 'warn' | 'danger'
}

interface ChartPoint  { x: string; y: number }
interface ChartSeries { label: string; data: ChartPoint[] }

interface Chart {
  key:    string
  title:  string
  type:   'line' | 'bar' | 'donut' | 'stacked_bar'
  unit?:  string
  series: ChartSeries[]
}

interface DashboardResponse {
  period:      string
  compareWith: string | null
  from:        string
  to:          string
  domain:      string
  kpis:        KPI[]
  charts:      Chart[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const periodDays = (p: string) => p === '30d' ? 30 : p === '90d' ? 90 : 7
const iso        = (d: Date)   => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dateRange(days: number, anchor = new Date()): { from: Date; to: Date } {
  const to   = new Date(anchor)
  const from = new Date(anchor)
  from.setDate(from.getDate() - days)
  return { from, to }
}

function pctDelta(cur: number, prev: number): number | undefined {
  return prev === 0 ? undefined : Math.round(((cur - prev) / prev) * 100)
}

function trend(delta: number | undefined, higherIsBetter = true): 'up' | 'down' | 'neutral' {
  if (delta === undefined) return 'neutral'
  if (delta === 0) return 'neutral'
  return (delta > 0) === higherIsBetter ? 'up' : 'down'
}

// ── Shared SQL fragments (parameterised — no raw string injection) ─────────────

// Returns { total, count, collected, outstanding } for a date range + branchId
async function revenueStats(
  db: any,
  branchId: string,
  from: string,
  to: string,
): Promise<{ total: number; count: number; collected: number; outstanding: number }> {
  const rows = await db.$queryRaw<[{ total: number; count: number; collected: number; outstanding: number }]>`
    SELECT
      COALESCE(SUM("grandTotal"),0)::float             AS total,
      COUNT(*)::int                                     AS count,
      COALESCE(SUM("paidAmt"),0)::float                AS collected,
      COALESCE(SUM("grandTotal" - "paidAmt"),0)::float AS outstanding
    FROM invoices
    WHERE "branchId" = ${branchId}::uuid
      AND "txnType"  = 'sale_invoice'
      AND "date"    >= ${from}::date
      AND "date"    <= ${to}::date
  `
  return rows[0]!
}

// Daily revenue bars — used by every domain
async function dailyRevenueSeries(
  db: any,
  branchId: string,
  from: string,
  to: string,
): Promise<Array<{ day: string; revenue: number; invoices: number }>> {
  return db.$queryRaw`
    SELECT
      DATE("date")::text                   AS day,
      COALESCE(SUM("grandTotal"),0)::float AS revenue,
      COUNT(*)::int                         AS invoices
    FROM invoices
    WHERE "branchId" = ${branchId}::uuid
      AND "txnType"  = 'sale_invoice'
      AND "date"    >= ${from}::date
      AND "date"    <= ${to}::date
    GROUP BY DATE("date")
    ORDER BY day ASC
  `
}

// Payment method breakdown from the payments table (source of truth for method)
async function paymentMethodBreakdown(
  db: any,
  branchId: string,
  from: string,
  to: string,
): Promise<Array<{ method: string; amount: number; count: number }>> {
  return db.$queryRaw`
    SELECT
      method,
      COALESCE(SUM(amount),0)::float AS amount,
      COUNT(*)::int                   AS count
    FROM payments
    WHERE "branchId" = ${branchId}::uuid
      AND "paymentDate" >= ${from}::date
      AND "paymentDate" <= ${to}::date
    GROUP BY method
    ORDER BY amount DESC
  `
}

// Top products/services by revenue
async function topProductsSeries(
  db: any,
  branchId: string,
  from: string,
  to: string,
  limit = 8,
): Promise<Array<{ name: string; qty: number; revenue: number }>> {
  return db.$queryRaw`
    SELECT p.name,
           SUM(ii.qty)::float   AS qty,
           SUM(ii.total)::float AS revenue
    FROM invoice_items ii
    JOIN products p ON p.id = ii."productId"
    JOIN invoices  i ON i.id = ii."invoiceId"
    WHERE i."branchId" = ${branchId}::uuid
      AND i."txnType"  = 'sale_invoice'
      AND i."date"    >= ${from}::date
      AND i."date"    <= ${to}::date
    GROUP BY p.name
    ORDER BY revenue DESC
    LIMIT ${limit}
  `
}

// Gross margin per product (requires purchasePrice on product)
async function grossMarginData(
  db: any,
  branchId: string,
  from: string,
  to: string,
): Promise<{ totalRevenue: number; totalCOGS: number; marginPct: number; rows: Array<{ name: string; revenue: number; cogs: number; margin_pct: number }> }> {
  const rows = await db.$queryRaw<Array<{ name: string; revenue: number; cogs: number; margin_pct: number }>>`
    SELECT
      p.name,
      COALESCE(SUM(ii.total),0)::float                                          AS revenue,
      COALESCE(SUM(ii.qty * COALESCE(p."purchasePrice",0)),0)::float           AS cogs,
      CASE
        WHEN SUM(ii.total) > 0
        THEN ROUND(((SUM(ii.total) - SUM(ii.qty * COALESCE(p."purchasePrice",0))) / SUM(ii.total) * 100)::numeric, 1)::float
        ELSE 0
      END AS margin_pct
    FROM invoice_items ii
    JOIN products p ON p.id = ii."productId"
    JOIN invoices  i ON i.id = ii."invoiceId"
    WHERE i."branchId" = ${branchId}::uuid
      AND i."txnType"  = 'sale_invoice'
      AND i."date"    >= ${from}::date
      AND i."date"    <= ${to}::date
      AND p."purchasePrice" IS NOT NULL
      AND p."purchasePrice" > 0
    GROUP BY p.name
    ORDER BY revenue DESC
    LIMIT 10
  `
  const totalRevenue = rows.reduce((s: number, r: { revenue: number; cogs: number }) => s + r.revenue, 0)
  const totalCOGS    = rows.reduce((s: number, r: { revenue: number; cogs: number }) => s + r.cogs, 0)
  const marginPct    = totalRevenue > 0 ? Math.round(((totalRevenue - totalCOGS) / totalRevenue) * 100) : 0
  return { totalRevenue, totalCOGS, marginPct, rows }
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export const analyticsRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/analytics/dashboard ─────────────────────────────────────────────
  app.get('/dashboard', async (req, reply) => {
    const q = z.object({
      period:      z.enum(['7d', '30d', '90d']).default('7d'),
      compareWith: z.enum(['prev_period', 'prev_year']).optional(),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'dash', q.period, q.compareWith ?? 'none')
    const result = await getOrSet(key, 300, async () => {
    const db        = req.db
    const branchId  = req.branchId
    const days      = periodDays(q.period)
    const now       = new Date()
    const { from }  = dateRange(days, now)

    const fromStr = iso(from)
    const toStr   = iso(now)

    // Comparison range
    let prevFromStr: string | null = null
    let prevToStr:   string | null = null
    if (q.compareWith === 'prev_period') {
      const pTo   = new Date(from); pTo.setDate(pTo.getDate() - 1)
      const pFrom = new Date(pTo);  pFrom.setDate(pFrom.getDate() - days)
      prevFromStr = iso(pFrom)
      prevToStr   = iso(pTo)
    } else if (q.compareWith === 'prev_year') {
      const pFrom = new Date(from); pFrom.setFullYear(pFrom.getFullYear() - 1)
      const pTo   = new Date(now);  pTo.setFullYear(pTo.getFullYear() - 1)
      prevFromStr = iso(pFrom)
      prevToStr   = iso(pTo)
    }

    // Always fetch branch domain
    const branch = await db.branch.findUnique({
      where: { id: branchId }, select: { domainType: true },
    })
    if (!branch) return reply.status(404).send({ error: 'Branch not found' })
    const domainType = branch.domainType

    // Parallel base fetches
    const [rev, prevRev, daily, payMethods, margin] = await Promise.all([
      revenueStats(db, branchId, fromStr, toStr),
      prevFromStr && prevToStr
        ? revenueStats(db, branchId, prevFromStr, prevToStr)
        : Promise.resolve(null),
      dailyRevenueSeries(db, branchId, fromStr, toStr),
      paymentMethodBreakdown(db, branchId, fromStr, toStr),
      grossMarginData(db, branchId, fromStr, toStr),
    ])

    const revDelta = prevRev ? pctDelta(rev.total, prevRev.total) : undefined

    // Universal charts present on every domain
    const universalCharts: Chart[] = [
      {
        key: 'daily_revenue', title: 'Daily Revenue', type: 'bar', unit: '₹',
        series: [
          { label: 'Revenue',  data: daily.map(r => ({ x: r.day, y: r.revenue  })) },
          { label: 'Invoices', data: daily.map(r => ({ x: r.day, y: r.invoices })) },
        ],
      },
      ...(payMethods.length > 0 ? [{
        key: 'payment_methods', title: 'Collections by Payment Mode', type: 'donut' as const, unit: '₹',
        series: payMethods.map(r => ({
          label: r.method,
          data:  [{ x: r.method, y: r.amount }],
        })),
      }] : []),
      ...(margin.rows.length > 0 ? [{
        key: 'margin', title: 'Gross Margin by Product', type: 'bar' as const, unit: '%',
        series: [{
          label: 'Margin %',
          data: margin.rows.map(r => ({ x: r.name, y: r.margin_pct })),
        }],
      }] : []),
    ]

    // Universal KPI always present
    const universalMarginKpi: KPI | null = margin.marginPct > 0 ? {
      key: 'gross_margin', label: 'Gross Margin', value: margin.marginPct, unit: '%',
      highlight: margin.marginPct >= 30 ? 'good' : margin.marginPct >= 15 ? 'warn' : 'danger',
    } : null

    let domainKpis:   KPI[]   = []
    let domainCharts: Chart[] = []

    // ── TRANSPORT / LOGISTICS ─────────────────────────────────────────────────
    if (domainType === 'transport') {
      const [lrStats, tripStats, expRows, routeRows] = await Promise.all([
        db.$queryRaw<Array<{ lr_count: number; freight: number; delivered: number; pending_pod: number }>>`
          SELECT COUNT(*)::int                                                   AS lr_count,
                 COALESCE(SUM("totalAmount"::float), 0)::float                   AS freight,
                 COUNT(*) FILTER (WHERE status IN ('delivered','pod_received','billed'))::int AS delivered,
                 COUNT(*) FILTER (WHERE status = 'delivered')::int               AS pending_pod
          FROM transport_lorry_receipts
          WHERE "branchId" = ${branchId}::uuid AND status != 'cancelled'
            AND "lrDate" BETWEEN ${fromStr}::date AND ${toStr}::date`,
        db.$queryRaw<Array<{ completed: number; running: number; hire: number }>>`
          SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
                 COUNT(*) FILTER (WHERE status = 'running')::int   AS running,
                 COALESCE(SUM("hireCharges"::float) FILTER (WHERE status != 'cancelled'), 0)::float AS hire
          FROM transport_trips
          WHERE "branchId" = ${branchId}::uuid
            AND "startDate" BETWEEN ${fromStr}::date AND ${toStr}::date`,
        db.$queryRaw<Array<{ category: string; amount: number }>>`
          SELECT category, COALESCE(SUM(amount::float), 0)::float AS amount
          FROM transport_expenses
          WHERE "branchId" = ${branchId}::uuid
            AND "expenseDate" BETWEEN ${fromStr}::date AND ${toStr}::date
          GROUP BY category ORDER BY amount DESC`,
        db.$queryRaw<Array<{ route: string; freight: number }>>`
          SELECT ("fromCity" || ' → ' || "toCity") AS route,
                 COALESCE(SUM("totalAmount"::float), 0)::float AS freight
          FROM transport_lorry_receipts
          WHERE "branchId" = ${branchId}::uuid AND status != 'cancelled'
            AND "lrDate" BETWEEN ${fromStr}::date AND ${toStr}::date
          GROUP BY 1 ORDER BY freight DESC LIMIT 8`,
      ])
      const lr         = lrStats[0]  ?? { lr_count: 0, freight: 0, delivered: 0, pending_pod: 0 }
      const trips      = tripStats[0] ?? { completed: 0, running: 0, hire: 0 }
      const tripExp    = expRows.reduce((s, r) => s + r.amount, 0)
      const totalCost  = tripExp + trips.hire
      const net        = lr.freight - totalCost
      const netPct     = lr.freight > 0 ? Math.round((net / lr.freight) * 1000) / 10 : 0

      domainKpis = [
        { key: 'freight',     label: 'Freight Booked',  value: lr.freight,       unit: '₹' },
        { key: 'billed',      label: 'Billed',          value: rev.total,        unit: '₹', delta: revDelta, trend: trend(revDelta), prev: prevRev?.total },
        { key: 'collected',   label: 'Collected',       value: rev.collected,    unit: '₹' },
        { key: 'outstanding', label: 'Outstanding',     value: rev.outstanding,  unit: '₹', highlight: rev.outstanding > 0 ? 'warn' : 'good' },
        { key: 'lrs',         label: 'LRs Booked',      value: lr.lr_count,      unit: 'count' },
        { key: 'trips',       label: 'Trips Completed', value: trips.completed,  unit: 'count' },
        { key: 'pending_pod', label: 'POD Pending',     value: lr.pending_pod,   unit: 'count', highlight: lr.pending_pod > 0 ? 'warn' : 'good' },
        { key: 'trip_cost',   label: 'Trip Costs',      value: totalCost,        unit: '₹' },
        { key: 'net_margin',  label: 'Net Margin',      value: netPct,           unit: '%', highlight: netPct >= 15 ? 'good' : netPct >= 5 ? 'warn' : 'danger' },
      ]
      domainCharts = [
        { key: 'top_routes', title: 'Top Routes by Freight', type: 'bar', unit: '₹',
          series: [{ label: 'Freight', data: routeRows.map(r => ({ x: r.route, y: r.freight })) }] },
        ...(expRows.length > 0 ? [{
          key: 'expense_mix', title: 'Trip Expenses by Category', type: 'donut' as const, unit: '₹',
          series: expRows.map(r => ({ label: r.category, data: [{ x: r.category, y: r.amount }] })),
        }] : []),
      ]
    }

    // ── DEFAULT (any other domain type) ───────────────────────────────────────
    else {
      const topProds = await topProductsSeries(db, branchId, fromStr, toStr)
      const avgBill  = rev.count > 0 ? Math.round(rev.total / rev.count) : 0

      domainKpis = [
        { key: 'revenue',     label: 'Revenue',       value: rev.total,       unit: '₹', delta: revDelta, trend: trend(revDelta), prev: prevRev?.total },
        { key: 'invoices',    label: 'Bills',         value: rev.count,       unit: 'count' },
        { key: 'collected',   label: 'Collected',     value: rev.collected,   unit: '₹' },
        { key: 'outstanding', label: 'Outstanding',   value: rev.outstanding, unit: '₹', highlight: rev.outstanding > 0 ? 'warn' : 'good' },
        { key: 'avg_bill',    label: 'Avg Bill',      value: avgBill,         unit: '₹' },
        ...(universalMarginKpi ? [universalMarginKpi] : []),
      ]
      domainCharts = [
        { key: 'top_products', title: 'Top Products / Services', type: 'bar', unit: '₹',
          series: [{ label: 'Revenue', data: topProds.map(p => ({ x: p.name, y: p.revenue })) }] },
      ]
    }

    return {
      period:      q.period,
      compareWith: q.compareWith ?? null,
      from:        fromStr,
      to:          toStr,
      domain:      domainType,
      kpis:        domainKpis,
      charts:      [...universalCharts, ...domainCharts],
    } as DashboardResponse
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/gst-summary?month=YYYY-MM ──────────────────────────
  // Returns GSTR-1 structured totals for a calendar month.
  app.get('/gst-summary', async (req, reply) => {
    const q = z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format: YYYY-MM'),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'gst', q.month)
    const result = await getOrSet(key, 900, async () => {
    const [year, mon] = q.month.split('-').map(Number) as [number, number]
    const from = `${q.month}-01`
    const to   = iso(new Date(year, mon, 0))   // last day of month
    const branchId = req.branchId
    const db       = req.db

    const [gstTotals, hsnSummary, b2bVsB2c, rateWise] = await Promise.all([

      // Overall GST totals for the month
      db.$queryRaw<[{
        taxable_amt: number; cgst: number; sgst: number; igst: number; cess: number
        total_invoice_value: number; invoice_count: number
      }]>`
        SELECT
          COALESCE(SUM("taxableAmt"),0)::float   AS taxable_amt,
          COALESCE(SUM("cgstTotal"),0)::float    AS cgst,
          COALESCE(SUM("sgstTotal"),0)::float    AS sgst,
          COALESCE(SUM("igstTotal"),0)::float    AS igst,
          COALESCE(SUM("cessTotal"),0)::float    AS cess,
          COALESCE(SUM("grandTotal"),0)::float   AS total_invoice_value,
          COUNT(*)::int                          AS invoice_count
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'sale_invoice'
          AND "date"    >= ${from}::date
          AND "date"    <= ${to}::date
          AND status   != 'draft'
      `,

      // HSN-wise summary (GSTR-1 Table 12)
      db.$queryRaw<Array<{
        hsn: string; description: string; uqc: string
        qty: number; taxable_value: number; cgst: number; sgst: number; igst: number
      }>>`
        SELECT
          COALESCE(ii."hsnSacCode", p."hsnSacCode", 'NA')  AS hsn,
          MIN(ii.description)                               AS description,
          MIN(ii.unit)                                      AS uqc,
          SUM(ii.qty)::float                                AS qty,
          COALESCE(SUM(ii."taxableAmt"),0)::float           AS taxable_value,
          COALESCE(SUM(ii."cgstAmt"),0)::float              AS cgst,
          COALESCE(SUM(ii."sgstAmt"),0)::float              AS sgst,
          COALESCE(SUM(ii."igstAmt"),0)::float              AS igst
        FROM invoice_items ii
        LEFT JOIN products p ON p.id = ii."productId"
        JOIN invoices i ON i.id = ii."invoiceId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."txnType"  = 'sale_invoice'
          AND i."date"    >= ${from}::date
          AND i."date"    <= ${to}::date
          AND i.status   != 'draft'
        GROUP BY COALESCE(ii."hsnSacCode", p."hsnSacCode", 'NA')
        ORDER BY taxable_value DESC
      `,

      // B2B (party has GSTIN) vs B2C breakdown
      db.$queryRaw<Array<{ type: string; count: number; taxable: number; tax: number }>>`
        SELECT
          CASE WHEN p.gstin IS NOT NULL AND p.gstin != '' THEN 'B2B' ELSE 'B2C' END AS type,
          COUNT(*)::int                                                  AS count,
          COALESCE(SUM(i."taxableAmt"),0)::float                        AS taxable,
          COALESCE(SUM(i."cgstTotal" + i."sgstTotal" + i."igstTotal"),0)::float AS tax
        FROM invoices i
        LEFT JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid AND i."txnType" = 'sale_invoice'
          AND i."date" >= ${from}::date AND i."date" <= ${to}::date AND i.status != 'draft'
        GROUP BY (CASE WHEN p.gstin IS NOT NULL AND p.gstin != '' THEN 'B2B' ELSE 'B2C' END)
      `,

      // GST rate-wise breakup
      db.$queryRaw<Array<{ gst_rate: number; taxable_value: number; tax_amount: number }>>`
        SELECT
          ii."gstRate"::float                               AS gst_rate,
          COALESCE(SUM(ii."taxableAmt"),0)::float           AS taxable_value,
          COALESCE(SUM(ii."cgstAmt" + ii."sgstAmt" + ii."igstAmt"),0)::float AS tax_amount
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii."invoiceId"
        WHERE i."branchId" = ${branchId}::uuid AND i."txnType" = 'sale_invoice'
          AND i."date" >= ${from}::date AND i."date" <= ${to}::date AND i.status != 'draft'
        GROUP BY ii."gstRate"
        ORDER BY ii."gstRate"
      `,
    ])

    return {
      month:   q.month,
      from,
      to,
      summary: gstTotals[0],
      b2b_vs_b2c:  b2bVsB2c,
      rate_wise:   rateWise,
      hsn_summary: hsnSummary,
    }
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/payment-methods?period=7d|30d|90d ─────────────────
  app.get('/payment-methods', async (req, reply) => {
    const q = z.object({
      period: z.enum(['7d', '30d', '90d']).default('30d'),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'pay', q.period)
    const result = await getOrSet(key, 300, async () => {
    const days     = periodDays(q.period)
    const now      = new Date()
    const { from } = dateRange(days, now)
    const fromStr  = iso(from)
    const toStr    = iso(now)
    const branchId = req.branchId
    const db       = req.db

    const [byMethod, daily, cashVsDigital] = await Promise.all([
      db.$queryRaw<Array<{ method: string; amount: number; count: number }>>`
        SELECT method,
               COALESCE(SUM(amount),0)::float AS amount,
               COUNT(*)::int AS count
        FROM payments WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" >= ${fromStr}::date AND "paymentDate" <= ${toStr}::date
        GROUP BY method ORDER BY amount DESC
      `,
      db.$queryRaw<Array<{ day: string; cash: number; digital: number }>>`
        SELECT "paymentDate"::text AS day,
               COALESCE(SUM(amount) FILTER (WHERE method = 'cash'),0)::float    AS cash,
               COALESCE(SUM(amount) FILTER (WHERE method != 'cash'),0)::float   AS digital
        FROM payments WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" >= ${fromStr}::date AND "paymentDate" <= ${toStr}::date
        GROUP BY "paymentDate" ORDER BY day ASC
      `,
      db.$queryRaw<[{ cash: number; digital: number; total: number }]>`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE method = 'cash'),0)::float    AS cash,
          COALESCE(SUM(amount) FILTER (WHERE method != 'cash'),0)::float   AS digital,
          COALESCE(SUM(amount),0)::float                                    AS total
        FROM payments WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" >= ${fromStr}::date AND "paymentDate" <= ${toStr}::date
      `,
    ])

    const cv = cashVsDigital[0]!
    const digitalPct = cv.total > 0 ? Math.round(cv.digital / cv.total * 100) : 0

    return {
      period: q.period, from: fromStr, to: toStr,
      summary: { ...cv, digital_pct: digitalPct },
      by_method: byMethod,
      daily_cash_vs_digital: daily,
    }
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/revenue-trend ──────────────────────────────────────
  app.get('/revenue-trend', async (req, reply) => {
    const q = z.object({
      period:  z.enum(['7d', '30d', '90d']).default('30d'),
      groupBy: z.enum(['day', 'week', 'month']).default('day'),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'trend', q.period, q.groupBy)
    const result = await getOrSet(key, 300, async () => {
    const days     = periodDays(q.period)
    const now      = new Date()
    const { from } = dateRange(days, now)
    const fromStr  = iso(from)
    const toStr    = iso(now)
    const branchId = req.branchId
    const db       = req.db

    // Use Prisma.raw only for the validated enum — prevents injection
    const truncFn = q.groupBy === 'month' ? Prisma.raw("'month'")
                  : q.groupBy === 'week'  ? Prisma.raw("'week'")
                  : Prisma.raw("'day'")

    const rows = await db.$queryRaw<Array<{
      period: string; revenue: number; invoices: number; collected: number
    }>>`
      SELECT
        DATE_TRUNC(${truncFn}, "date")::date::text   AS period,
        COALESCE(SUM("grandTotal"),0)::float          AS revenue,
        COUNT(*)::int                                 AS invoices,
        COALESCE(SUM("paidAmt"),0)::float             AS collected
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND "txnType"  = 'sale_invoice'
        AND "date"    >= ${fromStr}::date
        AND "date"    <= ${toStr}::date
      GROUP BY DATE_TRUNC(${truncFn}, "date")
      ORDER BY period ASC
    `

    return { from: fromStr, to: toStr, groupBy: q.groupBy, rows }
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/margin-report?period=7d|30d|90d ───────────────────
  app.get('/margin-report', async (req, reply) => {
    const q = z.object({
      period: z.enum(['7d', '30d', '90d']).default('30d'),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'margin', q.period)
    const result = await getOrSet(key, 600, async () => {
    const days     = periodDays(q.period)
    const now      = new Date()
    const { from } = dateRange(days, now)
    const fromStr  = iso(from)
    const toStr    = iso(now)
    const branchId = req.branchId
    const db       = req.db

    const { totalRevenue, totalCOGS, marginPct, rows } =
      await grossMarginData(db, branchId, fromStr, toStr)

    // Category-wise margin (uses product category if available)
    const categoryMargin = await db.$queryRaw<Array<{
      category: string; revenue: number; cogs: number; margin_pct: number
    }>>`
      SELECT
        COALESCE(cat.name, 'Uncategorised')          AS category,
        COALESCE(SUM(ii.total),0)::float             AS revenue,
        COALESCE(SUM(ii.qty * COALESCE(p."purchasePrice",0)),0)::float AS cogs,
        CASE WHEN SUM(ii.total) > 0
          THEN ROUND(((SUM(ii.total) - SUM(ii.qty * COALESCE(p."purchasePrice",0))) / SUM(ii.total) * 100)::numeric, 1)::float
          ELSE 0
        END AS margin_pct
      FROM invoice_items ii
      JOIN products p ON p.id = ii."productId"
      LEFT JOIN categories cat ON cat.id = p."categoryId"
      JOIN invoices i ON i.id = ii."invoiceId"
      WHERE i."branchId" = ${branchId}::uuid AND i."txnType" = 'sale_invoice'
        AND i."date" >= ${fromStr}::date AND i."date" <= ${toStr}::date
        AND p."purchasePrice" IS NOT NULL AND p."purchasePrice" > 0
      GROUP BY cat.name ORDER BY revenue DESC
    `

    return {
      period: q.period, from: fromStr, to: toStr,
      summary: { totalRevenue, totalCOGS, grossProfit: totalRevenue - totalCOGS, marginPct },
      by_product:  rows,
      by_category: categoryMargin,
    }
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/top-customers?period=7d|30d|90d&limit=10 ──────────
  app.get('/top-customers', async (req, reply) => {
    const q = z.object({
      period: z.enum(['7d', '30d', '90d']).default('30d'),
      limit:  z.coerce.number().int().min(1).max(50).default(10),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'topcust', q.period, String(q.limit))
    const result = await getOrSet(key, 600, async () => {
    const days     = periodDays(q.period)
    const now      = new Date()
    const { from } = dateRange(days, now)
    const fromStr  = iso(from)
    const toStr    = iso(now)
    const branchId = req.branchId
    const db       = req.db

    const rows = await db.$queryRaw<Array<{
      party_id: string; name: string; phone: string
      revenue: number; invoices: number; outstanding: number
    }>>`
      SELECT p.id::text AS party_id, p.name, COALESCE(p.phone,'') AS phone,
             COALESCE(SUM(i."grandTotal"),0)::float AS revenue,
             COUNT(i.id)::int AS invoices,
             p.balance::float AS outstanding
      FROM parties p
      LEFT JOIN invoices i ON i."partyId" = p.id
        AND i."txnType" = 'sale_invoice'
        AND i."date" >= ${fromStr}::date AND i."date" <= ${toStr}::date
      WHERE p."branchId" = ${branchId}::uuid AND p.type = 'customer'
      GROUP BY p.id, p.name, p.phone, p.balance
      ORDER BY revenue DESC
      LIMIT ${q.limit}
    `

    return { from: fromStr, to: toStr, customers: rows }
    }) // end getOrSet
    return reply.send(result)
  })

  // ── GET /api/analytics/sales-vs-purchases?months=6 ───────────────────────
  app.get('/sales-vs-purchases', async (req, reply) => {
    const q = z.object({
      months: z.coerce.number().int().min(1).max(12).default(6),
    }).parse(req.query)

    const key = cacheKey(req.schemaName, req.branchId, 'svsp', String(q.months))
    const result = await getOrSet(key, 600, async () => {
    const branchId = req.branchId
    const db = req.db
    const now = new Date()
    const fromDate = new Date(now.getFullYear(), now.getMonth() - q.months + 1, 1)
    const fromStr = iso(fromDate)
    const toStr   = iso(now)

    const salesByMonth = await db.$queryRaw<Array<{ month: string; revenue: number; invoices: number }>>`
      SELECT TO_CHAR(DATE_TRUNC('month', "date"), 'YYYY-MM') AS month,
             COALESCE(SUM("grandTotal"), 0)::float AS revenue,
             COUNT(*)::int AS invoices
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid AND "txnType" = 'sale_invoice'
        AND "date" >= ${fromStr}::date AND "date" <= ${toStr}::date
        AND status != 'cancelled'
      GROUP BY DATE_TRUNC('month', "date") ORDER BY month ASC
    `.catch((e: any) => { req.log.error({ err: e.message }, 'sales-vs-purchases: sales query failed'); return [] })

    const purchasesByMonth = await db.$queryRaw<Array<{ month: string; amount: number }>>`
      SELECT TO_CHAR(DATE_TRUNC('month', "poDate"), 'YYYY-MM') AS month,
             COALESCE(SUM("grandTotal"), 0)::float AS amount
      FROM purchase_orders
      WHERE "branchId" = ${branchId}::uuid
        AND "poDate" >= ${fromStr}::date AND "poDate" <= ${toStr}::date AND status != 'cancelled'
      GROUP BY DATE_TRUNC('month', "poDate") ORDER BY month ASC
    `.catch((e: any) => { req.log.error({ err: e.message }, 'sales-vs-purchases: purchases query failed'); return [] })

    const expensesByMonth = await db.$queryRaw<Array<{ month: string; amount: number }>>`
      SELECT TO_CHAR(DATE_TRUNC('month', "date"), 'YYYY-MM') AS month,
             COALESCE(SUM(amount), 0)::float AS amount
      FROM expenses
      WHERE "branchId" = ${branchId}::uuid
        AND "date" >= ${fromStr}::date AND "date" <= ${toStr}::date
      GROUP BY DATE_TRUNC('month', "date") ORDER BY month ASC
    `.catch((e: any) => { req.log.error({ err: e.message }, 'sales-vs-purchases: expenses query failed'); return [] })

    // Build full month list (fill gaps with 0)
    const months: string[] = []
    for (let i = 0; i < q.months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - q.months + 1 + i, 1)
      months.push(iso(d).slice(0, 7))
    }
    const sMap = new Map(salesByMonth.map(r => [r.month, r]))
    const pMap = new Map(purchasesByMonth.map(r => [r.month, r]))
    const eMap = new Map(expensesByMonth.map(r => [r.month, r]))

    const rows = months.map(month => {
      const sales    = sMap.get(month)?.revenue  ?? 0
      const purchases = pMap.get(month)?.amount  ?? 0
      const expenses  = eMap.get(month)?.amount  ?? 0
      return { month, sales, purchases, expenses, profit: sales - expenses }
    })

    const totals = rows.reduce(
      (acc, r) => ({ sales: acc.sales + r.sales, purchases: acc.purchases + r.purchases, expenses: acc.expenses + r.expenses, profit: acc.profit + r.profit }),
      { sales: 0, purchases: 0, expenses: 0, profit: 0 }
    )

    return { months: q.months, from: fromStr, to: toStr, rows, totals }
    }) // end getOrSet
    return reply.send(result)
  })
}
