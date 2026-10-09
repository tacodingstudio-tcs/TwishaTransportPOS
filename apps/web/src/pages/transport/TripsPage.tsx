// Trips — list, status filters and the "plan a trip" modal.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Search } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { StatusPill } from '@/components/transport/StatusPill'
import { CityInput } from '@/components/transport/CityInput'
import { inr, num, fmtDate, todayIst } from '@/components/transport/format'

const TABS = [
  { label: 'Running now', status: 'planned,running' },
  { label: 'On the way', status: 'running' },
  { label: 'Not started', status: 'planned' },
  { label: 'Finished', status: 'completed' },
  { label: 'All',       status: 'all' },
]

export function TripsPage() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const status = sp.get('status') ?? 'planned,running'
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [showNew, setShowNew] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['transport-trips', status, search, page],
    queryFn:  () => transportApi.listTrips({ status: status === 'all' ? undefined : status, search: search || undefined, page, limit: 20 }),
    placeholderData: (p) => p,
  })
  const rows: any[] = data?.data ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / 20))

  return (
    <div>
      <PageHeader
        title="Truck Trips"
        subtitle={`${num(total)} trips`}
        action={<button type="button" className="btn-primary" onClick={() => setShowNew(true)}><Plus className="w-4 h-4" /> New trip</button>}
      />
      <div className="p-6 space-y-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative max-w-sm flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Search trip no, truck, driver, city…" value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }} />
          </div>
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button key={t.label} type="button"
                onClick={() => { setSp({ status: t.status }, { replace: true }); setPage(1) }}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  status === t.status ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}>{t.label}</button>
            ))}
          </div>
        </div>

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No trips here yet</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Trip</th>
                    <th className="px-4 py-2.5 text-left">Route</th>
                    <th className="px-4 py-2.5 text-left">Truck / driver</th>
                    <th className="px-4 py-2.5 text-left">Start</th>
                    <th className="px-4 py-2.5 text-right">Loads</th>
                    <th className="px-4 py-2.5 text-right">Freight</th>
                    <th className="px-4 py-2.5 text-right">Spent</th>
                    <th className="px-4 py-2.5 text-right">Profit</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/transport/trips/${t.id}`)}>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.tripNo}</td>
                      <td className="px-4 py-3 text-gray-900 whitespace-nowrap">{t.fromCity} → {t.toCity}</td>
                      <td className="px-4 py-3">
                        <div className="text-gray-900">{t.vehicleNo}</div>
                        <div className="text-xs text-gray-500">{t.driverName ?? 'No driver'}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(t.startDate)}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{t.lrCount}</td>
                      <td className="px-4 py-3 text-right text-gray-900">{inr(t.freight)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">{inr(Number(t.expenses) + Number(t.hireCharges))}</td>
                      <td className={`px-4 py-3 text-right font-medium ${t.net >= 0 ? 'text-green-700' : 'text-red-600'}`}>{inr(t.net)}</td>
                      <td className="px-4 py-3"><StatusPill kind="trip" status={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {pages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button type="button" className="btn-ghost text-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>← Prev</button>
            <span className="text-sm text-gray-500">Page {page} of {pages}</span>
            <button type="button" className="btn-ghost text-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </div>

      {showNew && <NewTripModal onClose={() => setShowNew(false)} onCreated={(id) => navigate(`/transport/trips/${id}`)} />}
    </div>
  )
}

function NewTripModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    vehicleId: '', driverId: '', helperName: '', fromCity: '', toCity: '', startDate: todayIst(),
    driverAdvance: '', hireCharges: '', hireAdvancePaid: '', notes: '',
  })
  const [lrIds, setLrIds] = useState<string[]>([])
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const { data: vehicles = [] } = useQuery({ queryKey: ['transport-vehicles', 'trip'], queryFn: () => transportApi.listVehicles() })
  const { data: drivers = [] } = useQuery({ queryKey: ['transport-drivers', 'trip'], queryFn: () => transportApi.listDrivers() })
  const { data: waiting } = useQuery({ queryKey: ['transport-lrs', 'unassigned'], queryFn: () => transportApi.listLrs({ unassigned: 'true', limit: 100 }) })

  const vehicle = (vehicles as any[]).find((v) => v.id === f.vehicleId)
  const lrs: any[] = waiting?.data ?? []
  const picked = lrs.filter((l) => lrIds.includes(l.id))
  const weight = picked.reduce((s, l) => s + Number(l.chargedWeightKg), 0)
  const freight = picked.reduce((s, l) => s + Number(l.totalAmount), 0)
  const overload = vehicle?.capacityTons && weight / 1000 > Number(vehicle.capacityTons)

  const create = useMutation({
    mutationFn: () => transportApi.createTrip({
      vehicleId: f.vehicleId, driverId: f.driverId || null, helperName: f.helperName || null,
      fromCity: f.fromCity.trim(), toCity: f.toCity.trim(), startDate: f.startDate,
      driverAdvance: Number(f.driverAdvance || 0), hireCharges: Number(f.hireCharges || 0),
      hireAdvancePaid: Number(f.hireAdvancePaid || 0), notes: f.notes || null, lrIds,
    }),
    onSuccess: (t: any) => {
      qc.invalidateQueries({ queryKey: ['transport-trips'] })
      qc.invalidateQueries({ queryKey: ['transport-lrs'] })
      qc.invalidateQueries({ queryKey: ['transport-dashboard'] })
      toast.success(`Trip ${t.tripNo} planned`)
      onCreated(t.id)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  function submit() {
    if (!f.vehicleId) return toast.error('Pick a vehicle')
    if (!f.fromCity.trim() || !f.toCity.trim()) return toast.error('From and To are required')
    create.mutate()
  }

  return (
    <Modal title="New truck trip" width="xl" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save trip'}
        </button>
      </>}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-3">
          <div>
            <label className="label">Truck *</label>
            <select className="input" value={f.vehicleId} onChange={set('vehicleId')}>
              <option value="">— Select —</option>
              {(vehicles as any[]).filter((v) => v.status !== 'inactive').map((v) => (
                <option key={v.id} value={v.id}>
                  {v.regNo} · {v.vehicleType.toUpperCase()}{v.capacityTons ? ` ${v.capacityTons}T` : ''} · {v.status.replace('_', ' ')}
                </option>
              ))}
            </select>
            {vehicle?.status === 'on_trip' && <p className="text-xs text-amber-600 mt-1">On another trip now — you can plan, but starting needs it to be free.</p>}
          </div>
          <div>
            <label className="label">Driver</label>
            <select className="input" value={f.driverId} onChange={set('driverId')}>
              <option value="">— None —</option>
              {(drivers as any[]).filter((d) => d.status !== 'inactive').map((d) => (
                <option key={d.id} value={d.id}>{d.name} · {d.status.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">From *</label><CityInput value={f.fromCity} onChange={(v) => setF((p) => ({ ...p, fromCity: v }))} /></div>
            <div><label className="label">To *</label><CityInput value={f.toCity} onChange={(v) => setF((p) => ({ ...p, toCity: v }))} /></div>
            <div><label className="label">Start date</label><input type="date" className="input" value={f.startDate} onChange={set('startDate')} /></div>
            <div><label className="label">Helper</label><input className="input" value={f.helperName} onChange={set('helperName')} /></div>
            <div><label className="label">Driver advance (₹)</label><input type="number" min="0" className="input" value={f.driverAdvance} onChange={set('driverAdvance')} /></div>
            {vehicle?.ownership === 'market' && (
              <>
                <div><label className="label">Truck rent paid (₹)</label><input type="number" min="0" className="input" value={f.hireCharges} onChange={set('hireCharges')} /></div>
                <div><label className="label">Rent advance paid (₹)</label><input type="number" min="0" className="input" value={f.hireAdvancePaid} onChange={set('hireAdvancePaid')} /></div>
              </>
            )}
          </div>
          <div><label className="label">Notes</label><textarea className="input h-16 resize-none" value={f.notes} onChange={set('notes')} /></div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label !mb-0">Put these loads on the truck</label>
            <span className="text-xs text-gray-500">{picked.length} selected · {num(weight)} kg · {inr(freight)}</span>
          </div>
          {overload && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-2">
              Load is {num(weight / 1000, 1)} T — above {vehicle.regNo}'s {vehicle.capacityTons} T capacity.
            </p>
          )}
          <div className="border border-gray-200 rounded-lg max-h-[360px] overflow-y-auto divide-y divide-gray-50">
            {lrs.length === 0 ? (
              <p className="p-4 text-sm text-gray-400 text-center">No loads are waiting. You can add loads to the trip later.</p>
            ) : lrs.map((l) => (
              <label key={l.id} className="flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={lrIds.includes(l.id)}
                  onChange={(e) => setLrIds((p) => e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id))} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900"><span className="font-mono text-xs text-gray-500 mr-2">{l.lrNo}</span>{l.fromCity} → {l.toCity}</div>
                  <div className="text-xs text-gray-500 truncate">{l.consignorName} · {l.goodsDescription} · {num(l.chargedWeightKg)} kg</div>
                </div>
                <span className="text-sm font-medium text-gray-900">{inr(l.totalAmount)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}
