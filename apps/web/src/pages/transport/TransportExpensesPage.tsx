// Trip & vehicle expenses — fuel, tolls, repairs, challans… across the whole fleet.
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Trash2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { useCursorPager } from '@/hooks/useCursorPager'
import { CursorPager } from '@/components/ui/CursorPager'
import { PeriodBar, usePeriod } from '@/components/transport/PeriodBar'
import { inr, num, fmtDate, todayIst, EXPENSE_LABEL } from '@/components/transport/format'

const VEHICLE_EXPENSES = ['diesel', 'toll', 'repair', 'tyres', 'spares', 'insurance', 'permit_tax', 'challan', 'parking', 'emi', 'driver_salary', 'misc']

export function TransportExpensesPage() {
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const qc = useQueryClient()
  const [category, setCategory] = useState('')
  const [vehicleId, setVehicleId] = useState('')
  const period = usePeriod('all', { all: true })
  const { from, to } = period
  const pager = useCursorPager()
  useEffect(() => { pager.reset() }, [from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showNew, setShowNew] = useState(false)

  const { data: vehicles = [] } = useQuery({ queryKey: ['transport-vehicles', 'pick'], queryFn: () => transportApi.listVehicles() })
  const { data, isLoading } = useQuery({
    queryKey: ['transport-expenses', category, vehicleId, from, to, pager.after],
    queryFn:  () => transportApi.listExpenses({ category: category || undefined, vehicleId: vehicleId || undefined, from: from || undefined, to: to || undefined, after: pager.after, limit: 30 }),
    placeholderData: (p) => p,
  })
  const rows: any[] = data?.data ?? []
  useEffect(() => { if (data?.total != null) pager.rememberTotal(data.total) }, [data?.total]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <PayablesPanel readOnly={readOnly} />
        <div className="flex gap-3 flex-wrap">
          <select className="input w-48" value={category} onChange={(e) => { setCategory(e.target.value); pager.reset() }}>
            <option value="">All categories</option>
            {Object.entries(EXPENSE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="input w-48" value={vehicleId} onChange={(e) => { setVehicleId(e.target.value); pager.reset() }}>
            <option value="">All trucks</option>
            {(vehicles as any[]).map((v) => <option key={v.id} value={v.id}>{v.regNo}</option>)}
          </select>
          <PeriodBar period={period} />
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
                      <td className="px-4 py-2.5 text-right font-medium">
                        {inr(e.amount)}
                        {e.paidByEff === 'vendor_credit' && <span className={`block text-xs font-normal ${e.settledOn ? 'text-green-600' : 'text-amber-600'}`}>{e.vendorName || 'On account'} · {e.settledOn ? 'paid' : 'unpaid'}</span>}
                      </td>
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

        <CursorPager pager={pager} pageSize={30} shown={rows.length} nextCursor={data?.nextCursor} total={pager.total ?? data?.total} />
      </div>
      {showNew && <VehicleExpenseModal vehicles={vehicles as any[]} onClose={() => setShowNew(false)} />}
    </div>
  )
}

/** Unpaid on-account bills grouped by pump / shop, with a "mark paid" action per bill or per vendor. */
function PayablesPanel({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['transport-payables'], queryFn: () => transportApi.expensePayables() })
  const [open, setOpen] = useState<string | null>(null)
  const groups: any[] = data?.data ?? []
  const settle = useMutation({
    mutationFn: (ids: string[]) => transportApi.settleExpenses({ ids, settledOn: todayIst() }),
    onSuccess: (r: any) => {
      for (const k of ['transport-payables', 'transport-expenses', 'transport-trip']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(`${r.settled} bill${r.settled > 1 ? 's' : ''} marked paid`)
    },
    onError: (e) => toast.error(apiError(e)),
  })
  if (groups.length === 0) return null
  return (
    <section className="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-amber-900 mb-2">You owe pumps & shops {inr(data.totalPayable)}</h2>
      <div className="divide-y divide-amber-100 bg-white rounded-lg border border-amber-100">
        {groups.map((g) => (
          <div key={g.vendor}>
            <div className="flex items-center gap-3 px-3 py-2 text-sm">
              <button type="button" className="flex-1 text-left" onClick={() => setOpen(open === g.vendor ? null : g.vendor)}>
                <span className="font-medium text-gray-900">{g.vendor}</span>
                <span className="text-xs text-gray-500 ml-2">{g.count} bill{g.count > 1 ? 's' : ''} · since {fmtDate(g.oldest)}</span>
              </button>
              <span className="font-semibold">{inr(g.total)}</span>
              {!readOnly && (
                <button type="button" className="btn-ghost text-xs" disabled={settle.isPending}
                  onClick={() => { if (confirm(`Mark all ${g.count} bills of ${g.vendor} (${inr(g.total)}) as paid?`)) settle.mutate(g.bills.map((b: any) => b.id)) }}>
                  Mark all paid
                </button>
              )}
            </div>
            {open === g.vendor && (
              <table className="w-full text-xs bg-gray-50">
                <tbody className="divide-y divide-gray-100">
                  {g.bills.map((b: any) => (
                    <tr key={b.id}>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{fmtDate(b.expenseDate)}</td>
                      <td className="px-3 py-1.5">{EXPENSE_LABEL[b.category] ?? b.category}{b.litres ? ` · ${num(b.litres, 1)} L` : ''}</td>
                      <td className="px-3 py-1.5 text-gray-500">{b.vehicleNo ?? ''} {b.tripNo ? `· ${b.tripNo}` : ''} {b.billNo ? `· #${b.billNo}` : ''}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{inr(b.amount)}</td>
                      <td className="px-3 py-1.5 text-right">
                        {!readOnly && <button type="button" className="text-primary-600 hover:underline" onClick={() => settle.mutate([b.id])}>Paid</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function VehicleExpenseModal({ vehicles, onClose }: { vehicles: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ vehicleId: '', category: 'repair', amount: '', date: todayIst(), mode: 'cash', vendor: '', billNo: '', notes: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => transportApi.createExpense({
      vehicleId: f.vehicleId, category: f.category, amount: Number(f.amount), expenseDate: f.date,
      paymentMode: f.mode, vendorName: f.mode === 'credit' ? f.vendor.trim() : undefined, billNo: f.billNo || undefined, notes: f.notes || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['transport-expenses'] }); qc.invalidateQueries({ queryKey: ['transport-dashboard'] }); toast.success('Expense added'); onClose() },
    onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Add truck cost" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!f.vehicleId || !(Number(f.amount) > 0) || (f.mode === 'credit' && !f.vendor.trim()) || m.isPending} onClick={() => m.mutate()}>Save</button>
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
          <select className="input" value={f.mode} onChange={set('mode')}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option><option value="credit">On account (pay later)</option></select></div>
        {f.mode === 'credit' && <div className="col-span-2"><label className="label">Shop / pump name *</label><input className="input" value={f.vendor} onChange={set('vendor')} /></div>}
        <div><label className="label">Bill no</label><input className="input" value={f.billNo} onChange={set('billNo')} /></div>
        <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  )
}
