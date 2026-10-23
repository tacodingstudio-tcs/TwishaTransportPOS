// apps/api/src/routes/transport-bank.ts
// Bank statements: import a statement, match every line to what it is, reconcile books against the bank.
// Registered under /api/transport. Everything is scoped to the firm (branch) being worked in.
//
//   GET    /bank/accounts                      the firm's bank accounts, with counts of what still needs matching
//   POST   /bank/accounts                      add an account                                   (owner / manager)
//   PATCH  /bank/accounts/:id                  rename / opening balance                         (owner / manager)
//   POST   /bank/accounts/:id/import           save statement rows (the browser reads the file) — duplicates skipped
//   GET    /bank/accounts/:id/imports          what has been imported
//   DELETE /bank/imports/:id                   undo an import that nothing has been matched on  (owner / manager)
//   GET    /bank/accounts/:id/lines            statement lines (status / date / search filters)
//   GET    /bank/lines/:id/suggestions         what a line probably is
//   POST   /bank/lines/:id/match               receipt / link payments / pump bills / expense / label
//   POST   /bank/lines/:id/unmatch             undo (reverses anything the match created)
//   POST   /bank/lines/:id/ignore | /unignore
//   POST   /bank/accounts/:id/auto-match       match everything that is certain
//   GET    /bank/accounts/:id/reconciliation   books vs bank for a period
//
// A match either LINKS something that already exists (a receipt typed earlier, an expense) or CREATES it from the line
// (receipt against bills — with the TDS the customer cut —, pump bills settled, an office expense). `createdEntries`
// remembers which, so undoing a match reverses exactly what it made and nothing else.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { createHash } from 'crypto'
import { z } from 'zod'
import { BANK_LINE_LABELS, extractBankRef, bankMethodFromNarration, nameHits } from '@billing/shared'
import { recordPayment } from '../services/invoice.service.js'
import { createExpense, deleteExpense } from '../services/expense.service.js'
import { createPaymentTx, voidPaymentTx } from './payments.js'
import { recordTdsForBill } from './transport-billing.js'
import { BANK_SEARCH_EXPR } from '../lib/transport-ddl.js'
import { encodeCursor, decodeCursor, keysetBefore } from '../lib/keyset.js'
import { tbl, q, q1, run, insertRow, httpError, requireWrite, requireManager, r2, todayStr, addDays, paidByExpr } from '../lib/transport-helpers.js'

const idParam = z.object({ id: z.string().uuid() })
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const MAX_ACCOUNTS = 6
const MAX_IMPORT_ROWS = 5000

const AccountBody = z.object({
  name:           z.string().trim().min(1).max(80),
  bankName:       z.string().trim().max(80).optional(),
  accountNumber:  z.string().trim().regex(/^\d{6,20}$/, 'Account number is 6–20 digits').optional(),
  ifscCode:       z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like SBIN0001234').optional(),
  openingBalance: z.number().min(-1e10).max(1e10).default(0),
})

const ImportBody = z.object({
  fileName: z.string().max(200).optional(),
  rows: z.array(z.object({
    date:        dateStr,
    description: z.string().max(600),
    refNo:       z.string().max(100).default(''),
    debit:       z.number().min(0).max(1e10),
    credit:      z.number().min(0).max(1e10),
    balance:     z.number().min(-1e11).max(1e11).nullable().optional(),
  })).min(1).max(MAX_IMPORT_ROWS),
})

const LabelEnum = z.enum(BANK_LINE_LABELS)
const MatchBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('link_payments'), paymentIds: z.array(z.string().uuid()).min(1).max(30) }),
  z.object({
    kind: z.literal('receipt'), partyId: z.string().uuid(), note: z.string().max(300).optional(),
    allocations: z.array(z.object({
      invoiceId: z.string().uuid(), amount: z.number().positive().max(1e10), tds: z.number().min(0).max(1e9).optional(),
    })).max(60).default([]),
  }),
  z.object({ kind: z.literal('pump'), vendor: z.string().trim().min(1).max(100), expenseIds: z.array(z.string().uuid()).max(300).optional() }),
  z.object({ kind: z.literal('expense'), category: z.string().trim().min(1).max(60), description: z.string().max(300).optional(), gstRate: z.number().refine((v) => [0, 5, 12, 18, 28].includes(v)).default(0) }),
  z.object({ kind: z.literal('link_expense'), expenseId: z.string().uuid() }),
  z.object({ kind: z.literal('other'), label: LabelEnum, note: z.string().max(300).optional() }),
])
type Match = z.infer<typeof MatchBody>

export type Line = {
  id: string; branchId: string; bankAccountId: string; date: string; description: string; refNo: string | null
  debit: number; credit: number; balance: number | null; status: 'unmatched' | 'matched' | 'ignored'
  matchKind: string | null; label: string | null; paymentIds: string[]; tripExpenseIds: string[]; coreExpenseId: string | null
  createdEntries: boolean; notes: string | null
}

export const LINE_COLS = (a = 'l') => `
  ${a}.id, ${a}."branchId", ${a}."bankAccountId", to_char(${a}."txnDate", 'YYYY-MM-DD') AS date, ${a}.description, ${a}."refNo",
  ${a}.debit::float AS debit, ${a}.credit::float AS credit, ${a}.balance::float AS balance, ${a}.status, ${a}."matchKind", ${a}.label,
  ${a}."paymentIds", ${a}."tripExpenseIds", ${a}."coreExpenseId", ${a}."createdEntries", ${a}.notes`

const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000)

async function accountOf(req: FastifyRequest, id: string) {
  const a = await q1<any>(req,
    `SELECT id, name, "bankName", "accountNumber", "ifscCode", "openingBalance"::float AS "openingBalance"
     FROM ${tbl(req.schemaName, 'bank_accounts')} WHERE id = $1::uuid AND "branchId" = $2::uuid AND COALESCE("isActive", true)`, id, req.branchId)
  if (!a) throw httpError(404, 'Bank account not found')
  return a
}

async function lineOf(req: FastifyRequest, id: string): Promise<Line> {
  const l = await q1<Line>(req,
    `SELECT ${LINE_COLS()} FROM ${tbl(req.schemaName, 'transport_bank_lines')} l WHERE l.id = $1::uuid AND l."branchId" = $2::uuid`, id, req.branchId)
  if (!l) throw httpError(404, 'Statement line not found')
  return l
}

const maskAccount = (n: string | null) => (n ? `XXXX${String(n).slice(-4)}` : null)

