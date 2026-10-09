// Rate card — standard lane rates, optionally per customer and vehicle type. LR booking auto-suggests these.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Search, Pencil, Trash2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { CityInput } from '@/components/transport/CityInput'
import { PartyPicker, type PickedParty } from '@/components/transport/PartyPicker'
import { inr, RATE_BASIS_LABEL, VEHICLE_TYPE_LABEL } from '@/components/transport/format'

export function RoutesPage() {
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<any | 'new' | null>(null)

  const { data = [], isLoading } = useQuery({
    queryKey: ['transport-routes', search],
    queryFn:  () => transportApi.listRoutes({ search: search || undefined }),
  })
  const rows = data as any[]

  const remove = useMutation({
    mutationFn: (id: string) => transportApi.deleteRoute(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-routes'] }); toast.success('Route removed') },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader
        title="Rates"
        subtitle="Your usual rate for each route — filled automatically when you book a load"
        action={!readOnly && <button type="button" className="btn-primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> Add rate</button>}
      />
      <div className="p-6 space-y-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input className="input pl-9" placeholder="Search city…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No rates yet — add your usual routes so the rate fills in by itself.</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Route</th>
                    <th className="px-4 py-2.5 text-right">Distance</th>
                    <th className="px-4 py-2.5 text-left">For</th>
                    <th className="px-4 py-2.5 text-left">Rate is</th>
                    <th className="px-4 py-2.5 text-right">Rate</th>
                    <th className="px-4 py-2.5 text-right">Toll est.</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{r.fromCity} → {r.toCity}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{r.distanceKm ? `${r.distanceKm} km` : '—'}</td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{r.partyName ?? 'Everyone'}{r.vehicleType ? ` · ${VEHICLE_TYPE_LABEL[r.vehicleType]}` : ''}</td>
                      <td className="px-4 py-3 text-gray-600">{RATE_BASIS_LABEL[r.rateBasis]}</td>
                      <td className="px-4 py-3 text-right font-semibold">{inr(r.rate)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">{r.tollEstimate > 0 ? inr(r.tollEstimate) : '—'}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {!readOnly && <>
                          <button type="button" title="Edit" className="p-1 text-gray-400 hover:text-gray-700" onClick={() => setEditing(r)}><Pencil className="w-4 h-4" /></button>
                          <button type="button" title="Remove" className="p-1 text-gray-300 hover:text-red-600" onClick={() => { if (confirm('Remove this route?')) remove.mutate(r.id) }}><Trash2 className="w-4 h-4" /></button>
                        </>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
      {editing && <RouteFormModal initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RouteFormModal({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    fromCity: initial?.fromCity ?? '', toCity: initial?.toCity ?? '', distanceKm: initial?.distanceKm ?? '',
    vehicleType: initial?.vehicleType ?? '', rateBasis: initial?.rateBasis ?? 'per_ton', rate: initial?.rate ?? '',
    tollEstimate: initial?.tollEstimate ?? '', notes: initial?.notes ?? '',
  })
  const [party, setParty] = useState<PickedParty>(initial?.partyId ? { id: initial.partyId, name: initial.partyName ?? '' } : { name: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))

  const save = useMutation({
    mutationFn: (body: any) => (initial ? transportApi.updateRoute(initial.id, body) : transportApi.createRoute(body)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-routes'] }); qc.invalidateQueries({ queryKey: ['transport-cities'] }); toast.success('Route saved'); onClose() },
    onError: (e) => toast.error(apiError(e)),
  })

  function submit() {
    if (!f.fromCity.trim() || !f.toCity.trim()) return toast.error('From and To are required')
    if (f.rate === '') return toast.error('Enter the rate')
    save.mutate({
      fromCity: f.fromCity.trim(), toCity: f.toCity.trim(), distanceKm: f.distanceKm ? Number(f.distanceKm) : null,
      vehicleType: f.vehicleType || null, partyId: party.id ?? null, rateBasis: f.rateBasis, rate: Number(f.rate),
      tollEstimate: Number(f.tollEstimate || 0), notes: f.notes || null,
    })
  }

  return (
    <Modal title={initial ? 'Change rate' : 'Add rate'} onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" onClick={submit} disabled={save.isPending}>Save</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">From *</label><CityInput value={f.fromCity} onChange={(v) => setF((p) => ({ ...p, fromCity: v }))} /></div>
        <div><label className="label">To *</label><CityInput value={f.toCity} onChange={(v) => setF((p) => ({ ...p, toCity: v }))} /></div>
        <div><label className="label">Distance (km)</label><input type="number" min="0" className="input" value={f.distanceKm} onChange={set('distanceKm')} /></div>
        <div><label className="label">Vehicle type</label>
          <select className="input" value={f.vehicleType} onChange={set('vehicleType')}>
            <option value="">Any</option>{Object.entries(VEHICLE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        <div><label className="label">Rate basis</label>
          <select className="input" value={f.rateBasis} onChange={set('rateBasis')}>
            {['per_ton', 'per_kg', 'per_pkg', 'fixed'].map((v) => <option key={v} value={v}>{RATE_BASIS_LABEL[v]}</option>)}
          </select></div>
        <div><label className="label">Rate (₹) *</label><input type="number" min="0" className="input" value={f.rate} onChange={set('rate')} /></div>
        <div><label className="label">Toll (about, ₹)</label><input type="number" min="0" className="input" value={f.tollEstimate} onChange={set('tollEstimate')} /></div>
        <div className="col-span-2">
          <PartyPicker label="Special rate for one party (optional)" value={party} onChange={(p) => setParty(p.id ? p : { name: '' })} />
          <p className="text-xs text-gray-400 mt-1">Leave empty for your usual rate. A special party rate is used before the usual one.</p>
        </div>
      </div>
    </Modal>
  )
}
