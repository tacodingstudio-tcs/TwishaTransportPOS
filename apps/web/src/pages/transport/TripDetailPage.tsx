// Trip sheet — lifecycle (start / complete / cancel), LRs on board, expenses, P&L and driver settlement.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Play, Flag, Ban, Plus, Trash2, Unlink, Fuel } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, num, fmtDate, todayIst, EXPENSE_LABEL } from '@/components/transport/format'

const TRIP_EXPENSES = ['diesel', 'toll', 'driver_bhatta', 'loading_unloading', 'repair', 'tyres', 'challan', 'parking', 'broker_commission', 'misc']

type Dialog = null | 'start' | 'complete' | 'cancel' | 'expense' | 'addlr'

export function TripDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const canManage = useAuthStore((s) => s.canManage())
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [dialog, setDialog] = useState<Dialog>(null)

  const { data: trip, isLoading } = useQuery({ queryKey: ['transport-trip', id], queryFn: () => transportApi.getTrip(id!) })

  const refresh = () => {
    for (const k of ['transport-trip', 'transport-trips', 'transport-lrs', 'transport-dashboard', 'transport-vehicles', 'transport-drivers', 'transport-payables'])
      qc.invalidateQueries({ queryKey: [k] })
  }
  const done = (msg: string, warnings?: string[]) => {
    refresh(); setDialog(null); toast.success(msg)
    for (const w of warnings ?? []) toast(w, { icon: '⚠️', duration: 7000 })
  }

  const removeLr = useMutation({
    mutationFn: (lrId: string) => transportApi.removeTripLr(id!, lrId),
    onSuccess: () => done('LR removed from trip'), onError: (e) => toast.error(apiError(e)),
  })
  const delExpense = useMutation({
    mutationFn: (eid: string) => transportApi.deleteExpense(eid),
    onSuccess: () => done('Expense deleted'), onError: (e) => toast.error(apiError(e)),
  })

  if (isLoading || !trip) return <div className="p-8 text-center text-gray-400">{isLoading ? 'Loading…' : 'Trip not found'}</div>

  const live = trip.status === 'planned' || trip.status === 'running'
  const p = trip.pnl

  return (
    <div>
      <PageHeader
        title={`Trip ${trip.tripNo}`}
        subtitle={`${trip.fromCity} → ${trip.toCity} · ${trip.vehicleNo}${trip.driverName ? ` · ${trip.driverName}` : ''}`}
        action={
          <div className="flex gap-2 items-center">
            <StatusPill kind="trip" status={trip.status} />
            {!readOnly && trip.status === 'planned' && (
              <button type="button" className="btn-primary" onClick={() => setDialog('start')}><Play className="w-4 h-4" /> Start trip</button>
            )}
            {!readOnly && trip.status === 'running' && (
              <button type="button" className="btn-primary" onClick={() => setDialog('complete')}><Flag className="w-4 h-4" /> Finish trip</button>
            )}
            {canManage && live && (
              <button type="button" className="btn-ghost text-red-600" onClick={() => setDialog('cancel')}><Ban className="w-4 h-4" /> Cancel</button>
            )}
          </div>
        }
      />

      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">

          {/* LRs */}
          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center">
              <h2 className="text-sm font-semibold text-gray-900">Loads on this truck ({trip.lrs.length})</h2>
              {!readOnly && live && (
                <button type="button" className="ml-auto btn-ghost text-sm" onClick={() => setDialog('addlr')}><Plus className="w-4 h-4" /> Add LR</button>
              )}
            </div>
            {trip.lrs.length === 0 ? (
              <p className="p-6 text-sm text-gray-400 text-center">No LRs on this trip yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">LR</th>
                    <th className="px-4 py-2 text-left">Sender → Receiver</th>
                    <th className="px-4 py-2 text-right">Weight</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-right">Freight</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {trip.lrs.map((l: any) => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3"><Link className="font-mono text-xs text-primary-600 hover:underline" to={`/transport/lrs/${l.id}`}>{l.lrNo}</Link></td>
                      <td className="px-4 py-3"><div className="text-gray-900">{l.consignorName}</div><div className="text-xs text-gray-500">→ {l.consigneeName}</div></td>
                      <td className="px-4 py-3 text-right text-gray-600">{num(l.chargedWeightKg)} kg</td>
                      <td className="px-4 py-3"><StatusPill kind="lr" status={l.status} /></td>
                      <td className="px-4 py-3 text-right font-medium">{inr(l.totalAmount)}</td>
                      <td className="px-4 py-3 text-right">
                        {!readOnly && live && (l.status === 'booked' || l.status === 'in_transit') && (
                          <button type="button" title="Remove from trip" className="p-1 text-gray-400 hover:text-red-600"
                            onClick={() => removeLr.mutate(l.id)}><Unlink className="w-4 h-4" /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Expenses */}
          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center">
              <h2 className="text-sm font-semibold text-gray-900">Diesel & trip costs ({trip.expenses.length})</h2>
              {!readOnly && trip.status !== 'cancelled' && (
                <button type="button" className="ml-auto btn-ghost text-sm" onClick={() => setDialog('expense')}><Plus className="w-4 h-4" /> Add cost</button>
              )}
            </div>
            {trip.expenses.length === 0 ? (
              <p className="p-6 text-sm text-gray-400 text-center">No expenses recorded.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Category</th>
                    <th className="px-4 py-2 text-left">Details</th>
                    <th className="px-4 py-2 text-left">Paid by</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {trip.expenses.map((e: any) => (
                    <tr key={e.id}>
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDate(e.expenseDate)}</td>
                      <td className="px-4 py-2.5 text-gray-900">{EXPENSE_LABEL[e.category] ?? e.category}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">
                        {[e.litres && `${num(e.litres, 1)} L @ ${inr(e.ratePerLitre, 2)}`, e.location, e.notes].filter(Boolean).join(' · ')}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">
                        {e.paidByEff === 'driver' ? 'Driver' : e.paidByEff === 'vendor_credit' ? (e.vendorName || 'On account') : 'Company'}
                        <span className="block capitalize text-gray-400">{e.paymentMode.replace('_', ' ')}</span>
                        {e.paidByEff === 'vendor_credit' && (e.settledOn
                          ? <span className="text-green-600">Paid {fmtDate(e.settledOn)}</span>
                          : <span className="text-amber-600 font-medium">Unpaid</span>)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium">{inr(e.amount)}</td>
                      <td className="px-4 py-2.5 text-right">
                        {!readOnly && (
                          <button type="button" title="Delete" className="p-1 text-gray-300 hover:text-red-600"
                            onClick={() => { if (confirm('Delete this expense?')) delExpense.mutate(e.id) }}><Trash2 className="w-4 h-4" /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        {/* P&L + facts */}
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Profit on this trip</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-gray-500">Freight (bhada) earned</dt><dd>{inr(p.freight)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Spent on trip</dt><dd className="text-red-600">− {inr(p.expenses)}</dd></div>
              {p.hireCharges > 0 && <div className="flex justify-between"><dt className="text-gray-500">Truck rent paid</dt><dd className="text-red-600">− {inr(p.hireCharges)}</dd></div>}
              <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold">
                <dt>Profit</dt>
                <dd className={p.net >= 0 ? 'text-green-700' : 'text-red-600'}>{inr(p.net)} <span className="text-xs font-normal text-gray-400">({p.marginPct}%)</span></dd>
              </div>
            </dl>
            {p.vendorUnpaid > 0 && (
              <p className="text-xs text-amber-700 mt-3">{inr(p.vendorUnpaid)} of this is still unpaid to pumps / shops (taken on account).</p>
            )}
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2"><Fuel className="w-4 h-4 text-gray-400" /> Driver’s cash account</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-gray-500">Cash given to driver</dt><dd>{inr(p.driverAdvance)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Driver spent (cash)</dt><dd>− {inr(p.driverCashSpent)}</dd></div>
              <div className={`flex justify-between border-t border-gray-100 pt-2 font-semibold ${p.driverBalance >= 0 ? 'text-amber-700' : 'text-blue-700'}`}>
                <dt>{p.driverBalance >= 0 ? 'Driver should return' : 'You owe the driver'}</dt><dd>{inr(Math.abs(p.driverBalance))}</dd>
              </div>
            </dl>
            <p className="text-xs text-gray-400 mt-3">Only costs the driver paid are counted against the cash given. Costs paid by you or taken on account don’t affect it.</p>
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Trip details</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-gray-500">Start</dt><dd>{fmtDate(trip.startDate)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">End</dt><dd>{fmtDate(trip.endDate)}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Meter reading</dt>
                <dd>{trip.startOdometer != null ? num(trip.startOdometer) : '—'}{trip.endOdometer != null && ` → ${num(trip.endOdometer)} (${num(trip.endOdometer - trip.startOdometer)} km)`}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Helper</dt><dd>{trip.helperName ?? '—'}</dd></div>
              {trip.ownership === 'market' && <div className="flex justify-between"><dt className="text-gray-500">Hire advance paid</dt><dd>{inr(trip.hireAdvancePaid)} / {inr(trip.hireCharges)}</dd></div>}
            </dl>
            {trip.notes && <p className="text-xs text-gray-500 mt-3">{trip.notes}</p>}
          </section>
        </div>
      </div>

      {dialog === 'start' && <StartDialog trip={trip} onClose={() => setDialog(null)} onDone={(w) => done('Trip started', w)} />}
      {dialog === 'complete' && <CompleteDialog trip={trip} onClose={() => setDialog(null)} onDone={() => done('Trip completed')} />}
      {dialog === 'cancel' && <CancelTripDialog id={trip.id} onClose={() => setDialog(null)} onDone={() => { done('Trip cancelled'); navigate('/transport/trips') }} />}
      {dialog === 'expense' && <ExpenseDialog tripId={trip.id} onClose={() => setDialog(null)} onDone={() => done('Expense added')} />}
      {dialog === 'addlr' && <AddLrDialog tripId={trip.id} onClose={() => setDialog(null)} onDone={() => done('LRs added')} />}
    </div>
  )
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function StartDialog({ trip, onClose, onDone }: { trip: any; onClose: () => void; onDone: (w?: string[]) => void }) {
  const [odo, setOdo] = useState(trip.startOdometer != null ? String(trip.startOdometer) : '')
  const m = useMutation({
    mutationFn: () => transportApi.startTrip(trip.id, { startOdometer: odo ? Number(odo) : undefined }),
    onSuccess: (r: any) => onDone(r.warnings), onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Start trip" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={m.isPending} onClick={() => m.mutate()}>Start</button>
      </>}>
      <p className="text-sm text-gray-600 mb-3">{trip.vehicleNo} will show as “on the way” and its loads will show as on the way.</p>
      <label className="label">Truck meter reading now (km)</label>
      <input type="number" min="0" className="input" value={odo} onChange={(e) => setOdo(e.target.value)} />
    </Modal>
  )
}

function CompleteDialog({ trip, onClose, onDone }: { trip: any; onClose: () => void; onDone: () => void }) {
  const [odo, setOdo] = useState('')
  const [date, setDate] = useState(todayIst())
  const [markAll, setMarkAll] = useState(false)
  const pending = trip.lrs.filter((l: any) => l.status === 'booked' || l.status === 'in_transit')
  const m = useMutation({
    mutationFn: () => transportApi.completeTrip(trip.id, { endDate: date, endOdometer: odo ? Number(odo) : undefined, markLrsDelivered: markAll }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Finish trip" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={m.isPending || (pending.length > 0 && !markAll)} onClick={() => m.mutate()}>Finish</button>
      </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">End date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="label">Truck meter reading at end (km)</label><input type="number" min="0" className="input" value={odo} onChange={(e) => setOdo(e.target.value)} placeholder={trip.startOdometer != null ? `≥ ${trip.startOdometer}` : ''} /></div>
        </div>
        {pending.length > 0 && (
          <label className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={markAll} onChange={(e) => setMarkAll(e.target.checked)} />
            <span>All {pending.length} load{pending.length > 1 ? 's are' : ' is'} delivered
              <span className="block text-xs text-amber-700">{pending.map((l: any) => l.lrNo).join(', ')}</span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  )
}

function CancelTripDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const m = useMutation({ mutationFn: () => transportApi.cancelTrip(id, reason), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  return (
    <Modal title="Cancel trip" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Keep trip</button>
        <button type="button" className="btn-danger flex-1 justify-center" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Cancel trip</button>
      </>}>
      <p className="text-sm text-gray-600 mb-3">LRs on this trip go back to <em>booked / awaiting truck</em>.</p>
      <label className="label">Reason *</label>
      <textarea className="input h-20 resize-none" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  )
}

function AddLrDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [ids, setIds] = useState<string[]>([])
  const { data } = useQuery({ queryKey: ['transport-lrs', 'unassigned'], queryFn: () => transportApi.listLrs({ unassigned: 'true', limit: 100 }) })
  const lrs: any[] = data?.data ?? []
  const m = useMutation({ mutationFn: () => transportApi.addTripLrs(tripId, ids), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  return (
    <Modal title="Add loads to this trip" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={ids.length === 0 || m.isPending} onClick={() => m.mutate()}>Add {ids.length || ''}</button>
      </>}>
      {lrs.length === 0 ? <p className="text-sm text-gray-500">No LRs are waiting for a truck.</p> : (
        <div className="divide-y divide-gray-50 border border-gray-200 rounded-lg">
          {lrs.map((l) => (
            <label key={l.id} className="flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" className="mt-1" checked={ids.includes(l.id)}
                onChange={(e) => setIds((p) => e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id))} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900"><span className="font-mono text-xs text-gray-500 mr-2">{l.lrNo}</span>{l.fromCity} → {l.toCity}</div>
                <div className="text-xs text-gray-500 truncate">{l.consignorName} · {num(l.chargedWeightKg)} kg</div>
              </div>
              <span className="text-sm font-medium">{inr(l.totalAmount)}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  )
}

function ExpenseDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ category: 'diesel', amount: '', litres: '', rate: '', date: todayIst(), paidBy: 'driver', mode: 'cash', vendor: '', location: '', odometer: '', notes: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const isFuel = f.category === 'diesel'
  const onAccount = f.paidBy === 'vendor_credit'
  const computed = isFuel && f.litres && f.rate ? Math.round(Number(f.litres) * Number(f.rate) * 100) / 100 : 0
  const m = useMutation({
    mutationFn: () => transportApi.createExpense({
      tripId, category: f.category, amount: f.amount ? Number(f.amount) : undefined,
      litres: isFuel && f.litres ? Number(f.litres) : undefined, ratePerLitre: isFuel && f.rate ? Number(f.rate) : undefined,
      expenseDate: f.date, paidBy: f.paidBy, paymentMode: onAccount ? 'credit' : f.mode,
      vendorName: onAccount ? f.vendor.trim() : undefined, location: f.location || undefined,
      odometer: f.odometer ? Number(f.odometer) : undefined, notes: f.notes || undefined,
    }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Add diesel / trip cost" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={m.isPending || !(Number(f.amount) > 0 || computed > 0) || (onAccount && !f.vendor.trim())} onClick={() => m.mutate()}>Save</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Category</label>
          <select className="input" value={f.category} onChange={set('category')}>{TRIP_EXPENSES.map((c) => <option key={c} value={c}>{EXPENSE_LABEL[c]}</option>)}</select></div>
        <div><label className="label">Date</label><input type="date" className="input" value={f.date} onChange={set('date')} /></div>
        {isFuel && (
          <>
            <div><label className="label">Litres</label><input type="number" min="0" className="input" value={f.litres} onChange={set('litres')} /></div>
            <div><label className="label">Rate / litre (₹)</label><input type="number" min="0" className="input" value={f.rate} onChange={set('rate')} /></div>
          </>
        )}
        <div><label className="label">Amount (₹){isFuel && computed > 0 ? ` — ${inr(computed, 2)} from litres` : ''}</label>
          <input type="number" min="0" className="input" value={f.amount} onChange={set('amount')} placeholder={computed > 0 ? String(computed) : ''} /></div>
        <div className="col-span-2"><label className="label">Who paid?</label>
          <select className="input" value={f.paidBy} onChange={(e) => setF((p) => ({ ...p, paidBy: e.target.value, mode: e.target.value === 'company' && p.mode === 'cash' ? 'upi' : p.mode }))}>
            <option value="driver">Driver paid (from advance / own pocket)</option>
            <option value="company">I paid directly (UPI, FASTag, bank…)</option>
            <option value="vendor_credit">On account — pump / shop will be paid later</option>
          </select></div>
        {onAccount ? (
          <div className="col-span-2"><label className="label">Pump / shop name *</label>
            <input className="input" value={f.vendor} onChange={set('vendor')} placeholder="e.g. Sharma Petrol Pump" /></div>
        ) : (
          <div><label className="label">Payment mode</label>
            <select className="input" value={f.mode} onChange={set('mode')}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option>
              <option value="fastag">FASTag</option><option value="bank_transfer">Bank transfer</option>
            </select></div>
        )}
        <div><label className="label">Location</label><input className="input" value={f.location} onChange={set('location')} /></div>
        <div><label className="label">Odometer (km)</label><input type="number" min="0" className="input" value={f.odometer} onChange={set('odometer')} /></div>
        <div className="col-span-2"><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
      </div>
    </Modal>
  )
}
