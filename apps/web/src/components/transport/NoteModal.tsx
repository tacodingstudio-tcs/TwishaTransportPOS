// Raise a credit note (take value off a bill) or a debit note (add a charge to it). Once a GST bill is out it is not edited —
// the correction is a separate document that carries the bill's GST and shows in the registers.
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Loader2, MinusCircle, PlusCircle } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Modal } from '@/components/transport/Modal'
import { inr, todayIst } from '@/components/transport/format'

const CREDIT_REASONS: Array<[string, string]> = [
  ['shortage', 'Shortage / transit loss'], ['rate_reduction', 'Rate reduction'], ['discount', 'Discount / rebate'], ['other', 'Other adjustment'],
]
const DEBIT_REASONS: Array<[string, string]> = [
  ['detention', 'Detention / demurrage'], ['extra_charges', 'Extra loading / unloading'], ['rate_increase', 'Rate increase'], ['other', 'Other charge'],
]
const GST_RATES = [0, 5, 12, 18, 28]
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface NoteBill {
  id: string; number: string; date: string; taxableAmt: number | string; grandTotal: number | string
  items?: Array<{ gstRate: number | string }>
}

export function NoteModal({ bill, onClose }: { bill: NoteBill; onClose: () => void }) {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role)
  const canCredit = role === 'owner' || role === 'manager'
  const [kind, setKind] = useState<'credit' | 'debit'>(canCredit ? 'credit' : 'debit')
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [gst, setGst] = useState(String(Number(bill.items?.[0]?.gstRate ?? 0)))
  const [note, setNote] = useState('')
  const [date, setDate] = useState(todayIst())

  const reasons = kind === 'credit' ? CREDIT_REASONS : DEBIT_REASONS
  const amt = Number(amount) || 0
  const tax = r2((amt * Number(gst)) / 100)
  const total = r2(amt + tax)
  const billDate = String(bill.date).slice(0, 10)

  const m = useMutation({
    mutationFn: () => transportApi.addBillNote(bill.id, { kind, amount: amt, reason, gstRate: Number(gst), note: note.trim() || undefined, date }),
    onSuccess: (r: any) => {
      toast.success(`${kind === 'credit' ? 'Credit' : 'Debit'} note ${r.note?.number ?? ''} raised`)
      for (const k of ['invoice', 'invoices', 'parties', 'party', 'aging', 'bill-notes', 'ca']) qc.invalidateQueries({ queryKey: [k] })
      onClose()
    },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <Modal title={`Credit / debit note — bill ${bill.number}`} width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!reason || amt <= 0 || date < billDate || m.isPending} onClick={() => m.mutate()}>
          {m.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Raise {kind} note
        </button>
      </>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={!canCredit} onClick={() => { setKind('credit'); setReason('') }}
            className={`flex items-start gap-2 rounded-xl border p-3 text-left disabled:opacity-40 ${kind === 'credit' ? 'border-primary-400 bg-primary-50 ring-1 ring-primary-200' : 'border-gray-200 hover:bg-gray-50'}`}>
            <MinusCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <span><span className="block text-sm font-semibold text-gray-900">Credit note</span><span className="block text-xs text-gray-500">Takes value off the bill — shortage, rate cut, discount</span></span>
          </button>
          <button type="button" onClick={() => { setKind('debit'); setReason('') }}
            className={`flex items-start gap-2 rounded-xl border p-3 text-left ${kind === 'debit' ? 'border-primary-400 bg-primary-50 ring-1 ring-primary-200' : 'border-gray-200 hover:bg-gray-50'}`}>
            <PlusCircle className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
            <span><span className="block text-sm font-semibold text-gray-900">Debit note</span><span className="block text-xs text-gray-500">Adds a charge — detention, extra loading, rate increase</span></span>
          </button>
        </div>
        {!canCredit && <p className="text-xs text-gray-500">Only the owner or a manager can issue a credit note.</p>}

        <div>
          <label className="label">Reason *</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose…</option>
            {reasons.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="label">Amount before GST (₹) *</label>
            <input type="number" min="0" step="0.01" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            {kind === 'credit' && <p className="text-[11px] text-gray-400 mt-1">Bill value before GST: {inr(Number(bill.taxableAmt), 2)}</p>}
          </div>
          <div>
            <label className="label">GST %</label>
            <select className="input" value={gst} onChange={(e) => setGst(e.target.value)}>
              {GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Date</label><input type="date" className="input" value={date} min={billDate} max={todayIst()} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="label">Note (optional)</label><input className="input" placeholder="e.g. 2.5 MT short at unloading" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>

        {amt > 0 && (
          <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">Amount</span><span>{inr(amt, 2)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">GST {gst}%</span><span>{inr(tax, 2)}</span></div>
            <div className="flex justify-between font-semibold"><span>Note total</span><span>{inr(total, 2)}</span></div>
            <p className="text-xs text-gray-500 pt-1">
              {kind === 'credit'
                ? `The customer will owe about ${inr(total, 2)} less. It is set against what is still unpaid on this bill; if the bill is already paid it stays as their credit.`
                : `The customer will owe about ${inr(total, 2)} more, as a separate bill-like entry they can pay.`}
            </p>
          </div>
        )}
        <p className="text-[11px] text-gray-400">TDS is not recalculated. If the customer deducts TDS on the new value, record it from the original bill.</p>
      </div>
    </Modal>
  )
}
