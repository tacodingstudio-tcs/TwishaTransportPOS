// packages/shared/src/bank-statement.ts
// Reads a bank statement that has already been turned into rows of cells (what a spreadsheet library gives back for
// an .xlsx / .xls / .csv download from net banking). Pure functions, no dependencies — the browser uses them to show a
// preview before importing, and the API tests exercise them directly.
//
// Banks lay statements out differently (SBI: Txn Date / Description / Ref No. / Debit / Credit / Balance; Axis:
// Tran Date / CHQNO / PARTICULARS / DR / CR / BAL; HDFC: Date / Narration / Chq./Ref.No. / Withdrawal Amt. / Deposit
// Amt. / Closing Balance; ICICI: Transaction Date / Transaction Remarks / Withdrawal Amount / Deposit Amount /
// Balance), usually with a block of account details above the table. We find the header row by its words, map the
// columns by synonym, and let the user correct the mapping if a bank words it differently.

export interface ParsedBankRow {
  date: string            // YYYY-MM-DD
  description: string
  refNo: string
  debit: number           // money out
  credit: number          // money in
  balance: number | null  // running balance after this line, if the statement has one
}

export interface BankColumnMap {
  date: number | null
  description: number | null
  ref: number | null
  debit: number | null
  credit: number | null
  balance: number | null
  /** Single-amount layouts: one amount column plus a Dr/Cr marker (or a negative sign for money out). */
  amount: number | null
  type: number | null
}

export interface BankParseResult {
  rows: ParsedBankRow[]            // oldest first
  skipped: number                  // rows that looked like data but could not be used
  headerRow: number | null         // 0-based index of the header row that was used
  headers: string[]                // header cells of that row (for the mapping dropdowns)
  columns: BankColumnMap
  openingBalance: number | null
  closingBalance: number | null
  fromDate: string | null
  toDate: string | null
  warnings: string[]
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const clean = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim()
const lower = (v: unknown): string => clean(v).toLowerCase()
const pad2 = (n: number) => String(n).padStart(2, '0')

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function validYmd(y: number, m: number, d: number): string | null {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/** Dates as banks write them: 05/10/2026, 05-10-26, 5 Oct 2026, 05-Oct-2026, 2026-10-05, Excel serials, Date objects. */
export function parseBankDate(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : validYmd(v.getFullYear(), v.getMonth() + 1, v.getDate())
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {                                     // Excel serial day (1900 system)
      const dt = new Date(Math.round((v - 25569) * 86400000))
      return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
    }
    return null
  }
  const s = clean(v).replace(/[,]/g, ' ').replace(/\s+/g, ' ')
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s)                       // 2026-10-05
  if (m) return validYmd(+m[1]!, +m[2]!, +m[3]!)
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})(?:[ T].*)?$/.exec(s)                  // 05/10/2026, 05-10-26
  if (m) { const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!; return validYmd(y, +m[2]!, +m[1]!) }
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ]+(\d{2}|\d{4})(?:[ T].*)?$/.exec(s)           // 05-Oct-2026, 5 Oct 2026
  if (m) {
    const mon = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()]
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!
    return mon ? validYmd(y, mon, +m[1]!) : null
  }
  return null
}

/** "1,23,456.78", "₹ 500", "(250.00)", "1,000.00 Cr", "250 DR" → number. Blank → null. */
export function parseBankAmount(v: unknown): number | null {
  if (typeof v === 'number') return isFinite(v) ? v : null
  let s = clean(v)
  if (!s) return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1) }
  if (/\bdr\.?$/i.test(s)) { sign = -sign; s = s.replace(/\s*dr\.?$/i, '') }
  else if (/\bcr\.?$/i.test(s)) s = s.replace(/\s*cr\.?$/i, '')
  s = s.replace(/[₹,\s]|rs\.?|inr/gi, '')
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1) }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null
  const n = Number(s)
  return isFinite(n) ? sign * n : null
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

