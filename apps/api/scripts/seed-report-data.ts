// apps/api/scripts/seed-report-data.ts
// =============================================================================
// Fills the *existing* demo tenant so every CA / profit report has months of data to show:
//   Rajhansh Roadways   ~22 older trips (Apr → Sep) with diesel / toll / bhatta, freight bills per customer and month
//                       (forward + RCM GST, TDS), receipts by bank / UPI / cheque / cash, pump payments, office costs,
//                       and a bank statement that mostly matches — with a few lines left for you to classify.
//   Rajhansh Enterprise goods bills Apr → Oct, receipts, office costs, a bank statement.
// Drives the real HTTP API, like seed-demo.ts. Run it once; it does nothing if its data is already there.
//
//   pnpm --filter @billing/api exec tsx --env-file=.env scripts/seed-report-data.ts
//   API_URL=https://… (env) points it at another server.
// =============================================================================

const API = process.env['API_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3100}`
const MARK = 'Demo: report history'

let token = '', refresh = ''
async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`)
  return data as T
}
const get = <T = any>(p: string) => call<T>('GET', p)
const post = <T = any>(p: string, b?: unknown) => call<T>('POST', p, b ?? {})
const del = <T = any>(p: string) => call<T>('DELETE', p)

const IST = 5.5 * 3600_000
const day = (offset: number) => new Date(Date.now() + IST + offset * 86_400_000).toISOString().slice(0, 10)
const TODAY = day(0)
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const capToday = (d: string) => (d > TODAY ? TODAY : d)
const monthOf = (d: string) => d.slice(0, 7)
const lastOfMonth = (m: string) => { const [y, mm] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10) }
const log = (m: string) => console.log(`  ${m}`)
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

async function switchFirm(id: string) {
  const r = await post('/api/auth/switch-branch', { branchId: id, refreshToken: refresh })
  token = r.accessToken
}

type StmtRow = { date: string; description: string; refNo: string; debit: number; credit: number }
/** Sort, add a running balance, and import. Returns how many lines were added. */
async function importStatement(acctId: string, fileName: string, opening: number, rows: StmtRow[]) {
  rows.sort((a, b) => a.date.localeCompare(b.date))
  let bal = opening
  const withBal = rows.map((r) => { bal = r2(bal + r.credit - r.debit); return { ...r, balance: bal } })
  const out = await post(`/api/transport/bank/accounts/${acctId}/import`, { fileName, rows: withBal })
  return out.added ?? 0
}

async function bankAccount(name: string, bankName: string, ifsc: string, acctNo: string) {
  const list: any[] = await get('/api/transport/bank/accounts')
  const found = list.find((a) => a.name === name)
  if (found) return found
  return post('/api/transport/bank/accounts', { name, bankName, ifscCode: ifsc, accountNumber: acctNo, openingBalance: 0 })
}

/** Wipe an earlier, untouched import (the quick test file) so the full statement is not mixed with it. */
async function clearUntouchedImports(acctId: string) {
  const imps: any[] = await get(`/api/transport/bank/accounts/${acctId}/imports`)
  for (const i of imps) if (Number(i.touched) === 0) await del(`/api/transport/bank/imports/${i.id}`).catch(() => {})
}

async function autoThenLabel(acctId: string, labels: Array<[RegExp, string]>) {
  const auto = await post(`/api/transport/bank/accounts/${acctId}/auto-match`)
  log(`auto-matched: ${auto.receipts} receipts, ${auto.pumps} pump payments, ${auto.expenses} expenses`)
  const lines = (await get<any>(`/api/transport/bank/accounts/${acctId}/lines?status=unmatched&limit=200`)).data as any[]
  let n = 0
  for (const l of lines) {
    const hit = labels.find(([re]) => re.test(l.description))
    if (!hit) continue
    await post(`/api/transport/bank/lines/${l.id}/match`, { kind: 'other', label: hit[1] })
    n++
  }
  log(`${n} lines labelled; ${lines.length - n} left for you to match`)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PUMPS = ['Sharma Petrol Pump', 'Patel Fuel Station', 'HP Bhagwati Pump', 'Shell Highway Fuels', 'Jay Ambe Fuel', 'Bharat Petroleum Neemrana']
type Lane = { from: string; to: string; km: number; rate: number }
const LANES: Lane[] = [
  { from: 'Surat', to: 'Ahmedabad', km: 265, rate: 950 }, { from: 'Vapi', to: 'Pune', km: 440, rate: 1700 }, { from: 'Surat', to: 'Mumbai', km: 280, rate: 1150 },
  { from: 'Rajkot', to: 'Surat', km: 470, rate: 1600 }, { from: 'Surat', to: 'Pune', km: 590, rate: 1500 }, { from: 'Mumbai', to: 'Surat', km: 280, rate: 1100 },
  { from: 'Ahmedabad', to: 'Surat', km: 265, rate: 900 }, { from: 'Surat', to: 'Delhi', km: 1170, rate: 3300 },
]
const CLASS = {
  ace: { kmplLoaded: 16, kmplEmpty: 18, tollPerKm: 0.9, bhatta: 500, tons: 0.9, mult: 6.5 },
  lcv: { kmplLoaded: 8, kmplEmpty: 10, tollPerKm: 1.8, bhatta: 0, tons: 5.5, mult: 1.9 },
  icv: { kmplLoaded: 6, kmplEmpty: 7.5, tollPerKm: 2.6, bhatta: 0, tons: 10.5, mult: 1.4 },
  hcv: { kmplLoaded: 4.2, kmplEmpty: 5, tollPerKm: 3.4, bhatta: 0, tons: 24, mult: 1.0 },
} as const
const ALL_TRUCKS: Array<{ reg: string; cls: keyof typeof CLASS; driver?: string }> = [
  { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish' }, { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan' }, { reg: 'GJ06AT5577', cls: 'hcv', driver: 'Rajesh' },
  { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil' }, { reg: 'GJ01DD3308', cls: 'hcv' },
]
const CONSIGNORS = ['Arvind', 'Sagar', 'Shree', 'Mehta']
const CONSIGNEES = ['Bharat', 'Kumar', 'Mehta', 'Shree', 'Arvind']
// who cuts TDS and at what rate
const TDS_RATE: Record<string, number> = { Arvind: 1, Sagar: 2 }
const GOODS = ['Grey fabric rolls', 'Industrial chemicals (drums)', 'TMT steel bars', 'FMCG cartons', 'Cotton bales', 'Auto components', 'Ceramic tiles']

async function roadways(firmId: string) {
  console.log('\nRajhansh Roadways')
  await switchFirm(firmId)
  const trips = await get<any>('/api/transport/trips?limit=200')
  if (trips.data.filter((t: any) => t.notes === MARK && t.status === 'completed').length >= 20) { console.log('  already seeded — skipping'); return }

  const vehicles: any[] = await get('/api/transport/vehicles')
  const drivers: any[] = await get('/api/transport/drivers')
  const parties: any[] = (await get<any>('/api/parties?limit=200')).data
  const need = <T,>(x: T | undefined, what: string): T => { if (!x) throw new Error(`${what} not found`); return x }
  const veh = (reg: string) => need(vehicles.find((v) => v.regNo === reg), `vehicle ${reg}`)
  const drv = (n: string) => need(drivers.find((d: any) => d.name.startsWith(n)), `driver ${n}`)
  const party = (n: string) => need(parties.find((p) => p.name.startsWith(n)), `party ${n}`)
  // trucks that are out on a running trip (or whose driver is) cannot take a back-dated run
  const busyDrivers = new Set((drivers as any[]).filter((d) => d.onTrip ?? d.on_trip).map((d: any) => d.name))
  const TRUCKS = ALL_TRUCKS.filter((t) => veh(t.reg).status === 'available' && (!t.driver || !busyDrivers.has(drv(t.driver).name)))
  if (!TRUCKS.length) throw new Error('every truck is on a trip right now')
  log(`using trucks: ${TRUCKS.map((t) => t.reg).join(', ')}`)

  // 1. trips, oldest first, about one every 8 days from late March to last month
  type Done = { lrId: string; consignor: string; date: string }
  const done: Done[] = []
  const N = 22
  for (let i = 0; i < N; i++) {
    const ago = 200 - Math.round(i * (170 / (N - 1)))      // 200 → 30 days ago
    const t = TRUCKS[i % TRUCKS.length]!, c = CLASS[t.cls], lane = LANES[(i * 3) % LANES.length]!
    const consignor = CONSIGNORS[i % CONSIGNORS.length]!, consignee = CONSIGNEES[(i + 2) % CONSIGNEES.length]!
    const payer = (['account', 'driver', 'owner'] as const)[i % 3]!
    const tons = Math.round(c.tons * (0.85 + (i % 4) * 0.07) * 10) / 10
    const rate = Math.round(lane.rate * c.mult / 10) * 10
    const vehicle = veh(t.reg), driver = t.driver ? drv(t.driver) : undefined, start = day(-ago)
    const lr = await post('/api/transport/lrs', {
      lrDate: start, consignorId: party(consignor).id, consigneeId: party(consignee).id, fromCity: lane.from, toCity: lane.to,
      goodsDescription: GOODS[i % GOODS.length], packages: 30 + i * 11, packageType: ['Bales', 'Cartons', 'Drums', 'Bundles'][i % 4],
      actualWeightKg: Math.round(tons * 1000), weightBasis: 'load', freightType: 'tbb', rateBasis: 'per_ton', rate, invoiceRefs: `INV/${7000 + i * 17}`,
    })
    const trip = await post('/api/transport/trips', {
      vehicleId: vehicle.id, driverId: driver?.id, helperName: driver ? undefined : "Attached owner's driver", fromCity: lane.from, toCity: lane.to,
      startDate: start, driverAdvance: driver ? Math.round(lane.km * 11 / 100) * 100 : 0, lrIds: [lr.id], notes: MARK,
    })
    const odo = vehicle.currentOdometer
    await post(`/api/transport/trips/${trip.id}/start`, { startOdometer: odo })
    const total = Math.round(lane.km / c.kmplLoaded + lane.km / c.kmplEmpty)
    const rate0 = 86.5 + (i % 7) * 0.7
    const pay = payer === 'account' ? { paidBy: 'vendor_credit', vendorName: PUMPS[i % PUMPS.length], paymentMode: 'credit' }
      : payer === 'driver' ? { paidBy: 'driver', paymentMode: 'cash' } : { paidBy: 'company', paymentMode: 'upi' }
    await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: total, ratePerLitre: rate0, expenseDate: start, odometer: odo + 4, location: lane.from, ...pay })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'toll', amount: Math.round(lane.km * c.tollPerKm), expenseDate: start, paidBy: 'company', paymentMode: 'fastag' })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'driver_bhatta', amount: c.bhatta || Math.round(lane.km / 280 * 650) + 400, expenseDate: start, paidBy: 'driver', paymentMode: 'cash' })
    if (i % 4 === 2) await post('/api/transport/expenses', { tripId: trip.id, category: 'loading_unloading', amount: 800 + i * 50, expenseDate: start, paidBy: 'driver', paymentMode: 'cash' })
    if (i % 7 === 3) await post('/api/transport/expenses', { tripId: trip.id, category: 'repair', amount: 2800 + i * 90, expenseDate: addDays(start, 1), paidBy: 'company', paymentMode: 'bank_transfer', notes: 'Breakdown on the road' })
    const end = addDays(start, Math.max(2, Math.round(lane.km / 400) + 1))
    await post(`/api/transport/lrs/${lr.id}/deliver`, { deliveredAt: `${end}T10:00:00.000Z`, receivedBy: 'Store keeper' })
    await post(`/api/transport/lrs/${lr.id}/pod`, { podNotes: 'Signed copy received' })
    await post(`/api/transport/trips/${trip.id}/complete`, { endDate: end, endOdometer: odo + lane.km * 2 })
    vehicle.currentOdometer = odo + lane.km * 2
    done.push({ lrId: lr.id, consignor, date: start })
  }
  log(`${done.length} older trips`)

  // 2. one freight bill per customer per month (billed a few days after the month ends)
  const groups = new Map<string, Done[]>()
  for (const d of done) { const k = `${d.consignor}|${monthOf(d.date)}`; groups.set(k, [...(groups.get(k) ?? []), d]) }
  type Bill = { id: string; number: string; party: string; partyId: string; date: string; grand: number; tds: number }
  const bills: Bill[] = []
  let gi = 0
  for (const [k, lrs] of [...groups.entries()].sort((a, b) => a[0].split('|')[1]!.localeCompare(b[0].split('|')[1]!))) {
    const [consignor, month] = k.split('|') as [string, string]
    const date = capToday(addDays(lastOfMonth(month), 3 + (gi % 4)))
    const tdsRate = TDS_RATE[consignor]
    const gstMode = gi % 3 === 0 ? 'rcm' : 'forward_5'
    const r = await post('/api/transport/bills', { partyId: party(consignor).id, lrIds: lrs.map((l) => l.lrId), date, gstMode, ...(tdsRate ? { tdsApplicable: true, tdsRatePct: tdsRate } : {}) })
    const inv = await get<any>(`/api/invoices/${r.invoice.id}`)
    bills.push({ id: inv.id, number: inv.invoiceNumber ?? r.invoice.number, party: consignor, partyId: party(consignor).id, date, grand: Number(inv.grandTotal), tds: Number(inv.domainData?.tds_amount ?? 0) })
    gi++
  }
  log(`${bills.length} freight bills`)

  // 3. receipts: a mix of full / part / cheque / cash / unpaid, TDS cut where the customer does
  const stmt: StmtRow[] = []
  let utr = 0
  for (const [i, b] of bills.entries()) {
    const kind = i % 6
    if (kind === 5) continue                                            // unpaid — shows up as receivable
    const payDate = capToday(addDays(b.date, 9 + (i % 5) * 4))
    const net = r2(b.grand - b.tds)
    const full = kind === 0 || kind === 1 || kind === 3
    const amount = full ? net : r2(Math.round(net * 0.6 / 100) * 100)
    const method = kind === 0 || kind === 1 ? 'bank_transfer' : kind === 2 ? 'upi' : kind === 3 ? 'cheque' : 'cash'
    const refNo = method === 'cash' ? undefined : method === 'cheque' ? String(480100 + i) : `UTIBN${payDate.replace(/-/g, '').slice(2)}${String(++utr).padStart(4, '0')}`
    await post('/api/payments', { partyId: b.partyId, amount, method, refNo, paymentDate: payDate, allocations: [{ invoiceId: b.id, amount }] })
    if (b.tds > 0 && full) await post(`/api/transport/bills/${b.id}/tds`, { paymentDate: payDate })
    if (method !== 'cash') {
      const nm = b.party.toUpperCase()
      stmt.push({ date: addDays(payDate, method === 'cheque' ? 2 : 0), refNo: refNo ?? '', debit: 0, credit: amount,
        description: method === 'bank_transfer' ? `NEFT*${refNo}*${nm} INDUSTRIES` : method === 'upi' ? `UPI/CR/${refNo}/${nm}` : `CHQ DEP ${refNo} ${nm}` })
    }
  }
  log('receipts, TDS and statement credits recorded')

  // 4. pay the pumps' older bills by bank transfer (one payment per pump)
  const payables = await get<any>('/api/transport/expenses/payables')
  const cutoff = day(-45)
  let pn = 0
  for (const g of payables.data as any[]) {
    const old = (g.bills as any[]).filter((b) => String(b.expenseDate).slice(0, 10) < cutoff)
    if (old.length === 0) continue
    const settledOn = capToday(addDays(old.map((b) => String(b.expenseDate).slice(0, 10)).sort().pop()!, 12))
    await post('/api/transport/expenses/settle', { ids: old.map((b) => b.id), settledOn, mode: 'bank_transfer' })
    stmt.push({ date: settledOn, refNo: `${600000000000 + pn * 7919}`, debit: r2(old.reduce((t, b) => t + Number(b.amount), 0)), credit: 0, description: `UPI/DR/${600000000000 + pn * 7919}/${String(g.vendor).toUpperCase()}` })
    pn++
  }
  log(`${pn} pump payments`)

  // 5. office costs every month, paid by bank (GST inside where it applies)
  const months: string[] = []
  for (let m = '2026-04'; m <= TODAY.slice(0, 7); m = monthOf(addDays(`${m}-15`, 31))) months.push(m)
  const office = async (category: string, label: string, amount: number, gstRate: number, date: string, desc: string) => {
    await post('/api/expenses', { category, amount, gstRate, paymentMode: 'bank', date, description: desc })
    stmt.push({ date, refNo: '', debit: amount, credit: 0, description: `${label} ${desc}`.toUpperCase() })
  }
  for (const m of months) {
    await office('rent', 'NEFT RENT', 25000, 18, capToday(`${m}-05`), `Yard rent ${m}`)
    await office('electricity', 'BBPS ELECTRICITY', 3800 + (months.indexOf(m) % 3) * 450, 0, capToday(`${m}-12`), `Electricity ${m}`)
    await office('internet', 'AUTOPAY BROADBAND', 1180, 18, capToday(`${m}-08`), `Broadband ${m}`)
    await office('staff', 'NEFT SALARY', 42000, 0, capToday(`${m}-28`) , `Office staff salary ${m}`)
  }
  await office('insurance', 'NEFT INSURANCE', 58400, 18, '2026-06-18', 'Fleet insurance renewal')
  await office('emi', 'ECS EMI', 71500, 0, '2026-04-10', 'Truck loan EMI')
  for (const m of months.slice(1)) await office('emi', 'ECS EMI', 71500, 0, capToday(`${m}-10`), `Truck loan EMI ${m}`)
  log(`office costs for ${months.length} months`)

  // 6. things only the bank knows about
  for (const [i, m] of months.entries()) {
    stmt.push({ date: capToday(`${m}-20`), refNo: '', debit: 118, credit: 0, description: 'SMS CHARGES AND AMC' })
    stmt.push({ date: capToday(`${m}-26`), refNo: '', debit: 60000, credit: 0, description: 'NEFT TRANSFER TO OWNER SAVINGS' })
    stmt.push({ date: capToday(`${m}-02`), refNo: '', debit: 15000 + (i % 3) * 5000, credit: 0, description: 'FASTAG RECHARGE ICICI' })
  }
  stmt.push({ date: '2026-06-30', refNo: '', debit: 0, credit: 2140.5, description: 'INT PD ON SAVINGS' }, { date: '2026-09-30', refNo: '', debit: 0, credit: 2318.75, description: 'INT PD ON SAVINGS' })
  stmt.push({ date: '2026-08-14', refNo: 'IMPS5821', debit: 0, credit: 35000, description: 'IMPS FROM UNKNOWN SENDER' })
  stmt.push({ date: '2026-09-09', refNo: '', debit: 18500, credit: 0, description: 'NEFT TO RAMESH TRADERS' })
  stmt.push({ date: '2026-07-22', refNo: '', debit: 0, credit: 120000, description: 'CASH DEPOSIT SELF' })

  // 7. the statement
  const acct = await bankAccount('SBI Current', 'SBI', 'SBIN0060050', '31234567890')
  await clearUntouchedImports(acct.id)
  const added = await importStatement(acct.id, 'SBI_current_Apr-Oct_2026.csv', 1500000, stmt)
  log(`SBI Current: ${added} statement lines imported`)
  await autoThenLabel(acct.id, [[/SMS CHARGES/, 'Bank charges'], [/TRANSFER TO OWNER/, 'Owner drawings'], [/INT PD/, 'Interest received'], [/CASH DEPOSIT/, 'Other']])
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function enterprise(firmId: string) {
  console.log('\nRajhansh Enterprise')
  await switchFirm(firmId)
  const axis = ((await get<any[]>('/api/transport/bank/accounts')) ?? []).find((x: any) => x.name === 'Axis Current')
  if (axis && axis.lines > 0) { console.log('  already seeded — skipping'); return }

  // customers belong to one firm: use this firm's own, and copy a few across from the other firm until there are four
  const all: any[] = (await get<any>('/api/parties?limit=200')).data.filter((p: any) => p.type === 'customer' || p.type === 'both')
  const customers: any[] = all.filter((p) => p.branchId === firmId).slice(0, 4)
  for (const src of all.filter((p) => p.branchId !== firmId)) {
    if (customers.length >= 4) break
    if (customers.some((c) => String(c.name).toLowerCase() === String(src.name).toLowerCase())) continue
    try {
      const copied = await post('/api/transport/parties/copy', { fromPartyId: src.id })
      customers.push(copied.party ?? copied)
    } catch (e: any) {
      if (/already in this firm/.test(String(e.message))) customers.push(src)         // it is this firm's own customer
      else throw e
    }
  }
  if (customers.length === 0) throw new Error('no customers to bill')

  const PRODUCTS = [
    { description: 'FLYASH FROM KUTCH', hsnSacCode: '26219000', unit: 'MT', rate: 350, gstRate: 5 },
    { description: 'PORTLAND CEMENT PPC (BAGS)', hsnSacCode: '25232930', unit: 'BAG', rate: 335, gstRate: 28 },
    { description: 'RIVER SAND', hsnSacCode: '25059010', unit: 'MT', rate: 820, gstRate: 5 },
  ]
  const bills: Array<{ id: string; date: string; partyId: string; party: string; grand: number }> = []
  const dates = ['2026-04-12', '2026-05-06', '2026-05-27', '2026-06-18', '2026-07-09', '2026-08-04', '2026-08-26', '2026-09-15', '2026-10-06']
  // a re-run after a partial failure picks up the bills already made on those dates
  const existing: any[] = (await get<any>('/api/invoices?limit=100')).data ?? []
  for (const [i, date] of dates.entries()) {
    const c = customers[i % customers.length]!, p = PRODUCTS[i % PRODUCTS.length]!
    const have = existing.find((x: any) => String(x.date).slice(0, 10) === date && (x.party?.id ?? x.partyId) === c.id && x.status !== 'cancelled')
    if (have) {
      const inv = await get<any>(`/api/invoices/${have.id}`)
      bills.push({ id: inv.id, date, partyId: c.id, party: String(c.name), grand: Number(inv.grandTotal) })
      continue
    }
    const qty = p.unit === 'BAG' ? 150 + i * 12 : p.description.startsWith('RIVER') ? 40 + i * 6 : 110 + i * 14
    const r = await post('/api/transport/goods-bills', { partyId: c.id, date, items: [{ ...p, qty, rate: p.rate + (i % 3) * 5 }] })
    const inv = await get<any>(`/api/invoices/${r.invoice.id}`)
    bills.push({ id: inv.id, date, partyId: c.id, party: String(c.name), grand: Number(inv.grandTotal) })
  }
  log(`${bills.length} goods bills`)

  const stmt: StmtRow[] = []
  let utr = 0
  for (const [i, b] of bills.entries()) {
    if (i % 4 === 3) continue                                            // left unpaid
    const payDate = capToday(addDays(b.date, 11 + (i % 3) * 6))
    const full = i % 3 !== 1
    const amount = full ? b.grand : r2(Math.round(b.grand * 0.5 / 100) * 100)
    const method = i % 2 === 0 ? 'bank_transfer' : 'upi'
    const refNo = `AXISN${payDate.replace(/-/g, '').slice(2)}${String(++utr).padStart(4, '0')}`
    await post('/api/payments', { partyId: b.partyId, amount, method, refNo, paymentDate: payDate, allocations: [{ invoiceId: b.id, amount }] })
    stmt.push({ date: payDate, refNo, debit: 0, credit: amount, description: method === 'upi' ? `UPI/CR/${refNo}/${b.party.toUpperCase().slice(0, 18)}` : `NEFT*${refNo}*${b.party.toUpperCase().slice(0, 18)}` })
  }

  const months: string[] = []
  for (let m = '2026-04'; m <= TODAY.slice(0, 7); m = monthOf(addDays(`${m}-15`, 31))) months.push(m)
  for (const m of months) {
    for (const [category, label, amount, gst, d, desc] of [
      ['electricity', 'BBPS ELECTRICITY', 2200, 0, `${m}-14`, `Electricity ${m}`],
      ['staff', 'NEFT SALARY', 24000, 0, `${m}-28`, `Godown staff ${m}`],
    ] as const) {
      const date = capToday(d)
      await post('/api/expenses', { category, amount, gstRate: gst, paymentMode: 'bank', date, description: desc })
      stmt.push({ date, refNo: '', debit: amount, credit: 0, description: `${label} ${desc}`.toUpperCase() })
    }
    stmt.push({ date: capToday(`${m}-21`), refNo: '', debit: 118, credit: 0, description: 'SMS CHARGES AND AMC' })
  }
  await post('/api/expenses', { category: 'misc', amount: 9000, gstRate: 18, paymentMode: 'bank', date: '2026-07-15', description: 'Accountant fee' })
  stmt.push({ date: '2026-07-15', refNo: '', debit: 9000, credit: 0, description: 'NEFT ACCOUNTANT FEE' })
  stmt.push({ date: '2026-06-10', refNo: '', debit: 150000, credit: 0, description: 'NEFT TO ROADWAYS CURRENT A/C' })
  stmt.push({ date: '2026-09-04', refNo: '', debit: 0, credit: 60000, description: 'IMPS FROM UNKNOWN SENDER' })
  log('receipts and office costs recorded')

  const acct = await bankAccount('Axis Current', 'Axis Bank', 'UTIB0001591', '541010200000471')
  await clearUntouchedImports(acct.id)
  const added = await importStatement(acct.id, 'Axis_current_Apr-Oct_2026.csv', 300000, stmt)
  log(`Axis Current: ${added} statement lines imported`)
  await autoThenLabel(acct.id, [[/SMS CHARGES/, 'Bank charges'], [/TO ROADWAYS/, 'Transfer between own accounts']])
}

async function main() {
  console.log(`Seeding report data against ${API}`)
  const login = await post('/api/auth/login', { tenantPhone: '9100000001', phone: '9100000001', pin: '1111' })
  token = login.accessToken; refresh = login.refreshToken
  const firms: any[] = (await get<any>('/api/transport/firms')).firms
  const rw = firms.find((f) => f.kind === 'transport'), en = firms.find((f) => f.kind === 'goods')
  if (rw) await roadways(rw.id)
  if (en) await enterprise(en.id)
  console.log('\nDone.')
}

main().catch((e) => { console.error('\nFailed:', e.message ?? e); process.exit(1) })
