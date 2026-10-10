// apps/api/src/lib/eway-provider.ts
// E-way bill generation through a GST Suvidha Provider (GSP).
//
// The NIC e-way bill portal is only reachable through an authorised GSP (or the taxpayer's own
// API credentials). Two providers are implemented behind one interface:
//
//   mock         (default when no credentials are configured) — deterministic fake numbers with the
//                real Rule 138(10) validity maths. Lets the whole flow run and be tested offline.
//   mastersindia — Masters India's e-way bill REST API. Enabled with EWAY_PROVIDER=mastersindia plus
//                MASTERS_INDIA_USERNAME / MASTERS_INDIA_PASSWORD (and EWAY_SANDBOX=true to use their
//                sandbox host first).
//
// ⚠ The Masters India request/response field names below follow their published e-way bill API
//   documentation as best recalled and have NOT been exercised against a live account from this
//   codebase. Run `POST /api/transport/lrs/:id/eway/generate` against their sandbox with a test
//   GSTIN and fix any field-name differences — they are all confined to `mastersIndiaPayloads`.

export const GST_STATE_NAMES: Record<string, string> = {
  '01': 'JAMMU AND KASHMIR', '02': 'HIMACHAL PRADESH', '03': 'PUNJAB', '04': 'CHANDIGARH', '05': 'UTTARAKHAND',
  '06': 'HARYANA', '07': 'DELHI', '08': 'RAJASTHAN', '09': 'UTTAR PRADESH', '10': 'BIHAR', '11': 'SIKKIM',
  '12': 'ARUNACHAL PRADESH', '13': 'NAGALAND', '14': 'MANIPUR', '15': 'MIZORAM', '16': 'TRIPURA', '17': 'MEGHALAYA',
  '18': 'ASSAM', '19': 'WEST BENGAL', '20': 'JHARKHAND', '21': 'ODISHA', '22': 'CHHATTISGARH', '23': 'MADHYA PRADESH',
  '24': 'GUJARAT', '26': 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU', '27': 'MAHARASHTRA', '29': 'KARNATAKA',
  '30': 'GOA', '31': 'LAKSHADWEEP', '32': 'KERALA', '33': 'TAMIL NADU', '34': 'PUDUCHERRY',
  '35': 'ANDAMAN AND NICOBAR ISLANDS', '36': 'TELANGANA', '37': 'ANDHRA PRADESH', '38': 'LADAKH', '97': 'OTHER TERRITORY',
}

export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

export interface EwayParty {
  name: string
  gstin: string | null         // null/'' → unregistered (sent as "URP")
  address: string
  place: string
  pincode: string
  stateCode: string            // 2-digit GST state code
}

export interface EwayGenerateInput {
  userGstin: string            // the GSTIN the e-way bill is generated under (the transporter's)
  docType: 'Tax Invoice' | 'Bill of Supply' | 'Delivery Challan' | 'Others'
  docNo: string
  docDate: string              // YYYY-MM-DD
  from: EwayParty
  to: EwayParty
  hsnCode: string
  productName: string
  quantity: number
  unit: string                 // portal unit code, e.g. KGS, NOS
  taxableValue: number
  gstRatePct: number           // goods GST rate; split into CGST+SGST or IGST by state
  vehicleNo: string | null
  distanceKm: number           // 0 = let the portal compute from pincodes
  transporterName: string
  transDocNo: string           // the LR number
  transDocDate: string         // YYYY-MM-DD
}

export interface EwayResult {
  ewayBillNo: string
  validUpto: Date
  generatedAt: Date
  raw: unknown
}

export type CancelReason = 'duplicate' | 'order_cancelled' | 'data_entry_mistake' | 'others'
export type VehicleReason = 'breakdown' | 'transhipment' | 'others' | 'first_time'