// ── header detection ─────────────────────────────────────────────────────────────────────────────────────────────

type Field = keyof BankColumnMap

/** [field, exact-cell words, contains-words] — short words must match the whole cell to avoid false hits. */
const SYNONYMS: Array<[Field, string[], string[]]> = [
  ['date',        ['date', 'txn date', 'tran date', 'trans date', 'transaction date', 'posting date', 'post date', 'value date', 'value dt', 'val date'], ['transaction date', 'txn date', 'tran date']],
  ['description', ['description', 'narration', 'particulars', 'details', 'remarks', 'transaction remarks', 'transaction details'], ['narration', 'particulars', 'description', 'remarks', 'transaction details']],
  ['ref',         ['chq no', 'chq no.', 'cheque no', 'cheque number', 'ref no', 'ref no.', 'reference no', 'utr', 'chqno', 'chq./ref.no.', 'chq/ref no'], ['chq', 'cheque', 'ref.no', 'ref no', 'reference', 'utr']],
  ['debit',       ['debit', 'dr', 'withdrawal', 'withdrawals', 'debit amount', 'withdrawal amt', 'withdrawal amt.', 'dr amount'], ['withdraw', 'debit']],
  ['credit',      ['credit', 'cr', 'deposit', 'deposits', 'credit amount', 'deposit amt', 'deposit amt.', 'cr amount'], ['deposit', 'credit']],
  ['balance',     ['balance', 'bal', 'closing balance', 'running balance', 'available balance'], ['balance']],
  ['amount',      ['amount', 'amount (inr)', 'txn amount', 'transaction amount'], ['amount']],
  ['type',        ['dr/cr', 'cr/dr', 'type', 'txn type', 'transaction type', 'dr / cr'], ['dr/cr', 'cr/dr']],
]

const emptyMap = (): BankColumnMap => ({ date: null, description: null, ref: null, debit: null, credit: null, balance: null, amount: null, type: null })

function mapHeader(cells: unknown[]): BankColumnMap {
  const map = emptyMap()
  const texts = cells.map(lower)
  const taken = new Set<number>()
  const claim = (field: Field, idx: number) => { map[field] = idx; taken.add(idx) }
  // exact matches first (most reliable), then "contains" for the wordier headers
  for (const pass of [0, 1] as const) {
    for (const [field, exact, contains] of SYNONYMS) {
      if (map[field] != null) continue
      const words = pass === 0 ? exact : contains
      // prefer the earliest listed word, so "transaction date" beats "value date"
      for (const w of words) {
        const idx = texts.findIndex((t, i) => !taken.has(i) && (pass === 0 ? t === w : t.includes(w)))
        if (idx >= 0) { claim(field, idx); break }
      }
    }
  }
  return map
}

const score = (m: BankColumnMap): number =>
  (m.date != null ? 1 : 0) + (m.description != null ? 1 : 0) +
  (m.debit != null && m.credit != null ? 2 : m.amount != null ? 1 : 0) + (m.balance != null ? 1 : 0)

/** True when the mapping is enough to read transactions. */
export function bankMapIsUsable(m: BankColumnMap): boolean {
  return m.date != null && ((m.debit != null || m.credit != null) || m.amount != null)
}

/** Finds the header row (the first row that reads like one) and its column mapping. */
export function detectBankHeader(aoa: unknown[][]): { row: number; map: BankColumnMap } | null {
  for (let r = 0; r < Math.min(aoa.length, 80); r++) {
    const cells = aoa[r] ?? []
    if (cells.filter((c) => clean(c)).length < 3) continue
    const map = mapHeader(cells)
    if (score(map) >= 4 && bankMapIsUsable(map)) return { row: r, map }
  }
  return null
}

// ── references and wording ───────────────────────────────────────────────────────────────────────────────────────

