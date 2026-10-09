// Lorry Receipt detail — consignment facts, freight, movement timeline and lifecycle actions.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Printer, Pencil, Truck, PackageCheck, ClipboardCheck, Banknote, Ban, Unlink, ReceiptText, Check } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusPill } from '@/components/transport/StatusPill'
import { Modal } from '@/components/transport/Modal'
import { inr, num, mt, fmtDate, fmtDateTime, FREIGHT_TYPE_LABEL, RATE_BASIS_LABEL, WEIGHT_BASIS_LABEL, daysUntil } from '@/components/transport/format'

type Dialog = null | 'assign' | 'deliver' | 'pod' | 'collect' | 'cancel'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{children || <span className="text-gray-300">—</span>}</dd>
    </div>
  )
}

function Step({ done, label, when }: { done: boolean; label: string; when?: string | null }) {
  return (
    <li className="flex items-start gap-3">
      <span className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-300'}`}>
        <Check className="w-3 h-3" />
      </span>
      <div>
        <div className={`text-sm ${done ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>{label}</div>
        {when && <div className="text-xs text-gray-500">{fmtDateTime(when)}</div>}
      </div>
    </li>
  )
}

export function LrDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const canManage = useAuthStore((s) => s.canManage())
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [dialog, setDialog] = useState<Dialog>(null)

  const { data: lr, isLoading } = useQuery({ queryKey: ['transport-lr', id], queryFn: () => transportApi.getLr(id!) })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transport-lr', id] })
    qc.invalidateQueries({ queryKey: ['transport-lrs'] })
    qc.invalidateQueries({ queryKey: ['transport-dashboard'] })
    qc.invalidateQueries({ queryKey: ['transport-trips'] })
  }
  const done = (msg: string) => { refresh(); setDialog(null); toast.success(msg) }
  const fail = (e: unknown) => toast.error(apiError(e))

  const unassign = useMutation({ mutationFn: () => transportApi.unassignLr(id!), onSuccess: () => done('Removed from trip'), onError: fail })

  if (isLoading || !lr) return <div className="p-8 text-center text-gray-400">{isLoading ? 'Loading…' : 'LR not found'}</div>

  const open = lr.status === 'booked' || lr.status === 'in_transit'
  const balance = Number(lr.totalAmount) - Number(lr.advancePaid)
  const toPayDue = lr.freightType === 'to_pay' ? balance - Number(lr.toPayCollected) : 0
  const ewayDays = lr.ewayValidUpto ? daysUntil(lr.ewayValidUpto) : null
  const billLive = lr.invoiceId && lr.invoiceStatus !== 'cancelled'

  return (
    <div>
      <PageHeader
        title={lr.lrNo}
        subtitle={`${lr.fromCity} → ${lr.toCity} · ${fmtDate(lr.lrDate)}`}
        action={
          <div className="flex gap-2 flex-wrap justify-end">
            <StatusPill kind="lr" status={lr.status} />
            <button type="button" className="btn-ghost" onClick={() => window.open(`/transport/lrs/${lr.id}/print`, '_blank')}>
              <Printer className="w-4 h-4" /> Print
            </button>
            {!readOnly && (lr.status === 'booked' || lr.status === 'in_transit' || lr.status === 'delivered' || lr.status === 'pod_received') && !billLive && (
              <button type="button" className="btn-ghost" onClick={() => navigate(`/transport/lrs/${lr.id}/edit`)}>
                <Pencil className="w-4 h-4" /> Edit
              </button>
            )}
          </div>
        }
      />

      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">

          {/* Actions */}
          {!readOnly && lr.status !== 'cancelled' && (
            <div className="card p-4 flex flex-wrap gap-2">
              {open && (
                <button type="button" className="btn-primary" onClick={() => setDialog('deliver')}>
                  <PackageCheck className="w-4 h-4" /> Mark delivered
                </button>
              )}
              {open && !lr.tripId && (
                <button type="button" className="btn-ghost border border-gray-200" onClick={() => setDialog('assign')}>
                  <Truck className="w-4 h-4" /> Put on a truck trip
                </button>
              )}
              {open && lr.tripId && (
                <button type="button" className="btn-ghost border border-gray-200" onClick={() => unassign.mutate()} disabled={unassign.isPending}>
                  <Unlink className="w-4 h-4" /> Take off the trip
                </button>
              )}
              {lr.status === 'delivered' && (
                <button type="button" className="btn-primary" onClick={() => setDialog('pod')}>
                  <ClipboardCheck className="w-4 h-4" /> Signed copy received
                </button>
              )}
              {toPayDue > 0 && (lr.status !== 'booked') && (
                <button type="button" className="btn-ghost border border-gray-200" onClick={() => setDialog('collect')}>
                  <Banknote className="w-4 h-4" /> Money from receiver ({inr(toPayDue)})
                </button>
              )}
              {billLive && lr.invoiceId && (
                <Link to={`/invoices/${lr.invoiceId}`} className="btn-ghost border border-gray-200">
                  <ReceiptText className="w-4 h-4" /> See bill {lr.invoiceNo}
                </Link>
              )}
              {!billLive && lr.status !== 'booked' && lr.status !== 'in_transit' && lr.freightType !== 'to_pay' && (
                <Link to={`/transport/billing?partyId=${lr.consignorId ?? ''}&lr=${lr.id}`} className="btn-primary">
                  <ReceiptText className="w-4 h-4" /> Make bill
                </Link>
              )}
              {canManage && !billLive && (
                <button type="button" className="btn-ghost text-red-600 ml-auto" onClick={() => setDialog('cancel')}>
                  <Ban className="w-4 h-4" /> Cancel this load
                </button>
              )}
            </div>
          )}

          {/* Parties */}
          <section className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              { title: 'Sender', name: lr.consignorName, gstin: lr.consignorGstin, phone: lr.consignorPhone, address: lr.consignorAddress, partyId: lr.consignorId },
              { title: 'Receiver', name: lr.consigneeName, gstin: lr.consigneeGstin, phone: lr.consigneePhone, address: lr.consigneeAddress, partyId: lr.consigneeId },
            ].map((p) => (
              <div key={p.title}>
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{p.title}</div>
                <div className="text-sm font-semibold text-gray-900">
                  {p.partyId ? <Link to={`/parties/${p.partyId}`} className="hover:text-primary-600">{p.name}</Link> : p.name}
                </div>
                {p.address && <div className="text-sm text-gray-600 mt-0.5">{p.address}</div>}
                <div className="text-xs text-gray-500 mt-1">{[p.gstin && `GSTIN ${p.gstin}`, p.phone].filter(Boolean).join(' · ')}</div>
              </div>
            ))}
          </section>

          {/* Consignment */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Goods</h2>
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="col-span-2 md:col-span-4"><Field label="Goods">{lr.goodsDescription}</Field></div>
              <Field label="Packages">{lr.packages ? `${num(lr.packages)} ${lr.packageType ?? ''}` : ''}</Field>
              <Field label="Quantity loaded">{mt(lr.actualWeightKg)} MT</Field>
              <Field label="Quantity received">
                {lr.unloadWeightKg != null ? (
                  <>
                    {mt(lr.unloadWeightKg)} MT
                    {Number(lr.actualWeightKg) !== Number(lr.unloadWeightKg) && (
                      <span className={`block text-xs ${Number(lr.actualWeightKg) > Number(lr.unloadWeightKg) ? 'text-amber-600' : 'text-blue-600'}`}>
                        {Number(lr.actualWeightKg) > Number(lr.unloadWeightKg) ? 'short by' : 'extra'} {mt(Math.abs(Number(lr.actualWeightKg) - Number(lr.unloadWeightKg)))} MT
                      </span>
                    )}
                  </>
                ) : ''}
              </Field>
              <Field label="Charged on">
                {mt(lr.chargedWeightKg)} MT
                <span className="block text-xs text-gray-400">{WEIGHT_BASIS_LABEL[lr.weightBasis] ?? ''}</span>
              </Field>
              <Field label="Gate pass no">{lr.gatePassNo}</Field>
              <Field label="Shipment / DO no">{lr.shipmentNo}</Field>
              <Field label="Value of goods">{lr.declaredValue > 0 ? inr(lr.declaredValue) : ''}</Field>
              <Field label="Sender's bill no">{lr.invoiceRefs}</Field>
              <Field label="E-way bill">
                {lr.ewayBillNo && (
                  <>
                    <span className="font-mono">{lr.ewayBillNo}</span>
                    {lr.ewayValidUpto && (
                      <span className={`block text-xs ${ewayDays != null && ewayDays < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        valid till {fmtDateTime(lr.ewayValidUpto)}{ewayDays != null && ewayDays < 0 ? ' (expired)' : ''}
                      </span>
                    )}
                  </>
                )}
              </Field>
              <Field label="Remarks">{lr.remarks}</Field>
            </dl>
          </section>

          {/* Freight */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">
              Freight (bhada) <span className="ml-2 badge bg-gray-100 text-gray-600">{FREIGHT_TYPE_LABEL[lr.freightType]}</span>
            </h2>
            <dl className="text-sm space-y-2 max-w-md">
              <div className="flex justify-between">
                <dt className="text-gray-500">Freight ({RATE_BASIS_LABEL[lr.rateBasis]}{lr.rateBasis !== 'fixed' ? ` @ ${inr(lr.rate)}` : ''})</dt>
                <dd>{inr(lr.freightAmount, 2)}</dd>
              </div>
              {Number(lr.loadingCharges) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Loading</dt><dd>{inr(lr.loadingCharges, 2)}</dd></div>}
              {Number(lr.unloadingCharges) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Unloading</dt><dd>{inr(lr.unloadingCharges, 2)}</dd></div>}
              {Number(lr.detentionCharges) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Waiting charges</dt><dd>{inr(lr.detentionCharges, 2)}</dd></div>}
              {Number(lr.otherCharges) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Other</dt><dd>{inr(lr.otherCharges, 2)}</dd></div>}
              <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold"><dt>Total (before GST)</dt><dd>{inr(lr.totalAmount, 2)}</dd></div>
              {Number(lr.advancePaid) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Advance received</dt><dd>− {inr(lr.advancePaid, 2)}</dd></div>}
              {lr.freightType === 'to_pay' && (
                <>
                  <div className="flex justify-between"><dt className="text-gray-500">Received from receiver</dt><dd>− {inr(lr.toPayCollected, 2)}</dd></div>
                  <div className={`flex justify-between font-semibold ${toPayDue > 0 ? 'text-amber-700' : 'text-green-700'}`}>
                    <dt>Receiver still to pay</dt><dd>{inr(toPayDue, 2)}</dd>
                  </div>
                </>
              )}
            </dl>
          </section>
        </div>

        {/* Right rail */}
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Where is this load?</h2>
            <dl className="grid grid-cols-2 gap-4 mb-5">
              <Field label="Truck trip">
                {lr.tripId && <Link to={`/transport/trips/${lr.tripId}`} className="text-primary-600 hover:underline">{lr.tripNo}</Link>}
              </Field>
              <Field label="Truck">{lr.vehicleNo}</Field>
              <Field label="Driver">{lr.driverName}</Field>
              <Field label="Received by">{lr.receivedBy}</Field>
            </dl>
            <ul className="space-y-4">
              <Step done label="Booked" when={lr.createdAt} />
              <Step done={!!lr.dispatchedAt} label="Truck left" when={lr.dispatchedAt} />
              <Step done={!!lr.deliveredAt} label="Delivered" when={lr.deliveredAt} />
              <Step done={!!lr.podReceivedAt} label="Signed copy back" when={lr.podReceivedAt} />
              <Step done={!!billLive} label={billLive ? `Bill made — ${lr.invoiceNo}` : 'Bill made'} />
            </ul>
            {lr.damageNotes && (
              <div className="mt-4 text-sm bg-red-50 border border-red-100 text-red-700 rounded-lg px-3 py-2">
                <strong>Damage / short quantity:</strong> {lr.damageNotes}
              </div>
            )}
            {lr.podNotes && <p className="mt-3 text-xs text-gray-500">Note: {lr.podNotes}</p>}
          </section>
        </div>
      </div>

      {dialog === 'assign'  && <AssignDialog lrId={lr.id} onClose={() => setDialog(null)} onDone={() => done('LR added to trip')} />}
      {dialog === 'deliver' && <DeliverDialog lr={lr} onClose={() => setDialog(null)} onDone={() => done('Marked delivered')} />}
      {dialog === 'pod'     && <PodDialog lrId={lr.id} onClose={() => setDialog(null)} onDone={() => done('POD recorded')} />}
      {dialog === 'collect' && <CollectDialog lr={lr} due={toPayDue} onClose={() => setDialog(null)} onDone={() => done('Collection recorded')} />}
      {dialog === 'cancel'  && <CancelDialog lrId={lr.id} onClose={() => setDialog(null)} onDone={() => done('LR cancelled')} />}
    </div>
  )
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function AssignDialog({ lrId, onClose, onDone }: { lrId: string; onClose: () => void; onDone: () => void }) {
  const [tripId, setTripId] = useState('')
  const { data } = useQuery({ queryKey: ['transport-trips-open'], queryFn: () => transportApi.listTrips({ status: 'planned,running', limit: 50 }) })
  const m = useMutation({ mutationFn: () => transportApi.assignLr(lrId, tripId), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  const trips: any[] = data?.data ?? []
  return (
    <Modal title="Put on a truck trip" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!tripId || m.isPending} onClick={() => m.mutate()}>Put on trip</button>
      </>}>
      {trips.length === 0 ? (
        <p className="text-sm text-gray-500">There are no planned or running trips. Create a trip first from the Trips page.</p>
      ) : (
        <div className="space-y-2">
          {trips.map((t) => (
            <label key={t.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${tripId === t.id ? 'border-primary-300 bg-primary-50' : 'border-gray-200 hover:bg-gray-50'}`}>
              <input type="radio" name="trip" checked={tripId === t.id} onChange={() => setTripId(t.id)} />
              <div className="flex-1">
                <div className="text-sm font-medium text-gray-900">{t.tripNo} · {t.fromCity} → {t.toCity}</div>
                <div className="text-xs text-gray-500">{t.vehicleNo} · {t.driverName ?? 'No driver'} · {t.lrCount} LR{t.lrCount === 1 ? '' : 's'}</div>
              </div>
              <StatusPill kind="trip" status={t.status} />
            </label>
          ))}
        </div>
      )}
    </Modal>
  )
}

function DeliverDialog({ lr, onClose, onDone }: { lr: any; onClose: () => void; onDone: () => void }) {
  const [receivedBy, setReceivedBy] = useState('')
  const [damage, setDamage] = useState('')
  const [collected, setCollected] = useState('')
  const [unload, setUnload] = useState(lr.unloadWeightKg != null ? String(Number(lr.unloadWeightKg) / 1000) : '')
  const due = Number(lr.totalAmount) - Number(lr.advancePaid) - Number(lr.toPayCollected)
  const m = useMutation({
    mutationFn: () => transportApi.deliverLr(lr.id, {
      receivedBy: receivedBy || undefined, damageNotes: damage || undefined,
      toPayCollected: collected ? Number(collected) : undefined,
      unloadWeightKg: unload !== '' ? Math.round(Number(unload) * 1000 * 1000) / 1000 : undefined,
    }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Goods delivered" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={m.isPending} onClick={() => m.mutate()}>Save</button>
      </>}>
      <div className="space-y-3">
        <div>
          <label className="label">Quantity received at destination (MT) <span className="text-gray-400 font-normal">— you loaded {mt(lr.actualWeightKg)} MT</span></label>
          <input type="number" min="0" step="any" className="input" value={unload} onChange={(e) => setUnload(e.target.value)} placeholder="optional" />
          {(lr.weightBasis === 'unload' || lr.weightBasis === 'lower') && (
            <p className="text-xs text-blue-700 mt-1">Freight on this load is charged on the {lr.weightBasis === 'unload' ? 'received' : 'smaller'} weight, so the amount will change.</p>
          )}
        </div>
        <div><label className="label">Who received it?</label><input className="input" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Name of person at the consignee" /></div>
        {lr.freightType === 'to_pay' && (
          <div>
            <label className="label">To-Pay collected now (₹) — balance {inr(due)}</label>
            <input type="number" min="0" className="input" value={collected} onChange={(e) => setCollected(e.target.value)} />
          </div>
        )}
        <div><label className="label">Any damage or shortage?</label><textarea className="input h-20 resize-none" value={damage} onChange={(e) => setDamage(e.target.value)} /></div>
      </div>
    </Modal>
  )
}

function PodDialog({ lrId, onClose, onDone }: { lrId: string; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState('')
  const m = useMutation({ mutationFn: () => transportApi.podLr(lrId, { podNotes: notes || undefined }), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  return (
    <Modal title="Signed copy received" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={m.isPending} onClick={() => m.mutate()}>Save</button>
      </>}>
      <label className="label">Note (optional)</label>
      <textarea className="input h-20 resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Signed & stamped copy received by courier" />
    </Modal>
  )
}

function CollectDialog({ lr, due, onClose, onDone }: { lr: any; due: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(due))
  const m = useMutation({ mutationFn: () => transportApi.collectLr(lr.id, Number(amount)), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  return (
    <Modal title="Money received from receiver" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!(Number(amount) > 0) || m.isPending} onClick={() => m.mutate()}>Record</button>
      </>}>
      <label className="label">Amount received (₹) — balance {inr(due)}</label>
      <input type="number" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
    </Modal>
  )
}

function CancelDialog({ lrId, onClose, onDone }: { lrId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const m = useMutation({ mutationFn: () => transportApi.cancelLr(lrId, reason), onSuccess: onDone, onError: (e) => toast.error(apiError(e)) })
  return (
    <Modal title="Cancel this load" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Keep it</button>
        <button type="button" className="btn-danger flex-1 justify-center" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Cancel load</button>
      </>}>
      <label className="label">Reason *</label>
      <textarea className="input h-20 resize-none" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this LR being cancelled?" />
    </Modal>
  )
}
