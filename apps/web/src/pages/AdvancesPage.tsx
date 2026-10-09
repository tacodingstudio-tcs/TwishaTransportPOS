import { useState } from 'react'
import { useAdvances, useRecordAdvance, useAllocateAdvance } from '@/hooks/useApi'
import { useParties } from '@/hooks/useApi'
import { format } from 'date-fns'
import { Plus, X, CreditCard, CheckCircle } from 'lucide-react'
import toast from 'react-hot-toast'

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

const PAYMENT_METHODS = ['cash','upi','neft','rtgs','cheque','card','other']

function RecordAdvanceModal({ onClose }: { onClose: () => void }) {
  const { data: partiesData } = useParties({ type: 'customer', limit: 200 })
  const parties = (partiesData as any)?.data ?? []
  const recordMut = useRecordAdvance()

  const [form, setForm] = useState({
    partyId: '', amount: '', method: 'cash', refNo: '', notes: '',
    paymentDate: new Date().toISOString().split('T')[0],
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    await recordMut.mutateAsync({
      partyId: form.partyId,
      amount: Number(form.amount),
      method: form.method,
      refNo: form.refNo || undefined,
      notes: form.notes || undefined,
      paymentDate: form.paymentDate,
    })
    toast.success('Advance recorded')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-lg">Record Advance Payment</h2>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer *</label>
            <select required value={form.partyId} onChange={e => setForm(f => ({ ...f, partyId: e.target.value }))}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select customer…</option>
              {parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
              <input type="number" min={1} step="0.01" required value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Payment Date *</label>
              <input type="date" required value={form.paymentDate}
                onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Method *</label>
              <select value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Ref / UTR No.</label>
              <input type="text" value={form.refNo}
                onChange={e => setForm(f => ({ ...f, refNo: e.target.value }))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Optional" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Optional notes…" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={recordMut.isPending}
              className="flex-1 bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {recordMut.isPending ? 'Saving…' : 'Record Advance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function AllocateModal({ advance, onClose }: { advance: any; onClose: () => void }) {
  const allocateMut = useAllocateAdvance()
  const [rows, setRows] = useState([{ invoiceId: '', amount: '' }])

  const remaining = Number(advance.unallocatedAmt)
  const totalEntered = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  function addRow() { setRows(r => [...r, { invoiceId: '', amount: '' }]) }
  function removeRow(i: number) { setRows(r => r.filter((_, idx) => idx !== i)) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const allocations = rows
      .filter(r => r.invoiceId && Number(r.amount) > 0)
      .map(r => ({ invoiceId: r.invoiceId, amount: Number(r.amount) }))
    if (!allocations.length) return toast.error('Add at least one allocation')
    if (totalEntered > remaining) return toast.error('Total exceeds unallocated amount')
    await allocateMut.mutateAsync({ id: advance.id, allocations })
    toast.success('Advance allocated')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h2 className="font-semibold text-lg">Allocate Advance</h2>
            <p className="text-sm text-gray-500">{advance.party?.name} · Available: {formatINR(remaining)}</p>
          </div>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <p className="text-xs text-gray-500">Enter invoice IDs to allocate against. You can find an invoice ID in its detail page URL.</p>
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input type="text" placeholder="Invoice ID (UUID)" value={row.invoiceId}
                  onChange={e => setRows(r => r.map((x, idx) => idx === i ? { ...x, invoiceId: e.target.value } : x))}
                  className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-xs" />
                <input type="number" placeholder="Amount" min={0.01} step="0.01" value={row.amount}
                  onChange={e => setRows(r => r.map((x, idx) => idx === i ? { ...x, amount: e.target.value } : x))}
                  className="w-28 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {rows.length > 1 && (
                  <button type="button" onClick={() => removeRow(i)} className="text-red-400 hover:text-red-600">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={addRow}
            className="text-sm text-blue-600 hover:underline">+ Add another invoice</button>
          <div className="flex items-center justify-between text-sm pt-1">
            <span className="text-gray-500">Total allocating:</span>
            <span className={`font-semibold ${totalEntered > remaining ? 'text-red-600' : 'text-gray-900'}`}>
              {formatINR(totalEntered)}
            </span>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={allocateMut.isPending}
              className="flex-1 bg-green-600 text-white rounded py-2 text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {allocateMut.isPending ? 'Saving…' : 'Allocate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function AdvancesPage() {
  const [showRecord, setShowRecord]   = useState(false)
  const [allocating, setAllocating]   = useState<any>(null)
  const { data, isLoading } = useAdvances()
  const advances = Array.isArray(data) ? data : []

  const totalUnallocated = advances.reduce((s: number, a: any) => s + Number(a.unallocatedAmt), 0)

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Advance Payments</h1>
          <p className="text-sm text-gray-500 mt-1">On-account receipts not yet linked to an invoice</p>
        </div>
        <button type="button" onClick={() => setShowRecord(true)}
          className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Record Advance
        </button>
      </div>

      {/* Summary card */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Advances</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{advances.length}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Unallocated</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{formatINR(totalUnallocated)}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Fully Allocated</p>
          <p className="text-2xl font-bold text-green-600 mt-1">
            {advances.filter((a: any) => Number(a.unallocatedAmt) <= 0).length}
          </p>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : advances.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          No advance payments recorded yet.
          <button type="button" onClick={() => setShowRecord(true)}
            className="text-blue-600 hover:underline ml-1">Record one</button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Method</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Allocated</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Remaining</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {advances.map((adv: any) => {
                const fullyAllocated = Number(adv.unallocatedAmt) <= 0
                return (
                  <tr key={adv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{adv.party?.name ?? '—'}</div>
                      {adv.refNo && <div className="text-xs text-gray-400">{adv.refNo}</div>}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {format(new Date(adv.paymentDate), 'dd MMM yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <span className="uppercase text-xs font-medium text-gray-600 bg-gray-100 px-2 py-0.5 rounded">
                        {adv.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{formatINR(Number(adv.amount))}</td>
                    <td className="px-4 py-3 text-right text-green-600">{formatINR(Number(adv.allocatedAmt))}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={fullyAllocated ? 'text-gray-400' : 'font-semibold text-orange-600'}>
                        {fullyAllocated ? '—' : formatINR(Number(adv.unallocatedAmt))}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {fullyAllocated ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle className="w-3.5 h-3.5" /> Done
                        </span>
                      ) : (
                        <button type="button" onClick={() => setAllocating(adv)}
                          className="inline-flex items-center gap-1 text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700">
                          <CreditCard className="w-3 h-3" /> Allocate
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showRecord && <RecordAdvanceModal onClose={() => setShowRecord(false)} />}
      {allocating && <AllocateModal advance={allocating} onClose={() => setAllocating(null)} />}
    </div>
  )
}
