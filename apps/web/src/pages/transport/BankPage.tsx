// Bank statements — import the statement from net banking, tell the app what each line was, and see that books and
// bank agree. Every line ends up as: a receipt against bills (with the TDS the customer cut), a pump payment, an
// expense, or a label like "Owner drawings". Nothing is guessed silently: only certain matches are made automatically.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Landmark, Plus, Upload, Wand2, Loader2, X, Check, Undo2, EyeOff, Eye, FileSpreadsheet, AlertTriangle, ArrowDownLeft, ArrowUpRight, Trash2,
} from 'lucide-react'
import { parseBankStatementRows, BANK_LINE_LABELS, type BankColumnMap, type BankParseResult } from '@billing/shared'
import { transportApi, expenseApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { PartyCombobox, type PickedParty } from '@/components/ui/PartyCombobox'
import { readSpreadsheet } from '@/lib/excel'
import { useCurrentFirm } from '@/hooks/useFirms'
import { PeriodBar, usePeriod } from '@/components/transport/PeriodBar'
import { useCursorPager } from '@/hooks/useCursorPager'
import { CursorPager } from '@/components/ui/CursorPager'
import { inr, fmtDate, todayIst } from '@/components/transport/format'

type Status = 'unmatched' | 'matched' | 'ignored'
type Tab = Status | 'reconcile' | 'imports'
interface Account { id: string; name: string; bankName: string | null; accountMask: string | null; ifscCode: string | null; openingBalance: number; lines: number; unmatched: number; unmatchedIn: number; unmatchedOut: number; lastDate: string | null; statementBalance: number | null }
interface Line { id: string; date: string; description: string; refNo: string | null; debit: number; credit: number; balance: number | null; status: Status; matchKind: string | null; label: string | null; matchedTo: string | null; createdEntries: boolean; notes: string | null }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Refresh everything a match can change. */
function useRefresh() {
  const qc = useQueryClient()
  return () => {
    for (const k of ['bank-accounts', 'bank-lines', 'bank-recon', 'bank-imports', 'transport-payables', 'transport-expenses', 'invoices', 'invoice', 'parties', 'aging', 'ca'])
      qc.invalidateQueries({ queryKey: [k] })
  }
}

export function BankPage() {
  const role = useAuthStore((s) => s.user?.role)
  const canWrite = role !== 'viewer'
  const canManage = role === 'owner' || role === 'manager'
  const { firm } = useCurrentFirm()
  const refresh = useRefresh()

  const { data: accounts = [], isLoading } = useQuery<Account[]>({ queryKey: ['bank-accounts'], queryFn: transportApi.bankAccounts })
  const [acctId, setAcctId] = useState('')
  const acct = accounts.find((a) => a.id === acctId) ?? accounts[0]
  useEffect(() => { if (accounts.length && !accounts.some((a) => a.id === acctId)) setAcctId(accounts[0]!.id) }, [accounts, acctId])

  const [tab, setTab] = useState<Tab>('unmatched')
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [matching, setMatching] = useState<Line | null>(null)

  const auto = useMutation({
    mutationFn: () => transportApi.bankAutoMatch(acct!.id),
    onSuccess: (r: any) => {
      const n = r.receipts + r.pumps + r.expenses
      toast.success(n ? `Matched ${n} line${n === 1 ? '' : 's'} automatically (${r.receipts} receipts, ${r.pumps} pump payments, ${r.expenses} expenses)` : `Looked at ${r.examined} lines — nothing was certain enough to match by itself`)
      refresh()
    },
    onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div>
      <PageHeader
        title="Bank statements"
        subtitle={`${firm?.name ?? ''} — match every bank line to what it was`}
        action={
          <div className="flex gap-2">
            {canManage && <button type="button" className="btn-ghost" onClick={() => setAdding(true)}><Plus className="w-4 h-4" /> Add bank account</button>}
            {canWrite && acct && <button type="button" className="btn-primary" onClick={() => setImporting(true)}><Upload className="w-4 h-4" /> Import statement</button>}
          </div>
        }
      />
      <div className="p-6 space-y-5 max-w-7xl">
        {isLoading ? <div className="text-center text-gray-400 py-16">Loading…</div>
          : accounts.length === 0 ? <EmptyState canManage={canManage} onAdd={() => setAdding(true)} />
          : (
            <>
              {/* accounts */}
              <div className="flex flex-wrap gap-2">
                {accounts.map((a) => (
                  <button key={a.id} type="button" onClick={() => { setAcctId(a.id); setTab('unmatched') }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left ${a.id === acct?.id ? 'border-primary-400 bg-primary-50 ring-1 ring-primary-200' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                    <Landmark className="w-4 h-4 text-gray-500" />
                    <span>
                      <span className="block text-sm font-semibold text-gray-900">{a.name}</span>
                      <span className="block text-[11px] text-gray-500">{[a.bankName, a.accountMask].filter(Boolean).join(' · ') || 'Bank account'}</span>
                    </span>
                    {a.unmatched > 0 && <span className="ml-1 rounded-full bg-amber-500 text-white text-[11px] font-bold px-1.5 min-w-[1.25rem] text-center">{a.unmatched}</span>}
                  </button>
                ))}
              </div>

              {acct && (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <Stat label="Needs matching" value={String(acct.unmatched)} sub={acct.unmatched ? `${inr(acct.unmatchedIn)} in · ${inr(acct.unmatchedOut)} out` : 'all lines are classified'} tone={acct.unmatched ? 'amber' : 'green'} />
                    <Stat label="Statement balance" value={acct.statementBalance == null ? '—' : inr(acct.statementBalance, 2)} sub={acct.lastDate ? `as of ${fmtDate(acct.lastDate)}` : 'no statement imported yet'} />
                    <Stat label="Lines imported" value={String(acct.lines)} sub={acct.lastDate ? `latest ${fmtDate(acct.lastDate)}` : ''} />
                    <div className="card p-4 flex flex-col justify-center gap-2">
                      {canWrite && <button type="button" className="btn-ghost text-sm justify-center" disabled={auto.isPending || acct.unmatched === 0} onClick={() => auto.mutate()}>
                        {auto.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Match what is certain
                      </button>}
                      <p className="text-[11px] text-gray-400 text-center">Same reference, same amount, same pump — never a guess.</p>
                    </div>
                  </div>

                  <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
                    {([['unmatched', 'Needs matching'], ['matched', 'Matched'], ['ignored', 'Ignored'], ['reconcile', 'Books vs bank'], ['imports', 'Imported files']] as Array<[Tab, string]>).map(([k, l]) => (
                      <button key={k} type="button" onClick={() => setTab(k)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === k ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{l}</button>
                    ))}
                  </div>

                  {tab === 'reconcile' ? <ReconcileTab acct={acct} onMatch={setMatching} canWrite={canWrite} />
                    : tab === 'imports' ? <ImportsTab acct={acct} canManage={canManage} />
                    : <LinesTab key={`${acct.id}-${tab}`} acct={acct} status={tab} canWrite={canWrite} canManage={canManage} onMatch={setMatching} />}
                </>
              )}
            </>
          )}
      </div>

      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
      {importing && acct && <ImportModal acct={acct} onClose={() => setImporting(false)} onAutoMatch={() => { setImporting(false); auto.mutate() }} />}
      {matching && <MatchDrawer line={matching} canManage={canManage} onClose={() => setMatching(null)} onDone={() => { setMatching(null); refresh() }} />}
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'amber' | 'green' }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone === 'amber' ? 'text-amber-700' : tone === 'green' ? 'text-green-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  )
}

function EmptyState({ canManage, onAdd }: { canManage: boolean; onAdd: () => void }) {
  return (
    <div className="card p-10 text-center max-w-xl mx-auto">
      <span className="w-14 h-14 rounded-2xl bg-primary-50 text-primary-600 flex items-center justify-center mx-auto"><Landmark className="w-7 h-7" /></span>
      <h2 className="text-lg font-semibold text-gray-900 mt-4">Add the bank account first</h2>
      <p className="text-sm text-gray-500 mt-2">Then download the statement from net banking (Excel or CSV) and import it here. Each line becomes a receipt, a pump payment, an expense or a labelled entry — and your CA gets a clean bank book.</p>
      {canManage ? <button type="button" className="btn-primary mt-5" onClick={onAdd}><Plus className="w-4 h-4" /> Add bank account</button>
        : <p className="text-xs text-gray-400 mt-4">Ask the owner or a manager to add it.</p>}
    </div>
  )
}

// ── Statement lines ──────────────────────────────────────────────────────────────────────────────────────────────

function LinesTab({ acct, status, canWrite, canManage, onMatch }: { acct: Account; status: Status; canWrite: boolean; canManage: boolean; onMatch: (l: Line) => void }) {
  const refresh = useRefresh()
  const [search, setSearch] = useState('')
  const [dir, setDir] = useState('')
  const period = usePeriod('all', { all: true })
  const { from, to } = period
  const pager = useCursorPager()
  useEffect(() => { pager.reset() }, [from, to, status, acct.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const params = { status, search: search || undefined, direction: dir || undefined, from: from || undefined, to: to || undefined, after: pager.after, limit: 40 }
  const { data, isLoading } = useQuery({ queryKey: ['bank-lines', acct.id, params], queryFn: () => transportApi.bankLines(acct.id, params), placeholderData: (p) => p })
  const rows: Line[] = data?.data ?? []
  useEffect(() => { if (data?.total != null) pager.rememberTotal(data.total) }, [data?.total]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = useMutation({
    mutationFn: ({ kind, id }: { kind: 'unmatch' | 'unignore'; id: string }) => (kind === 'unmatch' ? transportApi.bankUnmatch(id) : transportApi.bankUnignore(id)),
    onSuccess: () => { toast.success('Done'); refresh() }, onError: (e) => toast.error(apiError(e)),
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <input className="input w-60" placeholder="Search narration, reference or amount…" value={search} onChange={(e) => { setSearch(e.target.value); pager.reset() }} />
        <select className="input w-36" value={dir} onChange={(e) => { setDir(e.target.value); pager.reset() }}>
          <option value="">In and out</option><option value="in">Money in</option><option value="out">Money out</option>
        </select>
        <PeriodBar period={period} />
        <span className="flex-1" />
        {data?.totals && <span className="text-xs text-gray-500">{data.total} line{data.total === 1 ? '' : 's'}</span>}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-2.5 text-left">Date</th><th className="px-4 py-2.5 text-left">Narration</th>
              <th className="px-4 py-2.5 text-right">Money out</th><th className="px-4 py-2.5 text-right">Money in</th><th className="px-4 py-2.5 text-right">Balance</th>
              <th className="px-4 py-2.5 text-left">{status === 'unmatched' ? '' : 'What it is'}</th><th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading && <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                {status === 'unmatched' ? (acct.lines === 0 ? 'Import a statement to begin.' : 'Nothing left to match 🎉') : 'Nothing here.'}
              </td></tr>
            )}
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-gray-50 align-top">
                <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{fmtDate(l.date)}</td>
                <td className="px-4 py-2.5 max-w-md">
                  <div className="text-gray-900 break-words">{l.description || '—'}</div>
                  {l.refNo && <div className="text-[11px] font-mono text-gray-400">{l.refNo}</div>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-red-600">{l.debit > 0 ? inr(l.debit, 2) : ''}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{l.credit > 0 ? inr(l.credit, 2) : ''}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">{l.balance == null ? '' : inr(l.balance, 2)}</td>
                <td className="px-4 py-2.5 text-xs text-gray-600">
                  {l.matchedTo && <span className="inline-flex items-center gap-1"><Check className="w-3.5 h-3.5 text-green-600" /> {l.matchedTo}</span>}
                  {l.notes && <div className="text-amber-700 mt-0.5">{l.notes}</div>}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {status === 'unmatched' && canWrite && <button type="button" className="btn-primary text-xs py-1" onClick={() => onMatch(l)}>Match</button>}
                  {status === 'matched' && canWrite && (!l.createdEntries || canManage) && (
                    <button type="button" className="btn-ghost text-xs" disabled={act.isPending}
                      onClick={() => { if (!l.createdEntries || confirm('Undo this match? The receipt, payment or expense made from it will be reversed.')) act.mutate({ kind: 'unmatch', id: l.id }) }}>
                      <Undo2 className="w-3.5 h-3.5" /> Undo
                    </button>
                  )}
                  {status === 'ignored' && canWrite && <button type="button" className="btn-ghost text-xs" disabled={act.isPending} onClick={() => act.mutate({ kind: 'unignore', id: l.id })}><Eye className="w-3.5 h-3.5" /> Bring back</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CursorPager pager={pager} pageSize={40} shown={rows.length} nextCursor={data?.nextCursor} total={pager.total ?? data?.total} />
    </div>
  )
}

// ── Books vs bank ────────────────────────────────────────────────────────────────────────────────────────────────

function ReconcileTab({ acct, onMatch, canWrite }: { acct: Account; onMatch: (l: Line) => void; canWrite: boolean }) {
  const period = usePeriod('year')
  const { from, to } = period
  const { data: r, isLoading } = useQuery({ queryKey: ['bank-recon', acct.id, from, to], queryFn: () => transportApi.bankReconciliation(acct.id, { from, to }) })
  if (isLoading || !r) return <div className="text-center text-gray-400 py-12">Loading…</div>
  const diff = r.check.difference
  return (
    <div className="space-y-5">
      <PeriodBar period={period} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="card p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">The statement itself</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div><dt className="text-xs text-gray-500">Opening</dt><dd className="font-semibold tabular-nums">{inr(r.statement.opening, 2)}</dd></div>
            <div><dt className="text-xs text-gray-500">Money in</dt><dd className="font-semibold tabular-nums text-green-700">{inr(r.statement.credits, 2)}</dd></div>
            <div><dt className="text-xs text-gray-500">Money out</dt><dd className="font-semibold tabular-nums text-red-600">{inr(r.statement.debits, 2)}</dd></div>
            <div><dt className="text-xs text-gray-500">Closing (as printed)</dt><dd className="font-semibold tabular-nums">{r.statement.closing == null ? '—' : inr(r.statement.closing, 2)}</dd></div>
          </dl>
          <div className={`mt-4 rounded-lg px-3 py-2 text-sm flex items-center gap-2 ${diff == null ? 'bg-gray-50 text-gray-500' : Math.abs(diff) < 0.01 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800'}`}>
            {diff == null ? 'The file has no running balance, so the closing balance cannot be checked.'
              : Math.abs(diff) < 0.01 ? <><Check className="w-4 h-4" /> Opening + in − out equals the closing balance: the statement is complete.</>
              : <><AlertTriangle className="w-4 h-4" /> Opening + in − out is {inr(r.check.expectedClosing, 2)} but the statement closes at {inr(r.check.statementClosing, 2)} — a file may be missing lines.</>}
          </div>
        </section>
        <section className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">What has been done</h3>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-gray-500">Matched</dt><dd className="font-semibold">{r.matched.count}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Not matched yet</dt><dd className={`font-semibold ${r.unmatched.count ? 'text-amber-700' : ''}`}>{r.unmatched.count}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Ignored</dt><dd className="font-semibold">{r.ignored.count}</dd></div>
          </dl>
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100"><h3 className="text-sm font-semibold text-gray-900">In the bank, not in your books ({r.inBankNotInBooks.length})</h3><p className="text-xs text-gray-500">Statement lines you have not matched yet.</p></div>
        {r.inBankNotInBooks.length === 0 ? <p className="p-5 text-sm text-gray-400">Every line in this period has been matched.</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-gray-50">
            {r.inBankNotInBooks.map((l: Line) => (
              <tr key={l.id}>
                <td className="px-5 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(l.date)}</td>
                <td className="px-2 py-2 text-gray-800">{l.description}</td>
                <td className="px-2 py-2 text-right tabular-nums">{l.credit > 0 ? <span className="text-green-700">{inr(l.credit, 2)}</span> : <span className="text-red-600">{inr(l.debit, 2)}</span>}</td>
                <td className="px-5 py-2 text-right">{canWrite && <button type="button" className="btn-ghost text-xs" onClick={() => onMatch(l)}>Match</button>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">In your books, not found in a statement ({r.inBooksNotInBank.length}) {r.inBooksNotInBank.length > 0 && <span className="text-gray-500 font-normal">— {inr(r.inBooksNotInBankTotal, 2)}</span>}</h3>
          <p className="text-xs text-gray-500">Receipts you recorded (bank, UPI, cheque) that no imported statement line explains yet — a cheque not cleared, or a statement not imported.</p>
        </div>
        {r.inBooksNotInBank.length === 0 ? <p className="p-5 text-sm text-gray-400">Every bank receipt in your books is on a statement.</p> : (
          <table className="w-full text-sm"><tbody className="divide-y divide-gray-50">
            {r.inBooksNotInBank.map((p: any) => (
              <tr key={p.id}>
                <td className="px-5 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(p.date)}</td>
                <td className="px-2 py-2 text-gray-800">{p.party ?? 'Customer'}</td>
                <td className="px-2 py-2 text-xs text-gray-500">{p.method.replace('_', ' ')}{p.refNo ? ` · ${p.refNo}` : ''}</td>
                <td className="px-5 py-2 text-right tabular-nums">{inr(p.amount, 2)}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>
    </div>
  )
}

function ImportsTab({ acct, canManage }: { acct: Account; canManage: boolean }) {
  const refresh = useRefresh()
  const { data = [], isLoading } = useQuery<any[]>({ queryKey: ['bank-imports', acct.id], queryFn: () => transportApi.bankImports(acct.id) })
  const del = useMutation({
    mutationFn: (id: string) => transportApi.deleteBankImport(id),
    onSuccess: (r: any) => { toast.success(`Removed ${r.removedLines} line${r.removedLines === 1 ? '' : 's'}`); refresh() }, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500 uppercase"><tr>
          <th className="px-4 py-2.5 text-left">Imported</th><th className="px-4 py-2.5 text-left">File</th><th className="px-4 py-2.5 text-left">Period</th>
          <th className="px-4 py-2.5 text-right">Lines</th><th className="px-4 py-2.5 text-right">Added</th><th className="px-4 py-2.5 text-right">Already there</th><th className="px-4 py-2.5" />
        </tr></thead>
        <tbody className="divide-y divide-gray-50">
          {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">Loading…</td></tr>}
          {!isLoading && data.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">No statement imported yet.</td></tr>}
          {data.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDate(i.createdAt)}</td>
              <td className="px-4 py-2.5 text-gray-800">{i.fileName ?? '—'}</td>
              <td className="px-4 py-2.5 text-xs text-gray-600">{fmtDate(i.fromDate)} – {fmtDate(i.toDate)}</td>
              <td className="px-4 py-2.5 text-right">{i.rowCount}</td><td className="px-4 py-2.5 text-right text-green-700">{i.addedCount}</td><td className="px-4 py-2.5 text-right text-gray-400">{i.duplicateCount}</td>
              <td className="px-4 py-2.5 text-right">
                {canManage && <button type="button" title={i.touched ? 'Some of these lines are matched or ignored' : 'Remove this import'} disabled={i.touched > 0 || del.isPending}
                  className="p-1 text-gray-300 enabled:hover:text-red-600 disabled:opacity-40" onClick={() => { if (confirm('Remove every line of this import?')) del.mutate(i.id) }}><Trash2 className="w-4 h-4" /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Add account ──────────────────────────────────────────────────────────────────────────────────────────────────

function AddAccountModal({ onClose }: { onClose: () => void }) {
  const refresh = useRefresh()
  const [f, setF] = useState({ name: '', bankName: '', accountNumber: '', ifscCode: '', openingBalance: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => transportApi.addBankAccount({
      name: f.name.trim(), bankName: f.bankName.trim() || undefined, accountNumber: f.accountNumber.trim() || undefined,
      ifscCode: f.ifscCode.trim().toUpperCase() || undefined, openingBalance: Number(f.openingBalance) || 0,
    }),
    onSuccess: () => { toast.success('Bank account added'); refresh(); onClose() }, onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Add bank account" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>Add account</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Name *</label><input className="input" placeholder="e.g. SBI Current" value={f.name} onChange={set('name')} autoFocus /></div>
        <div><label className="label">Bank</label><input className="input" placeholder="SBI" value={f.bankName} onChange={set('bankName')} /></div>
        <div><label className="label">IFSC</label><input className="input" maxLength={11} placeholder="SBIN0060050" value={f.ifscCode} onChange={set('ifscCode')} /></div>
        <div className="col-span-2"><label className="label">Account number</label><input className="input" inputMode="numeric" value={f.accountNumber} onChange={(e) => setF((p) => ({ ...p, accountNumber: e.target.value.replace(/\D/g, '') }))} /><p className="text-xs text-gray-400 mt-1">Only the last four digits are shown on screen afterwards.</p></div>
        <div className="col-span-2"><label className="label">Balance before the first statement line (₹)</label><input type="number" className="input" value={f.openingBalance} onChange={set('openingBalance')} /><p className="text-xs text-gray-400 mt-1">Optional — if the statement has a running balance, the app reads it from there.</p></div>
      </div>
    </Modal>
  )
}

// ── Import ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FIELDS: Array<[keyof BankColumnMap, string]> = [['date', 'Date'], ['description', 'Narration'], ['ref', 'Reference / cheque no'], ['debit', 'Money out'], ['credit', 'Money in'], ['balance', 'Balance']]

function ImportModal({ acct, onClose, onAutoMatch }: { acct: Account; onClose: () => void; onAutoMatch: () => void }) {
  const refresh = useRefresh()
  const [fileName, setFileName] = useState('')
  const [aoa, setAoa] = useState<unknown[][] | null>(null)
  const [overrides, setOverrides] = useState<{ headerRow?: number; columns?: Partial<BankColumnMap> } | undefined>()
  const [reading, setReading] = useState(false)
  const [done, setDone] = useState<null | { added: number; duplicates: number; skipped: number; fromDate: string; toDate: string }>(null)

  const parsed: BankParseResult | null = useMemo(() => (aoa ? parseBankStatementRows(aoa, overrides) : null), [aoa, overrides])
  const rows = parsed?.rows ?? []
  const totalIn = r2(rows.reduce((t, r) => t + r.credit, 0)), totalOut = r2(rows.reduce((t, r) => t + r.debit, 0))

  async function onFile(file: File | undefined) {
    if (!file) return
    setReading(true); setDone(null); setOverrides(undefined)
    try { setAoa(await readSpreadsheet(file)); setFileName(file.name) }
    catch { toast.error('That file could not be read. Download the statement as Excel (.xlsx / .xls) or CSV from net banking.'); setAoa(null) }
    finally { setReading(false) }
  }
  const setCol = (field: keyof BankColumnMap, v: string) =>
    setOverrides((o) => ({ headerRow: parsed?.headerRow ?? o?.headerRow ?? 0, columns: { ...(o?.columns ?? parsed?.columns ?? {}), [field]: v === '' ? null : Number(v) } }))

  const save = useMutation({
    mutationFn: () => transportApi.bankImport(acct.id, {
      fileName, rows: rows.map((r) => ({ date: r.date, description: r.description, refNo: r.refNo, debit: r.debit, credit: r.credit, balance: r.balance })),
    }),
    onSuccess: (r: any) => { setDone(r); refresh() }, onError: (e) => toast.error(apiError(e)),
  })

  return (
    <Modal title={`Import statement — ${acct.name}`} width="xl" onClose={onClose}
      footer={done ? <>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Close</button>
        {done.added > 0 && <button type="button" className="btn-primary flex-1 justify-center" onClick={onAutoMatch}><Wand2 className="w-4 h-4" /> Match what is certain</button>}
      </> : <>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={rows.length === 0 || rows.length > 5000 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Import {rows.length || ''} line{rows.length === 1 ? '' : 's'}
        </button>
      </>}>
      {done ? (
        <div className="text-center py-6 space-y-2">
          <span className="w-12 h-12 rounded-full bg-green-100 text-green-700 flex items-center justify-center mx-auto"><Check className="w-6 h-6" /></span>
          <h3 className="text-base font-semibold text-gray-900">{done.added} new line{done.added === 1 ? '' : 's'} added</h3>
          <p className="text-sm text-gray-500">{fmtDate(done.fromDate)} – {fmtDate(done.toDate)}{done.duplicates > 0 ? ` · ${done.duplicates} already imported earlier, skipped` : ''}{done.skipped > 0 ? ` · ${done.skipped} empty lines left out` : ''}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-3 border-2 border-dashed border-gray-300 rounded-xl p-4 cursor-pointer hover:bg-gray-50">
            <FileSpreadsheet className="w-8 h-8 text-gray-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{fileName || 'Choose the statement file'}</div>
              <div className="text-xs text-gray-500">Excel (.xlsx, .xls) or CSV, downloaded from net banking. Overlapping months are fine — lines already imported are skipped.</div>
            </div>
            {reading ? <Loader2 className="w-5 h-5 animate-spin text-gray-400" /> : <span className="btn-ghost text-sm">Browse</span>}
            <input type="file" accept=".xlsx,.xls,.csv,text/csv" className="hidden" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
          </label>

          {parsed && (
            <>
              {parsed.warnings.length > 0 && (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 space-y-1">
                  {parsed.warnings.slice(0, 5).map((w, i) => <div key={i} className="flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {w}</div>)}
                </div>
              )}
              {parsed.headerRow != null && (
                <details className="text-sm" open={rows.length === 0}>
                  <summary className="cursor-pointer text-gray-600 font-medium">Columns found {rows.length === 0 ? '— pick them yourself' : '(change if wrong)'}</summary>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                    {FIELDS.map(([field, label]) => (
                      <div key={field}>
                        <label className="label">{label}</label>
                        <select className="input" value={parsed.columns[field] ?? ''} onChange={(e) => setCol(field, e.target.value)}>
                          <option value="">— none —</option>
                          {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {rows.length > 0 && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">Lines</div><div className="font-semibold">{rows.length}</div></div>
                    <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">Period</div><div className="font-semibold">{fmtDate(parsed.fromDate)} – {fmtDate(parsed.toDate)}</div></div>
                    <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500 flex items-center gap-1"><ArrowDownLeft className="w-3 h-3" /> Money in</div><div className="font-semibold text-green-700">{inr(totalIn, 2)}</div></div>
                    <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500 flex items-center gap-1"><ArrowUpRight className="w-3 h-3" /> Money out</div><div className="font-semibold text-red-600">{inr(totalOut, 2)}</div></div>
                  </div>
                  {rows.length > 5000 && <div className="text-sm text-red-600">That is more than 5,000 lines — import it in two parts (for example half the year each).</div>}
                  <div className="border border-gray-200 rounded-lg overflow-auto max-h-64">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-500 uppercase sticky top-0"><tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Narration</th><th className="px-3 py-2 text-right">Out</th><th className="px-3 py-2 text-right">In</th><th className="px-3 py-2 text-right">Balance</th></tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {rows.slice(0, 8).map((r, i) => (
                          <tr key={i}><td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(r.date)}</td><td className="px-3 py-1.5 max-w-xs truncate">{r.description}</td>
                            <td className="px-3 py-1.5 text-right text-red-600">{r.debit > 0 ? inr(r.debit, 2) : ''}</td><td className="px-3 py-1.5 text-right text-green-700">{r.credit > 0 ? inr(r.credit, 2) : ''}</td>
                            <td className="px-3 py-1.5 text-right text-gray-500">{r.balance == null ? '' : inr(r.balance, 2)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 8 && <div className="px-3 py-2 text-xs text-gray-400 border-t border-gray-100">…and {rows.length - 8} more lines</div>}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}

// ── Match a line ─────────────────────────────────────────────────────────────────────────────────────────────────

function MatchDrawer({ line, canManage, onClose, onDone }: { line: Line; canManage: boolean; onClose: () => void; onDone: () => void }) {
  const { data: sug, isLoading } = useQuery<any>({ queryKey: ['bank-suggest', line.id], queryFn: () => transportApi.bankSuggestions(line.id) })
  const isIn = line.credit > 0
  const amount = isIn ? line.credit : line.debit

  const send = useMutation({
    mutationFn: (body: unknown) => transportApi.bankMatch(line.id, body),
    onSuccess: () => { toast.success('Matched'); onDone() }, onError: (e) => toast.error(apiError(e)),
  })
  const ignore = useMutation({
    mutationFn: () => transportApi.bankIgnore(line.id),
    onSuccess: () => { toast.success('Line ignored'); onDone() }, onError: (e) => toast.error(apiError(e)),
  })
  void canManage

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white w-full max-w-xl h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-gray-100 p-5 z-10">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-500">{fmtDate(line.date)}{line.refNo ? ` · ${line.refNo}` : ''}</div>
              <div className="text-sm font-medium text-gray-900 break-words mt-0.5">{line.description}</div>
              <div className={`text-2xl font-bold mt-1 ${isIn ? 'text-green-700' : 'text-red-600'}`}>{isIn ? '+ ' : '− '}{inr(amount, 2)} <span className="text-xs font-medium text-gray-500">{isIn ? 'money in' : 'money out'}</span></div>
            </div>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="p-5 space-y-6">
          {isLoading ? <div className="text-center text-gray-400 py-8">Looking for matches…</div> : isIn ? (
            <>
              <ExistingPayments sug={sug} busy={send.isPending} onLink={(ids) => send.mutate({ kind: 'link_payments', paymentIds: ids })} />
              <ReceiptForm line={line} sug={sug} busy={send.isPending} onSubmit={(body) => send.mutate(body)} />
            </>
          ) : (
            <>
              <PumpMatches sug={sug} amount={amount} busy={send.isPending} onPay={(vendor, ids) => send.mutate({ kind: 'pump', vendor, expenseIds: ids })} />
              <ExistingExpenses sug={sug} busy={send.isPending} onLink={(id) => send.mutate({ kind: 'link_expense', expenseId: id })} />
              <ExpenseForm busy={send.isPending} onSubmit={(body) => send.mutate(body)} />
            </>
          )}
          <OtherForm busy={send.isPending || ignore.isPending} onLabel={(label, note) => send.mutate({ kind: 'other', label, note: note || undefined })} onIgnore={() => ignore.mutate()} />
        </div>
      </div>
    </div>
  )
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="space-y-2">
    <div><h3 className="text-sm font-semibold text-gray-900">{title}</h3>{hint && <p className="text-xs text-gray-500">{hint}</p>}</div>
    {children}
  </section>
)

function ExistingPayments({ sug, busy, onLink }: { sug: any; busy: boolean; onLink: (ids: string[]) => void }) {
  const list: any[] = sug?.payments ?? []
  if (!list.length) return null
  return (
    <Section title="Already recorded in your books?" hint="Receipts you entered earlier with the same amount.">
      {list.map((p) => (
        <div key={p.paymentIds.join()} className="flex items-center gap-3 border border-gray-200 rounded-lg p-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">{p.party ?? 'Customer'} · {inr(p.amount, 2)}</div>
            <div className="text-xs text-gray-500">{fmtDate(p.date)} · {String(p.method).replace('_', ' ')}{p.refNo ? ` · ${p.refNo}` : ''}</div>
            <div className="text-[11px] text-green-700 mt-0.5">{p.reasons.join(' · ')}</div>
          </div>
          <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${p.score >= 90 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{p.score}%</span>
          <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => onLink(p.paymentIds)}>This is it</button>
        </div>
      ))}
    </Section>
  )
}

interface Alloc { on: boolean; amount: string; tds: boolean }

function ReceiptForm({ line, sug, busy, onSubmit }: { line: Line; sug: any; busy: boolean; onSubmit: (b: unknown) => void }) {
  const [party, setParty] = useState<PickedParty>({ name: '' })
  const { data, isFetching } = useQuery<any>({ queryKey: ['bank-open-bills', party.id], queryFn: () => transportApi.bankOpenBills(party.id!), enabled: !!party.id })
  const bills: any[] = data?.bills ?? []
  const [alloc, setAlloc] = useState<Record<string, Alloc>>({})

  // fill the bills oldest-first from the money received, leaving room for the TDS the customer is likely to have cut
  function autoFill(list: any[], tdsOn: Record<string, boolean>) {
    let left = line.credit
    const next: Record<string, Alloc> = {}
    for (const b of list) {
      const tds = tdsOn[b.id] ?? b.tdsPending > 0
      const room = Math.max(0, r2(b.outstanding - (tds ? b.tdsPending : 0)))
      const pay = Math.min(room, left)
      left = r2(left - pay)
      next[b.id] = { on: pay > 0, amount: pay > 0 ? String(pay) : '', tds: b.tdsPending > 0 && tds }
    }
    setAlloc(next)
  }
  useEffect(() => { if (bills.length) autoFill(bills, {}) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [data])

  const applied = r2(bills.reduce((t, b) => t + (alloc[b.id]?.on ? Number(alloc[b.id]!.amount) || 0 : 0), 0))
  const tdsTotal = r2(bills.reduce((t, b) => t + (alloc[b.id]?.on && alloc[b.id]?.tds ? b.tdsPending : 0), 0))
  const rest = r2(line.credit - applied)
  const set = (id: string, patch: Partial<Alloc>) => setAlloc((a) => ({ ...a, [id]: { ...(a[id] ?? { on: false, amount: '', tds: false }), ...patch } }))
  const over = applied > line.credit + 0.01
  const suggested: any[] = sug?.customers ?? []

  function submit() {
    onSubmit({
      kind: 'receipt', partyId: party.id,
      allocations: bills.filter((b) => alloc[b.id]?.on && Number(alloc[b.id]!.amount) > 0)
        .map((b) => ({ invoiceId: b.id, amount: Number(alloc[b.id]!.amount), ...(alloc[b.id]!.tds && b.tdsPending > 0 ? { tds: b.tdsPending } : {}) })),
    })
  }

  return (
    <Section title="Record it as a receipt from a customer" hint="Pick the customer, tick the bills it pays. If they cut TDS, it is recorded too.">
      {suggested.length > 0 && !party.id && (
        <div className="flex flex-wrap gap-2">
          {suggested.map((c) => <button key={c.id} type="button" className="text-xs rounded-full bg-primary-50 text-primary-700 px-3 py-1 hover:bg-primary-100" onClick={() => setParty({ id: c.id, name: c.name, gstin: c.gstin })}>{c.name} · owes {inr(c.outstanding)}</button>)}
        </div>
      )}
      <PartyCombobox value={party} onChange={(p) => { setParty(p); setAlloc({}) }} type="customer" allowFreeText={false} placeholder="Search customer…" />
      {party.id && (isFetching ? <div className="text-sm text-gray-400">Loading bills…</div> : bills.length === 0 ? (
        <p className="text-sm text-gray-500">This customer has no unpaid bills. The whole amount will be kept on their account as an advance.</p>
      ) : (
        <div className="space-y-2">
          <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
            {bills.map((b) => {
              const a = alloc[b.id] ?? { on: false, amount: '', tds: false }
              return (
                <div key={b.id} className="p-3 space-y-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={a.on} onChange={(e) => set(b.id, { on: e.target.checked, amount: e.target.checked && !a.amount ? String(Math.min(b.outstanding, Math.max(0, rest))) : a.amount })} />
                    <span className="font-mono text-xs text-gray-600">{b.number}</span>
                    <span className="text-xs text-gray-500">{fmtDate(b.date)}</span>
                    <span className="flex-1" />
                    <span className="text-xs text-gray-500">due {inr(b.outstanding, 2)}</span>
                  </label>
                  {a.on && (
                    <div className="flex items-center gap-3 pl-6">
                      <span className="text-xs text-gray-500">Pays</span>
                      <input type="number" min="0" className="input w-32 py-1" value={a.amount} onChange={(e) => set(b.id, { amount: e.target.value })} />
                      {b.tdsPending > 0 && (
                        <label className="flex items-center gap-1.5 text-xs text-amber-700">
                          <input type="checkbox" checked={a.tds} onChange={(e) => { set(b.id, { tds: e.target.checked }) }} /> customer cut TDS {inr(b.tdsPending, 2)}
                        </label>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button type="button" className="text-xs text-primary-600 hover:underline" onClick={() => autoFill(bills, Object.fromEntries(bills.map((b) => [b.id, alloc[b.id]?.tds ?? b.tdsPending > 0])))}>Fill the bills again, oldest first</button>
        </div>
      ))}
      {party.id && (
        <div className="rounded-lg bg-gray-50 p-3 text-sm space-y-1">
          <div className="flex justify-between"><span className="text-gray-500">Received in bank</span><span className="font-semibold">{inr(line.credit, 2)}</span></div>
          <div className="flex justify-between"><span className="text-gray-500">Applied to bills</span><span className={over ? 'font-semibold text-red-600' : 'font-semibold'}>{inr(applied, 2)}</span></div>
          {tdsTotal > 0 && <div className="flex justify-between"><span className="text-gray-500">TDS recorded as well</span><span className="font-semibold">{inr(tdsTotal, 2)}</span></div>}
          <div className="flex justify-between"><span className="text-gray-500">Kept on account (advance)</span><span className="font-semibold">{inr(Math.max(0, rest), 2)}</span></div>
          {over && <div className="text-xs text-red-600">The bills add up to more than the money received.</div>}
        </div>
      )}
      <button type="button" className="btn-primary w-full justify-center" disabled={!party.id || busy || over} onClick={submit}>Record receipt</button>
    </Section>
  )
}

function PumpMatches({ sug, amount, busy, onPay }: { sug: any; amount: number; busy: boolean; onPay: (vendor: string, ids: string[]) => void }) {
  const groups: any[] = sug?.pumps ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  useEffect(() => { setPicked(Object.fromEntries(groups.map((g) => [g.vendor, g.pick]))) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sug])
  if (!groups.length) return null
  return (
    <Section title="Paying a pump?" hint="Bills taken on account that this payment could settle.">
      {groups.map((g) => {
        const ids = picked[g.vendor] ?? []
        const total = r2(g.bills.filter((b: any) => ids.includes(b.id)).reduce((t: number, b: any) => t + b.amount, 0))
        const over = total > amount + 0.01
        return (
          <div key={g.vendor} className="border border-gray-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">{g.vendor}</span>
              {g.hits > 0 && <span className="text-[11px] rounded-full bg-green-100 text-green-700 px-2">name in narration</span>}
              {g.exact && <span className="text-[11px] rounded-full bg-green-100 text-green-700 px-2">exact amount</span>}
              <span className="flex-1" />
              <span className="text-xs text-gray-500">owed {inr(g.unpaid, 2)}</span>
            </div>
            <div className="max-h-40 overflow-y-auto divide-y divide-gray-50">
              {g.bills.map((b: any) => (
                <label key={b.id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={ids.includes(b.id)} onChange={(e) => setPicked((p) => ({ ...p, [g.vendor]: e.target.checked ? [...(p[g.vendor] ?? []), b.id] : (p[g.vendor] ?? []).filter((x) => x !== b.id) }))} />
                  <span className="text-xs text-gray-500 w-20">{fmtDate(b.date)}</span>
                  <span className="text-xs text-gray-500 flex-1 truncate">{[b.tripNo, b.vehicleNo, b.litres ? `${b.litres} L` : null].filter(Boolean).join(' · ')}</span>
                  <span className="tabular-nums">{inr(b.amount, 2)}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${over ? 'text-red-600' : 'text-gray-500'}`}>Selected {inr(total, 2)} of {inr(amount, 2)} paid{!over && total < amount - 0.01 ? ` — ${inr(amount - total, 2)} not matched to a bill` : ''}</span>
              <span className="flex-1" />
              <button type="button" className="btn-primary text-xs" disabled={busy || ids.length === 0 || over} onClick={() => onPay(g.vendor, ids)}>Mark {ids.length} bill{ids.length === 1 ? '' : 's'} paid</button>
            </div>
          </div>
        )
      })}
    </Section>
  )
}

function ExistingExpenses({ sug, busy, onLink }: { sug: any; busy: boolean; onLink: (id: string) => void }) {
  const list: any[] = sug?.expenses ?? []
  if (!list.length) return null
  return (
    <Section title="Already entered as an expense?" hint="Office costs paid by bank or UPI with this exact amount.">
      {list.map((e) => (
        <div key={e.id} className="flex items-center gap-3 border border-gray-200 rounded-lg p-3">
          <div className="flex-1 min-w-0"><div className="text-sm font-medium text-gray-900 truncate">{e.category}{e.description ? ` — ${e.description}` : ''}</div><div className="text-xs text-gray-500">{fmtDate(e.date)} · {inr(e.amount, 2)}</div></div>
          <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => onLink(e.id)}>This is it</button>
        </div>
      ))}
    </Section>
  )
}

function ExpenseForm({ busy, onSubmit }: { busy: boolean; onSubmit: (b: unknown) => void }) {
  const { data: cats = [] } = useQuery<any[]>({ queryKey: ['expense-categories'], queryFn: expenseApi.categories })
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [gst, setGst] = useState('0')
  return (
    <Section title="Record it as an expense" hint="Creates an office cost paid by bank, dated as on the statement.">
      <div className="grid grid-cols-2 gap-2">
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Category…</option>
          {cats.map((c: any) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <select className="input" value={gst} onChange={(e) => setGst(e.target.value)}>
          {[0, 5, 12, 18, 28].map((g) => <option key={g} value={g}>{g === 0 ? 'No GST in it' : `${g}% GST inside`}</option>)}
        </select>
        <input className="input col-span-2" placeholder="What was it for? (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <button type="button" className="btn-ghost w-full justify-center" disabled={!category || busy} onClick={() => onSubmit({ kind: 'expense', category, description: description || undefined, gstRate: Number(gst) })}>Record expense</button>
    </Section>
  )
}

function OtherForm({ busy, onLabel, onIgnore }: { busy: boolean; onLabel: (label: string, note: string) => void; onIgnore: () => void }) {
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  return (
    <Section title="Something else" hint="Owner drawings, a transfer between your own accounts, bank charges, a loan… Marks the line as dealt with, with that label for your CA.">
      <div className="flex flex-wrap gap-1.5">
        {BANK_LINE_LABELS.map((l) => (
          <button key={l} type="button" onClick={() => setLabel(l)} className={`text-xs rounded-full px-3 py-1 border ${label === l ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{l}</button>
        ))}
      </div>
      <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1 justify-center" disabled={!label || busy} onClick={() => onLabel(label, note)}>Mark as “{label || '…'}”</button>
        <button type="button" className="btn-ghost justify-center text-gray-500" disabled={busy} title="Hide this line — it needs no entry (for example a zero-effect reversal)" onClick={onIgnore}><EyeOff className="w-4 h-4" /> Ignore</button>
      </div>
    </Section>
  )
}
