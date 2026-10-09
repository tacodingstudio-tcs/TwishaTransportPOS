import { useState } from 'react'
import { useGRNs, useCreateGRN, usePurchaseOrders } from '@/hooks/useApi'
import { format } from 'date-fns'
import { Plus, X, CheckCircle, Package } from 'lucide-react'
import { grnApi } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

const STATUS_COLORS: Record<string, string> = {
  posted:    'bg-green-100 text-green-700',
  draft:     'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
}

interface GrnItem {
  description: string
  receivedQty: string
  unit: string
  rate: string
  batchNo: string
  expiryDate: string
  purchaseOrderItemId: string
}

function CreateGRNModal({ onClose }: { onClose: () => void }) {
  const createMut = useCreateGRN()
  const { data: poData } = usePurchaseOrders({ status: 'sent,partial', limit: 100 })
  const pos = (poData as any)?.data ?? []

  const [selectedPoId, setSelectedPoId] = useState('')
  const [grnDate, setGrnDate]           = useState(new Date().toISOString().split('T')[0])
  const [invoiceNo, setInvoiceNo]       = useState('')
  const [notes, setNotes]               = useState('')
  const [items, setItems] = useState<GrnItem[]>([{
    description: '', receivedQty: '', unit: 'pcs', rate: '', batchNo: '', expiryDate: '', purchaseOrderItemId: '',
  }])

  const selectedPo = pos.find((p: any) => p.id === selectedPoId)

  function populateFromPO(po: any) {
    if (!po?.items) return
    setItems(po.items.map((i: any) => ({
      description:         i.description,
      receivedQty:         String(Number(i.orderedQty) - Number(i.receivedQty)),
      unit:                i.unit,
      rate:                String(Number(i.rate)),
      batchNo:             '',
      expiryDate:          '',
      purchaseOrderItemId: i.id,
    })))
  }

  function updateItem(idx: number, patch: Partial<GrnItem>) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const validItems = items.filter(i => i.description && Number(i.receivedQty) > 0)
    if (!validItems.length) return toast.error('Add at least one item with received qty')
    await createMut.mutateAsync({
      purchaseOrderId: selectedPoId || undefined,
      grnDate,
      invoiceNo: invoiceNo || undefined,
      notes:     notes || undefined,
      items: validItems.map(i => ({
        purchaseOrderItemId: i.purchaseOrderItemId || undefined,
        description:         i.description,
        receivedQty:         Number(i.receivedQty),
        unit:                i.unit,
        rate:                Number(i.rate) || 0,
        batchNo:             i.batchNo || undefined,
        expiryDate:          i.expiryDate || undefined,
      })),
    })
    toast.success('GRN created')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-2xl shadow-xl my-4">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-lg">New Goods Receipt (GRN)</h2>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          {/* Link to PO */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Purchase Order (optional)</label>
              <select value={selectedPoId}
                onChange={e => { setSelectedPoId(e.target.value); const po = pos.find((p: any) => p.id === e.target.value); if (po) populateFromPO(po) }}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Unplanned / Walk-in receipt</option>
                {pos.map((po: any) => (
                  <option key={po.id} value={po.id}>{po.poNo} — {po.party?.name ?? '—'}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">GRN Date *</label>
              <input type="date" required value={grnDate} onChange={e => setGrnDate(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Invoice No.</label>
              <input type="text" value={invoiceNo} onChange={e => setInvoiceNo(e.target.value)} placeholder="Supplier's bill number"
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional"
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Items Received</label>
              <button type="button" onClick={() => setItems(p => [...p, { description: '', receivedQty: '', unit: 'pcs', rate: '', batchNo: '', expiryDate: '', purchaseOrderItemId: '' }])}
                className="text-xs text-blue-600 hover:underline">+ Add item</button>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-1 text-xs text-gray-500 px-1">
                <span className="col-span-4">Description</span>
                <span className="col-span-2">Qty</span>
                <span className="col-span-1">Unit</span>
                <span className="col-span-2">Rate</span>
                <span className="col-span-2">Batch / Expiry</span>
                <span className="col-span-1"></span>
              </div>
              {items.map((item, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-1 items-center">
                  <input className="col-span-4 border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                    placeholder="Item description" value={item.description}
                    onChange={e => updateItem(idx, { description: e.target.value })} />
                  <input type="number" min={0} step="0.001"
                    className="col-span-2 border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                    placeholder="Qty" value={item.receivedQty}
                    onChange={e => updateItem(idx, { receivedQty: e.target.value })} />
                  <input className="col-span-1 border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                    placeholder="pcs" value={item.unit}
                    onChange={e => updateItem(idx, { unit: e.target.value })} />
                  <input type="number" min={0}
                    className="col-span-2 border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                    placeholder="Rate" value={item.rate}
                    onChange={e => updateItem(idx, { rate: e.target.value })} />
                  <input className="col-span-2 border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                    placeholder="Batch no." value={item.batchNo}
                    onChange={e => updateItem(idx, { batchNo: e.target.value })} />
                  <button type="button" onClick={() => setItems(p => p.filter((_, i) => i !== idx))}
                    className="col-span-1 text-red-400 hover:text-red-600 flex justify-center">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={createMut.isPending}
              className="flex-1 bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {createMut.isPending ? 'Saving…' : 'Create GRN'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function GRNPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const { data, isLoading } = useGRNs()
  const grns = Array.isArray(data) ? data : []

  async function handleCancel(id: string) {
    if (!confirm('Cancel this GRN?')) return
    await grnApi.cancel(id)
    qc.invalidateQueries({ queryKey: ['grns'] })
    toast.success('GRN cancelled')
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Goods Receipts (GRN)</h1>
          <p className="text-sm text-gray-500 mt-0.5">Record incoming stock against purchase orders</p>
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New GRN
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : grns.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
          No goods receipts yet.
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">GRN No.</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Purchase Order</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Supplier</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Items</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {grns.map((grn: any) => (
                <tr key={grn.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{grn.grnNo}</td>
                  <td className="px-4 py-3 text-gray-500">{format(new Date(grn.grnDate), 'dd MMM yyyy')}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {grn.purchaseOrder ? (
                      <span className="font-medium">{grn.purchaseOrder.poNo}</span>
                    ) : <span className="text-gray-400">Unplanned</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {grn.purchaseOrder?.party?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{grn.items?.length ?? 0}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[grn.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {grn.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {grn.status === 'posted' && (
                      <button type="button" onClick={() => handleCancel(grn.id)}
                        className="text-xs text-red-500 hover:underline">Cancel</button>
                    )}
                    {grn.status === 'posted' && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle className="w-3.5 h-3.5" /> Posted
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateGRNModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}
