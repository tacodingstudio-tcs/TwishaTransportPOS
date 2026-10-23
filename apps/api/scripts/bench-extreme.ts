// Times the biggest registers over a THREE-YEAR range on the bench tenant, the way the screen asks (?preview=300) and the way Excel asks (full).
//   cd apps/api && npx tsx scripts/bench-extreme.ts
const API = process.env['API_URL'] ?? 'http://localhost:3100'
async function main() {
  const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantPhone: '9800000001', phone: '9800000001', pin: '1234' }) })
  if (!login.ok) throw new Error('login failed — run bench-seed.ts first')
  const token = ((await login.json()) as any).accessToken
  const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 1095 * 86_400_000).toISOString().slice(0, 10)
  const kinds = ['sales-register', 'receipts-register', 'expense-register', 'fuel-register', 'pump-ledger', 'bank-book', 'outstanding']
  console.log('report'.padEnd(20), 'screen (preview)'.padStart(18), 'Excel (all rows)'.padStart(20))
  for (const k of kinds) {
    const cells: string[] = []
    for (const extra of ['&preview=300', '']) {
      const t = performance.now()
      const r = await fetch(`${API}/api/transport/ca/${k}?from=${from}&to=${today}&asOn=${today}${extra}`, { headers: { authorization: `Bearer ${token}` } })
      const body: any = await r.json()
      cells.push(`${(performance.now() - t).toFixed(0).padStart(6)} ms ${String(body.totalRows ?? body.rows?.length ?? '-').padStart(7)} rows`)
    }
    console.log(k.padEnd(20), cells[0]!.padStart(18), cells[1]!.padStart(20))
  }
}
main()
