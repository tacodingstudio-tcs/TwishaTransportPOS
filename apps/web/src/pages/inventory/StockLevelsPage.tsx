// src/pages/inventory/StockLevelsPage.tsx
import { useState, useMemo } from 'react'
import { useStockLevels, useStockLedger, useReorderSuggestions, useCreatePurchaseOrder, useExpiryAlerts, useCreateStockAdjustment, usePostStockAdjustment } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Search, AlertTriangle, X, TrendingUp, TrendingDown, ShoppingCart, CalendarClock, Pencil } from 'lucide-react'
import toast from 'react-hot-toast'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

function formatQty(q: number, unit: string) {
  return `${Number(q).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`
}

function StockBadge({ current, low }: { current: number; low: number }) {
  if (current <= 0)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Out of stock</span>
  if (current <= low)
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700"><AlertTriangle className="w-3 h-3" />Low stock</span>
  return <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">OK</span>
}

function LedgerDrawer({ productId, productName, onClose }: { productId: string; productName: string; onClose: () => void }) {
  const { data, isLoading } = useStockLedger(productId)

  const txnLabel: Record<string, string> = {
    sale: 'Sale', sale_return: 'Sale Return', purchase: 'Purchase',
    purchase_return: 'Purchase Return', adjustment_in: 'Adj In', adjustment_out: 'Adj Out',
    transfer_out: 'Transfer Out', transfer_in: 'Transfer In', opening: 'Opening',
  }

  // Build running balance for chart (oldest → newest)
  const chartData = useMemo(() => {
    if (!data?.data?.length) return []
    const rows = [...data.data].reverse()
    let balance = 0
    return rows.map((entry: any) => {
      balance += Number(entry.qty)
      return {
        date: new Date(entry.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        balance: Math.round(balance * 100) / 100,
      }
    })
  }, [data])

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white shadow-xl flex flex-col h-full">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">{productName}</h3>
            <p className="text-xs text-gray-500">Stock ledger</p>
          </div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close" className="p-1.5 hover:bg-gray-100 rounded-md">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Stock history chart */}
        {chartData.length > 1 && (
          <div className="px-5 pt-4 pb-2 border-b border-gray-100">
            <p className="text-xs font-medium text-gray-500 mb-2">Stock history</p>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="stockGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} />
                <Tooltip
                  contentStyle={{ fontSize: 11, borderRadius: 6, border: '1px solid #e5e7eb' }}
                  formatter={(v: number) => [v, 'Qty']}
                />
                <Area type="monotone" dataKey="balance" stroke="#6366f1" strokeWidth={2} fill="url(#stockGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading && <p className="text-center py-10 text-gray-400">Loading...</p>}
          {!isLoading && (!data?.data || data.data.length === 0) && (
            <p className="text-center py-10 text-gray-400">No ledger entries</p>
          )}
          {data?.data?.map((entry: any) => (
            <div key={entry.id} className="flex items-center justify-between px-5 py-3 border-b border-gray-100 hover:bg-gray-50">
              <div>
                <div className="text-sm font-medium text-gray-800">{txnLabel[entry.txnType] ?? entry.txnType}</div>
                <div className="text-xs text-gray-400">{new Date(entry.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                {entry.notes && <div className="text-xs text-gray-400 truncate max-w-xs">{entry.notes}</div>}
              </div>
              <div className={`flex items-center gap-1 text-sm font-semibold ${Number(entry.qty) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {Number(entry.qty) > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {Number(entry.qty) > 0 ? '+' : ''}{Number(entry.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const URGENCY_STYLES: Record<string, string> = {
  expired:  'bg-red-100 text-red-700 border-red-200',
  critical: 'bg-red-50 text-red-600 border-red-100',
  warning:  'bg-amber-50 text-amber-700 border-amber-200',
  notice:   'bg-blue-50 text-blue-600 border-blue-100',
}

function ExpiryAlertsPanel() {
  const [days, setDays] = useState(90)
  const { data, isLoading } = useExpiryAlerts(days)

  const allBatches = data
    ? [...(data.batches?.expired ?? []), ...(data.batches?.critical ?? []), ...(data.batches?.warning ?? []), ...(data.batches?.notice ?? [])]
    : []

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Expiry window"
          className="input w-40 text-sm"
        >
          <option value={30}>Next 30 days</option>
          <option value={60}>Next 60 days</option>
          <option value={90}>Next 90 days</option>
          <option value={180}>Next 180 days</option>
        </select>
        {data && (
          <div className="flex gap-2 text-xs">
            {data.summary?.expired > 0 && <span className="px-2 py-1 rounded-full bg-red-100 text-red-700 font-medium">{data.summary.expired} expired</span>}
            {data.summary?.critical > 0 && <span className="px-2 py-1 rounded-full bg-red-50 text-red-600 font-medium border border-red-100">{data.summary.critical} critical</span>}
            {data.summary?.warning > 0 && <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 font-medium border border-amber-200">{data.summary.warning} warning</span>}
          </div>
        )}
      </div>

      {isLoading && <p className="text-center py-12 text-gray-400">Loading expiry data...</p>}
      {!isLoading && allBatches.length === 0 && (
        <div className="text-center py-16">
          <CalendarClock className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-gray-400">No batches expiring within {days} days</p>
        </div>
      )}

      {allBatches.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Product</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Batch</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Qty Left</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Expiry Date</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Days</th>
                <th className="px-5 py-3 font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {allBatches.map((b: any) => (
                <tr key={b.batchId} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{b.productName}</td>
                  <td className="px-5 py-3 text-gray-500 font-mono text-xs">{b.batchNo}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{Number(b.qtyRemaining).toLocaleString('en-IN', { maximumFractionDigits: 2 })} {b.unit}</td>
                  <td className="px-5 py-3 text-right text-gray-600">{new Date(b.expDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className={`px-5 py-3 text-right font-semibold ${b.daysToExpiry < 0 ? 'text-red-700' : b.daysToExpiry <= 30 ? 'text-red-600' : 'text-amber-600'}`}>
                    {b.daysToExpiry < 0 ? `${Math.abs(b.daysToExpiry)}d ago` : `${b.daysToExpiry}d`}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize border ${URGENCY_STYLES[b.urgency] ?? ''}`}>
                      {b.urgency}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ReorderPanel() {
  const { data, isLoading } = useReorderSuggestions()
  const createPO = useCreatePurchaseOrder()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const suggestions: any[] = data?.suggestions ?? []

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelected(suggestions.length === selected.size ? new Set() : new Set(suggestions.map((s: any) => s.productId)))
  }

  async function handleCreatePO() {
    const items = suggestions.filter((s: any) => selected.has(s.productId))
    if (!items.length) { toast.error('Select at least one product'); return }
    await createPO.mutateAsync({
      poDate: new Date().toISOString().split('T')[0],
      items: items.map((s: any) => ({
        productId:   s.productId,
        description: s.productName,
        orderedQty:  s.suggestedQty,
        unit:        s.unit ?? 'pcs',
        rate:        s.purchasePrice ?? 0,
        taxableAmt:  0,
        gstRate:     0,
        cgstAmt:     0,
        sgstAmt:     0,
        igstAmt:     0,
        total:       0,
      })),
    })
    setSelected(new Set())
  }

  if (isLoading) return <p className="text-center py-12 text-gray-400">Analyzing stock & sales...</p>

  if (!suggestions.length) return (
    <div className="text-center py-16">
      <ShoppingCart className="w-8 h-8 text-gray-300 mx-auto mb-2" />
      <p className="text-gray-400">No reorder suggestions right now</p>
    </div>
  )

  const URGENCY_CHIP: Record<string, string> = {
    critical: 'bg-red-100 text-red-700',
    high:     'bg-amber-100 text-amber-700',
    medium:   'bg-yellow-50 text-yellow-700',
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">{suggestions.length} product{suggestions.length !== 1 ? 's' : ''} need restocking</p>
        <div className="flex gap-2">
          <button type="button" onClick={selectAll} className="btn-ghost text-sm">
            {selected.size === suggestions.length ? 'Deselect all' : 'Select all'}
          </button>
          <button
            type="button"
            onClick={handleCreatePO}
            disabled={selected.size === 0 || createPO.isPending}
            className="btn-primary text-sm"
          >
            <ShoppingCart className="w-4 h-4" />
            {createPO.isPending ? 'Creating...' : `Draft PO (${selected.size})`}
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 w-10" aria-label="Select all">
                <input
                  type="checkbox"
                  aria-label="Select all products"
                  checked={selected.size === suggestions.length && suggestions.length > 0}
                  onChange={selectAll}
                  className="rounded border-gray-300"
                />
              </th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Product</th>
              <th className="text-right px-4 py-3 font-medium text-gray-500">Stock</th>
              <th className="text-right px-4 py-3 font-medium text-gray-500">Suggest Qty</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Reason</th>
              <th className="px-4 py-3 font-medium text-gray-500">Priority</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.map((s: any) => (
              <tr
                key={s.productId}
                className={`border-b border-gray-100 cursor-pointer transition-colors ${selected.has(s.productId) ? 'bg-primary-50' : 'hover:bg-gray-50'}`}
                onClick={() => toggle(s.productId)}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${s.productName}`}
                    checked={selected.has(s.productId)}
                    onChange={() => toggle(s.productId)}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded border-gray-300"
                  />
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{s.productName}</td>
                <td className="px-4 py-3 text-right text-gray-600">{s.currentStock}</td>
                <td className="px-4 py-3 text-right font-semibold text-primary-700">{s.suggestedQty}</td>
                <td className="px-4 py-3 text-gray-500 text-xs max-w-xs truncate">{s.reason}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${URGENCY_CHIP[s.urgency] ?? 'bg-gray-100 text-gray-500'}`}>
                    {s.urgency}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const QUICK_REASONS = [
  { value: 'physical_count', label: 'Physical Count' },
  { value: 'consumed',       label: 'Consumed / Used in Service' },
  { value: 'damage',         label: 'Damage / Breakage' },
  { value: 'theft',          label: 'Theft / Loss' },
  { value: 'expiry',         label: 'Expiry Write-off' },
  { value: 'opening_stock',  label: 'Opening Stock' },
]

function QuickStockUpdateModal({
  row, onClose,
}: {
  row: { productId: string; productName: string; currentQty: number; unit: string; packSize?: string }
  onClose: () => void
}) {
  const [mode, setMode]       = useState<'set' | 'add' | 'remove'>('set')
  const [value, setValue]     = useState('')
  const [reason, setReason]   = useState('physical_count')
  const [notes, setNotes]     = useState('')
  const [saving, setSaving]   = useState(false)

  const createAdj = useCreateStockAdjustment()
  const postAdj   = usePostStockAdjustment()

  const parsed = parseFloat(value || '0')
  const newQty = mode === 'set'    ? parsed
               : mode === 'add'    ? row.currentQty + parsed
               :                    row.currentQty - parsed
  const diff   = newQty - row.currentQty

  async function handleSave() {
    if (!value || isNaN(parsed) || parsed < 0) { toast.error('Enter a valid quantity'); return }
    if (newQty < 0) { toast.error('Stock cannot go below zero'); return }
    setSaving(true)
    try {
      const adj = await createAdj.mutateAsync({
        reason,
        adjDate: new Date().toISOString().split('T')[0],
        notes: notes || undefined,
        items: [{
          productId:     row.productId,
          systemQty:     row.currentQty,
          physicalQty:   newQty,
          differenceQty: diff,
        }],
      })
      await postAdj.mutateAsync(adj.id)
      toast.success('Stock updated')
      onClose()
    } catch {
      toast.error('Failed to update stock')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Update Stock</h3>
          <button type="button" onClick={onClose} className="p-1 hover:bg-gray-100 rounded" title="Close">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="mb-4">
          <p className="text-sm font-medium text-gray-900">{row.productName}</p>
          {row.packSize && <p className="text-xs text-gray-400">{row.packSize} per {row.unit}</p>}
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg text-sm">
            <span className="text-gray-500">Current stock</span>
            <span className="ml-auto font-semibold text-gray-800">{row.currentQty} <span className="text-gray-400 font-normal">{row.unit}</span></span>
          </div>

          {/* Mode toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {(['set', 'add', 'remove'] as const).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setValue(''); setReason(m === 'remove' ? 'consumed' : 'physical_count') }}
                className={`flex-1 py-2 font-medium transition-colors ${mode === m ? 'bg-primary-600 text-white' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                {m === 'set' ? 'Set to' : m === 'add' ? '+ Add' : '− Remove'}
              </button>
            ))}
          </div>

          <div>
            <label className="label" htmlFor="qty-val">
              {mode === 'set' ? `New total (${row.unit})` : mode === 'add' ? `Quantity to add (${row.unit})` : `Quantity to remove (${row.unit})`}
            </label>
            <input
              id="qty-val"
              type="number"
              min="0"
              step="0.001"
              value={value}
              onChange={e => setValue(e.target.value)}
              className="input"
              placeholder="0"
              autoFocus
            />
            {value !== '' && !isNaN(diff) && (
              <p className={`text-xs mt-1 font-medium ${diff > 0 ? 'text-green-600' : diff < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                {diff > 0 ? `+${diff.toFixed(3)}` : diff.toFixed(3)} {row.unit} → new total: <strong>{newQty.toFixed(3)} {row.unit}</strong>
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="quick-reason">Reason</label>
            <select id="quick-reason" value={reason} onChange={e => setReason(e.target.value)} className="input">
              {QUICK_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="quick-notes">Notes (optional)</label>
            <input
              id="quick-notes"
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="input"
              placeholder="Optional notes"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button type="button" onClick={handleSave} disabled={saving || !value} className="btn-primary flex-1">
            {saving ? 'Saving...' : 'Update Stock'}
          </button>
        </div>
      </div>
    </div>
  )
}

type Tab = 'stock' | 'reorder' | 'expiry'

export function StockLevelsPage() {
  const [search, setSearch]         = useState('')
  const [filter, setFilter]         = useState<'all' | 'low' | 'out'>('all')
  const [ledgerProduct, setLedgerProduct] = useState<{ id: string; name: string } | null>(null)
  const [quickUpdate, setQuickUpdate] = useState<{ productId: string; productName: string; currentQty: number; unit: string; packSize?: string } | null>(null)
  const [tab, setTab]               = useState<Tab>('stock')

  const { data, isLoading } = useStockLevels({
    q:       search || undefined,
    status:  filter !== 'all' ? filter : undefined,
    limit:   100,
  })

  const { data: reorderData } = useReorderSuggestions()
  const { data: expiryData }  = useExpiryAlerts(30)

  const allRows          = data?.data ?? []
  const outCount         = allRows.filter((r: any) => Number(r.currentQty) <= 0).length
  const lowCount         = allRows.filter((r: any) => Number(r.currentQty) > 0 && Number(r.currentQty) <= Number(r.product?.lowStockQty ?? 0)).length
  const reorderCount     = (reorderData?.suggestions ?? []).length
  const expiryCount      = (expiryData?.summary?.expired ?? 0) + (expiryData?.summary?.critical ?? 0)

  const totalValue = allRows.reduce((sum: number, r: any) => {
    const qty   = Number(r.currentQty ?? 0)
    const price = Number(r.product?.purchasePrice ?? 0)
    return sum + (qty > 0 ? qty * price : 0)
  }, 0)

  const inStockCount = allRows.filter((r: any) => Number(r.currentQty) > 0).length

  return (
    <div>
      <PageHeader
        title="Stock Levels"
        subtitle={data?.meta ? `${data.meta.total} products tracked` : undefined}
      />

      <div className="p-8">
        {/* Inventory value summary */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="card p-4">
            <p className="text-xs text-gray-500 mb-1">Total Inventory Value</p>
            <p className="text-xl font-bold text-gray-900">
              ₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">at purchase price</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 mb-1">Total SKUs</p>
            <p className="text-xl font-bold text-gray-900">{allRows.length}</p>
            <p className="text-xs text-gray-400 mt-0.5">{inStockCount} in stock</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 mb-1">Low Stock</p>
            <p className={`text-xl font-bold ${lowCount > 0 ? 'text-amber-600' : 'text-gray-900'}`}>{lowCount}</p>
            <p className="text-xs text-gray-400 mt-0.5">below reorder level</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-gray-500 mb-1">Out of Stock</p>
            <p className={`text-xl font-bold ${outCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>{outCount}</p>
            <p className="text-xs text-gray-400 mt-0.5">zero quantity</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200 mb-6">
          {([
            { key: 'stock',   label: 'Stock Levels' },
            { key: 'reorder', label: `Reorder Alerts${reorderCount > 0 ? ` (${reorderCount})` : ''}` },
            { key: 'expiry',  label: `Expiry Alerts${expiryCount > 0 ? ` (${expiryCount})` : ''}` },
          ] as { key: Tab; label: string }[]).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                tab === key ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'reorder' && <ReorderPanel />}
        {tab === 'expiry'  && <ExpiryAlertsPanel />}

        {tab === 'stock' && (
          <>
            {/* Summary chips */}
            <div className="flex gap-3 mb-5">
              {outCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilter(filter === 'out' ? 'all' : 'out')}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    filter === 'out' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5" /> {outCount} Out of stock
                </button>
              )}
              {lowCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilter(filter === 'low' ? 'all' : 'low')}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    filter === 'low' ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5" /> {lowCount} Low stock
                </button>
              )}
            </div>

            {/* Search */}
            <div className="relative max-w-sm mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                placeholder="Search products..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-9"
              />
            </div>

            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-5 py-3 font-medium text-gray-500">Product</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-500">Category</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Current Stock</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Reserved</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Available</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Purchase Price</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Stock Value</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Reorder At</th>
                    <th className="px-5 py-3 font-medium text-gray-500">Status</th>
                    <th className="px-5 py-3 font-medium text-gray-500">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && <tr><td colSpan={10} className="text-center py-12 text-gray-400">Loading...</td></tr>}
                  {!isLoading && data?.data?.length === 0 && (
                    <tr><td colSpan={10} className="text-center py-12 text-gray-400">No products found</td></tr>
                  )}
                  {data?.data?.map((row: any) => {
                    const current   = Number(row.currentQty ?? 0)
                    const reserved  = Number(row.reservedQty ?? 0)
                    const available = current - reserved
                    const low       = Number(row.product?.lowStockQty ?? 0)
                    return (
                      <tr
                        key={row.id}
                        className="table-row cursor-pointer"
                        onClick={() => setLedgerProduct({ id: row.productId, name: row.product?.name ?? '' })}
                      >
                        <td className="px-5 py-3 font-medium text-gray-900">{row.product?.name ?? '—'}</td>
                        <td className="px-5 py-3 text-gray-500">{row.product?.category?.name ?? '—'}</td>
                        <td className="px-5 py-3 text-right font-semibold text-gray-800">
                          {formatQty(current, row.product?.unit ?? '')}
                        </td>
                        <td className="px-5 py-3 text-right text-gray-500">{reserved > 0 ? formatQty(reserved, row.product?.unit ?? '') : '—'}</td>
                        <td className={`px-5 py-3 text-right font-medium ${available <= 0 ? 'text-red-600' : 'text-gray-700'}`}>
                          {formatQty(available, row.product?.unit ?? '')}
                        </td>
                        <td className="px-5 py-3 text-right text-gray-500">
                          {Number(row.product?.purchasePrice ?? 0) > 0
                            ? `₹${Number(row.product.purchasePrice).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                            : '—'}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold text-gray-800">
                          {current > 0 && Number(row.product?.purchasePrice ?? 0) > 0
                            ? `₹${(current * Number(row.product.purchasePrice)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
                            : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-gray-400">{low > 0 ? formatQty(low, row.product?.unit ?? '') : '—'}</td>
                        <td className="px-5 py-3">
                          <StockBadge current={current} low={low} />
                        </td>
                        <td className="px-5 py-3">
                          <button
                            type="button"
                            title="Update stock"
                            onClick={e => { e.stopPropagation(); setQuickUpdate({ productId: row.productId, productName: row.product?.name ?? '', currentQty: current, unit: row.product?.unit ?? 'pcs', packSize: row.product?.packSize }) }}
                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {ledgerProduct && (
        <LedgerDrawer
          productId={ledgerProduct.id}
          productName={ledgerProduct.name}
          onClose={() => setLedgerProduct(null)}
        />
      )}

      {quickUpdate && (
        <QuickStockUpdateModal
          row={quickUpdate}
          onClose={() => setQuickUpdate(null)}
        />
      )}
    </div>
  )
}
