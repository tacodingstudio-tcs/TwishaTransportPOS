// src/pages/InvoiceDetailPage.tsx
import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  useInvoice, useCancelInvoice, useRecordPayment, useSendReceipt,
  useConvertInvoice, useApproveInvoice, useRejectInvoice, useRequestApproval,
  useCreateReturn, useCreateDebitNote, useGenerateIrn, useGenerateEway,
} from '@/hooks/useApi'
import { PageHeader } from '@/components/layout/PageHeader'
import { TdsCard } from '@/components/transport/TdsCard'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { invoiceApi } from '@/lib/api'
import {
  Download, MessageCircle, XCircle, IndianRupee, Mail, Send,
  ArrowRight, CheckCircle, Clock, AlertCircle, RotateCcw, FileX,
  Zap, Truck, Printer,
} from 'lucide-react'
import { ThermalReceipt } from '@/components/invoice/ThermalReceipt'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const PIPELINE_NEXT: Record<string, string> = {
  quotation:        'sales_order',
  sales_order:      'sale_invoice',
  proforma:         'sale_invoice',
  delivery_challan: 'sale_invoice',
}
const PIPELINE_LABEL: Record<string, string> = {
  sales_order:  'Sales Order',
  sale_invoice: 'Tax Invoice',
}

const TXN_LABEL: Record<string, string> = {
  sale_invoice:     'Tax Invoice',
  purchase_invoice: 'Purchase Invoice',
  sale_return:      'Sale Return',
  purchase_return:  'Purchase Return',
  credit_note:      'Credit Note',
  debit_note:       'Debit Note',
  quotation:        'Quotation',
  proforma:         'Proforma Invoice',
  sales_order:      'Sales Order',
  delivery_challan: 'Delivery Challan',
}

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)
}

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: invoice, isLoading } = useInvoice(id!)
  const cancelInvoice  = useCancelInvoice()
  const recordPayment  = useRecordPayment()
  const convertMut     = useConvertInvoice()
  const approveMut     = useApproveInvoice()
  const rejectMut      = useRejectInvoice()
  const reqApprovalMut = useRequestApproval()
  const returnMut      = useCreateReturn()
  const debitNoteMut   = useCreateDebitNote()
  const irnMut         = useGenerateIrn()
  const ewayMut        = useGenerateEway()

  const [showRejectModal, setShowRejectModal] = useState(false)
  const [rejectNote, setRejectNote]           = useState('')

  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  // PDC fields
  const [chequeNo, setChequeNo]           = useState('')
  const [chequeDueDate, setChequeDueDate] = useState('')
  const [bankName, setBankName]           = useState('')

  const [showShareModal, setShareModal] = useState(false)
  const [shareChannel, setShareChannel] = useState<'whatsapp' | 'email'>('whatsapp')
  const [shareTo, setShareTo] = useState('')
  const sendReceipt = useSendReceipt()

  const [showEwayModal, setShowEwayModal] = useState(false)
  const [ewayVehicle, setEwayVehicle]     = useState('')
  const [ewayDistance, setEwayDistance]   = useState('')

  if (isLoading) return <div className="p-8 text-gray-400">Loading...</div>
  if (!invoice)  return <div className="p-8 text-gray-400">Invoice not found</div>

  const balanceDue = Number(invoice.grandTotal) - Number(invoice.paidAmt)
  const isSale     = invoice.txnType === 'sale_invoice'
  const isPurchase = invoice.txnType === 'purchase_invoice'
  const isActive   = invoice.status !== 'cancelled' && invoice.status !== 'converted'

  async function handlePayment() {
    const amount = Number(paymentAmount)
    if (amount <= 0) return
    await recordPayment.mutateAsync({
      id: id!,
      data: {
        amount,
        method: paymentMethod,
        ...(paymentMethod === 'cheque' && {
          refNo:         chequeNo || undefined,
          chequeNo:      chequeNo || undefined,
          chequeDueDate: chequeDueDate || undefined,
          bankName:      bankName || undefined,
          clearingStatus: chequeDueDate ? 'pending' : undefined,
        }),
      },
    })
    setShowPaymentModal(false)
    setPaymentAmount('')
    setChequeNo(''); setChequeDueDate(''); setBankName('')
  }

  async function handleReturn() {
    if (!confirm('Create a sale return for this invoice? Stock will be returned to inventory.')) return
    const ret = await returnMut.mutateAsync({ id: id! })
    navigate(`/invoices/${ret.id}`)
  }

  async function handleDebitNote() {
    if (!confirm('Create a debit note against this purchase invoice?')) return
    const dn = await debitNoteMut.mutateAsync({ id: id! })
    navigate(`/invoices/${dn.id}`)
  }

  function handleSendReceipt() {
    sendReceipt.mutate(
      { id: id!, data: { channel: shareChannel, to: shareTo || undefined } },
      { onSuccess: () => setShareModal(false) }
    )
  }

  async function handleCancel() {
    if (!confirm('Cancel this invoice? This will reverse stock and party balance.')) return
    await cancelInvoice.mutateAsync(id!)
    navigate('/invoices')
  }

  async function handleEway() {
    await ewayMut.mutateAsync({
      id: id!,
      data: {
        vehicleNo: ewayVehicle || undefined,
        distance:  ewayDistance ? Number(ewayDistance) : undefined,
      },
    })
    setShowEwayModal(false)
  }

  return (
    <div>
      <PageHeader
        title={`${TXN_LABEL[invoice.txnType] ?? invoice.txnType} · ${invoice.number}`}
        subtitle={format(new Date(invoice.date), 'd MMMM yyyy')}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <a href={invoiceApi.pdfUrl(id!)} target="_blank" rel="noreferrer" className="btn-ghost">
              <Download className="w-4 h-4" /> PDF
            </a>
            {isSale && Array.isArray((invoice.domainData as any)?.lr_ids) && (invoice.domainData as any).lr_ids.length > 0 && (
              <button type="button" onClick={() => window.open(`/transport/bills/${id}/print`, '_blank')} className="btn-primary">
                <Printer className="w-4 h-4" /> Freight statement
              </button>
            )}
            {isSale && (
              <button type="button" onClick={() => window.print()} className="btn-ghost">
                <Printer className="w-4 h-4" /> Receipt
              </button>
            )}
            <button type="button" onClick={() => { setShareTo(invoice.party?.phone ?? invoice.party?.email ?? ''); setShareModal(true) }} className="btn-ghost">
              <MessageCircle className="w-4 h-4" /> Share
            </button>

            {/* Pipeline: convert to next doc */}
            {PIPELINE_NEXT[invoice.txnType] && isActive && (
              <button type="button"
                onClick={() => convertMut.mutate({ id: id! }, { onSuccess: (r) => navigate(`/invoices/${r.invoice?.id ?? r.id}`) })}
                disabled={convertMut.isPending}
                className="btn-primary flex items-center gap-1 text-sm">
                <ArrowRight className="w-4 h-4" />
                Convert to {PIPELINE_LABEL[PIPELINE_NEXT[invoice.txnType]!] ?? PIPELINE_NEXT[invoice.txnType]?.replace('_', ' ')}
              </button>
            )}

            {/* Sale Return */}
            {isSale && isActive && invoice.status !== 'converted' && (
              <button type="button" onClick={handleReturn} disabled={returnMut.isPending}
                className="btn-ghost flex items-center gap-1 text-sm text-orange-600 border-orange-200 hover:bg-orange-50">
                <RotateCcw className="w-4 h-4" /> Sale Return
              </button>
            )}

            {/* Debit Note */}
            {isPurchase && isActive && (
              <button type="button" onClick={handleDebitNote} disabled={debitNoteMut.isPending}
                className="btn-ghost flex items-center gap-1 text-sm text-purple-600 border-purple-200 hover:bg-purple-50">
                <FileX className="w-4 h-4" /> Debit Note
              </button>
            )}

            {/* Generate IRN */}
            {isSale && isActive && !invoice.irnNo && (
              <button type="button" onClick={() => irnMut.mutate(id!)} disabled={irnMut.isPending}
                className="btn-ghost flex items-center gap-1 text-sm text-blue-600 border-blue-200 hover:bg-blue-50">
                <Zap className="w-4 h-4" /> {irnMut.isPending ? 'Generating…' : 'Gen IRN'}
              </button>
            )}

            {/* Generate E-Way Bill */}
            {isSale && isActive && !invoice.eWayBillNo && Number(invoice.grandTotal) >= 50000 && (
              <button type="button" onClick={() => setShowEwayModal(true)}
                className="btn-ghost flex items-center gap-1 text-sm text-teal-600 border-teal-200 hover:bg-teal-50">
                <Truck className="w-4 h-4" /> E-Way Bill
              </button>
            )}

            {/* Approval actions */}
            {invoice.approvalStatus === 'not_required' && isActive && (
              <button type="button" onClick={() => reqApprovalMut.mutate(id!)} disabled={reqApprovalMut.isPending}
                className="btn-ghost flex items-center gap-1 text-sm">
                <Clock className="w-4 h-4" /> Send for Approval
              </button>
            )}
            {invoice.approvalStatus === 'pending' && (
              <>
                <button type="button" onClick={() => approveMut.mutate({ id: id! })} disabled={approveMut.isPending}
                  className="btn-primary bg-green-600 hover:bg-green-700 flex items-center gap-1 text-sm">
                  <CheckCircle className="w-4 h-4" /> Approve
                </button>
                <button type="button" onClick={() => setShowRejectModal(true)}
                  className="btn-danger flex items-center gap-1 text-sm">
                  <AlertCircle className="w-4 h-4" /> Reject
                </button>
              </>
            )}

            {isActive && invoice.status !== 'paid' && (
              <button onClick={handleCancel} className="btn-danger">
                <XCircle className="w-4 h-4" /> Cancel
              </button>
            )}
          </div>
        }
      />

      <div className="p-8 grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-4">

          {/* Party + status */}
          <div className="card p-5 flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-500 mb-1">
                {isSale ? 'Billed to' : isPurchase ? 'Supplier' : 'Party'}
              </div>
              <div className="text-base font-semibold text-gray-900">
                {invoice.party?.name ?? 'Walk-in customer'}
              </div>
              {invoice.party?.phone && <div className="text-sm text-gray-500">{invoice.party.phone}</div>}
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <StatusBadge status={invoice.status} />
              {invoice.approvalStatus && invoice.approvalStatus !== 'not_required' && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  invoice.approvalStatus === 'approved' ? 'bg-green-100 text-green-700' :
                  invoice.approvalStatus === 'pending'  ? 'bg-yellow-100 text-yellow-700' :
                  invoice.approvalStatus === 'rejected' ? 'bg-red-100 text-red-700' : ''
                }`}>
                  {invoice.approvalStatus === 'approved' ? '✓ Approved' :
                   invoice.approvalStatus === 'pending'  ? '⏳ Pending Approval' : '✗ Rejected'}
                </span>
              )}
              {invoice.irnNo && (
                <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded font-mono cursor-help" title={invoice.irnNo}>
                  IRN: {String(invoice.irnNo).slice(0, 12)}…
                </span>
              )}
              {invoice.eWayBillNo && (
                <span className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded">
                  EWB: {invoice.eWayBillNo}
                  {invoice.eWayBillValidTo && ` (valid till ${format(new Date(invoice.eWayBillValidTo), 'dd MMM')})`}
                </span>
              )}
            </div>
          </div>

          {/* Freight bills: TDS the customer deducted */}
          {isSale && Number((invoice.domainData as any)?.tds_amount ?? 0) > 0 && <TdsCard invoiceId={id!} />}

          {/* Linked document */}
          {invoice.linkedInvoice && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 text-sm text-blue-700 flex items-center gap-2">
              <ArrowRight className="w-4 h-4" />
              Linked to: <a href={`/invoices/${invoice.linkedInvoice.id}`} className="font-medium hover:underline">{invoice.linkedInvoice.number}</a>
            </div>
          )}

          {/* Line items */}
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-500">Item</th>
                  <th className="text-center px-2 py-2.5 font-medium text-gray-500">Qty</th>
                  <th className="text-right px-2 py-2.5 font-medium text-gray-500">Rate</th>
                  <th className="text-right px-2 py-2.5 font-medium text-gray-500">GST</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-500">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item: any) => (
                  <tr key={item.id} className="table-row">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900">{item.description}</div>
                      {item.hsnSacCode && <div className="text-xs text-gray-400">HSN {item.hsnSacCode}</div>}
                    </td>
                    <td className="px-2 py-2.5 text-center text-gray-600">{Number(item.qty)} {item.unit}</td>
                    <td className="px-2 py-2.5 text-right text-gray-600">₹{Number(item.rate).toFixed(2)}</td>
                    <td className="px-2 py-2.5 text-right text-gray-600">
                      {Number(item.gstRate) > 0
                        ? `₹${(Number(item.cgstAmt) + Number(item.sgstAmt) + Number(item.igstAmt)).toFixed(2)}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold text-gray-900">
                      ₹{Number(item.total).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {invoice.notes && (
            <div className="card p-4 text-sm text-gray-600 bg-gray-50">
              <strong>Notes:</strong> {invoice.notes}
            </div>
          )}
        </div>

        {/* Totals + payment */}
        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Amount summary</h3>
            <div className="space-y-2 text-sm">
              <Row label="Subtotal"  value={formatINR(Number(invoice.subtotal))} />
              {Number(invoice.discountAmt) > 0 && <Row label="Discount" value={`−${formatINR(Number(invoice.discountAmt))}`} green />}
              {Number(invoice.cgstTotal) > 0 && <Row label="CGST"  value={formatINR(Number(invoice.cgstTotal))} />}
              {Number(invoice.sgstTotal) > 0 && <Row label="SGST"  value={formatINR(Number(invoice.sgstTotal))} />}
              {Number(invoice.igstTotal) > 0 && <Row label="IGST"  value={formatINR(Number(invoice.igstTotal))} />}
              <div className="flex justify-between pt-2 border-t border-gray-100 text-base font-bold text-gray-900">
                <span>Grand total</span>
                <span>{formatINR(Number(invoice.grandTotal))}</span>
              </div>
              <Row label="Paid" value={formatINR(Number(invoice.paidAmt))} green />
              {balanceDue > 0.01 && <Row label="Balance due" value={formatINR(balanceDue)} red bold />}
            </div>

            {balanceDue > 0.01 && isActive && (
              <button onClick={() => { setPaymentAmount(String(balanceDue.toFixed(2))); setShowPaymentModal(true) }}
                className="btn-primary w-full justify-center mt-4">
                <IndianRupee className="w-4 h-4" /> {isPurchase ? 'Pay Supplier' : 'Record Payment'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Share modal */}
      {showShareModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Send Receipt</h3>
            <div className="flex gap-2 mb-4">
              {(['whatsapp','email'] as const).map(ch => (
                <button key={ch} type="button" onClick={() => setShareChannel(ch)}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    shareChannel === ch ? (ch === 'whatsapp' ? 'bg-green-50 border-green-400 text-green-700' : 'bg-blue-50 border-blue-400 text-blue-700')
                    : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>
                  {ch === 'whatsapp' ? <MessageCircle className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
                  {ch === 'whatsapp' ? 'WhatsApp' : 'Email'}
                </button>
              ))}
            </div>
            <input type={shareChannel === 'whatsapp' ? 'tel' : 'email'} value={shareTo}
              onChange={e => setShareTo(e.target.value)}
              placeholder={shareChannel === 'whatsapp' ? '91XXXXXXXXXX' : 'customer@email.com'}
              className="input mb-4" />
            <div className="flex gap-2">
              <button type="button" onClick={() => setShareModal(false)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button type="button" onClick={handleSendReceipt} disabled={sendReceipt.isPending} className="btn-primary flex-1 justify-center">
                <Send className="w-4 h-4" /> {sendReceipt.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment modal with PDC support */}
      {showPaymentModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-xl space-y-3">
            <h3 className="text-base font-semibold text-gray-900">{isPurchase ? 'Pay Supplier' : 'Record Payment'}</h3>
            <div>
              <label className="label">Amount</label>
              <input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} className="input" autoFocus />
            </div>
            <div>
              <label className="label">Payment Method</label>
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="input">
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank Transfer / NEFT</option>
                <option value="cheque">Cheque / PDC</option>
              </select>
            </div>
            {paymentMethod === 'cheque' && (
              <div className="space-y-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs font-medium text-amber-700">Cheque / Post-Dated Cheque Details</p>
                <input type="text" placeholder="Cheque No." value={chequeNo} onChange={e => setChequeNo(e.target.value)} className="input text-sm" />
                <input type="date" placeholder="Due Date (for PDC)" value={chequeDueDate} onChange={e => setChequeDueDate(e.target.value)} className="input text-sm" />
                <input type="text" placeholder="Bank Name" value={bankName} onChange={e => setBankName(e.target.value)} className="input text-sm" />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowPaymentModal(false)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={handlePayment} disabled={recordPayment.isPending} className="btn-primary flex-1 justify-center">
                {recordPayment.isPending ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* E-Way Bill modal */}
      {showEwayModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-xl space-y-3">
            <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Truck className="w-5 h-5 text-teal-600" /> Generate E-Way Bill
            </h3>
            <div>
              <label className="label">Vehicle Number</label>
              <input type="text" placeholder="e.g. GJ05AB1234" value={ewayVehicle} onChange={e => setEwayVehicle(e.target.value)} className="input" />
            </div>
            <div>
              <label className="label">Distance (km)</label>
              <input type="number" placeholder="Approx. distance" value={ewayDistance} onChange={e => setEwayDistance(e.target.value)} className="input" />
            </div>
            <p className="text-xs text-gray-400">Sandbox mode — connects to NIC portal when GSTIN credentials are configured in branch settings.</p>
            <div className="flex gap-2">
              <button onClick={() => setShowEwayModal(false)} className="btn-ghost flex-1 justify-center">Cancel</button>
              <button onClick={handleEway} disabled={ewayMut.isPending} className="btn-primary flex-1 justify-center">
                {ewayMut.isPending ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-5 w-full max-w-md shadow-xl space-y-4">
            <h3 className="font-semibold text-red-600 flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> Reject Invoice
            </h3>
            <textarea rows={3} value={rejectNote} onChange={e => setRejectNote(e.target.value)}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              placeholder="Reason for rejection (required)" />
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowRejectModal(false)} className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
              <button type="button" disabled={!rejectNote.trim() || rejectMut.isPending}
                onClick={() => rejectMut.mutate({ id: id!, note: rejectNote }, { onSuccess: () => setShowRejectModal(false) })}
                className="flex-1 bg-red-600 text-white rounded py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {rejectMut.isPending ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Thermal receipt — hidden on screen, shown when printing */}
      {isSale && (
        <ThermalReceipt invoice={invoice} />
      )}
    </div>
  )
}

function Row({ label, value, green, red, bold }: {
  label: string; value: string; green?: boolean; red?: boolean; bold?: boolean
}) {
  return (
    <div className={`flex justify-between ${green ? 'text-green-600' : red ? 'text-red-600' : 'text-gray-600'} ${bold ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
