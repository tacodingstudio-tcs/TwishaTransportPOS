// Trip & vehicle expenses — fuel, tolls, repairs, challans… across the whole fleet.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Trash2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { inr, num, fmtDate, todayIst, EXPENSE_LABEL } from '@/components/transport/format'

const VEHICLE_EXPENSES = ['diesel', 'toll', 'repair', 'tyres', 'spares', 'insurance', 'permit_tax', 'challan', 'parking', 'emi', 'driver_salary', 'misc']

export function TransportExpensesPage() {
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const qc = useQueryClient()
  const [category, setCategory] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [showNew, setShowNew] = useState(false)

  const { data: vehicles = [] } = useQuery({ queryKey: ['transport-vehicles', 'pick'], queryFn: () => transportApi.listVehicles() })
  const { data, isLoading } = useQuery({
    queryKey: ['transport-expenses', category, vehicleId, from, to, page],
    queryFn:  () => transportApi.listExpenses({ category: category || undefined, vehicleId: vehicleId || undefined, from: from || undefined, to: to || undefined, page, limit: 30 }),
    placeholderData: (p) => p,
  })
  const rows: any[] = data?.data ?? []
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 30))

  const remove = useMutation({
    mutationFn: (id: string) => transportApi.deleteExpense(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-expenses'] }); toast.success('Expense deleted') },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader
        title="Diesel & trip costs"
        subtitle={`${num(data?.total ?? 0)} entries · ${inr(data?.totalAmount ?? 0)}`}
        action={!readOnly && <button type="button" className="btn-primary" onClick={() => setShowNew(true)}><Plus className="w-4 h-4" /> Add cost</button>}
      />
      <div className="p-6 space-y-4">
        <div className="flex gap-3 flex-wrap">
          <select className="input w-48" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1) }}>
            <option value="">All categories</option>
            {Object.entries(EXPENSE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input w-48" value={vehicleId} onChange={(e) => { setVehicleId(e.target.value); setPage(1) }}>
            <option value="">All trucks</option>
            {(vehicles as any[]).map((v) => <option key={v.id} value={v.id}>{v.regNo}</option>)}
          </select>
          <input type="date" className="input w-40" title="From" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
          <input type="date" className="input w-40" title="To" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
        </div>

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : rows.length === 0 ? <div className="text-center text-gray-400 py-12">No costs found</div>
          : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Date</th>
                    <th className="px-4 py-2.5 text-left">Category</th>
                    <th className="px-4 py-2.5 text-left">Truck</th>
                    <th className="px-4 py-2.5 text-left">Trip</th>
                    <th className="px-4 py-2.5 text-left">Details</th>
                    <th className="px-4 py-2.5 text-right">Amount</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDate(e.expenseDate)}</td>
                      <td className="px-4 py-2.5 text-gray-900">{EXPENSE_LABEL[e.category] ?? e.category}</td>
                      <td className="px-4 py-2.5 text-gray-700">{e.vehicleNo ?? '—'}</td>
                      <td className="px-4 py-2.5">{e.tripId ? <Link className="font-mono text-xs text-primary-600 hover:underline" to={`/transport/trips/${e.tripId}`}>{e.tripNo}</Link> : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{[e.litres && `${num(e.litres, 1)} L`, e.location, e.billNo, e.notes].filter(Boolean).join(' · ')}</td>
                      <td className="px-4 py-2.5 text-right font-medium">{inr(e.amount)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {!readOnly && <button type="button" title="Delete" className="p-1 text-gray-300 hover:text-red-600"
                          onClick={() => { if (confirm('Delete this expense?')) remove.mutate(e.id) }}><Trash2 className="w-4 h-4" /></button>}
                      </td>
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
      {showNew && <VehicleExpenseModal vehicles={vehicles as any[]} onClose={() => setShowNew(false)} />}
    </div>
  )
}

function VehicleExpenseModal({ vehicles, onClose }: { vehicles: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ vehicleId: '', category: 'repair', amount: '', date: todayIst(), mode: 'cash', billNo: '', notes: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => transportApi.createExpense({
      vehicleId: f.vehicleId, category: f.category, amount: Number(f.amount), expenseDate: f.date,
      paymentMode: f.mode, billNo: f.billNo || undefined, notes: f.notes || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-expenses'] }); qc.invalidateQueries({ queryKey: ['transport-dashboard'] }); toast.success('Expense added'); onClose() },
    onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Add truck cost" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!f.vehicleId || !(Number(f.amount) > 0) || m.isPending} onClick={() => m.mutate()}>Save</button>
      </>}>
      <p className="text-xs text-gray-400 mb-3">For diesel or toll during a trip, add it from that trip so the trip profit is correct.</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Truck *</label>
          <select className="input" value={f.vehicleId} onChange={set('vehicleId')}><option value="">— Select —</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.regNo}</option>)}</select></div>
        <div><label className="label">Category</label>
          <select className="input" value={f.category} onChange={set('category')}>{VEHICLE_EXPENSES.map((c) => <option key={c} value={c}>{EXPENSE_LABEL[c]}</option>)}</select></div>
        <div><label className="label">Amount (₹) *</label><input type="number" min="0" className="input" value={f.amount} onChange={set('amount')} /></div>
        <div><label className="label">Date</label><input type="date" className="input" value={f.date} onChange={set('date')} /></div>
        <div><label className="label">How was it paid?</label>
          <select className="input" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="credit">On credit</option></select></div>
        <div><label className="label">Bill no</label><input className="input" value={f.billNo} onChange={set('billNo')} /></div>
        <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  )
}
