// src/pages/DashboardPage.tsx
import { useState } from 'react'
import {
  useDailySummary, useLowStock, useUdhaarSummary, useInvoices,
  useWeeklySummary, useAIInsight, useReorderSuggestions,
  useAnalyticsDashboard, useAnalyticsTopCustomers, useExpenseSummary,
  useMonthlyComparison,
} from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { RevenueBarChart } from '@/components/charts/RevenueBarChart'
import { GSTINLookup } from '@/components/gstin/GSTINLookup'
import { Link } from 'react-router-dom'
import {
  TrendingUp, TrendingDown, AlertTriangle, Users, Receipt, ArrowRight,
  Sparkles, ShoppingCart, IndianRupee, BarChart2, ArrowUpRight, ArrowDownRight,
} from 'lucide-react'
import { format } from 'date-fns'

function formatINR(n: number) {
  return '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

const PERIOD_LABELS: Record<string, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' }

// Compute date range matching the analytics endpoint's period logic
function periodRange(period: string) {
  const now  = new Date()
  const days = period === '90d' ? 90 : period === '30d' ? 30 : 7
  const from = new Date(now); from.setDate(from.getDate() - days)
  const fmt  = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(from), to: fmt(now) }
}

export function DashboardPage() {
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d')
  const domainType = useAuthStore((s) => s.branch?.domainType as string | undefined)

  // Domains that carry physical inventory — show low-stock + reorder widgets
  const INVENTORY_DOMAINS = new Set([
    'retail', 'wholesale', 'electronics', 'hardware', 'pharmacy', 'optical',
    'jewellery', 'textile', 'sweet', 'automobile', 'enterprise', 'agri',
    'petrol_pump', 'printing',
  ])
  // Hybrid domains: sell physical goods alongside services
  const HYBRID_DOMAINS = new Set([
    'restaurant', 'repair', 'hotel', 'catering',
  ])
  // Service domains: no purchase orders, but may track consumables internally
  const SERVICE_DOMAINS = new Set([
    'salon', 'gym', 'clinic', 'coaching', 'photography', 'laundry',
    'diagnostic_lab', 'pest_control', 'tiffin',
  ])
  const isServiceDomain   = SERVICE_DOMAINS.has(domainType ?? '')
  const showInventoryWidgets = INVENTORY_DOMAINS.has(domainType ?? '') || HYBRID_DOMAINS.has(domainType ?? '') || isServiceDomain


  const { data: summary,  isLoading: summaryLoading } = useDailySummary()
  const { data: lowStockRaw, isLoading: lowStockLoading } = useLowStock()
  // For service domains, only show consumable items in low-stock widgets
  const lowStock = isServiceDomain
    ? lowStockRaw?.filter((p: any) => p.isConsumable)
    : lowStockRaw
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { data: udhaar }       = useUdhaarSummary()
  const { data: recentInvoices } = useInvoices({ limit: 5 })
  const { data: weeklyData, isLoading: weeklyLoading } = useWeeklySummary()
  const { data: aiInsight }    = useAIInsight()
  const { data: reorderData }  = useReorderSuggestions()

  const { data: monthly } = useMonthlyComparison()

  const { data: analytics, isLoading: analyticsLoading } = useAnalyticsDashboard({
    period, compareWith: 'prev_period',
  })
  const { data: topCustomers } = useAnalyticsTopCustomers({ period, limit: 5 })
  const range = periodRange(period)
  const { data: expSummary }   = useExpenseSummary({ from: range.from, to: range.to })

  const kpiMap: Record<string, any> = {}
  analytics?.kpis?.forEach((k: any) => { kpiMap[k.key] = k })

  const revenue  = kpiMap['revenue']?.value   ?? 0
  const expenses = expSummary?.totalAmount     ?? 0
  const profit   = revenue - expenses
  const margin   = analytics?.kpis?.find((k: any) => k.key === 'gross_margin')

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={format(new Date(), 'EEEE, d MMMM yyyy')}
        action={
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(['7d', '30d', '90d'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  period === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {p === '7d' ? '7D' : p === '30d' ? '30D' : '90D'}
              </button>
            ))}
          </div>
        }
      />

      <div className="p-8 space-y-6">

        {/* ── AI Insight ──────────────────────────────────────────────────── */}
        {aiInsight && (
          <div className="bg-gradient-to-r from-primary-50 to-blue-50 border border-primary-100 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-lg bg-primary-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles className="w-3.5 h-3.5 text-primary-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-primary-900">{aiInsight.headline}</p>
                {aiInsight.insights?.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {aiInsight.insights.map((ins: string, i: number) => (
                      <li key={i} className="text-xs text-primary-700">• {ins}</li>
                    ))}
                  </ul>
                )}
                {aiInsight.alert && (
                  <p className="mt-2 text-xs font-medium text-amber-700 bg-amber-50 rounded px-2 py-1">
                    ⚠ {aiInsight.alert}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Monthly comparison ──────────────────────────────────────────── */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">
              {monthly ? `${monthly.thisMonth} vs ${monthly.lastMonth}` : 'This month vs last month'}
            </h2>
            <span className="text-xs text-gray-400">Month-over-month</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <MonthlyMetric
              label="Revenue"
              thisVal={monthly?.revenue.this ?? 0}
              lastVal={monthly?.revenue.last ?? 0}
              delta={monthly?.revenue.delta ?? 0}
              color="blue"
            />
            <MonthlyMetric
              label="Expenses"
              thisVal={monthly?.expenses.this ?? 0}
              lastVal={monthly?.expenses.last ?? 0}
              delta={monthly?.expenses.delta ?? 0}
              color="amber"
              invertDelta
            />
            <MonthlyMetric
              label="Profit"
              thisVal={monthly?.profit.this ?? 0}
              lastVal={monthly?.profit.last ?? 0}
              delta={monthly?.profit.delta ?? 0}
              color={(monthly?.profit.this ?? 0) >= 0 ? 'green' : 'red'}
            />
          </div>
        </div>

        {/* ── P&L KPI cards ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-4">
          <KpiCard
            label={`Revenue (${PERIOD_LABELS[period]})`}
            value={formatINR(revenue)}
            delta={kpiMap['revenue']?.delta}
            trend={kpiMap['revenue']?.trend}
            highlight="blue"
            loading={analyticsLoading}
            icon={TrendingUp}
          />
          <KpiCard
            label={`Expenses (${PERIOD_LABELS[period]})`}
            value={formatINR(expenses)}
            highlight="amber"
            loading={analyticsLoading}
            icon={IndianRupee}
          />
          <KpiCard
            label="Net Profit"
            value={(profit < 0 ? '−' : '') + formatINR(profit)}
            highlight={profit >= 0 ? 'green' : 'red'}
            loading={analyticsLoading}
            icon={profit >= 0 ? TrendingUp : TrendingDown}
          />
          {margin ? (
            <KpiCard
              label="Gross Margin"
              value={`${margin.value}%`}
              highlight={margin.highlight === 'good' ? 'green' : margin.highlight === 'warn' ? 'amber' : 'red'}
              loading={analyticsLoading}
              icon={BarChart2}
            />
          ) : (
            <KpiCard
              label="Udhaar Outstanding"
              value={formatINR(udhaar?.totalOutstanding ?? 0)}
              sub={`${udhaar?.customerCount ?? 0} customers`}
              highlight="amber"
              icon={Users}
            />
          )}
        </div>

        {/* ── Today quick stats ───────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-4">
          <SmallStatCard
            label="Today's sales"
            value={summaryLoading ? '—' : formatINR(summary?.totalSales ?? 0)}
            sub={`${summary?.invoiceCount ?? 0} invoices`}
          />
          <SmallStatCard
            label="Collected today"
            value={summaryLoading ? '—' : formatINR(summary?.totalReceived ?? 0)}
            sub={summary?.totalOutstanding ? `${formatINR(summary.totalOutstanding)} pending` : 'Fully collected'}
          />
          <SmallStatCard
            label="Udhaar outstanding"
            value={formatINR(udhaar?.totalOutstanding ?? 0)}
            sub={`${udhaar?.customerCount ?? 0} customers`}
          />
          {showInventoryWidgets ? (
            <SmallStatCard
              label="Low stock items"
              value={lowStockLoading ? '—' : String(lowStock?.length ?? 0)}
              sub="Need reordering"
              warn={(lowStock?.length ?? 0) > 0}
            />
          ) : (
            <SmallStatCard
              label="Pending collections"
              value={formatINR(udhaar?.totalOutstanding ?? 0)}
              sub={`${udhaar?.customerCount ?? 0} parties with balance`}
              warn={(udhaar?.totalOutstanding ?? 0) > 0}
            />
          )}
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* ── Recent invoices ─────────────────────────────────────────── */}
          <div className="col-span-2 card">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">Recent invoices</h2>
              <Link to="/invoices" className="text-xs text-primary-600 font-medium flex items-center gap-1 hover:underline">
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-gray-100">
              {recentInvoices?.data?.length === 0 && (
                <div className="p-8 text-center text-sm text-gray-400">No invoices yet</div>
              )}
              {recentInvoices?.data?.map((inv: any) => (
                <Link
                  key={inv.id}
                  to={`/invoices/${inv.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div>
                    <div className="text-sm font-medium text-gray-900">{inv.number}</div>
                    <div className="text-xs text-gray-500">{inv.party?.name ?? 'Walk-in customer'}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-gray-900">{formatINR(Number(inv.grandTotal))}</span>
                    <StatusBadge status={inv.status} />
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* ── Payment breakdown today ──────────────────────────────────── */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Payment methods today</h2>
            {(!summary?.paymentBreakdown || summary.paymentBreakdown.length === 0) && (
              <p className="text-sm text-gray-400">No payments recorded yet</p>
            )}
            <div className="space-y-3">
              {summary?.paymentBreakdown?.map((p: any) => (
                <div key={p.method} className="flex items-center justify-between">
                  <span className="text-sm text-gray-600 capitalize">{p.method.replace('_', ' ')}</span>
                  <span className="text-sm font-medium text-gray-900">{formatINR(p.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Revenue chart ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Revenue — last 7 days</h2>
            <RevenueBarChart data={weeklyData ?? []} isLoading={weeklyLoading} />
          </div>
          <GSTINLookup />
        </div>

        {/* ── Top products + Top customers ─────────────────────────────────── */}
        {analytics && (
          <div className="grid grid-cols-2 gap-6">
            {/* Top products */}
            {(() => {
              const chart = analytics.charts?.find((c: any) => ['top_products','top_items','top_medicines','top_services'].some((k: string) => c.key.includes(k.split('_')[1] ?? k)))
                         ?? analytics.charts?.find((c: any) => c.key.includes('top'))
              const items = chart?.series?.[0]?.data?.slice(0, 5) ?? []
              if (items.length === 0) return null
              const max = Math.max(...items.map((d: any) => d.y), 1)
              return (
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-gray-900">Top products / services</h2>
                    <span className="text-xs text-gray-400">{PERIOD_LABELS[period]}</span>
                  </div>
                  <div className="space-y-3">
                    {items.map((item: any, i: number) => (
                      <div key={i}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-700 truncate max-w-[180px]">{item.x}</span>
                          <span className="font-medium text-gray-900 ml-2">{formatINR(item.y)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full">
                          {/* eslint-disable-next-line react/forbid-component-props */}
                          <div
                            className="h-1.5 bg-primary-500 rounded-full"
                            style={{ width: `${Math.round((item.y / max) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Top customers */}
            {topCustomers?.customers?.length > 0 && (
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-900">Top customers</h2>
                  <Link to="/parties" className="text-xs text-primary-600 hover:underline flex items-center gap-1">
                    View all <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
                <div className="space-y-2">
                  {topCustomers.customers.slice(0, 5).map((c: any) => (
                    <Link
                      key={c.party_id}
                      to={`/parties/${c.party_id}`}
                      className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50 -mx-1 px-1 rounded transition-colors"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{c.name}</div>
                        <div className="text-xs text-gray-400">{c.invoices} invoices</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-gray-900">{formatINR(c.revenue)}</div>
                        {c.outstanding > 0 && (
                          <div className="text-xs text-amber-600">{formatINR(c.outstanding)} due</div>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Low stock alert ──────────────────────────────────────────────── */}
        {showInventoryWidgets && lowStock && lowStock.length > 0 && (
          <div className="card p-5 border-amber-200 bg-amber-50/30">
            <h2 className="text-sm font-semibold text-amber-900 mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {isServiceDomain ? 'Consumables running low' : 'Low stock — reorder soon'}
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {lowStock.slice(0, 6).map((p: any) => {
                const qty = Number(p.stockOnHand)
                const unit = p.unit && p.unit !== 'svc' ? p.unit : 'units'
                const label = qty <= 0 ? 'Out of stock' : `${qty} ${unit} left`
                return (
                  <div key={p.id} className="bg-white rounded-lg px-3 py-2 border border-amber-100">
                    <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                    <div className={`text-xs font-medium ${qty <= 0 ? 'text-red-600' : 'text-amber-700'}`}>{label}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Smart Reorder ────────────────────────────────────────────────── */}
        {showInventoryWidgets && !isServiceDomain && reorderData?.suggestions?.length > 0 && (
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              <ShoppingCart className="w-4 h-4 text-primary-600" /> Smart Reorder Suggestions
            </h2>
            <div className="space-y-2">
              {reorderData.suggestions.slice(0, 5).map((s: any) => (
                <div key={s.productId} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{s.productName}</span>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {s.reason?.replace(/Only (-?\d+) days/, (_: string, d: string) =>
                        Number(d) <= 0 ? 'Out of stock' : `Only ${d} days`
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-xs text-gray-500">Suggest order</p>
                      <p className="text-sm font-semibold text-gray-900">{s.suggestedQty} units</p>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                      s.urgency === 'critical' ? 'bg-red-100 text-red-700' :
                      s.urgency === 'high'     ? 'bg-orange-100 text-orange-700' :
                                                  'bg-yellow-100 text-yellow-700'
                    }`}>{s.urgency}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  label, value, delta, trend, highlight, loading, icon: Icon, sub,
}: {
  label: string; value: string; delta?: number; trend?: string
  highlight: 'blue' | 'green' | 'amber' | 'red'; loading?: boolean
  icon?: React.ElementType; sub?: string
}) {
  const colorMap = {
    blue:  'text-blue-600 bg-blue-50',
    green: 'text-green-600 bg-green-50',
    amber: 'text-amber-600 bg-amber-50',
    red:   'text-red-600 bg-red-50',
  }
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        {Icon && (
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colorMap[highlight]}`}>
            <Icon className="w-4 h-4" />
          </div>
        )}
        {delta !== undefined && (
          <span className={`text-xs font-medium flex items-center gap-0.5 ${
            trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-600' : 'text-gray-400'
          }`}>
            {trend === 'up' ? <ArrowUpRight className="w-3 h-3" /> : trend === 'down' ? <ArrowDownRight className="w-3 h-3" /> : null}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-xl font-bold text-gray-900">{loading ? '—' : value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      {delta !== undefined && (
        <div className="text-xs text-gray-400 mt-1">vs previous period</div>
      )}
    </div>
  )
}

function SmallStatCard({ label, value, sub, warn }: {
  label: string; value: string; sub?: string; warn?: boolean
}) {
  return (
    <div className={`card p-4 ${warn ? 'border-amber-200 bg-amber-50/20' : ''}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-bold ${warn ? 'text-amber-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function MonthlyMetric({ label, thisVal, lastVal, delta, color, invertDelta }: {
  label: string; thisVal: number; lastVal: number; delta: number
  color: 'blue' | 'amber' | 'green' | 'red'; invertDelta?: boolean
}) {
  const isGood   = invertDelta ? delta <= 0 : delta >= 0
  const colorCls = { blue: 'text-blue-600', amber: 'text-amber-600', green: 'text-green-600', red: 'text-red-600' }[color]
  const bgCls    = { blue: 'bg-blue-50', amber: 'bg-amber-50', green: 'bg-green-50', red: 'bg-red-50' }[color]

  return (
    <div className={`rounded-xl p-4 ${bgCls}`}>
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className={`text-xl font-bold ${colorCls}`}>{formatINR(Math.abs(thisVal))}</div>
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-gray-400">Last month: {formatINR(lastVal)}</span>
        {delta !== 0 && (
          <span className={`text-xs font-semibold flex items-center gap-0.5 ${isGood ? 'text-green-600' : 'text-red-600'}`}>
            {delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  )
}
