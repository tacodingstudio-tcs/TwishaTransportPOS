// E-way bill panel for an LR: generate / update vehicle / extend / cancel through the GSP, with the
// audit trail of every call. Works in "test mode" (mock provider) until live credentials are set.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { FileCheck2, AlertTriangle, History } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { Modal } from '@/components/transport/Modal'
import { fmtDateTime, daysUntil } from '@/components/transport/format'

type Dlg = null | 'generate' | 'vehicle' | 'extend' | 'cancel'

const STATE_CODES: Array<[string, string]> = [
  ['24', 'Gujarat'], ['27', 'Maharashtra'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['29', 'Karnataka'],
  ['33', 'Tamil Nadu'], ['36', 'Telangana'], ['19', 'West Bengal'], ['23', 'Madhya Pradesh'], ['06', 'Haryana'], ['03', 'Punjab'],
  ['10', 'Bihar'], ['21', 'Odisha'], ['32', 'Kerala'], ['37', 'Andhra Pradesh'], ['22', 'Chhattisgarh'], ['20', 'Jharkhand'],
  ['30', 'Goa'], ['05', 'Uttarakhand'], ['02', 'Himachal Pradesh'], ['18', 'Assam'], ['04', 'Chandigarh'],
]

export function EwayCard({ lr, readOnly, canManage }: { lr: any; readOnly: boolean; canManage: boolean }) {
  const [dlg, setDlg] = useState<Dlg>(null)
  const [showLog, setShowLog] = useState(false)
  const qc = useQueryClient()
  const { data: status } = useQuery({ queryKey: ['eway-status'], queryFn: transportApi.ewayStatus, staleTime: 60_000 })
  const { data: events } = useQuery({
    queryKey: ['eway-events', lr.id], queryFn: () => transportApi.ewayEvents(lr.id), enabled: showLog,
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['transport-lr', lr.id] })
    qc.invalidateQueries({ queryKey: ['eway-events', lr.id] })
    qc.invalidateQueries({ queryKey: ['transport-lrs'] })
  }
  const done = (m: string) => { refresh(); setDlg(null); toast.success(m) }

  const open = lr.status === 'booked' || lr.status === 'in_transit'
  const active = lr.ewayStatus === 'active' && !!lr.ewayBillNo
  const manual = !!lr.ewayBillNo && !active           // number typed in by hand, not issued through us
  const days = lr.ewayValidUpto ? daysUntil(lr.ewayValidUpto) : null

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><FileCheck2 className="w-4 h-4 text-gray-400" /> E-way bill</h2>
        {status && !status.live && <span className="badge bg-amber-50 text-amber-700" title="No GSP credentials are set on the server — numbers are simulated">Test mode</span>}
        {status?.live && status.sandbox && <span className="badge bg-blue-50 text-blue-700">Sandbox</span>}
      </div>

      {lr.ewayBillNo ? (
        <div className="space-y-1">
          <div className="font-mono text-lg text-gray-900">{lr.ewayBillNo}</div>
          {lr.ewayValidUpto && (
            <div className={`text-xs ${days != null && days < 0 ? 'text-red-600' : days != null && days <= 1 ? 'text-amber-600' : 'text-gray-500'}`}>
              Valid till {fmtDateTime(lr.ewayValidUpto)}{days != null && days < 0 ? ' — expired' : ''}
            </div>
          )}
          {manual && <div className="text-xs text-gray-400">Number was entered by hand. Part-B / extension need a bill generated here.</div>}
        </div>
      ) : (
        <div className="text-sm text-gray-500">
          {lr.ewayStatus === 'cancelled' ? 'The previous e-way bill was cancelled. You can generate a new one.' : 'No e-way bill yet.'}
          {Number(lr.declaredValue) > 50000 && open && (
            <span className="flex items-start gap-1.5 text-amber-700 mt-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              Goods value is above ₹50,000 — an e-way bill is needed before the truck moves.
            </span>
          )}
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap gap-2 mt-4">
          {!lr.ewayBillNo && open && <button type="button" className="btn-primary" onClick={() => setDlg('generate')}>Generate e-way bill</button>}
          {active && open && <button type="button" className="btn-ghost border border-gray-200" onClick={() => setDlg('vehicle')}>Change truck (Part-B)</button>}
          {active && open && <button type="button" className="btn-ghost border border-gray-200" onClick={() => setDlg('extend')}>Extend validity</button>}
          {active && canManage && <button type="button" className="btn-ghost text-red-600" onClick={() => setDlg('cancel')}>Cancel e-way bill</button>}
        </div>
      )}

      <button type="button" className="mt-4 text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1" onClick={() => setShowLog((v) => !v)}>
        <History className="w-3 h-3" /> {showLog ? 'Hide' : 'Show'} activity
      </button>
      {showLog && (
        <ul className="mt-2 space-y-1 text-xs">
          {(events ?? []).length === 0 && <li className="text-gray-400">No activity yet.</li>}
          {(events ?? []).map((e: any) => (
            <li key={e.id} className="flex gap-2">
              <span className={e.ok ? 'text-green-600' : 'text-red-600'}>{e.ok ? '✓' : '✗'}</span>
              <span className="text-gray-700 capitalize">{e.action}</span>
              <span className="text-gray-400">{fmtDateTime(e.createdAt)}</span>
              {!e.ok && <span className="text-red-600 truncate" title={e.message}>{e.message}</span>}
            </li>
          ))}
        </ul>
      )}

      {dlg === 'generate' && <GenerateDialog lr={lr} onClose={() => setDlg(null)} onDone={(n) => done(`E-way bill ${n} generated`)} />}
      {dlg === 'vehicle' && <VehicleDialog lr={lr} onClose={() => setDlg(null)} onDone={() => done('Truck updated on the e-way bill')} />}
      {dlg === 'extend' && <ExtendDialog lr={lr} onClose={() => setDlg(null)} onDone={() => done('Validity extended')} />}
      {dlg === 'cancel' && <CancelDialog lr={lr} onClose={() => setDlg(null)} onDone={() => done('E-way bill cancelled')} />}
    </section>
  )
}

