import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Link } from 'react-router-dom'
import { TrendingDown, TrendingUp, AlertCircle } from 'lucide-react'

const formatINR = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)

function useOutstanding(type: 'customer' | 'supplier') {
  return useQuery({
    queryKey: ['outstanding', type],
    queryFn: () => api.get(`/payments/outstanding?type=${type}&limit=100`).then(r => r.data),
    staleTime: 30_000,
  })
}

interface AgingBucket {
  label: string
  key: keyof { '0_30': number; '31_60': number; '61_90': number; '90plus': number }
  color: string
  barColor: string
}

const BUCKETS: AgingBucket[] = [
  { label: '0–30 days',  key: '0_30',   color: 'text-green-700',  barColor: 'bg-green-400' },
  { label: '31–60 days', key: '31_60',  color: 'text-yellow-700', barColor: 'bg-yellow-400' },
  { label: '61–90 days', key: '61_90',  color: 'text-orange-700', barColor: 'bg-orange-400' },
  { label: '90+ days',   key: '90plus', color: 'text-red-700',    barColor: 'bg-red-500' },
]

function AgingBar({ aging, total }: { aging: Record<string, number>; total: number }) {
  if (!total) return <div className="w-full h-3 bg-gray-100 rounded-full" />
  return (
    <div className="flex h-3 rounded-full overflow-hidden w-full">
      {BUCKETS.map(b => {
        const val = aging[b.key] ?? 0
        const pct = total > 0 ? (val / total) * 100 : 0
        if (!pct) return null
        return <div key={b.key} className={`${b.barColor} transition-all`} style={{ width: `${pct}%` }} title={`${b.label}: ${formatINR(val)}`} />
      })}
    </div>
  )
}

function AgingTable({ type }: { type: 'customer' | 'supplier' }) {
  const { data, isLoading } = useOutstanding(type)
  const parties = (data as any)?.parties ?? []
  const aging   = (data as any)?.aging   ?? {}
  const total   = (data as any)?.total   ?? 0

  if (isLoading) return <div className="py-12 text-center text-gray-400">Loading…</div>

  return (
    <div className="space-y-4">
      {/* Summary aging bar */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="font-medium text-gray-700">
            {type === 'customer' ? 'Total Receivable' : 'Total Payable'}
          </span>
          <span className="font-bold text-lg text-gray-900">{formatINR(total)}</span>
        </div>
        <AgingBar aging={aging} total={total} />
        <div className="grid grid-cols-4 gap-2 mt-3">
          {BUCKETS.map(b => (
            <div key={b.key} className="text-center">
              <div className={`text-sm font-semibold ${b.color}`}>{formatINR(aging[b.key] ?? 0)}</div>
              <div className="text-xs text-gray-500">{b.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Party-wise table */}
      {parties.length === 0 ? (
        <div className="text-center py-10 text-gray-400">
          <AlertCircle className="w-6 h-6 mx-auto mb-2 opacity-30" />
          No outstanding {type === 'customer' ? 'receivables' : 'payables'}
        </div>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Party</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">0–30 d</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">31–60 d</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">61–90 d</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">90+ d</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Balance</th>
                <th className="px-4 py-3 w-24">Aging</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {parties.map((p: any) => (
                <tr key={p.partyId} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/parties/${p.partyId}`} className="font-medium text-blue-600 hover:underline">
                      {p.name}
                    </Link>
                    {p.phone && <div className="text-xs text-gray-400">{p.phone}</div>}
                    {p.oldestInvoiceDate && (
                      <div className="text-xs text-gray-400">Oldest: {p.oldestInvoiceDate}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-green-700">{p.aging['0_30'] > 0 ? formatINR(p.aging['0_30']) : '—'}</td>
                  <td className="px-4 py-3 text-right text-yellow-700">{p.aging['31_60'] > 0 ? formatINR(p.aging['31_60']) : '—'}</td>
                  <td className="px-4 py-3 text-right text-orange-700">{p.aging['61_90'] > 0 ? formatINR(p.aging['61_90']) : '—'}</td>
                  <td className="px-4 py-3 text-right text-red-700 font-medium">{p.aging['90plus'] > 0 ? formatINR(p.aging['90plus']) : '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatINR(p.balance)}</td>
                  <td className="px-4 py-3 w-24">
                    <AgingBar aging={p.aging} total={p.balance} />
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

export default function AgingPage() {
  const [tab, setTab] = useState<'customer' | 'supplier'>('customer')

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Aging / Outstanding</h1>
        <p className="text-sm text-gray-500 mt-0.5">Receivables and payables bucketed by overdue days</p>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-2">
        <button type="button"
          onClick={() => setTab('customer')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'customer' ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
          }`}>
          <TrendingUp className="w-4 h-4" /> Receivables
        </button>
        <button type="button"
          onClick={() => setTab('supplier')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === 'supplier' ? 'bg-purple-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'
          }`}>
          <TrendingDown className="w-4 h-4" /> Payables
        </button>
      </div>

      <AgingTable key={tab} type={tab} />
    </div>
  )
}
