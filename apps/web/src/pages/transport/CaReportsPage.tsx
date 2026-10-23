// CA reports — everything a chartered accountant asks a transport business for, per firm, as screens and Excel.
// Pick a period, look at a report, download it, or download the whole pack in one workbook.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Download, Eye, X, Loader2, Package, Layers, UserCheck } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { ReportTable, reportSheets, type CaReport } from '@/components/transport/ReportTable'
import { downloadWorkbook, fileSafe, type SheetSpec } from '@/lib/excel'
import { useCurrentFirm, useFirms } from '@/hooks/useFirms'
import { todayIst } from '@/components/transport/format'

interface Def { key: string; title: string; desc: string; sheet: string; asOn?: boolean }
const REPORTS: Def[] = [
  { key: 'sales-register',   title: 'Sales register',       sheet: 'Sales register', desc: 'Every freight and goods bill: GST split, TDS deducted and recorded, received, outstanding.' },
  { key: 'receipts-register', title: 'Receipts register',   sheet: 'Receipts',       desc: 'Money received, the TDS customers cut, and whether your bank statement shows each receipt.' },
  { key: 'expense-register', title: 'Expense register',     sheet: 'Expenses',       desc: 'Trip costs and office costs together: who paid, GST inside, what is still owed to pumps.' },
  { key: 'truck-monthly',    title: 'Truck-wise monthly report', sheet: 'Truck monthly', desc: 'Each truck, month by month: trips, km, freight, diesel, toll, other costs, hire and net profit — with the whole-period total per truck.' },
  { key: 'truck-weekly',     title: 'Truck-wise weekly report', sheet: 'Truck weekly', desc: 'The same, week by week (Monday to Sunday) — to see how each truck did this week or last.' },
  { key: 'fuel-register',    title: 'Fuel register',        sheet: 'Fuel',           desc: 'Every diesel fill, plus km per litre by trip and by truck.' },
  { key: 'tds-register',     title: 'TDS register (194C)',  sheet: 'TDS',            desc: 'TDS by customer and quarter, with PAN — to match against Form 26AS.' },
  { key: 'gstr3b',           title: 'GSTR-3B summary',      sheet: 'GSTR-3B',        desc: 'Outward tax, supplies where the customer pays the GST, input credit. Indicative — your CA files it.' },
  { key: 'pump-ledger',      title: 'Pump ledger',          sheet: 'Pump ledger',    desc: 'Diesel taken on account: billed, paid and still owed, pump by pump.' },
  { key: 'outstanding',      title: 'Who owes you',         sheet: 'Outstanding',    desc: 'Receivables aged by due date, as on the end date.', asOn: true },
  { key: 'bank-book',        title: 'Bank book',            sheet: 'Bank book',      desc: 'Every statement line and what it was matched to; lines still to classify are marked.' },
]
const COMBINED: Def = { key: 'combined', title: 'All firms together', sheet: 'All firms', desc: 'Every firm side by side — sales, costs, profit, what customers owe — with a total. Owner only.' }

// ── periods (Indian financial year: April to March) ─────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

function presets(today: string): Array<[string, string, string]> {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  const fy = m >= 4 ? y : y - 1
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y
  const qStartMonth = m >= 10 ? 10 : m >= 7 ? 7 : m >= 4 ? 4 : 1
  return [
    ['This month', ymd(y, m, 1), today],
    ['Last month', ymd(py, pm, 1), ymd(py, pm, lastDay(py, pm))],
    ['This quarter', ymd(y, qStartMonth, 1), today],
    [`FY ${fy}-${String(fy + 1).slice(2)} so far`, ymd(fy, 4, 1), today],
    [`FY ${fy - 1}-${String(fy).slice(2)}`, ymd(fy - 1, 4, 1), ymd(fy, 3, 31)],
  ]
}

