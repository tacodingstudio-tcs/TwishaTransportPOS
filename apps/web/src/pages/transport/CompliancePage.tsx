// Compliance — vehicle documents and driver licences that are expired or coming due.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { transportApi } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { fmtDate } from '@/components/transport/format'

const SEVERITY = {
  expired:  { label: 'Expired',  cls: 'bg-red-100 text-red-700' },
  critical: { label: 'Within 7 days', cls: 'bg-red-50 text-red-600' },
  warning:  { label: 'Due soon', cls: 'bg-amber-100 text-amber-700' },
} as const

export function CompliancePage() {
  const [days, setDays] = useState(60)
  const { data, isLoading } = useQuery({ queryKey: ['transport-compliance', days], queryFn: () => transportApi.compliance(days) })
  const items: any[] = data?.items ?? []

  return (
    <div>
      <PageHeader
        title="Papers expiry"
        subtitle="Truck papers and driver licences that are over or ending soon"
        action={
          <select className="input w-44" value={days} onChange={(e) => setDays(Number(e.target.value))} title="Look-ahead window">
            {[15, 30, 60, 90, 180].map((d) => <option key={d} value={d}>Next {d} days</option>)}
          </select>
        }
      />
      <div className="p-6 space-y-4">
        {data && (
          <div className="grid grid-cols-3 gap-3 max-w-xl">
            <div className="rounded-xl border bg-red-50 border-red-200 text-red-900 p-4"><div className="text-xs uppercase opacity-70">Over</div><div className="text-2xl font-bold">{data.counts.expired}</div></div>
            <div className="rounded-xl border bg-red-50/50 border-red-100 text-red-800 p-4"><div className="text-xs uppercase opacity-70">Within 7 days</div><div className="text-2xl font-bold">{data.counts.critical}</div></div>
            <div className="rounded-xl border bg-amber-50 border-amber-200 text-amber-900 p-4"><div className="text-xs uppercase opacity-70">Ending soon</div><div className="text-2xl font-bold">{data.counts.warning}</div></div>
          </div>
        )}

        {isLoading ? <div className="text-center text-gray-400 py-12">Loading…</div>
          : items.length === 0 ? (
            <div className="bg-white border border-gray-100 rounded-xl p-12 text-center">
              <ShieldCheck className="w-10 h-10 text-green-500 mx-auto mb-2" />
              <p className="text-gray-700 font-medium">All papers are valid for the next {days} days</p>
              <p className="text-sm text-gray-400 mt-1">Papers with no date are not watched — add the dates on each truck.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Truck / driver</th>
                    <th className="px-4 py-2.5 text-left">Paper</th>
                    <th className="px-4 py-2.5 text-left">Valid till</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map((i, idx) => {
                    const sev = SEVERITY[i.severity as keyof typeof SEVERITY]
                    return (
                      <tr key={`${i.entityId}-${i.doc}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <Link to={i.kind === 'vehicle' ? `/transport/vehicles/${i.entityId}` : '/transport/drivers'} className="font-medium text-gray-900 hover:text-primary-600 inline-flex items-center gap-2">
                            <ShieldAlert className={`w-4 h-4 ${i.severity === 'warning' ? 'text-amber-500' : 'text-red-500'}`} />
                            {i.entityName}
                          </Link>
                          <span className="ml-2 text-xs text-gray-400 capitalize">{i.kind}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-700">{i.doc}</td>
                        <td className="px-4 py-3 text-gray-600">{fmtDate(i.expiry)}</td>
                        <td className="px-4 py-3">
                          <span className={`badge ${sev.cls}`}>{i.daysLeft < 0 ? `Over ${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'} ago` : i.daysLeft === 0 ? 'Expires today' : `${i.daysLeft} days left`}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  )
}
