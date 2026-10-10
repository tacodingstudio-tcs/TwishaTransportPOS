// Fleet register — vehicles with live status and document-expiry warnings.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Search } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { PartyCombobox } from '@/components/ui/PartyCombobox'
import { StatusPill } from '@/components/transport/StatusPill'
import { num, toInputDate, daysUntil, VEHICLE_TYPE_LABEL } from '@/components/transport/format'

export const DOC_FIELDS: Array<[string, string]> = [
  ['fitnessExpiry', 'Fitness'], ['permitExpiry', 'Permit'], ['nationalPermitExpiry', 'National permit'],
  ['insuranceExpiry', 'Insurance'], ['pucExpiry', 'PUC'], ['roadTaxExpiry', 'Road tax'],
]

/** Worst document state for a vehicle → colour + short label for the list. */
export function complianceBadge(v: any, warnDays = 30): { cls: string; label: string } {
  let min: number | null = null
  for (const [k] of DOC_FIELDS) {
    const d = daysUntil(v[k])
    if (d != null && (min == null || d < min)) min = d
  }
  if (min == null) return { cls: 'bg-gray-100 text-gray-500', label: 'No dates' }
  if (min < 0) return { cls: 'bg-red-100 text-red-700', label: `Expired ${-min}d ago` }
  if (min <= 7) return { cls: 'bg-red-100 text-red-700', label: `Due in ${min}d` }
  if (min <= warnDays) return { cls: 'bg-amber-100 text-amber-700', label: `Due in ${min}d` }
  return { cls: 'bg-green-100 text-green-700', label: 'Papers OK' }
}