export function CaReportsPage() {
  const qc = useQueryClient()
  const today = todayIst()
  const { firm } = useCurrentFirm()
  const { data: firmData } = useFirms()
  const isOwner = useAuthStore((s) => s.user?.role === 'owner')
  const list = presets(today)
  const [preset, setPreset] = useState(3)
  const [from, setFrom] = useState(list[3]![1])
  const [to, setTo] = useState(list[3]![2])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const showCombined = isOwner && (firmData?.firms.length ?? 0) > 1
  // two trade names under one GSTIN are one taxpayer: the owner can read the GST and TDS reports for both names together
  const sameGstin = isOwner && !!firm?.gstin && (firmData?.firms.filter((f) => f.gstin === firm.gstin).length ?? 0) > 1
  const [together, setTogether] = useState(false)
  const TAX_REPORTS = ['gstr3b', 'tds-register']
  const all = showCombined ? [COMBINED, ...REPORTS] : REPORTS
  const active = all.find((r) => r.key === open) ?? null
  const [truckId, setTruckId] = useState('')
  const { data: trucks = [] } = useQuery<any[]>({ queryKey: ['transport-vehicles', 'pick'], queryFn: () => transportApi.listVehicles() })
  // the truck picker narrows only the truck-wise report; the pack always carries every truck
  const paramsFor = (d: Def, pack = false) => (d.asOn ? { asOn: to }
    : d.key.startsWith('truck-') && truckId && !pack ? { from, to, vehicleId: truckId }
    : together && sameGstin && !pack && TAX_REPORTS.includes(d.key) ? { from, to, scope: 'gstin' } : { from, to })
  const keyFor = (d: Def | string, pack = false) => {
    const k = typeof d === 'string' ? d : d.key
    return ['ca', k, from, to, k.startsWith('truck-') && !pack ? truckId : '', together && sameGstin && !pack && TAX_REPORTS.includes(k) ? 'gstin' : '']
  }
  const firmName = firm?.name ?? 'firm'

  const { data: report, isFetching, error } = useQuery<CaReport>({
    queryKey: [...keyFor(open ?? ''), 'preview'],                       // not the Excel's key: that one holds every row
    queryFn: () => transportApi.caReport(open!, { ...paramsFor(active!), preview: 300 }),
    enabled: !!active,
  })

  function pick(i: number) {
    setPreset(i)
    if (i < list.length) { setFrom(list[i]![1]); setTo(list[i]![2]) }
  }

  async function download(d: Def) {
    setBusy(d.key)
    try {
      const r: CaReport = await qc.fetchQuery({ queryKey: keyFor(d), queryFn: () => transportApi.caReport(d.key, paramsFor(d)), staleTime: 30_000 })
      await downloadWorkbook(`${fileSafe(firmName)}_${d.key}_${from}_to_${to}`, reportSheets(r, d.sheet))
    } catch (e) { toast.error(apiError(e)) } finally { setBusy(null) }
  }

  async function downloadPack() {
    setBusy('pack')
    try {
      const get = (d: Def) => qc.fetchQuery<CaReport>({ queryKey: keyFor(d, true), queryFn: () => transportApi.caReport(d.key, paramsFor(d, true)), staleTime: 30_000 })
      const [reports, trips, trucks, combined, both] = await Promise.all([
        Promise.all(REPORTS.map(get)),
        transportApi.tripPnl({ from, to }), transportApi.vehiclePnl({ from, to }),
        showCombined ? get(COMBINED) : Promise.resolve(null),
        // both names under one GSTIN: the GST and TDS reports as one, for the CA who files a single return
        sameGstin ? Promise.all(TAX_REPORTS.map((key) => qc.fetchQuery<CaReport>({
          queryKey: ['ca', key, from, to, '', 'gstin'], queryFn: () => transportApi.caReport(key, { from, to, scope: 'gstin' }), staleTime: 30_000,
        }))) : Promise.resolve(null),
      ])
      const by = Object.fromEntries(REPORTS.map((d, i) => [d.key, reports[i]!])) as Record<string, CaReport>
      const sales = by['sales-register']!.totals, exp = by['expense-register']!.totals, rec = by['receipts-register']!.totals
      const owed = by['outstanding']!.totals, pumps = by['pump-ledger']!.totals, tds = by['tds-register']!.totals, bank = by['bank-book']!.totals

      const summary: SheetSpec = {
        name: 'Summary', columns: ['Item', 'Value'],
        heading: [`${firmName}${firm?.gstin ? ` — GSTIN ${firm.gstin}` : ''}`, `CA pack for ${from} to ${to}`, `Prepared on ${today}`],
        rows: [
          { Item: 'Bills raised (taxable value)', Value: sales['Taxable value'] ?? 0 }, { Item: 'GST on those bills', Value: (sales['CGST'] ?? 0) + (sales['SGST'] ?? 0) + (sales['IGST'] ?? 0) },
          { Item: 'Invoice total', Value: sales['Invoice total'] ?? 0 }, { Item: 'TDS deducted by customers', Value: tds['TDS deducted by customer'] ?? 0 },
          { Item: 'TDS still to record', Value: tds['Pending to record'] ?? 0 }, { Item: 'Received (bank / UPI / cheque)', Value: rec['Received in bank / UPI / cheque'] ?? 0 },
          { Item: 'Received in cash', Value: rec['Received in cash'] ?? 0 }, { Item: 'Trip costs', Value: exp['Trip costs'] ?? 0 }, { Item: 'Office costs', Value: exp['Office costs'] ?? 0 },
          { Item: 'GST paid on office costs', Value: exp['GST paid on office costs'] ?? 0 }, { Item: 'Customers owe (as on end date)', Value: owed['Total outstanding'] ?? 0 },
          { Item: 'Owed to pumps (end of period)', Value: pumps['Owed at end'] ?? 0 }, { Item: 'Bank lines not yet matched', Value: bank['Lines not matched'] ?? 0 },
        ],
        notes: [
          'Sheets: Sales register, Receipts, Expenses, Fuel (+ mileage), TDS (+ summary), GSTR-3B, Pump ledger, Outstanding, Bank book, Trip and Truck profit' + (combined ? ', All firms.' : '.'),
          'GST and TDS figures are for your CA to review; this is not a filed return.',
        ],
      }
      const pnl: SheetSpec[] = [
        { name: 'Trip profit', heading: [`Profit per trip — ${firmName}`, `Period: ${from} to ${to}`], rows: (trips.data ?? []).map((r: any) => ({
          Trip: r.tripNo, Start: String(r.startDate).slice(0, 10), Route: `${r.fromCity} → ${r.toCity}`, Truck: r.vehicleNo, Driver: r.driverName ?? '', Status: r.status,
          Km: r.km ?? '', Freight: r.freight, Expenses: r.expenses, Hire: r.hire, Net: r.net, 'Margin %': r.marginPct })) },
        { name: 'Truck profit', heading: [`Profit per truck — ${firmName}`, `Period: ${from} to ${to}`], rows: (trucks.data ?? []).map((r: any) => ({
          Truck: r.regNo, Type: r.vehicleType, Ownership: r.ownership, Trips: r.trips, Km: r.km, Freight: r.freight, Expenses: r.expenses, Hire: r.hire, Net: r.net, 'Net per km': r.perKm ?? '' })) },
      ]
      const sheets: SheetSpec[] = [summary]
      for (const d of REPORTS) sheets.push(...reportSheets(by[d.key]!, d.sheet))
      sheets.push(...pnl)
      if (combined) sheets.push(...reportSheets(combined, COMBINED.sheet))
      if (both) { sheets.push(...reportSheets(both[0]!, 'GSTR-3B both names')); sheets.push(...reportSheets(both[1]!, 'TDS both names')) }
      await downloadWorkbook(`${fileSafe(firmName)}_CA_pack_${from}_to_${to}`, sheets)
      toast.success('CA pack downloaded')
    } catch (e) { toast.error(apiError(e)) } finally { setBusy(null) }
  }

  return (
    <div>
      <PageHeader title="CA reports" subtitle={`${firmName} — everything your accountant asks for`} />
      <div className="p-6 space-y-6 max-w-6xl">

        {/* period */}
        <section className="card p-4 flex flex-wrap items-center gap-2">
          {list.map(([label], i) => (
            <button key={label} type="button" onClick={() => pick(i)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${preset === i ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{label}</button>
          ))}
          <button type="button" onClick={() => setPreset(list.length)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${preset === list.length ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Pick dates</button>
          <div className="ml-auto flex items-center gap-2 flex-nowrap">
          <select className="input w-32" value={truckId} onChange={(e) => setTruckId(e.target.value)} title="Used by the truck-wise reports">
            <option value="">All trucks</option>
            {trucks.map((t: any) => <option key={t.id} value={t.id}>{t.regNo}</option>)}
          </select>
          <input type="date" className="input w-36" value={from} onChange={(e) => { setFrom(e.target.value); setPreset(list.length) }} />
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input w-36" value={to} max={today} onChange={(e) => { setTo(e.target.value); setPreset(list.length) }} />
          </div>
        </section>

        {sameGstin && (
          <label className="card p-4 flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-1" checked={together} onChange={(e) => setTogether(e.target.checked)} />
            <span>
              <span className="block text-sm font-semibold text-gray-900">Read both names together</span>
              <span className="block text-xs text-gray-500">Both names share one GSTIN, so the GSTR-3B summary and the TDS register can be shown as one — with a line for each name. The CA pack always includes both views.</span>
            </span>
          </label>
        )}

        {/* the pack */}
        <section className="card p-5 flex flex-wrap items-center gap-4 border-primary-200 bg-primary-50/40">
          <span className="w-11 h-11 rounded-xl bg-primary-600 text-white flex items-center justify-center shrink-0"><Package className="w-5 h-5" /></span>
          <div className="flex-1 min-w-[16rem]">
            <h2 className="text-sm font-semibold text-gray-900">CA pack — one Excel file with all of it</h2>
            <p className="text-xs text-gray-500 mt-0.5">Summary, sales, receipts, expenses, fuel, TDS, GSTR-3B, pump ledger, receivables, bank book and profit per trip and truck, and each truck month by month and week by week{showCombined ? ', plus both firms side by side' : ''}.</p>
          </div>
          <button type="button" className="btn-primary" disabled={busy !== null || !from || !to} onClick={downloadPack}>
            {busy === 'pack' ? <><Loader2 className="w-4 h-4 animate-spin" /> Collecting…</> : <><Download className="w-4 h-4" /> Download CA pack</>}
          </button>
        </section>

        {/* report cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {all.map((d) => (
            <section key={d.key} className={`card p-4 flex flex-col ${open === d.key ? 'ring-2 ring-primary-300' : ''}`}>
              <div className="flex items-start gap-2">
                {d.key === 'combined' && <Layers className="w-4 h-4 text-primary-600 mt-0.5 shrink-0" />}
                <h3 className="text-sm font-semibold text-gray-900">{d.title}</h3>
              </div>
              <p className="text-xs text-gray-500 mt-1 flex-1">{d.desc}</p>
              <div className="flex gap-2 mt-3">
                <button type="button" className="btn-ghost text-sm" onClick={() => setOpen(open === d.key ? null : d.key)}>
                  {open === d.key ? <><X className="w-4 h-4" /> Close</> : <><Eye className="w-4 h-4" /> View</>}
                </button>
                <button type="button" className="btn-ghost text-sm" disabled={busy !== null} onClick={() => download(d)}>
                  {busy === d.key ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Excel
                </button>
              </div>
            </section>
          ))}
        </div>

        {/* the open report */}
        {active && (
          <section className="space-y-3">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-gray-900">{active.title}</h2>
              <span className="text-xs text-gray-500">{active.asOn ? `as on ${to}` : `${from} to ${to}`}</span>
              <span className="flex-1" />
              {isFetching && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
            </div>
            {error ? <div className="card p-6 text-sm text-red-600">{apiError(error)}</div>
              : report ? <ReportTable report={report} />
              : <div className="card p-8 text-center text-gray-400">Loading…</div>}
          </section>
        )}

        <p className="text-xs text-gray-500 flex items-start gap-2 max-w-3xl">
          <UserCheck className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />
          Want your CA to look at these directly? Add them as a <strong>Viewer</strong> in <em>Firms &amp; Staff → Manage Users</em> — they can open every report here but cannot change anything.
        </p>
      </div>
    </div>
  )
}
