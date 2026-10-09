// src/pages/inventory/PurchaseOrderDetailPage.tsx
import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePurchaseOrder, useCancelPurchaseOrder, useCreateGRN, useRecordPOPayment } from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { ArrowLeft, Truck, X, IndianRupee, FileText } from 'lucide-react'

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600', sent: 'bg-blue-100 text-blue-700',
  partial: 'bg-amber-100 text-amber-700', received: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
}

function ReceiveGRNModal({ po, onClose }: { po: any; onClose: () => void }) {
  const createGRN = useCreateGRN()
  const [invoiceNo, setInvoiceNo]     = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [grnDate, setGrnDate]         = useState(new Date().toISOString().split('T')[0])
  const [qtys, setQtys] = useState<Record<string, string>>(
    Object.fromEntries((po.items ?? []).map((item: any) => [item.id, '']))
  )

  const pending = po.items?.filter((item: any) => Number(item.orderedQty) > Number(item.receivedQty))

  async function handleSubmit() {
    const receiptItems = pending
      .filter((item: any) => Number(qtys[item.id] ?? 0) > 0)
      .map((item: any) => ({
        purchaseOrderItemId: item.id,
        productId:          item.productId,
        description:        item.description,
        receivedQty:        Number(qtys[item.id]),
        unit:               item.unit,
        rate:               Number(item.rate),
        total:              Number(qtys[item.id]) * Number(item.rate),
      }))

    if (receiptItems.length === 0) return

    await createGRN.mutateAsync({
      purchaseOrderId: po.id,
      grnDate,
      invoiceNo:   invoiceNo || undefined,
      invoiceDate: invoiceDate || undefined,
      items:       receiptItems,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Record goods receipt</h3>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <label className="label" htmlFor="grn-date">GRN date</label>
            <input id="grn-date" type="date" value={grnDate} onChange={(e) => setGrnDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="grn-inv-no">Supplier invoice no.</label>
            <input id="grn-inv-no" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} className="input" placeholder="INV-1234" />
          </div>
          <div>
            <label className="label" htmlFor="grn-inv-date">Invoice date</label>
            <input id="grn-inv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="input" />
          </div>
        </div>

        <div className="border border-gray-200 rounded-lg overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Item</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Ordered</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Received</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Pending</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Receive now</th>
              </tr>
            </thead>
            <tbody>
              {pending?.map((item: any) => {
                const pend = Number(item.orderedQty) - Number(item.receivedQty)
                return (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="px-4 py-2.5 text-gray-800">{item.description}</td>
                    <td className="px-4 py-2.5 text-right text-gray-500">{Number(item.orderedQty)} {item.unit}</td>
                    <td className="px-4 py-2.5 text-right text-gray-500">{Number(item.receivedQty)}</td>
                    <td className="px-4 py-2.5 text-right text-amber-600 font-medium">{pend}</td>
                    <td className="px-4 py-2.5 text-right">
                      <input
                        type="number"
                        min={0}
                        max={pend}
                        placeholder="0"
                        value={qtys[item.id] ?? ''}
                        onChange={(e) => setQtys({ ...qtys, [item.id]: e.target.value })}
                        className="input w-24 text-right text-sm"
                        aria-label={`Receive qty for ${item.description}`}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex gap-2 mt-4">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={createGRN.isPending} className="btn-primary flex-1 justify-center">
            <Truck className="w-4 h-4" />
            {createGRN.isPending ? 'Recording...' : 'Record Receipt'}
          </button>
        </div>
      </div>
    </div>
  )
}

function RecordPaymentModal({ po, onClose }: { po: any; onClose: () => void }) {
  const recordPayment = useRecordPOPayment()
  const outstanding   = Number(po.grandTotal) - Number(po.paidAmt)

  const [amount,      setAmount]      = useState(String(outstanding.toFixed(2)))
  const [paymentMode, setPaymentMode] = useState('cash')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [referenceNo, setReferenceNo] = useState('')
  const [notes,       setNotes]       = useState('')

  async function handleSubmit() {
    if (!amount || Number(amount) <= 0) return
    await recordPayment.mutateAsync({
      id: po.id,
      amount:      Number(amount),
      paymentMode,
      paymentDate,
      referenceNo: referenceNo || undefined,
      notes:       notes || undefined,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Record payment</h3>
        <p className="text-xs text-gray-500 mb-4">
          Outstanding: <span className="font-semibold text-gray-800">{formatINR(outstanding)}</span>
          {' '}— an expense entry will be created automatically.
        </p>

        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="pay-amount">Amount paid (₹) *</label>
            <input
              id="pay-amount"
              type="number"
              min={0.01}
              max={outstanding}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="label" htmlFor="pay-mode">Payment mode</label>
            <select id="pay-mode" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)} className="input">
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank">Bank transfer / NEFT</option>
              <option value="credit">Credit / cheque</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pay-date">Payment date</label>
            <input id="pay-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="pay-ref">Reference / UTR no.</label>
            <input id="pay-ref" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} className="input" placeholder="UTR123456" />
          </div>
          <div>
            <label className="label" htmlFor="pay-notes">Notes</label>
            <input id="pay-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="input" placeholder="Optional" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={recordPayment.isPending || !amount || Number(amount) <= 0}
            className="btn-primary flex-1 justify-center"
          >
            {recordPayment.isPending ? 'Recording…' : 'Record Payment'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function PurchaseOrderDetailPage() {
  const { id }         = useParams<{ id: string }>()
  const navigate       = useNavigate()
  const { data: po, isLoading } = usePurchaseOrder(id!)
  const cancelPO           = useCancelPurchaseOrder()
  const [showGRN, setShowGRN]         = useState(false)
  const [showPayment, setShowPayment] = useState(false)

  if (isLoading) return <div className="p-8 text-gray-400">Loading...</div>
  if (!po) return <div className="p-8 text-gray-400">Purchase order not found.</div>

  const canReceive    = ['sent', 'partial', 'draft'].includes(po.status)
  const canCancel     = !['received', 'cancelled'].includes(po.status)
  const hasPending    = po.items?.some((i: any) => Number(i.orderedQty) > Number(i.receivedQty))
  const outstanding   = Number(po.grandTotal) - Number(po.paidAmt ?? 0)
  const canPay        = po.status !== 'cancelled' && outstanding > 0.01
  const hasReceived   = ['partial', 'received'].includes(po.status)

  function handleCreatePurchaseBill() {
    // Navigate to new purchase invoice pre-filled with PO supplier
    const params = new URLSearchParams({ txnType: 'purchase_invoice' })
    if (po.party?.id) params.set('partyId', po.party.id)
    if (po.party?.name) params.set('partyName', po.party.name)
    navigate(`/invoices/new?${params.toString()}`)
  }

  return (
    <div>
      <PageHeader
        title={`PO: ${po.poNo}`}
        subtitle={po.party?.name ?? 'No supplier'}
        action={
          <div className="flex gap-2">
            {canReceive && hasPending && (
              <button type="button" onClick={() => setShowGRN(true)} className="btn-primary">
                <Truck className="w-4 h-4" /> Receive Stock
              </button>
            )}
            {hasReceived && (
              <button type="button" onClick={handleCreatePurchaseBill} className="btn-secondary">
                <FileText className="w-4 h-4" /> Create Purchase Bill
              </button>
            )}
            {canPay && (
              <button type="button" onClick={() => setShowPayment(true)} className="btn-ghost">
                <IndianRupee className="w-4 h-4" /> Record Payment
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => { if (confirm('Cancel this PO?')) cancelPO.mutate(po.id, { onSuccess: () => navigate('/inventory/purchase-orders') }) }}
                className="btn-ghost text-red-600 hover:bg-red-50"
              >
                <X className="w-4 h-4" /> Cancel PO
              </button>
            )}
          </div>
        }
      />

      <div className="p-8 max-w-4xl space-y-6">
        {/* Meta */}
        <div className="card p-5 grid grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Status</div>
            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[po.status]}`}>{po.status}</span>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">PO Date</div>
            <div className="text-sm font-medium text-gray-800">{new Date(po.poDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Expected By</div>
            <div className="text-sm font-medium text-gray-800">{po.expectedDate ? new Date(po.expectedDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-0.5">Grand Total</div>
            <div className="text-sm font-semibold text-gray-900">{formatINR(Number(po.grandTotal))}</div>
          </div>
        </div>

        {/* Line items */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 font-medium text-sm text-gray-700">Line Items</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Item</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Ordered</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Received</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Pending</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Rate</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Total</th>
              </tr>
            </thead>
            <tbody>
              {po.items?.map((item: any) => {
                const pending = Number(item.orderedQty) - Number(item.receivedQty)
                return (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="px-5 py-3 text-gray-800">{item.description}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{Number(item.orderedQty)} {item.unit}</td>
                    <td className="px-5 py-3 text-right text-green-600 font-medium">{Number(item.receivedQty)}</td>
                    <td className={`px-5 py-3 text-right font-medium ${pending > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{pending > 0 ? pending : '—'}</td>
                    <td className="px-5 py-3 text-right text-gray-600">{formatINR(Number(item.rate))}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-800">{formatINR(Number(item.total))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {/* Totals footer */}
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 text-sm space-y-1 text-right">
            <div className="text-gray-500">Subtotal: <span className="text-gray-700 font-medium ml-6">{formatINR(Number(po.subtotal))}</span></div>
            <div className="text-gray-500">GST: <span className="text-gray-700 font-medium ml-6">{formatINR(Number(po.cgstTotal) + Number(po.sgstTotal) + Number(po.igstTotal))}</span></div>
            <div className="font-semibold text-gray-900">Grand Total: <span className="ml-6">{formatINR(Number(po.grandTotal))}</span></div>
            {Number(po.paidAmt) > 0 && (
              <>
                <div className="text-green-600">Paid: <span className="font-medium ml-6">{formatINR(Number(po.paidAmt))}</span></div>
                <div className={`font-semibold ${outstanding > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {outstanding > 0 ? 'Outstanding' : 'Fully Paid'}:
                  <span className="ml-6">{outstanding > 0 ? formatINR(outstanding) : '✓'}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {po.notes && (
          <div className="card p-4 text-sm text-gray-600">
            <span className="font-medium text-gray-700">Notes: </span>{po.notes}
          </div>
        )}

        <button type="button" onClick={() => navigate(-1)} className="btn-ghost gap-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
      </div>

      {showGRN     && <ReceiveGRNModal     po={po} onClose={() => setShowGRN(false)} />}
      {showPayment && <RecordPaymentModal  po={po} onClose={() => setShowPayment(false)} />}
    </div>
  )
}