function Footer({ onClose, label, disabled, pending, onGo }: { onClose: () => void; label: string; disabled?: boolean; pending: boolean; onGo: () => void }) {
  return (
    <>
      <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Close</button>
      <button type="button" className="btn-primary flex-1 justify-center" disabled={disabled || pending} onClick={onGo}>{pending ? 'Please wait…' : label}</button>
    </>
  )
}

function GenerateDialog({ lr, onClose, onDone }: { lr: any; onClose: () => void; onDone: (no: string) => void }) {
  const [f, setF] = useState({
    hsnCode: lr.hsnCode ?? '', fromPincode: lr.fromPincode ?? '', toPincode: lr.toPincode ?? '',
    fromStateCode: '', toStateCode: '',
    distanceKm: lr.distanceKm ?? '', supplyDocNo: lr.supplyDocNo ?? lr.invoiceRefs ?? '', supplyDocDate: '',
    goodsGstRate: '0',
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => transportApi.ewayGenerate(lr.id, {
      hsnCode: f.hsnCode || undefined, fromPincode: f.fromPincode || undefined, toPincode: f.toPincode || undefined,
      fromStateCode: f.fromStateCode || undefined, toStateCode: f.toStateCode || undefined,
      distanceKm: f.distanceKm !== '' ? Number(f.distanceKm) : undefined,
      supplyDocNo: f.supplyDocNo || undefined, supplyDocDate: f.supplyDocDate || undefined,
      goodsGstRate: Number(f.goodsGstRate) || 0,
    }),
    onSuccess: (r) => onDone(r.ewayBillNo), onError: (e) => toast.error(apiError(e)),
  })
  const stateSelect = (k: 'fromStateCode' | 'toStateCode') => (
    <select className="input" value={f[k]} onChange={set(k)}>
      <option value="">Choose state…</option>
      {STATE_CODES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
    </select>
  )
  return (
    <Modal title="Generate e-way bill" width="lg" onClose={onClose}
      footer={<Footer onClose={onClose} label="Generate" pending={m.isPending} onGo={() => m.mutate()} />}>
      <p className="text-xs text-gray-500 mb-4">
        {lr.consignorName} ({lr.fromCity}) → {lr.consigneeName} ({lr.toCity}) · value ₹{Number(lr.declaredValue).toLocaleString('en-IN')}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">HSN code of goods *</label><input className="input" inputMode="numeric" value={f.hsnCode} onChange={set('hsnCode')} placeholder="e.g. 5205" /></div>
        <div><label className="label">Goods GST rate %</label><input className="input" type="number" min="0" max="28" value={f.goodsGstRate} onChange={set('goodsGstRate')} /></div>
        <div><label className="label">Pickup pincode *</label><input className="input" inputMode="numeric" maxLength={6} value={f.fromPincode} onChange={set('fromPincode')} /></div>
        <div><label className="label">Delivery pincode *</label><input className="input" inputMode="numeric" maxLength={6} value={f.toPincode} onChange={set('toPincode')} /></div>
        {!lr.consignorGstin && <div><label className="label">Sender state *</label>{stateSelect('fromStateCode')}</div>}
        {!lr.consigneeGstin && <div><label className="label">Receiver state *</label>{stateSelect('toStateCode')}</div>}
        <div><label className="label">Distance (km)</label><input className="input" type="number" min="0" value={f.distanceKm} onChange={set('distanceKm')} placeholder="0 = portal calculates" /></div>
        <div />
        <div><label className="label">Sender's bill / invoice no</label><input className="input" maxLength={16} value={f.supplyDocNo} onChange={set('supplyDocNo')} /></div>
        <div><label className="label">Sender's bill date</label><input className="input" type="date" value={f.supplyDocDate} onChange={set('supplyDocDate')} /></div>
      </div>
      <p className="text-xs text-gray-400 mt-3">What you enter here is saved on the load, so it is not asked again. The truck number comes from the load's trip.</p>
    </Modal>
  )
}

function VehicleDialog({ lr, onClose, onDone }: { lr: any; onClose: () => void; onDone: () => void }) {
  const [vehicleNo, setVehicleNo] = useState('')
  const [reason, setReason] = useState('breakdown')
  const [remark, setRemark] = useState('')
  const m = useMutation({
    mutationFn: () => transportApi.ewayVehicle(lr.id, { vehicleNo: vehicleNo.toUpperCase().replace(/[^A-Z0-9]/g, ''), reason, remark: remark || 'Vehicle changed' }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Change truck on the e-way bill" width="md" onClose={onClose}
      footer={<Footer onClose={onClose} label="Update" disabled={vehicleNo.trim().length < 6} pending={m.isPending} onGo={() => m.mutate()} />}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">Currently {lr.vehicleNo || 'no truck'} on this load.</p>
        <div><label className="label">New truck number *</label><input className="input uppercase" value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="GJ01AB1234" /></div>
        <div>
          <label className="label">Reason</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="first_time">First assignment</option><option value="breakdown">Breakdown</option>
            <option value="transhipment">Transhipment</option><option value="others">Other</option>
          </select>
        </div>
        <div><label className="label">Remark</label><input className="input" maxLength={100} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="e.g. tyre burst at Vadodara" /></div>
      </div>
    </Modal>
  )
}

function ExtendDialog({ lr, onClose, onDone }: { lr: any; onClose: () => void; onDone: () => void }) {
  const [km, setKm] = useState('')
  const [reason, setReason] = useState('Others')
  const [remark, setRemark] = useState('')
  const m = useMutation({
    mutationFn: () => transportApi.ewayExtend(lr.id, { remainingKm: Number(km), reason, remark }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Extend e-way bill validity" width="md" onClose={onClose}
      footer={<Footer onClose={onClose} label="Extend" disabled={!(Number(km) > 0) || remark.trim().length < 3} pending={m.isPending} onGo={() => m.mutate()} />}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">The portal allows extension only from 8 hours before to 8 hours after expiry.</p>
        <div><label className="label">Remaining distance (km) *</label><input className="input" type="number" min="1" value={km} onChange={(e) => setKm(e.target.value)} /></div>
        <div>
          <label className="label">Reason</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {['Natural Calamity', 'Law and Order Situation', 'Transshipment', 'Accident', 'Others'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div><label className="label">Remark *</label><input className="input" maxLength={100} value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
      </div>
    </Modal>
  )
}

function CancelDialog({ lr, onClose, onDone }: { lr: any; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('data_entry_mistake')
  const [remark, setRemark] = useState('')
  const m = useMutation({
    mutationFn: () => transportApi.ewayCancel(lr.id, { reason, remark }),
    onSuccess: onDone, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Cancel e-way bill" width="md" onClose={onClose}
      footer={<Footer onClose={onClose} label="Cancel e-way bill" disabled={remark.trim().length < 3} pending={m.isPending} onGo={() => m.mutate()} />}>
      <div className="space-y-3">
        <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">The portal only accepts cancellation within 24 hours of generation and before the goods are verified in transit.</p>
        <div>
          <label className="label">Reason</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="data_entry_mistake">Data entry mistake</option><option value="duplicate">Duplicate</option>
            <option value="order_cancelled">Order cancelled</option><option value="others">Other</option>
          </select>
        </div>
        <div><label className="label">Remark *</label><input className="input" maxLength={100} value={remark} onChange={(e) => setRemark(e.target.value)} /></div>
      </div>
    </Modal>
  )
}
