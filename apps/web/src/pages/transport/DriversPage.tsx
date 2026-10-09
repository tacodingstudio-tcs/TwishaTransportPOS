// Drivers — roster, licence expiry and trip-advance ledger.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Search, Pencil, Trash2, Phone } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, fmtDate, toInputDate, daysUntil } from '@/components/transport/format'

export function DriversPage() {
  const canManage = useAuthStore((s) => s.canManage())
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<any | 'new' | null>(null)
  const [ledgerFor, setLedgerFor] = useState<string | null>(null)

  const { data = [], isLoading } = useQuery({
    queryKey: ['transport-drivers', search],
    queryFn:  () => transportApi.listDrivers({ search: search || undefined }),
  })
  const rows = data as any[]

  const remove = useMutation({
    mutationFn: (id: string) => transportApi.deleteDriver(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-drivers'] }); toast.success('Driver removed') },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader
        title="Drivers"
        subtitle={`${rows.length} drivers`}
        action={!readOnly && <button type="button" className="btn-primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" /> Add driver</button>}
      />
      <div className="p-6 space-y-4">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input className="input pl-9" placeholder="Name, phone, licence no…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No drivers yet</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Driver</th>
                    <th className="px-4 py-2.5 text-left">Licence</th>
                    <th className="px-4 py-2.5 text-left">Licence valid till</th>
                    <th className="px-4 py-2.5 text-left">Salary</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((d) => {
                    const left = daysUntil(d.licenseExpiry)
                    return (
                      <tr key={d.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setLedgerFor(d.id)}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{d.name}</div>
                          {d.phone && <div className="text-xs text-gray-500 flex items-center gap-1"><Phone className="w-3 h-3" />{d.phone}</div>}
                        </td>
                        <td className="px-4 py-3 text-gray-600"><div className="font-mono text-xs">{d.licenseNo ?? '—'}</div><div className="text-xs text-gray-400">{d.licenseClass}</div></td>
                        <td className="px-4 py-3">
                          {d.licenseExpiry ? (
                            <span className={`badge ${left! < 0 ? 'bg-red-100 text-red-700' : left! <= 30 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                              {fmtDate(d.licenseExpiry)}{left! < 0 ? ' · expired' : left! <= 30 ? ` · ${left}d` : ''}
                            </span>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs">{inr(d.salaryAmount)} / {d.salaryType.replace('_', ' ')}</td>
                        <td className="px-4 py-3"><StatusPill kind="driver" status={d.status} /></td>
                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          {!readOnly && <button type="button" title="Edit" className="p-1 text-gray-400 hover:text-gray-700" onClick={() => setEditing(d)}><Pencil className="w-4 h-4" /></button>}
                          {canManage && <button type="button" title="Remove" className="p-1 text-gray-300 hover:text-red-600"
                            onClick={() => { if (confirm(`Remove ${d.name}?`)) remove.mutate(d.id) }}><Trash2 className="w-4 h-4" /></button>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {editing && <DriverFormModal initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {ledgerFor && <DriverLedgerModal id={ledgerFor} onClose={() => setLedgerFor(null)} />}
    </div>
  )
}

function DriverFormModal({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    name: initial?.name ?? '', phone: initial?.phone ?? '', licenseNo: initial?.licenseNo ?? '', licenseClass: initial?.licenseClass ?? 'HMV',
    licenseExpiry: toInputDate(initial?.licenseExpiry), bloodGroup: initial?.bloodGroup ?? '', address: initial?.address ?? '',
    joinedOn: toInputDate(initial?.joinedOn), salaryType: initial?.salaryType ?? 'monthly', salaryAmount: initial?.salaryAmount ?? '',
    status: initial?.status === 'off_duty' ? 'off_duty' : 'available', notes: initial?.notes ?? '',
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))

  const save = useMutation({
    mutationFn: (body: any) => (initial ? transportApi.updateDriver(initial.id, body) : transportApi.createDriver(body)),
    onSuccess: () => {
      for (const k of ['transport-drivers', 'transport-compliance', 'transport-dashboard']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(initial ? 'Driver updated' : 'Driver added'); onClose()
    },
    onError: (e) => toast.error(apiError(e)),
  })

  function submit() {
    if (!f.name.trim()) return toast.error('Name is required')
    save.mutate({
      name: f.name.trim(), phone: f.phone || null, licenseNo: f.licenseNo || null, licenseClass: f.licenseClass || null,
      licenseExpiry: f.licenseExpiry || null, bloodGroup: f.bloodGroup || null, address: f.address || null, joinedOn: f.joinedOn || null,
      salaryType: f.salaryType, salaryAmount: Number(f.salaryAmount || 0), notes: f.notes || null,
      ...(initial && initial.status !== 'on_trip' ? { status: f.status } : {}),
    })
  }

  return (
    <Modal title={initial ? `Edit ${initial.name}` : 'Add driver'} onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Name *</label><input className="input" value={f.name} onChange={set('name')} /></div>
        <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={set('phone')} /></div>
        <div><label className="label">Blood group</label><input className="input" value={f.bloodGroup} onChange={set('bloodGroup')} /></div>
        <div><label className="label">Licence no</label><input className="input" value={f.licenseNo} onChange={set('licenseNo')} /></div>
        <div><label className="label">Licence class</label><input className="input" value={f.licenseClass} onChange={set('licenseClass')} /></div>
        <div><label className="label">Licence expiry</label><input type="date" className="input" value={f.licenseExpiry} onChange={set('licenseExpiry')} /></div>
        <div><label className="label">Joined on</label><input type="date" className="input" value={f.joinedOn} onChange={set('joinedOn')} /></div>
        <div><label className="label">Pay type</label>
          <select className="input" value={f.salaryType} onChange={set('salaryType')}><option value="monthly">Monthly</option><option value="per_trip">Per trip</option><option value="per_km">Per km</option></select></div>
        <div><label className="label">Pay amount (₹)</label><input type="number" min="0" className="input" value={f.salaryAmount} onChange={set('salaryAmount')} /></div>
        {initial && initial.status !== 'on_trip' && (
          <div><label className="label">Available?</label>
            <select className="input" value={f.status} onChange={set('status')}><option value="available">Available</option><option value="off_duty">On leave</option></select></div>
        )}
        <div className="col-span-2"><label className="label">Address</label><input className="input" value={f.address} onChange={set('address')} /></div>
      </div>
    </Modal>
  )
}

function DriverLedgerModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['transport-driver', id], queryFn: () => transportApi.getDriver(id) })
  return (
    <Modal title={data ? `${data.name} — cash account` : 'Driver'} width="lg" onClose={onClose}>
      {!data ? <p className="text-gray-400 text-sm">Loading…</p> : data.trips.length === 0 ? (
        <p className="text-sm text-gray-500">No trips yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase"><tr>
            <th className="py-2 text-left">Trip</th><th className="py-2 text-left">Vehicle</th>
            <th className="py-2 text-right">Cash given</th><th className="py-2 text-right">Spent</th><th className="py-2 text-right">Balance</th></tr></thead>
          <tbody className="divide-y divide-gray-50">
            {data.trips.map((t: any) => (
              <tr key={t.id}>
                <td className="py-2"><div className="text-gray-900">{t.fromCity} → {t.toCity}</div><div className="text-xs text-gray-500">{t.tripNo} · {fmtDate(t.startDate)}</div></td>
                <td className="py-2 text-gray-600">{t.vehicleNo}</td>
                <td className="py-2 text-right">{inr(t.driverAdvance)}</td>
                <td className="py-2 text-right">{inr(t.cashSpent)}</td>
                <td className={`py-2 text-right font-medium ${t.balance > 0 ? 'text-amber-700' : t.balance < 0 ? 'text-blue-700' : 'text-gray-500'}`}>
                  {t.balance === 0 ? 'Settled' : `${inr(Math.abs(t.balance))} ${t.balance > 0 ? 'to return' : 'owed'}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
