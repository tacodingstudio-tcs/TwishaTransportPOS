// Adds the NEW records of one tenant schema (e.g. your LOCAL demo tenant) to another tenant schema (e.g. the LIVE Neon one) WITHOUT
// deleting or changing anything that is already there. Insert-only, one transaction, dry-run by default, and it can undo itself.
//
//   set SRC_URL=postgresql://billing_app:localdev123@localhost:5434/billing_db
//   set SRC_SCHEMA=t_shree_ganesh_roadlines_ulhj
//   set DST_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require      (direct, non-pooler)
//   set DST_SCHEMA=t_shree_ganesh_roadlines_tz7z
//   npx tsx scripts/merge-tenant.ts                 -> DRY RUN: does everything, prints the report, rolls back
//   npx tsx scripts/merge-tenant.ts --apply         -> same, then COMMITS
//   npx tsx scripts/merge-tenant.ts --undo          -> DRY RUN of the undo;  --undo --apply  removes exactly what the merge added
//
// What is merged:  customers, trucks, drivers, routes, trips, loads (LRs), bills + lines, payments + allocations, office costs, trip costs.
// What is NOT:     bank accounts / statements, notifications, e-way events, users, branches, settings. Firms are matched by name, users by phone.
// Skipped on purpose:
//   * browser-test leftovers: customers called "Saurastra Cement <digits>", loads for "Walk-in Receiver Traders" / "Cotton yarn cones, 120 bags",
//     and every trip / bill tied to them; trips that are still running (a running trip owns its truck's on-trip flag);
//   * anything the target ALREADY HAS by content (same customer + date + amount for bills and payments, same date + parties + vehicle +
//     route + weight + amount for loads, same truck + dates + route for trips, same date + category + amount for costs). The generated
//     demo history exists on both sides, so it is not copied twice.
// Safe by construction: every imported row gets a NEW id; customers/trucks/drivers/routes that already exist on the target are reused;
//   LR / trip / bill numbers that would clash continue after the target's highest; the counters move past the imported numbers;
//   a reused customer's balance is topped up by what the imported bills add. A second run is refused.
import pg from 'pg'
import { randomUUID } from 'node:crypto'

const { Client } = pg
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`Set ${k} first (see the top of this file).`); process.exit(2) } return v }
const SRC_URL = need('SRC_URL'), DST_URL = need('DST_URL'), SS = need('SRC_SCHEMA'), DS = need('DST_SCHEMA')
const APPLY = process.argv.includes('--apply'), UNDO = process.argv.includes('--undo')
const JUNK_PARTY = /^Saurastra Cement( Limited)? \d{3,6}$/i
const JUNK_RECEIVER = 'walk-in receiver traders', JUNK_GOODS = 'cotton yarn cones, 120 bags'
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

type Row = Record<string, any>
const q = (id: string) => `"${id}"`
function connect(url: string) {
  const ssl = /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined
  // every value comes back as the server's own text (exact numerics and dates); json is parsed
  return new Client({
    connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''), ssl,
    types: { getTypeParser: ((oid: number) => (oid === 114 || oid === 3802 ? (s: string) => JSON.parse(s) : (s: string) => s)) as any },
  })
}
const S = connect(SRC_URL), D = connect(DST_URL)
await S.connect(); await D.connect()
const rows = async (c: pg.Client, schema: string, table: string): Promise<Row[]> => (await c.query(`SELECT * FROM ${q(schema)}.${q(table)}`)).rows
const say = (s = '') => console.log(s)

