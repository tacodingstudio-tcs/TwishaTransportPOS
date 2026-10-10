// src/pages/CreateInvoicePage.tsx
import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProductSearch } from '@/components/invoice/ProductSearch'
import { PartySearch } from '@/components/invoice/PartySearch'
import { DomainInvoiceFields } from '@/components/invoice/DomainInvoiceFields'
import { PartyHistory } from '@/components/invoice/PartyHistory'
import { useCreateInvoice, useDiscountRules } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { Trash2, Minus, Plus, AlertTriangle, X, Tag, PauseCircle, Tv2 } from 'lucide-react'
import toast from 'react-hot-toast'

interface LineItem {
  key:          string
  productId?:   string
  description:  string
  qty:          number
  rate:         number
  discountPct:  number
  gstRate:      number
  unit:         string
  hsnSacCode:   string | null
  appliedRule?: string   // rule name that auto-applied discount
}

interface SelectedParty {
  id: string
  name: string
  phone: string | null
  balance: number
  creditLimit: number
  meta?: Record<string, unknown>
}

interface PaymentSplit {
  method: string
  amount: number
}

const PAYMENT_METHODS = [
  { value: 'cash',   label: 'Cash' },
  { value: 'upi',    label: 'UPI' },
  { value: 'card',   label: 'Card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'credit', label: 'Credit (Udhaar)' },
]

function calcLine(item: LineItem) {
  const gross    = item.qty * item.rate
  const discount = gross * (item.discountPct / 100)
  const taxable  = gross - discount
  const gstAmt   = taxable * (item.gstRate / 100)
  return { gross, discount, taxable, gstAmt, total: taxable + gstAmt }
}

const PATIENT_DOMAINS = new Set(['clinic', 'diagnostic_lab', 'optical'])

const B2B_DOMAINS = new Set([
  'wholesale', 'enterprise', 'electronics', 'textile', 'hardware',
  'printing', 'jewellery', 'automobile', 'agri', 'catering', 'transport',
])

const TXN_OPTIONS = [
  { value: 'sale_invoice',     label: 'Tax Invoice',        desc: 'Standard sales invoice' },
  { value: 'quotation',        label: 'Quotation',          desc: 'Price quote for customer' },
  { value: 'proforma',         label: 'Proforma Invoice',   desc: 'Pre-shipment invoice' },
  { value: 'sales_order',      label: 'Sales Order',        desc: 'Confirmed order before invoice' },
  { value: 'delivery_challan', label: 'Delivery Challan',   desc: 'Goods dispatch note' },
  { value: 'purchase_invoice', label: 'Purchase Invoice',   desc: 'Vendor/supplier bill' },
]

function applyDiscountRules(
  item: LineItem,
  allItems: LineItem[],
  rules: any[],
  partyId?: string,
): { discountPct: number; appliedRule?: string } {
  if (!rules.length) return { discountPct: item.discountPct }

  const today  = new Date()
  const dow    = today.getDay()  // 0=Sun
  const todayStr = today.toISOString().slice(0, 10)

  for (const rule of rules) {
    if (!rule.isActive) continue
    if (rule.validFrom && todayStr < rule.validFrom) continue
    if (rule.validTo   && todayStr > rule.validTo)   continue

    const cond = rule.conditions ?? {}

    // Day-of-week filter
    if (cond.dayOfWeek?.length && !cond.dayOfWeek.includes(dow)) continue

    // Party filter
    if (cond.partyIds?.length && partyId && !cond.partyIds.includes(partyId)) continue

    // Product filter
    if (cond.productIds?.length && item.productId && !cond.productIds.includes(item.productId)) continue

    // Min qty check
    const totalQty = allItems.filter(i => i.productId === item.productId).reduce((s, i) => s + i.qty, 0)
    if (cond.minQty && totalQty < cond.minQty) continue

    // Min amount check (cart total)
    const cartTotal = allItems.reduce((s, i) => s + i.qty * i.rate, 0)
    if (cond.minAmt && cartTotal < cond.minAmt) continue

    const action = rule.action ?? {}

    if (rule.type === 'percentage' && action.discountPct != null) {
      return { discountPct: action.discountPct, appliedRule: rule.name }
    }
    if (rule.type === 'flat' && action.discountAmt != null) {
      const itemTotal = item.qty * item.rate
      const pct = itemTotal > 0 ? Math.min(100, (action.discountAmt / itemTotal) * 100) : 0
      return { discountPct: parseFloat(pct.toFixed(2)), appliedRule: rule.name }
    }
    if (rule.type === 'qty_slab' && action.slabs?.length) {
      const qty = item.qty
      const slab = [...action.slabs].reverse().find((s: any) => qty >= s.minQty)
      if (slab) return { discountPct: slab.discountPct, appliedRule: rule.name }
    }
    // BOGO: mark 1 free unit — express as discountPct on the item
    if (rule.type === 'bogo' && action.freeQty != null && item.qty > action.freeQty) {
      const pct = (action.freeQty / item.qty) * 100
      return { discountPct: parseFloat(pct.toFixed(2)), appliedRule: rule.name }
    }
  }

  return { discountPct: item.discountPct }
}

const VALID_TXN_TYPES = new Set([
  'sale_invoice','purchase_invoice','quotation','proforma','sales_order','delivery_challan',
])

export function CreateInvoicePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const createInvoice = useCreateInvoice()
  const domainType = useAuthStore((s: any) => s.branch?.domainType ?? '')

  const { data: discountRules = [] } = useDiscountRules()
  const activeRules: any[] = useMemo(
    () => (discountRules as any[]).filter((r: any) => r.isActive),
    [discountRules]
  )

  const initialTxnType = VALID_TXN_TYPES.has(searchParams.get('txnType') ?? '')
    ? (searchParams.get('txnType') as string)
    : 'sale_invoice'

  const [txnType, setTxnType]   = useState(initialTxnType)
  const [items, setItems]       = useState<LineItem[]>([])
  const [party, setParty]       = useState<SelectedParty | null>(null)
  const [notes, setNotes]       = useState('')
  const [domainExtra, setDomainExtra] = useState<Record<string, unknown>>({})

  // Split payment — default single cash row
  const [splits, setSplits] = useState<PaymentSplit[]>([{ method: 'cash', amount: 0 }])

  // Hold Bill feature
  const [showHeldBills, setShowHeldBills] = useState(false)
  function getHeldBills(): Array<{ id: string; savedAt: string; label: string; items: LineItem[]; party: SelectedParty | null; notes: string; splits: PaymentSplit[]; domainExtra: Record<string, unknown> }> {
    try { return JSON.parse(localStorage.getItem('held_bills') ?? '[]') } catch { return [] }
  }
  const [heldBillsCount, setHeldBillsCount] = useState(() => getHeldBills().length)

  function holdCurrentBill() {
    if (items.length === 0) { toast('Nothing to hold — add items first', { icon: '💡' }); return }
    const held = getHeldBills()
    const newBill = {
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      label: party ? party.name : `Bill ${held.length + 1}`,
      items,
      party,
      notes,
      splits,
      domainExtra,
    }
    const updated = [...held, newBill]
    localStorage.setItem('held_bills', JSON.stringify(updated))
    setHeldBillsCount(updated.length)
    // Reset form
    setItems([])
    setParty(null)
    setNotes('')
    setSplits([{ method: 'cash', amount: 0 }])
    setDomainExtra({})
    toast.success('Bill held — start a new one')
  }

  function restoreHeldBill(id: string) {
    const held = getHeldBills()
    const bill = held.find(b => b.id === id)
    if (!bill) return
    setItems(bill.items)
    setParty(bill.party)
    setNotes(bill.notes)
    setSplits(bill.splits)
    setDomainExtra(bill.domainExtra)
    const updated = held.filter(b => b.id !== id)
    localStorage.setItem('held_bills', JSON.stringify(updated))
    setHeldBillsCount(updated.length)
    setShowHeldBills(false)
    toast.success(`Restored: ${bill.label}`)
  }

  function deleteHeldBill(id: string) {
    const updated = getHeldBills().filter(b => b.id !== id)
    localStorage.setItem('held_bills', JSON.stringify(updated))
    setHeldBillsCount(updated.length)
  }

  function patchDomainExtra(patch: Record<string, unknown>) {
    setDomainExtra(prev => ({ ...prev, ...patch }))
  }

  function reapplyRules(newItems: LineItem[], partyId?: string) {
    return newItems.map(item => {
      const { discountPct, appliedRule } = applyDiscountRules(item, newItems, activeRules, partyId)
      return { ...item, discountPct, appliedRule }
    })
  }

  function addProduct(product: {
    id: string; name: string; salePrice: number; gstRate: number
    unit: string; hsnSacCode: string | null
    stockOnHand?: number; trackStock?: boolean; meta?: Record<string, unknown>
  }) {
    // Low stock / out-of-stock warnings
    if (product.trackStock) {
      const qty = product.stockOnHand ?? 0
      if (qty <= 0) {
        toast.error(`${product.name} is out of stock`)
      } else if (qty <= 5) {
        toast(`Low stock: ${product.name} has only ${qty} ${product.unit} left`, { icon: '⚠️' })
      }
    }

    // Determine rate based on party price group
    let rate = product.salePrice
    const priceGroupsEnabled = localStorage.getItem('pos_price_groups') === 'true'
    if (priceGroupsEnabled && party) {
      const priceGroup = (party as any).meta?.priceGroup
      if (priceGroup === 'wholesale' && product.meta?.wholesalePrice) {
        rate = Number(product.meta.wholesalePrice)
      } else if (priceGroup === 'special' && product.meta?.specialPrice) {
        rate = Number(product.meta.specialPrice)
      }
    }

    setItems((prev) => {
      const existingIdx = prev.findIndex((i) => i.productId === product.id)
      let next: LineItem[]
      if (existingIdx >= 0) {
        next = prev.map((it, idx) => idx === existingIdx ? { ...it, qty: it.qty + 1 } : it)
      } else {
        next = [...prev, {
          key:         crypto.randomUUID(),
          productId:   product.id,
          description: product.name,
          qty:         1,
          rate,
          discountPct: 0,
          gstRate:     product.gstRate,
          unit:        product.unit,
          hsnSacCode:  product.hsnSacCode,
        }]
      }
      return reapplyRules(next, party?.id)
    })

    // Weighing scale: track last added product unit for scale button
    setLastAddedProduct(product.trackStock !== undefined ? product : null)
  }

  // Weighing scale support
  const [lastAddedProduct, setLastAddedProduct] = useState<{
    id: string; name: string; unit: string
  } | null>(null)
  const [scaleWeight, setScaleWeight] = useState<string | null>(null)
  const scaleEnabled = localStorage.getItem('pos_weighing_scale') === 'true'

  async function getWeightFromScale() {
    if (!('serial' in navigator)) {
      toast.error('Web Serial not supported. Use Chrome/Edge.')
      return
    }
    try {
      const port = await (navigator as any).serial.requestPort()
      await port.open({ baudRate: 9600 })
      const reader = port.readable.getReader()
      const { value } = await reader.read()
      reader.releaseLock()
      await port.close()
      const text = new TextDecoder().decode(value)
      const match = text.match(/(\d+\.?\d*)/)
      const weightStr = match?.[1]
      if (weightStr) {
        const weight = parseFloat(weightStr)
        setScaleWeight(weightStr)
        if (lastAddedProduct) {
          setItems(prev => prev.map(it =>
            it.productId === lastAddedProduct.id
              ? { ...it, qty: weight }
              : it
          ))
          toast.success(`Weight: ${weightStr} ${lastAddedProduct.unit}`)
        }
      } else {
        toast.error('Could not parse weight from scale')
      }
    } catch {
      toast.error('Failed to read from scale')
    }
  }

  function updateItem(key: string, patch: Partial<LineItem>) {
    setItems((prev) => {
      const next = prev.map((it) => it.key === key ? { ...it, ...patch } : it)
      // Re-apply rules only when qty changes (affects slab/bogo/minQty)
      if ('qty' in patch) return reapplyRules(next, party?.id)
      return next
    })
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((it) => it.key !== key))
  }

  const totals = useMemo(() => {
    const lines      = items.map(calcLine)
    const subtotal   = lines.reduce((s, l) => s + l.gross, 0)
    const discount   = lines.reduce((s, l) => s + l.discount, 0)
    const taxable    = lines.reduce((s, l) => s + l.taxable, 0)
    const gst        = lines.reduce((s, l) => s + l.gstAmt, 0)
    const beforeRound = taxable + gst
    const grandTotal  = Math.round(beforeRound)
    const roundOff    = grandTotal - beforeRound
    return { subtotal, discount, taxable, gst, grandTotal, roundOff }
  }, [items])

  // Load AI invoice draft if navigated from AI page
  useEffect(() => {
    const raw = localStorage.getItem('ai_invoice_draft')
    if (!raw) return
    localStorage.removeItem('ai_invoice_draft')
    try {
      const draft = JSON.parse(raw)
      if (draft.items?.length) setItems(draft.items)
      if (draft.party) setParty(draft.party)
      if (draft.notes) setNotes(draft.notes)
    } catch { /* ignore */ }
  }, [])

  // Auto-fill first split amount when grand total changes
  useEffect(() => {
    setSplits(prev => {
      const allocated = prev.slice(1).reduce((s, sp) => s + sp.amount, 0)
      const remaining = Math.max(0, totals.grandTotal - allocated)
      return [{ ...prev[0]!, amount: remaining }, ...prev.slice(1)]
    })
  }, [totals.grandTotal])

  // Customer display broadcast
  const broadcastRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    broadcastRef.current = new BroadcastChannel('pos_display')
    return () => broadcastRef.current?.close()
  }, [])

  useEffect(() => {
    broadcastRef.current?.postMessage({ items, grandTotal: totals.grandTotal, party })
  }, [items, totals.grandTotal, party])

  const customerDisplayEnabled = localStorage.getItem('pos_customer_display') === 'true'

  const splitsTotal = splits.reduce((s, sp) => s + sp.amount, 0)
  const splitsDiff  = Math.abs(splitsTotal - totals.grandTotal)
  const isUdhaar    = splits.some(sp => sp.method === 'credit' && sp.amount > 0)

  function addSplit() {
    setSplits(prev => [...prev, { method: 'cash', amount: 0 }])
  }
  function removeSplit(idx: number) {
    setSplits(prev => {
      const next = prev.filter((_, i) => i !== idx)
      return next.length ? next : [{ method: 'cash', amount: 0 }]
    })
  }
  function updateSplit(idx: number, patch: Partial<PaymentSplit>) {
    setSplits(prev => prev.map((sp, i) => i === idx ? { ...sp, ...patch } : sp))
  }

  const partyBalance     = party ? Number(party.balance) : 0
  const partyCreditLimit = party ? Number(party.creditLimit) : 0

  const creditSplitAmt = splits.filter(s => s.method === 'credit').reduce((s, sp) => s + sp.amount, 0)
  const creditLimitBreached = useMemo(() => {
    if (!party || !isUdhaar || partyCreditLimit <= 0) return false
    return (partyBalance + creditSplitAmt) > partyCreditLimit
  }, [party, isUdhaar, partyBalance, partyCreditLimit, creditSplitAmt])

  const creditRemaining = partyCreditLimit > 0
    ? Math.max(0, partyCreditLimit - partyBalance)
    : null

  async function handleSubmit() {
    if (items.length === 0) return
    if (creditLimitBreached) return
    if (splitsDiff > 0.5) return  // splits don't add up

    const validSplits = splits.filter(sp => sp.amount > 0)

    await createInvoice.mutateAsync({
      txnType,
      partyId: party?.id,
      items: items.map((it) => ({
        productId:   it.productId,
        description: it.description,
        qty:         it.qty,
        rate:        it.rate,
        discountPct: it.discountPct,
        gstRate:     it.gstRate,
        unit:        it.unit,
        hsnSacCode:  it.hsnSacCode ?? undefined,
      })),
      domainData: {
        is_udhaar: isUdhaar,
        source:    'pos',
        payment_splits: validSplits,
        ...domainExtra,
      },
      notes: notes || undefined,
    })

    navigate('/invoices')
  }

  const isPurchase    = txnType === 'purchase_invoice'
  const isProforma    = txnType === 'proforma' || txnType === 'quotation' || txnType === 'sales_order'
  const partyLabel    = isPurchase ? 'Supplier' : PATIENT_DOMAINS.has(domainType) ? 'Patient / Customer' : 'Customer'
  const isB2B         = B2B_DOMAINS.has(domainType)
  const selectedTxn   = TXN_OPTIONS.find(t => t.value === txnType)!

  return (
    <div>
      <PageHeader
        title={isB2B ? `New ${selectedTxn?.label ?? 'Document'}` : 'New Bill'}
        subtitle={isB2B ? selectedTxn?.desc : undefined}
      />

      <div className="p-8 grid grid-cols-3 gap-6">

        {/* ── Left: product search + line items ─────────────────────────── */}
        <div className="col-span-2 space-y-4">

          {/* Document type selector — B2B domains get full set; others see it when arriving via ?txnType= */}
          {(isB2B || initialTxnType !== 'sale_invoice') && (
            <div className="card p-4">
              <label className="label">Document Type</label>
              <div className="grid grid-cols-3 gap-2 mt-1">
                {TXN_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { setTxnType(opt.value); setItems([]); setParty(null) }}
                    className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                      txnType === opt.value
                        ? 'bg-primary-50 border-primary-400 text-primary-700 font-medium'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <ProductSearch onSelect={addProduct} />
          </div>

          <div className="card overflow-hidden">
            {items.length === 0 ? (
              <div className="text-center py-16 text-gray-400 text-sm">
                Search and add products to start billing
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 font-medium text-gray-500">Item</th>
                    <th className="text-center px-2 py-2.5 font-medium text-gray-500 w-32">Qty</th>
                    <th className="text-right px-2 py-2.5 font-medium text-gray-500 w-24">Rate</th>
                    <th className="text-right px-2 py-2.5 font-medium text-gray-500 w-20">Disc%</th>
                    <th className="text-right px-2 py-2.5 font-medium text-gray-500 w-20">GST%</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-24">Total</th>
                    <th className="w-8" scope="col" aria-label="Remove" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => {
                    const line = calcLine(item)
                    return (
                      <tr key={item.key} className="hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <div className="text-gray-800">{item.description}</div>
                          {item.appliedRule && (
                            <div className="flex items-center gap-1 mt-0.5 text-xs text-green-600">
                              <Tag className="w-3 h-3" />
                              {item.appliedRule}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              title="Decrease quantity"
                              onClick={() => updateItem(item.key, { qty: Math.max(1, item.qty - 1) })}
                              className="p-0.5 rounded hover:bg-gray-100"
                            ><Minus className="w-3 h-3" /></button>
                            <input
                              type="number"
                              min={1}
                              step={0.01}
                              value={item.qty}
                              aria-label="Quantity"
                              onChange={(e) => updateItem(item.key, { qty: Math.max(0.01, parseFloat(e.target.value) || 1) })}
                              className="w-14 text-center text-sm border border-gray-200 rounded px-1 py-0.5"
                            />
                            <button
                              type="button"
                              title="Increase quantity"
                              onClick={() => updateItem(item.key, { qty: item.qty + 1 })}
                              className="p-0.5 rounded hover:bg-gray-100"
                            ><Plus className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min={0}
                            value={item.rate}
                            aria-label="Rate"
                            onChange={(e) => updateItem(item.key, { rate: parseFloat(e.target.value) || 0 })}
                            className="w-20 text-right text-sm border border-gray-200 rounded px-1 py-0.5"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={item.discountPct}
                            aria-label="Discount %"
                            onChange={(e) => updateItem(item.key, { discountPct: parseFloat(e.target.value) || 0, appliedRule: undefined })}
                            className="w-14 text-right text-sm border border-gray-200 rounded px-1 py-0.5"
                          />
                        </td>
                        <td className="px-2 py-2 text-right text-gray-500">{item.gstRate}%</td>
                        <td className="px-4 py-2 text-right font-medium text-gray-900">
                          ₹{line.total.toFixed(2)}
                        </td>
                        <td className="pr-2">
                          <button
                            type="button"
                            title="Remove item"
                            onClick={() => removeItem(item.key)}
                            className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="card p-4">
            <label className="label">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any notes for this invoice..."
              className="input"
              rows={2}
            />
          </div>
        </div>

        {/* ── Right: customer + domain fields + totals + submit ──────────── */}
        <div className="space-y-4">

          <div className="card p-4">
            <label className="label">{partyLabel}</label>
            <PartySearch selected={party} onSelect={setParty} partyType={isPurchase ? 'supplier' : 'customer'} />
          </div>

          {/* Domain-specific fields */}
          <DomainInvoiceFields
            domainType={domainType}
            data={domainExtra}
            onChange={patchDomainExtra}
          />

          {/* Party / patient history */}
          {party && (
            <PartyHistory
              partyId={party.id}
              partyName={party.name}
              domainType={domainType}
            />
          )}

          {/* ── Payment splits ──────────────────────────────────────────── */}
          {!isPurchase && !isProforma && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Payment</h3>
                <button
                  type="button"
                  onClick={addSplit}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium"
                >
                  + Split payment
                </button>
              </div>

              <div className="space-y-2">
                {splits.map((sp, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <select
                      value={sp.method}
                      title={`Payment method ${idx + 1}`}
                      onChange={(e) => updateSplit(idx, { method: e.target.value })}
                      className="input flex-1 text-sm py-1.5"
                    >
                      {PAYMENT_METHODS.map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={sp.amount}
                      onChange={(e) => updateSplit(idx, { amount: parseFloat(e.target.value) || 0 })}
                      className="input w-28 text-right text-sm py-1.5"
                      placeholder="Amount"
                    />
                    {splits.length > 1 && (
                      <button
                        type="button"
                        title="Remove payment split"
                        onClick={() => removeSplit(idx)}
                        className="p-1 text-gray-300 hover:text-red-500 rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {splitsDiff > 0.5 && (
                <p className="mt-2 text-xs text-amber-600">
                  Payment total ₹{splitsTotal.toFixed(0)} ≠ bill total ₹{totals.grandTotal.toFixed(0)} (diff ₹{splitsDiff.toFixed(0)})
                </p>
              )}
            </div>
          )}

          <div className="card p-5 sticky top-20">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Bill summary</h3>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-600">
                <span>Subtotal</span>
                <span>₹{totals.subtotal.toFixed(2)}</span>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Discount</span>
                  <span>−₹{totals.discount.toFixed(2)}</span>
                </div>
              )}
              {totals.gst > 0 && (
                <div className="flex justify-between text-gray-600">
                  <span>GST</span>
                  <span>₹{totals.gst.toFixed(2)}</span>
                </div>
              )}
              {Math.abs(totals.roundOff) > 0.001 && (
                <div className="flex justify-between text-gray-500 text-xs">
                  <span>Round off</span>
                  <span>{totals.roundOff > 0 ? '+' : ''}₹{totals.roundOff.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 border-t border-gray-100 text-base font-bold text-gray-900">
                <span>Total</span>
                <span>₹{totals.grandTotal.toFixed(0)}</span>
              </div>
            </div>

            {/* Credit limit warning */}
            {party && partyCreditLimit > 0 && isUdhaar && (
              <div className={`mt-3 rounded-lg p-3 text-xs ${creditLimitBreached ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-gray-50 text-gray-500'}`}>
                {creditLimitBreached ? (
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>
                      Credit limit exceeded. Limit: ₹{partyCreditLimit.toLocaleString('en-IN')} · Balance: ₹{partyBalance.toLocaleString('en-IN')} · Remaining: ₹{(creditRemaining ?? 0).toLocaleString('en-IN')}
                    </span>
                  </div>
                ) : (
                  <span>Credit remaining: ₹{(creditRemaining ?? 0).toLocaleString('en-IN')} of ₹{partyCreditLimit.toLocaleString('en-IN')}</span>
                )}
              </div>
            )}

            {creditLimitBreached ? (
              <div className="mt-3 rounded-lg bg-red-100 border border-red-300 px-4 py-3 text-center">
                <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-red-700 mb-0.5">
                  <AlertTriangle className="w-4 h-4" /> Credit Limit Exceeded — Cannot Create Invoice
                </div>
                <p className="text-xs text-red-600">
                  Collect ₹{Math.ceil(partyBalance + creditSplitAmt - partyCreditLimit).toLocaleString('en-IN')} or raise the credit limit first.
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={items.length === 0 || createInvoice.isPending || splitsDiff > 0.5}
                className="btn-primary w-full justify-center mt-3"
              >
                {createInvoice.isPending ? 'Creating...' : `Create ${selectedTxn?.label ?? 'Invoice'} · ₹${totals.grandTotal.toFixed(0)}`}
              </button>
            )}

            {/* Hold Bill button */}
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={holdCurrentBill}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
              >
                <PauseCircle className="w-4 h-4" />
                Hold
                {heldBillsCount > 0 && (
                  <span className="ml-1 bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {heldBillsCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowHeldBills(true)}
                className="px-3 py-2 text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors"
              >
                Held Bills
              </button>
              {customerDisplayEnabled && (
                <button
                  type="button"
                  onClick={() => window.open('/customer-display', 'customer_display', 'width=800,height=600')}
                  className="px-3 py-2 text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg"
                  title="Open customer display"
                >
                  <Tv2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Weighing scale button */}
            {scaleEnabled && lastAddedProduct && ['kg', 'gm', 'g'].includes(lastAddedProduct.unit.toLowerCase()) && (
              <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-blue-700 font-medium">Last item: {lastAddedProduct.name}</span>
                  {scaleWeight && <span className="text-xs text-blue-600">Weight: {scaleWeight} {lastAddedProduct.unit}</span>}
                </div>
                <button
                  type="button"
                  onClick={getWeightFromScale}
                  className="w-full text-xs px-3 py-1.5 text-blue-700 bg-blue-100 hover:bg-blue-200 rounded font-medium"
                >
                  🔌 Get weight from scale
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Held Bills drawer */}
      {showHeldBills && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => setShowHeldBills(false)}>
          <div className="bg-white w-full max-w-lg rounded-t-2xl p-6 max-h-[70vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">Held Bills ({heldBillsCount})</h2>
              <button type="button" title="Close held bills" onClick={() => setShowHeldBills(false)} className="p-1 text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            {getHeldBills().length === 0 ? (
              <p className="text-center text-gray-400 py-8">No held bills</p>
            ) : (
              <div className="space-y-3">
                {getHeldBills().map(bill => (
                  <div key={bill.id} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
                    <div>
                      <div className="text-sm font-medium text-gray-800">{bill.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {bill.items.length} items · {new Date(bill.savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => restoreHeldBill(bill.id)}
                        className="px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 rounded-lg">
                        Restore
                      </button>
                      <button type="button" title="Delete held bill" onClick={() => { deleteHeldBill(bill.id); setHeldBillsCount(getHeldBills().length) }}
                        className="p-1.5 text-gray-300 hover:text-red-500 rounded">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
