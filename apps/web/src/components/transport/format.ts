// Shared formatting + status vocabulary for the transport screens.

export const inr = (n: number | string | null | undefined, decimals = 0): string => {
  const v = Number(n ?? 0)
  const body = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return `${v < 0 ? '-' : ''}₹${body}`
}

export const num = (n: number | string | null | undefined, decimals = 0): string =>
  Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

/** API date (UTC-midnight for DATE columns) → "09 Oct 2026". Formatted in UTC so the day never shifts. */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Today as YYYY-MM-DD in IST regardless of the browser's timezone. */
export function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

/** Value for <input type="date"> from an API date. */
export const toInputDate = (v: string | Date | null | undefined): string =>
  v ? new Date(v).toISOString().slice(0, 10) : ''

/** Whole days from today (IST) until an API date; negative = already past. */
export function daysUntil(v: string | Date | null | undefined): number | null {
  if (!v) return null
  const a = new Date(`${todayIst()}T00:00:00Z`).getTime()
  const b = new Date(`${new Date(v).toISOString().slice(0, 10)}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000)
}

export const FREIGHT_TYPE_LABEL: Record<string, string> = { paid: 'Sender paid', to_pay: 'Receiver pays', tbb: 'Bill later' }

export const RATE_BASIS_LABEL: Record<string, string> = {
  fixed: 'Fixed amount', per_ton: 'Per ton (MT)', per_kg: 'Per kg', per_pkg: 'Per bag / box', per_km: 'Per km',
}

export const VEHICLE_TYPE_LABEL: Record<string, string> = {
  mini_truck: 'Mini truck (Chhota Hathi)', pickup: 'Pickup', lcv: 'Small truck (LCV)', icv: 'Medium truck (ICV)', hcv: 'Big truck (6–12 wheeler)',
  trailer: 'Trailer', container: 'Container', tanker: 'Tanker', tipper: 'Tipper', reefer: 'Reefer', other: 'Other',
}

export const GST_MODE_LABEL: Record<string, string> = {
  rcm:        'Customer pays the 5% GST himself (RCM)',
  forward_5:  'I charge 5% GST on the bill',
  forward_12: 'I charge 12% GST on the bill',
  forward_18: 'I charge 18% GST on the bill',
  exempt:     'No GST',
}

export const EXPENSE_LABEL: Record<string, string> = {
  diesel: 'Diesel', toll: 'Toll / FASTag', driver_salary: 'Driver salary', driver_bhatta: 'Driver bhatta',
  tyres: 'Tyres', spares: 'Spares', repair: 'Repair / service', insurance: 'Insurance', permit_tax: 'Permit / tax',
  challan: 'Challan / fine', loading_unloading: 'Loading / unloading', vehicle_hire: 'Vehicle hire',
  broker_commission: 'Broker commission', parking: 'Parking', emi: 'EMI', rent: 'Rent', electricity: 'Electricity',
  internet: 'Phone / internet', staff: 'Staff salary', maintenance: 'Maintenance', misc: 'Misc',
}

type Tone = { label: string; cls: string }

export const LR_STATUS: Record<string, Tone> = {
  booked:       { label: 'Booked',            cls: 'bg-blue-100 text-blue-700' },
  in_transit:   { label: 'On the way',        cls: 'bg-amber-100 text-amber-700' },
  delivered:    { label: 'Delivered',         cls: 'bg-green-100 text-green-700' },
  pod_received: { label: 'Signed copy back',  cls: 'bg-emerald-100 text-emerald-700' },
  billed:       { label: 'Bill made',         cls: 'bg-purple-100 text-purple-700' },
  cancelled:    { label: 'Cancelled',    cls: 'bg-red-100 text-red-600' },
}
export const TRIP_STATUS: Record<string, Tone> = {
  planned:   { label: 'Not started', cls: 'bg-gray-100 text-gray-700' },
  running:   { label: 'On the way',  cls: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Finished',    cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-100 text-red-600' },
}
export const VEHICLE_STATUS: Record<string, Tone> = {
  available:   { label: 'Free',        cls: 'bg-green-100 text-green-700' },
  on_trip:     { label: 'On the way',  cls: 'bg-amber-100 text-amber-700' },
  maintenance: { label: 'In garage',   cls: 'bg-red-100 text-red-600' },
  inactive:    { label: 'Inactive',    cls: 'bg-gray-100 text-gray-500' },
}
export const DRIVER_STATUS: Record<string, Tone> = {
  available: { label: 'Free',       cls: 'bg-green-100 text-green-700' },
  on_trip:   { label: 'On the way', cls: 'bg-amber-100 text-amber-700' },
  off_duty:  { label: 'On leave',   cls: 'bg-gray-100 text-gray-600' },
  inactive:  { label: 'Inactive',  cls: 'bg-gray-100 text-gray-500' },
}

// ── Quantity: stored in kg, entered/printed in whatever the operator thinks in (usually MT) ──
export type QtyUnit = 'MT' | 'kg'
export const toKg = (v: number, unit: QtyUnit): number => (unit === 'MT' ? Math.round(v * 1000 * 1000) / 1000 : v)
export const fromKg = (kg: number, unit: QtyUnit): number => (unit === 'MT' ? Math.round(kg) / 1000 : kg)
/** 29480 → "29.480" (MT, 3 dp) */
export const mt = (kg: number | string | null | undefined, dp = 3): string =>
  (Number(kg ?? 0) / 1000).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })

export const WEIGHT_BASIS_LABEL: Record<string, string> = {
  manual: 'Weight I type',
  load:   'Weight loaded',
  unload: 'Weight received',
  lower:  'Smaller of the two',
}

// ── Amount in words (Indian numbering): 104212 → "One Lakh Four Thousand Two Hundred Twelve Only" ──
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function below1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100 }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10 }
  if (n > 0) parts.push(ONES[n]!)
  return parts.join(' ')
}

export function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount))
  const paise = Math.round((Math.abs(amount) - rupees) * 100)
  if (rupees === 0 && paise === 0) return 'Zero Only'
  const units: Array<[number, string]> = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']]
  let n = rupees
  const words: string[] = []
  for (const [size, name] of units) {
    if (n >= size) { words.push(`${below1000(Math.floor(n / size))} ${name}`); n %= size }
  }
  if (n > 0) words.push(below1000(n))
  const rupeeText = words.join(' ')
  const paiseText = paise > 0 ? `${below1000(paise)} Paise` : ''
  return [rupeeText, rupeeText && paiseText ? 'and' : '', paiseText].filter(Boolean).join(' ') + ' Only'
}
