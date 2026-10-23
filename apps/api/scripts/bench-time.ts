// apps/api/scripts/bench-time.ts
// Times the main list / report endpoints against the bench tenant (see bench-seed.ts): three runs each, reports the median and payload size.
//   cd apps/api && npx tsx scripts/bench-time.ts            # all
//   cd apps/api && npx tsx scripts/bench-time.ts lrs        # only paths containing "lrs"
const API = process.env['API_URL'] ?? 'http://localhost:3100'
const FILTER = process.argv[2] ?? ''
let token = ''

async function get(path: string): Promise<{ ms: number; status: number; bytes: number }> {
  const t = performance.now()
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const body = await r.arrayBuffer()
  return { ms: performance.now() - t, status: r.status, bytes: body.byteLength }
}

const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
const ago = (d: number) => new Date(Date.now() + 5.5 * 3600_000 - d * 86_400_000).toISOString().slice(0, 10)
const FY = `from=${ago(200)}&to=${today}`
const YEAR = `from=${ago(365)}&to=${today}`

const PATHS: Array<[string, string]> = [
  ['home dashboard', '/api/transport/dashboard'],
  ['LR list (page 1)', '/api/transport/lrs?page=1&limit=20'],
  ['LR list (deep page 1500)', '/api/transport/lrs?page=1500&limit=20'],
  ['LR list (search lr no)', '/api/transport/lrs?q=LR-B-39'],
  ['LR list (very deep page 15000)', '/api/transport/lrs?page=15000&limit=20'],
  ['LR list (unbilled, all time)', '/api/transport/lrs?unbilled=true&limit=20'],
  ['bills (very deep page 6000)', '/api/invoices?page=6000&limit=20'],
  ['trip costs (very deep page 20000)', '/api/transport/expenses?page=20000&limit=30'],
  ['trip costs (all time, one category)', '/api/transport/expenses?category=diesel&limit=30'],
  ['LR search (truck / goods)', '/api/transport/lrs?search=Cement'],
  ['LR list (month)', `/api/transport/lrs?limit=20&from=${ago(30)}&to=${today}`],
  ['LR billable', '/api/transport/billing/billable'],
  ['trips list', '/api/transport/trips?limit=20&status=planned,running'],
  ['trips (all, search)', '/api/transport/trips?limit=20&search=Surat'],
  ['bills list', '/api/invoices?limit=20'],
  ['bills (search customer)', '/api/invoices?limit=20&search=Customer%2012'],
  ['bills (month)', `/api/invoices?limit=20&fromDate=${ago(30)}&toDate=${today}`],
  ['parties list', '/api/parties?limit=20'],
  ['parties search', '/api/parties?limit=20&search=Customer%2012'],
  ['aging receivables', '/api/payments/outstanding?type=customer&limit=100'],
  ['trip costs list', '/api/transport/expenses?limit=30'],
  ['trip costs (month)', `/api/transport/expenses?limit=30&from=${ago(30)}&to=${today}`],
  ['pump payables', '/api/transport/expenses/payables'],
  ['office costs list', '/api/expenses?limit=50'],
  ['office costs summary (year)', `/api/expenses/summary?${YEAR}`],
  ['profit per trip (month)', `/api/transport/reports/trip-pnl?from=${ago(30)}&to=${today}`],
  ['profit per truck (year)', `/api/transport/reports/vehicle-pnl?${YEAR}`],
  ['business per party (year)', `/api/transport/reports/party-business?${YEAR}`],
  ['CA sales register (FY)', `/api/transport/ca/sales-register?${FY}`],
  ['CA receipts (FY)', `/api/transport/ca/receipts-register?${FY}`],
  ['CA expenses (FY)', `/api/transport/ca/expense-register?${FY}`],
  ['CA fuel (FY)', `/api/transport/ca/fuel-register?${FY}`],
  ['CA TDS (FY)', `/api/transport/ca/tds-register?${FY}`],
  ['CA GSTR-3B (FY)', `/api/transport/ca/gstr3b?${FY}`],
  ['CA pump ledger (FY)', `/api/transport/ca/pump-ledger?${FY}`],
  ['CA outstanding', `/api/transport/ca/outstanding?asOn=${today}`],
  ['CA bank book (FY)', `/api/transport/ca/bank-book?${FY}`],
  ['CA truck monthly (year)', `/api/transport/ca/truck-monthly?${YEAR}`],
  ['CA truck weekly (3 months)', `/api/transport/ca/truck-weekly?from=${ago(90)}&to=${today}`],
  ['CA all firms', `/api/transport/ca/combined?${FY}`],
  ['bank accounts', '/api/transport/bank/accounts'],
]

async function main() {
  const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantPhone: '9800000001', phone: '9800000001', pin: '1234' }) })
  if (!login.ok) throw new Error('login failed — run bench-seed.ts first')
  token = ((await login.json()) as any).accessToken

  // paths that need an id from earlier answers
  const acct = ((await (await fetch(`${API}/api/transport/bank/accounts`, { headers: { authorization: `Bearer ${token}` } })).json()) as any[])[0]
  if (acct) {
    PATHS.push(['bank lines (needs matching)', `/api/transport/bank/accounts/${acct.id}/lines?status=unmatched&page=1&limit=40`])
    PATHS.push(['bank lines (search)', `/api/transport/bank/accounts/${acct.id}/lines?status=matched&search=CUSTOMER%2012&limit=40`])
    PATHS.push(['bank reconciliation (FY)', `/api/transport/bank/accounts/${acct.id}/reconciliation?${FY}`])
  }

  const rows: Array<[string, number, number, number]> = []
  for (const [label, path] of PATHS) {
    if (FILTER && !path.includes(FILTER) && !label.toLowerCase().includes(FILTER.toLowerCase())) continue
    const runs = []
    let status = 0, bytes = 0
    for (let i = 0; i < 3; i++) { const r = await get(path); runs.push(r.ms); status = r.status; bytes = r.bytes }
    runs.sort((a, b) => a - b)
    rows.push([`${label}${status === 200 ? '' : `  [HTTP ${status}]`}`, runs[1]!, Math.max(...runs), bytes])
  }
  const width = Math.max(...rows.map((r) => r[0].length))
  for (const [l, med, max, bytes] of rows.sort((a, b) => b[1] - a[1])) {
    const flag = med > 1000 ? '  ◄◄ SLOW' : med > 300 ? '  ◄ slow' : ''
    console.log(`${l.padEnd(width)}  ${med.toFixed(0).padStart(6)} ms  (max ${max.toFixed(0)})  ${(bytes / 1024).toFixed(0).padStart(5)} KB${flag}`)
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
