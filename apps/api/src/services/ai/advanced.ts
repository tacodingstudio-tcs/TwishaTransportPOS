// services/ai/advanced.ts
// Seven new AI features:
//   1. categorizeExpense      — auto-tag expense category from description
//   2. cashflowForecast       — 7/30-day cash flow projection
//   3. findPartyDuplicates    — detect duplicate party entries
//   4. detectPriceAnomaly     — flag when purchase price deviates from history
//   5. gstFilingSummary       — structured GST summary for CA / filing
//   6. demandForecast         — predict which SKUs will stock out
//   7. chat                   — free-form Q&A over tenant data

import { db } from '@billing/db'
import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { z } from 'zod'

type TenantDb = typeof db

// ─────────────────────────────────────────────────────────────────────────────
// 1. Expense Categorization
// ─────────────────────────────────────────────────────────────────────────────

const EXPENSE_CATEGORIES = [
  'rent', 'electricity', 'salaries', 'fuel_transport', 'marketing',
  'office_supplies', 'repairs_maintenance', 'bank_charges', 'taxes_fees',
  'purchases', 'insurance', 'subscriptions', 'miscellaneous',
] as const

export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number]

export interface ExpenseCategoryResult {
  category: ExpenseCategory
  confidence: number
  reason: string
  suggestedGlCode?: string
}

