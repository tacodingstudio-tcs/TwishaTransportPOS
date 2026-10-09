// src/pages/ExpensePage.tsx
import { useState } from 'react'
import { Plus, Trash2, Pencil, TrendingDown, X, Check } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  useExpenses, useExpenseSummary, useExpenseCategories,
  useCreateExpense, useUpdateExpense, useDeleteExpense,
  useBranches,
} from '@/hooks/useApi'
import { useParties } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'

// ── Date helpers ──────────────────────────────────────────────────────────────
function monthRange(offset = 0) {
  const now  = new Date()
  const year = now.getFullYear()
  const mon  = now.getMonth() + offset
  const from = new Date(year, mon, 1)
  const to   = new Date(year, mon + 1, 0)
  const fmt  = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(from), to: fmt(to) }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

function fmtAmount(n: number) {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

const PAYMENT_MODES = ['cash', 'upi', 'bank', 'credit'] as const
type PaymentMode = typeof PAYMENT_MODES[number]
const MODE_LABEL: Record<PaymentMode, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank', credit: 'Credit' }
const MODE_COLOR: Record<PaymentMode, string> = {
  cash:   'bg-green-100 text-green-700',
  upi:    'bg-blue-100 text-blue-700',
  bank:   'bg-purple-100 text-purple-700',
  credit: 'bg-orange-100 text-orange-700',
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function ExpensePage() {
  const [range, setRange]          = useState(monthRange(0))
  const [filterCat, setFilterCat]  = useState('')
  const [filterBranch, setFilterBranch] = useState('')
  const [showAdd, setShowAdd]      = useState(false)
  const [editExpense, setEditExpense] = useState<any | null>(null)

  const role               = useAuthStore((s) => s.user?.role)
  const { data: branches } = useBranches()

  const branchParam = filterBranch || undefined   // undefined = current branch (default)

  const { data: categories = [] } = useExpenseCategories()
  const { data: summary }         = useExpenseSummary({ ...range, branchId: branchParam })
  const { data: list, isLoading } = useExpenses({
    from:     range.from,
    to:       range.to,
    category: filterCat || undefined,
    branchId: branchParam,
    limit:    100,
  })
  const deleteExpense = useDeleteExpense()

  // Client-side safety filter: if a specific branch is selected, ensure only
  // that branch's expenses are shown even if server returns more.
  const allExpenses = list?.data ?? []
  const expenses = filterBranch && filterBranch !== 'all'
    ? allExpenses.filter((e: any) => e.branchId === filterBranch)
    : allExpenses

  // Month navigation
  const [monthOffset, setMonthOffset] = useState(0)
  function shiftMonth(delta: number) {
    const next = monthOffset + delta
    setMonthOffset(next)
    setRange(monthRange(next))
  }

  const monthLabel = new Date(range.from).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle={summary ? `${fmtAmount(summary.totalAmount)} this month` : undefined}
        action={
          <button type="button" onClick={() => setShowAdd(true)} className="btn-primary">
            <Plus className="w-4 h-4" /> Add Expense
          </button>
        }
      />

      <div className="p-8 space-y-6">

        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-4 gap-4">
            <div className="card p-4 col-span-1">
              <div className="text-xs text-gray-400 mb-1">Total Expenses</div>
              <div className="text-2xl font-bold text-gray-900">{fmtAmount(summary.totalAmount)}</div>
              {summary.totalGst > 0 && (
                <div className="text-xs text-gray-400 mt-1">GST paid: {fmtAmount(summary.totalGst)}</div>
              )}
            </div>
            {summary.byCategory.slice(0, 3).map((c: any) => (
              <div key={c.category} className="card p-4">
                <div className="text-xs text-gray-400 mb-1 flex items-center gap-1">
                  <span>{c.icon}</span> {c.label}
                </div>
                <div className="text-xl font-semibold text-gray-900">{fmtAmount(c.total)}</div>
                <div className="text-xs text-gray-400 mt-1">
                  {summary.totalAmount > 0
                    ? Math.round((c.total / summary.totalAmount) * 100) + '% of total'
                    : ''}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Branch filter — owner only */}
        {role === 'owner' && (branches ?? []).length > 1 && (
          <div className="flex items-center gap-2">
            <select
              value={filterBranch}
              onChange={(e) => setFilterBranch(e.target.value)}
              className="input w-52 text-sm"
              aria-label="Filter by branch"
            >
              <option value="">Current branch</option>
              <option value="all">All branches</option>
              {(branches ?? []).map((b: any) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Month navigator + category filter */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="btn-ghost px-2 py-1 text-sm">‹</button>
            <span className="text-sm font-medium text-gray-700 min-w-[120px] text-center">{monthLabel}</span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              disabled={monthOffset >= 0}
              className="btn-ghost px-2 py-1 text-sm disabled:opacity-30"
            >›</button>
          </div>

          {/* Category filter chips */}
          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
            <button
              type="button"
              onClick={() => setFilterCat('')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                !filterCat ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            {categories.map((c: any) => (
              <button
                key={c.code}
                type="button"
                onClick={() => setFilterCat(filterCat === c.code ? '' : c.code)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap flex items-center gap-1 transition-colors ${
                  filterCat === c.code
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                <span>{c.icon}</span> {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Expense list */}
        {isLoading && <div className="text-gray-400 text-center py-12">Loading…</div>}
        {!isLoading && expenses.length === 0 && (
          <div className="text-center py-16">
            <TrendingDown className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-400">No expenses recorded for this period.</p>
            <button type="button" onClick={() => setShowAdd(true)} className="btn-primary mt-4">
              <Plus className="w-4 h-4" /> Add first expense
            </button>
          </div>
        )}

        {expenses.length > 0 && (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Category</th>
                  <th className="px-4 py-3 text-left">Description</th>
                  {filterBranch === 'all' && <th className="px-4 py-3 text-left">Branch</th>}
                  <th className="px-4 py-3 text-left">Vendor</th>
                  <th className="px-4 py-3 text-left">Mode</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {expenses.map((exp: any) => {
                  const cat = categories.find((c: any) => c.code === exp.category)
                  return (
                    <tr key={exp.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(exp.date)}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5">
                          <span>{cat?.icon ?? '📎'}</span>
                          <span className="text-gray-700">{cat?.label ?? exp.category}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-[200px] truncate">
                        {exp.description || exp.referenceNo || '—'}
                      </td>
                      {filterBranch === 'all' && (
                        <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{exp.branchName ?? '—'}</td>
                      )}
                      <td className="px-4 py-3 text-gray-500 text-xs">{exp.partyId ? '•' : '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${MODE_COLOR[exp.paymentMode as PaymentMode] ?? ''}`}>
                          {MODE_LABEL[exp.paymentMode as PaymentMode] ?? exp.paymentMode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {fmtAmount(Number(exp.amount))}
                        {exp.gstRate > 0 && (
                          <div className="text-xs text-gray-400 font-normal">+{exp.gstRate}% GST</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => setEditExpense(exp)}
                            title="Edit"
                            className="p-1 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (confirm('Delete this expense?')) deleteExpense.mutate(exp.id)
                            }}
                            title="Delete"
                            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50">
                <tr>
                  <td colSpan={filterBranch === 'all' ? 6 : 5} className="px-4 py-3 text-sm font-medium text-gray-600">Total</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">
                    {fmtAmount(expenses.reduce((s: number, e: any) => s + Number(e.amount), 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {showAdd && (
        <ExpenseModal
          categories={categories}
          onClose={() => setShowAdd(false)}
        />
      )}

      {editExpense && (
        <ExpenseModal
          categories={categories}
          expense={editExpense}
          onClose={() => setEditExpense(null)}
        />
      )}
    </div>
  )
}

// ── Add / Edit Modal ──────────────────────────────────────────────────────────
function ExpenseModal({
  categories,
  expense,
  onClose,
}: {
  categories: any[]
  expense?:   any
  onClose:    () => void
}) {
  const isEdit       = !!expense
  const createExp    = useCreateExpense()
  const updateExp    = useUpdateExpense()
  const { data: partiesData } = useParties({ limit: 200 })
  const parties      = partiesData?.data ?? []

  const today = new Date().toISOString().slice(0, 10)

  const [form, setForm] = useState({
    date:          expense?.date?.slice(0, 10) ?? today,
    category:      expense?.category           ?? (categories[0]?.code ?? ''),
    description:   expense?.description        ?? '',
    amount:        expense ? String(Number(expense.amount)) : '',
    gstRate:       expense ? String(expense.gstRate) : '0',
    paymentMode:   expense?.paymentMode        ?? 'cash',
    partyId:       expense?.partyId            ?? '',
    referenceNo:   expense?.referenceNo        ?? '',
    notes:         expense?.notes              ?? '',
    isRecurring:   expense?.isRecurring        ?? false,
    recurrence:    expense?.recurrence         ?? 'monthly',
  })

  const amount    = Number(form.amount) || 0
  const gstRate   = Number(form.gstRate)
  const gstAmount = +(amount * gstRate / (100 + gstRate)).toFixed(2)

  async function handleSubmit() {
    if (!form.amount || !form.category) return
    const payload = {
      date:        form.date,
      category:    form.category,
      description: form.description   || undefined,
      amount:      Number(form.amount),
      gstRate:     Number(form.gstRate),
      paymentMode: form.paymentMode,
      partyId:     form.partyId       || undefined,
      referenceNo: form.referenceNo   || undefined,
      notes:       form.notes         || undefined,
      isRecurring: form.isRecurring,
      recurrence:  form.isRecurring ? form.recurrence : undefined,
    }
    if (isEdit) {
      await updateExp.mutateAsync({ id: expense.id, data: payload })
    } else {
      await createExp.mutateAsync(payload)
    }
    onClose()
  }

  const isPending = createExp.isPending || updateExp.isPending

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Edit expense' : 'Add expense'}
          </h3>
          <button type="button" onClick={onClose} title="Close" className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Category */}
          <div>
            <label className="label" htmlFor="exp-category">Category</label>
            <select
              id="exp-category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="input"
            >
              {categories.map((c: any) => (
                <option key={c.code} value={c.code}>{c.icon} {c.label}</option>
              ))}
            </select>
          </div>

          {/* Amount + GST */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="exp-amount">Amount (₹)</label>
              <input
                id="exp-amount"
                type="number"
                placeholder="0"
                autoFocus
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="exp-gst">GST rate</label>
              <select
                id="exp-gst"
                value={form.gstRate}
                onChange={(e) => setForm({ ...form, gstRate: e.target.value })}
                className="input"
              >
                {[0, 5, 12, 18, 28].map((r) => (
                  <option key={r} value={r}>{r}%</option>
                ))}
              </select>
            </div>
          </div>
          {gstAmount > 0 && (
            <p className="text-xs text-gray-400 -mt-1">
              GST included: ₹{gstAmount} · Base: ₹{(amount - gstAmount).toFixed(2)}
            </p>
          )}

          {/* Date + Payment mode */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="exp-date">Date</label>
              <input
                id="exp-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="exp-mode">Payment mode</label>
              <select
                id="exp-mode"
                value={form.paymentMode}
                onChange={(e) => setForm({ ...form, paymentMode: e.target.value })}
                className="input"
              >
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>{MODE_LABEL[m]}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="label" htmlFor="exp-desc">Description (optional)</label>
            <input
              id="exp-desc"
              placeholder="e.g. June rent, Supplier payment"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="input"
            />
          </div>

          {/* Vendor + Ref no */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="exp-party">Vendor (optional)</label>
              <select
                id="exp-party"
                value={form.partyId}
                onChange={(e) => setForm({ ...form, partyId: e.target.value })}
                className="input"
              >
                <option value="">— None —</option>
                {parties.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="exp-ref">Bill / Ref no.</label>
              <input
                id="exp-ref"
                placeholder="INV-441"
                value={form.referenceNo}
                onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
                className="input"
              />
            </div>
          </div>

          {/* Recurring toggle */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
            <button
              type="button"
              onClick={() => setForm({ ...form, isRecurring: !form.isRecurring })}
              className={`w-9 h-5 rounded-full transition-colors flex items-center ${form.isRecurring ? 'bg-primary-600' : 'bg-gray-300'}`}
              aria-label="Toggle recurring"
            >
              <span className={`w-4 h-4 bg-white rounded-full shadow transition-transform mx-0.5 ${form.isRecurring ? 'translate-x-4' : ''}`} />
            </button>
            <span className="text-sm text-gray-700">Recurring expense</span>
            {form.isRecurring && (
              <select
                value={form.recurrence}
                onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
                className="input ml-auto w-28 text-xs"
                aria-label="Recurrence frequency"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            )}
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 justify-center">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending || !form.amount || !form.category}
            className="btn-primary flex-1 justify-center"
          >
            {isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Expense'}
          </button>
        </div>
      </div>
    </div>
  )
}
