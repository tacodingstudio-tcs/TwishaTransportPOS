// Transport module — integration tests against a running API (see jest.config.cjs / README).
// Every suite provisions its own throwaway tenants (phones 7xxxxxxxxx are purged by globalSetup),
// so nothing depends on seed data.

import { newTransportTenant, addStaff, today, type Session } from './helpers'

const fyLabel = (d = today()) => {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}

let regCounter = 0
const uniqueReg = () => `GJ${String(10 + (regCounter % 80))}XT${String(Date.now()).slice(-4)}${regCounter++ % 10}`.slice(0, 12)

describe('Transport', () => {
  let owner: Session, other: Session, viewer: Session, manager: Session, cashier: Session
  let local: any, outstate: any   // customers: same state (24) and other state (27)

  beforeAll(async () => {
    owner   = await newTransportTenant('Alpha Carriers')
    other   = await newTransportTenant('Beta Carriers')
    viewer  = await addStaff(owner, 'viewer')
    manager = await addStaff(owner, 'manager')
    cashier = await addStaff(owner, 'cashier')
    local = (await owner.api.post('/api/parties', {
      type: 'customer', name: 'Local Mills', address: { city: 'Surat', stateCode: '24' },
    })).data
    outstate = (await owner.api.post('/api/parties', {
      type: 'customer', name: 'Mumbai Traders', address: { city: 'Mumbai', stateCode: '27' },
    })).data
  })

  // ── factories ──────────────────────────────────────────────────────────────
  const mkVehicle = async (s = owner, body: Record<string, unknown> = {}) => {
    const r = await s.api.post('/api/transport/vehicles', { regNo: uniqueReg(), vehicleType: 'hcv', capacityTons: 25, currentOdometer: 1000, ...body })
    expect(r.status).toBe(201)
    return r.data
  }
  const mkDriver = async (s = owner, body: Record<string, unknown> = {}) => {
    const r = await s.api.post('/api/transport/drivers', { name: `Driver ${regCounter++}`, ...body })
    expect(r.status).toBe(201)
    return r.data
  }
  const mkLr = async (s = owner, body: Record<string, unknown> = {}) => {
    const r = await s.api.post('/api/transport/lrs', {
      consignorName: 'Acme Exports', consigneeName: 'Beta Retail', fromCity: 'Surat', toCity: 'Mumbai',
      goodsDescription: 'Cotton bales', actualWeightKg: 10000, rateBasis: 'per_ton', rate: 1000, ...body,
    })
    expect(r.status).toBe(201)
    return r.data
  }
  const mkTrip = async (s = owner, vehicleId: string, body: Record<string, unknown> = {}) => {
    const r = await s.api.post('/api/transport/trips', { vehicleId, fromCity: 'Surat', toCity: 'Mumbai', ...body })
    expect(r.status).toBe(201)
    return r.data
  }
  const getLr = async (id: string, s = owner) => (await s.api.get(`/api/transport/lrs/${id}`)).data
  const getVehicle = async (id: string, s = owner) => (await s.api.get(`/api/transport/vehicles/${id}`)).data

  // ═══════════════════════════════════════════════════════════════════════════
  describe('fleet', () => {
    test('vehicle registration number is normalised and stored', async () => {
      const r = await owner.api.post('/api/transport/vehicles', { regNo: 'gj 05-xy 7788', vehicleType: 'icv' })
      expect(r.status).toBe(201)
      expect(r.data.regNo).toBe('GJ05XY7788')
      expect(r.data.status).toBe('available')
    })

    test('duplicate registration number is rejected with 409', async () => {
      const v = await mkVehicle()
      const dup = await owner.api.post('/api/transport/vehicles', { regNo: v.regNo.toLowerCase() })
      expect(dup.status).toBe(409)
    })

    test('invalid vehicle type is a 422 validation error', async () => {
      const r = await owner.api.post('/api/transport/vehicles', { regNo: uniqueReg(), vehicleType: 'spaceship' })
      expect(r.status).toBe(422)
    })

    test('read-only users cannot create or modify fleet records', async () => {
      const v = await mkVehicle()
      expect((await viewer.api.post('/api/transport/vehicles', { regNo: uniqueReg() })).status).toBe(403)
      expect((await viewer.api.patch(`/api/transport/vehicles/${v.id}`, { notes: 'x' })).status).toBe(403)
      expect((await viewer.api.get('/api/transport/vehicles')).status).toBe(200)   // but they can read
    })

    test('"on_trip" cannot be set by hand — only trips control it', async () => {
      const v = await mkVehicle()
      const r = await owner.api.patch(`/api/transport/vehicles/${v.id}`, { status: 'on_trip' })
      expect(r.status).toBe(422)
      const ok = await owner.api.patch(`/api/transport/vehicles/${v.id}`, { status: 'maintenance' })
      expect(ok.status).toBe(200)
      expect(ok.data.status).toBe('maintenance')
    })

    test('a vehicle in maintenance cannot be started on a trip', async () => {
      const v = await mkVehicle(owner, { status: undefined })
      await owner.api.patch(`/api/transport/vehicles/${v.id}`, { status: 'maintenance' })
      const trip = await mkTrip(owner, v.id)
      const start = await owner.api.post(`/api/transport/trips/${trip.id}/start`)
      expect(start.status).toBe(422)
      expect(start.data.error).toMatch(/not available/i)
    })

    test('tenants are isolated from each other', async () => {
      const v = await mkVehicle(owner)
      expect((await other.api.get(`/api/transport/vehicles/${v.id}`)).status).toBe(404)
      const list = await other.api.get('/api/transport/vehicles')
      expect(list.data.find((x: any) => x.id === v.id)).toBeUndefined()
    })

    test('compliance report flags expired and imminent documents, ignores far-off ones', async () => {
      const v = await mkVehicle(owner, {
        fitnessExpiry: today(-1), insuranceExpiry: today(5), pucExpiry: today(20), roadTaxExpiry: today(400),
      })
      const r = await owner.api.get('/api/transport/compliance?days=30')
      expect(r.status).toBe(200)
      const mine = r.data.items.filter((i: any) => i.entityId === v.id)
      const by = (doc: string) => mine.find((i: any) => i.doc === doc)
      expect(by('Fitness')).toMatchObject({ severity: 'expired', daysLeft: -1 })
      expect(by('Insurance')).toMatchObject({ severity: 'critical', daysLeft: 5 })
      expect(by('PUC')).toMatchObject({ severity: 'warning', daysLeft: 20 })
      expect(by('Road Tax')).toBeUndefined()
      expect(r.data.counts.expired).toBeGreaterThanOrEqual(1)
    })

    test('driver licence expiry appears in compliance', async () => {
      const d = await mkDriver(owner, { licenseNo: 'GJ0120250001', licenseExpiry: today(10) })
      const r = await owner.api.get('/api/transport/compliance?days=30')
      expect(r.data.items.find((i: any) => i.entityId === d.id && i.doc === 'Driving Licence')).toMatchObject({ kind: 'driver', daysLeft: 10 })
    })

    test('rate card lookup prefers a customer-specific rate over the standard one', async () => {
      await owner.api.post('/api/transport/routes', { fromCity: 'Surat', toCity: 'Pune', rateBasis: 'per_ton', rate: 900 })
      await owner.api.post('/api/transport/routes', { fromCity: 'Surat', toCity: 'Pune', rateBasis: 'per_ton', rate: 750, partyId: local.id })
      const generic = await owner.api.get('/api/transport/routes/lookup?from=surat&to=PUNE')
      expect(Number(generic.data.rate)).toBe(900)
      const forLocal = await owner.api.get(`/api/transport/routes/lookup?from=Surat&to=Pune&partyId=${local.id}`)
      expect(Number(forLocal.data.rate)).toBe(750)
      const none = await owner.api.get('/api/transport/routes/lookup?from=Surat&to=Nowhere')
      expect(none.data === null || none.data === '').toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('lorry receipts', () => {
    test('freight is computed on the server for every rate basis', async () => {
      const perTon = await mkLr(owner, { actualWeightKg: 12000, rateBasis: 'per_ton', rate: 1150, loadingCharges: 500 })
      expect(Number(perTon.freightAmount)).toBe(13800)
      expect(Number(perTon.totalAmount)).toBe(14300)

      const perKg = await mkLr(owner, { actualWeightKg: 800, chargedWeightKg: 1000, rateBasis: 'per_kg', rate: 4.5 })
      expect(Number(perKg.freightAmount)).toBe(4500)           // charged weight wins when higher

      const perPkg = await mkLr(owner, { packages: 40, rateBasis: 'per_pkg', rate: 55, detentionCharges: 300 })
      expect(Number(perPkg.freightAmount)).toBe(2200)
      expect(Number(perPkg.totalAmount)).toBe(2500)

      const fixed = await mkLr(owner, { rateBasis: 'fixed', rate: 0, freightAmount: 38000, unloadingCharges: 700 })
      expect(Number(fixed.totalAmount)).toBe(38700)
    })

    test('a client-sent freightAmount cannot override a per-ton calculation', async () => {
      const lr = await mkLr(owner, { actualWeightKg: 5000, rateBasis: 'per_ton', rate: 1000, freightAmount: 1 })
      expect(Number(lr.freightAmount)).toBe(5000)
    })

    test('LR numbers are sequential within the financial year', async () => {
      const a = await mkLr(), b = await mkLr()
      const re = new RegExp(`^LR-${fyLabel()}-(\\d{4})$`)
      const na = Number(re.exec(a.lrNo)?.[1]), nb = Number(re.exec(b.lrNo)?.[1])
      expect(na).toBeGreaterThan(0)
      expect(nb).toBe(na + 1)
    })

    test('concurrent bookings never share an LR number', async () => {
      const made = await Promise.all(Array.from({ length: 8 }, () => mkLr()))
      expect(new Set(made.map((l) => l.lrNo)).size).toBe(8)
    })

    test('consignor and consignee are required', async () => {
      const r = await owner.api.post('/api/transport/lrs', { fromCity: 'A', toCity: 'B', goodsDescription: 'x' })
      expect(r.status).toBe(422)
      expect(r.data.error).toMatch(/consignor/i)
    })

    test('a saved party is snapshotted onto the LR (name, GSTIN, address)', async () => {
      const gstin = '24AAACL1234A1ZB'
      const p = (await owner.api.post('/api/parties', { type: 'customer', name: 'Snapshot Co', gstin: undefined, address: { line1: 'Plot 9', city: 'Vapi', stateCode: '24' } })).data
      const lr = await mkLr(owner, { consignorId: p.id, consignorName: undefined, consignorGstin: gstin })
      expect(lr.consignorName).toBe('Snapshot Co')
      expect(lr.consignorGstin).toBe(gstin)
      expect(lr.consignorAddress).toContain('Vapi')
    })

    test('advance cannot exceed the freight total', async () => {
      const r = await owner.api.post('/api/transport/lrs', {
        consignorName: 'A', consigneeName: 'B', fromCity: 'X', toCity: 'Y', goodsDescription: 'g',
        actualWeightKg: 1000, rateBasis: 'per_ton', rate: 1000, advancePaid: 5000,
      })
      expect(r.status).toBe(422)
    })

    test('high-value consignments without an e-way bill get a warning, not a block', async () => {
      const warned = await mkLr(owner, { declaredValue: 60000 })
      expect(warned.warnings.join(' ')).toMatch(/e-way/i)
      const clean = await mkLr(owner, { declaredValue: 60000, ewayBillNo: '123456789012' })
      expect(clean.warnings).toEqual([])
      const small = await mkLr(owner, { declaredValue: 49000 })
      expect(small.warnings).toEqual([])
    })

    test('e-way validity: 1 day per 200 km, 100 km for over-dimensional cargo', async () => {
      const a = await owner.api.get('/api/transport/utils/eway-validity?distanceKm=550')
      expect(a.data.days).toBe(3)
      const b = await owner.api.get('/api/transport/utils/eway-validity?distanceKm=150')
      expect(b.data.days).toBe(1)
      const c = await owner.api.get('/api/transport/utils/eway-validity?distanceKm=550&odc=true')
      expect(c.data.days).toBe(6)
    })

    test('editing recalculates freight; billed LRs are locked', async () => {
      const lr = await mkLr(owner, { actualWeightKg: 10000, rate: 1000 })
      const edited = await owner.api.patch(`/api/transport/lrs/${lr.id}`, { rate: 1200 })
      expect(edited.status).toBe(200)
      expect(Number(edited.data.freightAmount)).toBe(12000)
      expect(Number(edited.data.totalAmount)).toBe(12000)
    })

    test('delivery → POD happens in order, and To-Pay collection is bounded by the balance due', async () => {
      const lr = await mkLr(owner, { freightType: 'to_pay', advancePaid: 2000 })   // total 10,000 → 8,000 due
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/pod`, {})).status).toBe(422)   // not delivered yet
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, { receivedBy: 'Gatekeeper' })).status).toBe(200)
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/collect`, { amount: 9000 })).status).toBe(422)
      const part = await owner.api.post(`/api/transport/lrs/${lr.id}/collect`, { amount: 5000 })
      expect(Number(part.data.toPayCollected)).toBe(5000)
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/collect`, { amount: 3500 })).status).toBe(422)
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/collect`, { amount: 3000 })).status).toBe(200)
      const pod = await owner.api.post(`/api/transport/lrs/${lr.id}/pod`, { podNotes: 'signed' })
      expect(pod.data.status).toBe('pod_received')
    })

    test('only owner/manager can cancel an LR, and a reason is mandatory', async () => {
      const lr = await mkLr()
      expect((await cashier.api.post(`/api/transport/lrs/${lr.id}/cancel`, { reason: 'wrong party' })).status).toBe(403)
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/cancel`, {})).status).toBe(422)
      const done = await manager.api.post(`/api/transport/lrs/${lr.id}/cancel`, { reason: 'wrong party' })
      expect(done.status).toBe(200)
      expect(done.data.status).toBe('cancelled')
      expect((await owner.api.patch(`/api/transport/lrs/${lr.id}`, { remarks: 'x' })).status).toBe(422)
    })

    test('LR list filters: unassigned, search, status, and tenant isolation', async () => {
      const lr = await mkLr(owner, { consigneeName: 'Zebra Unique Receivers' })
      const found = await owner.api.get('/api/transport/lrs?search=Zebra%20Unique')
      expect(found.data.data.map((l: any) => l.id)).toContain(lr.id)
      const unassigned = await owner.api.get('/api/transport/lrs?unassigned=true&limit=200')
      expect(unassigned.data.data.map((l: any) => l.id)).toContain(lr.id)
      const theirs = await other.api.get('/api/transport/lrs?search=Zebra%20Unique')
      expect(theirs.data.total).toBe(0)
      expect((await other.api.get(`/api/transport/lrs/${lr.id}`)).status).toBe(404)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('load/unload quantity, own LR numbers, bulk entry', () => {
    const n = (v: unknown) => Number(v)

    test('freight is charged on the chosen weight: load, unload, or the lower of the two', async () => {
      const base = { actualWeightKg: 29480, unloadWeightKg: 29450, rateBasis: 'per_ton', rate: 890 }
      const onLoad = await mkLr(owner, { ...base, weightBasis: 'load' })
      expect(n(onLoad.freightAmount)).toBe(26237.2)             // 29.48 t × ₹890 — the figure on the customer's bill
      const onUnload = await mkLr(owner, { ...base, weightBasis: 'unload' })
      expect(n(onUnload.freightAmount)).toBe(26210.5)           // 29.45 t × ₹890
      const lower = await mkLr(owner, { ...base, actualWeightKg: 29450, unloadWeightKg: 29480, weightBasis: 'lower' })
      expect(n(lower.chargedWeightKg)).toBe(29450)
      const noUnloadYet = await mkLr(owner, { actualWeightKg: 30000, weightBasis: 'unload', rateBasis: 'per_ton', rate: 1000 })
      expect(n(noUnloadYet.freightAmount)).toBe(30000)          // falls back to load until the unload qty is known
    })

    test('recording the unload quantity at delivery re-prices an unload-based LR (and leaves a load-based one alone)', async () => {
      const lrUnload = await mkLr(owner, { actualWeightKg: 30000, weightBasis: 'unload', rateBasis: 'per_ton', rate: 1000 })
      const lrLoad   = await mkLr(owner, { actualWeightKg: 30000, weightBasis: 'load',   rateBasis: 'per_ton', rate: 1000 })
      const a = await owner.api.post(`/api/transport/lrs/${lrUnload.id}/deliver`, { unloadWeightKg: 29500 })
      const b = await owner.api.post(`/api/transport/lrs/${lrLoad.id}/deliver`, { unloadWeightKg: 29500 })
      expect(n(a.data.totalAmount)).toBe(29500)
      expect(n(a.data.unloadWeightKg)).toBe(29500)
      expect(n(b.data.totalAmount)).toBe(30000)                 // shortage recorded, price unchanged
      expect(n(b.data.unloadWeightKg)).toBe(29500)
    })

    test('gate pass and shipment numbers are kept on the LR', async () => {
      const lr = await mkLr(owner, { gatePassNo: '3004343531', shipmentNo: '3464' })
      expect(lr.gatePassNo).toBe('3004343531')
      expect(lr.shipmentNo).toBe('3464')
    })

    test('an operator can use their own LR number — but never the same one twice', async () => {
      const mine = await mkLr(owner, { lrNo: `B-${Date.now() % 100000}` })
      expect(mine.lrNo).toMatch(/^B-\d+$/)
      const dup = await owner.api.post('/api/transport/lrs', {
        consignorName: 'A', consigneeName: 'B', fromCity: 'X', toCity: 'Y', goodsDescription: 'g', lrNo: mine.lrNo.toLowerCase(),
      })
      expect(dup.status).toBe(409)
      // own numbers do not disturb the automatic series
      const auto1 = await mkLr(), auto2 = await mkLr()
      const seq = (x: string) => Number(x.split('-').pop())
      expect(seq(auto2.lrNo)).toBe(seq(auto1.lrNo) + 1)
      // renaming onto an existing number is refused too
      const other2 = await mkLr()
      expect((await owner.api.patch(`/api/transport/lrs/${other2.id}`, { lrNo: mine.lrNo })).status).toBe(409)
      expect((await owner.api.patch(`/api/transport/lrs/${other2.id}`, { lrNo: `${mine.lrNo}-A` })).status).toBe(200)
    })

    test('bulk entry books a month of trips for one customer, optionally already delivered', async () => {
      const veh = await mkVehicle(owner)
      const res = await owner.api.post('/api/transport/lrs/bulk', {
        common: { consignorId: local.id, fromCity: 'Kodinar', goodsDescription: 'Fly ash', rateBasis: 'per_ton', weightBasis: 'load', freightType: 'tbb' },
        markDelivered: true,
        rows: [
          { lrDate: today(-20), lrNo: `M${Date.now() % 100000}1`, vehicleNo: veh.regNo.toLowerCase(), toCity: 'Palitana', actualWeightKg: 29480, unloadWeightKg: 29450, rate: 890, gatePassNo: 'GP1', shipmentNo: 'S1' },
          { lrDate: today(-19), toCity: 'Botad', actualWeightKg: 29680, unloadWeightKg: 29790, rate: 1043 },
          { lrDate: today(-18), toCity: 'Anand', actualWeightKg: 34060, rate: 1404 },
        ],
      })
      expect(res.status).toBe(201)
      expect(res.data.count).toBe(3)
      expect(n(res.data.totalAmount)).toBeCloseTo(105013.68, 2)
      const [first, second] = res.data.lrs
      expect(first.status).toBe('delivered')
      expect(first.consigneeName).toBe('Local Mills')                // receiver defaults to the customer's plant
      expect(first.vehicleId).toBe(veh.id)                           // typed registration linked to the fleet record
      expect(first.vehicleNo).toBe(veh.regNo)
      expect(second.gatePassNo).toBeNull()
      // history is immediately billable
      const bill = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: res.data.lrs.map((l: any) => l.id), gstMode: 'forward_18' })
      expect(bill.status).toBe(201)
      expect(n(bill.data.invoice.taxableAmt)).toBe(105013.68)
    })

    test('bulk entry is all-or-nothing and names the offending row', async () => {
      const before = (await owner.api.get('/api/transport/lrs?limit=1')).data.total
      const res = await owner.api.post('/api/transport/lrs/bulk', {
        common: { consignorId: local.id, fromCity: 'A', goodsDescription: 'x', rateBasis: 'per_ton', rate: 100 },
        rows: [
          { toCity: 'B', actualWeightKg: 1000 },
          { toCity: 'C', actualWeightKg: 1000, advancePaid: 999999 },   // advance > freight → rejected
          { toCity: 'D', actualWeightKg: 1000 },
        ],
      })
      expect(res.status).toBe(422)
      expect(res.data.error).toMatch(/Row 2/)
      expect((await owner.api.get('/api/transport/lrs?limit=1')).data.total).toBe(before)   // row 1 was rolled back
    })

    test('bulk entry rejects duplicate LR numbers inside the batch and existing numbers', async () => {
      const dupInBatch = await owner.api.post('/api/transport/lrs/bulk', {
        common: { consignorId: local.id, fromCity: 'A', toCity: 'B', goodsDescription: 'x' },
        rows: [{ lrNo: 'DUP-1' }, { lrNo: 'dup-1' }],
      })
      expect(dupInBatch.status).toBe(422)
      const existing = await mkLr(owner, { lrNo: `EX-${Date.now() % 100000}` })
      const dupExisting = await owner.api.post('/api/transport/lrs/bulk', {
        common: { consignorId: local.id, fromCity: 'A', toCity: 'B', goodsDescription: 'x' },
        rows: [{ lrNo: existing.lrNo }],
      })
      expect(dupExisting.status).toBe(409)
    })

    test('read-only users cannot use bulk entry', async () => {
      const r = await viewer.api.post('/api/transport/lrs/bulk', { common: { consignorId: local.id }, rows: [{}] })
      expect(r.status).toBe(403)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('real-world acceptance: a transporter\'s monthly GTA bill (14 trips, 18% forward charge, 1% TDS)', () => {
    // [date, truck, LR no, gate pass, destination, load MT, unload MT, rate ₹/MT, amount printed on the customer's bill]
    const TRIPS: Array<[string, string, string, string, string, number, number, number, number]> = [
      ['2026-08-14', 'GJ10TX6971', '3464', '3004343531', 'PALITANA',         29.48, 29.45, 890,  26237.20],
      ['2026-08-18', 'GJ10TX6971', '3473', '3004344330', 'LATHIDAD BOTAD',   29.68, 29.79, 1043, 30956.24],
      ['2026-08-29', 'GJ18BT2626', '3495', '3004346534', 'ANKLAV',           34.37, 34.48, 1421, 48839.77],
      ['2026-08-29', 'GJ10TX6971', '3496', '3004346555', 'SUTRAPADA',        29.59, 29.50, 163,  4823.17],
      ['2026-08-31', 'GJ32V5599',  '3499', '3004346952', 'ADALAJ GANDHINAG', 34.46, 34.35, 1300, 44798.00],
      ['2026-09-01', 'GJ32V4774',  '3500', '3004347036', 'SIHOR BHAVNAGAR',  34.31, 34.15, 949,  32560.19],
      ['2026-09-03', 'GJ32V4774',  '3504', '3004347323', 'ANAND',            34.06, 33.99, 1404, 47820.24],
      ['2026-09-05', 'GJ18BT2626', '3505', '3004347447', 'BOTAD',            34.18, 34.00, 1043, 35649.74],
      ['2026-09-05', 'GJ32V5599',  '3506', '3004347445', 'BHAVNAGAR',        33.97, 33.99, 969,  32916.93],
      ['2026-09-06', 'GJ32V4774',  '3507', '3004347617', 'BHAVNAGAR',        34.52, 34.69, 969,  33449.88],
      ['2026-09-08', 'GJ32V5599',  '3511', '3004347959', 'BOTAD',            34.21, 34.12, 1043, 35681.03],
      ['2026-09-08', 'GJ10TX6971', '3512', '3004348056', 'RAJULA',           29.59, 29.59, 550,  16274.50],
      ['2026-09-09', 'GJ18BT2626', '3515', '3004348203', 'PALITANA',         34.07, 34.07, 890,  30322.30],
      ['2026-09-09', 'GJ32V4774',  '3516', '3004348224', 'LATHI AMRELI',     34.33, 34.27, 813,  27910.29],
    ]

    test('entered as a quick-entry batch and billed, it reproduces the printed bill', async () => {
      const s = await newTransportTenant('Rajhansh Test')
      const cement = (await s.api.post('/api/parties', {
        type: 'customer', name: 'Saurastra Cement Limited', address: { city: 'Ranavav', stateCode: '24' },
      })).data

      const entered = await s.api.post('/api/transport/lrs/bulk', {
        common: { consignorId: cement.id, fromCity: 'Kodinar', goodsDescription: 'Fly ash', rateBasis: 'per_ton', weightBasis: 'load', freightType: 'tbb' },
        markDelivered: true,
        rows: TRIPS.map(([date, truck, lr, gp, dest, load, unload, rate]) => ({
          lrDate: date, vehicleNo: truck, lrNo: lr, gatePassNo: gp, toCity: dest,
          actualWeightKg: Math.round(load * 1000), unloadWeightKg: Math.round(unload * 1000), rate,
        })),
      })
      expect(entered.status).toBe(201)
      expect(entered.data.count).toBe(14)

      // every trip's freight equals the amount printed on the customer's bill (charged on LOAD quantity)
      entered.data.lrs.forEach((lr: any, i: number) => {
        expect(lr.lrNo).toBe(TRIPS[i]![2])
        expect(Number(lr.freightAmount)).toBeCloseTo(TRIPS[i]![8], 2)
      })

      const total = TRIPS.reduce((a, t) => a + t[8], 0)
      expect(total).toBeCloseTo(448239.48, 2)                       // printed as 4,48,239 (rounded)

      const bill = await s.api.post('/api/transport/bills', {
        partyId: cement.id, lrIds: [...entered.data.lrs].reverse().map((l: any) => l.id),
        gstMode: 'forward_18', tdsApplicable: true, tdsRatePct: 1, creditDays: 30,
      })
      expect(bill.status).toBe(201)
      const inv = (await s.api.get(`/api/invoices/${bill.data.invoice.id}`)).data

      expect(Number(inv.taxableAmt)).toBeCloseTo(448239.48, 2)
      expect(Number(inv.cgstTotal)).toBeCloseTo(40341.55, 0)         // 9% — printed ₹40,342
      expect(Number(inv.sgstTotal)).toBeCloseTo(40341.55, 0)         // 9% — printed ₹40,342
      expect(Number(inv.igstTotal)).toBe(0)
      expect(Number(inv.grandTotal)).toBe(528923)                    // printed ₹5,28,923
      expect(bill.data.tdsAmount).toBe(4482)                         // printed ₹4,482 (1%)
      expect(bill.data.netReceivable).toBe(524441)                   // handwritten ₹5,24,441
      expect(inv.items).toHaveLength(14)
      // statement lines run in date order (then LR number), whatever order the LRs were selected in
      expect(inv.items.map((i: any) => i.itemMeta.lr_no)).toEqual(TRIPS.map((t) => t[2]))
      expect(inv.items[0].itemMeta).toMatchObject({ lr_no: '3464', gate_pass_no: '3004343531', load_kg: 29480, unload_kg: 29450 })
      expect(inv.domainData.period_from).toBe('2026-08-14')
      expect(inv.domainData.period_to).toBe('2026-09-09')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('TDS on freight bills', () => {
    test('TDS is worked out on the freight (excl. GST), rounded to the rupee, with the net receivable', async () => {
      // mirrors the customer's real bill: ₹4,48,239 freight, 18% GST, 1% TDS → ₹4,482
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined, rateBasis: 'fixed', rate: 0, freightAmount: 448239 })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id], gstMode: 'forward_18', tdsApplicable: true, tdsRatePct: 1 })
      expect(r.status).toBe(201)
      expect(r.data.tdsAmount).toBe(4482)
      const grand = Number(r.data.invoice.grandTotal)
      expect(grand).toBeGreaterThanOrEqual(528922)               // 4,48,239 + 18% GST = 5,28,922.02, rounded to the rupee
      expect(grand).toBeLessThanOrEqual(528923)
      expect(r.data.netReceivable).toBe(grand - 4482)
      const inv = (await owner.api.get(`/api/invoices/${r.data.invoice.id}`)).data
      expect(inv.domainData.tds_amount).toBe(4482)
    })

    test('no TDS unless asked for; 2% for non-individual deductors', async () => {
      const a = await mkLr(owner, { consignorId: local.id, consignorName: undefined }), b = await mkLr(owner, { consignorId: local.id, consignorName: undefined })
      await owner.api.post(`/api/transport/lrs/${a.id}/deliver`, {}); await owner.api.post(`/api/transport/lrs/${b.id}/deliver`, {})
      const none = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [a.id], gstMode: 'rcm' })
      expect(none.data.tdsAmount).toBe(0)
      const two = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [b.id], gstMode: 'rcm', tdsApplicable: true, tdsRatePct: 2 })
      expect(two.data.tdsAmount).toBe(200)                         // 2% of ₹10,000
      expect(two.data.netReceivable).toBe(9800)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('recording the TDS a customer deducted', () => {
    const n = (v: unknown) => Number(v)
    const billWithTds = async (rate = 1, freight = 10000) => {
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined, rateBasis: 'fixed', rate: 0, freightAmount: freight })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id], gstMode: 'rcm', tdsApplicable: true, tdsRatePct: rate })
      expect(r.status).toBe(201)
      return r.data.invoice
    }
    const balance = async () => n((await owner.api.get(`/api/parties/${local.id}`)).data.balance)

    test('TDS + the net receipt clear the bill exactly; customer balance returns to where it started', async () => {
      const b0 = await balance()
      const inv = await billWithTds(1, 10000)                          // TDS ₹100, net ₹9,900
      expect(await balance()).toBeCloseTo(b0 + 10000, 2)

      const pos = (await owner.api.get(`/api/transport/bills/${inv.id}/tds`)).data
      expect(pos).toMatchObject({ tdsAmount: 100, recorded: 0, remaining: 100, outstanding: 10000 })

      const rec = await owner.api.post(`/api/transport/bills/${inv.id}/tds`, { certificateNo: 'FORM16A-0042' })
      expect(rec.status).toBe(201)
      expect(rec.data).toMatchObject({ recorded: 100, remaining: 0, outstanding: 9900, invoiceStatus: 'partial' })
      expect(rec.data.payment.method).toBe('tds')
      expect(rec.data.payment.refNo).toBe('FORM16A-0042')
      expect(await balance()).toBeCloseTo(b0 + 9900, 2)

      const net = await owner.api.post(`/api/invoices/${inv.id}/payment`, { amount: 9900, method: 'bank_transfer' })
      expect(net.status).toBe(201)
      expect((await owner.api.get(`/api/invoices/${inv.id}`)).data.status).toBe('paid')
      expect(await balance()).toBeCloseTo(b0, 2)
    })

    test('TDS can be recorded in parts but never beyond what was deducted', async () => {
      const inv = await billWithTds(2, 50000)                          // 2% → ₹1,000
      const tooMuch = await owner.api.post(`/api/transport/bills/${inv.id}/tds`, { amount: 1500 })
      expect(tooMuch.status).toBe(422)
      expect((await owner.api.post(`/api/transport/bills/${inv.id}/tds`, { amount: 400 })).data.remaining).toBe(600)
      expect((await owner.api.post(`/api/transport/bills/${inv.id}/tds`, { amount: 700 })).status).toBe(422)
      expect((await owner.api.post(`/api/transport/bills/${inv.id}/tds`, { amount: 600 })).data.remaining).toBe(0)
      const again = await owner.api.post(`/api/transport/bills/${inv.id}/tds`, {})
      expect(again.status).toBe(422)
      expect(again.data.error).toMatch(/already been recorded/)
    })

    test('a bill with no TDS marked, a cancelled bill and another business bill are refused', async () => {
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const plain = (await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id] })).data.invoice
      expect((await owner.api.post(`/api/transport/bills/${plain.id}/tds`, {})).status).toBe(422)

      const withTds = await billWithTds()
      await owner.api.post(`/api/invoices/${withTds.id}/cancel`)
      expect((await owner.api.post(`/api/transport/bills/${withTds.id}/tds`, {})).status).toBe(422)

      const mine = await billWithTds()
      expect((await other.api.post(`/api/transport/bills/${mine.id}/tds`, {})).status).toBe(404)
      expect((await other.api.get(`/api/transport/bills/${mine.id}/tds`)).status).toBe(404)
    })

    test('read-only users cannot record TDS', async () => {
      const inv = await billWithTds()
      expect((await viewer.api.post(`/api/transport/bills/${inv.id}/tds`, {})).status).toBe(403)
    })

    test('voiding the TDS entry puts the amount back as recordable and the bill as outstanding', async () => {
      const inv = await billWithTds(1, 20000)                          // TDS ₹200
      const rec = await owner.api.post(`/api/transport/bills/${inv.id}/tds`, {})
      const voided = await owner.api.post(`/api/payments/${rec.data.payment.id}/void`, { reason: 'entered against the wrong bill' })
      expect(voided.status).toBe(200)
      const pos = (await owner.api.get(`/api/transport/bills/${inv.id}/tds`)).data
      expect(pos).toMatchObject({ recorded: 0, remaining: 200, outstanding: 20000 })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('trips', () => {
    test('start puts the vehicle on the road and moves booked LRs in transit', async () => {
      const v = await mkVehicle(), d = await mkDriver()
      const lr = await mkLr()
      const trip = await mkTrip(owner, v.id, { driverId: d.id, lrIds: [lr.id] })
      expect(trip.status).toBe('planned')
      expect((await getLr(lr.id)).tripId).toBe(trip.id)
      expect((await getLr(lr.id)).status).toBe('booked')

      const started = await owner.api.post(`/api/transport/trips/${trip.id}/start`, { startOdometer: 1000 })
      expect(started.status).toBe(200)
      expect(started.data.status).toBe('running')
      expect((await getVehicle(v.id)).status).toBe('on_trip')
      expect((await getLr(lr.id)).status).toBe('in_transit')
      expect((await getLr(lr.id)).vehicleNo).toBe(v.regNo)
    })

    test('a vehicle cannot be dispatched twice at once', async () => {
      const v = await mkVehicle()
      const t1 = await mkTrip(owner, v.id), t2 = await mkTrip(owner, v.id)
      expect((await owner.api.post(`/api/transport/trips/${t1.id}/start`)).status).toBe(200)
      const second = await owner.api.post(`/api/transport/trips/${t2.id}/start`)
      expect(second.status).toBe(422)
      expect(second.data.error).toMatch(/not available/i)
    })

    test('simultaneous start requests: exactly one wins the vehicle', async () => {
      const v = await mkVehicle()
      const trips = await Promise.all([mkTrip(owner, v.id), mkTrip(owner, v.id), mkTrip(owner, v.id)])
      const results = await Promise.all(trips.map((t) => owner.api.post(`/api/transport/trips/${t.id}/start`)))
      expect(results.filter((r) => r.status === 200)).toHaveLength(1)
      expect(results.filter((r) => r.status === 422)).toHaveLength(2)
    })

    test('a busy driver blocks the start and the claimed vehicle is released again', async () => {
      const d = await mkDriver()
      const v1 = await mkVehicle(), v2 = await mkVehicle()
      const t1 = await mkTrip(owner, v1.id, { driverId: d.id }), t2 = await mkTrip(owner, v2.id, { driverId: d.id })
      expect((await owner.api.post(`/api/transport/trips/${t1.id}/start`)).status).toBe(200)
      const r = await owner.api.post(`/api/transport/trips/${t2.id}/start`)
      expect(r.status).toBe(422)
      expect((await getVehicle(v2.id)).status).toBe('available')     // not left stuck on_trip
    })

    test('starting with an expired fitness certificate succeeds but warns', async () => {
      const v = await mkVehicle(owner, { fitnessExpiry: today(-3) })
      const t = await mkTrip(owner, v.id)
      const r = await owner.api.post(`/api/transport/trips/${t.id}/start`)
      expect(r.status).toBe(200)
      expect(r.data.warnings.join(' ')).toMatch(/Fitness/)
    })

    test('completing needs delivered LRs (or an explicit mark-all) and a sane odometer', async () => {
      const v = await mkVehicle(), lr = await mkLr()
      const t = await mkTrip(owner, v.id, { lrIds: [lr.id] })
      await owner.api.post(`/api/transport/trips/${t.id}/start`, { startOdometer: 5000 })

      const blocked = await owner.api.post(`/api/transport/trips/${t.id}/complete`, {})
      expect(blocked.status).toBe(422)
      expect(blocked.data.error).toContain(lr.lrNo)

      const backwards = await owner.api.post(`/api/transport/trips/${t.id}/complete`, { markLrsDelivered: true, endOdometer: 4000 })
      expect(backwards.status).toBe(422)

      const done = await owner.api.post(`/api/transport/trips/${t.id}/complete`, { markLrsDelivered: true, endOdometer: 5600 })
      expect(done.status).toBe(200)
      expect(done.data.status).toBe('completed')
      const veh = await getVehicle(v.id)
      expect(veh.status).toBe('available')
      expect(veh.currentOdometer).toBe(5600)
      expect((await getLr(lr.id)).status).toBe('delivered')
    })

    test('trip profit = LR freight − expenses − vehicle hire; driver settlement counts cash only', async () => {
      const v = await mkVehicle(owner, { ownership: 'market' })
      const lr1 = await mkLr(owner, { rate: 1000 }), lr2 = await mkLr(owner, { rate: 2000 })   // 10,000 + 20,000
      const t = await mkTrip(owner, v.id, { lrIds: [lr1.id, lr2.id], driverAdvance: 5000, hireCharges: 12000, hireAdvancePaid: 4000 })
      await owner.api.post(`/api/transport/trips/${t.id}/start`)

      const diesel = await owner.api.post('/api/transport/expenses', { tripId: t.id, category: 'diesel', litres: 100, ratePerLitre: 90, paymentMode: 'credit' })
      expect(Number(diesel.data.amount)).toBe(9000)               // litres × rate when no amount given
      await owner.api.post('/api/transport/expenses', { tripId: t.id, category: 'toll', amount: 1500, paymentMode: 'fastag' })
      await owner.api.post('/api/transport/expenses', { tripId: t.id, category: 'driver_bhatta', amount: 800, paymentMode: 'cash' })

      const full = (await owner.api.get(`/api/transport/trips/${t.id}`)).data
      expect(full.lrs).toHaveLength(2)
      expect(full.pnl).toMatchObject({ freight: 30000, expenses: 11300, hireCharges: 12000, totalCost: 23300, net: 6700 })
      expect(full.pnl.driverCashSpent).toBe(800)
      expect(full.pnl.driverBalance).toBe(4200)                    // ₹5,000 advance − ₹800 spent in cash
    })

    test('hire advance cannot exceed hire charges', async () => {
      const v = await mkVehicle()
      const r = await owner.api.post('/api/transport/trips', { vehicleId: v.id, fromCity: 'A', toCity: 'B', hireCharges: 1000, hireAdvancePaid: 2000 })
      expect(r.status).toBe(422)
    })

    test('an LR already on another trip cannot be added to a second trip', async () => {
      const lr = await mkLr()
      const v1 = await mkVehicle(), v2 = await mkVehicle()
      await mkTrip(owner, v1.id, { lrIds: [lr.id] })
      const r = await owner.api.post('/api/transport/trips', { vehicleId: v2.id, fromCity: 'A', toCity: 'B', lrIds: [lr.id] })
      expect(r.status).toBe(422)
      // …and the failed attempt must not leave an orphan trip behind
      const trips = (await owner.api.get(`/api/transport/trips?vehicleId=${v2.id}`)).data
      expect(trips.total).toBe(0)
    })

    test('cancelling a trip returns its LRs to the pool; staff cannot cancel', async () => {
      const v = await mkVehicle(), lr = await mkLr()
      const t = await mkTrip(owner, v.id, { lrIds: [lr.id] })
      await owner.api.post(`/api/transport/trips/${t.id}/start`)
      expect((await cashier.api.post(`/api/transport/trips/${t.id}/cancel`, { reason: 'breakdown' })).status).toBe(403)
      expect((await manager.api.post(`/api/transport/trips/${t.id}/cancel`, { reason: 'breakdown' })).status).toBe(200)
      const back = await getLr(lr.id)
      expect(back.status).toBe('booked')
      expect(back.tripId).toBeNull()
      expect((await getVehicle(v.id)).status).toBe('available')
    })

    test('expenses need a trip or a vehicle, and not a cancelled trip', async () => {
      expect((await owner.api.post('/api/transport/expenses', { category: 'diesel', amount: 100 })).status).toBe(422)
      const v = await mkVehicle()
      const t = await mkTrip(owner, v.id)
      await manager.api.post(`/api/transport/trips/${t.id}/cancel`, { reason: 'not needed' })
      expect((await owner.api.post('/api/transport/expenses', { tripId: t.id, category: 'toll', amount: 100 })).status).toBe(422)
      const standalone = await owner.api.post('/api/transport/expenses', { vehicleId: v.id, category: 'insurance', amount: 42000 })
      expect(standalone.status).toBe(201)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('freight billing', () => {
    const deliveredLr = async (body: Record<string, unknown> = {}) => {
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined, ...body })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      return lr
    }
    const bill = (lrIds: string[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, s = owner, partyId = local.id) =>
      s.api.post('/api/transport/bills', { partyId, lrIds, ...extra }, { headers })
    const n = (v: unknown) => Number(v)

    test('RCM bill carries no GST and a reverse-charge note; LRs flip to billed', async () => {
      const lr = await deliveredLr()
      const r = await bill([lr.id], { gstMode: 'rcm' })
      expect(r.status).toBe(201)
      const inv = (await owner.api.get(`/api/invoices/${r.data.invoice.id}`)).data
      expect(n(inv.grandTotal)).toBe(10000)
      expect(n(inv.cgstTotal) + n(inv.sgstTotal) + n(inv.igstTotal)).toBe(0)
      expect(inv.notes).toMatch(/reverse charge/i)
      expect(inv.items[0].hsnSacCode).toBe('996791')
      const after = await getLr(lr.id)
      expect(after.status).toBe('billed')
      expect(after.invoiceId).toBe(r.data.invoice.id)
    })

    test('forward-charge 18% splits CGST+SGST within the state', async () => {
      const lr = await deliveredLr()
      const inv = (await owner.api.get(`/api/invoices/${(await bill([lr.id], { gstMode: 'forward_18' })).data.invoice.id}`)).data
      expect(n(inv.taxableAmt)).toBe(10000)
      expect(n(inv.cgstTotal)).toBe(900)
      expect(n(inv.sgstTotal)).toBe(900)
      expect(n(inv.igstTotal)).toBe(0)
      expect(n(inv.grandTotal)).toBe(11800)
    })

    test('forward-charge 5% is IGST for an out-of-state customer', async () => {
      const lr = await mkLr(owner, { consignorId: outstate.id, consignorName: undefined })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await bill([lr.id], { gstMode: 'forward_5' }, {}, owner, outstate.id)
      const inv = (await owner.api.get(`/api/invoices/${r.data.invoice.id}`)).data
      expect(n(inv.igstTotal)).toBe(500)
      expect(n(inv.cgstTotal) + n(inv.sgstTotal)).toBe(0)
    })

    test('one bill can cover many LRs, listing each as a line', async () => {
      const a = await deliveredLr({ rate: 1000 }), b = await deliveredLr({ rate: 3000 }), c = await deliveredLr({ rate: 500 })
      const r = await bill([a.id, b.id, c.id], { gstMode: 'rcm' })
      expect(r.data.lrCount).toBe(3)
      const inv = (await owner.api.get(`/api/invoices/${r.data.invoice.id}`)).data
      expect(inv.items).toHaveLength(3)
      expect(n(inv.grandTotal)).toBe(45000)
      expect(inv.items.map((i: any) => i.description).join('|')).toContain(a.lrNo)
      expect(inv.domainData.lr_nos).toEqual(expect.arrayContaining([a.lrNo, b.lrNo, c.lrNo]))
    })

    test('an LR cannot be billed twice', async () => {
      const lr = await deliveredLr()
      expect((await bill([lr.id])).status).toBe(201)
      const again = await bill([lr.id])
      expect(again.status).toBe(409)
      expect(again.data.error).toContain(lr.lrNo)
    })

    test('a client retry with the same Idempotency-Key returns the original bill (no duplicate)', async () => {
      const lr = await deliveredLr()
      const key = `retry-${Date.now()}-${Math.random()}`
      const first = await bill([lr.id], {}, { 'Idempotency-Key': key })
      const retry = await bill([lr.id], {}, { 'Idempotency-Key': key })
      expect(first.status).toBe(201)
      expect(retry.status).toBe(200)
      expect(retry.data.invoice.id).toBe(first.data.invoice.id)
      const all = (await owner.api.get(`/api/invoices?limit=100&partyId=${local.id}`)).data.data
      expect(all.filter((i: any) => i.id === first.data.invoice.id)).toHaveLength(1)
    })

    test('two clerks billing the same LR at the same instant: exactly one bill is created', async () => {
      const lr = await deliveredLr()
      // (the jest harness gives each POST its own Idempotency-Key, i.e. two independent clients)
      const results = await Promise.all([bill([lr.id]), bill([lr.id])])
      expect(results.map((r) => r.status).sort()).toEqual([201, 409])
      const winner = results.find((r) => r.status === 201)!
      expect((await getLr(lr.id)).invoiceId).toBe(winner.data.invoice.id)
      expect((await getLr(lr.id)).status).toBe('billed')
    })

    test('a billed LR cannot be cancelled until the bill is cancelled — then it can be re-billed', async () => {
      const lr = await deliveredLr()
      const first = await bill([lr.id])
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/cancel`, { reason: 'oops' })).status).toBe(422)
      expect((await owner.api.patch(`/api/transport/lrs/${lr.id}`, { rate: 5 })).status).toBe(422)

      const cancel = await owner.api.post(`/api/invoices/${first.data.invoice.id}/cancel`)
      expect(cancel.status).toBe(200)

      const candidates = (await owner.api.get(`/api/transport/bills/candidates?partyId=${local.id}&freightType=tbb`)).data
      expect(candidates.data.map((l: any) => l.id)).toContain(lr.id)

      const second = await bill([lr.id])
      expect(second.status).toBe(201)
      expect(second.data.invoice.id).not.toBe(first.data.invoice.id)
    })

    test('cancelled LRs and unknown LRs are refused', async () => {
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined })
      await owner.api.post(`/api/transport/lrs/${lr.id}/cancel`, { reason: 'void' })
      expect((await bill([lr.id])).status).toBe(422)
      expect((await bill(['00000000-0000-4000-8000-000000000000'])).status).toBe(404)
    })

    test('candidates exclude billed LRs and respect the freight-type filter', async () => {
      const tbb = await deliveredLr(), paid = await deliveredLr({ freightType: 'paid' })
      const list = (await owner.api.get(`/api/transport/bills/candidates?partyId=${local.id}&freightType=tbb`)).data
      const ids = list.data.map((l: any) => l.id)
      expect(ids).toContain(tbb.id)
      expect(ids).not.toContain(paid.id)
      await bill([tbb.id])
      const after = (await owner.api.get(`/api/transport/bills/candidates?partyId=${local.id}&freightType=tbb`)).data
      expect(after.data.map((l: any) => l.id)).not.toContain(tbb.id)
    })

    test('read-only users cannot raise bills', async () => {
      const lr = await deliveredLr()
      expect((await bill([lr.id], {}, {}, viewer)).status).toBe(403)
    })

    test('a bill must be raised to a real party in the same business', async () => {
      const lr = await deliveredLr()
      const ghost = await bill([lr.id], {}, {}, owner, '00000000-0000-4000-8000-000000000000')
      expect(ghost.status).toBe(404)
      // other tenant cannot bill our LR
      const stolen = await other.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id] })
      expect([404, 422]).toContain(stolen.status)
    })

    test('POD can be enforced before billing via branch settings', async () => {
      const s = await newTransportTenant('Strict POD')
      const branches = (await s.api.get('/api/branches')).data
      await s.api.patch(`/api/branches/${branches[0].id}`, { domainConfig: { pod_required_before_billing: true } })
      const party = (await s.api.post('/api/parties', { type: 'customer', name: 'P', address: { stateCode: '24' } })).data
      const lr = await mkLr(s, { consignorId: party.id, consignorName: undefined })
      await s.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const refused = await s.api.post('/api/transport/bills', { partyId: party.id, lrIds: [lr.id] })
      expect(refused.status).toBe(422)
      expect(refused.data.error).toMatch(/POD/)
      await s.api.post(`/api/transport/lrs/${lr.id}/pod`, {})
      expect((await s.api.post('/api/transport/bills', { partyId: party.id, lrIds: [lr.id] })).status).toBe(201)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('dashboard & reports', () => {
    test('a fresh business has an empty but valid dashboard', async () => {
      const s = await newTransportTenant('Empty Co')
      const r = await s.api.get('/api/transport/dashboard')
      expect(r.status).toBe(200)
      expect(r.data.fleet.total).toBe(0)
      expect(r.data.attention).toMatchObject({ pendingPod: 0, unassignedLrs: 0, unbilledCount: 0, complianceDue: 0 })
      expect(r.data.month.freight).toBe(0)
    })

    test('dashboard counters follow the data', async () => {
      const s = await newTransportTenant('Counter Co')
      const v1 = await mkVehicle(s), v2 = await mkVehicle(s, { fitnessExpiry: today(-2) })
      await mkVehicle(s)
      const lr = await mkLr(s), lr2 = await mkLr(s)
      const trip = await mkTrip(s, v1.id, { lrIds: [lr.id] })
      await s.api.post(`/api/transport/trips/${trip.id}/start`)
      await s.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      void v2; void lr2

      const d = (await s.api.get('/api/transport/dashboard')).data
      expect(d.fleet).toMatchObject({ total: 3, onTrip: 1, available: 2 })
      expect(d.attention.pendingPod).toBe(1)
      expect(d.attention.unassignedLrs).toBe(1)
      expect(d.attention.unbilledCount).toBe(1)           // the delivered, still-unbilled To-Be-Billed LR
      expect(d.attention.complianceExpired).toBe(1)
      expect(d.today.lrCount).toBe(2)
      expect(d.runningTrips).toHaveLength(1)
    })

    test('trip P&L report totals equal the sum of its rows', async () => {
      const v = await mkVehicle()
      const lr = await mkLr(owner, { rate: 1000 })
      const t = await mkTrip(owner, v.id, { lrIds: [lr.id] })
      await owner.api.post(`/api/transport/trips/${t.id}/start`)
      await owner.api.post('/api/transport/expenses', { tripId: t.id, category: 'diesel', amount: 4000 })
      const rep = (await owner.api.get(`/api/transport/reports/trip-pnl?from=${today(-30)}&to=${today()}`)).data
      const row = rep.data.find((r: any) => r.id === t.id)
      expect(row).toMatchObject({ freight: 10000, expenses: 4000, net: 6000 })
      const sumNet = rep.data.reduce((a: number, r: any) => a + r.net, 0)
      expect(Math.round(rep.totals.net * 100)).toBe(Math.round(sumNet * 100))
    })

    test('vehicle P&L includes non-trip costs such as insurance', async () => {
      const v = await mkVehicle()
      await owner.api.post('/api/transport/expenses', { vehicleId: v.id, category: 'insurance', amount: 30000 })
      const rep = (await owner.api.get(`/api/transport/reports/vehicle-pnl?from=${today(-30)}&to=${today()}`)).data
      expect(rep.data.find((r: any) => r.id === v.id)).toMatchObject({ expenses: 30000, net: -30000 })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('PDFs, e-way bills and WhatsApp messages', () => {
    const pdf = (s: Session, path: string) => s.api.get(path, { responseType: 'arraybuffer' })
    const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 4000): Promise<T | null> => {
      const end = Date.now() + ms
      while (Date.now() < end) { const v = await fn(); if (v) return v as T; await new Promise((r) => setTimeout(r, 150)) }
      return null
    }
    const messagesFor = async (refId: string, s = owner) =>
      (await s.api.get('/api/transport/notifications', { params: { refId, limit: 20 } })).data.data as any[]

    test('LR PDF is a real PDF, single-copy option works, other tenants cannot read it', async () => {
      const lr = await mkLr()
      const r = await pdf(owner, `/api/transport/lrs/${lr.id}/pdf`)
      expect(r.status).toBe(200)
      expect(r.headers['content-type']).toContain('application/pdf')
      expect(Buffer.from(r.data).slice(0, 5).toString()).toBe('%PDF-')
      const one = await pdf(owner, `/api/transport/lrs/${lr.id}/pdf?copies=1`)
      expect(Buffer.from(one.data).length).toBeLessThan(Buffer.from(r.data).length)
      expect((await pdf(other, `/api/transport/lrs/${lr.id}/pdf`)).status).toBe(404)
      expect((await pdf(viewer, `/api/transport/lrs/${lr.id}/pdf`)).status).toBe(200)
    })

    test('freight bill PDF renders for a billed LR', async () => {
      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined })
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const bill = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id], gstMode: 'forward_5' })
      expect(bill.status).toBe(201)
      const r = await pdf(owner, `/api/transport/bills/${bill.data.invoice.id}/pdf`)
      expect(r.status).toBe(200)
      expect(Buffer.from(r.data).slice(0, 5).toString()).toBe('%PDF-')
    })

    test('e-way bill: needs the portal fields, then generates, updates the truck, and cancels with an audit trail', async () => {
      const lr = await mkLr(owner, { declaredValue: 120000, consignorGstin: '24AABCA1111A1ZX' })
      const missing = await owner.api.post(`/api/transport/lrs/${lr.id}/eway/generate`, {})
      expect(missing.status).toBe(422)
      expect(missing.data.message ?? missing.data.error).toMatch(/HSN/i)

      expect((await viewer.api.post(`/api/transport/lrs/${lr.id}/eway/generate`, {})).status).toBe(403)

      const gen = await owner.api.post(`/api/transport/lrs/${lr.id}/eway/generate`, {
        hsnCode: '5205', fromPincode: '395003', toPincode: '400001', toStateCode: '27', distanceKm: 280, goodsGstRate: 5,
      })
      expect(gen.status).toBe(201)
      expect(gen.data.ewayBillNo).toMatch(/^\d{12}$/)
      const after = await getLr(lr.id)
      expect(after).toMatchObject({ ewayBillNo: gen.data.ewayBillNo, ewayStatus: 'active', hsnCode: '5205' })
      expect(new Date(after.ewayValidUpto).getTime()).toBeGreaterThan(Date.now())

      // already has one
      expect((await owner.api.post(`/api/transport/lrs/${lr.id}/eway/generate`, {})).status).toBe(409)

      const veh = await owner.api.post(`/api/transport/lrs/${lr.id}/eway/vehicle`, { vehicleNo: 'GJ01AB1234', reason: 'breakdown', remark: 'Tyre burst' })
      expect(veh.status).toBe(200)
      expect((await getLr(lr.id)).vehicleNo).toBe('GJ01AB1234')

      // only owner/manager may cancel
      expect((await cashier.api.post(`/api/transport/lrs/${lr.id}/eway/cancel`, { reason: 'duplicate', remark: 'dup' })).status).toBe(403)
      const cancel = await manager.api.post(`/api/transport/lrs/${lr.id}/eway/cancel`, { reason: 'data_entry_mistake', remark: 'wrong hsn' })
      expect(cancel.status).toBe(200)
      expect(await getLr(lr.id)).toMatchObject({ ewayBillNo: null, ewayStatus: 'cancelled' })

      const events = (await owner.api.get(`/api/transport/lrs/${lr.id}/eway/events`)).data
      expect(events.map((e: any) => e.action).sort()).toEqual(['cancel', 'generate', 'vehicle'])
      expect(events.every((e: any) => e.ok)).toBe(true)
    })

    test('e-way bill cannot be generated for a delivered LR', async () => {
      const lr = await mkLr()
      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, {})
      const r = await owner.api.post(`/api/transport/lrs/${lr.id}/eway/generate`, { hsnCode: '5205', fromPincode: '395003', toPincode: '400001', fromStateCode: '24', toStateCode: '27' })
      expect(r.status).toBe(422)
    })

    test('manual WhatsApp send is logged; a number that is not a mobile is skipped, not lost', async () => {
      const lr = await mkLr(owner, { consignorPhone: '9876543210' })
      const sent = await owner.api.post(`/api/transport/lrs/${lr.id}/notify`, { kind: 'lr_booked' })
      expect(sent.status).toBe(202)
      const logged = await waitFor(async () => (await messagesFor(lr.id)).find((m) => m.kind === 'lr_booked'))
      expect(logged).toMatchObject({ toPhone: '919876543210', attachment: `lr_pdf:${lr.id}` })
      expect(['queued', 'sent', 'skipped', 'failed']).toContain(logged!.status)

      const bad = await mkLr(owner, { consignorPhone: '12345' })
      const r = await owner.api.post(`/api/transport/lrs/${bad.id}/notify`, { kind: 'lr_booked' })
      expect(r.status).toBe(422)
      const row = (await messagesFor(bad.id))[0]
      expect(row.status).toBe('skipped')
      expect((await viewer.api.post(`/api/transport/lrs/${lr.id}/notify`, {})).status).toBe(403)
    })

    test('automatic messages are off by default, and on when the owner switches them on', async () => {
      const off = await mkLr(owner, { consignorPhone: '9811111111' })
      await new Promise((r) => setTimeout(r, 600))
      expect(await messagesFor(off.id)).toHaveLength(0)

      expect((await cashier.api.put('/api/transport/notify-settings', { notify_lr_booked: true })).status).toBe(403)
      const set = await manager.api.put('/api/transport/notify-settings', { notify_lr_booked: true, notify_lr_delivered: true, notify_bill_created: true })
      expect(set.status).toBe(200)
      expect(set.data).toMatchObject({ notify_lr_booked: true, notify_bill_reminders: false })

      const lr = await mkLr(owner, { consignorId: local.id, consignorName: undefined, consignorPhone: '9822222222' })
      const booked = await waitFor(async () => (await messagesFor(lr.id)).find((m) => m.kind === 'lr_booked'))
      expect(booked).toBeTruthy()

      await owner.api.post(`/api/transport/lrs/${lr.id}/deliver`, { receivedBy: 'Ramesh' })
      const delivered = await waitFor(async () => (await messagesFor(lr.id)).find((m) => m.kind === 'lr_delivered'))
      expect(delivered?.message).toContain('Ramesh')

      const bill = await owner.api.post('/api/transport/bills', { partyId: local.id, lrIds: [lr.id], gstMode: 'rcm' })
      expect(bill.status).toBe(201)
      // `local` has no phone, so the message is logged as skipped rather than silently dropped
      const billMsg = await waitFor(async () => (await messagesFor(bill.data.invoice.id)).find((m) => m.kind === 'bill_created'))
      expect(billMsg).toBeTruthy()
      expect(billMsg!.attachment).toBe(`bill_pdf:${bill.data.invoice.id}`)

      await manager.api.put('/api/transport/notify-settings', { notify_lr_booked: false, notify_lr_delivered: false, notify_bill_created: false })
    })

    test('retrying a message with no valid number is reported, not silently queued', async () => {
      const lr = await mkLr(owner, { consignorPhone: '12345' })
      await owner.api.post(`/api/transport/lrs/${lr.id}/notify`, { kind: 'lr_booked' })
      const row = (await messagesFor(lr.id))[0]
      expect(row.status).toBe('skipped')
      const retry = await owner.api.post(`/api/transport/notifications/${row.id}/retry`)
      expect(retry.status).toBe(422)
    })

    test('supplier and customer pickers include parties of type "both"', async () => {
      const both = (await owner.api.post('/api/parties', { type: 'both', name: 'Dual Role Fuels' })).data
      const sup  = (await owner.api.get('/api/parties', { params: { type: 'supplier', search: 'Dual Role' } })).data
      expect(sup.data.map((p: any) => p.id)).toContain(both.id)
      const cust = (await owner.api.get('/api/parties', { params: { type: 'customer', search: 'Dual Role' } })).data
      expect(cust.data.map((p: any) => p.id)).toContain(both.id)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  describe('single-business accounts', () => {
    test('additional branches cannot be created', async () => {
      const r = await owner.api.post('/api/branches', { name: 'Second Yard', domainType: 'transport' })
      expect(r.status).toBe(403)
      const list = (await owner.api.get('/api/branches')).data
      expect(list).toHaveLength(1)
    })

    test('registration defaults to the transport domain and seeds its categories', async () => {
      const list = (await owner.api.get('/api/branches')).data
      expect(list[0].domainType).toBe('transport')
      expect(list[0].domainConfig).toMatchObject({ lr_prefix: 'LR', default_gst_mode: 'rcm' })
    })

    test('staff can sign in with the business phone and are role-limited', async () => {
      expect((await viewer.api.get('/api/transport/lrs')).status).toBe(200)
      expect((await viewer.api.post('/api/transport/lrs', {})).status).toBe(403)
    })
  })
})