export async function categorizeExpense(
  description: string,
  amount: number,
): Promise<ExpenseCategoryResult> {
  const text = await ai.chat({
    quality: 'fast',
    system: `You are an Indian business expense categorizer. Categorize the expense and respond ONLY with JSON.
Valid categories: ${EXPENSE_CATEGORIES.join(', ')}.
GL code format: 5XXXX (expense range).`,
    prompt: `Description: "${description}"
Amount: ₹${amount}

Respond with:
{"category":"<one of the valid categories>","confidence":<0-1>,"reason":"<one line>","suggestedGlCode":"<5xxxx or null>"}`,
  })

  const raw = parseAIJson<ExpenseCategoryResult>(text) ?? ({} as Partial<ExpenseCategoryResult>)
  return {
    category: EXPENSE_CATEGORIES.includes(raw.category as ExpenseCategory)
      ? (raw.category as ExpenseCategory)
      : 'miscellaneous',
    confidence:      typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    reason:          typeof raw.reason === 'string' ? raw.reason : '',
    suggestedGlCode: typeof raw.suggestedGlCode === 'string' ? raw.suggestedGlCode : undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Cash Flow Forecast
// ─────────────────────────────────────────────────────────────────────────────

export interface CashflowDay {
  date: string
  projectedInflow:  number
  projectedOutflow: number
  netCashflow:      number
  confidence:       'high' | 'medium' | 'low'
}

export interface CashflowForecast {
  currentBalance:    number
  days:              CashflowDay[]
  summary:           string
  topRisks:          string[]
}

export async function cashflowForecast(
  branchId: string,
  horizon: 7 | 30,
  tenantDb: TenantDb,
): Promise<CashflowForecast> {
  const [revenueHistory, expenseHistory, outstandingReceivables, outstandingPayables] =
    await Promise.all([
      // last 60 days daily revenue
      tenantDb.$queryRaw<Array<{ day: string; revenue: number; count: number }>>`
        SELECT DATE("date")::text AS day,
               COALESCE(SUM("grandTotal"), 0)::float AS revenue,
               COUNT(*)::int AS count
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'sale_invoice'
          AND "date"    >= NOW() - INTERVAL '60 days'
        GROUP BY DATE("date")
        ORDER BY day
      `,
      // last 60 days daily expenses
      tenantDb.$queryRaw<Array<{ day: string; expense: number }>>`
        SELECT DATE("date")::text AS day,
               COALESCE(SUM(amount), 0)::float AS expense
        FROM expenses
        WHERE "branchId" = ${branchId}::uuid
          AND "date"    >= NOW() - INTERVAL '60 days'
        GROUP BY DATE("date")
        ORDER BY day
      `.catch(() => [] as any[]),
      // outstanding receivables due in next 30 days
      tenantDb.$queryRaw<Array<{ due_date: string; amount: number }>>`
        SELECT DATE("dueDate")::text AS due_date,
               COALESCE(SUM("grandTotal" - "paidAmt"), 0)::float AS amount
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'sale_invoice'
          AND "dueDate" >= NOW()
          AND "dueDate" <= NOW() + INTERVAL '30 days'
          AND "paidAmt"  < "grandTotal"
        GROUP BY DATE("dueDate")
        ORDER BY due_date
      `.catch(() => [] as any[]),
      // outstanding payables
      tenantDb.$queryRaw<Array<{ due_date: string; amount: number }>>`
        SELECT DATE("dueDate")::text AS due_date,
               COALESCE(SUM("grandTotal" - "paidAmt"), 0)::float AS amount
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'purchase_invoice'
          AND "dueDate" >= NOW()
          AND "dueDate" <= NOW() + INTERVAL '30 days'
          AND "paidAmt"  < "grandTotal"
        GROUP BY DATE("dueDate")
        ORDER BY due_date
      `.catch(() => [] as any[]),
    ])

  // Compute averages
  const avgDailyRevenue  = revenueHistory.length
    ? revenueHistory.reduce((s, r) => s + r.revenue, 0) / revenueHistory.length
    : 0
  const avgDailyExpense  = expenseHistory.length
    ? expenseHistory.reduce((s, r) => s + r.expense, 0) / expenseHistory.length
    : 0

  // Build receivables/payables lookup by date
  const recMap = Object.fromEntries(outstandingReceivables.map((r) => [r.due_date, r.amount]))
  const payMap = Object.fromEntries(outstandingPayables.map((r) => [r.due_date, r.amount]))

  // Generate daily forecast
  const days: CashflowDay[] = []
  for (let i = 1; i <= horizon; i++) {
    const d    = new Date()
    d.setDate(d.getDate() + i)
    const date = d.toISOString().slice(0, 10)

    const inflow  = avgDailyRevenue  + (recMap[date] ?? 0)
    const outflow = avgDailyExpense  + (payMap[date] ?? 0)
    // confidence degrades with distance
    const confidence: 'high' | 'medium' | 'low' =
      i <= 7 ? 'high' : i <= 14 ? 'medium' : 'low'

    days.push({ date, projectedInflow: Math.round(inflow), projectedOutflow: Math.round(outflow), netCashflow: Math.round(inflow - outflow), confidence })
  }

  const totalNet = days.reduce((s, d) => s + d.netCashflow, 0)

  // AI narrative
  const aiText = await ai.chat({
    quality: 'fast',
    system:  'You are a cash flow analyst for an Indian SMB. Be concise, practical, in English.',
    prompt: `Business data:
- Avg daily revenue: ₹${avgDailyRevenue.toFixed(0)}
- Avg daily expense: ₹${avgDailyExpense.toFixed(0)}
- Outstanding receivables next ${horizon}d: ₹${outstandingReceivables.reduce((s, r) => s + r.amount, 0).toFixed(0)}
- Outstanding payables next ${horizon}d: ₹${outstandingPayables.reduce((s, r) => s + r.amount, 0).toFixed(0)}
- Projected net ${horizon}-day cashflow: ₹${totalNet.toFixed(0)}

Respond ONLY with JSON:
{"summary":"<2 sentence narrative>","topRisks":["<risk 1>","<risk 2>","<risk 3>"]}`,
  }).catch(() => '{"summary":"Forecast based on historical averages.","topRisks":[]}')

  const aiData = parseAIJson<{ summary?: string; topRisks?: string[] }>(aiText) ?? {}

  return {
    currentBalance: 0, // would need bank account integration
    days,
    summary:  aiData.summary  ?? 'Forecast based on historical averages.',
    topRisks: aiData.topRisks ?? [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Party Duplicate Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface DuplicatePartyGroup {
  ids:        string[]
  names:      string[]
  phones:     (string | null)[]
  gstins:     (string | null)[]
  reason:     string
  confidence: number
}

export async function findPartyDuplicates(
  branchId: string,
  tenantDb: TenantDb,
): Promise<DuplicatePartyGroup[]> {
  // Find parties sharing phone or GSTIN, or with very similar names
  const [phoneGroups, gstinGroups] = await Promise.all([
    tenantDb.$queryRaw<Array<{ phone: string; ids: string; names: string }>>`
      SELECT phone,
             STRING_AGG(id::text, ',' ORDER BY "createdAt") AS ids,
             STRING_AGG(name,     ',' ORDER BY "createdAt") AS names
      FROM parties
      WHERE "branchId" = ${branchId}::uuid
        AND phone IS NOT NULL
        AND phone != ''
      GROUP BY phone
      HAVING COUNT(*) > 1
    `.catch(() => [] as any[]),

    tenantDb.$queryRaw<Array<{ gstin: string; ids: string; names: string }>>`
      SELECT gstin,
             STRING_AGG(id::text,  ',' ORDER BY "createdAt") AS ids,
             STRING_AGG(name,      ',' ORDER BY "createdAt") AS names
      FROM parties
      WHERE "branchId" = ${branchId}::uuid
        AND gstin IS NOT NULL
        AND gstin != ''
      GROUP BY gstin
      HAVING COUNT(*) > 1
    `.catch(() => [] as any[]),
  ])

  const groups: DuplicatePartyGroup[] = []

  for (const g of phoneGroups) {
    groups.push({
      ids:        g.ids.split(','),
      names:      g.names.split(','),
      phones:     [g.phone],
      gstins:     [],
      reason:     `Same phone number: ${g.phone}`,
      confidence: 0.95,
    })
  }

  for (const g of gstinGroups) {
    // Skip if already caught by phone group
    const ids = g.ids.split(',')
    const alreadyCovered = groups.some((gr) => ids.some((id: string) => gr.ids.includes(id)))
    if (!alreadyCovered) {
      groups.push({
        ids,
        names:      g.names.split(','),
        phones:     [],
        gstins:     [g.gstin],
        reason:     `Same GSTIN: ${g.gstin}`,
        confidence: 0.99,
      })
    }
  }

  return groups
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Purchase Price Anomaly
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceAnomalyResult {
  productId:   string
  productName: string
  currentRate: number
  avgRate:     number
  deviationPct: number
  severity:    'ok' | 'warning' | 'alert'
  message:     string
}

export async function detectPriceAnomaly(
  branchId:    string,
  items:       Array<{ productId: string; rate: number }>,
  tenantDb:    TenantDb,
): Promise<PriceAnomalyResult[]> {
  if (items.length === 0) return []

  const productIds = items.map((i) => i.productId)

  const history = await tenantDb.$queryRaw<Array<{
    product_id: string; product_name: string
    avg_rate: number; min_rate: number; max_rate: number; count: number
  }>>`
    SELECT il."productId"::text AS product_id,
           p.name               AS product_name,
           AVG(il.rate)::float  AS avg_rate,
           MIN(il.rate)::float  AS min_rate,
           MAX(il.rate)::float  AS max_rate,
           COUNT(*)::int        AS count
    FROM invoice_lines il
    JOIN products p ON p.id = il."productId"
    JOIN invoices  i ON i.id = il."invoiceId"
    WHERE il."productId" = ANY(${productIds}::uuid[])
      AND i."branchId"   = ${branchId}::uuid
      AND i."txnType"    = 'purchase_invoice'
      AND i."date"      >= NOW() - INTERVAL '90 days'
    GROUP BY il."productId", p.name
    HAVING COUNT(*) >= 2
  `.catch(() => [] as any[])

  const histMap = Object.fromEntries(history.map((h) => [h.product_id, h]))

  return items
    .filter((item) => histMap[item.productId])
    .map((item) => {
      const h   = histMap[item.productId]!
      const dev = ((item.rate - h.avg_rate) / h.avg_rate) * 100
      const abs = Math.abs(dev)
      return {
        productId:    item.productId,
        productName:  h.product_name,
        currentRate:  item.rate,
        avgRate:      Math.round(h.avg_rate * 100) / 100,
        deviationPct: Math.round(dev * 10) / 10,
        severity:     abs >= 25 ? 'alert' : abs >= 10 ? 'warning' : 'ok',
        message: abs < 10
          ? `Rate within normal range (avg ₹${h.avg_rate.toFixed(2)})`
          : `${dev > 0 ? '▲' : '▼'} ${abs.toFixed(1)}% vs 90-day avg ₹${h.avg_rate.toFixed(2)}`,
      } satisfies PriceAnomalyResult
    })
    .filter((r) => r.severity !== 'ok')
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GST Filing Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface GstFilingSummary {
  month:      string
  b2b: {
    taxable: number; igst: number; cgst: number; sgst: number
    count: number; invoices: Array<{ gstin: string; partyName: string; taxable: number; igst: number; cgst: number; sgst: number }>
  }
  b2c: {
    taxable: number; igst: number; cgst: number; sgst: number; count: number
  }
  purchases: {
    taxable: number; igst: number; cgst: number; sgst: number; count: number
  }
  netGstPayable: number
  aiSummary:     string
}

export async function gstFilingSummary(
  branchId: string,
  month:    string, // YYYY-MM
  tenantDb: TenantDb,
): Promise<GstFilingSummary> {
  const from = `${month}-01`
  const [yr, mo] = month.split('-').map(Number) as [number, number]
  const to   = new Date(yr, mo, 0).toISOString().slice(0, 10)

  const [b2bRows, b2cRows, purchaseRows] = await Promise.all([
    // B2B — registered buyers (have GSTIN)
    tenantDb.$queryRaw<Array<{
      gstin: string; party_name: string
      taxable: number; igst: number; cgst: number; sgst: number
    }>>`
      SELECT p.gstin,
             p.name                                    AS party_name,
             COALESCE(SUM(i."taxableAmt"), 0)::float   AS taxable,
             COALESCE(SUM(i."igst"),       0)::float   AS igst,
             COALESCE(SUM(i."cgst"),       0)::float   AS cgst,
             COALESCE(SUM(i."sgst"),       0)::float   AS sgst
      FROM invoices i
      JOIN parties  p ON p.id = i."partyId"
      WHERE i."branchId" = ${branchId}::uuid
        AND i."txnType"  = 'sale_invoice'
        AND i."date"    >= ${from}::date
        AND i."date"    <= ${to}::date
        AND p.gstin IS NOT NULL AND p.gstin != ''
      GROUP BY p.gstin, p.name
    `.catch(() => [] as any[]),

    // B2C — unregistered buyers
    tenantDb.$queryRaw<[{ taxable: number; igst: number; cgst: number; sgst: number; count: number }]>`
      SELECT COALESCE(SUM(i."taxableAmt"), 0)::float AS taxable,
             COALESCE(SUM(i."igst"),       0)::float AS igst,
             COALESCE(SUM(i."cgst"),       0)::float AS cgst,
             COALESCE(SUM(i."sgst"),       0)::float AS sgst,
             COUNT(*)::int                           AS count
      FROM invoices i
      LEFT JOIN parties p ON p.id = i."partyId"
      WHERE i."branchId" = ${branchId}::uuid
        AND i."txnType"  = 'sale_invoice'
        AND i."date"    >= ${from}::date
        AND i."date"    <= ${to}::date
        AND (p.gstin IS NULL OR p.gstin = '')
    `.catch(() => [{ taxable: 0, igst: 0, cgst: 0, sgst: 0, count: 0 }] as any),

    // Purchases (ITC)
    tenantDb.$queryRaw<[{ taxable: number; igst: number; cgst: number; sgst: number; count: number }]>`
      SELECT COALESCE(SUM(i."taxableAmt"), 0)::float AS taxable,
             COALESCE(SUM(i."igst"),       0)::float AS igst,
             COALESCE(SUM(i."cgst"),       0)::float AS cgst,
             COALESCE(SUM(i."sgst"),       0)::float AS sgst,
             COUNT(*)::int                           AS count
      FROM invoices i
      WHERE i."branchId" = ${branchId}::uuid
        AND i."txnType"  = 'purchase_invoice'
        AND i."date"    >= ${from}::date
        AND i."date"    <= ${to}::date
    `.catch(() => [{ taxable: 0, igst: 0, cgst: 0, sgst: 0, count: 0 }] as any),
  ])

  const b2bTotals = {
    taxable: b2bRows.reduce((s, r) => s + r.taxable, 0),
    igst:    b2bRows.reduce((s, r) => s + r.igst, 0),
    cgst:    b2bRows.reduce((s, r) => s + r.cgst, 0),
    sgst:    b2bRows.reduce((s, r) => s + r.sgst, 0),
    count:   b2bRows.length,
    invoices: b2bRows.map((r) => ({
      gstin:     r.gstin,
      partyName: r.party_name,
      taxable:   Math.round(r.taxable * 100) / 100,
      igst:      Math.round(r.igst * 100) / 100,
      cgst:      Math.round(r.cgst * 100) / 100,
      sgst:      Math.round(r.sgst * 100) / 100,
    })),
  }

  const b2c   = b2cRows[0]!
  const purch = purchaseRows[0]!

  const outputGst = b2bTotals.igst + b2bTotals.cgst + b2bTotals.sgst
                  + b2c.igst       + b2c.cgst       + b2c.sgst
  const inputGst  = purch.igst + purch.cgst + purch.sgst
  const netGst    = Math.max(0, outputGst - inputGst)

  const aiSummary = await ai.chat({
    quality: 'fast',
    system:  'You are a GST expert for Indian SMBs. Summarize the GST position in 2 sentences.',
    prompt: `Month: ${month}
B2B sales taxable: ₹${b2bTotals.taxable.toFixed(2)}, GST output: ₹${(b2bTotals.igst + b2bTotals.cgst + b2bTotals.sgst).toFixed(2)}
B2C sales taxable: ₹${b2c.taxable.toFixed(2)}, GST output: ₹${(b2c.igst + b2c.cgst + b2c.sgst).toFixed(2)}
ITC (purchase GST): ₹${inputGst.toFixed(2)}
Net GST payable: ₹${netGst.toFixed(2)}
Write a 2-sentence summary for the business owner.`,
  }).catch(() => `GST summary for ${month}. Net payable after ITC: ₹${netGst.toFixed(2)}.`)

  return {
    month,
    b2b:           b2bTotals,
    b2c:           { taxable: b2c.taxable, igst: b2c.igst, cgst: b2c.cgst, sgst: b2c.sgst, count: b2c.count },
    purchases:     { taxable: purch.taxable, igst: purch.igst, cgst: purch.cgst, sgst: purch.sgst, count: purch.count },
    netGstPayable: Math.round(netGst * 100) / 100,
    aiSummary,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Demand Forecast (Inventory)
// ─────────────────────────────────────────────────────────────────────────────

export interface DemandForecastItem {
  productId:       string
  productName:     string
  currentStock:    number
  avgDailySales:   number
  daysUntilStockout: number
  forecastedDemand7d: number
  suggestedOrder:  number
  urgency:         'critical' | 'soon' | 'ok'
}

export async function demandForecast(
  branchId: string,
  tenantDb: TenantDb,
): Promise<DemandForecastItem[]> {
  const rows = await tenantDb.$queryRaw<Array<{
    product_id:   string
    product_name: string
    current_stock: number
    avg_daily_sales: number
    low_stock_qty: number
  }>>`
    SELECT
      p.id::text                                  AS product_id,
      p.name                                      AS product_name,
      COALESCE(SUM(sl.qty), 0)::float             AS current_stock,
      p."lowStockQty"::float                      AS low_stock_qty,
      COALESCE(
        ABS(SUM(CASE WHEN sl."txnType" = 'sale' AND sl."createdAt" >= NOW() - INTERVAL '14 days'
                THEN sl.qty ELSE 0 END)) / 14.0,
        0
      )::float                                    AS avg_daily_sales
    FROM products p
    LEFT JOIN stock_ledger sl ON sl."productId" = p.id AND sl."branchId" = ${branchId}::uuid
    WHERE p."branchId"  = ${branchId}::uuid
      AND p."trackStock" = true
      AND p."isActive"   = true
    GROUP BY p.id, p.name, p."lowStockQty"
    HAVING COALESCE(SUM(sl.qty), 0) >= 0
    ORDER BY
      -- prioritise items with fastest burn vs stock
      CASE WHEN COALESCE(
        ABS(SUM(CASE WHEN sl."txnType" = 'sale' AND sl."createdAt" >= NOW() - INTERVAL '14 days'
                THEN sl.qty ELSE 0 END)) / 14.0, 0) > 0
        THEN COALESCE(SUM(sl.qty), 0) /
             (ABS(SUM(CASE WHEN sl."txnType" = 'sale' AND sl."createdAt" >= NOW() - INTERVAL '14 days'
                      THEN sl.qty ELSE 0 END)) / 14.0)
        ELSE 9999
      END ASC
    LIMIT 30
  `.catch(() => [] as any[])

  return rows.map((r) => {
    const daysLeft     = r.avg_daily_sales > 0
      ? Math.floor(r.current_stock / r.avg_daily_sales)
      : 999
    const demand7d     = Math.ceil(r.avg_daily_sales * 7)
    const suggestOrder = Math.max(
      Math.ceil(r.avg_daily_sales * 14) - r.current_stock,
      Math.ceil(r.low_stock_qty * 2),
    )
    const urgency: 'critical' | 'soon' | 'ok' =
      daysLeft <= 3  ? 'critical' :
      daysLeft <= 10 ? 'soon'     : 'ok'

    return {
      productId:            r.product_id,
      productName:          r.product_name,
      currentStock:         Math.round(r.current_stock * 100) / 100,
      avgDailySales:        Math.round(r.avg_daily_sales * 100) / 100,
      daysUntilStockout:    daysLeft === 999 ? -1 : daysLeft,
      forecastedDemand7d:   demand7d,
      suggestedOrder:       Math.max(0, suggestOrder),
      urgency,
    } satisfies DemandForecastItem
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Chat Assistant
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export async function chatWithData(
  question:    string,
  history:     ChatMessage[],
  branchId:    string,
  tenantDb:    TenantDb,
): Promise<string> {
  // Gather context data the AI can reference
  const [todayStats, topParties, lowStock, overdueAmt] = await Promise.all([
    tenantDb.$queryRaw<[{ revenue: number; invoices: number; expenses: number; received: number }]>`
      SELECT
        COALESCE(SUM(CASE WHEN "txnType"='sale_invoice' THEN "grandTotal" END), 0)::float AS revenue,
        COUNT(CASE WHEN "txnType"='sale_invoice' THEN 1 END)::int                         AS invoices,
        0::float                                                                           AS expenses,
        COALESCE(SUM(CASE WHEN "txnType"='sale_invoice' THEN "paidAmt" END), 0)::float   AS received
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid AND DATE("date") = CURRENT_DATE
    `.catch(() => [{ revenue: 0, invoices: 0, expenses: 0, received: 0 }] as any),

    tenantDb.$queryRaw<Array<{ name: string; balance: number }>>`
      SELECT p.name,
             COALESCE(SUM(i."grandTotal" - i."paidAmt"), 0)::float AS balance
      FROM invoices i JOIN parties p ON p.id = i."partyId"
      WHERE i."branchId" = ${branchId}::uuid
        AND i."txnType"  = 'sale_invoice'
        AND i."paidAmt"  < i."grandTotal"
      GROUP BY p.name
      ORDER BY balance DESC
      LIMIT 5
    `.catch(() => [] as any[]),

    tenantDb.$queryRaw<Array<{ name: string; stock: number }>>`
      SELECT p.name, COALESCE(SUM(sl.qty), 0)::float AS stock
      FROM products p
      LEFT JOIN stock_ledger sl ON sl."productId" = p.id AND sl."branchId" = ${branchId}::uuid
      WHERE p."branchId"  = ${branchId}::uuid
        AND p."trackStock" = true
      GROUP BY p.id, p.name, p."lowStockQty"
      HAVING COALESCE(SUM(sl.qty), 0) <= p."lowStockQty"
      LIMIT 5
    `.catch(() => [] as any[]),

    tenantDb.$queryRaw<[{ total: number }]>`
      SELECT COALESCE(SUM("grandTotal" - "paidAmt"), 0)::float AS total
      FROM invoices
      WHERE "branchId" = ${branchId}::uuid
        AND "txnType"  = 'sale_invoice'
        AND "dueDate"  < CURRENT_DATE
        AND "paidAmt"  < "grandTotal"
    `.catch(() => [{ total: 0 }] as any),
  ])

  const today   = todayStats[0]!
  const overdue = overdueAmt[0]!.total

  const context = `
LIVE BUSINESS DATA (today: ${new Date().toISOString().slice(0, 10)}):
- Today's sales: ₹${today.revenue.toFixed(0)} (${today.invoices} invoices, ₹${today.received.toFixed(0)} received)
- Total overdue receivables: ₹${overdue.toFixed(0)}
- Top outstanding parties: ${topParties.map((p) => `${p.name} (₹${p.balance.toFixed(0)})`).join(', ') || 'none'}
- Low-stock items: ${lowStock.map((p) => `${p.name} (${p.stock} left)`).join(', ') || 'none'}
`.trim()

  const historyText = history.slice(-6).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')

  const reply = await ai.chat({
    quality: 'best',
    system: `You are a smart business assistant for an Indian SMB billing platform called HisabKitab.
You have access to live business data. Answer in the same language the user writes (Hindi, English, Gujarati, etc.).
Be concise, practical, and helpful. Format numbers with ₹ for rupees.
Never make up data not provided — if you don't know, say so.`,
    prompt: `${context}

${historyText ? `Conversation history:\n${historyText}\n` : ''}
User: ${question}`,
  })

  return reply
}
