// TDS the customer deducted from a freight bill — shown on the invoice page.
// "Record TDS" books it as a payment of method TDS against the bill, so the bill's outstanding
// amount, status, customer balance and aging all update; the customer's net payment then clears it.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Percent, CheckCircle2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { Modal } from './Modal'
import { inr, todayIst } from './format'

export function TdsCard({ invoiceId }: { invoiceId: string }) {
  const qc = useQueryClient()
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [cert, setCert] = useState('')
  const [date, setDate] = useState(todayIst())

  const { data: pos } = useQuery({ queryKey: ['transport-tds', invoiceId], queryFn: () => transportApi.tdsPosition(invoiceId) })

  const record = useMutation({
    mutationFn: () => transportApi.recordTds(invoiceId, {
      amount: amount ? Number(amount) : undefined, certificateNo: cert.trim() || undefined, paymentDate: date,
    }),
    onSuccess: () => {
      for (const k of ['transport-tds', 'invoice', 'invoices', 'payments', 'parties', 'party']) qc.invalidateQueries({ queryKey: [k] })
      qc.invalidateQueries({ queryKey: ['invoice', invoiceId] })
      toast.success('TDS recorded')
      setOpen(false)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  if (!pos || pos.tdsAmount <= 0) return null
  const done = pos.remaining <= 0

  return (
    <div className={`card p-4 flex items-center gap-4 ${done ? '' : 'border-amber-200 bg-amber-50/40'}`}>
      <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${done ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
        {done ? <CheckCircle2 className="w-5 h-5" /> : <Percent className="w-5 h-5" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">TDS (tax) kept by party: {inr(pos.tdsAmount, 2)}</div>
        <div className="text-xs text-gray-500">
          {done
            ? `All noted. Still to receive on this bill: ${inr(pos.outstanding, 2)}${pos.outstanding > 0 ? ' — the money the party will pay you.' : '.'}`
            : `${inr(pos.recorded, 2)} noted · ${inr(pos.remaining, 2)} still to note. Note it when the party pays you the rest of the money.`}
        </div>
      </div>
      {!done && !readOnly && !pos.cancelled && (
        <button type="button" className="btn-primary text-sm" onClick={() => { setAmount(String(pos.remaining)); setOpen(true) }}>Note TDS</button>
      )}

      {open && (
        <Modal title="Note TDS kept by party" width="md" onClose={() => setOpen(false)}
          footer={<>
            <button type="button" className="btn-ghost flex-1 justify-center" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn-primary flex-1 justify-center" disabled={record.isPending || !(Number(amount) > 0)} onClick={() => record.mutate()}>
              {record.isPending ? 'Saving…' : 'Save'}
            </button>
          </>}>
          <p className="text-sm text-gray-600 mb-3">
            The party kept this tax (TDS) and paid you the rest. This lowers what he still owes on the bill.
            You get this amount back later as income-tax credit — it is not cash.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">TDS amount (₹) — at most {inr(pos.remaining, 2)}</label>
              <input type="number" min="0" step="any" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div><label className="label">Date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><label className="label">TDS certificate no (optional)</label><input className="input" value={cert} onChange={(e) => setCert(e.target.value)} placeholder="optional" /></div>
          </div>
        </Modal>
      )}
    </div>
  )
}
