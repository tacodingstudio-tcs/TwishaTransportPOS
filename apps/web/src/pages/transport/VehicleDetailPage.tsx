// Vehicle profile — documents, mileage, cost breakdown and recent trips.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Pencil, Wrench, Trash2, CheckCircle2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, num, fmtDate, daysUntil, VEHICLE_TYPE_LABEL, EXPENSE_LABEL } from '@/components/transport/format'
import { DOC_FIELDS, VehicleFormModal } from './VehiclesPage'

function DocChip({ label, date }: { label: string; date: string | null }) {
  const d = daysUntil(date)
  const tone = d == null ? 'bg-gray-50 border-gray-200 text-gray-400'
    : d < 0 ? 'bg-red-50 border-red-200 text-red-700'
    : d <= 30 ? 'bg-amber-50 border-amber-200 text-amber-700'
    : 'bg-green-50 border-green-200 text-green-700'
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-sm font-semibold">{date ? fmtDate(date) : 'Not set'}</div>
      {d != null && <div className="text-xs">{d < 0 ? `Expired ${-d} days ago` : d === 0 ? 'Expires today' : `${d} days left`}</div>}
    </div>
  )
}

export function VehicleDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const canManage = useAuthStore((s) => s.canManage())
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [edit, setEdit] = useState(false)

  const { data: v, isLoading } = useQuery({ queryKey: ['transport-vehicle', id], queryFn: () => transportApi.getVehicle(id!) })

  const invalidate = () => { for (const k of ['transport-vehicle', 'transport-vehicles', 'transport-dashboard']) qc.invalidateQueries({ queryKey: [k] }) }
  const setStatus = useMutation({
    mutationFn: (status: string) => transportApi.updateVehicle(id!, { status }),
    onSuccess: () => { invalidate(); toast.success('Status updated') }, onError: (e) => toast.error(apiError(e)),
  })
  const remove = useMutation({
    mutationFn: () => transportApi.deleteVehicle(id!),
    onSuccess: () => { invalidate(); toast.success('Vehicle removed'); navigate('/transport/vehicles') }, onError: (e) => toast.error(apiError(e)),
  })

  if (isLoading || !v) return <div className="p-8 text-center text-gray-400">{isLoading ? 'Loading…' : 'Vehicle not found'}</div>

  const totalCost = (v.expenseByCategory as any[]).reduce((s, r) => s + Number(r.amount), 0)

  return (
    <div>
      <PageHeader
        title={v.regNo}
        subtitle={`${VEHICLE_TYPE_LABEL[v.vehicleType]}${v.capacityTons ? ` · ${v.capacityTons} T` : ''}${v.makeModel ? ` · ${v.makeModel}` : ''}`}
        action={
          <div className="flex gap-2 items-center">
            <StatusPill kind="vehicle" status={v.status} />
            {!readOnly && v.status === 'available' && (
              <button type="button" className="btn-ghost" onClick={() => setStatus.mutate('maintenance')}><Wrench className="w-4 h-4" /> Send to garage</button>
            )}
            {!readOnly && v.status === 'maintenance' && (
              <button type="button" className="btn-ghost" onClick={() => setStatus.mutate('available')}><CheckCircle2 className="w-4 h-4" /> Back on road</button>
            )}
            {!readOnly && <button type="button" className="btn-ghost" onClick={() => setEdit(true)}><Pencil className="w-4 h-4" /> Edit</button>}
            {canManage && (
              <button type="button" className="btn-ghost text-red-600" onClick={() => { if (confirm(`Remove ${v.regNo} from your trucks?`)) remove.mutate() }}>
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Papers</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {DOC_FIELDS.map(([k, label]) => <DocChip key={k} label={label} date={v[k]} />)}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Profile</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-gray-500">Own / hired</dt><dd className="capitalize">{v.ownership}</dd></div>
              {v.ownerName && <div className="flex justify-between"><dt className="text-gray-500">Owner</dt><dd>{v.ownerName}{v.ownerPhone ? ` · ${v.ownerPhone}` : ''}</dd></div>}
              <div className="flex justify-between"><dt className="text-gray-500">Default driver</dt><dd>{v.defaultDriverName ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Meter reading</dt><dd>{num(v.currentOdometer)} km</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Mileage</dt><dd>{v.fuelEfficiencyKmpl ? `${v.fuelEfficiencyKmpl} km/L` : '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">FASTag</dt><dd>{v.fastagId ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Year</dt><dd>{v.yearOfMfg ?? '—'}</dd></div>
            </dl>
            {v.notes && <p className="text-xs text-gray-500">{v.notes}</p>}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">All costs so far <span className="font-normal text-gray-400">· {inr(totalCost)}</span></h2>
            {(v.expenseByCategory as any[]).length === 0 ? <p className="text-sm text-gray-400">No expenses recorded.</p> : (
              <ul className="space-y-2">
                {(v.expenseByCategory as any[]).map((r) => {
                  const pct = totalCost ? Math.round((Number(r.amount) / totalCost) * 100) : 0
                  return (
                    <li key={r.category}>
                      <div className="flex justify-between text-sm"><span className="text-gray-700">{EXPENSE_LABEL[r.category] ?? r.category}</span><span className="font-medium">{inr(r.amount)}</span></div>
                      <div className="h-1.5 bg-gray-100 rounded-full mt-1"><div className="h-1.5 bg-primary-500 rounded-full" style={{ width: `${pct}%` }} /></div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100"><h2 className="text-sm font-semibold text-gray-900">Recent trips</h2></div>
            {(v.recentTrips as any[]).length === 0 ? <p className="p-5 text-sm text-gray-400">No trips yet.</p> : (
              <ul className="divide-y divide-gray-50 max-h-[360px] overflow-y-auto">
                {(v.recentTrips as any[]).map((t) => (
                  <li key={t.id}>
                    <Link to={`/transport/trips/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-900">{t.fromCity} → {t.toCity}</div>
                        <div className="text-xs text-gray-500">{t.tripNo} · {fmtDate(t.startDate)}</div>
                      </div>
                      <span className="text-sm font-medium">{inr(t.freight)}</span>
                      <StatusPill kind="trip" status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {edit && <VehicleFormModal initial={v} onClose={() => setEdit(false)} />}
    </div>
  )
}
