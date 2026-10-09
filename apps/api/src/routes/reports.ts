// apps/api/src/routes/reports.ts
//
// Accountant-grade reports that sit outside analytics (which is dashboard/charts).
// These are day-end and month-end operational reports every SMB needs.
//
//  GET /api/reports/day-book?date=YYYY-MM-DD
//  GET /api/reports/stock-summary
//  GET /api/reports/gstr1?month=YYYY-MM

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'

export const reportRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/reports/day-book ─────────────────────────────────────────────
  // Every accountant's starting point: all money that came in and went out
  // on a specific date, with an opening/closing cash position.
  // Includes: sale invoices, purchase invoices, payments received,
  //           payments made, credit notes.
  app.get('/day-book', async (req, reply) => {
    const q = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format: YYYY-MM-DD')
            .default(new Date().toISOString().slice(0, 10)),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId
    const dateStr  = q.date

    const [invoicesOnDate, paymentsOnDate, prevBalance] = await Promise.all([

      // All invoices on this date (sales + purchases + credit notes)
      db.$queryRaw<Array<{
        id: string; number: string; txn_type: string; party_name: string | null
        grand_total: number; paid_amt: number; status: string; created_at: string
      }>>`
        SELECT
          i.id::text,
          i.number,
          i."txnType"                       AS txn_type,
          p.name                            AS party_name,
          i."grandTotal"::float             AS grand_total,
          i."paidAmt"::float                AS paid_amt,
          i.status,
          TO_CHAR(i."createdAt", 'HH24:MI') AS created_at
        FROM invoices i
        LEFT JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."date"     = ${dateStr}::date
          AND i.status    != 'draft'
        ORDER BY i."createdAt" ASC
      `,

      // All payment entries on this date
      db.$queryRaw<Array<{
        id: string; party_name: string | null; amount: number
        method: string; ref_no: string | null; created_at: string
      }>>`
        SELECT
          py.id::text,
          p.name                             AS party_name,
          py.amount::float,
          py.method,
          py."refNo"                         AS ref_no,
          TO_CHAR(py."createdAt", 'HH24:MI') AS created_at
        FROM payments py
        LEFT JOIN parties p ON p.id = py."partyId"
        WHERE py."branchId"   = ${branchId}::uuid
          AND py."paymentDate" = ${dateStr}::date
        ORDER BY py."createdAt" ASC
      `,

      // Cash balance at start of day = sum of all payments before this date
      // minus all purchases paid before this date (simple cash position)
      db.$queryRaw<[{ balance: number }]>`
        SELECT COALESCE(SUM(amount),0)::float AS balance
        FROM payments
        WHERE "branchId"    = ${branchId}::uuid
          AND "paymentDate" < ${dateStr}::date
          AND method        = 'cash'
      `,
    ])

    // Separate sales from purchases
    const saleInvoices     = invoicesOnDate.filter(i => i.txn_type === 'sale_invoice')
    const purchaseInvoices = invoicesOnDate.filter(i => i.txn_type === 'purchase_invoice')
    const otherInvoices    = invoicesOnDate.filter(i => !['sale_invoice','purchase_invoice'].includes(i.txn_type))

    // Cash receipts = payments received on this date (cash method)
    const cashReceipts  = paymentsOnDate.filter(p => p.method === 'cash')
    const upiReceipts   = paymentsOnDate.filter(p => p.method === 'upi')
    const cardReceipts  = paymentsOnDate.filter(p => p.method === 'card')
    const otherReceipts = paymentsOnDate.filter(p => !['cash','upi','card'].includes(p.method))

    const totalSales     = saleInvoices.reduce((s, i) => s + i.grand_total, 0)
    const totalPurchases = purchaseInvoices.reduce((s, i) => s + i.grand_total, 0)
    const totalReceipts  = paymentsOnDate.reduce((s, p) => s + p.amount, 0)
    const cashReceiptsAmt = cashReceipts.reduce((s, p) => s + p.amount, 0)
    const openingBalance  = prevBalance[0]!.balance

    // Net new credit sales on this date (invoiced but not yet paid)
    const creditSales = saleInvoices
      .filter(i => i.paid_amt < i.grand_total)
      .reduce((s, i) => s + (i.grand_total - i.paid_amt), 0)

    return reply.send({
      date:     dateStr,
      opening_cash_balance: openingBalance,
      closing_cash_balance: openingBalance + cashReceiptsAmt,

      summary: {
        total_sales:         totalSales,
        total_purchases:     totalPurchases,
        total_receipts:      totalReceipts,
        credit_sales:        creditSales,
        net_cash_in:         cashReceiptsAmt,
      },

      receipts_by_mode: {
        cash:  cashReceipts.reduce((s, p)  => s + p.amount, 0),
        upi:   upiReceipts.reduce((s, p)   => s + p.amount, 0),
        card:  cardReceipts.reduce((s, p)  => s + p.amount, 0),
        other: otherReceipts.reduce((s, p) => s + p.amount, 0),
      },

      sale_invoices:     saleInvoices,
      purchase_invoices: purchaseInvoices,
      other_invoices:    otherInvoices,
      payments:          paymentsOnDate,
    })
  })

  // ── GET /api/reports/stock-summary ────────────────────────────────────────
  // Current stock position: every active product with qty on hand,
  // value at purchase price (cost), value at sale price (MRP), and potential margin.
  // Used for year-end stock audit, insurance valuation, and bank financing.
  app.get('/stock-summary', async (req, reply) => {
    const q = z.object({
      categoryId: z.string().uuid().optional(),
      lowStockOnly: z.coerce.boolean().default(false),
      zeroStockOnly: z.coerce.boolean().default(false),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    const categoryFilter = q.categoryId
      ? Prisma.sql`AND p."categoryId" = ${q.categoryId}::uuid`
      : Prisma.empty

    const rows = await db.$queryRaw<Array<{
      product_id: string; name: string; sku: string | null
      category: string | null; unit: string
      qty_on_hand: number; low_stock_qty: number
      purchase_price: number | null; sale_price: number
      cost_value: number; retail_value: number; potential_margin: number
      last_purchase_date: string | null; last_sale_date: string | null
      status: string
    }>>`
      SELECT
        p.id::text                                          AS product_id,
        p.name,
        p.sku,
        cat.name                                            AS category,
        p.unit,
        COALESCE(SUM(sl.qty), 0)::float                   AS qty_on_hand,
        p."lowStockQty"::float                             AS low_stock_qty,
        p."purchasePrice"::float                           AS purchase_price,
        p."salePrice"::float                               AS sale_price,
        COALESCE(SUM(sl.qty) * COALESCE(p."purchasePrice", 0), 0)::float AS cost_value,
        COALESCE(SUM(sl.qty) * p."salePrice", 0)::float   AS retail_value,
        COALESCE(
          SUM(sl.qty) * (p."salePrice" - COALESCE(p."purchasePrice", 0)), 0
        )::float                                           AS potential_margin,
        MAX(CASE WHEN sl."txnType" = 'purchase'
            THEN TO_CHAR(sl."createdAt",'YYYY-MM-DD') END) AS last_purchase_date,
        MAX(CASE WHEN sl."txnType" = 'sale'
            THEN TO_CHAR(sl."createdAt",'YYYY-MM-DD') END) AS last_sale_date,
        CASE
          WHEN COALESCE(SUM(sl.qty),0) <= 0                     THEN 'out_of_stock'
          WHEN COALESCE(SUM(sl.qty),0) <= p."lowStockQty"       THEN 'low_stock'
          ELSE                                                        'in_stock'
        END                                                AS status
      FROM products p
      LEFT JOIN categories cat     ON cat.id  = p."categoryId"
      LEFT JOIN stock_ledger sl    ON sl."productId" = p.id
                                  AND sl."branchId"  = ${branchId}::uuid
      WHERE p."branchId" = ${branchId}::uuid
        AND p."isActive" = true
        AND p."trackStock" = true
        ${categoryFilter}
      GROUP BY p.id, p.name, p.sku, cat.name, p.unit,
               p."lowStockQty", p."purchasePrice", p."salePrice"
      ORDER BY cost_value DESC
    `

    // Apply post-query JS filters (avoids SQL param type issues)
    const filtered = rows.filter(r => {
      if (q.lowStockOnly  && r.qty_on_hand > r.low_stock_qty) return false
      if (q.zeroStockOnly && r.qty_on_hand > 0)               return false
      return true
    })

    const totalCostValue   = filtered.reduce((s: number, r) => s + r.cost_value, 0)
    const totalRetailValue = filtered.reduce((s: number, r) => s + r.retail_value, 0)
    const outOfStock       = filtered.filter(r => r.status === 'out_of_stock').length
    const lowStock         = filtered.filter(r => r.status === 'low_stock').length

    // Category-wise rollup
    const byCategoryMap = new Map<string, { cost: number; retail: number; items: number }>()
    for (const r of filtered) {
      const cat = r.category ?? 'Uncategorised'
      const existing = byCategoryMap.get(cat) ?? { cost: 0, retail: 0, items: 0 }
      byCategoryMap.set(cat, {
        cost:   existing.cost   + r.cost_value,
        retail: existing.retail + r.retail_value,
        items:  existing.items  + 1,
      })
    }
    const byCategory = Array.from(byCategoryMap.entries())
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.cost - a.cost)

    return reply.send({
      as_of:              new Date().toISOString().slice(0, 10),
      summary: {
        total_products:   filtered.length,
        out_of_stock:     outOfStock,
        low_stock:        lowStock,
        total_cost_value:   Math.round(totalCostValue),
        total_retail_value: Math.round(totalRetailValue),
        potential_margin:   Math.round(totalRetailValue - totalCostValue),
        margin_pct: totalRetailValue > 0
          ? Math.round(((totalRetailValue - totalCostValue) / totalRetailValue) * 100)
          : 0,
      },
      by_category: byCategory,
      products:    filtered,
    })
  })

  // ── GET /api/reports/gstr1?month=YYYY-MM ─────────────────────────────────
  // GSTR-1 structured data export.
  // Not a filing tool — produces the structured rows an accountant
  // copies into the GST portal or CA's software.
  // Covers: B2B (Table 4), B2C Large (Table 5), B2C Small (Table 7),
  //         HSN Summary (Table 12).
  app.get('/gstr1', async (req, reply) => {
    const q = z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/, 'Format: YYYY-MM'),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId
    const [yr, mo] = q.month.split('-').map(Number) as [number, number]
    const from     = `${q.month}-01`
    const to       = new Date(yr, mo, 0).toISOString().slice(0, 10)

    // Fetch branch GSTIN for inter-state detection
    const branch = await db.branch.findUnique({
      where: { id: branchId }, select: { gstin: true, stateCode: true },
    })
    const branchStateCode = branch?.stateCode ?? (branch?.gstin?.slice(0, 2) ?? '00')

    const [b2b, b2cLarge, b2cSmall, hsnSummary, cdnr] = await Promise.all([

      // B2B: invoices to registered businesses (party has GSTIN)
      // GSTR-1 Table 4
      db.$queryRaw<Array<{
        gstin: string; party_name: string; invoice_no: string
        invoice_date: string; invoice_value: number; place_of_supply: string
        is_igst: boolean; taxable_value: number
        cgst: number; sgst: number; igst: number; cess: number
      }>>`
        SELECT
          p.gstin,
          p.name                                         AS party_name,
          i.number                                       AS invoice_no,
          TO_CHAR(i."date", 'YYYY-MM-DD')               AS invoice_date,
          i."grandTotal"::float                          AS invoice_value,
          COALESCE(p."address"->>'stateCode',
                   LEFT(p.gstin, 2), ${branchStateCode}) AS place_of_supply,
          (LEFT(COALESCE(p."address"->>'stateCode',
                 LEFT(p.gstin, 2), ${branchStateCode}), 2)
           != ${branchStateCode})                        AS is_igst,
          i."taxableAmt"::float                          AS taxable_value,
          i."cgstTotal"::float                           AS cgst,
          i."sgstTotal"::float                           AS sgst,
          i."igstTotal"::float                           AS igst,
          i."cessTotal"::float                           AS cess
        FROM invoices i
        JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."txnType"  = 'sale_invoice'
          AND i."date"    >= ${from}::date
          AND i."date"    <= ${to}::date
          AND i.status   != 'draft'
          AND p.gstin IS NOT NULL AND p.gstin != ''
        ORDER BY i."date" ASC, i.number ASC
      `,

      // B2C Large: unregistered buyers, invoice > ₹2.5L inter-state
      // GSTR-1 Table 5
      db.$queryRaw<Array<{
        invoice_no: string; invoice_date: string; invoice_value: number
        place_of_supply: string; taxable_value: number; igst: number
      }>>`
        SELECT
          i.number                                       AS invoice_no,
          TO_CHAR(i."date", 'YYYY-MM-DD')               AS invoice_date,
          i."grandTotal"::float                          AS invoice_value,
          COALESCE(i."domainData"->>'state_code',
                   ${branchStateCode})                   AS place_of_supply,
          i."taxableAmt"::float                          AS taxable_value,
          i."igstTotal"::float                           AS igst
        FROM invoices i
        LEFT JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."txnType"  = 'sale_invoice'
          AND i."date"    >= ${from}::date
          AND i."date"    <= ${to}::date
          AND i.status   != 'draft'
          AND i."igstTotal" > 0
          AND i."grandTotal" > 250000
          AND (p.gstin IS NULL OR p.gstin = '')
        ORDER BY i."date" ASC
      `,

      // B2C Small: all remaining B2C — consolidated by rate and state
      // GSTR-1 Table 7
      db.$queryRaw<Array<{
        place_of_supply: string; gst_rate: number
        taxable_value: number; cgst: number; sgst: number; igst: number
      }>>`
        SELECT
          COALESCE(i."domainData"->>'state_code', ${branchStateCode}) AS place_of_supply,
          ii."gstRate"::float                                          AS gst_rate,
          COALESCE(SUM(ii."taxableAmt"),0)::float                     AS taxable_value,
          COALESCE(SUM(ii."cgstAmt"),0)::float                        AS cgst,
          COALESCE(SUM(ii."sgstAmt"),0)::float                        AS sgst,
          COALESCE(SUM(ii."igstAmt"),0)::float                        AS igst
        FROM invoices i
        JOIN invoice_items ii ON ii."invoiceId" = i.id
        LEFT JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."txnType"  = 'sale_invoice'
          AND i."date"    >= ${from}::date
          AND i."date"    <= ${to}::date
          AND i.status   != 'draft'
          AND (p.gstin IS NULL OR p.gstin = '')
          AND NOT (i."igstTotal" > 0 AND i."grandTotal" > 250000)
        GROUP BY place_of_supply, ii."gstRate"
        ORDER BY place_of_supply, gst_rate
      `,

      // HSN Summary — GSTR-1 Table 12
      db.$queryRaw<Array<{
        hsn: string; description: string; uqc: string
        total_qty: number; taxable_value: number
        cgst: number; sgst: number; igst: number; cess: number
      }>>`
        SELECT
          COALESCE(ii."hsnSacCode", p."hsnSacCode", 'NA')  AS hsn,
          MIN(ii.description)                               AS description,
          MIN(ii.unit)                                      AS uqc,
          SUM(ii.qty)::float                                AS total_qty,
          COALESCE(SUM(ii."taxableAmt"),0)::float           AS taxable_value,
          COALESCE(SUM(ii."cgstAmt"),0)::float              AS cgst,
          COALESCE(SUM(ii."sgstAmt"),0)::float              AS sgst,
          COALESCE(SUM(ii."igstAmt"),0)::float              AS igst,
          0::float                                          AS cess
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

      // CDNR — Credit/Debit notes to registered parties
      // GSTR-1 Table 9
      db.$queryRaw<Array<{
        receiver_gstin: string; party_name: string
        note_no: string; note_date: string; note_type: string
        invoice_value: number; taxable_value: number
        cgst: number; sgst: number; igst: number
      }>>`
        SELECT
          p.gstin                        AS receiver_gstin,
          p.name                         AS party_name,
          i.number                       AS note_no,
          TO_CHAR(i."date",'YYYY-MM-DD') AS note_date,
          CASE WHEN i."txnType" = 'credit_note' THEN 'C' ELSE 'D' END AS note_type,
          i."grandTotal"::float          AS invoice_value,
          i."taxableAmt"::float          AS taxable_value,
          i."cgstTotal"::float           AS cgst,
          i."sgstTotal"::float           AS sgst,
          i."igstTotal"::float           AS igst
        FROM invoices i
        JOIN parties p ON p.id = i."partyId"
        WHERE i."branchId" = ${branchId}::uuid
          AND i."txnType" IN ('credit_note','debit_note')
          AND i."date"   >= ${from}::date AND i."date" <= ${to}::date
          AND i.status  != 'draft'
          AND p.gstin IS NOT NULL AND p.gstin != ''
        ORDER BY i."date" ASC
      `,
    ])

    // Totals
    const b2bTotal  = b2b.reduce((s: number, r) => s + r.invoice_value, 0)
    const b2cTotal  = (b2cLarge.reduce((s: number, r) => s + r.invoice_value, 0))
                    + (b2cSmall.reduce((s: number, r) => s + r.taxable_value, 0))
    const totalTax  = hsnSummary.reduce((s: number, r) => s + r.cgst + r.sgst + r.igst, 0)

    return reply.send({
      month:         q.month,
      from,
      to,
      branch_gstin:  branch?.gstin ?? null,
      summary: {
        b2b_invoice_count:  b2b.length,
        b2b_taxable_value:  b2b.reduce((s: number, r) => s + r.taxable_value, 0),
        b2b_total_value:    b2bTotal,
        b2c_taxable_value:  b2cTotal,
        total_output_tax:   totalTax,
        cdnr_count:         cdnr.length,
      },
      tables: {
        b2b,
        b2c_large: b2cLarge,
        b2c_small: b2cSmall,
        cdnr,
        hsn: hsnSummary,
      },
    })
  })

  // ── GET /api/reports/pl-statement?from=YYYY-MM-DD&to=YYYY-MM-DD ───────────
  // Formal Profit & Loss statement for any date range.
  app.get('/pl-statement', async (req, reply) => {
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(
        new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(
        new Date().toISOString().slice(0, 10)),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    const [revenue, purchases, expenseRows, gstOut, gstIn] = await Promise.all([

      db.$queryRaw<[{ total: number; invoices: number; returns: number }]>`
        SELECT
          COALESCE(SUM(CASE WHEN "txnType" = 'sale_invoice' THEN "grandTotal" ELSE 0 END), 0)::float  AS total,
          COUNT(CASE WHEN "txnType" = 'sale_invoice' THEN 1 END)::int                                 AS invoices,
          COALESCE(SUM(CASE WHEN "txnType" = 'credit_note' THEN "grandTotal" ELSE 0 END), 0)::float   AS returns
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "date" >= ${q.from}::date AND "date" <= ${q.to}::date
          AND status != 'draft' AND status != 'cancelled'
      `,

      db.$queryRaw<[{ total: number; orders: number }]>`
        SELECT
          COALESCE(SUM("grandTotal"), 0)::float AS total,
          COUNT(*)::int                         AS orders
        FROM purchase_orders
        WHERE "branchId" = ${branchId}::uuid
          AND "poDate" >= ${q.from}::date AND "poDate" <= ${q.to}::date
          AND status != 'cancelled'
      `.catch(() => [{ total: 0, orders: 0 }] as [{ total: number; orders: number }]),

      db.$queryRaw<Array<{ category: string; amount: number; count: number }>>`
        SELECT
          COALESCE(category, 'Uncategorised') AS category,
          COALESCE(SUM(amount), 0)::float     AS amount,
          COUNT(*)::int                       AS count
        FROM expenses
        WHERE "branchId" = ${branchId}::uuid
          AND "date" >= ${q.from}::date AND "date" <= ${q.to}::date
        GROUP BY category
        ORDER BY amount DESC
      `.catch(() => [] as Array<{ category: string; amount: number; count: number }>),

      db.$queryRaw<[{ cgst: number; sgst: number; igst: number }]>`
        SELECT
          COALESCE(SUM("cgstTotal"), 0)::float AS cgst,
          COALESCE(SUM("sgstTotal"), 0)::float AS sgst,
          COALESCE(SUM("igstTotal"), 0)::float AS igst
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType" = 'sale_invoice'
          AND "date" >= ${q.from}::date AND "date" <= ${q.to}::date
          AND status != 'draft' AND status != 'cancelled'
      `,

      db.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM("taxAmt"), 0)::float AS total
        FROM purchase_orders
        WHERE "branchId" = ${branchId}::uuid
          AND "poDate" >= ${q.from}::date AND "poDate" <= ${q.to}::date
          AND status != 'cancelled'
      `.catch(() => [{ total: 0 }] as [{ total: number }]),
    ])

    const grossRevenue    = revenue[0]!.total
    const salesReturns    = revenue[0]!.returns
    const netRevenue      = grossRevenue - salesReturns
    const cogs            = purchases[0]!.total
    const grossProfit     = netRevenue - cogs
    const totalExpenses   = expenseRows.reduce((s, r) => s + r.amount, 0)
    const operatingProfit = grossProfit - totalExpenses
    const outputTax       = gstOut[0]!.cgst + gstOut[0]!.sgst + gstOut[0]!.igst
    const inputTax        = gstIn[0]!.total
    const netGstLiability = outputTax - inputTax

    return reply.send({
      from: q.from,
      to:   q.to,
      statement: {
        gross_revenue:      Math.round(grossRevenue),
        sales_returns:      Math.round(salesReturns),
        net_revenue:        Math.round(netRevenue),
        invoice_count:      revenue[0]!.invoices,
        cogs:               Math.round(cogs),
        purchase_orders:    purchases[0]!.orders,
        gross_profit:       Math.round(grossProfit),
        gross_margin_pct:   netRevenue > 0
          ? Math.round((grossProfit / netRevenue) * 1000) / 10 : 0,
        total_expenses:     Math.round(totalExpenses),
        expense_categories: expenseRows,
        operating_profit:   Math.round(operatingProfit),
        op_margin_pct:      netRevenue > 0
          ? Math.round((operatingProfit / netRevenue) * 1000) / 10 : 0,
        output_gst:         Math.round(outputTax),
        input_gst:          Math.round(inputTax),
        net_gst_liability:  Math.round(netGstLiability),
        net_profit:         Math.round(operatingProfit - netGstLiability),
        net_margin_pct:     netRevenue > 0
          ? Math.round(((operatingProfit - netGstLiability) / netRevenue) * 1000) / 10 : 0,
      },
    })
  })

  // ── GET /api/reports/cash-register?date=YYYY-MM-DD ────────────────────────
  // System-expected cash for the day + any saved cashier count.
  app.get('/cash-register', async (req, reply) => {
    const q = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
            .default(new Date().toISOString().slice(0, 10)),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId
    const dateStr  = q.date

    const [cashIn, cashOut, prevBalance, savedEntry] = await Promise.all([

      db.$queryRaw<[{ amount: number }]>`
        SELECT COALESCE(SUM(amount), 0)::float AS amount
        FROM payments
        WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" = ${dateStr}::date
          AND method = 'cash'
          AND direction = 'inbound'
      `.catch(() => [{ amount: 0 }] as [{ amount: number }]),

      db.$queryRaw<[{ amount: number }]>`
        SELECT COALESCE(SUM(amount), 0)::float AS amount
        FROM payments
        WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" = ${dateStr}::date
          AND method = 'cash'
          AND direction = 'outbound'
      `.catch(() => [{ amount: 0 }] as [{ amount: number }]),

      db.$queryRaw<[{ balance: number }]>`
        SELECT COALESCE(SUM(
          CASE WHEN direction = 'inbound' THEN amount ELSE -amount END
        ), 0)::float AS balance
        FROM payments
        WHERE "branchId" = ${branchId}::uuid
          AND "paymentDate" < ${dateStr}::date
          AND method = 'cash'
      `.catch(() => [{ balance: 0 }] as [{ balance: number }]),

      db.$queryRaw<Array<{
        id: string; system_cash: number; counted_cash: number
        difference: number; notes: string | null; closed_by: string | null
      }>>`
        SELECT id::text, "systemCash"::float AS system_cash,
               "countedCash"::float AS counted_cash,
               difference::float,
               notes, "closedBy" AS closed_by
        FROM cash_register_entries
        WHERE "branchId" = ${branchId}::uuid AND date = ${dateStr}::date
      `.catch(() => [] as Array<any>),
    ])

    const openingBalance = prevBalance[0]!.balance
    const cashInAmt      = cashIn[0]!.amount
    const cashOutAmt     = cashOut[0]!.amount
    const systemCash     = openingBalance + cashInAmt - cashOutAmt

    const payments = await db.$queryRaw<Array<{
      id: string; party_name: string | null; amount: number
      direction: string; ref_no: string | null; created_at: string
    }>>`
      SELECT py.id::text,
             p.name                             AS party_name,
             py.amount::float,
             py.direction,
             py."refNo"                         AS ref_no,
             TO_CHAR(py."createdAt", 'HH24:MI') AS created_at
      FROM payments py
      LEFT JOIN parties p ON p.id = py."partyId"
      WHERE py."branchId"    = ${branchId}::uuid
        AND py."paymentDate" = ${dateStr}::date
        AND py.method        = 'cash'
      ORDER BY py."createdAt" ASC
    `.catch(() => [] as Array<any>)

    return reply.send({
      date:              dateStr,
      opening_balance:   Math.round(openingBalance * 100) / 100,
      cash_in:           Math.round(cashInAmt  * 100) / 100,
      cash_out:          Math.round(cashOutAmt * 100) / 100,
      system_cash:       Math.round(systemCash * 100) / 100,
      saved_entry:       savedEntry[0] ?? null,
      cash_transactions: payments,
    })
  })

  // ── POST /api/reports/cash-register ───────────────────────────────────────
  // Save cashier's physical cash count for the day.
  app.post('/cash-register', async (req, reply) => {
    const body = z.object({
      date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      systemCash:  z.number(),
      countedCash: z.number(),
      notes:       z.string().max(500).optional(),
      closedBy:    z.string().max(100).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    await db.$executeRaw`
      INSERT INTO cash_register_entries
        ("branchId", date, "systemCash", "countedCash", notes, "closedBy", "updatedAt")
      VALUES
        (${branchId}::uuid, ${body.date}::date, ${body.systemCash},
         ${body.countedCash}, ${body.notes ?? null}, ${body.closedBy ?? null}, now())
      ON CONFLICT ("branchId", date)
      DO UPDATE SET
        "systemCash"  = EXCLUDED."systemCash",
        "countedCash" = EXCLUDED."countedCash",
        notes         = EXCLUDED.notes,
        "closedBy"    = EXCLUDED."closedBy",
        "updatedAt"   = now()
    `

    return reply.code(200).send({ ok: true })
  })

  // ── GET /api/reports/bank-accounts ────────────────────────────────────────
  app.get('/bank-accounts', async (req, reply) => {
    const db       = req.db
    const branchId = req.branchId

    const accounts = await db.$queryRaw<Array<{
      id: string; name: string; bank_name: string | null
      account_number: string | null; opening_balance: number
    }>>`
      SELECT id::text, name, "bankName" AS bank_name,
             "accountNumber" AS account_number,
             "openingBalance"::float AS opening_balance
      FROM bank_accounts
      WHERE "branchId" = ${branchId}::uuid AND "isActive" = true
      ORDER BY name ASC
    `.catch(() => [] as Array<any>)

    return reply.send({ accounts })
  })

  // ── POST /api/reports/bank-accounts ───────────────────────────────────────
  app.post('/bank-accounts', async (req, reply) => {
    const body = z.object({
      name:           z.string().min(1).max(100),
      bankName:       z.string().max(100).optional(),
      accountNumber:  z.string().max(30).optional(),
      openingBalance: z.number().default(0),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const rows = await db.$queryRaw<[{ id: string }]>`
      INSERT INTO bank_accounts ("branchId", name, "bankName", "accountNumber", "openingBalance")
      VALUES (${branchId}::uuid, ${body.name}, ${body.bankName ?? null},
              ${body.accountNumber ?? null}, ${body.openingBalance})
      RETURNING id::text
    `

    return reply.code(201).send({ id: rows[0]!.id })
  })

  // ── GET /api/reports/bank-reconciliation?month=YYYY-MM ────────────────────
  // Book balance (recorded bank payments) vs. user-entered statement balance.
  app.get('/bank-reconciliation', async (req, reply) => {
    const q = z.object({
      month:         z.string().regex(/^\d{4}-\d{2}$/),
      bankAccountId: z.string().uuid().optional(),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId
    const [yr, mo] = q.month.split('-').map(Number) as [number, number]
    const from = `${q.month}-01`
    const to   = new Date(yr, mo, 0).toISOString().slice(0, 10)

    const [bookRows, payments, savedEntry] = await Promise.all([

      db.$queryRaw<[{ inbound: number; outbound: number }]>`
        SELECT
          COALESCE(SUM(CASE WHEN direction = 'inbound'  THEN amount ELSE 0 END), 0)::float AS inbound,
          COALESCE(SUM(CASE WHEN direction = 'outbound' THEN amount ELSE 0 END), 0)::float AS outbound
        FROM payments
        WHERE "branchId"    = ${branchId}::uuid
          AND method        = 'bank_transfer'
          AND "paymentDate" >= ${from}::date
          AND "paymentDate" <= ${to}::date
      `.catch(() => [{ inbound: 0, outbound: 0 }] as [{ inbound: number; outbound: number }]),

      db.$queryRaw<Array<{
        id: string; party_name: string | null; amount: number
        direction: string; ref_no: string | null; payment_date: string
      }>>`
        SELECT py.id::text,
               p.name                                   AS party_name,
               py.amount::float,
               py.direction,
               py."refNo"                               AS ref_no,
               TO_CHAR(py."paymentDate", 'YYYY-MM-DD')  AS payment_date
        FROM payments py
        LEFT JOIN parties p ON p.id = py."partyId"
        WHERE py."branchId"    = ${branchId}::uuid
          AND py.method        = 'bank_transfer'
          AND py."paymentDate" >= ${from}::date
          AND py."paymentDate" <= ${to}::date
        ORDER BY py."paymentDate" ASC, py."createdAt" ASC
      `.catch(() => [] as Array<any>),

      db.$queryRawUnsafe<Array<{
        id: string; statement_balance: number; book_balance: number
        difference: number; notes: string | null
      }>>(
        `SELECT id::text,
                "statementBalance"::float AS statement_balance,
                "bookBalance"::float      AS book_balance,
                ("statementBalance" - "bookBalance")::float AS difference,
                notes
         FROM bank_reconciliation_entries
         WHERE "branchId" = $1::uuid
           AND month      = $2
           AND ${q.bankAccountId ? `"bankAccountId" = '${q.bankAccountId}'::uuid` : `"bankAccountId" IS NULL`}`,
        branchId, q.month,
      ).catch(() => [] as Array<any>),
    ])

    const bookIn      = bookRows[0]!.inbound
    const bookOut     = bookRows[0]!.outbound
    const bookBalance = bookIn - bookOut

    return reply.send({
      month:           q.month,
      bank_account_id: q.bankAccountId ?? null,
      book_balance:    Math.round(bookBalance * 100) / 100,
      book_in:         Math.round(bookIn      * 100) / 100,
      book_out:        Math.round(bookOut     * 100) / 100,
      saved_entry:     savedEntry[0] ?? null,
      transactions:    payments,
    })
  })

  // ── POST /api/reports/bank-reconciliation ─────────────────────────────────
  // Save bank statement balance for a month to complete reconciliation.
  app.post('/bank-reconciliation', async (req, reply) => {
    const body = z.object({
      month:            z.string().regex(/^\d{4}-\d{2}$/),
      bankAccountId:    z.string().uuid().optional(),
      statementBalance: z.number(),
      bookBalance:      z.number(),
      notes:            z.string().max(500).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    await db.$executeRaw`
      INSERT INTO bank_reconciliation_entries
        ("branchId", "bankAccountId", month, "statementBalance", "bookBalance", notes, "updatedAt")
      VALUES
        (${branchId}::uuid,
         ${body.bankAccountId ? body.bankAccountId : null}::uuid,
         ${body.month},
         ${body.statementBalance}, ${body.bookBalance},
         ${body.notes ?? null}, now())
      ON CONFLICT ("branchId", "bankAccountId", month)
      DO UPDATE SET
        "statementBalance" = EXCLUDED."statementBalance",
        "bookBalance"      = EXCLUDED."bookBalance",
        notes              = EXCLUDED.notes,
        "updatedAt"        = now()
    `

    return reply.code(200).send({ ok: true })
  })

  // ── GET /api/reports/monthly-comparison ──────────────────────────────────
  // This month vs last month: revenue, expenses, profit.
  // Returns absolute values + % delta for each metric.
  app.get('/monthly-comparison', async (req, reply) => {
    const db       = req.db
    const branchId = req.branchId

    const now       = new Date()
    const thisYear  = now.getFullYear()
    const thisMon   = now.getMonth() + 1  // 1-based

    const lastMonDate  = new Date(thisYear, now.getMonth() - 1, 1)
    const lastYear     = lastMonDate.getFullYear()
    const lastMon      = lastMonDate.getMonth() + 1

    const pad = (n: number) => String(n).padStart(2, '0')
    const thisFrom = `${thisYear}-${pad(thisMon)}-01`
    const thisTo   = now.toISOString().slice(0, 10)
    const lastFrom = `${lastYear}-${pad(lastMon)}-01`
    const lastTo   = `${lastYear}-${pad(lastMon)}-${new Date(lastYear, lastMon, 0).getDate()}`

    const [thisRev, lastRev, thisExp, lastExp] = await Promise.all([
      db.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM("grandTotal"),0)::float AS total
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'sale_invoice'
          AND status    != 'cancelled'
          AND date BETWEEN ${thisFrom}::date AND ${thisTo}::date
      `,
      db.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM("grandTotal"),0)::float AS total
        FROM invoices
        WHERE "branchId" = ${branchId}::uuid
          AND "txnType"  = 'sale_invoice'
          AND status    != 'cancelled'
          AND date BETWEEN ${lastFrom}::date AND ${lastTo}::date
      `,
      db.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM(amount),0)::float AS total
        FROM expenses
        WHERE "branchId" = ${branchId}::uuid
          AND date BETWEEN ${thisFrom}::date AND ${thisTo}::date
      `,
      db.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM(amount),0)::float AS total
        FROM expenses
        WHERE "branchId" = ${branchId}::uuid
          AND date BETWEEN ${lastFrom}::date AND ${lastTo}::date
      `,
    ])

    const rev  = { this: thisRev[0].total,  last: lastRev[0].total  }
    const exp  = { this: thisExp[0].total,  last: lastExp[0].total  }
    const prof = { this: rev.this - exp.this, last: rev.last - exp.last }

    function delta(cur: number, prev: number) {
      if (prev === 0) return cur > 0 ? 100 : 0
      return Math.round(((cur - prev) / prev) * 100)
    }

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

    return {
      thisMonth: monthNames[thisMon - 1],
      lastMonth: monthNames[lastMon - 1],
      revenue:  { this: rev.this,  last: rev.last,  delta: delta(rev.this,  rev.last)  },
      expenses: { this: exp.this,  last: exp.last,  delta: delta(exp.this,  exp.last)  },
      profit:   { this: prof.this, last: prof.last, delta: delta(prof.this, prof.last) },
    }
  })
}