/** The UTR / cheque / UPI reference hidden in a narration, if there is one (used to match payments). */
export function extractBankRef(description: string): string {
  const d = description.toUpperCase()
  const patterns: RegExp[] = [
    /\b(?:UTR|RRN|REF(?:ERENCE)?(?:\s*NO)?)[\s:.\-#]*([A-Z0-9]{8,24})\b/,
    /\b([A-Z]{4}[RN]\d{10,}|[A-Z]{4}[0-9]{2}[A-Z0-9]{8,})\b/,        // NEFT/RTGS UTRs: UTIBN26101..., SBINR52026...
    /\bUPI[\/\-](?:[A-Z]+[\/\-])?(\d{9,16})\b/,
    /\bIMPS[\/\-](?:[A-Z]+[\/\-])?(\d{9,16})\b/,
    /\b(\d{12})\b/,                                                     // a bare 12-digit UPI/IMPS reference
    /\b(?:CHQ|CHEQUE|CLG)[\s:.\-#]*(?:NO)?[\s:.\-#]*(\d{5,8})\b/,
  ]
  for (const p of patterns) { const m = p.exec(d); if (m?.[1]) return m[1] }
  return ''
}

/** How the money moved, from the narration: UPI, cheque, or (default) a bank transfer — for the payment record. */
export function bankMethodFromNarration(description: string): 'upi' | 'cheque' | 'bank_transfer' {
  const d = description.toUpperCase()
  if (/\bUPI\b/.test(d)) return 'upi'
  if (/\b(CHQ|CHEQUE|CLG|CLEARING)\b/.test(d)) return 'cheque'
  return 'bank_transfer'
}

const STOP = new Set(['limited', 'private', 'pvt', 'ltd', 'llp', 'company', 'and', 'the', 'enterprise', 'enterprises', 'traders', 'trading',
  'industries', 'corporation', 'india', 'roadways', 'transport', 'logistics', 'cement', 'sons', 'bank', 'neft', 'rtgs', 'imps', 'upi'])

/** Distinctive words of a business name (≥ 4 letters, no generic words) for matching narrations to customers / pumps. */
export function nameTokens(name: string): string[] {
  return [...new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))]
}

/** How many of a name's distinctive words appear in the narration. */
export function nameHits(name: string, narration: string): number {
  const n = narration.toLowerCase()
  return nameTokens(name).filter((t) => n.includes(t)).length
}

/** Labels for bank lines that are not a customer receipt, a pump payment or an expense. */
export const BANK_LINE_LABELS = [
  'Owner drawings', 'Capital introduced', 'Transfer between own accounts', 'Bank charges', 'Interest received',
  'Interest paid', 'Loan received', 'Loan EMI / repayment', 'GST / tax payment', 'Refund / reversal',
  'Salary / driver payment', 'Other',
] as const
export type BankLineLabel = (typeof BANK_LINE_LABELS)[number]

// ── the parser ───────────────────────────────────────────────────────────────────────────────────────────────────