/** One short sentence for the list: what a matched line turned out to be. */
export async function describeMatches(req: FastifyRequest, lines: Line[]): Promise<Map<string, string>> {
  const s = req.schemaName
  const out = new Map<string, string>()
  const payIds = [...new Set(lines.flatMap((l) => l.paymentIds ?? []))]
  const expIds = [...new Set(lines.flatMap((l) => l.tripExpenseIds ?? []))]
  const coreIds = [...new Set(lines.map((l) => l.coreExpenseId).filter(Boolean) as string[])]
  const [pays, exps, cores] = await Promise.all([
    payIds.length ? q<any>(req, `SELECT p.id, p.method, pa.name AS party FROM ${tbl(s, 'payments')} p LEFT JOIN ${tbl(s, 'parties')} pa ON pa.id = p."partyId" WHERE p.id = ANY($1::uuid[])`, payIds) : [],
    expIds.length ? q<any>(req, `SELECT id, "vendorName" FROM ${tbl(s, 'transport_expenses')} WHERE id = ANY($1::uuid[])`, expIds) : [],
    coreIds.length ? q<any>(req, `SELECT id, category FROM ${tbl(s, 'expenses')} WHERE id = ANY($1::uuid[])`, coreIds) : [],
  ])
  const pById = new Map(pays.map((p: any) => [p.id, p])), eById = new Map(exps.map((e: any) => [e.id, e])), cById = new Map(cores.map((c: any) => [c.id, c]))
  for (const l of lines) {
    if (l.status === 'ignored') { out.set(l.id, `Ignored${l.label ? ` — ${l.label}` : ''}`); continue }
    if (l.status !== 'matched') continue
    if (l.matchKind === 'receipt') {
      const parties = [...new Set((l.paymentIds ?? []).map((id) => (pById.get(id) as any)?.party).filter(Boolean))]
      out.set(l.id, `Receipt from ${parties.join(', ') || 'customer'}`)
    } else if (l.matchKind === 'pump') {
      const vendors = [...new Set((l.tripExpenseIds ?? []).map((id) => (eById.get(id) as any)?.vendorName).filter(Boolean))]
      out.set(l.id, `Paid ${vendors.join(', ') || 'pump'} (${(l.tripExpenseIds ?? []).length} bill${(l.tripExpenseIds ?? []).length === 1 ? '' : 's'})`)
    } else if (l.matchKind === 'expense') {
      out.set(l.id, `Expense — ${(cById.get(l.coreExpenseId ?? '') as any)?.category ?? 'office cost'}`)
    } else if (l.matchKind === 'other') out.set(l.id, l.label ?? 'Other')
  }
  return out
}

const matchedPaymentGuard = (s: string, a = 'p') => `
  NOT EXISTS (SELECT 1 FROM ${tbl(s, 'transport_bank_lines')} bl
              WHERE bl."branchId" = $1::uuid AND bl.status = 'matched' AND bl."paymentIds" @> ARRAY[${a}.id])`

// ── suggestions ──────────────────────────────────────────────────────────────────────────────────────────────────

interface PaymentSuggestion { paymentIds: string[]; party: string | null; amount: number; date: string; refNo: string | null; method: string; score: number; reasons: string[] }

async function paymentSuggestions(req: FastifyRequest, line: Line): Promise<PaymentSuggestion[]> {
  const s = req.schemaName
  const rows = await q<any>(req,
    `SELECT p.id, p."partyId", pa.name AS party, p.amount::float AS amount, p.method, p."refNo", to_char(p."paymentDate", 'YYYY-MM-DD') AS date
     FROM ${tbl(s, 'payments')} p LEFT JOIN ${tbl(s, 'parties')} pa ON pa.id = p."partyId"
     WHERE p."branchId" = $1::uuid AND p.status = 'active' AND p.type IN ('receipt', 'advance')
       AND p.method NOT IN ('cash', 'tds', 'credit') AND ${matchedPaymentGuard(s)}
       AND p."paymentDate" BETWEEN $2::date AND $3::date
     ORDER BY p."paymentDate" LIMIT 400`, req.branchId, addDays(line.date, -60), addDays(line.date, 14))

  // candidate groups: each payment alone, and payments that arrived together (same customer + reference, or same day)
  const groups = new Map<string, any[]>()
  const add = (key: string, p: any) => { const g = groups.get(key) ?? []; g.push(p); groups.set(key, g) }
  for (const p of rows) {
    add(`one:${p.id}`, p)
    if (p.partyId && p.refNo) add(`ref:${p.partyId}:${String(p.refNo).toLowerCase()}`, p)
    if (p.partyId) add(`day:${p.partyId}:${p.date}`, p)
  }
  const text = `${line.description} ${line.refNo ?? ''}`.toLowerCase()
  const seen = new Set<string>()
  const out: PaymentSuggestion[] = []
  for (const g of groups.values()) {
    const total = r2(g.reduce((t, p) => t + p.amount, 0))
    if (Math.abs(total - line.credit) > 0.01) continue
    const key = g.map((p) => p.id).sort().join(',')
    if (seen.has(key)) continue
    seen.add(key)
    let score = 60; const reasons = ['Same amount']
    const refHit = g.some((p) => p.refNo && String(p.refNo).length >= 5 && text.includes(String(p.refNo).toLowerCase()))
    if (refHit) { score += 30; reasons.push('Reference matches') }
    const party = g[0].party as string | null
    if (party && nameHits(party, line.description) > 0) { score += 10; reasons.push('Customer name in narration') }
    const days = Math.min(...g.map((p) => dayDiff(p.date, line.date)))
    if (days <= 3) { score += 5; reasons.push('Within 3 days') }
    out.push({ paymentIds: g.map((p) => p.id), party, amount: total, date: g[0].date, refNo: g[0].refNo, method: g[0].method, score: Math.min(100, score), reasons })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5)
}

