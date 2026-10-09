// src/pages/ReportsPage.tsx
import { useState } from 'react'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  useAnalyticsGstSummary, useAnalyticsMargin,
  useAnalyticsSalesVsPurchases, useReportsGstr1,
  useReportsPlStatement, useReportsCashRegister, useReportsCashRegisterSave,
  useReportsBankAccounts, useReportsBankAccountCreate,
  useReportsBankRecon, useReportsBankReconSave, useDayBook,
} from '@/hooks/useApi'
import { FileText, TrendingUp, BarChart2, Download, DollarSign, Landmark, BookOpen } from 'lucide-react'

function formatINR(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

function fmtPct(n: number) { return n.toFixed(1) + '%' }

function recentMonths(count = 12) {
  const months: { value: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      value: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    })
  }
  return months
}

function todayStr() { return new Date().toISOString().slice(0, 10) }
function firstOfMonth() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`
}

const MONTHS = recentMonths()

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-2 bg-gray-100 rounded-full flex-1">
      {/* eslint-disable-next-line react/forbid-component-props */}
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const INDENT_CLS = ['pl-4', 'pl-9', 'pl-14'] as const

// ── P&L line row ──────────────────────────────────────────────────────────────
function PLRow({ label, value, indent = 0, bold = false, color = 'text-gray-900', sub = '' }: {
  label: string; value: number; indent?: number; bold?: boolean; color?: string; sub?: string
}) {
  const indentCls = INDENT_CLS[Math.min(indent, INDENT_CLS.length - 1)]
  return (
    <tr>
      <td className={`py-2 text-sm ${indentCls} ${bold ? 'font-semibold' : 'text-gray-600'}`}>
        {label}
        {sub && <span className="ml-2 text-xs text-gray-400">{sub}</span>}
      </td>
      <td className={`py-2 text-right text-sm font-mono ${color} ${bold ? 'font-bold' : ''}`}>
        {value < 0 ? `(${formatINR(Math.abs(value))})` : formatINR(value)}
      </td>
    </tr>
  )
}

function PLDivider({ label }: { label: string }) {
  return (
    <tr className="border-t border-gray-200">
      <td colSpan={2} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400 pl-4">{label}</td>
    </tr>
  )
}

const TABS = [
  { key: 'pl',       label: 'P&L Statement',        icon: BookOpen   },
  { key: 'svp',      label: 'Sales vs Purchases',    icon: TrendingUp },
  { key: 'cash',     label: 'Cash Register',         icon: DollarSign },
  { key: 'bank',     label: 'Bank Reconciliation',   icon: Landmark   },
  { key: 'gst',      label: 'GST Report',            icon: FileText   },
  { key: 'margin',   label: 'Margin by Product',     icon: BarChart2  },
  { key: 'day-book', label: 'Day Book',              icon: BookOpen   },
]

export function ReportsPage() {
  const domainType = useAuthStore((s) => s.branch?.domainType as string | undefined)
  const showSvpTab = !SERVICE_DOMAINS.has(domainType ?? '')
  const visibleTabs = TABS.filter((t) => t.key !== 'svp' || showSvpTab)
  const [tab, setTab] = useState<'pl' | 'svp' | 'cash' | 'bank' | 'gst' | 'margin' | 'day-book'>('pl')

  return (
    <div>
      <PageHeader title="Reports" subtitle="Financial & operational reports" />

      <div className="p-8 space-y-6">
        <div className="flex gap-1 border-b border-gray-200 flex-wrap">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key as any)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'pl'       && <PLStatementTab />}
        {tab === 'svp'      && showSvpTab && <SalesVsPurchasesTab />}
        {tab === 'cash'     && <CashRegisterTab />}
        {tab === 'bank'     && <BankReconciliationTab />}
        {tab === 'gst'      && <GSTReportTab />}
        {tab === 'margin'   && <MarginTab />}
        {tab === 'day-book' && <DayBookTab />}
      </div>
    </div>
  )
}

// ── Tab: P&L Statement ────────────────────────────────────────────────────────
function PLStatementTab() {
  const [from, setFrom] = useState(firstOfMonth())
  const [to,   setTo  ] = useState(todayStr())
  const [applied, setApplied] = useState({ from: firstOfMonth(), to: todayStr() })

  const { data, isLoading, error } = useReportsPlStatement(applied)
  const s = data?.statement

  return (
    <div className="space-y-5">
      {/* Date range controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-500" htmlFor="pl-from">From</label>
        <input id="pl-from" type="date" title="Start date" value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input text-sm w-40" max={to} />
        <label className="text-sm text-gray-500" htmlFor="pl-to">To</label>
        <input id="pl-to" type="date" title="End date" value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input text-sm w-40" min={from} max={todayStr()} />
        <button
          type="button"
          onClick={() => setApplied({ from, to })}
          className="btn btn-primary text-sm px-4 py-2"
        >
          Apply
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : error ? (
        <div className="text-center py-12 text-red-500">Failed to load P&L</div>
      ) : !s ? null : (
        <div className="grid grid-cols-3 gap-5">
          {/* Formal P&L table */}
          <div className="col-span-2 card overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Profit & Loss Statement</h3>
                <p className="text-xs text-gray-400 mt-0.5">{applied.from} to {applied.to}</p>
              </div>
            </div>
            <table className="w-full">
              <tbody>
                <PLDivider label="Revenue" />
                <PLRow label="Gross Revenue" value={s.gross_revenue}
                  sub={`${s.invoice_count} invoices`} indent={1} />
                {s.sales_returns > 0 && (
                  <PLRow label="Less: Sales Returns / Credit Notes" value={-s.sales_returns} indent={1} color="text-red-600" />
                )}
                <tr className="border-t border-gray-200">
                  <td className="py-2 pl-4 text-sm font-semibold text-gray-900">Net Revenue</td>
                  <td className="py-2 text-right text-sm font-bold text-blue-700 font-mono">{formatINR(s.net_revenue)}</td>
                </tr>

                <PLDivider label="Cost of Goods Sold" />
                <PLRow label="Purchases / COGS"
                  value={s.cogs} sub={`${s.purchase_orders} orders`} indent={1} />
                <tr className="border-t border-gray-200">
                  <td className="py-2 pl-4 text-sm font-semibold text-gray-900">Gross Profit</td>
                  <td className={`py-2 text-right text-sm font-bold font-mono ${s.gross_profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {s.gross_profit < 0 ? `(${formatINR(Math.abs(s.gross_profit))})` : formatINR(s.gross_profit)}
                    <span className="ml-2 text-xs font-normal text-gray-400">{fmtPct(s.gross_margin_pct)}</span>
                  </td>
                </tr>

                <PLDivider label="Operating Expenses" />
                {s.expense_categories.map((ec: any) => (
                  <PLRow key={ec.category} label={ec.category} value={ec.amount}
                    sub={`${ec.count} entries`} indent={1} />
                ))}
                {s.expense_categories.length === 0 && (
                  <tr><td colSpan={2} className="py-2 pl-8 text-sm text-gray-400">No expenses recorded</td></tr>
                )}
                <tr className="border-t border-gray-200">
                  <td className="py-2 pl-4 text-sm font-semibold text-gray-900">Operating Profit (EBIT)</td>
                  <td className={`py-2 text-right text-sm font-bold font-mono ${s.operating_profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {s.operating_profit < 0 ? `(${formatINR(Math.abs(s.operating_profit))})` : formatINR(s.operating_profit)}
                    <span className="ml-2 text-xs font-normal text-gray-400">{fmtPct(s.op_margin_pct)}</span>
                  </td>
                </tr>

                <PLDivider label="Tax (GST)" />
                <PLRow label="Output GST (collected)" value={s.output_gst} indent={1} />
                <PLRow label="Input GST (on purchases)" value={-s.input_gst} indent={1} color="text-green-700" />
                <tr className="border-t border-gray-200">
                  <td className="py-2 pl-4 text-sm font-semibold text-gray-900">Net GST Liability</td>
                  <td className="py-2 text-right text-sm font-bold text-amber-700 font-mono">{formatINR(s.net_gst_liability)}</td>
                </tr>

                <tr className="border-t-2 border-gray-300 bg-gray-50">
                  <td className="px-4 py-3 text-base font-bold text-gray-900">Net Profit / (Loss)</td>
                  <td className={`px-4 py-3 text-right text-base font-bold font-mono ${s.net_profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                    {s.net_profit < 0 ? `(${formatINR(Math.abs(s.net_profit))})` : formatINR(s.net_profit)}
                    <span className="ml-2 text-sm font-normal text-gray-500">{fmtPct(s.net_margin_pct)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* KPI sidebar */}
          <div className="space-y-4">
            {[
              { label: 'Net Revenue',      value: s.net_revenue,       color: 'text-blue-700'   },
              { label: 'Gross Profit',     value: s.gross_profit,      color: s.gross_profit  >= 0 ? 'text-green-700' : 'text-red-600' },
              { label: 'Gross Margin',     value: s.gross_margin_pct,  color: 'text-gray-900', fmt: fmtPct },
              { label: 'Total Expenses',   value: s.total_expenses,    color: 'text-amber-700'  },
              { label: 'Operating Profit', value: s.operating_profit,  color: s.operating_profit >= 0 ? 'text-green-700' : 'text-red-600' },
              { label: 'Net GST Payable',  value: s.net_gst_liability, color: 'text-purple-700' },
              { label: 'Net Profit',       value: s.net_profit,        color: s.net_profit    >= 0 ? 'text-green-700' : 'text-red-600' },
            ].map((c: any) => (
              <div key={c.label} className="card p-4">
                <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                <div className={`text-xl font-bold ${c.color}`}>
                  {c.fmt ? c.fmt(c.value) : (c.value < 0 ? `(${formatINR(Math.abs(c.value))})` : formatINR(c.value))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Cash Register ────────────────────────────────────────────────────────
function CashRegisterTab() {
  const [date, setDate] = useState(todayStr())
  const [countedCash, setCountedCash] = useState('')
  const [notes, setNotes] = useState('')

  const { data, isLoading, refetch } = useReportsCashRegister({ date })
  const save = useReportsCashRegisterSave()

  const systemCash = data?.system_cash ?? 0
  const savedEntry = data?.saved_entry ?? null
  const transactions: any[] = data?.cash_transactions ?? []
  const counted = parseFloat(countedCash) || 0
  const diff = counted - systemCash

  function handleSave() {
    save.mutate({
      date,
      systemCash,
      countedCash: counted,
      notes: notes || undefined,
    }, { onSuccess: () => refetch() })
  }

  return (
    <div className="space-y-5">
      {/* Date picker */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-500" htmlFor="cr-date">Date</label>
        <input id="cr-date" type="date" title="Register date" value={date} onChange={(e) => setDate(e.target.value)}
          className="input text-sm w-44" max={todayStr()} />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : (
        <div className="grid grid-cols-3 gap-5">
          {/* Register summary */}
          <div className="col-span-2 space-y-4">
            {/* System balance cards */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Opening Balance', value: data?.opening_balance ?? 0, color: 'text-gray-700' },
                { label: 'Cash In Today',   value: data?.cash_in ?? 0,         color: 'text-green-700' },
                { label: 'Cash Out Today',  value: data?.cash_out ?? 0,        color: 'text-red-600'   },
              ].map((c) => (
                <div key={c.label} className="card p-4">
                  <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                  <div className={`text-xl font-bold ${c.color}`}>{formatINR(c.value)}</div>
                </div>
              ))}
            </div>

            {/* System expected */}
            <div className="card p-4 flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500 mb-1">System Expected Cash in Drawer</div>
                <div className="text-2xl font-bold text-blue-700">{formatINR(systemCash)}</div>
              </div>
              {savedEntry && (
                <div className="text-right">
                  <div className="text-xs text-gray-500 mb-1">Last Counted</div>
                  <div className="text-xl font-bold text-gray-900">{formatINR(savedEntry.counted_cash)}</div>
                  <div className={`text-sm font-medium mt-0.5 ${savedEntry.difference >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {savedEntry.difference >= 0 ? '+' : ''}{formatINR(savedEntry.difference)} variance
                  </div>
                </div>
              )}
            </div>

            {/* Day-end count entry */}
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">Day-End Cash Count</h3>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Cash in Drawer (Physical Count)</label>
                  <input
                    type="number"
                    value={countedCash}
                    onChange={(e) => setCountedCash(e.target.value)}
                    placeholder={`Expected: ${formatINR(systemCash)}`}
                    className="input w-full text-sm"
                    min="0"
                    step="0.01"
                  />
                </div>
                {countedCash !== '' && (
                  <div className={`text-center px-4 ${diff === 0 ? 'text-green-700' : diff > 0 ? 'text-blue-700' : 'text-red-600'}`}>
                    <div className="text-xs text-gray-500 mb-1">Variance</div>
                    <div className="text-lg font-bold">
                      {diff > 0 ? '+' : ''}{formatINR(diff)}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Notes (optional)</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Short change due to broken note"
                  className="input w-full text-sm" maxLength={200} />
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={countedCash === '' || save.isPending}
                className="btn btn-primary text-sm px-4 py-2 disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : 'Save Day-End Count'}
              </button>
            </div>
          </div>

          {/* Cash transactions */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Cash Transactions ({transactions.length})</h3>
            </div>
            {transactions.length === 0 ? (
              <div className="p-6 text-center text-gray-400 text-sm">No cash transactions</div>
            ) : (
              <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
                {transactions.map((t: any) => (
                  <div key={t.id} className="px-4 py-2.5 flex justify-between items-center">
                    <div>
                      <div className="text-sm text-gray-800">{t.party_name ?? 'Walk-in'}</div>
                      <div className="text-xs text-gray-400">{t.created_at}{t.ref_no ? ` · ${t.ref_no}` : ''}</div>
                    </div>
                    <div className={`text-sm font-semibold font-mono ${t.direction === 'inbound' ? 'text-green-700' : 'text-red-600'}`}>
                      {t.direction === 'inbound' ? '+' : '−'}{formatINR(t.amount)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Bank Reconciliation ──────────────────────────────────────────────────
function BankReconciliationTab() {
  const [month, setMonth]         = useState(MONTHS[0]!.value)
  const [selectedAcct, setAcct]   = useState<string | undefined>(undefined)
  const [stmtBalance, setStmt]    = useState('')
  const [notes, setNotes]         = useState('')
  const [showAddAcct, setAddAcct] = useState(false)
  const [newAcct, setNewAcct]     = useState({ name: '', bankName: '', accountNumber: '', openingBalance: '' })

  const { data: acctData }            = useReportsBankAccounts()
  const { data, isLoading, refetch }  = useReportsBankRecon({ month, bankAccountId: selectedAcct })
  const save    = useReportsBankReconSave()
  const addAcct = useReportsBankAccountCreate()

  const accounts: any[] = acctData?.accounts ?? []
  const transactions: any[] = data?.transactions ?? []
  const bookBalance = data?.book_balance ?? 0
  const savedEntry  = data?.saved_entry ?? null
  const stmt        = parseFloat(stmtBalance) || 0
  const diff        = stmt - bookBalance

  function handleSave() {
    save.mutate({
      month,
      bankAccountId: selectedAcct,
      statementBalance: stmt,
      bookBalance,
      notes: notes || undefined,
    }, { onSuccess: () => { refetch(); setStmt('') } })
  }

  function handleAddAccount() {
    addAcct.mutate({
      name: newAcct.name,
      bankName: newAcct.bankName || undefined,
      accountNumber: newAcct.accountNumber || undefined,
      openingBalance: parseFloat(newAcct.openingBalance) || 0,
    }, { onSuccess: () => { setAddAcct(false); setNewAcct({ name: '', bankName: '', accountNumber: '', openingBalance: '' }) } })
  }

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <select title="Select month" value={month} onChange={(e) => setMonth(e.target.value)} className="input w-52 text-sm">
          {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <select
          title="Select bank account"
          value={selectedAcct ?? ''}
          onChange={(e) => setAcct(e.target.value || undefined)}
          className="input w-48 text-sm"
        >
          <option value="">All bank payments</option>
          {accounts.map((a: any) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => setAddAcct(!showAddAcct)}
          className="text-sm text-primary-600 hover:underline">
          + Add bank account
        </button>
      </div>

      {/* Add account form */}
      {showAddAcct && (
        <div className="card p-4 space-y-3 max-w-lg">
          <h3 className="text-sm font-semibold text-gray-900">New Bank Account</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Account Name *</label>
              <input value={newAcct.name} onChange={(e) => setNewAcct(p => ({...p, name: e.target.value}))}
                placeholder="HDFC Current A/C" className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Bank Name</label>
              <input value={newAcct.bankName} onChange={(e) => setNewAcct(p => ({...p, bankName: e.target.value}))}
                placeholder="HDFC Bank" className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Account Number</label>
              <input value={newAcct.accountNumber} onChange={(e) => setNewAcct(p => ({...p, accountNumber: e.target.value}))}
                placeholder="XXXX1234" className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Opening Balance</label>
              <input type="number" value={newAcct.openingBalance}
                onChange={(e) => setNewAcct(p => ({...p, openingBalance: e.target.value}))}
                placeholder="0" className="input text-sm w-full" min="0" />
            </div>
          </div>
          <button type="button" onClick={handleAddAccount}
            disabled={!newAcct.name || addAcct.isPending}
            className="btn btn-primary text-sm px-4 py-2 disabled:opacity-50">
            {addAcct.isPending ? 'Saving…' : 'Add Account'}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : (
        <div className="grid grid-cols-3 gap-5">
          <div className="col-span-2 space-y-4">
            {/* Book vs Statement */}
            <div className="grid grid-cols-2 gap-4">
              <div className="card p-4">
                <div className="text-xs text-gray-500 mb-1">Book Balance (Recorded)</div>
                <div className="text-2xl font-bold text-blue-700">{formatINR(bookBalance)}</div>
                <div className="mt-2 text-xs text-gray-400 space-y-0.5">
                  <div>In: {formatINR(data?.book_in ?? 0)}</div>
                  <div>Out: {formatINR(data?.book_out ?? 0)}</div>
                </div>
              </div>
              {savedEntry ? (
                <div className="card p-4">
                  <div className="text-xs text-gray-500 mb-1">Statement Balance (Saved)</div>
                  <div className="text-2xl font-bold text-gray-900">{formatINR(savedEntry.statement_balance)}</div>
                  <div className={`mt-1 text-sm font-medium ${savedEntry.difference === 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {savedEntry.difference === 0 ? '✓ Reconciled' : `${formatINR(Math.abs(savedEntry.difference))} difference`}
                  </div>
                </div>
              ) : (
                <div className="card p-4 border-2 border-dashed border-gray-200">
                  <div className="text-xs text-gray-500 mb-2">Enter Bank Statement Balance</div>
                  <input type="number" value={stmtBalance}
                    onChange={(e) => setStmt(e.target.value)}
                    placeholder="From bank statement"
                    className="input w-full text-sm mb-2" min="0" step="0.01" />
                  {stmtBalance !== '' && (
                    <div className={`text-sm font-medium mb-2 ${diff === 0 ? 'text-green-600' : 'text-amber-600'}`}>
                      Difference: {diff >= 0 ? '+' : ''}{formatINR(diff)}
                    </div>
                  )}
                  <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes (optional)" className="input w-full text-sm mb-2" />
                  <button type="button" onClick={handleSave}
                    disabled={stmtBalance === '' || save.isPending}
                    className="btn btn-primary text-sm px-3 py-1.5 disabled:opacity-50 w-full">
                    {save.isPending ? 'Saving…' : 'Save Reconciliation'}
                  </button>
                </div>
              )}
            </div>

            {/* Transactions table */}
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">
                  Bank Transactions ({transactions.length})
                </h3>
                {savedEntry && (
                  <button type="button" onClick={() => { setStmt(String(savedEntry.statement_balance)); }}
                    className="text-xs text-primary-600 hover:underline">
                    Edit
                  </button>
                )}
              </div>
              {transactions.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">
                  No bank transfer payments recorded for {month}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left">Date</th>
                      <th className="px-4 py-2 text-left">Party</th>
                      <th className="px-4 py-2 text-left">Ref No</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {transactions.map((t: any) => (
                      <tr key={t.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-500 text-xs">{t.payment_date}</td>
                        <td className="px-4 py-2 text-gray-800">{t.party_name ?? '—'}</td>
                        <td className="px-4 py-2 text-gray-500 font-mono text-xs">{t.ref_no ?? '—'}</td>
                        <td className={`px-4 py-2 text-right font-semibold font-mono ${t.direction === 'inbound' ? 'text-green-700' : 'text-red-600'}`}>
                          {t.direction === 'inbound' ? '+' : '−'}{formatINR(t.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Reconciliation status sidebar */}
          <div className="space-y-4">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Reconciliation Status</h3>
              {savedEntry ? (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Book Balance</span>
                    <span className="font-mono">{formatINR(savedEntry.book_balance)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Statement Balance</span>
                    <span className="font-mono">{formatINR(savedEntry.statement_balance)}</span>
                  </div>
                  <div className={`flex justify-between border-t pt-2 font-semibold ${Math.abs(savedEntry.difference) < 1 ? 'text-green-700' : 'text-red-600'}`}>
                    <span>Difference</span>
                    <span className="font-mono">{formatINR(savedEntry.difference)}</span>
                  </div>
                  {Math.abs(savedEntry.difference) < 1 && (
                    <div className="mt-2 text-center text-green-700 text-xs font-medium bg-green-50 rounded py-1">
                      ✓ Accounts reconciled
                    </div>
                  )}
                  {savedEntry.notes && (
                    <p className="mt-2 text-xs text-gray-400 italic">{savedEntry.notes}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-400">Enter the statement balance to reconcile</p>
              )}
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">How to Reconcile</h3>
              <ol className="text-xs text-gray-500 space-y-1.5 list-decimal list-inside">
                <li>Select the month to reconcile</li>
                <li>Get the closing balance from your bank statement</li>
                <li>Enter it in the "Statement Balance" field</li>
                <li>If difference is ₹0, accounts are reconciled</li>
                <li>If not, check for missing or duplicate entries</li>
              </ol>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Sales vs Purchases ────────────────────────────────────────────────────
function SalesVsPurchasesTab() {
  const [months, setMonths] = useState(6)
  const { data, isLoading, error } = useAnalyticsSalesVsPurchases({ months })

  const rows: any[] = data?.rows ?? []
  const totals = data?.totals ?? { sales: 0, purchases: 0, expenses: 0, profit: 0 }
  const maxVal = Math.max(...rows.flatMap((r: any) => [r.sales, r.expenses]), 1)

  function monthLabel(m: string) {
    return new Date(m + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-500">Show last</span>
        {[3, 6, 12].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setMonths(n)}
            className={`px-3 py-1 text-xs font-medium rounded-md border transition-colors ${
              months === n ? 'bg-primary-50 border-primary-300 text-primary-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {n} months
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Sales',     value: totals.sales,     color: 'text-blue-600'  },
          { label: 'Total Purchases', value: totals.purchases, color: 'text-purple-600' },
          { label: 'Total Expenses',  value: totals.expenses,  color: 'text-amber-600' },
          { label: 'Net Profit',      value: totals.profit,    color: totals.profit >= 0 ? 'text-green-600' : 'text-red-600' },
        ].map((c) => (
          <div key={c.label} className="card p-4">
            <div className="text-xs text-gray-500 mb-1">{c.label}</div>
            <div className={`text-xl font-bold ${c.color}`}>
              {(totals.profit < 0 && c.label === 'Net Profit' ? '−' : '')}{formatINR(Math.abs(c.value))}
            </div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : error ? (
        <div className="text-center py-12 text-red-500">Error loading data</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="p-5 border-b border-gray-100">
            <div className="flex items-end gap-3 h-40">
              {rows.map((r: any) => {
                const sH = maxVal > 0 ? Math.round((r.sales    / maxVal) * 100) : 0
                const eH = maxVal > 0 ? Math.round((r.expenses / maxVal) * 100) : 0
                return (
                  <div key={r.month} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full flex gap-0.5 items-end h-32">
                      {/* eslint-disable-next-line react/forbid-component-props */}
                      <div className="flex-1 bg-blue-400 rounded-t" style={{ height: `${sH}%` }} title={`Sales: ${formatINR(r.sales)}`} />
                      {/* eslint-disable-next-line react/forbid-component-props */}
                      <div className="flex-1 bg-amber-400 rounded-t" style={{ height: `${eH}%` }} title={`Expenses: ${formatINR(r.expenses)}`} />
                    </div>
                    <span className="text-xs text-gray-400">{monthLabel(r.month)}</span>
                  </div>
                )
              })}
            </div>
            <div className="flex gap-4 mt-3">
              <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-3 h-3 rounded-sm bg-blue-400 inline-block" /> Sales</span>
              <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-3 h-3 rounded-sm bg-amber-400 inline-block" /> Expenses</span>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-100">
              <tr>
                <th className="px-4 py-3 text-left">Month</th>
                <th className="px-4 py-3 text-right">Sales</th>
                <th className="px-4 py-3 text-right">Purchases</th>
                <th className="px-4 py-3 text-right">Expenses</th>
                <th className="px-4 py-3 text-right">Net Profit</th>
                <th className="px-4 py-3 text-right">Margin %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((r: any) => {
                const marginPct = r.sales > 0 ? ((r.profit / r.sales) * 100) : 0
                return (
                  <tr key={r.month} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-700">{monthLabel(r.month)}</td>
                    <td className="px-4 py-3 text-right text-blue-700 font-medium">{formatINR(r.sales)}</td>
                    <td className="px-4 py-3 text-right text-purple-700">{formatINR(r.purchases)}</td>
                    <td className="px-4 py-3 text-right text-amber-700">{formatINR(r.expenses)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${r.profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      {r.profit < 0 ? '−' : ''}{formatINR(Math.abs(r.profit))}
                    </td>
                    <td className={`px-4 py-3 text-right text-xs ${marginPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {fmtPct(marginPct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <tr>
                <td className="px-4 py-3 text-gray-700">Total</td>
                <td className="px-4 py-3 text-right text-blue-700">{formatINR(totals.sales)}</td>
                <td className="px-4 py-3 text-right text-purple-700">{formatINR(totals.purchases)}</td>
                <td className="px-4 py-3 text-right text-amber-700">{formatINR(totals.expenses)}</td>
                <td className={`px-4 py-3 text-right ${totals.profit >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                  {totals.profit < 0 ? '−' : ''}{formatINR(Math.abs(totals.profit))}
                </td>
                <td className="px-4 py-3 text-right text-xs text-gray-500">
                  {totals.sales > 0 ? fmtPct((totals.profit / totals.sales) * 100) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Tab: GST Report ────────────────────────────────────────────────────────────
function GSTReportTab() {
  const [month, setMonth] = useState(MONTHS[0]!.value)
  const [view, setView]   = useState<'summary' | 'gstr1'>('summary')

  const { data: summary, isLoading: summaryLoading } = useAnalyticsGstSummary({ month })
  const { data: gstr1,   isLoading: gstr1Loading   } = useReportsGstr1(view === 'gstr1' ? { month } : undefined)

  const s = summary?.summary

  function downloadCSV(rows: any[], filename: string) {
    if (!rows.length) return
    const keys = Object.keys(rows[0])
    const csv  = [keys.join(','), ...rows.map(r => keys.map(k => JSON.stringify(r[k] ?? '')).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a    = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = filename; a.click()
  }

  function exportTallyXML() {
    const b2b: any[] = gstr1?.tables?.b2b ?? []
    const b2c: any[] = gstr1?.tables?.b2c_small ?? []
    const allRows = [...b2b, ...b2c]
    if (!allRows.length) { alert('No invoice data to export. Switch to GSTR-1 Detail view first.'); return }

    const vouchers = b2b.map((r: any) => `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>${(r.invoice_date ?? '').replace(/-/g, '')}</DATE>
        <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${r.invoice_no ?? ''}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${r.party_name ?? ''}</PARTYLEDGERNAME>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>Sales</LEDGERNAME>
          <AMOUNT>-${Number(r.taxable_value ?? 0).toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>GST</LEDGERNAME>
          <AMOUNT>-${(Number(r.cgst ?? 0) + Number(r.sgst ?? 0) + Number(r.igst ?? 0)).toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${r.party_name ?? 'Sundry Debtors'}</LEDGERNAME>
          <AMOUNT>${Number(r.invoice_value ?? 0).toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>
    </TALLYMESSAGE>`).join('')

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
    <REQUESTDATA>${vouchers}
    </REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`

    const blob = new Blob([xml], { type: 'text/xml' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `Tally_GSTR1_${month}.xml`; a.click()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 flex-wrap">
        <select title="Select month" value={month} onChange={(e) => setMonth(e.target.value)} className="input w-52 text-sm">
          {MONTHS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <button type="button" onClick={exportTallyXML}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
          <Download className="w-3.5 h-3.5" /> Export Tally XML
        </button>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[{ key: 'summary', label: 'Summary' }, { key: 'gstr1', label: 'GSTR-1 Detail' }].map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key as any)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                view === v.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'summary' && (
        summaryLoading ? <div className="text-center py-12 text-gray-400">Loading…</div> : !s ? null : (
          <div className="space-y-5">
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: 'Total Invoice Value', value: formatINR(s.total_invoice_value) },
                { label: 'Taxable Value',        value: formatINR(s.taxable_amt) },
                { label: 'Total Tax (GST)',      value: formatINR(s.cgst + s.sgst + s.igst) },
                { label: 'Total Invoices',       value: String(s.invoice_count) },
              ].map((c) => (
                <div key={c.label} className="card p-4">
                  <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                  <div className="text-xl font-bold text-gray-900">{c.value}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Tax Breakup (GSTR-3B)</h3>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-50">
                    {[
                      { label: 'CGST', value: s.cgst },
                      { label: 'SGST', value: s.sgst },
                      { label: 'IGST', value: s.igst },
                      { label: 'Cess', value: s.cess },
                    ].map((r) => (
                      <tr key={r.label}>
                        <td className="py-2 text-gray-600">{r.label}</td>
                        <td className="py-2 text-right font-medium text-gray-900">{formatINR(r.value)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-gray-200">
                      <td className="py-2 font-semibold text-gray-900">Total Output Tax</td>
                      <td className="py-2 text-right font-bold text-gray-900">{formatINR(s.cgst + s.sgst + s.igst)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="card p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">B2B vs B2C Split</h3>
                <div className="space-y-3">
                  {summary?.b2b_vs_b2c?.map((r: any) => (
                    <div key={r.type}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-600">{r.type} ({r.count} invoices)</span>
                        <span className="font-medium">{formatINR(r.taxable)}</span>
                      </div>
                      <Bar value={r.taxable} max={s.taxable_amt} color="bg-primary-400" />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {summary?.rate_wise?.length > 0 && (
              <div className="card p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Rate-wise Tax (GSTR-3B Table 3.1)</h3>
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500 border-b border-gray-100">
                    <tr>
                      <th className="pb-2 text-left">GST Rate</th>
                      <th className="pb-2 text-right">Taxable Value</th>
                      <th className="pb-2 text-right">Tax Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {summary.rate_wise.map((r: any) => (
                      <tr key={r.gst_rate}>
                        <td className="py-2 text-gray-700">{r.gst_rate}%</td>
                        <td className="py-2 text-right">{formatINR(r.taxable_value)}</td>
                        <td className="py-2 text-right font-medium">{formatINR(r.tax_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {summary?.hsn_summary?.length > 0 && (
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">HSN Summary (Table 12)</h3>
                  <button type="button" onClick={() => downloadCSV(summary.hsn_summary, `HSN_${month}.csv`)}
                    className="flex items-center gap-1 text-xs text-primary-600 hover:underline">
                    <Download className="w-3.5 h-3.5" /> Export CSV
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left">HSN/SAC</th>
                      <th className="px-4 py-2 text-left">Description</th>
                      <th className="px-4 py-2 text-right">Qty</th>
                      <th className="px-4 py-2 text-right">Taxable Value</th>
                      <th className="px-4 py-2 text-right">CGST</th>
                      <th className="px-4 py-2 text-right">SGST</th>
                      <th className="px-4 py-2 text-right">IGST</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {summary.hsn_summary.map((r: any) => (
                      <tr key={r.hsn} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-700">{r.hsn}</td>
                        <td className="px-4 py-2 text-gray-600 max-w-[180px] truncate">{r.description ?? '—'}</td>
                        <td className="px-4 py-2 text-right text-gray-600">{Number(r.qty).toFixed(2)} {r.uqc}</td>
                        <td className="px-4 py-2 text-right">{formatINR(r.taxable_value)}</td>
                        <td className="px-4 py-2 text-right text-xs">{formatINR(r.cgst)}</td>
                        <td className="px-4 py-2 text-right text-xs">{formatINR(r.sgst)}</td>
                        <td className="px-4 py-2 text-right text-xs">{formatINR(r.igst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      )}

      {view === 'gstr1' && (
        gstr1Loading ? <div className="text-center py-12 text-gray-400">Loading…</div> : !gstr1 ? null : (
          <div className="space-y-5">
            {gstr1.tables?.b2b?.length > 0 && (
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Table 4 — B2B Invoices ({gstr1.tables.b2b.length})</h3>
                  <button type="button" onClick={() => downloadCSV(gstr1.tables.b2b, `GSTR1_B2B_${month}.csv`)}
                    className="flex items-center gap-1 text-xs text-primary-600 hover:underline">
                    <Download className="w-3.5 h-3.5" /> Export
                  </button>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">GSTIN</th>
                      <th className="px-3 py-2 text-left">Party</th>
                      <th className="px-3 py-2 text-left">Invoice No</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-right">Value</th>
                      <th className="px-3 py-2 text-right">Taxable</th>
                      <th className="px-3 py-2 text-right">CGST</th>
                      <th className="px-3 py-2 text-right">SGST</th>
                      <th className="px-3 py-2 text-right">IGST</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {gstr1.tables.b2b.map((r: any) => (
                      <tr key={r.invoice_no} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-gray-600">{r.gstin}</td>
                        <td className="px-3 py-2 text-gray-700">{r.party_name}</td>
                        <td className="px-3 py-2 text-gray-700">{r.invoice_no}</td>
                        <td className="px-3 py-2 text-gray-500">{r.invoice_date}</td>
                        <td className="px-3 py-2 text-right">{formatINR(r.invoice_value)}</td>
                        <td className="px-3 py-2 text-right">{formatINR(r.taxable_value)}</td>
                        <td className="px-3 py-2 text-right">{formatINR(r.cgst)}</td>
                        <td className="px-3 py-2 text-right">{formatINR(r.sgst)}</td>
                        <td className="px-3 py-2 text-right">{formatINR(r.igst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {gstr1.tables?.b2c_small?.length > 0 && (
              <div className="card overflow-hidden">
                <div className="p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Table 7 — B2C (Consolidated by rate)</h3>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left">Place of Supply</th>
                      <th className="px-4 py-2 text-right">GST Rate</th>
                      <th className="px-4 py-2 text-right">Taxable Value</th>
                      <th className="px-4 py-2 text-right">CGST</th>
                      <th className="px-4 py-2 text-right">SGST</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {gstr1.tables.b2c_small.map((r: any, i: number) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-700">{r.place_of_supply}</td>
                        <td className="px-4 py-2 text-right">{r.gst_rate}%</td>
                        <td className="px-4 py-2 text-right">{formatINR(r.taxable_value)}</td>
                        <td className="px-4 py-2 text-right">{formatINR(r.cgst)}</td>
                        <td className="px-4 py-2 text-right">{formatINR(r.sgst)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {gstr1.tables?.b2b?.length === 0 && gstr1.tables?.b2c_small?.length === 0 && (
              <div className="text-center py-12 text-gray-400">No invoices found for {month}</div>
            )}
          </div>
        )
      )}
    </div>
  )
}

// ── Tab: Margin by Product ─────────────────────────────────────────────────────
const SERVICE_DOMAINS = new Set([
  'salon', 'gym', 'clinic', 'coaching', 'photography', 'laundry',
  'diagnostic_lab', 'pest_control', 'catering', 'tiffin', 'repair',
])

function MarginTab() {
  const domainType = useAuthStore((s) => s.branch?.domainType as string | undefined)
  const isServiceDomain = SERVICE_DOMAINS.has(domainType ?? '')
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d')
  const { data, isLoading } = useAnalyticsMargin({ period })

  const summary    = data?.summary    ?? { totalRevenue: 0, totalCOGS: 0, grossProfit: 0, marginPct: 0 }
  const byProduct  = data?.by_product  ?? []
  const byCategory = data?.by_category ?? []
  const maxRev     = Math.max(...byProduct.map((r: any) => r.revenue), 1)

  return (
    <div className="space-y-5">
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {(['7d', '30d', '90d'] as const).map((p) => (
          <button key={p} type="button" onClick={() => setPeriod(p)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              period === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}>
            {p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : 'Last 90 days'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Revenue',      value: formatINR(summary.totalRevenue), color: 'text-blue-600'  },
              { label: 'COGS',         value: formatINR(summary.totalCOGS),    color: 'text-red-600'   },
              { label: 'Gross Profit', value: formatINR(summary.grossProfit),  color: 'text-green-600' },
              { label: 'Gross Margin', value: fmtPct(summary.marginPct),
                color: summary.marginPct >= 30 ? 'text-green-600' : summary.marginPct >= 15 ? 'text-amber-600' : 'text-red-600' },
            ].map((c) => (
              <div key={c.label} className="card p-4">
                <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                <div className={`text-xl font-bold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {byProduct.length === 0 ? (
            <div className="card p-8 text-center space-y-2">
              <p className="text-sm text-gray-500 font-medium">No margin data available</p>
              {isServiceDomain ? (
                <p className="text-xs text-gray-400">
                  Margin tracking is designed for product-based businesses. For services, add a cost price to each service item in your product master to track profitability.
                </p>
              ) : (
                <p className="text-xs text-gray-400">
                  Add purchase prices to your products to see margins. Go to <strong>Inventory → Products</strong> and set the purchase price for each item.
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-5">
              <div className="card overflow-hidden">
                <div className="p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Top 10 Products by Revenue</h3>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left">Product</th>
                      <th className="px-4 py-2 text-right">Revenue</th>
                      <th className="px-4 py-2 text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {byProduct.map((r: any) => (
                      <tr key={r.name} className="hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <div className="text-gray-800 truncate max-w-[150px]">{r.name}</div>
                          <Bar value={r.revenue} max={maxRev} color="bg-primary-300" />
                        </td>
                        <td className="px-4 py-2 text-right text-gray-700">{formatINR(r.revenue)}</td>
                        <td className={`px-4 py-2 text-right font-semibold ${r.margin_pct >= 20 ? 'text-green-600' : r.margin_pct >= 10 ? 'text-amber-600' : 'text-red-600'}`}>
                          {fmtPct(r.margin_pct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card overflow-hidden">
                <div className="p-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">Margin by Category</h3>
                </div>
                {byCategory.length === 0 ? (
                  <div className="p-6 text-center text-gray-400 text-sm">No category data</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500">
                      <tr>
                        <th className="px-4 py-2 text-left">Category</th>
                        <th className="px-4 py-2 text-right">Revenue</th>
                        <th className="px-4 py-2 text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {byCategory.map((r: any) => (
                        <tr key={r.category} className="hover:bg-gray-50">
                          <td className="px-4 py-2 text-gray-700">{r.category}</td>
                          <td className="px-4 py-2 text-right text-gray-700">{formatINR(r.revenue)}</td>
                          <td className={`px-4 py-2 text-right font-semibold ${r.margin_pct >= 20 ? 'text-green-600' : r.margin_pct >= 10 ? 'text-amber-600' : 'text-red-600'}`}>
                            {fmtPct(r.margin_pct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Tab: Day Book ──────────────────────────────────────────────────────────────
function DayBookTab() {
  const [date, setDate] = useState(todayStr())
  const [applied, setApplied] = useState(todayStr())
  const { data, isLoading, error } = useDayBook({ date: applied })

  const summary        = (data as any)?.summary ?? {}
  const saleInvoices   = (data as any)?.sale_invoices     ?? []
  const purchaseInvs   = (data as any)?.purchase_invoices  ?? []
  const otherInvs      = (data as any)?.other_invoices     ?? []
  const payments       = (data as any)?.payments           ?? []
  const modeReceipts   = (data as any)?.receipts_by_mode   ?? {}

  return (
    <div className="space-y-5">
      {/* Date picker */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-500" htmlFor="db-date">Date</label>
        <input id="db-date" type="date" title="Day book date" value={date}
          onChange={(e) => setDate(e.target.value)}
          className="input text-sm w-44" max={todayStr()} />
        <button type="button" onClick={() => setApplied(date)}
          className="btn btn-primary text-sm px-4 py-2">Apply</button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-400">Loading…</div>
      ) : error ? (
        <div className="text-center py-12 text-red-500">Failed to load day book</div>
      ) : (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Total Sales',     value: summary.total_sales     ?? 0, color: 'text-blue-700'    },
              { label: 'Total Purchases', value: summary.total_purchases  ?? 0, color: 'text-purple-700'  },
              { label: 'Total Receipts',  value: summary.total_receipts   ?? 0, color: 'text-green-700'   },
              { label: 'Net Cash In',     value: summary.net_cash_in      ?? 0, color: 'text-emerald-700' },
            ].map((c) => (
              <div key={c.label} className="card p-4">
                <div className="text-xs text-gray-500 mb-1">{c.label}</div>
                <div className={`text-xl font-bold ${c.color}`}>{formatINR(c.value)}</div>
              </div>
            ))}
          </div>

          {/* Cash position */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4">
              <div className="text-xs text-gray-500 mb-1">Opening Cash Balance</div>
              <div className="text-lg font-bold text-gray-900">{formatINR((data as any)?.opening_cash_balance ?? 0)}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-gray-500 mb-1">Closing Cash Balance</div>
              <div className="text-lg font-bold text-gray-900">{formatINR((data as any)?.closing_cash_balance ?? 0)}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-gray-500 mb-1">Credit Sales (Udhaar)</div>
              <div className="text-lg font-bold text-amber-700">{formatINR(summary.credit_sales ?? 0)}</div>
            </div>
          </div>

          {/* Receipts by mode */}
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Receipts by Payment Mode</h3>
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Cash',  value: modeReceipts.cash  ?? 0 },
                { label: 'UPI',   value: modeReceipts.upi   ?? 0 },
                { label: 'Card',  value: modeReceipts.card  ?? 0 },
                { label: 'Other', value: modeReceipts.other ?? 0 },
              ].map(m => (
                <div key={m.label} className="text-center">
                  <div className="text-xs text-gray-500 mb-1">{m.label}</div>
                  <div className="text-base font-semibold text-gray-900">{formatINR(m.value)}</div>
                </div>
              ))}
            </div>
          </div>

          {saleInvoices.length > 0 && (
            <DayBookSection title={`Sales (${saleInvoices.length})`} rows={saleInvoices} />
          )}
          {purchaseInvs.length > 0 && (
            <DayBookSection title={`Purchases (${purchaseInvs.length})`} rows={purchaseInvs} />
          )}
          {otherInvs.length > 0 && (
            <DayBookSection title={`Other Documents (${otherInvs.length})`} rows={otherInvs} />
          )}

          {payments.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">Payment Receipts ({payments.length})</h3>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Time</th>
                    <th className="px-4 py-2 text-left">Party</th>
                    <th className="px-4 py-2 text-left">Method</th>
                    <th className="px-4 py-2 text-left">Ref</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {payments.map((p: any) => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-400 text-xs">{p.created_at}</td>
                      <td className="px-4 py-2 text-gray-700">{p.party_name ?? 'Walk-in'}</td>
                      <td className="px-4 py-2 capitalize text-gray-600">{p.method}</td>
                      <td className="px-4 py-2 text-gray-400 font-mono text-xs">{p.ref_no ?? '—'}</td>
                      <td className="px-4 py-2 text-right font-semibold text-green-700">{formatINR(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {saleInvoices.length === 0 && purchaseInvs.length === 0 && payments.length === 0 && (
            <div className="text-center py-12 text-gray-400">No transactions on {applied}</div>
          )}
        </div>
      )}
    </div>
  )
}

function DayBookSection({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="p-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-4 py-2 text-left">Time</th>
            <th className="px-4 py-2 text-left">Invoice No</th>
            <th className="px-4 py-2 text-left">Party</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Paid</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((r: any) => (
            <tr key={r.id} className="hover:bg-gray-50">
              <td className="px-4 py-2 text-gray-400 text-xs">{r.created_at}</td>
              <td className="px-4 py-2 font-mono text-xs text-gray-700">{r.number}</td>
              <td className="px-4 py-2 text-gray-700">{r.party_name ?? 'Walk-in'}</td>
              <td className="px-4 py-2">
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  r.status === 'paid' ? 'bg-green-100 text-green-700'
                  : r.status === 'partial' ? 'bg-amber-100 text-amber-700'
                  : 'bg-gray-100 text-gray-600'
                }`}>{r.status}</span>
              </td>
              <td className="px-4 py-2 text-right font-semibold text-gray-900">{formatINR(r.grand_total)}</td>
              <td className="px-4 py-2 text-right text-green-700">{formatINR(r.paid_amt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
