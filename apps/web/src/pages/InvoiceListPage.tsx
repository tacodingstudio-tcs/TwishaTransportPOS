// src/pages/InvoiceListPage.tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useInvoices } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Plus, Search } from 'lucide-react'
import { format } from 'date-fns'

const B2B_DOMAINS = new Set([
  'wholesale', 'enterprise', 'electronics', 'textile', 'hardware',
  'printing', 'jewellery', 'automobile', 'agri', 'catering', 'transport',
])

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

const ALL_DOC_TYPE_TABS = [
  { key: '',                label: 'All',          b2bOnly: false },
  { key: 'sale_invoice',    label: 'Sales',        b2bOnly: false },
  { key: 'purchase_invoice',label: 'Purchases',    b2bOnly: false },
  { key: 'quotation',       label: 'Quotations',   b2bOnly: true  },
  { key: 'proforma',        label: 'Proforma',     b2bOnly: true  },
  { key: 'sales_order',     label: 'Orders',       b2bOnly: true  },
  { key: 'delivery_challan',label: 'Challans',     b2bOnly: true  },
  { key: 'credit_note',     label: 'Credit Notes', b2bOnly: true  },
  { key: 'debit_note',      label: 'Debit Notes',  b2bOnly: true  },
  { key: 'sale_return',     label: 'Returns',      b2bOnly: false },
]

const TXN_BADGE: Record<string, string> = {
  sale_invoice:     'bg-blue-100 text-blue-700',
  purchase_invoice: 'bg-purple-100 text-purple-700',
  quotation:        'bg-yellow-100 text-yellow-700',
  proforma:         'bg-indigo-100 text-indigo-700',
  sales_order:      'bg-cyan-100 text-cyan-700',
  delivery_challan: 'bg-orange-100 text-orange-700',
  credit_note:      'bg-green-100 text-green-700',
  debit_note:       'bg-pink-100 text-pink-700',
  sale_return:      'bg-red-100 text-red-700',
  purchase_return:  'bg-red-100 text-red-700',
}

export function InvoiceListPage() {
  const navigate = useNavigate()
  const [search, setSearch]   = useState('')
  const [status, setStatus]   = useState('')
  const [txnType, setTxnType] = useState('')
  const [page, setPage]       = useState(1)
  const domainType = useAuthStore((s: any) => s.branch?.domainType ?? '')
  const isB2B = B2B_DOMAINS.has(domainType)

  const { data, isLoading } = useInvoices({
    search:  search  || undefined,
    status:  status  || undefined,
    txnType: txnType || undefined,
    page,
    limit: 20,
  })

  function handleTabChange(key: string) {
    setTxnType(key)
    setPage(1)
  }

  return (
    <div>
      <PageHeader
        title={isB2B ? 'Documents' : 'Bills'}
        subtitle={data?.meta ? `${data.meta.total} total` : undefined}
        action={
          <div className="flex gap-2">
            {txnType === 'purchase_invoice' && (
              <button
                type="button"
                onClick={() => navigate('/invoices/new?txnType=purchase_invoice')}
                className="btn-ghost"
              >
                <Plus className="w-4 h-4" /> New Purchase Bill
              </button>
            )}
            <Link to="/invoices/new" className="btn-primary">
              <Plus className="w-4 h-4" /> {isB2B ? 'New Document' : 'New Bill'}
            </Link>
          </div>
        }
      />

      <div className="p-8 space-y-4">

        {/* Document type tabs */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {ALL_DOC_TYPE_TABS.filter(t => isB2B || !t.b2bOnly).map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={`px-3 py-1.5 rounded text-sm font-medium whitespace-nowrap transition-colors ${
                txnType === tab.key
                  ? 'bg-primary-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search + status filter */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              placeholder="Search by number, customer…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1) }}
              className="input pl-9"
            />
          </div>
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1) }}
            className="input w-44"
            title="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="paid">Paid</option>
            <option value="partial">Partially paid</option>
            <option value="converted">Converted</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-5 py-3 font-medium text-gray-500">Number</th>
                {!txnType && <th className="text-left px-5 py-3 font-medium text-gray-500">Type</th>}
                <th className="text-left px-5 py-3 font-medium text-gray-500">Party</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Date</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500">Amount</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && data?.data?.length === 0 && (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">No documents found</td></tr>
              )}
              {data?.data?.map((inv: any) => (
                <tr key={inv.id} className="table-row">
                  <td className="px-5 py-3">
                    <Link to={`/invoices/${inv.id}`} className="font-medium text-primary-600 hover:underline">
                      {inv.number}
                    </Link>
                  </td>
                  {!txnType && (
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TXN_BADGE[inv.txnType] ?? 'bg-gray-100 text-gray-600'}`}>
                        {inv.txnType?.replace(/_/g, ' ')}
                      </span>
                    </td>
                  )}
                  <td className="px-5 py-3 text-gray-700">{inv.party?.name ?? 'Walk-in'}</td>
                  <td className="px-5 py-3 text-gray-500">{format(new Date(inv.date), 'd MMM yyyy')}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-900">
                    {formatINR(Number(inv.grandTotal))}
                  </td>
                  <td className="px-5 py-3"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data?.meta && data.meta.totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Page {data.meta.page} of {data.meta.totalPages}</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn-ghost disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= data.meta.totalPages} onClick={() => setPage(p => p + 1)} className="btn-ghost disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
