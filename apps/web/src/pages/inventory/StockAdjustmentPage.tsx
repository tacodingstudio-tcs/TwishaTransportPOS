// src/pages/inventory/StockAdjustmentPage.tsx
import { useState } from 'react'
import { useStockAdjustments, useCreateStockAdjustment, usePostStockAdjustment, useProducts } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, Search, ClipboardCheck, CheckCircle } from 'lucide-react'

const REASONS = [
  { value: 'consumed',       label: 'Consumed / Used in Service' },
  { value: 'physical_count', label: 'Physical Count' },
  { value: 'damage',         label: 'Damage / Breakage' },
  { value: 'theft',          label: 'Theft / Loss' },
  { value: 'expiry',         label: 'Expiry Write-off' },
  { value: 'sample',         label: 'Sample / Tester' },
  { value: 'opening_stock',  label: 'Opening Stock' },
]

const STATUS_COLORS: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  posted:    'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
}

function CreateAdjustmentModal({ onClose }: { onClose: () => void }) {
  const createAdj  = useCreateStockAdjustment()
  const { data: productsData } = useProducts({ limit: 500 })

  const [reason, setReason]   = useState('physical_count')
  const [adjDate, setAdjDate] = useState(new Date().toISOString().split('T')[0])
  const [notes, setNotes]     = useState('')
  const [lines, setLines]     = useState<Array<{
    productId: string; systemQty: string; physicalQty: string; rate: string;
  }>>([{ productId: '', systemQty: '0', physicalQty: '', rate: '' }])

  function addLine() {
    setLines([...lines, { productId: '', systemQty: '0', physicalQty: '', rate: '' }])
  }

  function removeLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i))
  }

  function setLine(i: number, key: string, value: string) {
    const next = [...lines]
    if (key === 'productId' && value) {
      const p = productsData?.data?.find((x: any) => x.id === value)
      if (p) {
        next[i] = { ...next[i]!, productId: value, rate: String(p.purchasePrice ?? '') }
        setLines(next); return
      }
    }
    next[i] = { ...next[i]!, [key]: value }
    setLines(next)
  }

  async function handleSubmit() {
    const validLines = lines.filter((l) => l.productId && l.physicalQty !== '')
    if (validLines.length === 0) return
    await createAdj.mutateAsync({
      reason,
      adjDate,
      notes: notes || undefined,
      items: validLines.map((l) => ({
        productId:    l.productId,
        systemQty:   Number(l.systemQty),
        physicalQty: Number(l.physicalQty),
        differenceQty: Number(l.physicalQty) - Number(l.systemQty),
        rate:        l.rate ? Number(l.rate) : undefined,
      })),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">New stock adjustment</h3>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="label" htmlFor="adj-reason">Reason</label>
            <select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} className="input">
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="adj-date">Date</label>
            <input id="adj-date" type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="adj-notes">Notes</label>
            <input id="adj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="input" placeholder="Optional" />
          </div>
        </div>

        {/* Line items */}
        <div className="mb-3">
          <div className="grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 mb-1 px-1">
            <span className="col-span-5">Product</span>
            <span className="col-span-2 text-right">System Qty</span>
            <span className="col-span-2 text-right">Physical Qty</span>
            <span className="col-span-2 text-right">Difference</span>
            <span className="col-span-1" />
          </div>
          <div className="space-y-2">
            {lines.map((line, i) => {
              const diff = line.physicalQty !== '' ? Number(line.physicalQty) - Number(line.systemQty || 0) : null
              return (
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
                  <input
                    type="number"
                    min={0}
                    placeholder="0"
                    value={line.systemQty}
                    onChange={(e) => setLine(i, 'systemQty', e.target.value)}
                    className="input text-sm text-right col-span-2"
                    aria-label="System qty"
                  />
                  <input
                    type="number"
                    min={0}
                    placeholder="0"
                    value={line.physicalQty}
                    onChange={(e) => setLine(i, 'physicalQty', e.target.value)}
                    className="input text-sm text-right col-span-2"
                    aria-label="Physical qty"
                  />
                  <div className={`col-span-2 text-right text-sm font-medium ${diff === null ? 'text-gray-300' : diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {diff !== null ? (diff > 0 ? `+${diff}` : diff) : '—'}
                  </div>
                  <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1} className="col-span-1 text-xs text-gray-400 hover:text-red-500 disabled:opacity-30">✕</button>
                </div>
              )
            })}
          </div>
          <button type="button" onClick={addLine} className="mt-2 text-sm text-primary-600 hover:text-primary-700 font-medium">
            + Add item
          </button>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={createAdj.isPending} className="btn-primary flex-1 justify-center">
            {createAdj.isPending ? 'Saving...' : 'Save as Draft'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function StockAdjustmentPage() {
  const [search, setSearch]         = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading } = useStockAdjustments({ q: search || undefined, limit: 50 })
  const postAdj             = usePostStockAdjustment()

  return (
    <div>
      <PageHeader
        title="Stock Adjustments"
        subtitle="Physical counts, damage write-offs, and corrections"
        action={
          <button type="button" onClick={() => setShowCreate(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> New Adjustment
          </button>
        }
      />

      <div className="p-8">
        <div className="relative max-w-sm mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input placeholder="Search adjustments..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-9" />
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Adj No.</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Date</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Reason</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Items</th>
                <th className="px-5 py-3 font-medium text-gray-500">Status</th>
                <th className="px-5 py-3 font-medium text-gray-500">Notes</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={7} className="text-center py-12 text-gray-400">Loading...</td></tr>}
              {!isLoading && data?.data?.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <ClipboardCheck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-400">No adjustments yet.</p>
                  </td>
                </tr>
              )}
              {data?.data?.map((adj: any) => (
                <tr key={adj.id} className="table-row">
                  <td className="px-5 py-3 font-mono text-sm font-medium text-gray-800">{adj.adjNo}</td>
                  <td className="px-5 py-3 text-gray-500">{new Date(adj.adjDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td className="px-5 py-3 text-gray-700 capitalize">{REASONS.find((r) => r.value === adj.reason)?.label ?? adj.reason}</td>
                  <td className="px-5 py-3 text-right text-gray-600">{adj._count?.items ?? adj.items?.length ?? '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[adj.status] ?? 'bg-gray-100 text-gray-600'}`}>{adj.status}</span>
                  </td>
                  <td className="px-5 py-3 text-gray-400 text-xs max-w-xs truncate">{adj.notes ?? '—'}</td>
                  <td className="px-3 py-3">
                    {adj.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() => { if (confirm('Post this adjustment? Stock will be updated.')) postAdj.mutate(adj.id) }}
                        className="flex items-center gap-1 text-xs text-green-700 hover:text-green-800 font-medium"
                        title="Post adjustment"
                      >
                        <CheckCircle className="w-3.5 h-3.5" /> Post
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateAdjustmentModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}
