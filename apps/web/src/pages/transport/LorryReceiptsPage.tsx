// Lorry Receipt register — search, status filters, drill-through from the dashboard.
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Search, Download, Rows3 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { transportApi } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, num, fmtDate, FREIGHT_TYPE_LABEL } from '@/components/transport/format'

const TABS: Array<{ label: string; params: Record<string, string> }> = [
  { label: 'All',            params: {} },
  { label: 'Not delivered', params: { status: 'booked,in_transit' } },
  { label: 'Need a truck', params: { unassigned: 'true' } },
  { label: 'Delivered',      params: { status: 'delivered,pod_received' } },
  { label: 'Signed copy pending', params: { status: 'delivered' } },
  { label: 'Bill not made', params: { unbilled: 'true' } },
  { label: 'Receiver to pay', params: { toPayPending: 'true' } },
  { label: 'Bill made', params: { status: 'billed' } },
]

const FILTER_KEYS = ['status', 'unassigned', 'unbilled', 'toPayPending'] as const

export function LorryReceiptsPage() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const search = sp.get('q') ?? ''
  const page   = Number(sp.get('page') ?? 1)
  const from   = sp.get('from') ?? ''
  const to     = sp.get('to') ?? ''

  const filters = useMemo(() => {
    const f: Record<string, string> = {}
    for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) f[k] = v }
    return f
  }, [sp])

  const activeTab = TABS.findIndex((t) => {
    const keys = Object.keys(t.params)
    return keys.length === Object.keys(filters).length && keys.every((k) => filters[k] === t.params[k])
  })

  const params = { ...filters, search: search || undefined, from: from || undefined, to: to || undefined, page, limit: 20 }
  const { data, isLoading } = useQuery({
    queryKey: ['transport-lrs', params],
    queryFn:  () => transportApi.listLrs(params),
    placeholderData: (prev) => prev,
  })

  const rows: any[] = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / 20))

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k) }
    if (!('page' in patch)) next.delete('page')
    setSp(next, { replace: true })
  }

  function pickTab(i: number) {
    const next = new URLSearchParams(sp)
    for (const k of FILTER_KEYS) next.delete(k)
    for (const [k, v] of Object.entries(TABS[i]!.params)) next.set(k, v)
    next.delete('page')
    setSp(next, { replace: true })
  }

  async function exportExcel() {
    const all = await transportApi.listLrs({ ...params, page: 1, limit: 200 })
    const sheet = (all.data as any[]).map((l) => ({
      'LR No': l.lrNo, Date: String(l.lrDate).slice(0, 10), Consignor: l.consignorName, Consignee: l.consigneeName,
      From: l.fromCity, To: l.toCity, Goods: l.goodsDescription, Packages: l.packages,
      'Weight (kg)': l.chargedWeightKg, 'Freight type': FREIGHT_TYPE_LABEL[l.freightType], Vehicle: l.vehicleNo ?? '',
      'E-way bill': l.ewayBillNo ?? '', Status: l.status, 'Total (₹)': l.totalAmount, 'Bill': l.invoiceNo ?? '',
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), 'LR register')
    XLSX.writeFile(wb, `lr-register-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <div>
      <PageHeader
        title="Loads (LR / bilty)"
        subtitle={`${num(total)} loads${data?.totalAmount != null ? ` · ${inr(data.totalAmount)}` : ''}`}
        action={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={exportExcel}><Download className="w-4 h-4" /> Excel</button>
            <button type="button" className="btn-ghost" onClick={() => navigate('/transport/lrs/quick')}><Rows3 className="w-4 h-4" /> Enter many loads</button>
            <button type="button" className="btn-primary" onClick={() => navigate('/transport/lrs/new')}>
              <Plus className="w-4 h-4" /> New Load (LR)
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative max-w-sm flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Search LR no, party, truck no, goods…"
              value={search} onChange={(e) => update({ q: e.target.value || null })} />
          </div>
          <input type="date" className="input w-40" title="From date" value={from} onChange={(e) => update({ from: e.target.value || null })} />
          <input type="date" className="input w-40" title="To date" value={to} onChange={(e) => update({ to: e.target.value || null })} />
        </div>

        <div className="flex gap-1 flex-wrap">
          {TABS.map((t, i) => (
            <button key={t.label} type="button" onClick={() => pickTab(i)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeTab === i ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="text-center text-gray-400 py-12">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-gray-400 py-12">No loads found</div>
        ) : (
          <div className="bg-white border border-gray-100 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2.5 text-left">LR</th>
                  <th className="px-4 py-2.5 text-left">Date</th>
                  <th className="px-4 py-2.5 text-left">Sender → Receiver</th>
                  <th className="px-4 py-2.5 text-left">Route</th>
                  <th className="px-4 py-2.5 text-right">Weight</th>
                  <th className="px-4 py-2.5 text-left">Freight paid by</th>
                  <th className="px-4 py-2.5 text-left">Truck</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((l) => (
                  <tr key={l.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/transport/lrs/${l.id}`)}>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{l.lrNo}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(l.lrDate)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{l.consignorName}</div>
                      <div className="text-xs text-gray-500">→ {l.consigneeName}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{l.fromCity} → {l.toCity}</td>
                    <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">{num(l.chargedWeightKg)} kg</td>
                    <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{FREIGHT_TYPE_LABEL[l.freightType]}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{l.vehicleNo ?? <span className="text-gray-300">—</span>}</td>
                    <td className="px-4 py-3"><StatusPill kind="lr" status={l.status} /></td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 whitespace-nowrap">{inr(l.totalAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2">
            <button type="button" className="btn-ghost text-sm" disabled={page === 1}
              onClick={() => update({ page: String(page - 1) })}>← Prev</button>
            <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
            <button type="button" className="btn-ghost text-sm" disabled={page >= totalPages}
              onClick={() => update({ page: String(page + 1) })}>Next →</button>
          </div>
        )}
      </div>
    </div>
  )
}
