// src/pages/inventory/StockTransfersPage.tsx
import { useState } from 'react'
import {
  useStockTransfers, useCreateStockTransfer,
  useDispatchStockTransfer, useReceiveStockTransfer,
  useProducts, useBranches,
} from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, Search, Send, PackageCheck, ArrowLeftRight } from 'lucide-react'

const STATUS_COLORS: Record<string, string> = {
  draft:      'bg-gray-100 text-gray-600',
  in_transit: 'bg-blue-100 text-blue-700',
  received:   'bg-green-100 text-green-700',
  cancelled:  'bg-red-100 text-red-600',
}

function CreateTransferModal({ onClose }: { onClose: () => void }) {
  const createTransfer = useCreateStockTransfer()
  const { data: productsData } = useProducts({ limit: 500 })
  const branch = useAuthStore((s) => s.branch)
  const { data: branches }     = useBranches()

  const [toBranch, setToBranch]           = useState('')
  const [transferDate, setTransferDate]   = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]                 = useState('')
  const [lines, setLines] = useState<Array<{
    productId: string; sentQty: string; unit: string; rate: string;
  }>>([{ productId: '', sentQty: '', unit: 'pcs', rate: '' }])

  function addLine() {
    setLines([...lines, { productId: '', sentQty: '', unit: 'pcs', rate: '' }])
  }

  function removeLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i))
  }

  function setLine(i: number, key: string, value: string) {
    const next = [...lines]
    if (key === 'productId' && value) {
      const p = productsData?.data?.find((x: any) => x.id === value)
      if (p) {
        next[i] = { ...next[i]!, productId: value, unit: p.unit ?? 'pcs', rate: String(p.purchasePrice ?? '') }
        setLines(next); return
      }
    }
    next[i] = { ...next[i]!, [key]: value }
    setLines(next)
  }

  async function handleSubmit() {
    const validLines = lines.filter((l) => l.productId && l.sentQty)
    if (!toBranch || validLines.length === 0) return
    try {
      await createTransfer.mutateAsync({
        toBranchId:   toBranch,
        transferDate,
        notes:        notes || undefined,
        items: validLines.map((l) => ({
          productId: l.productId,
          sentQty:   Number(l.sentQty),
          unit:      l.unit,
          rate:      Number(l.rate) || 0,
        })),
      })
      onClose()
    } catch (err: any) {
      // 422 insufficient stock — show item-level breakdown
      const items = err?.response?.data?.items as Array<{ productName: string; available: number; requested: number; unit: string }> | undefined
      if (items?.length) {
        const lines = items.map((i) => `• ${i.productName}: need ${i.requested} ${i.unit}, available ${i.available} ${i.unit}`).join('\n')
        alert(`Insufficient stock:\n\n${lines}`)
      }
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Create stock transfer</h3>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="label" htmlFor="tr-from">From branch</label>
            <input id="tr-from" className="input bg-gray-50" value={branch?.name ?? ''} disabled />
          </div>
          <div>
            <label className="label" htmlFor="tr-to">To branch</label>
            <select
              id="tr-to"
              value={toBranch}
              onChange={(e) => setToBranch(e.target.value)}
              className="input"
            >
              <option value="">Select branch…</option>
              {(branches ?? [])
                .filter((b: any) => b.id !== branch?.id)
                .map((b: any) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tr-date">Transfer date</label>
            <input id="tr-date" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} className="input" />
          </div>
        </div>

        {/* Line items */}
        <div className="mb-3">
          <div className="grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 mb-1 px-1">
            <span className="col-span-5">Product</span>
            <span className="col-span-2 text-right">Qty</span>
            <span className="col-span-2">Unit</span>
            <span className="col-span-2 text-right">Cost Rate</span>
            <span className="col-span-1" />
          </div>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <select
                  value={line.productId}
                  onChange={(e) => setLine(i, 'productId', e.target.value)}
                  className="input text-sm col-span-5"
                  aria-label="Product"
                >
                  <option value="">— Select product —</option>
                  {productsData?.data?.map((p: any) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <input type="number" min={0} placeholder="0" value={line.sentQty} onChange={(e) => setLine(i, 'sentQty', e.target.value)} className="input text-sm text-right col-span-2" aria-label="Qty" />
                <select value={line.unit} onChange={(e) => setLine(i, 'unit', e.target.value)} className="input text-sm col-span-2" aria-label="Unit">
                  {['pcs', 'kg', 'g', 'l', 'ml', 'box', 'dozen'].map((u) => <option key={u}>{u}</option>)}
                </select>
                <input type="number" min={0} placeholder="0" value={line.rate} onChange={(e) => setLine(i, 'rate', e.target.value)} className="input text-sm text-right col-span-2" aria-label="Cost rate" />
                <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1} className="col-span-1 text-xs text-gray-400 hover:text-red-500 disabled:opacity-30">✕</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addLine} className="mt-2 text-sm text-primary-600 hover:text-primary-700 font-medium">
            + Add item
          </button>
        </div>

        <div>
          <label className="label" htmlFor="tr-notes">Notes</label>
          <textarea id="tr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} placeholder="Optional notes..." />
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={createTransfer.isPending} className="btn-primary flex-1 justify-center">
            {createTransfer.isPending ? 'Creating...' : 'Create Transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReceiveTransferModal({ transfer, onClose }: { transfer: any; onClose: () => void }) {
  const receiveTransfer = useReceiveStockTransfer()
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().split('T')[0])
  const [qtys, setQtys] = useState<Record<string, string>>(
    Object.fromEntries((transfer.items ?? []).map((item: any) => [item.id, String(item.sentQty)]))
  )

  async function handleSubmit() {
    await receiveTransfer.mutateAsync({
      id: transfer.id,
      data: {
        receivedDate,
        items: transfer.items.map((item: any) => ({
          id:          item.id,
          receivedQty: Number(qtys[item.id] ?? item.sentQty),
        })),
      },
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Confirm receipt — {transfer.transferNo}</h3>

        <div className="mb-4">
          <label className="label" htmlFor="recv-date">Received date</label>
          <input id="recv-date" type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className="input max-w-xs" />
        </div>

        <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Item</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Sent</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Received</th>
              </tr>
            </thead>
            <tbody>
              {transfer.items?.map((item: any) => (
                <tr key={item.id} className="border-b border-gray-100">
                  <td className="px-4 py-2.5 text-gray-800">{item.product?.name ?? item.productId}</td>
                  <td className="px-4 py-2.5 text-right text-gray-500">{Number(item.sentQty)} {item.unit}</td>
                  <td className="px-4 py-2.5 text-right">
                    <input
                      type="number"
                      min={0}
                      max={Number(item.sentQty)}
                      value={qtys[item.id] ?? ''}
                      onChange={(e) => setQtys({ ...qtys, [item.id]: e.target.value })}
                      className="input w-24 text-right text-sm"
                      aria-label={`Received qty for ${item.product?.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={receiveTransfer.isPending} className="btn-primary flex-1 justify-center">
            <PackageCheck className="w-4 h-4" />
            {receiveTransfer.isPending ? 'Confirming...' : 'Confirm Receipt'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function StockTransfersPage() {
  const [search, setSearch]         = useState('')
  const [status, setStatus]         = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [receiving, setReceiving]   = useState<any | null>(null)

  const { data, isLoading }   = useStockTransfers({ q: search || undefined, status: status || undefined, limit: 50 })
  const dispatchTransfer      = useDispatchStockTransfer()

  return (
    <div>
      <PageHeader
        title="Stock Transfers"
        subtitle="Move stock between branches"
        action={
          <button type="button" onClick={() => setShowCreate(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> New Transfer
          </button>
        }
      />

      <div className="p-8">
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input placeholder="Search transfers..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-9" />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-44" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="in_transit">In Transit</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Transfer No.</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">From</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">To</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Date</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Items</th>
                <th className="px-5 py-3 font-medium text-gray-500">Status</th>
                <th className="px-3 py-3" scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={7} className="text-center py-12 text-gray-400">Loading...</td></tr>}
              {!isLoading && data?.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <ArrowLeftRight className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-400">No transfers yet.</p>
                  </td>
                </tr>
              )}
              {data?.data?.map((tr: any) => (
                <tr key={tr.id} className="table-row">
                  <td className="px-5 py-3 font-mono text-sm font-medium text-gray-800">{tr.transferNo}</td>
                  <td className="px-5 py-3 text-gray-600">{tr.fromBranch?.name ?? tr.fromBranchId}</td>
                  <td className="px-5 py-3 text-gray-600">{tr.toBranch?.name ?? tr.toBranchId}</td>
                  <td className="px-5 py-3 text-gray-500">{new Date(tr.transferDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td className="px-5 py-3 text-right text-gray-600">{tr._count?.items ?? tr.items?.length ?? '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[tr.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {tr.status === 'in_transit' ? 'In Transit' : tr.status}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      {tr.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => { if (confirm('Dispatch this transfer? Stock will be deducted from source branch.')) dispatchTransfer.mutate(tr.id) }}
                          className="flex items-center gap-1 text-xs text-blue-700 hover:text-blue-800 font-medium"
                        >
                          <Send className="w-3.5 h-3.5" /> Dispatch
                        </button>
                      )}
                      {tr.status === 'in_transit' && (
                        <button
                          type="button"
                          onClick={() => setReceiving(tr)}
                          className="flex items-center gap-1 text-xs text-green-700 hover:text-green-800 font-medium"
                        >
                          <PackageCheck className="w-3.5 h-3.5" /> Receive
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateTransferModal onClose={() => setShowCreate(false)} />}
      {receiving && <ReceiveTransferModal transfer={receiving} onClose={() => setReceiving(null)} />}
    </div>
  )
}
