// apps/api/scripts/seed-demo.ts
// =============================================================================
// Seeds a realistic demo transporter by driving the *real HTTP API*:
//   register tenant → login → parties → drivers/vehicles/routes → LRs → trips
//   (start / expenses / deliver / POD / complete) → freight bills → a payment.
// It doubles as an end-to-end smoke test of the whole transport flow.
//
//   pnpm --filter @billing/api seed          (API must be running on API_URL)
//
// Idempotent: if the demo tenant already has vehicles, it does nothing.
// Demo logins:  owner 9100000001 / 1111   ·  manager 9100000011 / 2222
// =============================================================================

const API = process.env['API_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3100}`

// ── tiny HTTP client ─────────────────────────────────────────────────────────
let token = ''
async function call<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`)
  return data as T
}
const get  = <T = any>(p: string) => call<T>('GET', p)
const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => call<T>('POST', p, b ?? {}, h)

// ── deterministic helpers ────────────────────────────────────────────────────
let seed = 20260101
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo))

const IST = 5.5 * 3600_000
const day = (offset: number) => new Date(Date.now() + IST + offset * 86_400_000).toISOString().slice(0, 10)

/** Valid GSTIN (state + PAN + entity + Z + mod-36 checksum) so it passes the registration validator. */
function gstin(state: string, pan: string): string {
  const base = `${state}${pan}1Z`
  const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let sum = 0
  for (let i = 0; i < 14; i++) { const m = CH.indexOf(base[i]!) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(m / 36) + (m % 36) }
  return base + CH[(36 - (sum % 36)) % 36]
}

const log = (m: string) => console.log(`  ${m}`)

async function main() {
  console.log(`Seeding transport demo against ${API}`)

  // ── 1. tenant + login ──────────────────────────────────────────────────────
  const OWNER = { phone: '9100000001', pin: '1111' }
  const exists = await fetch(`${API}/api/tenants/check-phone/${OWNER.phone}`).then((r) => r.json()).catch(() => null)
  if (!exists || exists.available !== false) {
    await post('/api/tenants/register', {
      businessName: 'Shree Ganesh Roadlines', ownerName: 'Ramesh Patel',
      phone: OWNER.phone, pin: OWNER.pin, city: 'Surat', stateCode: '24', lang: 'en',
      gstin: gstin('24', 'AAFPP4321K'),
    })
    log('registered tenant "Shree Ganesh Roadlines"')
  }
  const login = await post('/api/auth/login', { tenantPhone: OWNER.phone, phone: OWNER.phone, pin: OWNER.pin })
  token = login.accessToken

  const existing = await get<any[]>('/api/transport/vehicles')
  if (existing.length > 0) { console.log('Demo data already present — nothing to do.'); return }

  // staff logins
  await post('/api/users', { name: 'Kiran Shah', phone: '9100000011', pin: '2222', role: 'manager', lang: 'en' }).catch(() => {})
  await post('/api/users', { name: 'Accounts View', phone: '9100000012', pin: '3333', role: 'viewer', lang: 'en' }).catch(() => {})

  // ── 2. parties ─────────────────────────────────────────────────────────────
  const partyDefs = [
    { name: 'Arvind Textiles Pvt Ltd',   city: 'Surat',     sc: '24', pan: 'AABCA1111A', phone: '9825011111' },
    { name: 'Sagar Chemicals',           city: 'Vapi',      sc: '24', pan: 'AAGFS2222B', phone: '9825022222' },
    { name: 'Mehta Steel Traders',       city: 'Mumbai',    sc: '27', pan: 'AAHFM3333C', phone: '9820033333' },
    { name: 'Kumar FMCG Distributors',   city: 'Delhi',     sc: '07', pan: 'AAACK4444D', phone: '9810044444' },
    { name: 'Shree Agro Industries',     city: 'Rajkot',    sc: '24', pan: 'AAJCS5555E', phone: '9825055555' },
    { name: 'Bharat Auto Components',    city: 'Pune',      sc: '27', pan: 'AABCB6666F', phone: '9822066666' },
  ]
  const parties: any[] = []
  for (const p of partyDefs) {
    parties.push(await post('/api/parties', {
      type: 'customer', name: p.name, phone: p.phone, gstin: gstin(p.sc, p.pan),
      address: { line1: `Plot ${between(10, 400)}, GIDC`, city: p.city, stateCode: p.sc, state: p.city },
      creditLimit: 500000,
    }))
  }
  const byName = (n: string) => parties.find((p) => p.name.startsWith(n))!
  log(`${parties.length} parties`)

  // ── 3. drivers ─────────────────────────────────────────────────────────────
  const driverDefs = [
    ['Mohan Yadav', 'GJ0520150012345', 400], ['Sunil Chauhan', 'GJ0520120067890', 420], ['Rajesh Thakor', 'GJ0620180011223', 380],
    ['Imran Sheikh', 'MH0420140099887', 450], ['Dilip Rathod', 'GJ0520190055443', 360], ['Harish Solanki', 'GJ0120170033221', 400],
  ] as const
  const drivers: any[] = []
  for (const [i, [name, lic, perDay]] of driverDefs.entries()) {
    drivers.push(await post('/api/transport/drivers', {
      name, phone: `98250${String(30000 + i * 111).slice(0, 5)}`, licenseNo: lic, licenseClass: 'HMV',
      licenseExpiry: day(i === 3 ? 12 : 200 + i * 40), salaryType: 'monthly', salaryAmount: perDay * 26, joinedOn: day(-700),
    }))
  }
  log(`${drivers.length} drivers`)

  // ── 4. vehicles (with a few compliance dates deliberately due/expired) ──────
  const vehicleDefs = [
    { regNo: 'GJ05BX4821', type: 'hcv',       cap: 25,  make: 'Tata Prima 2825.K',   own: 'own',      odo: 412000, ins: 140, fit: 200 },
    { regNo: 'GJ05BX7316', type: 'hcv',       cap: 25,  make: 'Ashok Leyland 2820',  own: 'own',      odo: 388500, ins: 9,   fit: 320 },   // insurance due in 9 days
    { regNo: 'GJ05CA1190', type: 'icv',       cap: 12,  make: 'Eicher Pro 3015',     own: 'own',      odo: 210300, ins: 260, fit: -4  },   // fitness expired
    { regNo: 'GJ05CA9042', type: 'lcv',       cap: 6,   make: 'Tata 407',            own: 'own',      odo: 156700, ins: 90,  fit: 150 },
    { regNo: 'GJ06AT5577', type: 'container', cap: 28,  make: 'BharatBenz 3523R',    own: 'attached', odo: 501200, ins: 70,  fit: 28  },   // fitness due in 28 days
    { regNo: 'GJ01DD3308', type: 'trailer',   cap: 40,  make: 'Volvo FM 440',        own: 'attached', odo: 298400, ins: 180, fit: 365 },
    { regNo: 'MH04KL2255', type: 'hcv',       cap: 20,  make: 'Tata Signa 3718',     own: 'market',   odo: 0,      ins: 120, fit: 120 },
    { regNo: 'GJ05DE6140', type: 'mini_truck',cap: 1,   make: 'Tata Ace Gold',       own: 'own',      odo: 88200,  ins: 55,  fit: 90  },
  ] as const
  const vehicles: any[] = []
  for (const [i, v] of vehicleDefs.entries()) {
    vehicles.push(await post('/api/transport/vehicles', {
      regNo: v.regNo, vehicleType: v.type, makeModel: v.make, capacityTons: v.cap, yearOfMfg: 2016 + (i % 8),
      ownership: v.own, ownerName: v.own === 'own' ? 'Shree Ganesh Roadlines' : pick(['Patel Brothers', 'Jay Ambe Transport']),
      ownerPhone: v.own === 'own' ? undefined : '9825099999',
      currentOdometer: v.odo, fitnessExpiry: day(v.fit), insuranceExpiry: day(v.ins),
      permitExpiry: day(300 + i * 11), pucExpiry: day(40 + i * 17), roadTaxExpiry: day(500),
      defaultDriverId: v.own === 'own' && drivers[i] ? drivers[i].id : undefined,
    }))
  }
  log(`${vehicles.length} vehicles`)

  // ── 5. rate card ───────────────────────────────────────────────────────────
  const routeDefs = [
    ['Surat', 'Mumbai', 280, 'per_ton', 1150], ['Surat', 'Ahmedabad', 265, 'per_ton', 950], ['Surat', 'Delhi', 1170, 'per_ton', 3300],
    ['Vapi', 'Pune', 440, 'per_ton', 1700], ['Rajkot', 'Surat', 470, 'per_ton', 1600], ['Mumbai', 'Surat', 280, 'per_ton', 1100],
    ['Surat', 'Pune', 590, 'fixed', 38000],
  ] as const
  for (const [f, t, km, basis, rate] of routeDefs) {
    await post('/api/transport/routes', { fromCity: f, toCity: t, distanceKm: km, rateBasis: basis, rate, tollEstimate: Math.round(km * 3.1) })
  }
  log(`${routeDefs.length} rate-card routes`)

  // ── 6. LRs + trips ─────────────────────────────────────────────────────────
  const goods = ['Grey fabric rolls', 'Industrial chemicals (drums)', 'TMT steel bars', 'FMCG cartons', 'Cotton bales', 'Auto components', 'Ceramic tiles', 'Packed groundnut oil']
  const lanes = [
    { from: 'Surat', to: 'Mumbai',    consignor: 'Arvind',  consignee: 'Mehta',  km: 280,  rate: 1150 },
    { from: 'Vapi',  to: 'Pune',      consignor: 'Sagar',   consignee: 'Bharat', km: 440,  rate: 1700 },
    { from: 'Surat', to: 'Delhi',     consignor: 'Arvind',  consignee: 'Kumar',  km: 1170, rate: 3300 },
    { from: 'Rajkot',to: 'Surat',     consignor: 'Shree',   consignee: 'Arvind', km: 470,  rate: 1600 },
    { from: 'Mumbai',to: 'Surat',     consignor: 'Mehta',   consignee: 'Sagar',  km: 280,  rate: 1100 },
  ] as const

  async function bookLr(lane: (typeof lanes)[number], daysAgo: number, freightType: 'tbb' | 'paid' | 'to_pay' = 'tbb') {
    const consignor = byName(lane.consignor), consignee = byName(lane.consignee)
    const kg = between(6, 24) * 1000
    const value = between(2, 14) * 100000
    return post('/api/transport/lrs', {
      lrDate: day(-daysAgo), consignorId: consignor.id, consigneeId: consignee.id,
      fromCity: lane.from, toCity: lane.to, goodsDescription: pick(goods),
      packages: between(40, 600), packageType: pick(['Bales', 'Cartons', 'Drums', 'Bundles']),
      actualWeightKg: kg, unloadWeightKg: kg - between(0, 80), weightBasis: 'load', gatePassNo: `30043${between(10000, 99999)}`, declaredValue: value,
      invoiceRefs: `INV/${between(1000, 9999)}`, ewayBillNo: value > 50000 ? String(between(100000000000, 999999999999)) : undefined,
      ewayValidUpto: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      freightType, rateBasis: 'per_ton', rate: lane.rate,
      loadingCharges: pick([0, 500, 800]), unloadingCharges: pick([0, 500]), detentionCharges: rnd() < 0.15 ? 1500 : 0,
      advancePaid: freightType === 'paid' ? 0 : 0,
    })
  }

  const completedTrips = 11
  const doneLrs: any[] = []
  let vi = 0
  for (let t = 0; t < completedTrips; t++) {
    const lane = lanes[t % lanes.length]!
    const startAgo = 58 - t * 5                    // oldest first
    const vehicle = vehicles[vi++ % 6]!            // keep the market/ACE vehicles for special cases
    const driver  = drivers[t % drivers.length]!
    const lrs = []
    const nLr = t % 3 === 0 ? 2 : 1
    for (let k = 0; k < nLr; k++) lrs.push(await bookLr(lane, startAgo, t === 4 ? 'to_pay' : t === 7 ? 'paid' : 'tbb'))
    const trip = await post('/api/transport/trips', {
      vehicleId: vehicle.id, driverId: driver.id, fromCity: lane.from, toCity: lane.to,
      startDate: day(-startAgo), driverAdvance: lane.km * 12, lrIds: lrs.map((l: any) => l.id),
    })
    const startOdo = vehicle.currentOdometer + 0
    await post(`/api/transport/trips/${trip.id}/start`, { startOdometer: startOdo })
    const diesel = Math.round((lane.km * 2) / 3.6)
    await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: diesel, ratePerLitre: 89.4,
      expenseDate: day(-startAgo), odometer: startOdo + 5, location: lane.from, paymentMode: 'credit' })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'toll', amount: Math.round(lane.km * 3.4), expenseDate: day(-startAgo), paymentMode: 'fastag' })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'driver_bhatta', amount: Math.round(lane.km / 280 * 900) + 400, expenseDate: day(-startAgo), paymentMode: 'cash' })
    if (rnd() < 0.5) await post('/api/transport/expenses', { tripId: trip.id, category: 'loading_unloading', amount: between(600, 1800), expenseDate: day(-startAgo), paymentMode: 'cash' })
    if (rnd() < 0.25) await post('/api/transport/expenses', { tripId: trip.id, category: 'challan', amount: 500, expenseDate: day(-startAgo), paymentMode: 'cash', notes: 'Weighbridge fine' })
    for (const lr of lrs) {
      await post(`/api/transport/lrs/${lr.id}/deliver`, {
        deliveredAt: new Date(Date.now() - (startAgo - 2) * 86_400_000).toISOString(), receivedBy: 'Store keeper',
        ...(t === 4 ? { toPayCollected: Math.round(lr.totalAmount * 0.6) } : {}),
      })
      if (rnd() < 0.8) await post(`/api/transport/lrs/${lr.id}/pod`, { podNotes: 'Signed copy received' })
    }
    await post(`/api/transport/trips/${trip.id}/complete`, { endDate: day(-(startAgo - 2)), endOdometer: startOdo + lane.km * 2 })
    vehicle.currentOdometer = startOdo + lane.km * 2
    doneLrs.push(...lrs)
  }
  log(`${completedTrips} completed trips, ${doneLrs.length} delivered LRs`)

  // two running trips
  for (let r = 0; r < 2; r++) {
    const lane = lanes[(r + 1) % lanes.length]!
    const vehicle = vehicles[r]!
    const lr = await bookLr(lane, 1 + r)
    const trip = await post('/api/transport/trips', {
      vehicleId: vehicle.id, driverId: drivers[(r + 3) % drivers.length].id, fromCity: lane.from, toCity: lane.to,
      startDate: day(-(1 + r)), driverAdvance: 8000, lrIds: [lr.id],
    })
    await post(`/api/transport/trips/${trip.id}/start`, { startOdometer: vehicle.currentOdometer })
    await post('/api/transport/expenses', { tripId: trip.id, category: 'diesel', litres: 180, ratePerLitre: 89.4, expenseDate: day(-(1 + r)), paymentMode: 'credit' })
  }
  // a planned trip with a loaded LR, plus unassigned LRs waiting for a truck
  {
    const lane = lanes[2]!
    const lr = await bookLr(lane, 0)
    await post('/api/transport/trips', { vehicleId: vehicles[3].id, driverId: drivers[4].id, fromCity: lane.from, toCity: lane.to,
      startDate: day(1), driverAdvance: 15000, lrIds: [lr.id] })
  }
  await bookLr(lanes[0]!, 0)
  await bookLr(lanes[3]!, 0, 'paid')
  log('2 running trips, 1 planned trip, 2 unassigned LRs')

  // ── 7. freight bills ───────────────────────────────────────────────────────
  let billed = 0
  const bills: any[] = []
  for (const name of ['Arvind', 'Sagar', 'Mehta']) {
    const party = byName(name)
    const cand = await get<any>(`/api/transport/bills/candidates?partyId=${party.id}&as=consignor&freightType=tbb`)
    const ids = cand.data.filter((l: any) => ['delivered', 'pod_received'].includes(l.status)).map((l: any) => l.id)
    if (ids.length === 0) continue
    const res = await post('/api/transport/bills', { partyId: party.id, lrIds: ids, gstMode: name === 'Mehta' ? 'forward_18' : 'rcm', creditDays: 30 })
    bills.push(res.invoice)
    billed += ids.length
  }
  log(`${bills.length} freight bills covering ${billed} LRs`)

  // one part-payment so Outstanding / Aging show something real
  if (bills[0]) {
    await post('/api/payments', {
      partyId: bills[0].partyId, amount: Math.round(Number(bills[0].grandTotal) / 2), method: 'bank_transfer',
      refNo: 'NEFT-884412', allocations: [{ invoiceId: bills[0].id, amount: Math.round(Number(bills[0].grandTotal) / 2) }],
    })
    log('recorded a part payment')
  }

  console.log('\nDone. Log in with  owner 9100000001 / 1111   (manager 9100000011 / 2222, viewer 9100000012 / 3333)')
}

main().catch((e) => { console.error('\nSeed failed:', e.message ?? e); process.exit(1) })