// ── undo ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (UNDO) {
  await D.query('BEGIN')
  try {
    const log = await D.query(`SELECT sig, detail FROM ${q(DS)}."_merge_log" WHERE sig LIKE $1`, [`${SS}:%`]).catch(() => ({ rows: [] as Row[] }))
    if (!log.rows.length) throw new Error(`No merge of ${SS} is recorded in ${DS}.`)
    const detail = JSON.parse(log.rows[0].detail)
    if (!detail.ids) throw new Error('That merge was made by an older version of this script and did not record its ids — restore a Neon branch instead.')
    const order = ['payment_allocations', 'invoice_items', 'payments', 'expenses', 'transport_expenses', 'transport_lorry_receipts', 'invoices', 'transport_trips', 'transport_routes', 'transport_drivers', 'transport_vehicles', 'parties']
    for (const t of order) {
      const ids: string[] = detail.ids[t] ?? []
      if (!ids.length) continue
      const r = await D.query(`DELETE FROM ${q(DS)}.${q(t)} WHERE id = ANY($1::uuid[])`, [ids]); say(`  removed ${String(r.rowCount).padStart(5)} from ${t}`)
    }
    for (const b of detail.balanceDeltas ?? []) await D.query(`UPDATE ${q(DS)}.parties SET balance = balance - $1::numeric WHERE id = $2::uuid`, [b.delta, b.id])
    await D.query(`DELETE FROM ${q(DS)}."_merge_log" WHERE sig LIKE $1`, [`${SS}:%`])
    say(`${APPLY ? 'UNDONE (committed).' : 'Dry run of the undo — rolled back. Add --apply to really remove them.'}  (numbering counters are left where they are; that is harmless)`)
    await D.query(APPLY ? 'COMMIT' : 'ROLLBACK')
  } catch (e: any) { await D.query('ROLLBACK').catch(() => {}); console.error('\nFAILED, nothing was changed:', e?.message ?? e); process.exitCode = 1 }
  await S.end(); await D.end()
  process.exit(process.exitCode ?? 0)
}

// ── read everything we need ───────────────────────────────────────────────────────────────────────────────────────────
const T = ['branches', 'users', 'parties', 'transport_vehicles', 'transport_drivers', 'transport_routes', 'transport_trips', 'transport_lorry_receipts',
  'invoices', 'invoice_items', 'payments', 'payment_allocations', 'expenses', 'transport_expenses'] as const
const src: Record<string, Row[]> = {}, dst: Record<string, Row[]> = {}
for (const t of T) { src[t] = await rows(S, SS, t); dst[t] = ['invoice_items', 'payment_allocations'].includes(t) ? [] : await rows(D, DS, t) }

// ── firms by name, users by phone ─────────────────────────────────────────────────────────────────────────────────────
const M = new Map<string, string>()        // old uuid -> new uuid (or the existing target row)
for (const b of src.branches) {
  const m = dst.branches.find((x) => x.name.trim().toLowerCase() === b.name.trim().toLowerCase())
  if (!m) { console.error(`Firm "${b.name}" is not on the target. Rename/create it there first.`); process.exit(2) }
  M.set(b.id, m.id)
}
const owner = dst.users.find((u) => u.role === 'owner') ?? dst.users[0]
for (const u of src.users) M.set(u.id, (dst.users.find((x) => x.phone === u.phone) ?? owner).id)

