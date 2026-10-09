import { useState } from 'react'
import { Link } from 'react-router-dom'
import { usePendingApprovals, useApproveInvoice, useRejectInvoice } from '@/hooks/useApi'
import { format } from 'date-fns'
import { CheckCircle, XCircle, Clock, AlertCircle } from 'lucide-react'
const formatINR = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

export default function ApprovalsPage() {
  const { data: pending = [], isLoading } = usePendingApprovals()
  const approveMut = useApproveInvoice()
  const rejectMut  = useRejectInvoice()

  const [rejectingId, setRejectingId]   = useState<string | null>(null)
  const [rejectNote, setRejectNote]     = useState('')
  const [approveNote, setApproveNote]   = useState<Record<string, string>>({})

  const docs = pending as any[]

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Clock className="w-6 h-6 text-yellow-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pending Approvals</h1>
          <p className="text-sm text-gray-500">{docs.length} document{docs.length !== 1 ? 's' : ''} awaiting approval</p>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <CheckCircle className="w-12 h-12 mx-auto mb-3 text-green-300" />
          <p className="font-medium text-gray-500">All caught up — no pending approvals</p>
        </div>
      ) : (
        <div className="space-y-3">
          {docs.map((doc: any) => (
            <div key={doc.id} className="bg-white border rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                      {doc.txnType.replace('_', ' ')}
                    </span>
                    <Link to={`/invoices/${doc.id}`} className="font-semibold text-blue-600 hover:underline">
                      {doc.number}
                    </Link>
                    <span className="text-gray-400 text-sm">{format(new Date(doc.date), 'dd MMM yyyy')}</span>
                  </div>
                  <div className="text-sm text-gray-600">
                    Party: <span className="font-medium">{doc.party?.name ?? 'Unknown'}</span>
                  </div>
                  <div className="text-sm text-gray-500">
                    Requested by: {doc.createdByUser?.name} · {format(new Date(doc.createdAt), 'dd MMM yyyy, h:mm a')}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold text-gray-900">{formatINR(doc.grandTotal)}</div>
                </div>
              </div>

              {/* Approve note */}
              <input type="text"
                value={approveNote[doc.id] ?? ''}
                onChange={e => setApproveNote(prev => ({ ...prev, [doc.id]: e.target.value }))}
                placeholder="Approval note (optional)"
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />

              <div className="flex gap-2">
                <button type="button"
                  onClick={() => approveMut.mutate({ id: doc.id, note: approveNote[doc.id] })}
                  disabled={approveMut.isPending}
                  className="flex-1 flex items-center justify-center gap-2 bg-green-600 text-white py-2 rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  <CheckCircle className="w-4 h-4" /> Approve
                </button>
                <button type="button"
                  onClick={() => { setRejectingId(doc.id); setRejectNote('') }}
                  className="flex-1 flex items-center justify-center gap-2 border border-red-300 text-red-600 py-2 rounded text-sm font-medium hover:bg-red-50">
                  <XCircle className="w-4 h-4" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject modal */}
      {rejectingId && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg p-5 w-full max-w-md shadow-xl space-y-4">
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="w-5 h-5" />
              <h3 className="font-semibold">Reject Document</h3>
            </div>
            <label htmlFor="reject-note" className="text-sm text-gray-600 block">
              Reason for rejection (required)
            </label>
            <textarea id="reject-note"
              value={rejectNote}
              onChange={e => setRejectNote(e.target.value)}
              rows={3}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              placeholder="e.g. Amount exceeds approved budget, please resubmit with PO reference" />
            <div className="flex gap-2">
              <button type="button" onClick={() => setRejectingId(null)}
                className="flex-1 border rounded py-2 text-sm hover:bg-gray-50">Cancel</button>
              <button type="button"
                disabled={!rejectNote.trim() || rejectMut.isPending}
                onClick={() => rejectMut.mutate({ id: rejectingId, note: rejectNote }, { onSuccess: () => setRejectingId(null) })}
                className="flex-1 bg-red-600 text-white rounded py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {rejectMut.isPending ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
