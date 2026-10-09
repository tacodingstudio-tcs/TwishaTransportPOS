import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useInvoices, useConvertInvoice } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { format } from 'date-fns'
import { FileText, ArrowRight, Plus, RefreshCw, CheckCircle } from 'lucide-react'

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n)

// Which tabs are relevant per domain
const DOMAIN_TABS: Record<string, string[]> = {
  wholesale:     ['quotation','sales_order','delivery_challan'],
  enterprise:    ['quotation','sales_order','proforma','delivery_challan'],
  electronics:   ['quotation','sales_order','delivery_challan'],
  textile:       ['quotation','sales_order','delivery_challan'],
  hardware:      ['quotation','sales_order'],
  printing:      ['quotation','proforma','delivery_challan'],
  catering:      ['quotation','proforma'],
  sweet:         ['quotation','sales_order'],
  jewellery:     ['quotation','proforma'],
  automobile:    ['quotation','proforma'],
  agri:          ['quotation','sales_order','delivery_challan'],
  manufacturing: ['quotation','sales_order','delivery_challan'],
  construction:  ['quotation','proforma'],
  furniture:     ['quotation','proforma'],
  optical:       ['quotation','proforma'],
}
const DEFAULT_TABS = ['quotation','proforma']

const ALL_TABS = [
  { key: 'quotation',        label: 'Quotations',        next: 'Sales Order' },
  { key: 'sales_order',      label: 'Sales Orders',      next: 'Invoice'     },
  { key: 'proforma',         label: 'Proforma',          next: 'Invoice'     },
  { key: 'delivery_challan', label: 'Delivery Challans', next: 'Invoice'     },
]

const STATUS_COLORS: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  confirmed: 'bg-blue-100 text-blue-700',
  converted: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
}

export default function DocumentPipelinePage() {
  const navigate   = useNavigate()
  const { branch } = useAuthStore()
  const domainType = (branch as any)?.domainType ?? ''

  const allowedKeys = DOMAIN_TABS[domainType] ?? DEFAULT_TABS
  const visibleTabs = ALL_TABS.filter(t => allowedKeys.includes(t.key))

  const [tab, setTab]  = useState(visibleTabs[0]?.key ?? 'quotation')
  const convertMut     = useConvertInvoice()
  const activeTab      = visibleTabs.find(t => t.key === tab) ?? visibleTabs[0]!

  const { data, isLoading } = useInvoices({ txnType: tab, limit: 50 })
  const docs = (data as any)?.data ?? []

  async function handleConvert(id: string) {
    const result = await convertMut.mutateAsync({ id })
    navigate(`/invoices/${result.invoice?.id ?? result.id}`)
  }

  // Build pipeline steps for this domain
  const pipelineSteps = [
    ...(allowedKeys.includes('quotation')        ? [{ label: 'Quotation',        color: 'bg-purple-100 text-purple-700' }] : []),
    ...(allowedKeys.includes('sales_order')       ? [{ label: 'Sales Order',      color: 'bg-blue-100 text-blue-700'   }] : []),
    ...(allowedKeys.includes('proforma')          ? [{ label: 'Proforma',         color: 'bg-indigo-100 text-indigo-700'}] : []),
    ...(allowedKeys.includes('delivery_challan')  ? [{ label: 'Delivery Challan', color: 'bg-yellow-100 text-yellow-700'}] : []),
    { label: 'Tax Invoice', color: 'bg-green-100 text-green-700' },
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Document Pipeline</h1>
          <p className="text-sm text-gray-500 mt-1">Convert documents through your sales workflow</p>
        </div>
        <Link to="/invoices/new" className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Document
        </Link>
      </div>

      {/* Pipeline flow visual — domain-specific */}
      <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm overflow-x-auto">
        {pipelineSteps.map((step, i) => (
          <div key={step.label} className="flex items-center gap-2 whitespace-nowrap">
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${step.color}`}>{step.label}</span>
            {i < pipelineSteps.length - 1 && <ArrowRight className="w-4 h-4 text-gray-400" />}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 flex gap-6">
        {visibleTabs.map(t => (
          <button key={t.key} type="button"
            onClick={() => setTab(t.key)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            No {activeTab.label.toLowerCase()} found.
            <Link to="/invoices/new" className="text-blue-600 hover:underline ml-1">Create one</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Number</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Party</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Approval</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.map((doc: any) => (
                <tr key={doc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/invoices/${doc.id}`} className="font-medium text-blue-600 hover:underline">
                      {doc.number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{format(new Date(doc.date), 'dd MMM yyyy')}</td>
                  <td className="px-4 py-3 text-gray-700">{doc.party?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatINR(Number(doc.grandTotal))}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[doc.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {doc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {doc.approvalStatus && doc.approvalStatus !== 'not_required' && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        doc.approvalStatus === 'approved' ? 'bg-green-100 text-green-700' :
                        doc.approvalStatus === 'pending'  ? 'bg-yellow-100 text-yellow-700' :
                        doc.approvalStatus === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-gray-100 text-gray-500'
                      }`}>{doc.approvalStatus}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {doc.status !== 'converted' && doc.status !== 'cancelled' ? (
                      <button type="button" onClick={() => handleConvert(doc.id)}
                        disabled={convertMut.isPending}
                        className="inline-flex items-center gap-1 text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50">
                        <RefreshCw className="w-3 h-3" />
                        Convert to {activeTab.next}
                      </button>
                    ) : doc.status === 'converted' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle className="w-3 h-3" /> Converted
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