// ── content keys, to recognise what the target already has ───────────────────────────────────────────────────────────
const norm = (v: any) => String(v ?? '').trim().toLowerCase()
const partyName = (list: Row[]) => new Map(list.map((p) => [p.id, norm(p.name)]))
const vehReg = (list: Row[]) => new Map(list.map((v) => [v.id, norm(v.regNo)]))
const kBill = (r: Row, b: string, pn: Map<string, string>) => [b, pn.get(r.partyId) ?? '', r.date, r.grandTotal, r.txnType].join('|')
const kLr = (r: Row, b: string) => [b, r.lrDate, norm(r.consignorName), norm(r.consigneeName), norm(r.vehicleNo), norm(r.fromCity), norm(r.toCity), r.chargedWeightKg, r.totalAmount].join('|')
const kTrip = (r: Row, b: string, vr: Map<string, string>) => [b, vr.get(r.vehicleId) ?? '', r.startDate, norm(r.fromCity), norm(r.toCity)].join('|')
const kPay = (r: Row, b: string, pn: Map<string, string>) => [b, pn.get(r.partyId) ?? '', r.paymentDate, r.amount, r.method].join('|')
const kExp = (r: Row, b: string) => [b, r.date, norm(r.category), r.amount, norm(r.description)].join('|')
const kTExp = (r: Row, b: string, vr: Map<string, string>) => [b, r.expenseDate, norm(r.category), r.amount, vr.get(r.vehicleId) ?? '', r.litres ?? ''].join('|')
const dPN = partyName(dst.parties), sPN = partyName(src.parties), dVR = vehReg(dst.transport_vehicles), sVR = vehReg(src.transport_vehicles)
const bag = (list: Row[], key: (r: Row) => string) => { const m = new Map<string, number>(); for (const r of list) m.set(key(r), (m.get(key(r)) ?? 0) + 1); return m }
const tBill = bag(dst.invoices, (r) => kBill(r, r.branchId, dPN)), tLr = bag(dst.transport_lorry_receipts, (r) => kLr(r, r.branchId))
const tTrip = bag(dst.transport_trips, (r) => kTrip(r, r.branchId, dVR)), tPay = bag(dst.payments, (r) => kPay(r, r.branchId, dPN))
const tExp = bag(dst.expenses, (r) => kExp(r, r.branchId))
const tTExp = bag((await rows(D, DS, 'transport_expenses')).filter((e) => !e.tripId), (r) => kTExp(r, r.branchId, dVR))
// the first n source rows with a key the target already has n times are "already there"
const alreadyThere = (list: Row[], key: (r: Row) => string, have: Map<string, number>) => {
  const left = new Map(have), out = new Set<string>()
  for (const r of [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) { const k = key(r); if ((left.get(k) ?? 0) > 0) { left.set(k, left.get(k)! - 1); out.add(r.id) } }
  return out
}

// ── what is left out ──────────────────────────────────────────────────────────────────────────────────────────────────
const xParty = new Set(src.parties.filter((p) => JUNK_PARTY.test(p.name)).map((p) => p.id))
const xTrip = new Set<string>(), xLr = new Set<string>(), xInv = new Set<string>(), xPay = new Set<string>()
const isJunkLr = (l: Row) => xParty.has(l.consignorId) || xParty.has(l.consigneeId) || norm(l.consigneeName) === JUNK_RECEIVER || norm(l.goodsDescription) === JUNK_GOODS
for (const t of src.transport_trips) if (t.status === 'running') xTrip.add(t.id)
for (const l of src.transport_lorry_receipts) if (isJunkLr(l)) xLr.add(l.id)
for (const i of src.invoices) if (xParty.has(i.partyId)) xInv.add(i.id)
for (let again = true; again;) {          // test-run records pull in everything tied to them
  again = false
  for (const l of src.transport_lorry_receipts) {
    if (xLr.has(l.id)) { if (l.tripId && !xTrip.has(l.tripId)) { xTrip.add(l.tripId); again = true } if (l.invoiceId && !xInv.has(l.invoiceId)) { xInv.add(l.invoiceId); again = true } }
    else if ((l.tripId && xTrip.has(l.tripId)) || (l.invoiceId && xInv.has(l.invoiceId))) { xLr.add(l.id); again = true }
  }
}
const junkCount = { parties: xParty.size, loads: xLr.size, trips: xTrip.size, bills: xInv.size }
// what the target already has
const bm = (b: string) => M.get(b)!
const dupInv = alreadyThere(src.invoices.filter((i) => !xInv.has(i.id)), (r) => kBill(r, bm(r.branchId), sPN), tBill)
const dupLr = alreadyThere(src.transport_lorry_receipts.filter((l) => !xLr.has(l.id)), (r) => kLr(r, bm(r.branchId)), tLr)
const dupTrip = alreadyThere(src.transport_trips.filter((t) => !xTrip.has(t.id)), (r) => kTrip(r, bm(r.branchId), sVR), tTrip)
const dupPay = alreadyThere(src.payments.filter((p) => !xParty.has(p.partyId)), (r) => kPay(r, bm(r.branchId), sPN), tPay)
const dupExp = alreadyThere(src.expenses, (r) => kExp(r, bm(r.branchId)), tExp)
const dupTExp = alreadyThere(src.transport_expenses.filter((e) => !e.tripId), (r) => kTExp(r, bm(r.branchId), sVR), tTExp)
dupInv.forEach((id) => xInv.add(id)); dupLr.forEach((id) => xLr.add(id)); dupTrip.forEach((id) => xTrip.add(id))
for (let again = true; again;) {          // a bill that is already there takes its loads with it; a trip whose loads are all there is there too
  again = false
  const lrsOfTrip = new Map<string, Row[]>(); for (const l of src.transport_lorry_receipts) if (l.tripId) (lrsOfTrip.get(l.tripId) ?? lrsOfTrip.set(l.tripId, []).get(l.tripId)!).push(l)
  for (const l of src.transport_lorry_receipts) if (!xLr.has(l.id) && ((l.invoiceId && xInv.has(l.invoiceId)) || (l.tripId && xTrip.has(l.tripId)))) { xLr.add(l.id); again = true }
  for (const [tid, ls] of lrsOfTrip) if (!xTrip.has(tid) && ls.every((l) => xLr.has(l.id))) { xTrip.add(tid); again = true }
}
for (const p of src.payments) {
  if (xParty.has(p.partyId) || dupPay.has(p.id)) { xPay.add(p.id); continue }
  const al = src.payment_allocations.filter((a) => a.paymentId === p.id)
  if (al.length && al.every((a) => xInv.has(a.invoiceId))) xPay.add(p.id)
}
const keepParty = src.parties.filter((p) => !xParty.has(p.id))
const keepTrip = src.transport_trips.filter((t) => !xTrip.has(t.id))
const keepLr = src.transport_lorry_receipts.filter((l) => !xLr.has(l.id))
const keepInv = src.invoices.filter((i) => !xInv.has(i.id))
const keepPay = src.payments.filter((p) => !xPay.has(p.id))
const payIds = new Set(keepPay.map((p) => p.id)), invIds = new Set(keepInv.map((i) => i.id))
const keepAlloc = src.payment_allocations.filter((a) => payIds.has(a.paymentId) && invIds.has(a.invoiceId))
const keepItems = src.invoice_items.filter((i) => invIds.has(i.invoiceId))
const keepTExp = src.transport_expenses.filter((e) => (e.tripId ? !xTrip.has(e.tripId) : !dupTExp.has(e.id)))
const keepExp = src.expenses.filter((e) => !xParty.has(e.partyId) && !dupExp.has(e.id))

// ── reuse what already exists on the target, make new ids for the rest ────────────────────────────────────────────────
const sameName = (a: string, b: string) => norm(a) === norm(b)
const reused = { parties: [] as Row[], vehicles: 0, drivers: 0, routes: 0 }
const newParties: Row[] = [], newVehicles: Row[] = [], newDrivers: Row[] = [], newRoutes: Row[] = []
for (const p of keepParty) {
  const b = M.get(p.branchId) ?? null
  const hit = dst.parties.find((x) => (x.branchId ?? null) === b && sameName(x.name, p.name))
  if (hit) { M.set(p.id, hit.id); reused.parties.push(p) } else { M.set(p.id, randomUUID()); newParties.push(p) }
}
for (const v of src.transport_vehicles) {
  const hit = dst.transport_vehicles.find((x) => x.branchId === M.get(v.branchId) && sameName(x.regNo, v.regNo))
  if (hit) { M.set(v.id, hit.id); reused.vehicles++ } else { M.set(v.id, randomUUID()); newVehicles.push(v) }
}
for (const d of src.transport_drivers) {
  const hit = dst.transport_drivers.find((x) => x.branchId === M.get(d.branchId) && sameName(x.name, d.name) && (x.phone ?? '') === (d.phone ?? ''))
  if (hit) { M.set(d.id, hit.id); reused.drivers++ } else { M.set(d.id, randomUUID()); newDrivers.push(d) }
}
for (const r of src.transport_routes) {
  const hit = dst.transport_routes.find((x) => x.branchId === M.get(r.branchId) && sameName(x.fromCity, r.fromCity) && sameName(x.toCity, r.toCity))
  if (hit) { M.set(r.id, hit.id); reused.routes++ } else { M.set(r.id, randomUUID()); newRoutes.push(r) }
}
for (const list of [keepTrip, keepLr, keepInv, keepItems, keepPay, keepAlloc, keepExp, keepTExp]) for (const r of list) M.set(r.id, randomUUID())
// a skipped bill / load / trip / payment that something kept still points at it: send it to the copy that is already on the target
const twin = (list: Row[], skip: Set<string>, key: (r: Row) => string, targetRows: Row[], tkey: (r: Row) => string) => {
  const by = new Map<string, string>(); for (const t of targetRows) if (!by.has(tkey(t))) by.set(tkey(t), t.id)
  for (const r of list) if (skip.has(r.id)) { const t = by.get(key(r)); if (t) M.set(r.id, t) }
}
twin(src.invoices, dupInv, (r) => kBill(r, bm(r.branchId), sPN), dst.invoices, (r) => kBill(r, r.branchId, dPN))
twin(src.transport_lorry_receipts, dupLr, (r) => kLr(r, bm(r.branchId)), dst.transport_lorry_receipts, (r) => kLr(r, r.branchId))
twin(src.transport_trips, dupTrip, (r) => kTrip(r, bm(r.branchId), sVR), dst.transport_trips, (r) => kTrip(r, r.branchId, dVR))

// ── numbers that would clash continue after the target's highest ─────────────────────────────────────────────────────
const existingNums = async (table: string, col: string, scopeCols: string[]) => {
  const out = new Map<string, Set<string>>()
  for (const r of (await D.query(`SELECT ${scopeCols.map(q).join(',')}, ${q(col)} AS n FROM ${q(DS)}.${q(table)}`)).rows) {
    const k = scopeCols.map((c) => r[c]).join('|'); if (!out.has(k)) out.set(k, new Set()); out.get(k)!.add(r.n)
  }
  return out
}
function assign(items: Row[], col: string, scopeOf: (r: Row) => string, existing: Map<string, Set<string>>) {
  const changed = new Map<string, Map<string, string>>()      // scope -> old -> new
  const byScope = new Map<string, Row[]>()
  for (const r of items) { const k = scopeOf(r); if (!byScope.has(k)) byScope.set(k, []); byScope.get(k)!.push(r) }
  for (const [scope, list] of byScope) {
    const E = existing.get(scope) ?? new Set<string>()
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const reserve = new Set<string>(E)
    const clash = list.filter((r) => E.has(r[col]))
    for (const r of list) if (!E.has(r[col])) reserve.add(r[col])
    const maxOf = new Map<string, number>()
    const note = (n: string) => { const m = /^(.*?)(\d+)$/.exec(n); if (m) maxOf.set(m[1], Math.max(maxOf.get(m[1]) ?? 0, Number(m[2]))) }
    reserve.forEach(note)
    const map = new Map<string, string>()
    for (const r of clash) {
      const old: string = r[col]; const m = /^(.*?)(\d+)$/.exec(old)
      let nn: string
      if (m) { const next = (maxOf.get(m[1]) ?? 0) + 1; maxOf.set(m[1], next); nn = m[1] + String(next).padStart(m[2].length, '0') }
      else { let k = 1; while (reserve.has(`${old}-M${k}`)) k++; nn = `${old}-M${k}` }
      reserve.add(nn); map.set(old, nn)
    }
    changed.set(scope, map)
  }
  return changed
}
const lrCh = assign(keepLr, 'lrNo', (r) => String(bm(r.branchId)), await existingNums('transport_lorry_receipts', 'lrNo', ['branchId']))
const tripCh = assign(keepTrip, 'tripNo', (r) => String(bm(r.branchId)), await existingNums('transport_trips', 'tripNo', ['branchId']))
const invCh = assign(keepInv, 'number', (r) => `${bm(r.branchId)}|${r.txnType}`, await existingNums('invoices', 'number', ['branchId', 'txnType']))
const numMaps = new Map<string, Map<string, string>>()      // dst branch -> every changed number (any kind)
const addNums = (ch: Map<string, Map<string, string>>) => { for (const [scope, m] of ch) { const b = scope.split('|')[0]; if (!numMaps.has(b)) numMaps.set(b, new Map()); for (const [o, n] of m) numMaps.get(b)!.set(o, n) } }
addNums(lrCh); addNums(tripCh); addNums(invCh)
const numRe = new Map<string, RegExp>()
for (const [b, m] of numMaps) if (m.size) numRe.set(b, new RegExp(`(?<![A-Za-z0-9])(?:${[...m.keys()].sort((a, c) => c.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9])`, 'g'))

const invBranch = new Map(src.invoices.map((i) => [i.id, i.branchId])), payBranch = new Map(src.payments.map((p) => [p.id, p.branchId]))
function xform(row: Row, srcBranch: string | undefined): Row {
  let s = JSON.stringify(row).replace(UUID_RE, (u) => M.get(u.toLowerCase()) ?? u)
  const b = srcBranch ? M.get(srcBranch) : undefined
  const re = b ? numRe.get(b) : undefined
  if (re) s = s.replace(re, (x) => numMaps.get(b!)!.get(x) ?? x)
  return JSON.parse(s)
}

// ── write ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const colsOf = async (table: string) => (await D.query(
  `SELECT column_name c FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position`, [DS, table])).rows.map((r) => r.c as string)
