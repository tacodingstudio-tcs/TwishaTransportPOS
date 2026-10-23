// Transport reports — profit per trip, per vehicle, and business by customer. Exports to Excel.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Download } from 'lucide-react'
import { transportApi } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { PeriodBar, usePeriod } from '@/components/transport/PeriodBar'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, num, fmtDate, todayIst, VEHICLE_TYPE_LABEL } from '@/components/transport/format'

type Tab = 'trips' | 'vehicles' | 'parties'
const TABS: Array<[Tab, string]> = [['trips', 'Profit per trip'], ['vehicles', 'Profit per truck'], ['parties', 'Business per party']]

export function TransportReportsPage() {
  const [tab, setTab] = useState<Tab>('trips')
  const period = usePeriod('month')
  const { from, to } = period

  const params = { from, to }
  const { data, isLoading } = useQuery({
    queryKey: ['transport-report', tab, from, to],
    queryFn: () => tab === 'trips' ? transportApi.tripPnl(params) : tab === 'vehicles' ? transportApi.vehiclePnl(params) : transportApi.partyBusiness(params),
  })
  const all: any[] = data?.data ?? []
  const rows = all.slice(0, 300)                      // a long period can be thousands of trips: draw the first 300, Excel has them all
  const t = data?.totals

  async function exportXlsx() {
    const XLSX = await import('xlsx')                 // loaded when needed, not with the page
    const sheet = all.map((r) => tab === 'trips' ? {
      Trip: r.tripNo, Start: String(r.startDate).slice(0, 10), Route: `${r.fromCity} → ${r.toCity}`, Vehicle: r.vehicleNo, Driver: r.driverName ?? '',
      Status: r.status, 'Km': r.km ?? '', 'Freight': r.freight, 'Expenses': r.expenses, 'Hire': r.hire, 'Net': r.net, 'Margin %': r.marginPct,
    } : tab === 'vehicles' ? {
      Vehicle: r.regNo, Type: r.vehicleType, Ownership: r.ownership, Trips: r.trips, Km: r.km, Freight: r.freight, Expenses: r.expenses, Hire: r.hire, Net: r.net, 'Net per km': r.perKm ?? '',
    } : {
      Customer: r.name, LRs: r.lrCount, 'Weight (kg)': r.weightKg, Freight: r.freight, Billed: r.billed, Unbilled: r.unbilled,
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), TABS.find(([k]) => k === tab)![1])
    XLSX.writeFile(wb, `transport-${tab}-${from}-to-${to}.xlsx`)
  }

  const netCls = (n: number) => (n >= 0 ? 'text-green-700' : 'text-red-600')

  return (
    <div>
      <PageHeader title="Profit report" subtitle="Where you earn — and where you lose"
        action={<button type="button" className="btn-ghost" onClick={exportXlsx} disabled={all.length === 0}><Download className="w-4 h-4" /> Excel</button>} />
      <div className="p-6 space-y-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="flex gap-1">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${tab === k ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{l}</button>
            ))}
          </div>
          <div className="ml-auto"><PeriodBar period={period} /></div>
        </div>

        {t && tab !== 'parties' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border bg-gray-50 border-gray-200 p-4"><div className="text-xs uppercase text-gray-500">Freight</div><div className="text-xl font-bold text-gray-900">{inr(t.freight)}</div></div>
            <div className="rounded-xl border bg-gray-50 border-gray-200 p-4"><div className="text-xs uppercase text-gray-500">Spent</div><div className="text-xl font-bold text-gray-900">{inr(t.totalCost)}</div></div>
            <div className="rounded-xl border bg-gray-50 border-gray-200 p-4"><div className="text-xs uppercase text-gray-500">Profit</div><div className={`text-xl font-bold ${netCls(t.net)}`}>{inr(t.net)}</div></div>
            <div className="rounded-xl border bg-gray-50 border-gray-200 p-4"><div className="text-xs uppercase text-gray-500">Profit %</div><div className={`text-xl font-bold ${netCls(t.net)}`}>{t.freight > 0 ? `${Math.round((t.net / t.freight) * 1000) / 10}%` : '—'}</div></div>
          </div>
        )}

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No data for this period</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              {tab === 'trips' && (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100"><tr>
                    <th className="px-4 py-2.5 text-left">Trip</th><th className="px-4 py-2.5 text-left">Route</th><th className="px-4 py-2.5 text-left">Vehicle</th>
                    <th className="px-4 py-2.5 text-right">Km</th><th className="px-4 py-2.5 text-right">Freight</th><th className="px-4 py-2.5 text-right">Costs</th>
                    <th className="px-4 py-2.5 text-right">Net</th><th className="px-4 py-2.5 text-right">Margin</th><th className="px-4 py-2.5 text-left">Status</th></tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3"><Link to={`/transport/trips/${r.id}`} className="font-mono text-xs text-primary-600 hover:underline">{r.tripNo}</Link><div className="text-xs text-gray-400">{fmtDate(r.startDate)}</div></td>
                        <td className="px-4 py-3 whitespace-nowrap">{r.fromCity} → {r.toCity}</td>
                        <td className="px-4 py-3 text-gray-600">{r.vehicleNo}<div className="text-xs text-gray-400">{r.driverName}</div></td>
                        <td className="px-4 py-3 text-right text-gray-600">{r.km != null ? num(r.km) : '—'}</td>
                        <td className="px-4 py-3 text-right">{inr(r.freight)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{inr(r.totalCost)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${netCls(r.net)}`}>{inr(r.net)}</td>
                        <td className={`px-4 py-3 text-right ${netCls(r.net)}`}>{r.marginPct}%</td>
                        <td className="px-4 py-3"><StatusPill kind="trip" status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'vehicles' && (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100"><tr>
                    <th className="px-4 py-2.5 text-left">Vehicle</th><th className="px-4 py-2.5 text-right">Trips</th><th className="px-4 py-2.5 text-right">Km</th>
                    <th className="px-4 py-2.5 text-right">Freight</th><th className="px-4 py-2.5 text-right">Costs</th><th className="px-4 py-2.5 text-right">Net</th>
                    <th className="px-4 py-2.5 text-right">Net / km</th></tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map((r) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3"><Link to={`/transport/vehicles/${r.id}`} className="font-semibold text-gray-900 hover:text-primary-600">{r.regNo}</Link>
                          <div className="text-xs text-gray-400">{VEHICLE_TYPE_LABEL[r.vehicleType]} · {r.ownership}</div></td>
                        <td className="px-4 py-3 text-right">{r.trips}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{num(r.km)}</td>
                        <td className="px-4 py-3 text-right">{inr(r.freight)}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{inr(r.totalCost)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${netCls(r.net)}`}>{inr(r.net)}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{r.perKm != null ? inr(r.perKm, 2) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === 'parties' && (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100"><tr>
                    <th className="px-4 py-2.5 text-left">Party (sender)</th><th className="px-4 py-2.5 text-right">LRs</th><th className="px-4 py-2.5 text-right">Weight</th>
                    <th className="px-4 py-2.5 text-right">Freight</th><th className="px-4 py-2.5 text-right">Bill made</th><th className="px-4 py-2.5 text-right">Bill not made</th></tr></thead>
                  <tbody className="divide-y divide-gray-50">
                    {rows.map((r) => (
                      <tr key={r.key} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{r.name}</td>
                        <td className="px-4 py-3 text-right">{r.lrCount}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{num(r.weightKg / 1000, 1)} T</td>
                        <td className="px-4 py-3 text-right font-semibold">{inr(r.freight)}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{inr(r.billed)}</td>
                        <td className={`px-4 py-3 text-right ${r.unbilled > 0 ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>{inr(r.unbilled)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        {all.length > rows.length && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            Showing the first {rows.length} of {all.length.toLocaleString('en-IN')} rows — the totals above cover all of them, and the Excel file has every row.
          </p>
        )}
        <p className="text-xs text-gray-400">Amounts are before GST. Driver salary and office costs are not counted here.</p>
      </div>
    </div>
  )
}