export function parseBankStatementRows(aoa: unknown[][], overrides?: { headerRow?: number; columns?: Partial<BankColumnMap> }): BankParseResult {
  const warnings: string[] = []
  const result: BankParseResult = {
    rows: [], skipped: 0, headerRow: null, headers: [], columns: emptyMap(),
    openingBalance: null, closingBalance: null, fromDate: null, toDate: null, warnings,
  }

  let headerRow = overrides?.headerRow ?? null
  let map = emptyMap()
  if (headerRow == null) {
    const found = detectBankHeader(aoa)
    if (!found) { warnings.push('Could not find the table of transactions. Check that this is the statement file, or pick the columns yourself.'); return result }
    headerRow = found.row; map = found.map
  } else {
    map = mapHeader(aoa[headerRow] ?? [])
  }
  if (overrides?.columns) map = { ...map, ...overrides.columns }
  result.headerRow = headerRow
  result.headers = (aoa[headerRow] ?? []).map(clean)
  result.columns = map
  if (!bankMapIsUsable(map)) { warnings.push('Could not tell which columns hold the date and the money in / out. Pick them below.'); return result }
  if (map.description == null) warnings.push('No narration column found — lines will have no description to match on.')

  const cellAt = (row: unknown[], i: number | null) => (i == null ? undefined : row[i])
  const parsed: ParsedBankRow[] = []
  let declaredOpening: number | null = null

  for (let r = headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? []
    if (row.every((c) => !clean(c))) continue
    const description = clean(cellAt(row, map.description))
    const date = parseBankDate(cellAt(row, map.date))

    if (!date) {
      // "Opening Balance" lines carry a balance but no date; anything else without a date is a footer / repeated header
      if (/opening\s+balance|b\/f|brought forward/i.test(description + ' ' + row.map(clean).join(' '))) {
        const b = parseBankAmount(cellAt(row, map.balance)) ?? row.map(parseBankAmount).find((x) => x != null) ?? null
        if (b != null && declaredOpening == null) declaredOpening = b
      } else if (row.map(clean).filter(Boolean).length >= 3 && parseBankAmount(cellAt(row, map.balance)) != null) {
        result.skipped++        // had a balance but no usable date: worth telling the user
      }
      continue
    }

    let debit = 0, credit = 0
    if (map.debit != null || map.credit != null) {
      debit = Math.abs(parseBankAmount(cellAt(row, map.debit)) ?? 0)
      credit = Math.abs(parseBankAmount(cellAt(row, map.credit)) ?? 0)
    } else if (map.amount != null) {
      const amt = parseBankAmount(cellAt(row, map.amount))
      const t = lower(cellAt(row, map.type))
      if (amt == null) { result.skipped++; continue }
      const isDebit = /^(dr|debit|d)\b/.test(t) || /\bdr\b/.test(t) || (!t && amt < 0) || /\bdr\.?$/i.test(clean(cellAt(row, map.amount)))
      if (isDebit) debit = Math.abs(amt); else credit = Math.abs(amt)
    }
    if (debit > 0 && credit > 0) { result.skipped++; warnings.push(`Row ${r + 1}: both money out and money in on one line — skipped.`); continue }
    if (debit === 0 && credit === 0) continue                                        // a balance-only / zero line

    parsed.push({
      date, description, refNo: clean(cellAt(row, map.ref)),
      debit: round2(debit), credit: round2(credit), balance: (() => { const b = parseBankAmount(cellAt(row, map.balance)); return b == null ? null : round2(b) })(),
    })
  }

  // Some banks list the newest line first. Everything downstream wants oldest first.
  if (parsed.length > 1 && parsed[0]!.date > parsed[parsed.length - 1]!.date) parsed.reverse()
  result.rows = parsed
  if (parsed.length) {
    result.fromDate = parsed[0]!.date
    result.toDate = parsed[parsed.length - 1]!.date
    const last = parsed[parsed.length - 1]!
    result.closingBalance = last.balance
    const first = parsed[0]!
    result.openingBalance = declaredOpening ?? (first.balance != null ? round2(first.balance - first.credit + first.debit) : null)

    // A statement whose running balances do not add up is incomplete or mis-read — say so before it is saved.
    let breaks = 0
    for (let i = 1; i < parsed.length; i++) {
      const p = parsed[i - 1]!, c = parsed[i]!
      if (p.balance != null && c.balance != null && Math.abs(round2(p.balance + c.credit - c.debit) - c.balance) > 0.01) breaks++
    }
    if (breaks > 0) warnings.push(`${breaks} line${breaks === 1 ? '' : 's'} where the running balance does not follow from the line before — the file may be missing rows or sorted differently.`)
  }
  if (result.skipped > 0) warnings.push(`${result.skipped} row${result.skipped === 1 ? '' : 's'} could not be read and ${result.skipped === 1 ? 'was' : 'were'} left out.`)
  return result
}