export interface EwayProvider {
  readonly name: 'mock' | 'mastersindia'
  readonly live: boolean
  generate(input: EwayGenerateInput): Promise<EwayResult & { request: unknown }>
  cancel(args: { userGstin: string; ewayBillNo: string; reason: CancelReason; remark: string }): Promise<{ raw: unknown; request: unknown }>
  updateVehicle(args: {
    userGstin: string; ewayBillNo: string; vehicleNo: string; fromPlace: string; fromStateCode: string
    reason: VehicleReason; remark: string; transDocNo?: string; transDocDate?: string
  }): Promise<{ raw: unknown; request: unknown }>
  extend(args: {
    userGstin: string; ewayBillNo: string; vehicleNo: string; fromPlace: string; fromStateCode: string
    remainingKm: number; reason: string; remark: string; inTransit: boolean
  }): Promise<EwayResult & { request: unknown }>
}

export class EwayError extends Error {
  statusCode: number
  raw?: unknown
  constructor(message: string, statusCode = 502, raw?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.raw = raw
  }
}

// ── Validity (CGST Rule 138(10)) ───────────────────────────────────────────────

/** 1 day per 200 km (100 km for ODC), minimum 1 day, running to 23:59 IST of the last day. */
export function ewayValidity(from: Date, distanceKm: number, odc = false): Date {
  const days = Math.max(1, Math.ceil(distanceKm / (odc ? 100 : 200)))
  const ist = new Date(from.getTime() + 5.5 * 3600_000)
  ist.setUTCHours(23, 59, 59, 0)
  ist.setUTCDate(ist.getUTCDate() + days - 1)
  return new Date(ist.getTime() - 5.5 * 3600_000)
}

// ── Mock provider ──────────────────────────────────────────────────────────────

let mockSeq = 0
function mockNumber(): string {
  // 12 digits, like a real e-way bill number; time-based so restarts do not collide.
  mockSeq = (mockSeq + 1) % 1000
  return `${String(Date.now()).slice(-9)}${String(mockSeq).padStart(3, '0')}`
}

const mockProvider: EwayProvider = {
  name: 'mock',
  live: false,
  async generate(input) {
    const now = new Date()
    const km = input.distanceKm > 0 ? input.distanceKm : 100
    return { ewayBillNo: mockNumber(), generatedAt: now, validUpto: ewayValidity(now, km), raw: { mock: true }, request: input }
  },
  async cancel(args) { return { raw: { mock: true, cancelled: args.ewayBillNo }, request: args } },
  async updateVehicle(args) { return { raw: { mock: true, vehicleNo: args.vehicleNo }, request: args } },
  async extend(args) {
    const now = new Date()
    return { ewayBillNo: args.ewayBillNo, generatedAt: now, validUpto: ewayValidity(now, Math.max(1, args.remainingKm)), raw: { mock: true }, request: args }
  },
}

// ── Masters India provider ─────────────────────────────────────────────────────

