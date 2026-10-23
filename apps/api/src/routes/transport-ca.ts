// apps/api/src/routes/transport-ca.ts
// What a chartered accountant asks a transport business for, as data the screen shows and the browser turns into Excel.
// Registered under /api/transport. Each report is for the firm (branch) being worked in; /ca/combined adds the owner's
// firms together. Dates are IST business dates; amounts are rupees.
//
//   GET /ca/sales-register     freight + goods bills: GST split, TDS deducted / recorded, received, outstanding
//   GET /ca/receipts-register  money received (and TDS the customer cut), what it was applied to, whether the bank shows it
//   GET /ca/expense-register   trip costs + office costs, who paid, GST paid
//   GET /ca/truck-weekly      the same, week by week (Monday to Sunday)
//   GET /ca/truck-monthly     each truck month by month: trips, km, freight, diesel, toll, other costs, hire, net (?vehicleId= for one truck)
//   GET /ca/fuel-register      every diesel fill + km per litre by trip and by truck
//   GET /ca/tds-register       TDS (Sec 194C) by customer and quarter, for matching against Form 26AS
//   GET /ca/gstr3b             outward tax, supplies where the recipient pays, input credit — indicative, not a return
//                              (both also take ?scope=gstin, owner only: every firm that shares this firm's GSTIN, as one return)
//   GET /ca/pump-ledger        diesel taken on account: billed, paid, still owed — per pump
//   GET /ca/outstanding        who owes what, aged by due date
//   GET /ca/bank-book          bank statement lines with what each one was matched to
//   GET /ca/combined           owner only: every firm side by side, with a total
//
// Every report returns { title, from, to, firm, columns, rows, totals, notes } so one table component can show any of them.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getExpenseCategories } from '@billing/domain-registry'
import { tbl, q, q1, httpError, r2, todayStr, paidByExpr } from '../lib/transport-helpers.js'
import { qFast } from '../lib/fast-sql.js'
import { describeMatches, LINE_COLS, type Line } from './transport-bank.js'

type Cell = string | number | null
type Row = Record<string, Cell>

interface Report {
  title: string; from: string; to: string; firm: { name: string; gstin: string | null }
  columns: string[]; rows: Row[]; totals: Record<string, number>; notes: string[]
  [extra: string]: unknown
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const period = z.object({ from: dateStr.optional(), to: dateStr.optional() })
/** `?preview=300`: the screen wants the first rows plus the real totals — not 86,000 rows to throw 85,700 away. */
const previewQ = z.object({ preview: z.coerce.number().int().min(1).max(2000).optional() })
const byDate = (a: Row, b: Row) => (a['Date']! < b['Date']! ? -1 : a['Date']! > b['Date']! ? 1 : 0)        // ISO dates sort as plain text (localeCompare is ~10× slower)
/** `gstin` = every firm under this firm's GSTIN together (one taxpayer, several trade names) — the CA files one return. */
const scopeQ = z.object({ scope: z.enum(['firm', 'gstin']).default('firm') })

/** 1 April of the financial year that contains `d`. */
const fyStart = (d: string) => `${Number(d.slice(5, 7)) >= 4 ? d.slice(0, 4) : String(Number(d.slice(0, 4)) - 1)}-04-01`
const range = (qy: { from?: string; to?: string }) => {
  const to = qy.to ?? todayStr()
  const from = qy.from ?? fyStart(to)
  if (from > to) throw httpError(422, '“From” is after “To”')
  return { from, to }
}

/** "Q2 FY2026-27" for a YYYY-MM-DD date (Indian financial-year quarters). */
export function fyQuarter(d: string): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7))
  const fy = m >= 4 ? y : y - 1
  const qn = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4
  return `Q${qn} FY${fy}-${String(fy + 1).slice(2)}`
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card', cheque: 'Cheque', bank_transfer: 'Bank transfer', credit: 'On credit', tds: 'TDS deducted by customer',
}
const GST_MODE_LABEL: Record<string, string> = {
  rcm: 'RCM — recipient pays', forward_5: 'Forward charge 5%', forward_12: 'Forward charge 12%', forward_18: 'Forward charge 18%', exempt: 'Exempt',
}
const PAYER_LABEL: Record<string, string> = { driver: 'Driver', company: 'Company', vendor_credit: 'On account at pump' }

async function firmOf(req: FastifyRequest) {
  const b = await q1<any>(req, `SELECT name, gstin FROM ${tbl(req.schemaName, 'branches')} WHERE id = $1::uuid`, req.branchId)
  return { name: String(b?.name ?? ''), gstin: (b?.gstin ?? null) as string | null }
}

const sum = (rows: Row[], key: string, where?: (r: Row) => boolean) =>
  r2(rows.filter((r) => (where ? where(r) : true)).reduce((t, r) => t + (Number(r[key]) || 0), 0))

const tdsRecordedSql = (s: string) => `
  COALESCE((SELECT SUM(al.amount) FROM ${tbl(s, 'payment_allocations')} al JOIN ${tbl(s, 'payments')} pm ON pm.id = al."paymentId"
            WHERE al."invoiceId" = i.id AND pm.method = 'tds' AND pm.status = 'active'), 0)::float`

const billType = (dd: any): string => (dd?.bill_kind === 'credit_note' ? 'Credit note' : dd?.bill_kind === 'debit_note' ? 'Debit note'
  : dd?.bill_kind === 'goods_sale' ? 'Goods bill' : Array.isArray(dd?.lr_ids) && dd.lr_ids.length ? 'Freight bill' : 'Sale')

