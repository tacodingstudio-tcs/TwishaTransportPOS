// Transport dashboard — fleet status, running trips, what needs attention today, month P&L.
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Truck, Users, FileText, Route, ShieldAlert, ReceiptText, Wallet, PackageCheck,
  FilePlus2, RefreshCw, AlertTriangle, CalendarClock, ClipboardCheck, ChevronRight,
} from 'lucide-react'
import { transportApi } from '@/lib/api'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, fmtDate } from '@/components/transport/format'

function StatCard({ label, value, sub, color, icon: Icon, onClick }: {
  label: string; value: string | number; sub?: string; color: string; icon: React.ElementType; onClick?: () => void
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${color} ${onClick ? 'cursor-pointer hover:shadow-sm transition-shadow' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</span>
        <Icon className="w-4 h-4 opacity-60" />
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5">{sub}</div>}
    </div>
  )
}

function AttentionRow({ icon: Icon, tone, label, hint, count, onClick }: {
  icon: React.ElementType; tone: string; label: string; hint?: string; count: string | number; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left transition-colors">
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        {hint && <span className="block text-xs text-gray-500 truncate">{hint}</span>}
      </span>
      <span className="text-sm font-semibold text-gray-900">{count}</span>
      <ChevronRight className="w-4 h-4 text-gray-300" />
    </button>
  )
}

export function TransportDashboardPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['transport-dashboard'],
    queryFn:  transportApi.dashboard,
    refetchInterval: 60_000,
  })

  if (isLoading) return <div className="p-8 text-center text-gray-400">Loading dashboard…</div>
  if (isError || !data) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500 mb-3">Could not load the dashboard.</p>
        <button type="button" className="btn-primary" onClick={() => refetch()}>Retry</button>
      </div>
    )
  }

  const { fleet, drivers, runningTrips, today, attention: a, month, recentLrs } = data

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Home</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost text-sm" title="Refresh" onClick={() => refetch()}>
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" className="btn-ghost text-sm" onClick={() => navigate('/transport/trips')}>
            <Route className="w-4 h-4" /> New Trip
          </button>
          <button type="button" className="btn-primary text-sm" onClick={() => navigate('/transport/lrs/new')}>
            <FilePlus2 className="w-4 h-4" /> New Load (LR)
          </button>
        </div>
      </div>

      {/* New business: three plain steps */}
      {(fleet.total === 0 || recentLrs.length === 0) && (
        <div className="rounded-xl border border-primary-200 bg-primary-50/50 p-5">
          <div className="text-base font-semibold text-gray-900">Welcome! Start with these 3 steps</div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            {[
              { n: 1, done: fleet.total > 0, title: 'Add your truck', hint: 'Truck number and papers', to: '/transport/vehicles' },
              { n: 2, done: false, title: 'Add a party', hint: 'The person whose goods you carry', to: '/parties' },
              { n: 3, done: recentLrs.length > 0, title: 'Book your first load', hint: 'From where, to where, how much', to: '/transport/lrs/new' },
            ].map((s) => (
              <button key={s.n} type="button" onClick={() => navigate(s.to)}
                className="flex items-center gap-3 text-left bg-white rounded-xl border border-gray-200 p-4 hover:shadow-sm">
                <span className={`w-9 h-9 rounded-full flex items-center justify-center font-bold shrink-0 ${s.done ? 'bg-green-500 text-white' : 'bg-primary-600 text-white'}`}>
                  {s.done ? '✓' : s.n}
                </span>
                <span><span className="block text-sm font-semibold text-gray-900">{s.title}</span><span className="block text-xs text-gray-500">{s.hint}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Fleet + today */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <StatCard label="Trucks" value={fleet.total} sub={`${fleet.utilisationPct}% on the road`}
          color="bg-gray-50 border-gray-200 text-gray-900" icon={Truck} onClick={() => navigate('/transport/vehicles')} />
        <StatCard label="Free trucks" value={fleet.available} sub={fleet.maintenance ? `${fleet.maintenance} in workshop` : undefined}
          color="bg-green-50 border-green-200 text-green-900" icon={PackageCheck} />
        <StatCard label="On the way" value={fleet.onTrip}
          color="bg-amber-50 border-amber-200 text-amber-900" icon={Route} onClick={() => navigate('/transport/trips?status=running')} />
        <StatCard label="Free drivers" value={`${drivers.available}/${drivers.total}`}
          color="bg-blue-50 border-blue-200 text-blue-900" icon={Users} onClick={() => navigate('/transport/drivers')} />
        <StatCard label="Loads today" value={today.lrCount} sub={inr(today.freight)}
          color="bg-primary-50 border-primary-200 text-primary-900" icon={FileText} />
        <StatCard label="This month" value={inr(month.freight)} sub={`${month.lrCount} loads · ${month.marginPct}% profit`}
          color="bg-purple-50 border-purple-200 text-purple-900" icon={Wallet} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Needs attention */}
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden lg:col-span-1">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-semibold text-gray-900">Needs your attention</span>
          </div>
          <div className="divide-y divide-gray-50">
            <AttentionRow icon={ShieldAlert}
              tone={a.complianceExpired ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}
              label="Papers expiring" hint={a.complianceExpired ? `${a.complianceExpired} already expired` : 'Fitness, permit, insurance, PUC'}
              count={a.complianceDue} onClick={() => navigate('/transport/compliance')} />
            <AttentionRow icon={CalendarClock} tone="bg-red-100 text-red-600"
              label="E-way bills ending soon" hint="Within 24 hours, truck still on the road"
              count={a.ewayExpiring} onClick={() => navigate('/transport/lrs?status=booked,in_transit')} />
            <AttentionRow icon={FileText} tone="bg-blue-100 text-blue-600"
              label="Loads waiting for a truck" hint="Booked, no truck given yet"
              count={a.unassignedLrs} onClick={() => navigate('/transport/lrs?unassigned=true')} />
            <AttentionRow icon={ClipboardCheck} tone="bg-amber-100 text-amber-600"
              label="Signed copy pending" hint="Delivered, signed LR copy not back yet"
              count={a.pendingPod} onClick={() => navigate('/transport/lrs?status=delivered')} />
            <AttentionRow icon={ReceiptText} tone="bg-purple-100 text-purple-600"
              label="Delivered, bill not made" hint={inr(a.unbilledAmount) + ' to bill'}
              count={a.unbilledCount} onClick={() => navigate('/transport/billing')} />
            <AttentionRow icon={Wallet} tone="bg-green-100 text-green-700"
              label="Money to collect from receiver" hint={inr(a.toPayAmount) + ' pending'}
              count={a.toPayCount} onClick={() => navigate('/transport/lrs?toPayPending=true')} />
          </div>
        </div>

        {/* Running trips */}
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden lg:col-span-2">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Route className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-semibold text-gray-900">Trucks on the road</span>
            <span className="ml-auto text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
              {runningTrips.length}
            </span>
          </div>
          {runningTrips.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">No trips running right now</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Trip</th>
                    <th className="px-4 py-2 text-left">Route</th>
                    <th className="px-4 py-2 text-left">Truck</th>
                    <th className="px-4 py-2 text-left">Driver</th>
                    <th className="px-4 py-2 text-left">Since</th>
                    <th className="px-4 py-2 text-right">Loads</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {runningTrips.map((t: any) => (
                    <tr key={t.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/transport/trips/${t.id}`)}>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.tripNo}</td>
                      <td className="px-4 py-3 text-gray-900">{t.fromCity} → {t.toCity}</td>
                      <td className="px-4 py-3 text-gray-700">{t.vehicleNo}</td>
                      <td className="px-4 py-3 text-gray-500">{t.driverName ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(t.startDate)}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{t.lrCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Month P&L strip + recent LRs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4 lg:col-span-1">
          <div className="text-sm font-semibold text-gray-900 mb-3">This month so far</div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-gray-500">Freight (bhada) booked</dt><dd className="font-medium">{inr(month.freight)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Diesel, toll & truck costs</dt><dd className="font-medium text-red-600">− {inr(month.expenses)}</dd></div>
            <div className="flex justify-between border-t border-gray-100 pt-2">
              <dt className="font-medium text-gray-900">Profit</dt>
              <dd className={`font-bold ${month.net >= 0 ? 'text-green-700' : 'text-red-600'}`}>{inr(month.net)}</dd>
            </div>
          </dl>
          <p className="text-xs text-gray-400 mt-3">
            Before driver salary, office costs and GST. Open Profit Report to see profit for each trip and truck.
          </p>
          <button type="button" className="btn-ghost text-sm mt-2 -ml-3" onClick={() => navigate('/transport/reports')}>
            See profit report <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden lg:col-span-2">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary-600" />
            <span className="text-sm font-semibold text-gray-900">Latest loads (LR)</span>
            <button type="button" className="ml-auto text-xs text-primary-600 hover:underline" onClick={() => navigate('/transport/lrs')}>
              View all
            </button>
          </div>
          {recentLrs.length === 0 ? (
            <p className="p-6 text-sm text-gray-400 text-center">No loads yet — tap “New Load (LR)” to book your first one.</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentLrs.map((l: any) => (
                <div key={l.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/transport/lrs/${l.id}`)}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      <span className="font-mono text-xs text-gray-500 mr-2">{l.lrNo}</span>
                      {l.fromCity} → {l.toCity}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{l.consignorName} → {l.consigneeName}</div>
                  </div>
                  <StatusPill kind="lr" status={l.status} />
                  <div className="text-sm font-medium text-gray-900 w-24 text-right">{inr(l.totalAmount)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
