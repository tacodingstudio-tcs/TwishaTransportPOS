// apps/api/scripts/seed-office-costs.ts
// =============================================================================
// Adds one Office Costs entry in EVERY expense category of the firm you are signed in to (the demo owner's current firm),
// dated in a chosen month, so each category filter on the Office Costs page has something to show.
// Drives the real HTTP API. Idempotent: a category that already has a "Sample:" entry is skipped.
//
//   cd apps/api && npx tsx scripts/seed-office-costs.ts                   # September 2026
//   MONTH=2026-10 npx tsx scripts/seed-office-costs.ts                    # another month
//   FIRM=goods npx tsx scripts/seed-office-costs.ts                       # the goods firm instead of the transport firm
//   API_URL=https://… (env) points it at another server.
// =============================================================================

const API = process.env['API_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3100}`
const MONTH = process.env['MONTH'] ?? '2026-09'
const FIRM = process.env['FIRM'] ?? 'transport'
const MARK = 'Sample: '

let token = '', refresh = ''
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return data as T
}

// amount is what was paid (GST inside, where there is any)
const SAMPLES: Record<string, { amount: number; gst: number; mode: string; what: string }> = {
  diesel:            { amount: 18400, gst: 0,  mode: 'bank',  what: 'Diesel for the yard generator and the shunting tractor' },
  toll:              { amount: 6200,  gst: 0,  mode: 'upi',   what: 'FASTag recharge — office car' },
  driver_salary:     { amount: 36000, gst: 0,  mode: 'bank',  what: 'Driver salaries for the month (attached trucks)' },
  driver_bhatta:     { amount: 4500,  gst: 0,  mode: 'cash',  what: 'Food allowance, drivers waiting at the yard' },
  tyres:             { amount: 26550, gst: 18, mode: 'bank',  what: 'Two retreaded tyres, spare stock' },
  spares:            { amount: 11800, gst: 18, mode: 'bank',  what: 'Air filters, brake liners' },
  repair:            { amount: 7080,  gst: 18, mode: 'upi',   what: 'Workshop service, truck GJ05CA9042' },
  insurance:         { amount: 41300, gst: 18, mode: 'bank',  what: 'Goods-in-transit insurance, annual' },
  permit_tax:        { amount: 9500,  gst: 0,  mode: 'bank',  what: 'National permit authorisation fee' },
  challan:           { amount: 1000,  gst: 0,  mode: 'cash',  what: 'Overload challan, paid at the RTO' },
  loading_unloading: { amount: 5200,  gst: 0,  mode: 'cash',  what: 'Hamali at the godown' },
  vehicle_hire:      { amount: 22000, gst: 0,  mode: 'bank',  what: 'Market truck hired for an urgent load' },
  broker_commission: { amount: 3500,  gst: 0,  mode: 'upi',   what: 'Broker commission, Mumbai lane' },
  parking:           { amount: 1800,  gst: 0,  mode: 'cash',  what: 'Yard and parking charges' },
  emi:               { amount: 71500, gst: 0,  mode: 'bank',  what: 'Truck loan EMI' },
  rent:              { amount: 25000, gst: 18, mode: 'bank',  what: 'Yard and office rent' },
  electricity:       { amount: 4150,  gst: 0,  mode: 'bank',  what: 'Electricity bill' },
  internet:          { amount: 1180,  gst: 18, mode: 'bank',  what: 'Broadband and office phones' },
  staff:             { amount: 42000, gst: 0,  mode: 'bank',  what: 'Office staff salary' },
  maintenance:       { amount: 3300,  gst: 18, mode: 'upi',   what: 'Weighbridge calibration and CCTV service' },
  misc:              { amount: 1500,  gst: 0,  mode: 'cash',  what: 'Tea, stationery and small items' },
}

async function main() {
  console.log(`Adding one office cost per category for ${MONTH} (${FIRM} firm) against ${API}`)
  const login = await call('POST', '/api/auth/login', { tenantPhone: '9100000001', phone: '9100000001', pin: '1111' })
  token = login.accessToken; refresh = login.refreshToken
  const firms: any[] = (await call<any>('GET', '/api/transport/firms')).firms
  const firm = firms.find((f) => f.kind === FIRM)
  if (!firm) throw new Error(`No ${FIRM} firm found`)
  token = (await call('POST', '/api/auth/switch-branch', { branchId: firm.id, refreshToken: refresh })).accessToken

  const cats: Array<{ code: string; label: string }> = await call('GET', '/api/expenses/categories')
  let added = 0, skipped = 0
  for (const [i, c] of cats.entries()) {
    const s = SAMPLES[c.code] ?? { amount: 2500, gst: 0, mode: 'cash', what: c.label }
    const have = await call<any>('GET', `/api/expenses?category=${c.code}&limit=100`)
    if ((have.data ?? []).some((e: any) => String(e.description ?? '').startsWith(MARK))) { skipped++; continue }
    const day = String(3 + ((i * 5) % 24)).padStart(2, '0')
    await call('POST', '/api/expenses', {
      category: c.code, amount: s.amount, gstRate: s.gst, paymentMode: s.mode, date: `${MONTH}-${day}`, description: `${MARK}${s.what}`,
    })
    added++
  }
  console.log(`  ${added} added, ${skipped} already there (${cats.length} categories)`)
  console.log('Done.')
}

main().catch((e) => { console.error('\nFailed:', e.message ?? e); process.exit(1) })