export const transportCaRoutes: FastifyPluginAsync = async (app) => {
  const S = (req: FastifyRequest) => req.schemaName

  // `?preview=300` is what the on-screen view asks for: the first rows only (totals, summaries and notes still cover everything), so a
  // three-year register of 86,000 rows does not travel to, or get drawn by, the browser. Excel and the CA pack ask without it.
  app.addHook('preSerialization', async (req, _reply, payload: any) => {
    const n = Number((req.query as Record<string, unknown> | undefined)?.['preview'])
    if (!n || n < 1 || !payload || !Array.isArray(payload.rows)) return payload
    const trimMileage = Array.isArray(payload.mileage) && payload.mileage.length > n ? { mileage: payload.mileage.slice(0, n) } : {}
    if (payload.rows.length <= n) return Object.keys(trimMileage).length ? { ...payload, ...trimMileage } : payload
    return { ...payload, ...trimMileage, rows: payload.rows.slice(0, n), totalRows: payload.rows.length, truncated: true }
  })

  /** The branches a tax report covers: this firm, or (owner only) every active firm with the same GSTIN. */
  async function scopeBranches(req: FastifyRequest, scope: 'firm' | 'gstin'): Promise<{ ids: string[]; names: string[]; together: boolean }> {
    const me = await q1<any>(req, `SELECT name, gstin FROM ${tbl(S(req), 'branches')} WHERE id = $1::uuid`, req.branchId)
    if (scope !== 'gstin') return { ids: [req.branchId], names: [String(me?.name ?? '')], together: false }
    if (req.role !== 'owner') throw httpError(403, 'Only the owner can see the firms together')
    if (!me?.gstin) return { ids: [req.branchId], names: [String(me?.name ?? '')], together: false }
    const bs = await q<any>(req, `SELECT id, name FROM ${tbl(S(req), 'branches')} WHERE "isActive" = true AND gstin = $1 ORDER BY "createdAt"`, me.gstin)
    return { ids: bs.map((b: any) => b.id), names: bs.map((b: any) => String(b.name)), together: bs.length > 1 }
  }

  // ── Sales register ──────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/sales-register', async (req): Promise<Report> => {
    const qy = period.merge(previewQ).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    // TDS recorded against each bill, added up ONCE and joined — asking bill by bill made the database do 150,000 look-ups (3 s of 5 s).
    const TDS = `tds AS (SELECT al."invoiceId" AS iid, SUM(al.amount)::float AS amt FROM ${tbl(s, 'payment_allocations')} al JOIN ${tbl(s, 'payments')} pm ON pm.id = al."paymentId"
                         WHERE pm."branchId" = $1::uuid AND pm.method = 'tds' AND pm.status = 'active' GROUP BY al."invoiceId")`
    const WHERE = `i."branchId" = $1::uuid AND i."txnType" IN ('sale_invoice', 'credit_note', 'debit_note') AND (i."txnType" = 'sale_invoice' OR i."domainData"->>'bill_kind' IN ('credit_note', 'debit_note')) AND i.status <> 'draft' AND i.date BETWEEN $2::date AND $3::date`
    const FROM = `FROM ${tbl(s, 'invoices')} i LEFT JOIN ${tbl(s, 'parties')} p ON p.id = i."partyId" LEFT JOIN tds ON tds.iid = i.id WHERE ${WHERE}`
    const COLS = `to_char(i.date, 'YYYY-MM-DD') AS date, i.number, i.status, i."domainData" AS dd,
              i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst, i."igstTotal"::float AS igst,
              i."roundOff"::float AS "roundOff", i."grandTotal"::float AS total, i."paidAmt"::float AS paid,
              p.name AS party, p.gstin, p.pan, COALESCE(p.address->>'stateCode', '') AS sc, COALESCE(tds.amt, 0) AS "tdsRecorded"`
    const ORDER = `ORDER BY i.date, NULLIF(substring(i.number FROM '[0-9]+$'), '')::bigint NULLS LAST, i.number`
    const mapRow = (r: any): Row => {
      const cancelled = r.status === 'cancelled'
      const dd = r.dd ?? {}
      const isCredit = dd.bill_kind === 'credit_note'
      if (isCredit) for (const k of ['taxable', 'cgst', 'sgst', 'igst', 'roundOff', 'total']) r[k] = -r[k]       // a credit note takes value off
      const tax = r2(r.cgst + r.sgst + r.igst)
      const treatment = dd.bill_kind === 'goods_sale' ? (tax > 0 ? `GST ${Math.round((tax / Math.max(r.taxable, 0.01)) * 100)}%` : 'Nil rated')
        : (GST_MODE_LABEL[String(dd.gst_mode)] ?? '')
      const tdsDeducted = r2(Number(dd.tds_amount ?? 0))
      return {
        'Date': r.date, 'Invoice no': r.number, 'Type': billType(dd), 'Customer': r.party ?? '', 'GSTIN': r.gstin ?? '', 'PAN': r.pan ?? '',
        'Place of supply': r.sc || (r.gstin ? String(r.gstin).slice(0, 2) : ''), 'GST treatment': treatment,
        'Taxable value': r2(r.taxable), 'CGST': r2(r.cgst), 'SGST': r2(r.sgst), 'IGST': r2(r.igst), 'Round off': r2(r.roundOff), 'Invoice total': r2(r.total),
        'TDS deducted': tdsDeducted, 'TDS recorded': r2(r.tdsRecorded),
        'Received (excl. TDS)': cancelled || isCredit ? 0 : r2(Math.max(0, r.paid - r.tdsRecorded)),
        'Outstanding': cancelled || isCredit ? 0 : r2(Math.max(0, r.total - r.paid)),
        'Status': cancelled ? 'Cancelled' : String(r.status).replace(/_/g, ' '),
        'LR numbers': Array.isArray(dd.lr_nos) ? dd.lr_nos.join(', ') : '', 'Vehicles': Array.isArray(dd.vehicle_nos) ? dd.vehicle_nos.join(', ') : '',
        'Against bill': dd.against_number ?? '',
      }
    }
    const cols = ['Date', 'Invoice no', 'Type', 'Customer', 'GSTIN', 'PAN', 'Place of supply', 'GST treatment', 'Taxable value', 'CGST', 'SGST', 'IGST', 'Round off', 'Invoice total', 'TDS deducted', 'TDS recorded', 'Received (excl. TDS)', 'Outstanding', 'Status', 'LR numbers', 'Vehicles', 'Against bill']
    const NOTES = ['Cancelled bills are listed (so the number series is complete) but left out of the totals.', 'Credit notes are shown as minus figures and debit notes as plus, so the totals are net of both.']

    // Screen: the same totals from ONE aggregate query, and only the first rows.
    if (qy.preview) {
      const [agg, first] = await Promise.all([
        qFast<any>(req, `WITH ${TDS}, r AS (
            SELECT (i.status = 'cancelled') AS cancelled, ((i."domainData"->>'bill_kind') = 'credit_note') AS credit,
                   i."taxableAmt" AS taxable, i."cgstTotal" AS cgst, i."sgstTotal" AS sgst, i."igstTotal" AS igst, i."roundOff" AS ro, i."grandTotal" AS total, i."paidAmt" AS paid,
                   COALESCE(NULLIF(i."domainData"->>'tds_amount', '')::numeric, 0) AS tdsd, COALESCE(tds.amt, 0)::numeric AS tdsr
            FROM ${tbl(s, 'invoices')} i LEFT JOIN tds ON tds.iid = i.id WHERE ${WHERE})
          SELECT COUNT(*)::int AS n,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -taxable ELSE taxable END END), 0)::float AS taxable,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -cgst ELSE cgst END END), 0)::float AS cgst,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -sgst ELSE sgst END END), 0)::float AS sgst,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -igst ELSE igst END END), 0)::float AS igst,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -ro ELSE ro END END), 0)::float AS ro,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN CASE WHEN credit THEN -total ELSE total END END), 0)::float AS total,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN tdsd END), 0)::float AS tdsd,
            COALESCE(SUM(CASE WHEN NOT cancelled THEN tdsr END), 0)::float AS tdsr,
            COALESCE(SUM(CASE WHEN NOT cancelled AND NOT credit THEN GREATEST(0, paid - tdsr) END), 0)::float AS received,
            COALESCE(SUM(CASE WHEN NOT cancelled AND NOT credit THEN GREATEST(0, total - paid) END), 0)::float AS outstanding
          FROM r`, req.branchId, from, to),
        qFast<any>(req, `WITH ${TDS} SELECT ${COLS} ${FROM} ${ORDER} LIMIT ${qy.preview}`, req.branchId, from, to),
      ])
      const a = agg[0]
      return {
        title: 'Sales register', from, to, firm: await firmOf(req), columns: cols, rows: first.map(mapRow),
        ...(a.n > first.length ? { totalRows: a.n, truncated: true } : {}),
        totals: {
          'Taxable value': r2(a.taxable), 'CGST': r2(a.cgst), 'SGST': r2(a.sgst), 'IGST': r2(a.igst), 'Round off': r2(a.ro), 'Invoice total': r2(a.total),
          'TDS deducted': r2(a.tdsd), 'TDS recorded': r2(a.tdsr), 'Received (excl. TDS)': r2(a.received), 'Outstanding': r2(a.outstanding),
        },
        notes: NOTES,
      }
    }

    const rows = await qFast<any>(req, `WITH ${TDS} SELECT ${COLS} ${FROM} ${ORDER}`, req.branchId, from, to)
    const out: Row[] = rows.map(mapRow)
    const live = (r: Row) => r['Status'] !== 'Cancelled'
    return {
      title: 'Sales register', from, to, firm: await firmOf(req), columns: cols, rows: out,
      totals: Object.fromEntries(['Taxable value', 'CGST', 'SGST', 'IGST', 'Round off', 'Invoice total', 'TDS deducted', 'TDS recorded', 'Received (excl. TDS)', 'Outstanding'].map((k) => [k, sum(out, k, live)])),
      notes: NOTES,
    }
  })

  // ── Receipts register ───────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/receipts-register', async (req): Promise<Report> => {
    const qy = period.merge(previewQ).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    // Which statement holds each receipt: read the matched bank lines ONCE and join. (Asking per receipt — "is there a line whose
    // paymentIds contain this id?" — made the database re-read every bank line for every receipt: 22 s at 60,000 lines.)
    const MATCHED = `matched AS (
         SELECT DISTINCT ON (x.pid) x.pid, ba.name
         FROM ${tbl(s, 'transport_bank_lines')} bl
         CROSS JOIN LATERAL unnest(bl."paymentIds") AS x(pid)
         JOIN ${tbl(s, 'bank_accounts')} ba ON ba.id = bl."bankAccountId"
         WHERE bl."branchId" = $1::uuid AND bl.status = 'matched' AND bl."paymentIds" IS NOT NULL
         ORDER BY x.pid, bl."txnDate")`
    const WHERE = `p."branchId" = $1::uuid AND p.type IN ('receipt', 'advance') AND p."paymentDate" BETWEEN $2::date AND $3::date`
    // Which bills each receipt went to, and how much: added up once for all receipts in the period (the old per-receipt look-ups were most of the time).
    const ALLOC = `alloc AS (
         SELECT al."paymentId" AS pid, SUM(al.amount)::float AS applied, string_agg(i.number, ', ' ORDER BY i.number) AS bills
         FROM ${tbl(s, 'payment_allocations')} al JOIN ${tbl(s, 'invoices')} i ON i.id = al."invoiceId"
         WHERE al."paymentId" IN (SELECT p.id FROM ${tbl(s, 'payments')} p WHERE ${WHERE}) GROUP BY al."paymentId")`
    const COLS = `to_char(p."paymentDate", 'YYYY-MM-DD') AS date, pa.name AS party, pa.gstin, p.amount::float AS amount, p.method, p."refNo", p.status,
              COALESCE(alloc.bills, '') AS bills, COALESCE(alloc.applied, 0)::float AS applied, m.name AS bank`
    const FROM = `FROM ${tbl(s, 'payments')} p LEFT JOIN ${tbl(s, 'parties')} pa ON pa.id = p."partyId" LEFT JOIN matched m ON m.pid = p.id LEFT JOIN alloc ON alloc.pid = p.id WHERE ${WHERE}`
    // the screen's totals: one pass over the receipts of the period, each with what was applied to bills (no bill numbers needed)
    const TOTALS = `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(x.amount) FILTER (WHERE x.active AND x.method NOT IN ('cash', 'tds', 'credit')), 0)::float AS bank,
            COALESCE(SUM(x.amount) FILTER (WHERE x.active AND x.method = 'cash'), 0)::float AS cash,
            COALESCE(SUM(x.amount) FILTER (WHERE x.active AND x.method = 'tds'), 0)::float AS tds,
            COALESCE(SUM(GREATEST(0, x.amount - x.applied)) FILTER (WHERE x.active), 0)::float AS unapplied
          FROM (SELECT p.amount, p.method, (p.status = 'active') AS active, COALESCE(SUM(al.amount), 0) AS applied
                FROM ${tbl(s, 'payments')} p LEFT JOIN ${tbl(s, 'payment_allocations')} al ON al."paymentId" = p.id
                WHERE ${WHERE} GROUP BY p.id) x`
    // for the first rows only: which statement holds each of THESE receipts. The index on the bank lines' paymentIds finds them directly
    // (the full register reads every matched line once, MATCHED above; for 300 receipts that was 640 ms of waste at 600,000 lines).
    const MATCHED_PAGE = `matched AS (
         SELECT DISTINCT ON (x.pid) x.pid, ba.name
         FROM ${tbl(s, 'transport_bank_lines')} bl
         CROSS JOIN LATERAL unnest(bl."paymentIds") AS x(pid)
         JOIN ${tbl(s, 'bank_accounts')} ba ON ba.id = bl."bankAccountId"
         WHERE bl."branchId" = $1::uuid AND bl.status = 'matched' AND bl."paymentIds" && ARRAY(SELECT id FROM page) AND x.pid IN (SELECT id FROM page)
         ORDER BY x.pid, bl."txnDate")`
    // the first receipts only, then their bills: the bill numbers are looked up for these rows, not for every receipt in the period
    const pageRows = (n: number) => `page AS (SELECT p.* FROM ${tbl(s, 'payments')} p WHERE ${WHERE} ORDER BY p."paymentDate", p."createdAt" LIMIT ${n}),
       alloc AS (SELECT al."paymentId" AS pid, SUM(al.amount)::float AS applied, string_agg(i.number, ', ' ORDER BY i.number) AS bills
         FROM ${tbl(s, 'payment_allocations')} al JOIN ${tbl(s, 'invoices')} i ON i.id = al."invoiceId" WHERE al."paymentId" IN (SELECT id FROM page) GROUP BY al."paymentId")`
    const mapRow = (r: any): Row => ({
      'Date': r.date, 'Customer': r.party ?? '', 'GSTIN': r.gstin ?? '', 'Mode': METHOD_LABEL[r.method] ?? r.method, 'Reference / UTR': r.refNo ?? '',
      'Amount': r2(r.amount), 'Applied to bills': r.bills, 'Not yet applied': r2(Math.max(0, r.amount - r.applied)),
      'In bank statement': r.bank ?? (['cash', 'tds'].includes(r.method) ? '—' : ''), 'Status': r.status === 'active' ? 'Active' : r.status === 'voided' ? 'Voided' : r.status,
    })
    const columns = ['Date', 'Customer', 'GSTIN', 'Mode', 'Reference / UTR', 'Amount', 'Applied to bills', 'Not yet applied', 'In bank statement', 'Status']
    const NOTES = ['Voided receipts are listed but not counted. An empty “In bank statement” means no imported statement line has been matched to it yet.']

    // Screen: totals from one aggregate query, and only the first receipts.
    if (qy.preview) {
      const [agg, first] = await Promise.all([
        qFast<any>(req, TOTALS, req.branchId, from, to),
        qFast<any>(req, `WITH ${pageRows(qy.preview)}, ${MATCHED_PAGE}
          SELECT ${COLS} FROM page p LEFT JOIN ${tbl(s, 'parties')} pa ON pa.id = p."partyId" LEFT JOIN matched m ON m.pid = p.id LEFT JOIN alloc ON alloc.pid = p.id
          ORDER BY p."paymentDate", p."createdAt"`, req.branchId, from, to),
      ])
      const a = agg[0]
      return {
        title: 'Receipts register', from, to, firm: await firmOf(req), columns, rows: first.map(mapRow),
        ...(a.n > first.length ? { totalRows: a.n, truncated: true } : {}),
        totals: { 'Received in bank / UPI / cheque': r2(a.bank), 'Received in cash': r2(a.cash), 'TDS deducted by customers': r2(a.tds), 'Not yet applied to a bill': r2(a.unapplied) },
        notes: NOTES,
      }
    }

    const rows = await qFast<any>(req, `WITH ${MATCHED}, ${ALLOC} SELECT ${COLS} ${FROM} ORDER BY p."paymentDate", p."createdAt"`, req.branchId, from, to)
    const out: Row[] = rows.map(mapRow)
    const live = (r: Row) => r['Status'] === 'Active'
    return {
      title: 'Receipts register', from, to, firm: await firmOf(req), columns, rows: out,
      totals: {
        'Received in bank / UPI / cheque': sum(out, 'Amount', (r) => live(r) && !['Cash', 'TDS deducted by customer', 'On credit'].includes(String(r['Mode']))),
        'Received in cash': sum(out, 'Amount', (r) => live(r) && r['Mode'] === 'Cash'),
        'TDS deducted by customers': sum(out, 'Amount', (r) => live(r) && r['Mode'] === 'TDS deducted by customer'),
        'Not yet applied to a bill': sum(out, 'Not yet applied', live),
      },
      notes: NOTES,
    }
  })

  // ── Expense register ────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/expense-register', async (req): Promise<Report> => {
    const qy = period.merge(previewQ).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    const labels = new Map(getExpenseCategories('transport').map((c) => [c.code, c.label]))
    const tripRow = (r: any): Row => ({
      'Date': r.date, 'Source': 'Trip cost', 'Category': labels.get(r.category) ?? r.category, 'Trip': r.tripNo ?? '', 'Vehicle': r.vehicle ?? '',
      'Vendor / pump': r.vendorName ?? '', 'Description': r.notes ?? '', 'Bill no': r.billNo ?? '', 'Litres': r.litres == null ? null : r2(r.litres),
      'Amount': r2(r.amount), 'GST included': 0, 'Paid by': PAYER_LABEL[r.payer] ?? r.payer, 'Mode': r.paymentMode, 'Settled on': r.settled ?? '',
    })
    const officeRow = (r: any): Row => ({
      'Date': r.date, 'Source': 'Office cost', 'Category': labels.get(r.category) ?? r.category, 'Trip': '', 'Vehicle': '',
      'Vendor / pump': r.vendor ?? '', 'Description': r.description ?? '', 'Bill no': r.referenceNo ?? '', 'Litres': null,
      'Amount': r2(r.amount), 'GST included': r2(r.gst), 'Paid by': 'Company', 'Mode': r.paymentMode, 'Settled on': '',
    })
    const COLUMNS = ['Date', 'Source', 'Category', 'Trip', 'Vehicle', 'Vendor / pump', 'Description', 'Bill no', 'Litres', 'Amount', 'GST included', 'Paid by', 'Mode', 'Settled on']
    const NOTES = ['Trip costs do not carry GST in this app, so “GST included” only has office costs.', '“Still owed to pumps” = diesel taken on account that has not been marked paid.']
    const TRIP_SQL = `SELECT to_char(e."expenseDate", 'YYYY-MM-DD') AS date, e.category, e.amount::float AS amount, e.litres::float AS litres, e."vendorName", e."billNo", e.notes,
                e."paymentMode", ${paidByExpr('e')} AS payer, to_char(e."settledOn", 'YYYY-MM-DD') AS settled, t."tripNo", v."regNo" AS vehicle
         FROM ${tbl(s, 'transport_expenses')} e LEFT JOIN ${tbl(s, 'transport_trips')} t ON t.id = e."tripId" LEFT JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = e."vehicleId"
         WHERE e."branchId" = $1::uuid AND e."expenseDate" BETWEEN $2::date AND $3::date`
    const OFFICE_SQL = `SELECT to_char(e.date, 'YYYY-MM-DD') AS date, e.category, e.description, e.amount::float AS amount, e."gstAmount"::float AS gst, e."paymentMode", e."referenceNo", p.name AS vendor
         FROM ${tbl(s, 'expenses')} e LEFT JOIN ${tbl(s, 'parties')} p ON p.id = e."partyId"
         WHERE e."branchId" = $1::uuid AND e.date BETWEEN $2::date AND $3::date`

    // Screen: the real totals from one aggregate query each, plus only the first rows — never all of them.
    if (qy.preview) {
      const [tripAgg, officeAgg, trip, office] = await Promise.all([
        qFast<any>(req, `SELECT COUNT(*)::int AS n, COALESCE(SUM(e.amount), 0)::float AS amount,
                           COALESCE(SUM(e.amount) FILTER (WHERE ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL), 0)::float AS owed
                         FROM ${tbl(s, 'transport_expenses')} e WHERE e."branchId" = $1::uuid AND e."expenseDate" BETWEEN $2::date AND $3::date`, req.branchId, from, to),
        qFast<any>(req, `SELECT COUNT(*)::int AS n, COALESCE(SUM(e.amount), 0)::float AS amount, COALESCE(SUM(e."gstAmount"), 0)::float AS gst
                         FROM ${tbl(s, 'expenses')} e WHERE e."branchId" = $1::uuid AND e.date BETWEEN $2::date AND $3::date`, req.branchId, from, to),
        qFast<any>(req, `${TRIP_SQL} ORDER BY e."expenseDate", e."createdAt" LIMIT $4::int`, req.branchId, from, to, qy.preview),
        qFast<any>(req, `${OFFICE_SQL} ORDER BY e.date, e."createdAt" LIMIT $4::int`, req.branchId, from, to, qy.preview),
      ])
      const first = [...trip.map(tripRow), ...office.map(officeRow)].sort(byDate).slice(0, qy.preview)     // first N of two sorted lists = first N of their merge
      const total = tripAgg[0].n + officeAgg[0].n
      return {
        title: 'Expense register', from, to, firm: await firmOf(req), columns: COLUMNS, rows: first,
        ...(total > first.length ? { totalRows: total, truncated: true } : {}),
        totals: {
          'Trip costs': r2(tripAgg[0].amount), 'Office costs': r2(officeAgg[0].amount), 'Total expenses': r2(tripAgg[0].amount + officeAgg[0].amount),
          'GST paid on office costs': r2(officeAgg[0].gst), 'Still owed to pumps': r2(tripAgg[0].owed),
        },
        notes: NOTES,
      }
    }

    const [trip, office] = await Promise.all([
      qFast<any>(req, TRIP_SQL, req.branchId, from, to),
      qFast<any>(req, OFFICE_SQL, req.branchId, from, to),
    ])
    const out: Row[] = [...trip.map(tripRow), ...office.map(officeRow)].sort(byDate)
    return {
      title: 'Expense register', from, to, firm: await firmOf(req),
      columns: COLUMNS, rows: out,
      totals: {
        'Trip costs': sum(out, 'Amount', (r) => r['Source'] === 'Trip cost'), 'Office costs': sum(out, 'Amount', (r) => r['Source'] === 'Office cost'),
        'Total expenses': sum(out, 'Amount'), 'GST paid on office costs': sum(out, 'GST included'),
        'Still owed to pumps': sum(out, 'Amount', (r) => r['Paid by'] === 'On account at pump' && !r['Settled on']),
      },
      notes: NOTES,
    }
  })

  // ── Truck-wise monthly ──────────────────────────────────────────────────────────────────────────────────────────
  // Same attribution as /reports/vehicle-pnl: trips and hire by start date, freight by LR date, costs by expense date.
  for (const by of ['month', 'week'] as const) app.get(`/ca/truck-${by}ly`, async (req): Promise<Report> => {
    const { vehicleId, ...p } = z.object({ vehicleId: z.string().uuid().optional() }).merge(period).parse(req.query)
    const { from, to } = range(p)
    const s = S(req)
    const v = vehicleId ?? null
    // a bucket is a calendar month (YYYY-MM) or a Monday-to-Sunday week (the Monday's date)
    const month = (col: string) => (by === 'week' ? `to_char(date_trunc('week', ${col}), 'YYYY-MM-DD')` : `to_char(${col}, 'YYYY-MM')`)
    const [trips, lrs, costs, vehicles] = await Promise.all([
      qFast<any>(req,
        `SELECT t."vehicleId" AS vid, ${month('t."startDate"')} AS m, COUNT(*)::int AS trips, COALESCE(SUM(t."hireCharges"),0)::float AS hire,
                COALESCE(SUM(CASE WHEN t.status = 'completed' AND t."endOdometer" > t."startOdometer" THEN t."endOdometer" - t."startOdometer" END),0)::float AS km
         FROM ${tbl(s, 'transport_trips')} t WHERE t."branchId" = $1::uuid AND t.status != 'cancelled' AND t."startDate" BETWEEN $2::date AND $3::date
           AND ($4::uuid IS NULL OR t."vehicleId" = $4::uuid) GROUP BY 1, 2`, req.branchId, from, to, v),
      qFast<any>(req,
        `SELECT l."vehicleId" AS vid, ${month('l."lrDate"')} AS m, COALESCE(SUM(l."totalAmount"),0)::float AS freight
         FROM ${tbl(s, 'transport_lorry_receipts')} l WHERE l."branchId" = $1::uuid AND l.status != 'cancelled' AND l."vehicleId" IS NOT NULL
           AND l."lrDate" BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR l."vehicleId" = $4::uuid) GROUP BY 1, 2`, req.branchId, from, to, v),
      qFast<any>(req,
        `SELECT e."vehicleId" AS vid, ${month('e."expenseDate"')} AS m,
                COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'diesel'),0)::float AS diesel,
                COALESCE(SUM(e.amount) FILTER (WHERE e.category = 'toll'),0)::float AS toll,
                COALESCE(SUM(e.amount) FILTER (WHERE e.category NOT IN ('diesel','toll')),0)::float AS other
         FROM ${tbl(s, 'transport_expenses')} e WHERE e."branchId" = $1::uuid AND e."vehicleId" IS NOT NULL
           AND e."expenseDate" BETWEEN $2::date AND $3::date AND ($4::uuid IS NULL OR e."vehicleId" = $4::uuid) GROUP BY 1, 2`, req.branchId, from, to, v),
      qFast<any>(req, `SELECT id, "regNo" FROM ${tbl(s, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND ($2::uuid IS NULL OR id = $2::uuid) ORDER BY "regNo"`, req.branchId, v),
    ])
    const reg = new Map<string, string>(vehicles.map((x: any) => [x.id, x.regNo]))
    type Acc = { trips: number; km: number; freight: number; diesel: number; toll: number; other: number; hire: number }
    const cells = new Map<string, Acc>()           // `${vid}|${YYYY-MM}`
    const at = (vid: string, m: string) => { const k = `${vid}|${m}`; let c = cells.get(k); if (!c) cells.set(k, c = { trips: 0, km: 0, freight: 0, diesel: 0, toll: 0, other: 0, hire: 0 }); return c }
    for (const r of trips) Object.assign(at(r.vid, r.m), { trips: r.trips, km: r.km, hire: r.hire })
    for (const r of lrs) at(r.vid, r.m).freight += r.freight
    for (const r of costs) Object.assign(at(r.vid, r.m), { diesel: r.diesel, toll: r.toll, other: r.other })

    const buckets: string[] = []                   // every bucket in the period, for a single truck's full view
    if (by === 'week') {
      const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
      for (; d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 7)) buckets.push(d.toISOString().slice(0, 10))
    } else {
      for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)); `${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7); m === 12 ? (y++, m = 1) : m++) buckets.push(`${y}-${String(m).padStart(2, '0')}`)
    }
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const label = (m: string) => {
      if (by === 'month') return `${MON[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`
      const e = new Date(`${m}T00:00:00Z`); e.setUTCDate(e.getUTCDate() + 6)
      const sd = (x: string) => `${Number(x.slice(8, 10))} ${MON[Number(x.slice(5, 7)) - 1]}`
      const end = e.toISOString().slice(0, 10)
      return `${sd(m)} – ${sd(end)} ${end.slice(0, 4)}`
    }

    const rows: Row[] = [], totalsBy = new Map<string, Acc>()
    const col = by === 'week' ? 'Week' : 'Month'
    const mk = (name: string, m: string, a: Acc): Row => {
      const cost = r2(a.diesel + a.toll + a.other + a.hire), net = r2(a.freight - cost)
      return { 'Truck': name, [col]: m, 'Trips': a.trips, 'Km run': r2(a.km), 'Freight': r2(a.freight), 'Diesel': r2(a.diesel), 'Toll': r2(a.toll), 'Other trip costs': r2(a.other),
               'Hire charges': r2(a.hire), 'Total cost': cost, 'Net profit': net, 'Margin %': a.freight > 0 ? r2((net / a.freight) * 100) : null }
    }
    for (const [vid, name] of [...reg.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
      const tot: Acc = { trips: 0, km: 0, freight: 0, diesel: 0, toll: 0, other: 0, hire: 0 }
      for (const m of buckets) {
        const a = cells.get(`${vid}|${m}`)
        if (!a && !vehicleId) continue
        const c = a ?? { trips: 0, km: 0, freight: 0, diesel: 0, toll: 0, other: 0, hire: 0 }
        rows.push(mk(name, label(m), c))
        for (const k of Object.keys(tot) as Array<keyof Acc>) tot[k] += c[k]
      }
      if (a_any(tot)) totalsBy.set(name, tot)
    }
    function a_any(a: Acc) { return Object.values(a).some((x) => x !== 0) }
    const truckTotals: Row[] = [...totalsBy.entries()].map(([name, a]) => mk(name, 'Whole period', a))
    return {
      title: by === 'week' ? 'Truck-wise weekly report' : 'Truck-wise monthly report', from, to, firm: await firmOf(req),
      columns: ['Truck', by === 'week' ? 'Week' : 'Month', 'Trips', 'Km run', 'Freight', 'Diesel', 'Toll', 'Other trip costs', 'Hire charges', 'Total cost', 'Net profit', 'Margin %'], rows,
      totals: Object.fromEntries(['Trips', 'Km run', 'Freight', 'Diesel', 'Toll', 'Other trip costs', 'Hire charges', 'Total cost', 'Net profit'].map((k) => [k, sum(rows, k)])),
      vehicleSummary: truckTotals,
      notes: [...(by === 'week' ? ['Weeks run Monday to Sunday; the first and last week are cut at the period dates.'] : []), `Trips, km and hire charges fall in the ${by} the trip started; freight in the ${by} of the LR; costs in the ${by} they were incurred.`, 'Costs entered without a truck are not in this report.'],
    }
  })

  // ── Fuel register ───────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/fuel-register', async (req): Promise<Report> => {
    const qy = period.merge(previewQ).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    const FILLS_FROM = `FROM ${tbl(s, 'transport_expenses')} e LEFT JOIN ${tbl(s, 'transport_trips')} t ON t.id = e."tripId" LEFT JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = e."vehicleId"
       WHERE e."branchId" = $1::uuid AND e.category = 'diesel' AND e."expenseDate" BETWEEN $2::date AND $3::date`
    const FILLS = `SELECT to_char(e."expenseDate", 'YYYY-MM-DD') AS date, v."regNo" AS vehicle, t."tripNo", COALESCE(NULLIF(TRIM(e."vendorName"), ''), e.location, '') AS pump,
              e.litres::float AS litres, e."ratePerLitre"::float AS rate, e.amount::float AS amount, ${paidByExpr('e')} AS payer, e."paymentMode", e.odometer, e.location ${FILLS_FROM}`
    // one row per finished trip with a start and end meter reading and some diesel — the base of the km-per-litre tables
    const TRIPS_CTE = `diesel AS (
          SELECT e."tripId" AS tid, SUM(e.litres)::float AS litres FROM ${tbl(s, 'transport_expenses')} e
          WHERE e."branchId" = $1::uuid AND e.category = 'diesel' AND e."tripId" IN (
            SELECT t.id FROM ${tbl(s, 'transport_trips')} t WHERE t."branchId" = $1::uuid AND t.status = 'completed' AND t."endDate" BETWEEN $2::date AND $3::date)   -- only the trips in this period, not every diesel entry ever
          GROUP BY e."tripId" HAVING SUM(e.litres) > 0),
        trip_fuel AS (
          SELECT t."tripNo", v."regNo" AS vehicle, to_char(t."endDate", 'YYYY-MM-DD') AS "endDate", (t."endOdometer" - t."startOdometer")::int AS km, diesel.litres
          FROM ${tbl(s, 'transport_trips')} t JOIN diesel ON diesel.tid = t.id JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = t."vehicleId"
          WHERE t."branchId" = $1::uuid AND t.status = 'completed' AND t."endDate" BETWEEN $2::date AND $3::date
            AND t."endOdometer" IS NOT NULL AND t."startOdometer" IS NOT NULL AND t."endOdometer" > t."startOdometer")`
    const mapFill = (r: any): Row => ({
      'Date': r.date, 'Vehicle': r.vehicle ?? '', 'Trip': r.tripNo ?? '', 'Pump / place': r.pump, 'Litres': r.litres == null ? null : r2(r.litres),
      'Rate per litre': r.rate == null ? null : r2(r.rate), 'Amount': r2(r.amount), 'Paid by': PAYER_LABEL[r.payer] ?? r.payer, 'Mode': r.paymentMode, 'Odometer': r.odometer ?? null,
    })
    const mapMileage = (t: any): Row => ({ 'Trip': t.tripNo, 'Vehicle': t.vehicle, 'Ended on': t.endDate, 'Km run': Number(t.km), 'Diesel (litres)': r2(t.litres), 'Km per litre': r2(Number(t.km) / t.litres) })
    const columns = ['Date', 'Vehicle', 'Trip', 'Pump / place', 'Litres', 'Rate per litre', 'Amount', 'Paid by', 'Mode', 'Odometer']
    const NOTES = ['Km per litre uses completed trips that have both a start and an end meter reading and at least one diesel entry.']

    // Screen: totals and the per-truck summary from aggregate queries; only the first fills and the first trips' mileage.
    if (qy.preview) {
      const [agg, first, tripTables] = await Promise.all([
        qFast<any>(req, `SELECT COUNT(*)::int AS n, COALESCE(SUM(e.litres), 0)::float AS litres, COALESCE(SUM(e.amount), 0)::float AS amount ${FILLS_FROM}`, req.branchId, from, to),
        qFast<any>(req, `${FILLS} ORDER BY e."expenseDate", e."createdAt" LIMIT ${qy.preview}`, req.branchId, from, to),
        // the trip mileage is worked out once; one answer carries both tables ('v' = a truck's summary, 'm' = one of the first trips)
        qFast<any>(req, `WITH ${TRIPS_CTE},
            v AS (SELECT vehicle, COUNT(*)::int AS trips, SUM(km)::float AS km, SUM(litres)::float AS litres FROM trip_fuel WHERE litres > 0 GROUP BY vehicle),
            m AS (SELECT * FROM trip_fuel WHERE litres > 0 ORDER BY "endDate" LIMIT ${qy.preview})
          SELECT 'v' AS k, vehicle, trips, km, litres, NULL::text AS "tripNo", NULL::text AS "endDate" FROM v
          UNION ALL SELECT 'm', vehicle, NULL, km::float, litres, "tripNo", "endDate" FROM m`, req.branchId, from, to),
      ])
      const perTruck = tripTables.filter((r: any) => r.k === 'v').sort((x: any, y: any) => String(x.vehicle).localeCompare(String(y.vehicle)))
      const mileageRows = tripTables.filter((r: any) => r.k === 'm').sort((x: any, y: any) => (x.endDate < y.endDate ? -1 : x.endDate > y.endDate ? 1 : 0))
      const a = agg[0]
      return {
        title: 'Fuel register', from, to, firm: await firmOf(req), columns, rows: first.map(mapFill),
        ...(a.n > first.length ? { totalRows: a.n, truncated: true } : {}),
        totals: { 'Litres': r2(a.litres), 'Amount': r2(a.amount) },
        mileage: mileageRows.map(mapMileage),
        vehicleSummary: perTruck.map((v: any): Row => ({ 'Vehicle': v.vehicle, 'Trips': v.trips, 'Km run': r2(v.km), 'Diesel (litres)': r2(v.litres), 'Km per litre': r2(v.km / v.litres) })),
        notes: NOTES,
      }
    }

    const fills = await qFast<any>(req, `${FILLS} ORDER BY e."expenseDate", e."createdAt"`, req.branchId, from, to)
    const trips = await qFast<any>(req, `WITH ${TRIPS_CTE} SELECT * FROM trip_fuel ORDER BY "endDate"`, req.branchId, from, to)
    const out: Row[] = fills.map(mapFill)
    const mileage: Row[] = trips.filter((t: any) => t.litres > 0).map(mapMileage)
    const byVehicle = new Map<string, { km: number; litres: number; trips: number }>()
    for (const m of mileage) { const v = byVehicle.get(String(m['Vehicle'])) ?? { km: 0, litres: 0, trips: 0 }; v.km += Number(m['Km run']); v.litres += Number(m['Diesel (litres)']); v.trips++; byVehicle.set(String(m['Vehicle']), v) }
    const vehicleSummary: Row[] = [...byVehicle.entries()].map(([vehicle, v]) => ({ 'Vehicle': vehicle, 'Trips': v.trips, 'Km run': r2(v.km), 'Diesel (litres)': r2(v.litres), 'Km per litre': r2(v.km / v.litres) })).sort((a, b) => String(a['Vehicle']).localeCompare(String(b['Vehicle'])))
    return {
      title: 'Fuel register', from, to, firm: await firmOf(req), columns, rows: out,
      totals: { 'Litres': sum(out, 'Litres'), 'Amount': sum(out, 'Amount') }, mileage, vehicleSummary,
      notes: NOTES,
    }
  })

  // ── TDS register (Sec 194C) ─────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/tds-register', async (req): Promise<Report> => {
    const qy = period.merge(scopeQ).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    const sc = await scopeBranches(req, qy.scope)
    const rows = await q<any>(req,
      `SELECT to_char(i.date, 'YYYY-MM-DD') AS date, i.number, b.name AS firm, p.name AS party, p.pan, p.gstin, i."taxableAmt"::float AS taxable, i."domainData" AS dd,
              ${tdsRecordedSql(s)} AS recorded,
              (SELECT to_char(MIN(pm."paymentDate"), 'YYYY-MM-DD') FROM ${tbl(s, 'payment_allocations')} al JOIN ${tbl(s, 'payments')} pm ON pm.id = al."paymentId"
               WHERE al."invoiceId" = i.id AND pm.method = 'tds' AND pm.status = 'active') AS "recordedOn"
       FROM ${tbl(s, 'invoices')} i LEFT JOIN ${tbl(s, 'parties')} p ON p.id = i."partyId" LEFT JOIN ${tbl(s, 'branches')} b ON b.id = i."branchId"
       WHERE i."branchId" = ANY($1::uuid[]) AND i."txnType" = 'sale_invoice' AND i.status NOT IN ('draft', 'cancelled') AND i.date BETWEEN $2::date AND $3::date
         AND COALESCE((i."domainData"->>'tds_amount')::numeric, 0) > 0
       ORDER BY i.date, i.number`, sc.ids, from, to)
    const out: Row[] = rows.map((r: any) => {
      const expected = r2(Number(r.dd?.tds_amount ?? 0)), recorded = r2(r.recorded)
      return {
        'Quarter': fyQuarter(r.recordedOn ?? r.date), ...(sc.together ? { 'Firm': r.firm ?? '' } : {}), 'Customer': r.party ?? '', 'PAN': r.pan ?? '', 'GSTIN': r.gstin ?? '', 'Invoice no': r.number, 'Invoice date': r.date,
        'Taxable value': r2(r.taxable), 'TDS rate %': Number(r.dd?.tds_rate_pct ?? 0), 'TDS deducted by customer': expected, 'TDS recorded': recorded,
        'Pending to record': r2(Math.max(0, expected - recorded)), 'Recorded on': r.recordedOn ?? '',
      }
    })
    const groups = new Map<string, { customer: string; pan: string; quarter: string; expected: number; recorded: number; bills: number }>()
    for (const r of out) {
      const key = `${r['Quarter']}|${r['Customer']}|${r['PAN']}`
      const g = groups.get(key) ?? { customer: String(r['Customer']), pan: String(r['PAN']), quarter: String(r['Quarter']), expected: 0, recorded: 0, bills: 0 }
      g.expected += Number(r['TDS deducted by customer']); g.recorded += Number(r['TDS recorded']); g.bills++; groups.set(key, g)
    }
    const summary: Row[] = [...groups.values()].sort((a, b) => a.quarter.localeCompare(b.quarter) || a.customer.localeCompare(b.customer))
      .map((g) => ({ 'Quarter': g.quarter, 'Customer': g.customer, 'PAN': g.pan, 'Bills': g.bills, 'TDS deducted by customer': r2(g.expected), 'TDS recorded': r2(g.recorded), 'Pending to record': r2(Math.max(0, g.expected - g.recorded)) }))
    return {
      title: sc.together ? 'TDS register (Sec 194C) — all names under one PAN' : 'TDS register (Sec 194C)', from, to, firm: sc.together ? { name: sc.names.join(' + '), gstin: (await firmOf(req)).gstin } : await firmOf(req),
      columns: ['Quarter', ...(sc.together ? ['Firm'] : []), 'Customer', 'PAN', 'GSTIN', 'Invoice no', 'Invoice date', 'Taxable value', 'TDS rate %', 'TDS deducted by customer', 'TDS recorded', 'Pending to record', 'Recorded on'], rows: out,
      totals: { 'TDS deducted by customer': sum(out, 'TDS deducted by customer'), 'TDS recorded': sum(out, 'TDS recorded'), 'Pending to record': sum(out, 'Pending to record') },
      summary,
      notes: ['The quarter is the one in which the TDS was recorded (the customer’s payment), or the bill date while it is still pending — match it with Form 26AS.', '“Pending to record” is TDS the bill says the customer would deduct that has not been recorded against a payment yet.'],
    }
  })

  // ── GSTR-3B summary ─────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/gstr3b', async (req): Promise<Report> => {
    const qy = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).merge(period).merge(scopeQ).parse(req.query)
    const sc = await scopeBranches(req, qy.scope)
    let from: string, to: string
    if (qy.month) { from = `${qy.month}-01`; to = new Date(Date.UTC(Number(qy.month.slice(0, 4)), Number(qy.month.slice(5, 7)), 0)).toISOString().slice(0, 10) }
    else ({ from, to } = range(qy))
    const s = S(req)
    const inv = await q<any>(req,
      `SELECT i."branchId", i."txnType", i."taxableAmt"::float AS taxable, i."cgstTotal"::float AS cgst, i."sgstTotal"::float AS sgst, i."igstTotal"::float AS igst, i."domainData" AS dd
       FROM ${tbl(s, 'invoices')} i
       WHERE i."branchId" = ANY($1::uuid[]) AND i.status NOT IN ('draft', 'cancelled') AND i."txnType" IN ('sale_invoice', 'credit_note', 'purchase_invoice', 'debit_note')
         AND (i."txnType" <> 'debit_note' OR i."domainData"->>'bill_kind' = 'debit_note')
         AND i.date BETWEEN $2::date AND $3::date`, sc.ids, from, to)
    const office = await q1<any>(req,
      `SELECT COALESCE(SUM("gstAmount"), 0)::float AS gst FROM ${tbl(s, 'expenses')} WHERE "branchId" = ANY($1::uuid[]) AND date BETWEEN $2::date AND $3::date AND "gstAmount" > 0`, sc.ids, from, to)

    const acc = () => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 })
    const taxable = acc(), nil = acc(), rcm = acc(), credit = acc(), purchase = acc()
    const add = (a: ReturnType<typeof acc>, r: any) => { a.count++; a.taxable += r.taxable; a.igst += r.igst; a.cgst += r.cgst; a.sgst += r.sgst }
    for (const r of inv) {
      const tax = r.cgst + r.sgst + r.igst
      if (r.txnType === 'credit_note') add(credit, r)
      else if (r.txnType === 'purchase_invoice') add(purchase, r)
      else if (r.dd?.gst_mode === 'rcm' && tax === 0 && r.dd?.bill_kind !== 'goods_sale') add(rcm, r)
      else if (tax > 0) add(taxable, r)
      else add(nil, r)
    }
    const row = (section: string, description: string, a: ReturnType<typeof acc>): Row => ({
      'Section': section, 'Description': description, 'Invoices': a.count, 'Taxable value': r2(a.taxable), 'IGST': r2(a.igst), 'CGST': r2(a.cgst), 'SGST': r2(a.sgst), 'Total tax': r2(a.igst + a.cgst + a.sgst),
    })
    const outwardTax = r2(taxable.igst + taxable.cgst + taxable.sgst - (credit.igst + credit.cgst + credit.sgst))
    const itcPurchases = r2(purchase.igst + purchase.cgst + purchase.sgst)
    const officeGst = r2(office?.gst ?? 0)
    const rows: Row[] = [
      row('3.1(a)', 'Outward taxable supplies (freight on forward charge, goods)', taxable),
      row('3.1(c)', 'Nil-rated / exempt outward supplies', nil),
      row('Info', 'Freight billed with GST payable by the recipient (RCM) — no tax charged by you', rcm),
      row('Less', 'Credit notes issued (reduce outward tax)', credit),
      row('4(A)', 'Input tax credit on purchase invoices', purchase),
      { 'Section': 'Info', 'Description': 'GST paid on office costs (check each one is eligible for credit)', 'Invoices': null, 'Taxable value': null, 'IGST': null, 'CGST': null, 'SGST': null, 'Total tax': officeGst },
    ]
    // one line per trade name, so the CA can see where the combined figures come from
    const byFirm: Row[] = sc.together ? sc.ids.map((id, k) => {
      const mine = inv.filter((r: any) => r.branchId === id)
      const sum2 = (pred: (r: any) => boolean, f: (r: any) => number) => r2(mine.filter(pred).reduce((t: number, r: any) => t + f(r), 0))
      const sale = (r: any) => r.txnType !== 'credit_note' && r.txnType !== 'purchase_invoice'
      const tx = (r: any) => r.cgst + r.sgst + r.igst
      return {
        'Firm': sc.names[k] ?? '', 'Outward bills': mine.filter(sale).length, 'Taxable value (net of credit notes)': r2(sum2(sale, (r) => r.taxable) - sum2((r) => r.txnType === 'credit_note', (r) => r.taxable)),
        'Outward tax (net of credit notes)': r2(sum2(sale, tx) - sum2((r) => r.txnType === 'credit_note', tx)), 'Input credit — purchases': sum2((r) => r.txnType === 'purchase_invoice', tx),
      }
    }) : []
    return {
      title: sc.together ? 'GSTR-3B summary — all names under this GSTIN' : 'GSTR-3B summary', from, to,
      firm: sc.together ? { name: sc.names.join(' + '), gstin: (await firmOf(req)).gstin } : await firmOf(req),
      ...(sc.together ? { summary: byFirm } : {}),
      columns: ['Section', 'Description', 'Invoices', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Total tax'], rows,
      totals: { 'Outward tax (after credit notes)': outwardTax, 'Input credit — purchase invoices': itcPurchases, 'GST on office costs (to check)': officeGst, 'Indicative tax payable': r2(outwardTax - itcPurchases) },
      notes: [
        'Indicative figures from this app — not a return. Your CA decides the final treatment and files GSTR-3B.',
        'Where you issue a bill with GST payable by the recipient (RCM), show it as your CA advises (it also appears in GSTR-1).',
        'Fuel carries no input credit, and trip costs in this app are recorded without GST.',
      ],
    }
  })

  // ── Pump ledger ─────────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/pump-ledger', async (req): Promise<Report> => {
    const { from, to } = range(period.parse(req.query))
    const s = S(req)
    const rows = await qFast<any>(req,
      `SELECT COALESCE(NULLIF(TRIM(e."vendorName"), ''), 'Unknown') AS vendor, to_char(e."expenseDate", 'YYYY-MM-DD') AS date, e.amount::float AS amount, e.litres::float AS litres,
              to_char(e."settledOn", 'YYYY-MM-DD') AS settled, e."settledMode", e."expenseDate" AS d, t."tripNo", v."regNo" AS vehicle
       FROM ${tbl(s, 'transport_expenses')} e LEFT JOIN ${tbl(s, 'transport_trips')} t ON t.id = e."tripId" LEFT JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = e."vehicleId"
       WHERE e."branchId" = $1::uuid AND ${paidByExpr('e')} = 'vendor_credit' AND e."expenseDate" <= $3::date
       ORDER BY vendor, e."expenseDate", e."createdAt"`, req.branchId, from, to)
    const inRange = (d: string) => d >= from && d <= to
    const billed = rows.filter((r: any) => inRange(r.date))
    const out: Row[] = billed.map((r: any) => ({
      'Pump': r.vendor, 'Bill date': r.date, 'Trip': r.tripNo ?? '', 'Vehicle': r.vehicle ?? '', 'Litres': r.litres == null ? null : r2(r.litres),
      'Amount': r2(r.amount), 'Status': r.settled && r.settled <= to ? 'Paid' : 'Unpaid', 'Paid on': r.settled && r.settled <= to ? r.settled : '', 'Paid by': r.settled && r.settled <= to ? (r.settledMode ?? '') : '',
    }))
    const per = new Map<string, { opening: number; billed: number; paid: number }>()
    for (const r of rows) {
      const g = per.get(r.vendor) ?? { opening: 0, billed: 0, paid: 0 }
      const unpaidAtStart = r.date < from && (!r.settled || r.settled >= from)
      if (unpaidAtStart) g.opening += r.amount
      if (inRange(r.date)) g.billed += r.amount
      if (r.settled && inRange(r.settled)) g.paid += r.amount
      per.set(r.vendor, g)
    }
    const summary: Row[] = [...per.entries()].map(([pump, g]) => ({
      'Pump': pump, 'Owed at start': r2(g.opening), 'Billed in period': r2(g.billed), 'Paid in period': r2(g.paid), 'Owed at end': r2(g.opening + g.billed - g.paid),
    })).sort((a, b) => Number(b['Owed at end']) - Number(a['Owed at end']))
    return {
      title: 'Pump ledger', from, to, firm: await firmOf(req),
      columns: ['Pump', 'Bill date', 'Trip', 'Vehicle', 'Litres', 'Amount', 'Status', 'Paid on', 'Paid by'], rows: out,
      totals: { 'Billed in period': sum(summary, 'Billed in period'), 'Paid in period': sum(summary, 'Paid in period'), 'Owed at end': sum(summary, 'Owed at end') }, summary,
      notes: ['Lists diesel taken on account. “Owed at end” counts bills up to the end date that had not been paid by then.'],
    }
  })

  // ── Outstanding receivables ─────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/outstanding', async (req): Promise<Report> => {
    const qy = z.object({ asOn: dateStr.optional() }).merge(previewQ).parse(req.query)
    const on = qy.asOn ?? todayStr()
    const s = S(req)
    const FROM = `FROM ${tbl(s, 'invoices')} i JOIN ${tbl(s, 'parties')} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND (i."txnType" = 'sale_invoice' OR (i."txnType" = 'debit_note' AND i."domainData"->>'bill_kind' = 'debit_note'))
         AND i.status IN ('confirmed', 'partial') AND i."grandTotal" > i."paidAmt" AND i.date <= $2::date`
    const bucket = (d: number) => (d <= 0 ? 'Not due' : d <= 30 ? '1–30 days' : d <= 60 ? '31–60 days' : d <= 90 ? '61–90 days' : 'Over 90 days')
    const buckets = ['Not due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days']
    const columns = ['Customer', 'GSTIN', 'Invoice no', 'Invoice date', 'Due date', 'Invoice total', 'Received', 'Outstanding', 'Days overdue', 'Age']
    const NOTES = [`As on ${on}. Age counts from the due date (bill date + 30 days when no credit period was set).`]
    const OVERDUE = `($2::date - COALESCE(i."dueDate", i.date + 30))`
    const ROWS = `SELECT p.name AS party, p.gstin, i.number, to_char(i.date, 'YYYY-MM-DD') AS date, to_char(COALESCE(i."dueDate", i.date + 30), 'YYYY-MM-DD') AS due,
              i."grandTotal"::float AS total, i."paidAmt"::float AS paid, (i."grandTotal" - i."paidAmt")::float AS outstanding, ${OVERDUE}::int AS overdue ${FROM}`
    const mapRow = (r: any): Row => ({
      'Customer': r.party, 'GSTIN': r.gstin ?? '', 'Invoice no': r.number, 'Invoice date': r.date, 'Due date': r.due, 'Invoice total': r2(r.total), 'Received': r2(r.paid),
      'Outstanding': r2(r.outstanding), 'Days overdue': Math.max(0, r.overdue), 'Age': bucket(r.overdue),
    })

    // Screen: each customer's ageing worked out in the database (one row per customer), plus only the first bills.
    if (qy.preview) {
      const [perCustomer, first, count] = await Promise.all([
        qFast<any>(req, `SELECT p.name AS party, COUNT(*)::int AS bills,
            COALESCE(SUM(i."grandTotal" - i."paidAmt") FILTER (WHERE ${OVERDUE} <= 0), 0)::float AS b0,
            COALESCE(SUM(i."grandTotal" - i."paidAmt") FILTER (WHERE ${OVERDUE} BETWEEN 1 AND 30), 0)::float AS b1,
            COALESCE(SUM(i."grandTotal" - i."paidAmt") FILTER (WHERE ${OVERDUE} BETWEEN 31 AND 60), 0)::float AS b2,
            COALESCE(SUM(i."grandTotal" - i."paidAmt") FILTER (WHERE ${OVERDUE} BETWEEN 61 AND 90), 0)::float AS b3,
            COALESCE(SUM(i."grandTotal" - i."paidAmt") FILTER (WHERE ${OVERDUE} > 90), 0)::float AS b4,
            SUM(i."grandTotal" - i."paidAmt")::float AS total
          ${FROM} GROUP BY p.name ORDER BY total DESC`, req.branchId, on),
        qFast<any>(req, `${ROWS} ORDER BY p.name, i.date LIMIT ${qy.preview}`, req.branchId, on),
        Promise.resolve(null),
      ])
      void count
      const summary: Row[] = perCustomer.map((c: any) => ({
        'Customer': c.party, 'Bills': c.bills, 'Not due': r2(c.b0), '1–30 days': r2(c.b1), '31–60 days': r2(c.b2), '61–90 days': r2(c.b3), 'Over 90 days': r2(c.b4), 'Total outstanding': r2(c.total),
      }))
      const bills = perCustomer.reduce((t: number, c: any) => t + c.bills, 0)
      return {
        title: 'Outstanding receivables', from: on, to: on, firm: await firmOf(req), columns, rows: first.map(mapRow),
        ...(bills > first.length ? { totalRows: bills, truncated: true } : {}),
        totals: {
          'Total outstanding': r2(perCustomer.reduce((t: number, c: any) => t + c.total, 0)),
          'Not due': r2(perCustomer.reduce((t: number, c: any) => t + c.b0, 0)), '1–30 days': r2(perCustomer.reduce((t: number, c: any) => t + c.b1, 0)),
          '31–60 days': r2(perCustomer.reduce((t: number, c: any) => t + c.b2, 0)), '61–90 days': r2(perCustomer.reduce((t: number, c: any) => t + c.b3, 0)),
          'Over 90 days': r2(perCustomer.reduce((t: number, c: any) => t + c.b4, 0)),
        },
        summary, notes: NOTES,
      }
    }

    const rows = await qFast<any>(req, `${ROWS} ORDER BY p.name, i.date`, req.branchId, on)
    const out: Row[] = rows.map(mapRow)
    const byCustomer = new Map<string, { bills: number; by: Record<string, number>; total: number }>()
    for (const r of out) {
      const g = byCustomer.get(String(r['Customer'])) ?? { bills: 0, by: Object.fromEntries(buckets.map((b) => [b, 0])), total: 0 }
      g.bills++; g.by[String(r['Age'])] = (g.by[String(r['Age'])] ?? 0) + Number(r['Outstanding']); g.total += Number(r['Outstanding'])
      byCustomer.set(String(r['Customer']), g)
    }
    const summary: Row[] = [...byCustomer.entries()].map(([c, g]) => ({ 'Customer': c, 'Bills': g.bills, ...Object.fromEntries(buckets.map((b) => [b, r2(g.by[b] ?? 0)])), 'Total outstanding': r2(g.total) }))
      .sort((a, b) => Number(b['Total outstanding']) - Number(a['Total outstanding']))
    return {
      title: 'Outstanding receivables', from: on, to: on, firm: await firmOf(req), columns, rows: out,
      totals: { 'Total outstanding': sum(out, 'Outstanding'), ...Object.fromEntries(buckets.map((b) => [b, sum(out, 'Outstanding', (r) => r['Age'] === b)])) }, summary,
      notes: NOTES,
    }
  })

  // ── Bank book ───────────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/bank-book', async (req): Promise<Report> => {
    const qy = period.merge(previewQ).extend({ bankAccountId: z.string().uuid().optional() }).parse(req.query)
    const { from, to } = range(qy)
    const s = S(req)
    const params: unknown[] = [req.branchId, from, to]
    let where = `l."branchId" = $1::uuid AND l."txnDate" BETWEEN $2::date AND $3::date`
    if (qy.bankAccountId) { params.push(qy.bankAccountId); where += ` AND l."bankAccountId" = $4::uuid` }
    // only what the register shows (and what naming a match needs) — not every column of every line
    const COLS = `l.id, to_char(l."txnDate", 'YYYY-MM-DD') AS date, l.description, l."refNo", l.debit::float AS debit, l.credit::float AS credit, l.balance::float AS balance,
                  l.status, l."matchKind", l.label, l."paymentIds", l."tripExpenseIds", l."coreExpenseId", ba.name AS bank`
    const FROM = `FROM ${tbl(s, 'transport_bank_lines')} l JOIN ${tbl(s, 'bank_accounts')} ba ON ba.id = l."bankAccountId" WHERE ${where}`
    const COLUMNS = ['Date', 'Bank', 'Narration', 'Reference', 'Money out', 'Money in', 'Balance', 'Matched to', 'Status']
    const NOTES = ['Built from imported bank statements. Lines marked “Not matched” still need to be classified.']
    const toRow = (l: any, desc: Map<string, string>): Row => ({
      'Date': l.date, 'Bank': l.bank, 'Narration': l.description, 'Reference': l.refNo ?? '', 'Money out': l.debit, 'Money in': l.credit, 'Balance': l.balance,
      'Matched to': desc.get(l.id) ?? '', 'Status': l.status === 'matched' ? 'Matched' : l.status === 'ignored' ? 'Ignored' : 'Not matched',
    })

    // Screen: totals from one aggregate query, and only the first lines.
    if (qy.preview) {
      const [agg, first] = await Promise.all([
        qFast<any>(req, `SELECT COUNT(*)::int AS n, COALESCE(SUM(l.credit), 0)::float AS money_in, COALESCE(SUM(l.debit), 0)::float AS money_out,
                           (COUNT(*) FILTER (WHERE l.status NOT IN ('matched', 'ignored')))::int AS not_matched
                         FROM ${tbl(s, 'transport_bank_lines')} l WHERE ${where}`, ...params),
        qFast<any>(req, `SELECT ${COLS} ${FROM} ORDER BY ba.name, l."txnDate", l.seq LIMIT ${qy.preview}`, ...params),
      ])
      const desc = await describeMatches(req, first)
      return {
        title: 'Bank book', from, to, firm: await firmOf(req), columns: COLUMNS, rows: first.map((l: any) => toRow(l, desc)),
        ...(agg[0].n > first.length ? { totalRows: agg[0].n, truncated: true } : {}),
        totals: { 'Money in': r2(agg[0].money_in), 'Money out': r2(agg[0].money_out), 'Lines not matched': agg[0].not_matched },
        notes: NOTES,
      }
    }

    // All lines (Excel / CA pack). Read in index order; the few banks are put in name order here, which keeps date and sequence within each bank.
    const lines = await qFast<any>(req, `SELECT ${COLS} ${FROM} ORDER BY l."bankAccountId", l."txnDate", l.seq`, ...params)
    lines.sort((a, b) => (a.bank < b.bank ? -1 : a.bank > b.bank ? 1 : 0))
    const desc = await describeMatches(req, lines)
    const out: Row[] = lines.map((l: any) => toRow(l, desc))
    return {
      title: 'Bank book', from, to, firm: await firmOf(req),
      columns: COLUMNS, rows: out,
      totals: { 'Money in': sum(out, 'Money in'), 'Money out': sum(out, 'Money out'), 'Lines not matched': out.filter((r) => r['Status'] === 'Not matched').length },
      notes: NOTES,
    }
  })

  // ── Combined (owner) ────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/ca/combined', async (req): Promise<Report> => {
    if (req.role !== 'owner') throw httpError(403, 'Only the owner can see the firms combined')
    const { from, to } = range(period.parse(req.query))
    const s = S(req)
    const firms = await q<any>(req, `SELECT id, name, gstin FROM ${tbl(s, 'branches')} WHERE "isActive" = true ORDER BY "createdAt"`)
    const out: Row[] = []
    for (const f of firms) {
      const sales = await q1<any>(req,
        `SELECT COALESCE(SUM(CASE WHEN "txnType" = 'credit_note' THEN -"taxableAmt" ELSE "taxableAmt" END), 0)::float AS taxable,
                COALESCE(SUM(CASE WHEN "txnType" = 'credit_note' THEN -("cgstTotal" + "sgstTotal" + "igstTotal") ELSE "cgstTotal" + "sgstTotal" + "igstTotal" END), 0)::float AS gst,
                (COUNT(*) FILTER (WHERE "txnType" = 'sale_invoice'))::int AS bills,
                COALESCE(SUM(COALESCE(NULLIF("domainData"->>'tds_amount', '')::numeric, 0)), 0)::float AS tds
         FROM ${tbl(s, 'invoices')} WHERE "branchId" = $1::uuid AND ("txnType" = 'sale_invoice' OR "domainData"->>'bill_kind' IN ('credit_note', 'debit_note'))
           AND "txnType" IN ('sale_invoice', 'credit_note', 'debit_note') AND status NOT IN ('draft', 'cancelled') AND date BETWEEN $2::date AND $3::date`, f.id, from, to)
      const recv = await q1<any>(req,
        `SELECT COALESCE(SUM(amount), 0)::float AS amount FROM ${tbl(s, 'payments')}
         WHERE "branchId" = $1::uuid AND status = 'active' AND type IN ('receipt', 'advance') AND method NOT IN ('tds', 'credit') AND "paymentDate" BETWEEN $2::date AND $3::date`, f.id, from, to)
      const trip = await q1<any>(req, `SELECT COALESCE(SUM(amount), 0)::float AS amount FROM ${tbl(s, 'transport_expenses')} WHERE "branchId" = $1::uuid AND "expenseDate" BETWEEN $2::date AND $3::date`, f.id, from, to)
      const hire = await q1<any>(req, `SELECT COALESCE(SUM("hireCharges"), 0)::float AS amount FROM ${tbl(s, 'transport_trips')} WHERE "branchId" = $1::uuid AND status <> 'cancelled' AND "startDate" BETWEEN $2::date AND $3::date`, f.id, from, to)
      const office = await q1<any>(req, `SELECT COALESCE(SUM(amount), 0)::float AS amount FROM ${tbl(s, 'expenses')} WHERE "branchId" = $1::uuid AND date BETWEEN $2::date AND $3::date`, f.id, from, to)
      const owed = await q1<any>(req,
        `SELECT COALESCE(SUM("grandTotal" - "paidAmt"), 0)::float AS amount FROM ${tbl(s, 'invoices')}
         WHERE "branchId" = $1::uuid AND ("txnType" = 'sale_invoice' OR ("txnType" = 'debit_note' AND "domainData"->>'bill_kind' = 'debit_note'))
           AND status IN ('confirmed', 'partial') AND "grandTotal" > "paidAmt"`, f.id)
      const pumps = await q1<any>(req,
        `SELECT COALESCE(SUM(e.amount), 0)::float AS amount FROM ${tbl(s, 'transport_expenses')} e WHERE e."branchId" = $1::uuid AND ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL`, f.id)
      const unmatched = await q1<any>(req, `SELECT COUNT(*)::int AS n FROM ${tbl(s, 'transport_bank_lines')} WHERE "branchId" = $1::uuid AND status = 'unmatched'`, f.id)
      const costs = r2(trip.amount + hire.amount + office.amount)
      out.push({
        'Firm': f.name, 'GSTIN': f.gstin ?? '', 'Bills': sales.bills, 'Sales (taxable)': r2(sales.taxable), 'GST on sales': r2(sales.gst), 'TDS deducted by customers': r2(sales.tds),
        'Received in period': r2(recv.amount), 'Trip costs': r2(trip.amount), 'Truck hire': r2(hire.amount), 'Office costs': r2(office.amount),
        'Profit (sales − costs)': r2(sales.taxable - costs), 'Customers owe now': r2(owed.amount), 'Owed to pumps now': r2(pumps.amount), 'Bank lines to match': unmatched.n,
      })
    }
    const keys = ['Bills', 'Sales (taxable)', 'GST on sales', 'TDS deducted by customers', 'Received in period', 'Trip costs', 'Truck hire', 'Office costs', 'Profit (sales − costs)', 'Customers owe now', 'Owed to pumps now', 'Bank lines to match']
    const total: Row = { 'Firm': 'All firms together', 'GSTIN': '', ...Object.fromEntries(keys.map((k) => [k, sum(out, k)])) }
    return {
      title: 'All firms together', from, to, firm: await firmOf(req),
      columns: ['Firm', 'GSTIN', ...keys], rows: [...out, total], totals: Object.fromEntries(keys.map((k) => [k, Number(total[k])])),
      notes: ['Profit here is bill value (before GST) minus trip costs, truck hire and office costs — before driver salaries, EMIs and depreciation.', 'Each firm still files its own GST; these are only side-by-side totals for the owner.'],
    }
  })
}