export function VehiclesPage() {
  const navigate = useNavigate()
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [showNew, setShowNew] = useState(false)

  const { data = [], isLoading } = useQuery({
    queryKey: ['transport-vehicles', search, status],
    queryFn:  () => transportApi.listVehicles({ search: search || undefined, status: status || undefined }),
  })
  const rows = data as any[]

  return (
    <div>
      <PageHeader
        title="Trucks"
        subtitle={`${rows.length} trucks`}
        action={!readOnly && <button type="button" className="btn-primary" onClick={() => setShowNew(true)}><Plus className="w-4 h-4" /> Add truck</button>}
      />
      <div className="p-6 space-y-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative max-w-sm flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Search truck no, make, owner…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="flex gap-1">
            {[['', 'All'], ['available', 'Free'], ['on_trip', 'On the way'], ['maintenance', 'In garage']].map(([v, l]) => (
              <button key={v} type="button" onClick={() => setStatus(v!)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${status === v ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{l}</button>
            ))}
          </div>
        </div>

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No trucks yet — tap “Add truck”.</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Truck</th>
                    <th className="px-4 py-2.5 text-left">Type</th>
                    <th className="px-4 py-2.5 text-left">Own / hired</th>
                    <th className="px-4 py-2.5 text-left">Default driver</th>
                    <th className="px-4 py-2.5 text-right">Meter</th>
                    <th className="px-4 py-2.5 text-left">Papers</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((v) => {
                    const c = complianceBadge(v)
                    return (
                      <tr key={v.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/transport/vehicles/${v.id}`)}>
                        <td className="px-4 py-3"><div className="font-semibold text-gray-900">{v.regNo}</div><div className="text-xs text-gray-500">{v.makeModel}</div></td>
                        <td className="px-4 py-3 text-gray-700">{VEHICLE_TYPE_LABEL[v.vehicleType] ?? v.vehicleType}{v.capacityTons ? ` · ${v.capacityTons} T` : ''}</td>
                        <td className="px-4 py-3 text-gray-600 capitalize">{v.ownership}{v.ownership !== 'own' && v.ownerName ? ` · ${v.ownerName}` : ''}</td>
                        <td className="px-4 py-3 text-gray-600">{v.defaultDriverName ?? '—'}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{num(v.currentOdometer)} km</td>
                        <td className="px-4 py-3"><span className={`badge ${c.cls}`}>{c.label}</span></td>
                        <td className="px-4 py-3"><StatusPill kind="vehicle" status={v.status} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {showNew && <VehicleFormModal onClose={() => setShowNew(false)} />}
    </div>
  )
}

export function VehicleFormModal({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    regNo: initial?.regNo ?? '', vehicleType: initial?.vehicleType ?? 'hcv', makeModel: initial?.makeModel ?? '',
    yearOfMfg: initial?.yearOfMfg ?? '', capacityTons: initial?.capacityTons ?? '', bodyType: initial?.bodyType ?? '',
    ownership: initial?.ownership ?? 'own', ownerName: initial?.ownerName ?? '', ownerPhone: initial?.ownerPhone ?? '',
    fastagId: initial?.fastagId ?? '', currentOdometer: initial?.currentOdometer ?? 0, defaultDriverId: initial?.defaultDriverId ?? '',
    fitnessExpiry: toInputDate(initial?.fitnessExpiry), permitExpiry: toInputDate(initial?.permitExpiry),
    nationalPermitExpiry: toInputDate(initial?.nationalPermitExpiry), insuranceExpiry: toInputDate(initial?.insuranceExpiry),
    pucExpiry: toInputDate(initial?.pucExpiry), roadTaxExpiry: toInputDate(initial?.roadTaxExpiry), notes: initial?.notes ?? '',
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }))

  const { data: drivers = [] } = useQuery({ queryKey: ['transport-drivers', 'pick'], queryFn: () => transportApi.listDrivers() })

  const save = useMutation({
    mutationFn: (body: any) => (initial ? transportApi.updateVehicle(initial.id, body) : transportApi.createVehicle(body)),
    onSuccess: () => {
      for (const k of ['transport-vehicles', 'transport-vehicle', 'transport-compliance', 'transport-dashboard']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(initial ? 'Vehicle updated' : 'Vehicle added')
      onClose()
    },
    onError: (e) => toast.error(apiError(e)),
  })

  function submit() {
    if (f.regNo.trim().length < 6) return toast.error('Enter the registration number')
    const date = (v: string) => (v ? v : null)
    save.mutate({
      regNo: f.regNo, vehicleType: f.vehicleType, makeModel: f.makeModel || null,
      yearOfMfg: f.yearOfMfg ? Number(f.yearOfMfg) : null, capacityTons: f.capacityTons ? Number(f.capacityTons) : null,
      bodyType: f.bodyType || null, ownership: f.ownership,
      ownerName: f.ownership === 'own' ? null : f.ownerName || null, ownerPhone: f.ownership === 'own' ? null : f.ownerPhone || null,
      fastagId: f.fastagId || null, currentOdometer: Number(f.currentOdometer || 0), defaultDriverId: f.defaultDriverId || null,
      fitnessExpiry: date(f.fitnessExpiry), permitExpiry: date(f.permitExpiry), nationalPermitExpiry: date(f.nationalPermitExpiry),
      insuranceExpiry: date(f.insuranceExpiry), pucExpiry: date(f.pucExpiry), roadTaxExpiry: date(f.roadTaxExpiry),
      notes: f.notes || null,
    })
  }

  return (
    <Modal title={initial ? `Edit ${initial.regNo}` : 'Add truck'} width="lg" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div><label className="label">Truck number *</label><input className="input uppercase" value={f.regNo} onChange={set('regNo')} placeholder="GJ05AB1234" /></div>
          <div><label className="label">Type</label>
            <select className="input" value={f.vehicleType} onChange={set('vehicleType')}>
              {Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div><label className="label">Capacity (tons)</label><input type="number" min="0" step="0.5" className="input" value={f.capacityTons} onChange={set('capacityTons')} /></div>
          <div><label className="label">Make / model</label><input className="input" value={f.makeModel} onChange={set('makeModel')} /></div>
          <div><label className="label">Year</label><input type="number" className="input" value={f.yearOfMfg} onChange={set('yearOfMfg')} /></div>
          <div><label className="label">Body</label><input className="input" value={f.bodyType} onChange={set('bodyType')} placeholder="Open / closed / tanker" /></div>
          <div><label className="label">Ownership</label>
            <select className="input" value={f.ownership} onChange={set('ownership')}>
              <option value="own">My own truck</option><option value="attached">Attached to me</option><option value="market">Hired from outside</option>
            </select></div>
          {f.ownership !== 'own' && (
            <>
              <PartyCombobox label="Owner name" type="supplier" value={{ name: f.ownerName }}
                  hint="Pick a saved supplier to fill the owner's phone too, or type a new name"
                  onChange={(p) => setF((prev: any) => ({ ...prev, ownerName: p.name, ...(p.id && p.phone ? { ownerPhone: p.phone } : {}) }))} />
              <div><label className="label">Owner phone</label><input className="input" value={f.ownerPhone} onChange={set('ownerPhone')} /></div>
            </>
          )}
          <div><label className="label">Meter reading (km)</label><input type="number" min="0" className="input" value={f.currentOdometer} onChange={set('currentOdometer')} /></div>
          <div><label className="label">FASTag ID</label><input className="input" value={f.fastagId} onChange={set('fastagId')} /></div>
          <div><label className="label">Default driver</label>
            <select className="input" value={f.defaultDriverId} onChange={set('defaultDriverId')}>
              <option value="">— None —</option>
              {(drivers as any[]).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
        </div>

        <div>
          <h4 className="text-sm font-semibold text-gray-900 mb-2">Papers — last valid date</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {DOC_FIELDS.map(([k, label]) => (
              <div key={k}><label className="label">{label}</label><input type="date" className="input" value={(f as any)[k]} onChange={set(k as keyof typeof f)} /></div>
            ))}
          </div>
        </div>
        <div><label className="label">Notes</label><textarea className="input h-16 resize-none" value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  )
}