const toDdMmYyyy = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`

/** Parses "dd/mm/yyyy hh:mm:ss PM" or "dd/mm/yyyy hh:mm:ss" (IST) → Date. */
function parseNicDate(s: unknown): Date {
  const m = String(s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i)
  if (!m) return new Date(NaN)
  let h = Number(m[4])
  if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0 }
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, Number(m[5]), Number(m[6])) - 5.5 * 3600_000)
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const mastersIndiaPayloads = {
  generate(i: EwayGenerateInput) {
    const interState = i.from.stateCode !== i.to.stateCode
    const tax = r2(i.taxableValue * i.gstRatePct / 100)
    const half = r2(tax / 2)
    return {
      userGstin: i.userGstin,
      supply_type: 'Outward',
      sub_supply_type: 'Supply',
      document_type: i.docType,
      document_number: i.docNo,
      document_date: toDdMmYyyy(i.docDate),
      gstin_of_consignor: i.from.gstin || 'URP',
      legal_name_of_consignor: i.from.name,
      address1_of_consignor: i.from.address.slice(0, 120),
      place_of_consignor: i.from.place,
      pincode_of_consignor: Number(i.from.pincode),
      state_of_consignor: GST_STATE_NAMES[i.from.stateCode] ?? '',
      actual_from_state_name: GST_STATE_NAMES[i.from.stateCode] ?? '',
      gstin_of_consignee: i.to.gstin || 'URP',
      legal_name_of_consignee: i.to.name,
      address1_of_consignee: i.to.address.slice(0, 120),
      place_of_consignee: i.to.place,
      pincode_of_consignee: Number(i.to.pincode),
      state_of_supply: GST_STATE_NAMES[i.to.stateCode] ?? '',
      actual_to_state_name: GST_STATE_NAMES[i.to.stateCode] ?? '',
      transaction_type: 1,
      total_invoice_value: r2(i.taxableValue + tax),
      taxable_amount: i.taxableValue,
      cgst_amount: interState ? 0 : half,
      sgst_amount: interState ? 0 : r2(tax - half),
      igst_amount: interState ? tax : 0,
      cess_amount: 0,
      transportation_mode: 'Road',
      transportation_distance: String(i.distanceKm),
      transporter_name: i.transporterName,
      transporter_id: i.userGstin,
      transporter_document_number: i.transDocNo,
      transporter_document_date: toDdMmYyyy(i.transDocDate),
      vehicle_number: i.vehicleNo ?? '',
      vehicle_type: 'Regular',
      itemList: [{
        product_name: i.productName.slice(0, 100),
        product_description: i.productName.slice(0, 100),
        hsn_code: Number(i.hsnCode),
        unit_of_product: i.unit,
        quantity: i.quantity,
        taxable_amount: i.taxableValue,
        cgst_rate: interState ? 0 : i.gstRatePct / 2,
        sgst_rate: interState ? 0 : i.gstRatePct / 2,
        igst_rate: interState ? i.gstRatePct : 0,
        cess_rate: 0,
      }],
    }
  },
  cancel: (a: { userGstin: string; ewayBillNo: string; reason: CancelReason; remark: string }) => ({
    userGstin: a.userGstin,
    eway_bill_number: Number(a.ewayBillNo),
    reason_of_cancel: ({ duplicate: 'Duplicate', order_cancelled: 'Order Cancelled', data_entry_mistake: 'Data Entry Mistake', others: 'Others' } as const)[a.reason],
    cancel_remark: a.remark,
  }),
  vehicle: (a: { userGstin: string; ewayBillNo: string; vehicleNo: string; fromPlace: string; fromStateCode: string; reason: VehicleReason; remark: string; transDocNo?: string; transDocDate?: string }) => ({
    userGstin: a.userGstin,
    eway_bill_number: Number(a.ewayBillNo),
    vehicle_number: a.vehicleNo,
    place_of_consignor: a.fromPlace,
    state_of_consignor: GST_STATE_NAMES[a.fromStateCode] ?? '',
    reason_code_for_vehicle_updation: ({ breakdown: 'Breakdown', transhipment: 'Transhipment', others: 'Others', first_time: 'First Time' } as const)[a.reason],
    reason_for_vehicle_updation: a.remark,
    transporter_document_number: a.transDocNo ?? '',
    transporter_document_date: a.transDocDate ? toDdMmYyyy(a.transDocDate) : '',
    mode_of_transport: 'Road',
  }),
  extend: (a: { userGstin: string; ewayBillNo: string; vehicleNo: string; fromPlace: string; fromStateCode: string; remainingKm: number; reason: string; remark: string; inTransit: boolean }) => ({
    userGstin: a.userGstin,
    eway_bill_number: Number(a.ewayBillNo),
    vehicle_number: a.vehicleNo,
    place_of_consignor: a.fromPlace,
    state_of_consignor: GST_STATE_NAMES[a.fromStateCode] ?? '',
    remaining_distance: a.remainingKm,
    extend_validity_reason: a.reason,
    extend_remarks: a.remark,
    consignment_status: a.inTransit ? 'M' : 'T',
    mode_of_transport: 'Road',
  }),
}

function mastersIndiaProvider(): EwayProvider {
  const sandbox = process.env['EWAY_SANDBOX'] === 'true'
  const base = (process.env['MASTERS_INDIA_BASE_URL']
    ?? (sandbox ? 'https://sandb-api.mastersindia.co' : 'https://prod-api.mastersindia.co')).replace(/\/$/, '')
  const username = process.env['MASTERS_INDIA_USERNAME']
  const password = process.env['MASTERS_INDIA_PASSWORD']
  if (!username || !password) {
    throw new EwayError('E-way bill provider is not configured — set MASTERS_INDIA_USERNAME and MASTERS_INDIA_PASSWORD', 503)
  }

  let token: { value: string; at: number } | null = null
  async function getToken(force = false): Promise<string> {
    if (!force && token && Date.now() - token.at < 6 * 3600_000) return token.value
    const res = await fetch(`${base}/api/v1/token-auth/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(20_000),
    })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok || !body?.token) throw new EwayError(`E-way provider login failed (${res.status})`, 502, body)
    token = { value: body.token, at: Date.now() }
    return token.value
  }

  async function call(path: string, payload: unknown): Promise<any> {
    const attempt = async (force: boolean) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `JWT ${await getToken(force)}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000),
      })
      return { res, body: (await res.json().catch(() => ({}))) as any }
    }
    let { res, body } = await attempt(false)
    if (res.status === 401 || res.status === 403) ({ res, body } = await attempt(true))   // token expired
    const r = body?.results ?? body
    const ok = res.ok && (r?.status === 'Success' || r?.code === 200 || r?.message?.ewayBillNo || r?.message?.cancelDate || r?.message?.vehUpdDate || r?.message?.validUpto)
    if (!ok) {
      const msg = typeof r?.message === 'string' ? r.message : r?.message?.message ?? r?.errorMessage ?? `HTTP ${res.status}`
      throw new EwayError(`E-way provider rejected the request: ${msg}`, res.status >= 500 ? 502 : 422, body)
    }
    return body
  }

  return {
    name: 'mastersindia',
    live: true,
    async generate(input) {
      const request = mastersIndiaPayloads.generate(input)
      const raw = await call('/api/v1/ewayBillsGenerate/', request)
      const m = (raw?.results ?? raw)?.message ?? {}
      const validUpto = parseNicDate(m.validUpto)
      if (!m.ewayBillNo || isNaN(validUpto.getTime())) throw new EwayError('E-way provider returned an unexpected response', 502, raw)
      const generatedAt = parseNicDate(m.ewayBillDate)
      return { ewayBillNo: String(m.ewayBillNo), validUpto, generatedAt: isNaN(generatedAt.getTime()) ? new Date() : generatedAt, raw, request }
    },
    async cancel(args) {
      const request = mastersIndiaPayloads.cancel(args)
      return { raw: await call('/api/v1/ewayBillCancel/', request), request }
    },
    async updateVehicle(args) {
      const request = mastersIndiaPayloads.vehicle(args)
      return { raw: await call('/api/v1/updateVehicleNumber/', request), request }
    },
    async extend(args) {
      const request = mastersIndiaPayloads.extend(args)
      const raw = await call('/api/v1/ewayBillValidityExtend/', request)
      const m = (raw?.results ?? raw)?.message ?? {}
      const validUpto = parseNicDate(m.validUpto ?? m.updatedValidUpto)
      if (isNaN(validUpto.getTime())) throw new EwayError('E-way provider returned an unexpected response', 502, raw)
      return { ewayBillNo: args.ewayBillNo, validUpto, generatedAt: new Date(), raw, request }
    },
  }
}

export function getEwayProvider(): EwayProvider {
  const wanted = (process.env['EWAY_PROVIDER'] ?? '').toLowerCase()
  if (wanted === 'mastersindia') return mastersIndiaProvider()
  if (wanted === 'mock' || wanted === '') return mockProvider
  throw new EwayError(`Unknown EWAY_PROVIDER "${wanted}" (use "mock" or "mastersindia")`, 500)
}

/** Cheap check for the UI: is a live provider configured, or are we in mock mode? */
export function ewayProviderStatus(): { provider: string; live: boolean; configured: boolean; sandbox: boolean } {
  const wanted = (process.env['EWAY_PROVIDER'] ?? '').toLowerCase()
  if (wanted === 'mastersindia') {
    return {
      provider: 'mastersindia', live: true, sandbox: process.env['EWAY_SANDBOX'] === 'true',
      configured: !!(process.env['MASTERS_INDIA_USERNAME'] && process.env['MASTERS_INDIA_PASSWORD']),
    }
  }
  return { provider: 'mock', live: false, configured: true, sandbox: false }
}