async function customerSuggestions(req: FastifyRequest, line: Line) {
  const s = req.schemaName
  const rows = await q<any>(req,
    `SELECT pa.id, pa.name, pa.gstin, SUM(i."grandTotal" - i."paidAmt")::float AS outstanding, COUNT(*)::int AS bills
     FROM ${tbl(s, 'invoices')} i JOIN ${tbl(s, 'parties')} pa ON pa.id = i."partyId"
     WHERE i."branchId" = $1::uuid AND (i."txnType" = 'sale_invoice' OR (i."txnType" = 'debit_note' AND i."domainData"->>'bill_kind' = 'debit_note')) AND i.status IN ('confirmed', 'partial') AND i."grandTotal" > i."paidAmt"
     GROUP BY pa.id, pa.name, pa.gstin ORDER BY outstanding DESC LIMIT 200`, req.branchId)
  return rows
    .map((r: any) => ({ ...r, hits: nameHits(r.name, line.description) }))
    .filter((r: any) => r.hits > 0 || Math.abs(r.outstanding - line.credit) < 0.01)
    .sort((a: any, b: any) => b.hits - a.hits || b.outstanding - a.outstanding)
    .slice(0, 5)
}

interface PumpBill { id: string; date: string; amount: number; tripNo: string | null; vehicleNo: string | null; litres: number | null; billNo: string | null }
interface PumpGroup { vendor: string; unpaid: number; bills: PumpBill[]; pick: string[]; pickTotal: number; exact: boolean; hits: number }

async function pumpGroups(req: FastifyRequest, line: Line): Promise<PumpGroup[]> {
  const s = req.schemaName
  const rows = await q<any>(req,
    `SELECT e.id, TRIM(e."vendorName") AS vendor, e.amount::float AS amount, to_char(e."expenseDate", 'YYYY-MM-DD') AS date,
            t."tripNo", v."regNo" AS "vehicleNo", e.litres::float AS litres, e."billNo"
     FROM ${tbl(s, 'transport_expenses')} e
     LEFT JOIN ${tbl(s, 'transport_trips')} t ON t.id = e."tripId"
     LEFT JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = e."vehicleId"
     WHERE e."branchId" = $1::uuid AND ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL
     ORDER BY e."expenseDate", e."createdAt"`, req.branchId)
  const by = new Map<string, { vendor: string; bills: PumpBill[] }>()
  for (const r of rows) {
    const vendor = (r.vendor as string) || 'Unknown'
    const key = vendor.toLowerCase()
    const g = by.get(key) ?? { vendor, bills: [] }
    g.bills.push({ id: r.id, date: r.date, amount: r.amount, tripNo: r.tripNo, vehicleNo: r.vehicleNo, litres: r.litres, billNo: r.billNo })
    by.set(key, g)
  }
  const out: PumpGroup[] = []
  for (const g of by.values()) {
    let acc = 0; const pick: string[] = []
    for (const b of g.bills) { if (acc + b.amount <= line.debit + 0.01) { acc = r2(acc + b.amount); pick.push(b.id) } }
    out.push({ vendor: g.vendor, unpaid: r2(g.bills.reduce((t, b) => t + b.amount, 0)), bills: g.bills.slice(0, 80), pick, pickTotal: acc, exact: pick.length > 0 && Math.abs(acc - line.debit) <= 0.01, hits: nameHits(g.vendor, line.description) })
  }
  return out.sort((a, b) => b.hits - a.hits || Number(b.exact) - Number(a.exact) || b.unpaid - a.unpaid)
}

async function expenseSuggestions(req: FastifyRequest, line: Line) {
  const s = req.schemaName
  return q<any>(req,
    `SELECT e.id, e.category, e.description, e.amount::float AS amount, to_char(e.date, 'YYYY-MM-DD') AS date, e."paymentMode"
     FROM ${tbl(s, 'expenses')} e
     WHERE e."branchId" = $1::uuid AND e."paymentMode" IN ('bank', 'upi') AND ABS(e.amount - $2::numeric) <= 0.01
       AND e.date BETWEEN $3::date AND $4::date
       AND NOT EXISTS (SELECT 1 FROM ${tbl(s, 'transport_bank_lines')} bl WHERE bl."branchId" = $1::uuid AND bl.status = 'matched' AND bl."coreExpenseId" = e.id)
     ORDER BY e.date LIMIT 5`, req.branchId, line.debit, addDays(line.date, -10), addDays(line.date, 10))
}

// ── applying a match ─────────────────────────────────────────────────────────────────────────────────────────────

interface Applied {
  matchKind: 'receipt' | 'pump' | 'expense' | 'other'; label?: string; paymentIds?: string[]; tripExpenseIds?: string[]
  coreExpenseId?: string; createdEntries: boolean; notes?: string
}

const payCtx = (req: FastifyRequest) => ({ db: req.db, branchId: req.branchId, schemaName: req.schemaName, userId: req.userId, role: req.role }) as any

