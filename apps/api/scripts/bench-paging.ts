// Page-number vs bookmark paging, deep into the bench tenant: the same position reached both ways.
//   cd apps/api && npx tsx scripts/bench-paging.ts
const API = process.env['API_URL'] ?? 'http://localhost:3100'
let token = ''
async function get(path: string) { const t = performance.now(); const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } }); const d: any = await r.json(); return { ms: performance.now() - t, d, status: r.status } }
const med = async (path: string) => { const a = []; for (let i = 0; i < 3; i++) a.push((await get(path)).ms); return a.sort((x, y) => x - y)[1]!.toFixed(0).padStart(6) + ' ms' }
async function main() {
  token = ((await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantPhone: '9800000001', phone: '9800000001', pin: '1234' }) })).json()) as any).accessToken
  const acct = ((await get('/api/transport/bank/accounts')).d as any[])[0]
  const cases: Array<[string, string, number, (d: any) => string | null]> = [
    ['loads', '/api/transport/lrs', 15000, (d) => d.nextCursor],
    ['trip costs', '/api/transport/expenses', 20000, (d) => d.nextCursor],
    ['bills', '/api/invoices', 6000, (d) => d.meta.nextCursor],
    ['bank lines', `/api/transport/bank/accounts/${acct.id}/lines`, 10000, (d) => d.nextCursor],
  ]
  console.log('list'.padEnd(12), 'first page'.padStart(12), 'by page number'.padStart(18), 'by bookmark'.padStart(14), '  (same deep position)')
  for (const [name, path, deepPage, cur] of cases) {
    const limit = 20
    const first = await med(`${path}?limit=${limit}`)
    const byNumber = await med(`${path}?limit=${limit}&page=${deepPage}`)
    const marker = cur((await get(`${path}?limit=${limit}&page=${deepPage - 1}`)).d)             // the bookmark that points at that position
    const byBookmark = marker ? await med(`${path}?limit=${limit}&after=${marker}`) : 'n/a'
    console.log(name.padEnd(12), first.padStart(12), byNumber.padStart(18), byBookmark.padStart(14))
  }
}
main()
