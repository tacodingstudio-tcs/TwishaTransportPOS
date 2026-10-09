// src/pages/inventory/PurchaseOrdersPage.tsx
import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { usePurchaseOrders, useCreatePurchaseOrder, useParties, useProducts } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { Plus, Search, ChevronRight, ShoppingCart, ScanLine, Loader2, AlertTriangle } from 'lucide-react'
import { aiApi } from '@/lib/api'
import toast from 'react-hot-toast'

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const STATUS_COLORS: Record<string, string> = {
  draft:    'bg-gray-100 text-gray-600',
  sent:     'bg-blue-100 text-blue-700',
  partial:  'bg-amber-100 text-amber-700',
  received: 'bg-green-100 text-green-700',
  cancelled:'bg-red-100 text-red-600',
}

function CreatePOModal({ onClose }: { onClose: () => void }) {
  const createPO     = useCreatePurchaseOrder()
  const { data: suppliersData } = useParties({ type: 'supplier', limit: 100 })
  const { data: productsData }  = useProducts({ limit: 500 })

  const [partyId, setPartyId] = useState('')
  const [poDate, setPoDate]         = useState(new Date().toISOString().split('T')[0])
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes]           = useState('')
  const [lines, setLines]           = useState<Array<{
    productId: string; description: string; orderedQty: string; unit: string; rate: string; gstRate: string;
  }>>([{ productId: '', description: '', orderedQty: '', unit: 'pcs', rate: '', gstRate: '0' }])

  const [scanning, setScanning]         = useState(false)
  const [scanWarnings, setScanWarnings] = useState<string[]>([])
  const fileInputRef                    = useRef<HTMLInputElement>(null)

  async function handleScanBill(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setScanning(true)
    setScanWarnings([])
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload  = () => resolve((reader.result as string).split(',')[1]!)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const mediaType = (file.type || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp'
      const result = await aiApi.extractSupplierBill(base64, mediaType)

      // Pre-fill supplier
      if (result.supplier) setPartyId(result.supplier.id)

      // Pre-fill date
      if (result.billDate) setPoDate(result.billDate)

      // Pre-fill line items
      if (result.items?.length) {
        setLines(result.items.map((item: any) => ({
          productId:   item.productId ?? '',
          description: item.description ?? item.productName ?? '',
          orderedQty:  String(item.orderedQty ?? 1),
          unit:        item.unit ?? 'pcs',
          rate:        String(item.rate ?? ''),
          gstRate:     String(item.gstRate ?? 0),
        })))
      }

      // Build warnings
      const warnings: string[] = []
      if (result.supplier?.isNew)      warnings.push(`New supplier "${result.supplier.name}" created automatically`)
      if (result.newProductCount > 0)  warnings.push(`${result.newProductCount} item(s) not found in catalogue — description filled from bill, please verify`)
      if (result.confidence < 0.75)    warnings.push(`Low confidence (${Math.round(result.confidence * 100)}%) — please review all fields carefully`)
      setScanWarnings(warnings)

      toast.success('Bill scanned successfully')
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Could not scan bill — try a clearer photo')
    } finally {
      setScanning(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function addLine() {
    setLines([...lines, { productId: '', description: '', orderedQty: '', unit: 'pcs', rate: '', gstRate: '0' }])
  }

  function removeLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i))
  }

  function setLine(i: number, key: string, value: string) {
    const next = [...lines]
    // When product is selected, auto-fill description, unit, rate, gstRate
    if (key === 'productId' && value) {
      const p = productsData?.data?.find((x: any) => x.id === value)
      if (p) {
        next[i] = {
          ...next[i]!, productId: value,
          description: p.name, unit: p.unit ?? 'pcs',
          rate: String(p.purchasePrice ?? ''), gstRate: String(p.gstRate ?? 0),
        }
        setLines(next); return
      }
    }
    next[i] = { ...next[i]!, [key]: value }
    setLines(next)
  }

  function calcTotals() {
    let subtotal = 0, taxAmt = 0
    for (const l of lines) {
      const qty  = Number(l.orderedQty) || 0
      const rate = Number(l.rate) || 0
      const gst  = Number(l.gstRate) || 0
      const taxable = qty * rate
      subtotal += taxable
      taxAmt   += taxable * gst / 100
    }
    return { subtotal, taxAmt, grand: subtotal + taxAmt }
  }

  const { subtotal, taxAmt, grand } = calcTotals()

  async function handleSubmit() {
    if (!lines.some((l) => l.description && l.orderedQty && l.rate)) return
    await createPO.mutateAsync({
      partyId: partyId || undefined,
      poDate,
      expectedDate: expectedDate || undefined,
      notes:        notes || undefined,
      items: lines
        .filter((l) => l.description && l.orderedQty && l.rate)
        .map((l) => {
          const qty     = Number(l.orderedQty)
          const rate    = Number(l.rate)
          const gstRate = Number(l.gstRate)
          const taxable = qty * rate
          const cgst    = (taxable * gstRate) / 200
          const sgst    = cgst
          return {
            productId:   l.productId || undefined,
            description: l.description,
            orderedQty:  qty,
            unit:        l.unit,
            rate,
            taxableAmt:  taxable,
            gstRate,
            cgstAmt:     cgst,
            sgstAmt:     sgst,
            igstAmt:     0,
            total:       taxable + cgst + sgst,
          }
        }),
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">Create purchase order</h3>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              aria-label="Upload supplier bill image"
              onChange={handleScanBill}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={scanning}
              className="btn-ghost text-sm flex items-center gap-2"
            >
              {scanning
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</>
                : <><ScanLine className="w-4 h-4" /> Scan Bill</>
              }
            </button>
          </div>
        </div>

        {scanWarnings.length > 0 && (
          <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-1">
            {scanWarnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-amber-800">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {w}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="col-span-1">
            <label className="label" htmlFor="po-supplier">Supplier</label>
            <select id="po-supplier" value={partyId} onChange={(e) => setPartyId(e.target.value)} className="input">
              <option value="">— Walk-in / No supplier —</option>
              {suppliersData?.data?.map((s: any) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="po-date">PO date</label>
            <input id="po-date" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="po-exp">Expected by</label>
            <input id="po-exp" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className="input" />
          </div>
        </div>

        {/* Line items */}
        <div className="mb-3">
          <div className="grid grid-cols-12 gap-2 text-xs font-medium text-gray-500 mb-1 px-1">
            <span className="col-span-4">Product / Description</span>
            <span className="col-span-2">Qty</span>
            <span className="col-span-1">Unit</span>
            <span className="col-span-2">Rate (₹)</span>
            <span className="col-span-2">GST %</span>
            <span className="col-span-1" />
          </div>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-4">
                  <select
                    value={line.productId}
                    onChange={(e) => setLine(i, 'productId', e.target.value)}
                    className="input text-sm"
                    aria-label="Product"
                  >
                    <option value="">— Type description —</option>
                    {productsData?.data?.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  {!line.productId && (
                    <input
                      placeholder="Description"
                      value={line.description}
                      onChange={(e) => setLine(i, 'description', e.target.value)}
                      className="input text-sm mt-1"
                    />
                  )}
                </div>
                <input type="number" min={0} placeholder="0" value={line.orderedQty} onChange={(e) => setLine(i, 'orderedQty', e.target.value)} className="input text-sm col-span-2" aria-label="Qty" />
                <select value={line.unit} onChange={(e) => setLine(i, 'unit', e.target.value)} className="input text-sm col-span-1" aria-label="Unit">
                  {['pcs', 'kg', 'g', 'l', 'ml', 'box', 'dozen'].map((u) => <option key={u}>{u}</option>)}
                </select>
                <input type="number" min={0} placeholder="0" value={line.rate} onChange={(e) => setLine(i, 'rate', e.target.value)} className="input text-sm col-span-2" aria-label="Rate" />
                <select value={line.gstRate} onChange={(e) => setLine(i, 'gstRate', e.target.value)} className="input text-sm col-span-2" aria-label="GST rate">
                  {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
                </select>
                <button type="button" onClick={() => removeLine(i)} disabled={lines.length === 1} className="col-span-1 text-xs text-gray-400 hover:text-red-500 disabled:opacity-30">✕</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addLine} className="mt-2 text-sm text-primary-600 hover:text-primary-700 font-medium">
            + Add item
          </button>
        </div>

        {/* Totals */}
        <div className="border-t border-gray-100 pt-3 text-sm space-y-1 text-right">
          <div className="text-gray-500">Subtotal: <span className="text-gray-800 font-medium">{formatINR(subtotal)}</span></div>
          <div className="text-gray-500">GST: <span className="text-gray-800 font-medium">{formatINR(taxAmt)}</span></div>
          <div className="text-base font-semibold text-gray-900">Total: {formatINR(grand)}</div>
        </div>

        <div>
          <label className="label mt-3" htmlFor="po-notes">Notes</label>
          <textarea id="po-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="input" rows={2} placeholder="Any notes for this PO..." />
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={createPO.isPending} className="btn-primary flex-1 justify-center">
            {createPO.isPending ? 'Creating...' : 'Create PO'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PurchaseOrdersPage() {
  const [search, setSearch]       = useState('')
  const [status, setStatus]       = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading } = usePurchaseOrders({ q: search || undefined, status: status || undefined, limit: 50 })

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        subtitle={data?.meta ? `${data.meta.total} orders` : undefined}
        action={
          <button type="button" onClick={() => setShowCreate(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> Create PO
          </button>
        }
      />

      <div className="p-8">
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input placeholder="Search by PO number or supplier..." value={search} onChange={(e) => setSearch(e.target.value)} className="input pl-9" />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-44">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="partial">Partial</option>
            <option value="received">Received</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">PO No.</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Supplier</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Date</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Expected By</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Items</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Total</th>
                <th className="px-5 py-3 font-medium text-gray-500">Status</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={8} className="text-center py-12 text-gray-400">Loading...</td></tr>}
              {!isLoading && data?.data?.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-12">
                    <ShoppingCart className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-400">No purchase orders yet.</p>
                  </td>
                </tr>
              )}
              {data?.data?.map((po: any) => (
                <tr key={po.id} className="table-row">
                  <td className="px-5 py-3 font-mono text-sm font-medium text-primary-700">{po.poNo}</td>
                  <td className="px-5 py-3 text-gray-700">{po.party?.name ?? '—'}</td>
                  <td className="px-5 py-3 text-gray-500">{new Date(po.poDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                  <td className="px-5 py-3 text-gray-500">{po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td className="px-5 py-3 text-right text-gray-600">{po._count?.items ?? po.items?.length ?? '—'}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-800">{formatINR(Number(po.grandTotal))}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[po.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {po.status}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <Link to={`/inventory/purchase-orders/${po.id}`} className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md inline-flex">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreatePOModal onClose={() => setShowCreate(false)} />}
    </div>
  )
}