async function applyMatch(req: FastifyRequest, line: Line, m: Match): Promise<Applied> {
  const s = req.schemaName

  if (m.kind === 'link_payments') {
    if (line.credit <= 0) throw httpError(422, 'That line is money going out — a receipt cannot be linked to it')
    const rows = await q<any>(req,
      `SELECT p.id, p.amount::float AS amount, p.status, p.type, p.method FROM ${tbl(s, 'payments')} p
       WHERE p.id = ANY($2::uuid[]) AND p."branchId" = $1::uuid AND ${matchedPaymentGuard(s)}`, req.branchId, m.paymentIds)
    if (rows.length !== m.paymentIds.length) throw httpError(422, 'One of those payments was not found, or is already linked to another bank line')
    if (rows.some((p: any) => p.status !== 'active')) throw httpError(422, 'A voided payment cannot be linked')
    const total = r2(rows.reduce((t: number, p: any) => t + p.amount, 0))
    if (Math.abs(total - line.credit) > 0.01) throw httpError(422, `Those payments total ₹${total}, but the bank line is ₹${line.credit}`)
    return { matchKind: 'receipt', paymentIds: m.paymentIds, createdEntries: false }
  }

  if (m.kind === 'receipt') {
    if (line.credit <= 0) throw httpError(422, 'That line is money going out — it cannot be a receipt')
    const party = await q1<any>(req, `SELECT id, name FROM ${tbl(s, 'parties')} WHERE id = $1::uuid AND "branchId" = $2::uuid AND "isActive" = true`, m.partyId, req.branchId)
    if (!party) throw httpError(404, 'Customer not found in this firm')
    const allocated = r2(m.allocations.reduce((t, a) => t + a.amount, 0))
    if (allocated > line.credit + 0.01) throw httpError(422, `The bills add up to ₹${allocated}, more than the ₹${line.credit} received`)

    if (m.allocations.length) {
      const ids = m.allocations.map((a) => a.invoiceId)
      if (new Set(ids).size !== ids.length) throw httpError(422, 'A bill is listed twice')
      const bills = await q<any>(req,
        `SELECT id, "partyId", "txnType", status FROM ${tbl(s, 'invoices')} WHERE id = ANY($1::uuid[]) AND "branchId" = $2::uuid`, ids, req.branchId)
      if (bills.length !== ids.length || bills.some((b: any) => b.partyId !== m.partyId || b.txnType !== 'sale_invoice' || b.status === 'cancelled'))
        throw httpError(422, 'Those bills do not all belong to this customer')
    }

    const method = bankMethodFromNarration(line.description)
    const created: string[] = []
    const ctx = payCtx(req)
    try {
      for (const a of m.allocations) {
        const paid = await recordPayment({
          invoiceId: a.invoiceId, amount: a.amount, method, refNo: line.refNo || undefined, paymentDate: line.date,
          notes: `Bank statement: ${line.description.slice(0, 150)}`,
        } as any, ctx)
        created.push(paid.payment.id)
        if (a.tds && a.tds > 0) {
          const t = await recordTdsForBill(req, a.invoiceId, { amount: a.tds, paymentDate: line.date })
          created.push(t.payment.id)
        }
      }
      const rest = r2(line.credit - allocated)
      if (rest > 0.01) {
        const adv = await createPaymentTx({ db: req.db, branchId: req.branchId, userId: req.userId! }, {
          partyId: m.partyId, amount: rest, method, type: 'advance', refNo: line.refNo || undefined, paymentDate: line.date,
          notes: 'Bank receipt not yet applied to a bill',
        })
        created.push(adv.id)
      }
    } catch (err) {
      for (const id of created.reverse()) await voidPaymentTx({ db: req.db, branchId: req.branchId, userId: req.userId! }, id, 'Bank match failed — reversed').catch(() => {})
      throw err
    }
    return { matchKind: 'receipt', paymentIds: created, createdEntries: true, notes: m.note }
  }

  if (m.kind === 'pump') {
    if (line.debit <= 0) throw httpError(422, 'That line is money coming in — it cannot pay a pump')
    const groups = await pumpGroups(req, line)
    const g = groups.find((x) => x.vendor.toLowerCase() === m.vendor.trim().toLowerCase())
    if (!g) throw httpError(422, `No unpaid bills found for “${m.vendor}”`)
    let ids = m.expenseIds
    if (ids?.length) {
      const have = new Set(g.bills.map((b) => b.id))
      if (ids.some((id) => !have.has(id))) throw httpError(422, 'One of those bills is not an unpaid bill of this pump')
    } else ids = g.pick
    if (!ids.length) throw httpError(422, 'None of this pump’s unpaid bills fits inside that payment')
    const total = r2(g.bills.filter((b) => ids!.includes(b.id)).reduce((t, b) => t + b.amount, 0))
    if (total > line.debit + 0.01) throw httpError(422, `Those bills total ₹${total}, more than the ₹${line.debit} paid`)

    // atomic claim, like the Pump payables screen: only bills that are still unpaid are settled
    const done = await q<{ id: string }>(req,
      `UPDATE ${tbl(s, 'transport_expenses')} SET "settledOn" = $3::date, "settledMode" = 'bank_transfer'
       WHERE id = ANY($1::uuid[]) AND "branchId" = $2::uuid AND "settledOn" IS NULL RETURNING id`, ids, req.branchId, line.date)
    if (done.length !== ids.length) {
      if (done.length) await run(req, `UPDATE ${tbl(s, 'transport_expenses')} SET "settledOn" = NULL, "settledMode" = NULL WHERE id = ANY($1::uuid[])`, done.map((d) => d.id))
      throw httpError(409, 'Some of those bills were just paid by someone else — refresh and try again')
    }
    const rest = r2(line.debit - total)
    return { matchKind: 'pump', tripExpenseIds: ids, createdEntries: true, notes: rest > 0.01 ? `₹${rest} of this payment is not matched to any bill` : undefined }
  }

  if (m.kind === 'expense') {
    if (line.debit <= 0) throw httpError(422, 'That line is money coming in — it cannot be an expense')
    const e = await createExpense({
      date: line.date, category: m.category, description: (m.description || line.description).slice(0, 300), amount: line.debit,
      gstRate: m.gstRate as 0, paymentMode: 'bank', referenceNo: line.refNo || undefined, notes: 'From bank statement', isRecurring: false,
    }, { db: req.db, branchId: req.branchId, userId: req.userId!, branchDomainType: 'transport' } as any)
    return { matchKind: 'expense', coreExpenseId: e.id, createdEntries: true }
  }

  if (m.kind === 'link_expense') {
    if (line.debit <= 0) throw httpError(422, 'That line is money coming in — it cannot be an expense')
    const e = await q1<any>(req,
      `SELECT e.id, e.amount::float AS amount FROM ${tbl(s, 'expenses')} e
       WHERE e.id = $2::uuid AND e."branchId" = $1::uuid
         AND NOT EXISTS (SELECT 1 FROM ${tbl(s, 'transport_bank_lines')} bl WHERE bl."branchId" = $1::uuid AND bl.status = 'matched' AND bl."coreExpenseId" = e.id)`, req.branchId, m.expenseId)
    if (!e) throw httpError(422, 'That expense was not found, or is already linked to another bank line')
    if (Math.abs(e.amount - line.debit) > 0.01) throw httpError(422, `That expense is ₹${e.amount}, but the bank line is ₹${line.debit}`)
    return { matchKind: 'expense', coreExpenseId: m.expenseId, createdEntries: false }
  }

  return { matchKind: 'other', label: m.label, createdEntries: false, notes: m.note }
}

