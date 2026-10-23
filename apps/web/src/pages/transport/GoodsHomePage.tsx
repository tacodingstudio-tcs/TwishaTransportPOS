// Home for a goods / trading firm: this month's sales, what customers still owe, and the latest bills.
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, ReceiptText, Users, FileText } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useInvoices } from '@/hooks/useApi'
import { useCurrentFirm } from '@/hooks/useFirms'
import { useAuthStore } from '@/store/auth.store'
import { inr, fmtDate, todayIst } from '@/components/transport/format'

export function GoodsHomePage() {
  const navigate = useNavigate()
  const { firm } = useCurrentFirm()
  const user = useAuthStore((s) => s.user)
  const readOnly = user?.role === 'viewer'
  const { data, isLoading } = useInvoices({ txnType: 'sale_invoice', limit: 100, page: 1 })
  const rows: any[] = (data?.data ?? []).filter((i: any) => i.status !== 'cancelled')

  const stats = useMemo(() => {
    const month = todayIst().slice(0, 7)
    const thisMonth = rows.filter((i) => String(i.date).slice(0, 7) === month)
    return {
      sales: thisMonth.reduce((s, i) => s + Number(i.grandTotal), 0),
      count: thisMonth.length,
      owed: rows.reduce((s, i) => s + Math.max(0, Number(i.grandTotal) - Number(i.paidAmt ?? 0)), 0),
    }
  }, [rows])

  const nextNo = firm?.numbering?.style === 'plain' && firm.numbering.next != null ? `${firm.numbering.prefix ?? ''}${firm.numbering.next}` : null

  return (
    <div>
      <PageHeader
        title={firm?.name ?? 'Home'}
        subtitle={nextNo ? `Next bill number ${nextNo}` : 'Goods billing'}
        action={!readOnly && <button type="button" className="btn-primary" onClick={() => navigate('/transport/goods-bills/new')}><Plus className="w-4 h-4" /> New goods bill</button>}
      />
      <div className="p-6 space-y-6 max-w-5xl">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="card p-5"><div className="text-xs text-gray-500">Sales this month</div><div className="text-2xl font-bold text-gray-900 mt-1">{inr(stats.sales)}</div><div className="text-xs text-gray-400 mt-1">{stats.count} bill{stats.count === 1 ? '' : 's'}</div></div>
          <div className="card p-5"><div className="text-xs text-gray-500">Customers still owe</div><div className="text-2xl font-bold text-amber-700 mt-1">{inr(stats.owed)}</div><Link to="/aging" className="text-xs text-primary-600 hover:underline mt-1 inline-block">See who owes what →</Link></div>
          <div className="card p-5 flex flex-col gap-2 justify-center">
            <Link to="/transport/goods-bills/new" className="flex items-center gap-2 text-sm text-gray-700 hover:text-primary-700"><ReceiptText className="w-4 h-4" /> Make a goods bill</Link>
            <Link to="/parties" className="flex items-center gap-2 text-sm text-gray-700 hover:text-primary-700"><Users className="w-4 h-4" /> Customers</Link>
            <Link to="/invoices" className="flex items-center gap-2 text-sm text-gray-700 hover:text-primary-700"><FileText className="w-4 h-4" /> All bills</Link>
          </div>
        </div>

        <section className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">Latest bills</div>
          {isLoading ? <div className="p-8 text-center text-gray-400">Loading…</div>
            : rows.length === 0 ? <div className="p-8 text-center text-gray-400">No bills yet — make the first one with “New goods bill”.</div>
            : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr><th className="px-5 py-2 text-left">Bill</th><th className="px-5 py-2 text-left">Customer</th><th className="px-5 py-2 text-left">Date</th><th className="px-5 py-2 text-right">Amount</th><th className="px-5 py-2 text-left">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.slice(0, 10).map((i) => (
                    <tr key={i.id} className="hover:bg-gray-50">
                      <td className="px-5 py-2.5"><Link to={`/invoices/${i.id}`} className="font-medium text-primary-600 hover:underline">{i.number}</Link></td>
                      <td className="px-5 py-2.5 text-gray-700">{i.party?.name ?? 'Walk-in'}</td>
                      <td className="px-5 py-2.5 text-gray-500">{fmtDate(i.date)}</td>
                      <td className="px-5 py-2.5 text-right font-medium">{inr(i.grandTotal)}</td>
                      <td className="px-5 py-2.5"><StatusBadge status={i.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </section>
      </div>
    </div>
  )
}
