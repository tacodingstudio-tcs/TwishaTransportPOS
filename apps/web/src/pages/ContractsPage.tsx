import { useState } from 'react'
import { useContracts, useCreateContract, useUpdateContract, useGenerateContractInvoice } from '@/hooks/useApi'
import { useParties } from '@/hooks/useApi'
import { format, parseISO } from 'date-fns'
import { Plus, FileText, Pause, Play, Trash2, RefreshCw, X } from 'lucide-react'
import { contractApi } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

const CYCLES = ['weekly','monthly','quarterly','half_yearly','yearly'] as const
const STATUS_COLORS: Record<string,string> = {
  active:    'bg-green-100 text-green-700',
  paused:    'bg-yellow-100 text-yellow-700',
  expired:   'bg-gray-100 text-gray-500',
  cancelled: 'bg-red-100 text-red-600',
}

function ContractForm({ onClose, initial }: { onClose: () => void; initial?: any }) {
  const qc          = useQueryClient()
  const createMut   = useCreateContract()
  const updateMut   = useUpdateContract()
  const { data: partiesData } = useParties({ type: 'customer', limit: 200 })
  const parties = (partiesData as any)?.data ?? []

  const [form, setForm] = useState({
    partyId:      initial?.partyId      ?? '',
    title:        initial?.title        ?? '',
    startDate:    initial?.startDate?.split('T')[0] ?? new Date().toISOString().split('T')[0],
    endDate:      initial?.endDate?.split('T')[0]   ?? '',
    billingCycle: initial?.billingCycle ?? 'monthly',
    billingDay:   initial?.billingDay   ?? 1,
    amount:       initial?.amount       ?? '',
    gstRate:      initial?.gstRate      ?? 0,
    autoInvoice:  initial?.autoInvoice  ?? true,
    notes:        initial?.notes        ?? '',
    terms:        initial?.terms        ?? '',
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const payload = { ...form, amount: Number(form.amount), gstRate: Number(form.gstRate), billingDay: Number(form.billingDay) }
    if (initial?.id) {
      await updateMut.mutateAsync({ id: initial.id, ...payload })
    } else {
      await createMut.mutateAsync(payload)
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-lg">{initial ? 'Edit Contract' : 'New Contract'}</h2>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Party / Customer *</label>
            <select value={form.partyId} onChange={e => setForm(f=>({...f,partyId:e.target.value}))} required
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">Select party…</option>
              {parties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contract Title *</label>
            <input type="text" value={form.title} onChange={e => setForm(f=>({...f,title:e.target.value}))} required
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Monthly AMC — CCTV Maintenance" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date *</label>
              <input type="date" value={form.startDate} onChange={e => setForm(f=>({...f,startDate:e.target.value}))} required
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
              <input type="date" value={form.endDate} onChange={e => setForm(f=>({...f,endDate:e.target.value}))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing Cycle *</label>
              <select value={form.billingCycle} onChange={e => setForm(f=>({...f,billingCycle:e.target.value}))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {CYCLES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Billing Day</label>
              <input type="number" min={1} max={31} value={form.billingDay}
                onChange={e => setForm(f=>({...f,billingDay:Number(e.target.value)}))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount (excl. GST) *</label>
              <input type="number" min={0} step="0.01" value={form.amount}
                onChange={e => setForm(f=>({...f,amount:e.target.value}))} required
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">GST Rate %</label>
              <select value={form.gstRate} onChange={e => setForm(f=>({...f,gstRate:Number(e.target.value)}))}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {[0,5,12,18,28].map(r => <option key={r} value={r}>{r}%</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="autoInvoice" checked={form.autoInvoice}
              onChange={e => setForm(f=>({...f,autoInvoice:e.target.checked}))}
              className="rounded" />
            <label htmlFor="autoInvoice" className="text-sm text-gray-700">Auto-generate invoice on billing date</label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f=>({...f,notes:e.target.value}))} rows={2}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Internal notes…" />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={createMut.isPending || updateMut.isPending}
              className="flex-1 bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {createMut.isPending || updateMut.isPending ? 'Saving…' : initial ? 'Update' : 'Create Contract'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function ContractsPage() {
  const [showForm, setShowForm]   = useState(false)
  const [editItem, setEditItem]   = useState<any>(null)
  const [statusFilter, setStatusFilter] = useState('active')

  const qc       = useQueryClient()
  const { data, isLoading } = useContracts({ status: statusFilter || undefined })
  const genMut   = useGenerateContractInvoice()
  const contracts = (data as any) ?? []

  async function toggleStatus(c: any) {
    if (c.status === 'active') {
      await contractApi.pause(c.id)
    } else if (c.status === 'paused') {
      await contractApi.resume(c.id)
    }
    qc.invalidateQueries({ queryKey: ['contracts'] })
    toast.success(`Contract ${c.status === 'active' ? 'paused' : 'resumed'}`)
  }

  async function cancelContract(id: string) {
    await contractApi.cancel(id)
    qc.invalidateQueries({ queryKey: ['contracts'] })
    toast.success('Contract cancelled')
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contracts & Recurring Billing</h1>
          <p className="text-sm text-gray-500 mt-1">Auto-generate invoices on billing cycle</p>
        </div>
        <button type="button" onClick={() => { setEditItem(null); setShowForm(true) }}
          className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Contract
        </button>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {['', 'active', 'paused', 'expired', 'cancelled'].map(s => (
          <button key={s} type="button"
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
              statusFilter === s ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 text-gray-600 hover:border-gray-400'
            }`}>
            {s || 'All'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : contracts.length === 0 ? (
        <div className="text-center py-16 text-gray-400">No contracts found.</div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Contract</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Party</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Cycle</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Next Billing</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contracts.map((c: any) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{c.title}</div>
                    <div className="text-xs text-gray-400">{c.contractNo}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{c.party?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500 capitalize">{c.billingCycle.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatINR(c.amount)}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {c.nextBillingDate ? format(parseISO(c.nextBillingDate), 'dd MMM yyyy') : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[c.status] ?? 'bg-gray-100'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {c.status === 'active' && (
                        <button type="button" title="Generate invoice now"
                          onClick={() => genMut.mutate(c.id)}
                          disabled={genMut.isPending}
                          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded">
                          <FileText className="w-4 h-4" />
                        </button>
                      )}
                      {(c.status === 'active' || c.status === 'paused') && (
                        <button type="button" title={c.status === 'active' ? 'Pause' : 'Resume'}
                          onClick={() => toggleStatus(c)}
                          className="p-1.5 text-yellow-600 hover:bg-yellow-50 rounded">
                          {c.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </button>
                      )}
                      <button type="button" title="Edit"
                        onClick={() => { setEditItem(c); setShowForm(true) }}
                        className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      {c.status !== 'cancelled' && (
                        <button type="button" title="Cancel contract"
                          onClick={() => cancelContract(c.id)}
                          className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && <ContractForm onClose={() => { setShowForm(false); setEditItem(null) }} initial={editItem} />}
    </div>
  )
}