const inserted: Record<string, number> = {}, insertedIds: Record<string, string[]> = {}
async function insert(table: string, list: Row[]) {
  inserted[table] = list.length; insertedIds[table] = list.map((r) => r.id)
  if (!list.length) return
  const have = new Set(await colsOf(table)); const cols = Object.keys(list[0]).filter((c) => have.has(c))
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])))
    await D.query(`INSERT INTO ${q(DS)}.${q(table)} (${cols.map(q).join(',')}) SELECT ${cols.map(q).join(',')} FROM jsonb_populate_recordset(null::${q(DS)}.${q(table)}, $1::jsonb)`, [JSON.stringify(part)])
  }
}
const sig = `${SS}:${keepLr.length}:${keepInv.length}:${keepTrip.length}`
await D.query('BEGIN')
try {
  await D.query(`CREATE TABLE IF NOT EXISTS ${q(DS)}."_merge_log" (sig text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), detail text)`)
  if ((await D.query(`SELECT 1 FROM ${q(DS)}."_merge_log" WHERE sig LIKE $1`, [`${SS}:%`])).rowCount) throw new Error(`This source schema was already merged into ${DS} once — refusing to do it twice. Undo it first with --undo --apply (see ${DS}._merge_log).`)

  await insert('parties', newParties.map((r) => xform(r, r.branchId)))
  await insert('transport_vehicles', newVehicles.map((r) => xform(r, r.branchId)))
  await insert('transport_drivers', newDrivers.map((r) => xform(r, r.branchId)))
  await insert('transport_routes', newRoutes.map((r) => xform(r, r.branchId)))
  await insert('transport_trips', keepTrip.map((r) => xform(r, r.branchId)))
  await insert('invoices', keepInv.map((r) => xform(r, r.branchId)))
  await insert('transport_lorry_receipts', keepLr.map((r) => xform(r, r.branchId)))
  await insert('invoice_items', keepItems.map((r) => xform(r, invBranch.get(r.invoiceId))))
  await insert('payments', keepPay.map((r) => xform(r, r.branchId)))
  await insert('payment_allocations', keepAlloc.map((r) => xform(r, payBranch.get(r.paymentId))))
  await insert('expenses', keepExp.map((r) => xform(r, r.branchId)))
  await insert('transport_expenses', keepTExp.map((r) => xform(r, r.branchId)))

  // a customer that already existed gets what the imported bills and receipts add to what they owe
  // (what its imported bills minus receipts come to — never the whole source balance, which also holds what the target already has)
  const balanceDeltas: { id: string; delta: string }[] = []
  for (const p of reused.parties) {
    const mine = keepInv.filter((i) => i.partyId === p.id && i.status !== 'cancelled' && ['sale_invoice', 'debit_note'].includes(i.txnType)).reduce((a, i) => a + Number(i.grandTotal), 0)
    const credits = keepInv.filter((i) => i.partyId === p.id && i.status !== 'cancelled' && i.txnType === 'credit_note').reduce((a, i) => a + Number(i.grandTotal), 0)
    const paid = keepPay.filter((x) => x.partyId === p.id && x.status !== 'void' && x.status !== 'voided').reduce((a, x) => a + Number(x.amount), 0)
    const delta = (mine - credits - paid).toFixed(2)
    if (Number(delta) !== 0) { await D.query(`UPDATE ${q(DS)}.parties SET balance = balance + $1::numeric WHERE id = $2::uuid`, [delta, M.get(p.id)]); balanceDeltas.push({ id: M.get(p.id)!, delta }) }
  }

  // counters move past every imported number
  const bump = async (insSql: string, ins: any[], updSql: string, upd: any[]) => { const r = await D.query(updSql, upd); if (!r.rowCount) await D.query(insSql, ins) }
  const fin = (n: string, ch: Map<string, Map<string, string>>, scope: string) => ch.get(scope)?.get(n) ?? n
  const lrMax = new Map<string, number>(), tripMax = new Map<string, number>(), invMax = new Map<string, number>()
  for (const l of keepLr) { const n = fin(l.lrNo, lrCh, String(M.get(l.branchId))); const m = /^LR-(\d{4})-(\d+)$/.exec(n); if (m) { const k = `${M.get(l.branchId)}|${m[1]}`; lrMax.set(k, Math.max(lrMax.get(k) ?? 0, Number(m[2]))) } }
  for (const t of keepTrip) { const n = fin(t.tripNo, tripCh, String(M.get(t.branchId))); const m = /^TRP-(\d{4})-(\d+)$/.exec(n); if (m) { const k = `${M.get(t.branchId)}|${m[1]}`; tripMax.set(k, Math.max(tripMax.get(k) ?? 0, Number(m[2]))) } }
  for (const i of keepInv) {
    const n = fin(i.number, invCh, `${M.get(i.branchId)}|${i.txnType}`)
    const a = /^[A-Za-z]+-(\d{2})-(\d+)$/.exec(n); const p = /^(?:.*?)(\d+)$/.exec(n)
    const fy = a ? a[1] : 'plain', v = a ? Number(a[2]) : p ? Number(p[1]) : 0
    const k = `${M.get(i.branchId)}|${i.txnType}|${fy}`; invMax.set(k, Math.max(invMax.get(k) ?? 0, v))
  }
  for (const [k, v] of lrMax) { const [b, fy] = k.split('|'); await bump(`INSERT INTO ${q(DS)}.transport_counters ("branchId", kind, fy, "lastVal") VALUES ($1::uuid,'lr',$2,$3)`, [b, fy, v], `UPDATE ${q(DS)}.transport_counters SET "lastVal" = GREATEST("lastVal", $1) WHERE "branchId" = $2::uuid AND kind = 'lr' AND fy = $3`, [v, b, fy]) }
  for (const [k, v] of tripMax) { const [b, fy] = k.split('|'); await bump(`INSERT INTO ${q(DS)}.transport_counters ("branchId", kind, fy, "lastVal") VALUES ($1::uuid,'trip',$2,$3)`, [b, fy, v], `UPDATE ${q(DS)}.transport_counters SET "lastVal" = GREATEST("lastVal", $1) WHERE "branchId" = $2::uuid AND kind = 'trip' AND fy = $3`, [v, b, fy]) }
  for (const [k, v] of invMax) { const [b, t, fy] = k.split('|'); await bump(`INSERT INTO ${q(DS)}.invoice_sequences (branch_id, txn_type, fy, current_val) VALUES ($1::uuid,$2,$3,$4)`, [b, t, fy, v], `UPDATE ${q(DS)}.invoice_sequences SET current_val = GREATEST(current_val, $1) WHERE branch_id = $2::uuid AND txn_type = $3 AND fy = $4`, [v, b, t, fy]) }

  // ── checks on what was just written ─────────────────────────────────────────────────────────────────────────────
  const problems: string[] = []
  const ids = (l: Row[]) => l.map((r) => M.get(r.id))
  const dangling = async (table: string, col: string, ref: string, list: Row[]) => {
    const r = await D.query(`SELECT count(*)::int n FROM ${q(DS)}.${q(table)} x WHERE x.id = ANY($1::uuid[]) AND x.${q(col)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(DS)}.${q(ref)} y WHERE y.id = x.${q(col)})`, [ids(list)])
    if (Number(r.rows[0].n)) problems.push(`${table}.${col} -> ${ref}: ${r.rows[0].n} dangling`)
  }
  await dangling('transport_lorry_receipts', 'tripId', 'transport_trips', keepLr); await dangling('transport_lorry_receipts', 'invoiceId', 'invoices', keepLr)
  await dangling('transport_lorry_receipts', 'vehicleId', 'transport_vehicles', keepLr); await dangling('transport_lorry_receipts', 'consignorId', 'parties', keepLr)
  await dangling('transport_lorry_receipts', 'consigneeId', 'parties', keepLr); await dangling('transport_trips', 'vehicleId', 'transport_vehicles', keepTrip)
  await dangling('transport_trips', 'driverId', 'transport_drivers', keepTrip); await dangling('transport_expenses', 'tripId', 'transport_trips', keepTExp)
  await dangling('transport_expenses', 'vehicleId', 'transport_vehicles', keepTExp); await dangling('invoices', 'partyId', 'parties', keepInv)
  await dangling('invoices', 'linkedInvoiceId', 'invoices', keepInv); await dangling('payments', 'partyId', 'parties', keepPay)
  await dangling('payment_allocations', 'paymentId', 'payments', keepAlloc); await dangling('payment_allocations', 'invoiceId', 'invoices', keepAlloc)
  await dangling('invoice_items', 'invoiceId', 'invoices', keepItems)
  const sumSrc = keepInv.reduce((a, i) => a + Number(i.grandTotal), 0)
  const sumDst = Number((await D.query(`SELECT COALESCE(SUM("grandTotal"),0)::numeric s FROM ${q(DS)}.invoices WHERE id = ANY($1::uuid[])`, [ids(keepInv)])).rows[0].s)
  if (Math.abs(sumSrc - sumDst) > 0.005) problems.push(`bill totals differ: ${sumSrc} vs ${sumDst}`)
  const dupNo = await D.query(`SELECT count(*)::int n FROM (SELECT "branchId","lrNo" FROM ${q(DS)}.transport_lorry_receipts GROUP BY 1,2 HAVING count(*)>1) z`)
  if (Number(dupNo.rows[0].n)) problems.push('duplicate LR numbers')

  say(`\n${APPLY ? 'MERGE' : 'DRY RUN'}  ${SS}  →  ${DS}`)
  say(`skipped as browser-test leftovers: ${junkCount.parties} customers, ${junkCount.loads} loads, ${junkCount.trips} trips, ${junkCount.bills} bills`)
  say(`skipped because the target already has them: ${dupInv.size} bills, ${dupLr.size} loads, ${dupTrip.size} trips, ${dupPay.size} payments, ${dupExp.size} office costs`)
  say(`reused (already on target): ${reused.parties.length} customers, ${reused.vehicles} trucks, ${reused.drivers} drivers, ${reused.routes} routes`)
  say('inserted (new on the target):'); for (const [t, n] of Object.entries(inserted)) say(`  ${t.padEnd(26)} ${n}`)
  const cnt = (m: Map<string, Map<string, string>>) => [...m.values()].reduce((a, x) => a + x.size, 0)
  say(`renumbered because they clashed: ${cnt(lrCh)} LR numbers, ${cnt(tripCh)} trip numbers, ${cnt(invCh)} bill numbers`)
  say(`bill value imported: ${sumDst.toFixed(2)}`)
  if (problems.length) { say('\nPROBLEMS — nothing will be saved:'); problems.forEach((p) => say('  ✗ ' + p)); throw new Error('checks failed') }
  say('checks: no dangling links, bill totals equal, no duplicate LR numbers  ✓')

  await D.query(`INSERT INTO ${q(DS)}."_merge_log" (sig, detail) VALUES ($1, $2)`, [sig, JSON.stringify({ counts: inserted, ids: insertedIds, balanceDeltas })])
  await D.query(APPLY ? 'COMMIT' : 'ROLLBACK')
  say(APPLY ? '\nCOMMITTED. To remove exactly what was added: --undo --apply' : '\nDry run only — rolled back, nothing changed. Run again with --apply to keep it.')
} catch (e: any) {
  await D.query('ROLLBACK').catch(() => {})
  console.error('\nFAILED, nothing was saved:', e?.message ?? e)
  process.exitCode = 1
} finally { await S.end(); await D.end() }
