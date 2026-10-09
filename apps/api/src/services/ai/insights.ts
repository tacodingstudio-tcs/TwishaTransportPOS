// apps/api/src/services/ai/insights.ts
//
// Four AI features:
//   1. dashboardInsight   — natural language daily summary for the owner
//   2. reorderSuggestions — what to reorder and how much based on sales velocity
//   3. anomalyDetection   — duplicate/suspicious invoices flagged before saving
//   4. creditRisk         — per-customer payment reliability score

import { db } from '@billing/db'
import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dashboard Insight — natural language summary
// ─────────────────────────────────────────────────────────────────────────────

const DashboardInsightSchema = z.object({
  headline:  z.string().max(120),
  insights:  z.array(z.string().max(200)).max(4),
  alert:     z.string().max(200).nullable(),
})

export type DashboardInsight = z.infer<typeof DashboardInsightSchema>

export async function generateDashboardInsight(
  tenantId: string,
  branchId: string,
  lang: 'hi' | 'gu' | 'en' | 'mr' | 'ta' = 'en',
  tenantDb?: typeof db,
): Promise<DashboardInsight> {
  const client = tenantDb ?? db
  // Gather last 7 days revenue + today stats
  const [weekly, today, topProducts, overdueCount] = await Promise.all([
    client.$queryRaw<Array<{ day: string; revenue: number; count: number }>>`
      SELECT
        DATE("date")::text AS day,
        COALESCE(SUM("grandTotal"), 0)::float AS revenue,
        COUNT(*)::int AS count
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND "date" >= NOW() - INTERVAL '7 days'
        AND "txnType" = 'sale_invoice'
      GROUP BY DATE("date")
      ORDER BY day DESC
    `,
    client.$queryRaw<Array<{ total: number; count: number; received: number }>>`
      SELECT
        COALESCE(SUM("grandTotal"), 0)::float AS total,
        COUNT(*)::int AS count,
        COALESCE(SUM("paidAmt"), 0)::float AS received
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND DATE("date") = CURRENT_DATE
        AND "txnType" = 'sale_invoice'
    `,
    client.$queryRaw<Array<{ name: string; qty: number; revenue: number }>>`
      SELECT p.name, SUM(ii.qty)::float AS qty, SUM(ii.total)::float AS revenue
      FROM "invoice_items" ii
      JOIN products p ON p.id = ii."productId"
      JOIN invoices i ON i.id = ii."invoiceId"
      WHERE i."branchId" = ${branchId}::uuid
        AND i."date" >= NOW() - INTERVAL '7 days'
      GROUP BY p.name
      ORDER BY revenue DESC
      LIMIT 3
    `,
    client.$queryRaw<Array<{ cnt: number }>>`
      SELECT COUNT(*)::int AS cnt FROM parties
      WHERE balance > 0
    `,
  ])

  const todayData  = today[0] ?? { total: 0, count: 0, received: 0 }
  const prevDay    = weekly[1]
  const pctChange  = prevDay && prevDay.revenue > 0
    ? Math.round(((weekly[0]?.revenue ?? 0) - prevDay.revenue) / prevDay.revenue * 100)
    : null

  const context = `
Today: ₹${todayData.total.toFixed(0)} revenue, ${todayData.count} invoices, ₹${todayData.received.toFixed(0)} collected.
${pctChange !== null ? `vs yesterday: ${pctChange > 0 ? '+' : ''}${pctChange}%` : ''}
Top products (7d): ${topProducts.map((p) => `${p.name} ₹${p.revenue.toFixed(0)}`).join(', ')}
Customers with pending balance: ${overdueCount[0]?.cnt ?? 0}
`

  const raw = await ai.chat({
    system: `You are a business intelligence assistant for an Indian small business billing app.
Given today's sales data, write a brief, friendly, actionable summary for the shop owner.
Respond in ${lang === 'en' ? 'English' : lang === 'hi' ? 'Hindi' : lang === 'gu' ? 'Gujarati' : lang}.
Return ONLY JSON: { "headline": "one short sentence summary", "insights": ["up to 4 bullet observations"], "alert": "one urgent alert if any, else null" }
Keep each insight under 15 words. Be specific with numbers. Sound like a helpful colleague, not a robot.`,
    prompt: context,
    maxTokens: 400,
    quality: 'fast',
  })

  try {
    const parsed = parseAIJson<unknown>(raw)
    const result = DashboardInsightSchema.safeParse(parsed)
    if (result.success) return result.data
  } catch {}

  return {
    headline: `Today's revenue: ₹${todayData.total.toFixed(0)} from ${todayData.count} invoices`,
    insights: [],
    alert: null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Reorder Suggestions
// ─────────────────────────────────────────────────────────────────────────────

const ReorderSuggestionSchema = z.object({
  productId:   z.string(),
  productName: z.string(),
  currentStock:z.number(),
  lowStockQty: z.number(),
  avgDailySales:z.number(),
  daysLeft:    z.number(),
  suggestedQty:z.number(),
  reason:      z.string(),
  urgency:     z.enum(['critical', 'high', 'medium']),
})

export type ReorderSuggestion = z.infer<typeof ReorderSuggestionSchema>

export async function getReorderSuggestions(
  tenantId: string,
  branchId: string,
  tenantDb?: typeof db,
): Promise<ReorderSuggestion[]> {
  // Use tenant-scoped db when available (avoids cross-schema query issues)
  const client = tenantDb ?? db
  // Get low-stock products with 7-day sales velocity
  const products = await client.$queryRaw<Array<{
    id: string; name: string; stock: number; low_stock_qty: number
    avg_daily_sales: number
  }>>`
    SELECT
      p.id::text,
      p.name,
      COALESCE(SUM(sl.qty), 0)::float AS stock,
      p."lowStockQty"::float AS low_stock_qty,
      COALESCE(
        ABS(SUM(CASE WHEN sl."txnType" = 'sale' AND sl."createdAt" >= NOW() - INTERVAL '7 days'
                THEN sl.qty ELSE 0 END)) / 7.0,
        0
      )::float AS avg_daily_sales
    FROM products p
    LEFT JOIN stock_ledger sl ON sl."productId" = p.id AND sl."branchId" = ${branchId}::uuid
    WHERE p."branchId" = ${branchId}::uuid
      AND p."trackStock" = true
      AND p."isActive" = true
    GROUP BY p.id, p.name, p."lowStockQty"
    HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty" * 1.5
    ORDER BY stock ASC
    LIMIT 20
  `

  return products.map((p) => {
    const daysLeft   = p.avg_daily_sales > 0 ? Math.floor(p.stock / p.avg_daily_sales) : 999
    // Suggest enough stock for 14 days of sales
    const suggestedQty = Math.max(
      Math.ceil(p.avg_daily_sales * 14) - p.stock,
      Math.ceil(p.low_stock_qty * 2),
    )
    const urgency: ReorderSuggestion['urgency'] =
      daysLeft <= 2 ? 'critical' : daysLeft <= 5 ? 'high' : 'medium'

    const reason =
      daysLeft <= 2
        ? `Only ${daysLeft} day${daysLeft === 1 ? '' : 's'} of stock left at current sales rate`
        : p.avg_daily_sales > 0
        ? `Selling ~${p.avg_daily_sales.toFixed(1)} units/day, ${daysLeft} days left`
        : `Below low stock threshold (${p.low_stock_qty} ${p.stock < p.low_stock_qty ? '— already below' : '— close'})`

    return {
      productId:    p.id,
      productName:  p.name,
      currentStock: p.stock,
      lowStockQty:  p.low_stock_qty,
      avgDailySales:+p.avg_daily_sales.toFixed(2),
      daysLeft:     daysLeft === 999 ? -1 : daysLeft,
      suggestedQty,
      reason,
      urgency,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Invoice Anomaly Detection
// ─────────────────────────────────────────────────────────────────────────────

const AnomalySchema = z.object({
  type:        z.enum(['duplicate', 'unusual_amount', 'unusual_discount', 'suspicious_pattern']),
  severity:    z.enum(['warning', 'error']),
  message:     z.string(),
  relatedId:   z.string().nullable(),
})

export type InvoiceAnomaly = z.infer<typeof AnomalySchema>

export async function detectInvoiceAnomalies(
  tenantId: string,
  branchId: string,
  invoice: {
    partyId: string | null
    grandTotal: number
    items: Array<{ productId: string | null; qty: number; rate: number; discountPct: number }>
  },
): Promise<InvoiceAnomaly[]> {
  const anomalies: InvoiceAnomaly[] = []

  // Check for duplicate: same party, same total, within last 10 minutes
  if (invoice.partyId) {
    const dupes = await db.$queryRaw<Array<{ id: string; number: string }>>`
      SELECT id::text, number FROM invoices
      WHERE "tenantId" = ${tenantId}::uuid
        AND "partyId"  = ${invoice.partyId}::uuid
        AND "grandTotal" = ${invoice.grandTotal}
        AND "createdAt" > NOW() - INTERVAL '10 minutes'
      LIMIT 1
    `
    if (dupes.length > 0) {
      anomalies.push({
        type: 'duplicate', severity: 'error',
        message: `Possible duplicate — invoice ${dupes[0]!.number} for the same party and amount was created just now`,
        relatedId: dupes[0]!.id,
      })
    }
  }

  // Check unusual discount (> 30%)
  const highDiscount = invoice.items.find((i) => i.discountPct > 30)
  if (highDiscount) {
    anomalies.push({
      type: 'unusual_discount', severity: 'warning',
      message: `Item has ${highDiscount.discountPct}% discount — unusually high`,
      relatedId: null,
    })
  }

  // Check if total is > 3x the average for this party
  if (invoice.partyId && invoice.grandTotal > 0) {
    const avg = await db.$queryRaw<Array<{ avg_total: number; max_total: number }>>`
      SELECT
        AVG("grandTotal")::float AS avg_total,
        MAX("grandTotal")::float AS max_total
      FROM invoices
      WHERE "tenantId" = ${tenantId}::uuid
        AND "partyId" = ${invoice.partyId}::uuid
        AND "txnType" = 'sale_invoice'
    `
    const avgTotal = avg[0]?.avg_total ?? 0
    if (avgTotal > 0 && invoice.grandTotal > avgTotal * 3) {
      anomalies.push({
        type: 'unusual_amount', severity: 'warning',
        message: `This invoice (₹${invoice.grandTotal.toFixed(0)}) is ${Math.round(invoice.grandTotal / avgTotal)}x the average for this customer (₹${avgTotal.toFixed(0)})`,
        relatedId: null,
      })
    }
  }

  return anomalies
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Credit Risk Score
// ─────────────────────────────────────────────────────────────────────────────

const CreditRiskSchema = z.object({
  score:       z.number().min(0).max(100),
  label:       z.enum(['excellent', 'good', 'fair', 'poor', 'high_risk']),
  summary:     z.string().max(200),
  factors:     z.array(z.string().max(100)).max(4),
})

export type CreditRisk = z.infer<typeof CreditRiskSchema>

export async function getCreditRisk(
  partyId: string,
  tenantId: string,
): Promise<CreditRisk> {
  const [history, balance] = await Promise.all([
    db.$queryRaw<Array<{
      total_invoices: number; paid_count: number; partial_count: number
      avg_days_to_pay: number; max_outstanding_days: number
    }>>`
      SELECT
        COUNT(*)::int AS total_invoices,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid_count,
        COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_count,
        COALESCE(AVG(
          EXTRACT(DAY FROM (
            SELECT MIN(pa."createdAt") FROM payment_allocations pa
            JOIN payments py ON py.id = pa."paymentId"
            WHERE pa."invoiceId" = i.id
          ) - i."date")
        ), 0)::float AS avg_days_to_pay,
        COALESCE(MAX(
          CASE WHEN i.status IN ('confirmed','partial')
          THEN EXTRACT(DAY FROM NOW() - i."date") ELSE 0 END
        ), 0)::float AS max_outstanding_days
      FROM invoices i
      WHERE i."tenantId" = ${tenantId}::uuid
        AND i."partyId"  = ${partyId}::uuid
        AND i."txnType"  = 'sale_invoice'
    `,
    db.party.findUnique({
      where: { id: partyId },
      select: { balance: true, creditLimit: true, name: true },
    }),
  ])

  const h = history[0] ?? { total_invoices: 0, paid_count: 0, partial_count: 0, avg_days_to_pay: 0, max_outstanding_days: 0 }
  const payRate    = h.total_invoices > 0 ? h.paid_count / h.total_invoices : 1
  const balanceAmt = Number(balance?.balance ?? 0)
  const limit      = Number(balance?.creditLimit ?? 0)
  const utilization = limit > 0 ? balanceAmt / limit : 0

  // Score: 0-100, higher = better credit
  let score = 100
  score -= (1 - payRate) * 40          // payment rate weight
  score -= Math.min(h.avg_days_to_pay / 30 * 20, 20)  // avg days weight
  score -= Math.min(h.max_outstanding_days / 90 * 20, 20) // overdue weight
  score -= Math.min(utilization * 20, 20)              // credit utilization
  score = Math.max(0, Math.round(score))

  const label: CreditRisk['label'] =
    score >= 80 ? 'excellent' :
    score >= 60 ? 'good' :
    score >= 40 ? 'fair' :
    score >= 20 ? 'poor' : 'high_risk'

  const factors: string[] = []
  if (payRate < 0.7)              factors.push(`Only ${Math.round(payRate * 100)}% invoices fully paid`)
  if (h.avg_days_to_pay > 15)    factors.push(`Average ${Math.round(h.avg_days_to_pay)} days to pay`)
  if (h.max_outstanding_days > 30) factors.push(`Invoice outstanding for ${Math.round(h.max_outstanding_days)} days`)
  if (utilization > 0.8)         factors.push(`Using ${Math.round(utilization * 100)}% of credit limit`)
  if (h.paid_count > 5 && payRate >= 0.9) factors.push(`Reliable payer — ${h.paid_count} invoices paid on time`)

  const summary =
    score >= 80 ? 'Excellent payment history — safe to extend credit' :
    score >= 60 ? 'Generally reliable, minor delays occasionally' :
    score >= 40 ? 'Mixed payment history — monitor closely' :
    score >= 20 ? 'Frequent delays — consider reducing credit limit' :
    'High risk — collect outstanding before extending more credit'

  return { score, label, summary, factors }
}