/** Claims the line (so two people cannot match it at once), applies the match, and stores the outcome. */
async function matchLine(req: FastifyRequest, lineId: string, m: Match): Promise<Line> {
  const s = req.schemaName
  const claimed = await q<Line>(req,
    `UPDATE ${tbl(s, 'transport_bank_lines')} l SET status = 'matched', "matchedAt" = NOW(), "matchedBy" = $3::uuid
     WHERE l.id = $1::uuid AND l."branchId" = $2::uuid AND l.status <> 'matched' RETURNING ${LINE_COLS()}`, lineId, req.branchId, req.userId)
  if (!claimed[0]) {
    await lineOf(req, lineId)                                  // 404 if it does not exist
    throw httpError(409, 'This line is already matched')
  }
  try {
    const a = await applyMatch(req, claimed[0], m)
    await run(req,
      `UPDATE ${tbl(s, 'transport_bank_lines')}
       SET "matchKind" = $2, label = $3, "paymentIds" = $4::uuid[], "tripExpenseIds" = $5::uuid[], "coreExpenseId" = $6::uuid,
           "createdEntries" = $7, notes = $8
       WHERE id = $1::uuid`,
      lineId, a.matchKind, a.label ?? null, a.paymentIds ?? [], a.tripExpenseIds ?? [], a.coreExpenseId ?? null, a.createdEntries, a.notes ?? null)
  } catch (err) {
    await run(req, `UPDATE ${tbl(s, 'transport_bank_lines')} SET status = 'unmatched', "matchedAt" = NULL, "matchedBy" = NULL WHERE id = $1::uuid`, lineId)
    throw err
  }
  return lineOf(req, lineId)
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const transportBankRoutes: FastifyPluginAsync = async (app) => {
  const s = (req: FastifyRequest) => req.schemaName

  // GET /api/transport/bank/accounts
  app.get('/bank/accounts', async (req) => {
    const rows = await q<any>(req,
      `SELECT a.id, a.name, a."bankName", a."accountNumber", a."ifscCode", a."openingBalance"::float AS "openingBalance",
              (SELECT COUNT(*) FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id)::int AS lines,
              (SELECT COUNT(*) FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id AND l.status = 'unmatched')::int AS unmatched,
              (SELECT COALESCE(SUM(credit), 0) FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id AND l.status = 'unmatched')::float AS "unmatchedIn",
              (SELECT COALESCE(SUM(debit), 0) FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id AND l.status = 'unmatched')::float AS "unmatchedOut",
              (SELECT to_char(MAX("txnDate"), 'YYYY-MM-DD') FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id) AS "lastDate",
              (SELECT l.balance::float FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."bankAccountId" = a.id AND l.balance IS NOT NULL
                 ORDER BY l."txnDate" DESC, l.seq DESC LIMIT 1) AS "statementBalance"
       FROM ${tbl(s(req), 'bank_accounts')} a WHERE a."branchId" = $1::uuid AND COALESCE(a."isActive", true) ORDER BY a."createdAt"`, req.branchId)
    return rows.map((a: any) => ({ ...a, accountNumber: undefined, accountMask: maskAccount(a.accountNumber) }))
  })

  // POST /api/transport/bank/accounts
  app.post('/bank/accounts', async (req, reply) => {
    requireManager(req)
    const body = AccountBody.parse(req.body)
    const n = await q1<{ n: number }>(req, `SELECT COUNT(*)::int AS n FROM ${tbl(s(req), 'bank_accounts')} WHERE "branchId" = $1::uuid AND COALESCE("isActive", true)`, req.branchId)
    if ((n?.n ?? 0) >= MAX_ACCOUNTS) throw httpError(422, `You can add at most ${MAX_ACCOUNTS} bank accounts per firm`)
    const row = await insertRow(req, 'bank_accounts', {
      branchId: req.branchId, name: body.name, bankName: body.bankName ?? null, accountNumber: body.accountNumber ?? null,
      ifscCode: body.ifscCode ?? null, openingBalance: body.openingBalance, currentBalance: body.openingBalance,
    })
    return reply.status(201).send({ ...row, accountNumber: undefined, accountMask: maskAccount(row.accountNumber) })
  })

  // PATCH /api/transport/bank/accounts/:id
  app.patch('/bank/accounts/:id', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const body = AccountBody.partial().parse(req.body)
    await accountOf(req, id)
    await run(req,
      `UPDATE ${tbl(s(req), 'bank_accounts')} SET name = COALESCE($3, name), "bankName" = COALESCE($4, "bankName"),
         "ifscCode" = COALESCE($5, "ifscCode"), "openingBalance" = COALESCE($6::numeric, "openingBalance")
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId, body.name ?? null, body.bankName ?? null, body.ifscCode ?? null, body.openingBalance ?? null)
    return { ok: true }
  })

  // POST /api/transport/bank/accounts/:id/import — rows come from the browser (it reads the Excel / CSV)
  app.post('/bank/accounts/:id/import', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = ImportBody.parse(req.body)
    await accountOf(req, id)

    const tomorrow = addDays(todayStr(), 1)
    const clean: Array<{ date: string; description: string; refNo: string; debit: number; credit: number; balance: number | null }> = []
    let skipped = 0
    body.rows.forEach((r, i) => {
      if (r.debit > 0 && r.credit > 0) throw httpError(422, `Line ${i + 1} has money both out and in`)
      if (r.date < '2015-01-01' || r.date > tomorrow) throw httpError(422, `Line ${i + 1} has an impossible date (${r.date})`)
      if (r.debit === 0 && r.credit === 0) { skipped++; return }
      const description = r.description.replace(/\s+/g, ' ').trim()
      clean.push({ date: r.date, description, refNo: (r.refNo || extractBankRef(description)).trim(), debit: r2(r.debit), credit: r2(r.credit), balance: r.balance == null ? null : r2(r.balance) })
    })
    if (!clean.length) throw httpError(422, 'There are no transactions in that file')
    clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))        // stable: keeps the bank's order within a day

    const fromDate = clean[0]!.date, toDate = clean[clean.length - 1]!.date
    const imp = await q1<{ id: string }>(req,
      `INSERT INTO ${tbl(s(req), 'transport_bank_imports')} ("branchId", "bankAccountId", "fileName", "fromDate", "toDate", "rowCount", "createdBy")
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6, $7::uuid) RETURNING id`, req.branchId, id, body.fileName ?? null, fromDate, toDate, clean.length, req.userId)

    // identical-looking lines inside one file are real (two same-amount UPI payments in a day): number them, so a
    // re-import of the same period matches line for line and adds nothing
    const seen = new Map<string, number>()
    const prepared = clean.map((r, i) => {
      const base = createHash('sha1').update([r.date, r.description.toLowerCase(), r.debit.toFixed(2), r.credit.toFixed(2), r.balance == null ? '' : r.balance.toFixed(2), r.refNo].join('|')).digest('hex')
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n)
      return { ...r, seq: i + 1, key: `${base}:${n}` }
    })

    let added = 0
    for (let at = 0; at < prepared.length; at += 400) {
      const chunk = prepared.slice(at, at + 400)
      const params: unknown[] = [req.branchId, id, imp!.id]
      const values = chunk.map((r) => {
        const b = params.length
        params.push(r.date, r.description, r.refNo || null, r.debit, r.credit, r.balance, r.seq, r.key)
        return `($1::uuid, $2::uuid, $3::uuid, $${b + 1}::date, $${b + 2}, $${b + 3}, $${b + 4}::numeric, $${b + 5}::numeric, $${b + 6}::numeric, $${b + 7}::int, $${b + 8})`
      })
      const got = await q<{ id: string }>(req,
        `INSERT INTO ${tbl(s(req), 'transport_bank_lines')} ("branchId", "bankAccountId", "importId", "txnDate", description, "refNo", debit, credit, balance, seq, "dedupeKey")
         VALUES ${values.join(', ')} ON CONFLICT ("branchId", "bankAccountId", "dedupeKey") DO NOTHING RETURNING id`, ...params)
      added += got.length
    }
    const duplicates = clean.length - added
    await run(req, `UPDATE ${tbl(s(req), 'transport_bank_imports')} SET "addedCount" = $2, "duplicateCount" = $3 WHERE id = $1::uuid`, imp!.id, added, duplicates)
    return reply.status(201).send({ importId: imp!.id, rows: clean.length, added, duplicates, skipped, fromDate, toDate })
  })

  // GET /api/transport/bank/accounts/:id/imports
  app.get('/bank/accounts/:id/imports', async (req) => {
    const { id } = idParam.parse(req.params)
    await accountOf(req, id)
    return q(req,
      `SELECT i.id, i."fileName", to_char(i."fromDate", 'YYYY-MM-DD') AS "fromDate", to_char(i."toDate", 'YYYY-MM-DD') AS "toDate",
              i."rowCount", i."addedCount", i."duplicateCount", i."createdAt",
              (SELECT COUNT(*)::int FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE l."importId" = i.id AND l.status <> 'unmatched') AS "touched"
       FROM ${tbl(s(req), 'transport_bank_imports')} i WHERE i."bankAccountId" = $1::uuid AND i."branchId" = $2::uuid ORDER BY i."createdAt" DESC LIMIT 50`, id, req.branchId)
  })

  // DELETE /api/transport/bank/imports/:id — only while nothing in it has been matched or ignored
  app.delete('/bank/imports/:id', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const imp = await q1(req, `SELECT id FROM ${tbl(s(req), 'transport_bank_imports')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!imp) throw httpError(404, 'Import not found')
    const touched = await q1<{ n: number }>(req, `SELECT COUNT(*)::int AS n FROM ${tbl(s(req), 'transport_bank_lines')} WHERE "importId" = $1::uuid AND status <> 'unmatched'`, id)
    if ((touched?.n ?? 0) > 0) throw httpError(409, `${touched!.n} line(s) from this file are already matched or ignored — undo those first`)
    const n = await run(req, `DELETE FROM ${tbl(s(req), 'transport_bank_lines')} WHERE "importId" = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    await run(req, `DELETE FROM ${tbl(s(req), 'transport_bank_imports')} WHERE id = $1::uuid`, id)
    return { removedLines: n }
  })

  // GET /api/transport/bank/accounts/:id/lines
  app.get('/bank/accounts/:id/lines', async (req) => {
    const { id } = idParam.parse(req.params)
    const qy = z.object({
      status: z.enum(['unmatched', 'matched', 'ignored', 'all']).default('all'),
      direction: z.enum(['in', 'out']).optional(),
      from: dateStr.optional(), to: dateStr.optional(), search: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50),
      after: z.string().max(500).optional(),                       // position-based paging: the cursor the previous page returned
    }).parse(req.query)
    await accountOf(req, id)

    const params: unknown[] = [req.branchId, id]
    let where = `l."branchId" = $1::uuid AND l."bankAccountId" = $2::uuid`
    if (qy.from) { params.push(qy.from); where += ` AND l."txnDate" >= $${params.length}::date` }
    if (qy.to)   { params.push(qy.to);   where += ` AND l."txnDate" <= $${params.length}::date` }
    if (qy.search) {
      params.push(`%${qy.search}%`)
      const n = params.length
      const text = BANK_SEARCH_EXPR.replace(/"(\w+)"/g, 'l."$1"')                                   // matches idx_tbl_search_trgm
      // an amount (digits only) can also match a line's money; plain words only touch the indexed text
      where += /^[\d.,\s]+$/.test(qy.search.trim())
        ? ` AND (${text} ILIKE $${n} OR l.credit::text LIKE $${n} OR l.debit::text LIKE $${n})`
        : ` AND ${text} ILIKE $${n}`
    }
    if (qy.direction === 'in') where += ` AND l.credit > 0`
    if (qy.direction === 'out') where += ` AND l.debit > 0`
    // The per-status counts and the total are the slow part of this list: worked out for the first page (or a page number), never for a cursor page.
    let totals: Record<string, { count: number; credit: number; debit: number }> | undefined
    if (!qy.after) {
      const counts = await q<any>(req,
        `SELECT l.status, COUNT(*)::int AS count, COALESCE(SUM(l.credit), 0)::float AS credit, COALESCE(SUM(l.debit), 0)::float AS debit
         FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE ${where} GROUP BY l.status`, ...params)
      totals = { unmatched: { count: 0, credit: 0, debit: 0 }, matched: { count: 0, credit: 0, debit: 0 }, ignored: { count: 0, credit: 0, debit: 0 } }
      for (const c of counts) totals[c.status] = { count: c.count, credit: r2(c.credit), debit: r2(c.debit) }
    }

    const rowParams = [...params]
    if (qy.status !== 'all') { rowParams.push(qy.status); where += ` AND l.status = $${rowParams.length}` }
    const countParams = [...rowParams]
    if (qy.after) where += ` AND ${keysetBefore(rowParams, ['l."txnDate"', 'l.seq', 'l.id'], ['date', 'int', 'uuid'], decodeCursor(qy.after, 3))}`
    const total = qy.after ? null : await q1<{ n: number }>(req, `SELECT COUNT(*)::int AS n FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE ${where}`, ...countParams)
    rowParams.push(qy.limit + 1, qy.after ? 0 : (qy.page - 1) * qy.limit)
    const fetched = await q<Line>(req,
      `SELECT ${LINE_COLS()}, l."txnDate"::text AS _td, l.seq AS _seq FROM ${tbl(s(req), 'transport_bank_lines')} l WHERE ${where}
       ORDER BY l."txnDate" DESC, l.seq DESC, l.id DESC LIMIT $${rowParams.length - 1} OFFSET $${rowParams.length}`, ...rowParams)
    const more = fetched.length > qy.limit
    const rows = fetched.slice(0, qy.limit)
    const last: any = rows[rows.length - 1]
    const nextCursor = more && last ? encodeCursor([last._td, last._seq ?? 0, last.id]) : null
    for (const r of rows as any[]) { delete r._td; delete r._seq }
    const desc = await describeMatches(req, rows)
    return { data: rows.map((l) => ({ ...l, matchedTo: desc.get(l.id) ?? null })), nextCursor, ...(total ? { total: total.n } : {}), page: qy.page, limit: qy.limit, ...(totals ? { totals } : {}) }
  })

  // GET /api/transport/bank/customers/:id/open-bills — a customer's unpaid bills, with TDS still to be recorded on each
  app.get('/bank/customers/:id/open-bills', async (req) => {
    const { id } = idParam.parse(req.params)
    const s2 = s(req)
    const party = await q1<any>(req, `SELECT id, name, gstin FROM ${tbl(s2, 'parties')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!party) throw httpError(404, 'Customer not found in this firm')
    const bills = await q<any>(req,
      `SELECT i.id, i.number, to_char(i.date, 'YYYY-MM-DD') AS date, i."grandTotal"::float AS total, i."paidAmt"::float AS paid,
              (i."grandTotal" - i."paidAmt")::float AS outstanding,
              COALESCE(NULLIF(i."domainData"->>'tds_amount', '')::numeric, 0)::float AS "tdsMarked",
              COALESCE((SELECT SUM(al.amount) FROM ${tbl(s2, 'payment_allocations')} al JOIN ${tbl(s2, 'payments')} pm ON pm.id = al."paymentId"
                        WHERE al."invoiceId" = i.id AND pm.method = 'tds' AND pm.status = 'active'), 0)::float AS "tdsRecorded"
       FROM ${tbl(s2, 'invoices')} i
       WHERE i."branchId" = $1::uuid AND i."partyId" = $2::uuid AND (i."txnType" = 'sale_invoice' OR (i."txnType" = 'debit_note' AND i."domainData"->>'bill_kind' = 'debit_note')) AND i.status IN ('confirmed', 'partial') AND i."grandTotal" > i."paidAmt"
       ORDER BY i.date, i.number`, req.branchId, id)
    return {
      party,
      bills: bills.map((b: any) => ({
        id: b.id, number: b.number, date: b.date, total: r2(b.total), paid: r2(b.paid), outstanding: r2(b.outstanding),
        tdsPending: r2(Math.max(0, b.tdsMarked - b.tdsRecorded)),
      })),
    }
  })

  // GET /api/transport/bank/lines/:id/suggestions
  app.get('/bank/lines/:id/suggestions', async (req) => {
    const { id } = idParam.parse(req.params)
    const line = await lineOf(req, id)
    if (line.credit > 0) {
      const [payments, customers] = await Promise.all([paymentSuggestions(req, line), customerSuggestions(req, line)])
      return { direction: 'in', line, payments, customers }
    }
    const [pumps, expenses] = await Promise.all([pumpGroups(req, line), expenseSuggestions(req, line)])
    return { direction: 'out', line, pumps, expenses }
  })

  // POST /api/transport/bank/lines/:id/match
  app.post('/bank/lines/:id/match', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = MatchBody.parse(req.body)
    const line = await matchLine(req, id, body)
    const d = await describeMatches(req, [line])
    return { ...line, matchedTo: d.get(line.id) ?? null }
  })

  // POST /api/transport/bank/lines/:id/unmatch
  app.post('/bank/lines/:id/unmatch', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const line = await lineOf(req, id)
    if (line.status === 'unmatched') return line
    if (line.status === 'matched' && line.createdEntries) requireManager(req)       // reversing a receipt / settlement / expense

    const s2 = s(req)
    if (line.status === 'matched' && line.createdEntries) {
      if (line.matchKind === 'receipt')
        for (const pid of [...line.paymentIds].reverse())
          await voidPaymentTx({ db: req.db, branchId: req.branchId, userId: req.userId! }, pid, 'Bank match undone').catch((e: any) => { if (e?.statusCode !== 409) throw e })
      if (line.matchKind === 'pump')
        await run(req, `UPDATE ${tbl(s2, 'transport_expenses')} SET "settledOn" = NULL, "settledMode" = NULL WHERE id = ANY($1::uuid[]) AND "branchId" = $2::uuid AND "settledMode" = 'bank_transfer'`, line.tripExpenseIds, req.branchId)
      if (line.matchKind === 'expense' && line.coreExpenseId)
        await deleteExpense(line.coreExpenseId, { db: req.db, branchId: req.branchId, userId: req.userId!, branchDomainType: 'transport' } as any).catch((e: any) => { if (e?.statusCode !== 404) throw e })
    }
    await run(req,
      `UPDATE ${tbl(s2, 'transport_bank_lines')} SET status = 'unmatched', "matchKind" = NULL, label = NULL, "paymentIds" = '{}', "tripExpenseIds" = '{}',
         "coreExpenseId" = NULL, "createdEntries" = false, notes = NULL, "matchedAt" = NULL, "matchedBy" = NULL WHERE id = $1::uuid`, id)
    return lineOf(req, id)
  })

  // POST /api/transport/bank/lines/:id/ignore  { reason }   |   /unignore
  app.post('/bank/lines/:id/ignore', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const { reason } = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body ?? {})
    const n = await run(req,
      `UPDATE ${tbl(s(req), 'transport_bank_lines')} SET status = 'ignored', label = $3, "matchedAt" = NOW(), "matchedBy" = $4::uuid
       WHERE id = $1::uuid AND "branchId" = $2::uuid AND status = 'unmatched'`, id, req.branchId, reason ?? null, req.userId)
    if (n === 0) { await lineOf(req, id); throw httpError(409, 'Only a line that is still unmatched can be ignored') }
    return lineOf(req, id)
  })
  app.post('/bank/lines/:id/unignore', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const n = await run(req,
      `UPDATE ${tbl(s(req), 'transport_bank_lines')} SET status = 'unmatched', label = NULL, "matchedAt" = NULL, "matchedBy" = NULL
       WHERE id = $1::uuid AND "branchId" = $2::uuid AND status = 'ignored'`, id, req.branchId)
    if (n === 0) { await lineOf(req, id); throw httpError(409, 'That line is not ignored') }
    return lineOf(req, id)
  })

  // POST /api/transport/bank/accounts/:id/auto-match — only what is certain; everything else stays for a person
  app.post('/bank/accounts/:id/auto-match', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    await accountOf(req, id)
    const lines = await q<Line>(req,
      `SELECT ${LINE_COLS()} FROM ${tbl(s(req), 'transport_bank_lines')} l
       WHERE l."branchId" = $1::uuid AND l."bankAccountId" = $2::uuid AND l.status = 'unmatched' ORDER BY l."txnDate", l.seq LIMIT 1000`, req.branchId, id)
    const out = { examined: lines.length, receipts: 0, pumps: 0, expenses: 0 }
    for (const line of lines) {
      try {
        if (line.credit > 0) {
          const sug = await paymentSuggestions(req, line)
          const best = sug[0]
          // sure: the reference matches, or it is the only payment of that amount
          if (best && (best.score >= 90 || (best.score >= 70 && sug.length === 1))) {
            await matchLine(req, line.id, { kind: 'link_payments', paymentIds: best.paymentIds }); out.receipts++
          }
        } else if (line.debit > 0) {
          const pumps = (await pumpGroups(req, line)).filter((g) => g.exact && g.hits > 0)
          if (pumps.length === 1) { await matchLine(req, line.id, { kind: 'pump', vendor: pumps[0]!.vendor, expenseIds: pumps[0]!.pick }); out.pumps++; continue }
          const exps = await expenseSuggestions(req, line)
          if (exps.length === 1) { await matchLine(req, line.id, { kind: 'link_expense', expenseId: exps[0].id }); out.expenses++ }
        }
      } catch { /* a line that cannot be matched safely is simply left for a person */ }
    }
    return out
  })

  // GET /api/transport/bank/accounts/:id/reconciliation?from&to — books vs bank
  app.get('/bank/accounts/:id/reconciliation', async (req) => {
    const { id } = idParam.parse(req.params)
    const qy = z.object({ from: dateStr.optional(), to: dateStr.optional() }).parse(req.query)
    const account = await accountOf(req, id)
    const today = todayStr()
    const from = qy.from ?? `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1)}-04-01`
    const to = qy.to ?? today
    const t = tbl(s(req), 'transport_bank_lines')

    const sums = await q1<any>(req,
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(credit), 0)::float AS credit, COALESCE(SUM(debit), 0)::float AS debit
       FROM ${t} WHERE "branchId" = $1::uuid AND "bankAccountId" = $2::uuid AND "txnDate" BETWEEN $3::date AND $4::date`, req.branchId, id, from, to)
    const byStatus = await q<any>(req,
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(credit), 0)::float AS credit, COALESCE(SUM(debit), 0)::float AS debit
       FROM ${t} WHERE "branchId" = $1::uuid AND "bankAccountId" = $2::uuid AND "txnDate" BETWEEN $3::date AND $4::date GROUP BY status`, req.branchId, id, from, to)
    const st: Record<string, { count: number; credit: number; debit: number }> = { unmatched: { count: 0, credit: 0, debit: 0 }, matched: { count: 0, credit: 0, debit: 0 }, ignored: { count: 0, credit: 0, debit: 0 } }
    for (const r of byStatus) st[r.status] = { count: r.count, credit: r2(r.credit), debit: r2(r.debit) }

    // opening = the balance the statement shows just before the period, else the account's opening balance
    const before = await q1<any>(req,
      `SELECT balance::float AS balance FROM ${t} WHERE "branchId" = $1::uuid AND "bankAccountId" = $2::uuid AND "txnDate" < $3::date AND balance IS NOT NULL
       ORDER BY "txnDate" DESC, seq DESC LIMIT 1`, req.branchId, id, from)
    const firstIn = await q1<any>(req,
      `SELECT (balance - credit + debit)::float AS opening FROM ${t} WHERE "branchId" = $1::uuid AND "bankAccountId" = $2::uuid AND "txnDate" BETWEEN $3::date AND $4::date AND balance IS NOT NULL
       ORDER BY "txnDate", seq LIMIT 1`, req.branchId, id, from, to)
    const last = await q1<any>(req,
      `SELECT balance::float AS balance FROM ${t} WHERE "branchId" = $1::uuid AND "bankAccountId" = $2::uuid AND "txnDate" BETWEEN $3::date AND $4::date AND balance IS NOT NULL
       ORDER BY "txnDate" DESC, seq DESC LIMIT 1`, req.branchId, id, from, to)
    const opening = r2(before?.balance ?? firstIn?.opening ?? account.openingBalance)
    const closing = last?.balance != null ? r2(last.balance) : null
    const expected = r2(opening + (sums?.credit ?? 0) - (sums?.debit ?? 0))

    const bankNotBooks = await q<Line>(req,
      `SELECT ${LINE_COLS()} FROM ${t} l WHERE l."branchId" = $1::uuid AND l."bankAccountId" = $2::uuid AND l.status = 'unmatched'
         AND l."txnDate" BETWEEN $3::date AND $4::date ORDER BY l."txnDate" DESC, l.seq DESC LIMIT 200`, req.branchId, id, from, to)
    const booksNotBank = await q<any>(req,
      `SELECT p.id, to_char(p."paymentDate", 'YYYY-MM-DD') AS date, pa.name AS party, p.amount::float AS amount, p.method, p."refNo"
       FROM ${tbl(s(req), 'payments')} p LEFT JOIN ${tbl(s(req), 'parties')} pa ON pa.id = p."partyId"
       WHERE p."branchId" = $1::uuid AND p.status = 'active' AND p.type IN ('receipt', 'advance') AND p.method NOT IN ('cash', 'tds', 'credit')
         AND p."paymentDate" BETWEEN $2::date AND $3::date AND ${matchedPaymentGuard(s(req))}
       ORDER BY p."paymentDate" DESC LIMIT 200`, req.branchId, from, to)

    return {
      account: { id: account.id, name: account.name, bankName: account.bankName }, from, to,
      statement: { opening, credits: r2(sums?.credit ?? 0), debits: r2(sums?.debit ?? 0), lines: sums?.n ?? 0, closing },
      check: { expectedClosing: expected, statementClosing: closing, difference: closing == null ? null : r2(closing - expected) },
      matched: st['matched'], unmatched: st['unmatched'], ignored: st['ignored'],
      inBankNotInBooks: bankNotBooks,
      inBooksNotInBank: booksNotBank.map((p: any) => ({ ...p, amount: r2(p.amount) })),
      inBooksNotInBankTotal: r2(booksNotBank.reduce((t2: number, p: any) => t2 + p.amount, 0)),
    }
  })
}
