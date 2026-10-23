// apps/api/scripts/seed-more-trips.ts
// =============================================================================
// Adds more truck trips (with diesel / toll / bhatta, paid by driver, owner or on account at a pump) to the
// *existing* demo tenant, so trip profit, driver cash, hired-truck rent and pump payables have something to show.
// Drives the real HTTP API, like seed-demo.ts.
//
//   pnpm --filter @billing/api exec tsx --env-file=.env scripts/seed-more-trips.ts              # batch 1
//   BATCH=2 pnpm --filter @billing/api exec tsx --env-file=.env scripts/seed-more-trips.ts      # batch 2
//   API_URL=https://… (env) points it at another server (e.g. the live API).
//
// Idempotent per batch: does nothing if that batch's trips are already there. Batch 2 uses trucks batch 1 did
// not (the market-hire truck, the trailer) and dates the shared trucks into the gaps between batch 1's runs.
// =============================================================================

const API = process.env['API_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3100}`
const BATCH = Number(process.env['BATCH'] ?? 1)
const MARK = BATCH === 1 ? 'Demo: extra trips' : `Demo: more trips (${BATCH})`

let token = ''
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
const get  = <T = any>(p: string) => call<T>('GET', p)
const post = <T = any>(p: string, b?: unknown) => call<T>('POST', p, b ?? {})

const IST = 5.5 * 3600_000
const day = (offset: number) => new Date(Date.now() + IST + offset * 86_400_000).toISOString().slice(0, 10)
const log = (m: string) => console.log(`  ${m}`)

// Pumps the owner has accounts with.
const PUMPS = ['Sharma Petrol Pump', 'Patel Fuel Station', 'HP Bhagwati Pump', 'Shell Highway Fuels', 'Jay Ambe Fuel', 'Bharat Petroleum Neemrana']
const HOME_PUMP: Record<string, string> = { Surat: PUMPS[0]!, Vapi: PUMPS[1]!, Rajkot: PUMPS[2]!, Mumbai: PUMPS[3]!, Ahmedabad: PUMPS[4]! }

type Lane = { from: string; to: string; km: number; rate: number }
const L = {
  suratAhm: { from: 'Surat',  to: 'Ahmedabad', km: 265,  rate: 950 },
  vapiPune: { from: 'Vapi',   to: 'Pune',      km: 440,  rate: 1700 },
  suratDel: { from: 'Surat',  to: 'Delhi',     km: 1170, rate: 3300 },
  suratMum: { from: 'Surat',  to: 'Mumbai',    km: 280,  rate: 1150 },
  rajSurat: { from: 'Rajkot', to: 'Surat',     km: 470,  rate: 1600 },
  mumSurat: { from: 'Mumbai', to: 'Surat',     km: 280,  rate: 1100 },
  suratPune:{ from: 'Surat',  to: 'Pune',      km: 590,  rate: 1500 },
  ahmSurat: { from: 'Ahmedabad', to: 'Surat',  km: 265,  rate: 900 },
} satisfies Record<string, Lane>

// Truck classes: realistic diesel mileage (km/litre loaded, empty on the way back) and toll per km.
const CLASS = {
  ace: { kmplLoaded: 16,  kmplEmpty: 18,  tollPerKm: 0.9, bhatta: 500 },   // Tata Ace
  lcv: { kmplLoaded: 8,   kmplEmpty: 10,  tollPerKm: 1.8, bhatta: 0 },     // Tata 407
  icv: { kmplLoaded: 6,   kmplEmpty: 7.5, tollPerKm: 2.6, bhatta: 0 },     // Eicher 3015
  hcv: { kmplLoaded: 4.2, kmplEmpty: 5,   tollPerKm: 3.4, bhatta: 0 },     // container / trailer
} as const

type Payer = 'account' | 'driver' | 'owner' | 'none'   // 'none' = a hired truck: its owner buys the diesel
type Row = {
  reg: string; cls: keyof typeof CLASS; driver?: string; lane: Lane; ago: number
  from: string; to: string; tons: number; rate: number; payer: Payer
  hire?: [charges: number, advance: number]            // market truck: rent agreed, part paid up front
}
type Running = { reg: string; cls: keyof typeof CLASS; driver: string; lane: Lane; from: string; to: string; tons: number; rate: number
  litres: number; payer: Payer; advance: number }

const BATCHES: Record<number, { rows: Row[]; running: Running; settle: { pumps: string[]; olderThanDays: number } }> = {
  1: {
    rows: [
      { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish', lane: L.suratAhm, ago: 27, from: 'Arvind', to: 'Shree',  tons: 5.5, rate: 1900, payer: 'account' },
      { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan',  lane: L.vapiPune, ago: 25, from: 'Sagar',  to: 'Bharat', tons: 10.5, rate: 2100, payer: 'account' },
      { reg: 'GJ06AT5577', cls: 'hcv', driver: 'Rajesh', lane: L.suratDel, ago: 24, from: 'Arvind', to: 'Kumar',  tons: 24,  rate: 3300, payer: 'account' },
      { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil',  lane: L.suratAhm, ago: 21, from: 'Arvind', to: 'Mehta',  tons: 0.9, rate: 6000, payer: 'driver' },
      { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish', lane: L.rajSurat, ago: 18, from: 'Shree',  to: 'Arvind', tons: 5.5, rate: 2600, payer: 'account' },
      { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan',  lane: L.mumSurat, ago: 15, from: 'Mehta',  to: 'Sagar',  tons: 11,  rate: 1500, payer: 'owner' },
      { reg: 'GJ06AT5577', cls: 'hcv', driver: 'Rajesh', lane: L.suratMum, ago: 12, from: 'Arvind', to: 'Mehta',  tons: 25,  rate: 1150, payer: 'account' },
      { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil',  lane: L.suratMum, ago:  9, from: 'Arvind', to: 'Bharat', tons: 0.9, rate: 6800, payer: 'driver' },
      { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish', lane: L.vapiPune, ago:  6, from: 'Sagar',  to: 'Bharat', tons: 5.8, rate: 2700, payer: 'account' },
      { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan',  lane: L.suratMum, ago:  4, from: 'Arvind', to: 'Mehta',  tons: 11,  rate: 1500, payer: 'account' },
    ],
    running: { reg: 'GJ06AT5577', cls: 'hcv', driver: 'Rajesh', lane: L.suratMum, from: 'Mehta', to: 'Sagar', tons: 22, rate: 1150, litres: 160, payer: 'account', advance: 6000 },
    settle: { pumps: [PUMPS[0]!, PUMPS[1]!], olderThanDays: 14 },
  },
  2: {
    rows: [
      // the 40-tonne trailer and the hired market truck were not used in batch 1
      { reg: 'GJ01DD3308', cls: 'hcv',                    lane: L.suratDel,  ago: 26, from: 'Arvind', to: 'Kumar',  tons: 36, rate: 3300, payer: 'account' },
      { reg: 'MH04KL2255', cls: 'hcv',                    lane: L.suratMum,  ago: 20, from: 'Mehta',  to: 'Bharat', tons: 18, rate: 1150, payer: 'none', hire: [15000, 6000] },
      { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish', lane: L.ahmSurat,  ago: 22, from: 'Shree',  to: 'Arvind', tons: 5.6, rate: 1700, payer: 'account' },
      { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan',  lane: L.suratPune, ago: 21, from: 'Arvind', to: 'Bharat', tons: 11, rate: 2400, payer: 'account' },
      { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil',  lane: L.suratMum,  ago: 15, from: 'Mehta',  to: 'Arvind', tons: 0.9, rate: 6800, payer: 'driver' },
      { reg: 'GJ01DD3308', cls: 'hcv',                    lane: L.suratPune, ago: 14, from: 'Sagar',  to: 'Bharat', tons: 34, rate: 1500, payer: 'account' },
      { reg: 'GJ05CA9042', cls: 'lcv', driver: 'Harish', lane: L.suratAhm,  ago: 12, from: 'Arvind', to: 'Shree',  tons: 5.2, rate: 1900, payer: 'owner' },
      { reg: 'MH04KL2255', cls: 'hcv',                    lane: L.vapiPune,  ago: 10, from: 'Sagar',  to: 'Bharat', tons: 19, rate: 1700, payer: 'none', hire: [24000, 10000] },
      { reg: 'GJ05CA1190', cls: 'icv', driver: 'Mohan',  lane: L.rajSurat,  ago: 10, from: 'Shree',  to: 'Arvind', tons: 11.5, rate: 2650, payer: 'account' },
      { reg: 'GJ01DD3308', cls: 'hcv',                    lane: L.suratMum,  ago:  6, from: 'Arvind', to: 'Mehta',  tons: 38, rate: 1150, payer: 'account' },
      { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil',  lane: L.suratAhm,  ago:  4, from: 'Arvind', to: 'Bharat', tons: 0.8, rate: 6000, payer: 'driver' },
    ],
    running: { reg: 'GJ05DE6140', cls: 'ace', driver: 'Sunil', lane: L.suratAhm, from: 'Arvind', to: 'Mehta', tons: 0.9, rate: 6000, litres: 30, payer: 'driver', advance: 2500 },
    settle: { pumps: [PUMPS[2]!, PUMPS[4]!, PUMPS[3]!], olderThanDays: 12 },
  },
}

async function main() {
  const plan = BATCHES[BATCH]
  if (!plan) throw new Error(`Unknown BATCH ${BATCH} (have ${Object.keys(BATCHES).join(', ')})`)
  console.log(`Adding more trips (batch ${BATCH}) against ${API}`)
  const login = await post('/api/auth/login', { tenantPhone: '9100000001', phone: '9100000001', pin: '1111' })
  token = login.accessToken

  const trips = await get<any>('/api/transport/trips?limit=200')
  if (trips.data.some((t: any) => t.notes === MARK)) { console.log('Those trips are already present — nothing to do.'); return }

  const vehicles: any[] = await get('/api/transport/vehicles')
  const drivers: any[] = await get('/api/transport/drivers')
  const parties: any[] = (await get<any>('/api/parties?limit=200')).data
  const need = <T,>(x: T | undefined, what: string): T => { if (!x) throw new Error(`${what} not found`); return x }
  const veh = (reg: string) => need(vehicles.find((v) => v.regNo === reg), `vehicle ${reg}`)
  const drv = (n: string) => need(drivers.find((d) => d.name.startsWith(n)), `driver ${n}`)
  const party = (n: string) => need(parties.find((p) => p.name.startsWith(n)), `party ${n}`)

  const goods = ['Grey fabric rolls', 'Industrial chemicals (drums)', 'TMT steel bars', 'FMCG cartons', 'Cotton bales', 'Auto components', 'Ceramic tiles']
  const bookLr = (lane: Lane, daysAgo: number, consignor: string, consignee: string, tons: number, i: number, rate = lane.rate) => post('/api/transport/lrs', {
    lrDate: day(-daysAgo), consignorId: party(consignor).id, consigneeId: party(consignee).id,
    fromCity: lane.from, toCity: lane.to, goodsDescription: goods[(i + BATCH) % goods.length],
    packages: 40 + i * 37, packageType: ['Bales', 'Cartons', 'Drums', 'Bundles'][i % 4],
    actualWeightKg: Math.round(tons * 1000), weightBasis: 'load', freightType: 'tbb', rateBasis: 'per_ton', rate,
    invoiceRefs: `INV/${4000 + BATCH * 500 + i * 13}`, loadingCharges: i % 3 === 0 ? 500 : 0,
  })
  const dieselPay = (payer: Payer, city: string) =>
    payer === 'account' ? { paidBy: 'vendor_credit', vendorName: HOME_PUMP[city] ?? PUMPS[4], paymentMode: 'credit' }
    : payer === 'driver' ? { paidBy: 'driver', paymentMode: 'cash' } : { paidBy: 'company', paymentMode: 'upi' }

  let n = 0
  for (const [i, r] of plan.rows.entries()) {
    const c = CLASS[r.cls], vehicle = veh(r.reg), driver = r.driver ? drv(r.driver) : undefined, lane = r.lane
    const lr = await bookLr(lane, r.ago, r.from, r.to, r.tons, i, r.rate)
    const trip = await post('/api/transport/trips', {
      vehicleId: vehicle.id, driverId: driver?.id, helperName: driver ? undefined : (r.hire ? 'Hired driver' : "Attached owner's driver"), fromCity: lane.from, toCity: lane.to,
      startDate: day(-r.ago), driverAdvance: driver ? Math.round(lane.km * 11 / 100) * 100 : 0, lrIds: [lr.id], notes: MARK,
      ...(r.hire ? { hireCharges: r.hire[0], hireAdvancePaid: r.hire[1] } : {}),
    })
    const odo = vehicle.currentOdometer
    await post(`/api/transport/trips/${trip.id}/start`, { startOdometer: odo })

    if (r.payer !== 'none') {
      // diesel: loaded out + empty back, split into a fill at the start and (long runs) one on the highway
      const total = Math.round(lane.km / c.kmplLoaded + lane.km / c.kmplEmpty)
      const long = lane.km > 400
      const litres = long ? Math.round(total * 0.6) : total
      const rate0 = 88.9 + (i % 4) * 0.6
      await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres, ratePerLitre: rate0,
        expenseDate: day(-r.ago), odometer: odo + 4, location: lane.from, ...dieselPay(r.payer, lane.from) })
      if (long) await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: total - litres, ratePerLitre: rate0 + 1.4,
        expenseDate: day(-(r.ago - 1)), odometer: odo + Math.round(lane.km * 0.8), location: 'Highway', paidBy: 'vendor_credit',
        vendorName: PUMPS[3 + (i % 3)], paymentMode: 'credit' })
      await post('/api/transport/expenses', { tripId: trip.id, category: 'driver_bhatta', amount: c.bhatta || Math.round(lane.km / 280 * 650) + 400, expenseDate: day(-r.ago), paidBy: 'driver', paymentMode: 'cash' })
    } else {
      // hired truck: its owner pays for diesel and the driver; we pay the broker
      await post('/api/transport/expenses', { tripId: trip.id, category: 'broker_commission', amount: Math.round(r.tons * r.rate * 0.02), expenseDate: day(-r.ago), paidBy: 'company', paymentMode: 'upi' })
    }
    await post('/api/transport/expenses', { tripId: trip.id, category: 'toll', amount: Math.round(lane.km * c.tollPerKm), expenseDate: day(-r.ago), paidBy: 'company', paymentMode: 'fastag' })
    if (i % 3 === 1) await post('/api/transport/expenses', { tripId: trip.id, category: 'loading_unloading', amount: 900 + i * 60, expenseDate: day(-r.ago), paidBy: r.payer === 'none' ? 'company' : 'driver', paymentMode: r.payer === 'none' ? 'upi' : 'cash' })
    if (BATCH === 1 && i === 2) await post('/api/transport/expenses', { tripId: trip.id, category: 'challan', amount: 500, expenseDate: day(-(r.ago - 1)), paidBy: 'driver', paymentMode: 'cash', notes: 'Weighbridge fine' })
    if (BATCH === 1 && i === 6) await post('/api/transport/expenses', { tripId: trip.id, category: 'tyres', amount: 7800, expenseDate: day(-(r.ago - 1)), paidBy: 'company', paymentMode: 'bank_transfer', notes: 'Puncture repair + 1 retread' })
    if (BATCH === 2 && i === 0) await post('/api/transport/expenses', { tripId: trip.id, category: 'parking', amount: 600, expenseDate: day(-(r.ago - 1)), paidBy: 'driver', paymentMode: 'cash', notes: 'Night halt, Jaipur bypass' })
    if (BATCH === 2 && i === 5) await post('/api/transport/expenses', { tripId: trip.id, category: 'repair', amount: 4200, expenseDate: day(-(r.ago - 1)), paidBy: 'company', paymentMode: 'bank_transfer', notes: 'Air hose + brake adjustment' })

    await post(`/api/transport/lrs/${lr.id}/deliver`, { deliveredAt: new Date(Date.now() - (r.ago - 2) * 86_400_000).toISOString(), receivedBy: 'Store keeper' })
    await post(`/api/transport/lrs/${lr.id}/pod`, { podNotes: 'Signed copy received' })
    await post(`/api/transport/trips/${trip.id}/complete`, { endDate: day(-(r.ago - 2)), endOdometer: odo + lane.km * 2 })
    vehicle.currentOdometer = odo + lane.km * 2
    n++
  }
  log(`${n} completed trips`)

  // a trip on the road right now
  {
    const r = plan.running, vehicle = veh(r.reg), driver = drv(r.driver), lane = r.lane
    const lr = await bookLr(lane, 1, r.from, r.to, r.tons, 11, r.rate)
    const trip = await post('/api/transport/trips', { vehicleId: vehicle.id, driverId: driver.id, fromCity: lane.from, toCity: lane.to,
      startDate: day(-1), driverAdvance: r.advance, lrIds: [lr.id], notes: MARK })
    await post(`/api/transport/trips/${trip.id}/start`, { startOdometer: vehicle.currentOdometer })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: r.litres, ratePerLitre: 90.2, expenseDate: day(-1),
      location: lane.from, ...dieselPay(r.payer, lane.from) })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'toll', amount: Math.round(lane.km * CLASS[r.cls].tollPerKm), expenseDate: day(-1), paidBy: 'company', paymentMode: 'fastag' })
    log('1 running trip')
  }

  // pay some of the pumps for older bills; the others stay owed
  const pay = await get<any>('/api/transport/expenses/payables')
  const settle = pay.data
    .filter((g: any) => plan.settle.pumps.includes(g.vendor))
    .flatMap((g: any) => g.bills).filter((b: any) => String(b.expenseDate).slice(0, 10) < day(-plan.settle.olderThanDays)).map((b: any) => b.id)
  if (settle.length) await post('/api/transport/expenses/settle', { ids: settle, settledOn: day(-3), mode: 'upi' })
  const after = await get<any>('/api/transport/expenses/payables')
  log(`${settle.length} older pump bills paid; still owed: ₹${after.totalPayable} across ${after.data.length} pumps`)
  console.log('\nDone.')
}

main().catch((e) => { console.error('\nFailed:', e.message ?? e); process.exit(1) })
