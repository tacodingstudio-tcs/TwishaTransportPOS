// src/pages/PartyStatementPage.tsx
import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { usePartyStatement, useInvoices } from '@/hooks/useApi'
import { useAuthStore } from '@/store/auth.store'
import { getEntityConfig } from '@/lib/entityConfig'
import { PageHeader } from '@/components/layout/PageHeader'
import { format } from 'date-fns'
import {
  Star, TrendingUp, ShoppingBag, MessageCircle, CreditCard, AlertTriangle,
  Edit2, Save, X, User, ClipboardList, Eye, Dumbbell, GraduationCap,
  Stethoscope, FlaskConical,
} from 'lucide-react'
import { partyApi } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function buildWhatsAppLink(phone: string | null | undefined, name: string, balance: number): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  const wa = digits.length === 10 ? `91${digits}` : digits
  const msg = `Namaste ${name}! Aapka baki ₹${balance.toLocaleString('en-IN')} hai. Kripya jald se jald payment karein. Dhanyawad! 🙏`
  return `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`
}

function LoyaltyBadge({ pts }: { pts: number }) {
  const tier = pts >= 1000 ? { label: 'Gold',   color: 'bg-yellow-100 text-yellow-700 border-yellow-200' }
             : pts >= 500  ? { label: 'Silver', color: 'bg-gray-100 text-gray-600 border-gray-300' }
             : pts >= 200  ? { label: 'Bronze', color: 'bg-orange-50 text-orange-700 border-orange-200' }
             : { label: 'Member', color: 'bg-blue-50 text-blue-600 border-blue-200' }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${tier.color}`}>
      <Star className="w-3 h-3" /> {tier.label} · {pts.toLocaleString('en-IN')} pts
    </span>
  )
}

// ── Domain profile card ───────────────────────────────────────────────────────

function domainIcon(dt: string) {
  if (['clinic','optical','pharmacy'].includes(dt)) return <Stethoscope className="w-4 h-4" />
  if (dt === 'diagnostic_lab')                       return <FlaskConical className="w-4 h-4" />
  if (dt === 'gym')                                  return <Dumbbell className="w-4 h-4" />
  if (dt === 'coaching')                             return <GraduationCap className="w-4 h-4" />
  if (dt === 'optical')                              return <Eye className="w-4 h-4" />
  return <ClipboardList className="w-4 h-4" />
}

interface MetaCardProps {
  domainType: string
  partyId:    string
  meta:       Record<string, unknown>
  onSaved:    () => void
}

function MetaProfileCard({ domainType, partyId, meta, onSaved }: MetaCardProps) {
  const cfg         = getEntityConfig(domainType)
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState<Record<string, string>>({})
  const [saving,  setSaving]  = useState(false)

  if (cfg.metaFields.length === 0) return null

  function startEdit() {
    const init: Record<string, string> = {}
    cfg.metaFields.forEach(f => { init[f.key] = meta[f.key] != null ? String(meta[f.key]) : '' })
    setDraft(init)
    setEditing(true)
  }

  async function save() {
    setSaving(true)
    try {
      const cleanMeta = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''))
      await partyApi.update(partyId, { meta: cleanMeta })
      await queryClient.invalidateQueries({ queryKey: ['party', partyId] })
      await queryClient.invalidateQueries({ queryKey: ['party-statement', partyId] })
      await onSaved()
      setEditing(false)
    } catch (err: any) {
      alert('Save failed: ' + (err?.response?.data?.error ?? err?.message ?? 'Unknown error'))
    } finally {
      setSaving(false)
    }
  }

  const filled = cfg.metaFields.filter(f => meta[f.key] != null && meta[f.key] !== '')

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-gray-700">
          {domainIcon(domainType)}
          <h3 className="text-sm font-semibold">{cfg.singular} Profile</h3>
        </div>
        {!editing && (
          <button type="button" onClick={startEdit} className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-800">
            <Edit2 className="w-3 h-3" /> Edit
          </button>
        )}
      </div>

      {!editing ? (
        filled.length === 0 ? (
          <p className="text-xs text-gray-400">
            No profile details yet.{' '}
            <button type="button" onClick={startEdit} className="text-primary-600 hover:underline">Add now</button>
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            {cfg.metaFields.map(f => {
              const v = meta[f.key]
              if (v == null || v === '') return null
              return (
                <div key={f.key}>
                  <dt className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{f.label}</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{String(v)}</dd>
                </div>
              )
            })}
          </dl>
        )
      ) : (
        <div className="space-y-3">
          {cfg.metaFields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.type === 'select' ? (
                <select
                  title={f.label}
                  value={draft[f.key] ?? ''}
                  onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))}
                  className="input"
                >
                  <option value="">— Select —</option>
                  {f.options?.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  value={draft[f.key] ?? ''}
                  onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))}
                  className="input"
                  placeholder={f.placeholder}
                />
              )}
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setEditing(false)} className="btn-ghost text-sm flex items-center gap-1">
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
            <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm flex items-center gap-1">
              <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Domain-specific visit / test history from invoices ────────────────────────

function DomainInvoiceHistory({ partyId, domainType }: { partyId: string; domainType: string }) {
  const navigate = useNavigate()
  const { data }  = useInvoices({ partyId, txnType: 'sale_invoice', limit: 8 })
  const invoices: any[] = (data as any)?.data ?? []

  if (invoices.length === 0) return null

  // Domain-specific section title
  const sectionTitle = {
    clinic:         'Visit History',
    diagnostic_lab: 'Test History',
    optical:        'Prescription History',
    pharmacy:       'Prescription / Purchase History',
    gym:            'Membership & Purchase History',
    coaching:       'Fee Payment History',
    salon:          'Service History',
    tiffin:         'Billing History',
    hotel:          'Stay History',
    repair:         'Repair History',
    pest_control:   'Service History',
    photography:    'Booking History',
  }[domainType] ?? 'Invoice History'

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-700">{sectionTitle}</h3>
        <span className="text-xs text-gray-400">({invoices.length} records)</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left px-5 py-2.5 font-medium text-gray-500">Invoice</th>
            <th className="text-left px-5 py-2.5 font-medium text-gray-500">Date</th>
            <th className="text-left px-5 py-2.5 font-medium text-gray-500">Details</th>
            <th className="text-right px-5 py-2.5 font-medium text-gray-500">Amount</th>
            <th className="text-center px-5 py-2.5 font-medium text-gray-500">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv: any) => {
            const dd = inv.domainData as Record<string, unknown> | null
            const detail = getDomainDetail(domainType, dd)
            return (
              <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)} className="table-row cursor-pointer">
                <td className="px-5 py-3 font-medium text-primary-600">{inv.number}</td>
                <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                  {inv.date ? format(new Date(inv.date), 'd MMM yyyy') : '—'}
                </td>
                <td className="px-5 py-3 text-gray-600 text-xs max-w-xs truncate">{detail || '—'}</td>
                <td className="px-5 py-3 text-right font-medium text-gray-900">{formatINR(Number(inv.grandTotal ?? 0))}</td>
                <td className="px-5 py-3 text-center">
                  <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    inv.status === 'paid'    ? 'bg-green-50 text-green-700' :
                    inv.status === 'partial' ? 'bg-yellow-50 text-yellow-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>{inv.status}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function getDomainDetail(domainType: string, dd: Record<string, unknown> | null): string {
  if (!dd) return ''
  const s = (k: string) => dd[k] != null ? String(dd[k]) : ''
  switch (domainType) {
    case 'clinic':
      return [s('visit_type') ? s('visit_type').toUpperCase() : '', s('referral_doctor')].filter(Boolean).join(' · ')
    case 'diagnostic_lab':
      return [s('ref_doctor'), dd.home_collection ? 'Home Collection' : '', dd.urgent ? 'URGENT' : ''].filter(Boolean).join(' · ')
    case 'optical':
      return s('re_sph') ? `RE ${s('re_sph')}/${s('re_cyl')}  LE ${s('le_sph')}/${s('le_cyl')}` : ''
    case 'pharmacy':
      return [s('doctor_name'), s('prescription_id')].filter(Boolean).join(' · ')
    case 'gym':
      return [s('membership_from') ? `${s('membership_from')} → ${s('membership_to')}` : '', s('member_id')].filter(Boolean).join('  ')
    case 'coaching':
      return [s('batch_name'), s('fee_month')].filter(Boolean).join(' · ')
    case 'salon':
      return s('staff_name') ? `Staff: ${s('staff_name')}` : ''
    case 'tiffin':
      return s('billing_period_from') ? `${s('billing_period_from')} → ${s('billing_period_to')}` : ''
    case 'hotel':
      return [s('room_no') ? `Room ${s('room_no')}` : '', s('check_in') ? `${s('check_in')} → ${s('check_out')}` : ''].filter(Boolean).join('  ')
    case 'repair':
      return [s('device_brand'), s('device_model'), s('problem_reported')].filter(Boolean).join(' · ')
    case 'pest_control':
      return s('service_address') ? s('service_address').slice(0, 50) : ''
    case 'photography':
      return [s('event_type'), s('event_date'), s('photographer_name')].filter(Boolean).join(' · ')
    default:
      return ''
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function PartyStatementPage() {
  const { id }     = useParams<{ id: string }>()
  const domainType = useAuthStore((s: any) => s.branch?.domainType ?? '')
  const cfg        = getEntityConfig(domainType)

  const { data, isLoading, refetch } = usePartyStatement(id!)

  if (isLoading) return <div className="p-8 text-gray-400">Loading…</div>
  if (!data)     return <div className="p-8 text-gray-400">Not found</div>

  const { party, ledger, summary } = data

  const isCustomer     = party.type !== 'supplier'
  const isServiceDomain = ['clinic','diagnostic_lab','optical','pharmacy','gym','coaching',
    'salon','tiffin','hotel','pest_control','photography','repair','laundry'].includes(domainType)
  const isGalleryDomain = ['photography','salon','repair','catering','printing','hotel',
    'pest_control','laundry','automobile'].includes(domainType)

  const creditUsedPct = party.creditLimit > 0
    ? Math.min(100, Math.round((party.currentBalance / party.creditLimit) * 100))
    : 0
  const creditWarning = party.creditLimit > 0 && creditUsedPct >= 80
  const waLink        = buildWhatsAppLink(party.phone, party.name, party.currentBalance)

  const entityLabel = isServiceDomain && isCustomer ? cfg.singular : (party.type === 'supplier' ? 'Supplier' : 'Customer')

  return (
    <div>
      <PageHeader
        title={party.name}
        subtitle={[entityLabel, party.phone].filter(Boolean).join(' · ')}
        action={
          <div className="flex items-center gap-2">
            {party.loyaltyPts > 0 && <LoyaltyBadge pts={party.loyaltyPts} />}
            {waLink && party.currentBalance > 0 && (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost text-sm flex items-center gap-1.5 text-green-700 border-green-200 hover:bg-green-50"
              >
                <MessageCircle className="w-4 h-4" /> Send Reminder
              </a>
            )}
          </div>
        }
      />

      <div className="p-8 space-y-6">

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <ShoppingBag className="w-4 h-4 text-primary-500" />
              <span className="text-xs text-gray-500">Total {isServiceDomain ? 'Billing' : 'Purchases'}</span>
            </div>
            <div className="text-lg font-bold text-gray-900">{formatINR(summary.totalPurchases)}</div>
            <div className="text-xs text-gray-400 mt-0.5">{summary.invoiceCount} invoice{summary.invoiceCount !== 1 ? 's' : ''}</div>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="w-4 h-4 text-green-500" />
              <span className="text-xs text-gray-500">Avg. Bill Value</span>
            </div>
            <div className="text-lg font-bold text-gray-900">{formatINR(summary.avgInvoiceValue)}</div>
            {summary.lastPurchaseDate && (
              <div className="text-xs text-gray-400 mt-0.5">
                Last: {format(new Date(summary.lastPurchaseDate), 'd MMM yyyy')}
              </div>
            )}
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <Star className="w-4 h-4 text-yellow-500" />
              <span className="text-xs text-gray-500">Loyalty Points</span>
            </div>
            <div className="text-lg font-bold text-gray-900">{party.loyaltyPts.toLocaleString('en-IN')}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {party.loyaltyPts >= 1000 ? 'Gold tier' : party.loyaltyPts >= 500 ? 'Silver tier' : party.loyaltyPts >= 200 ? 'Bronze tier' : 'Member'}
            </div>
          </div>

          <div className={`card p-4 ${creditWarning ? 'border-red-200 bg-red-50' : ''}`}>
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className={`w-4 h-4 ${creditWarning ? 'text-red-500' : 'text-gray-400'}`} />
              <span className="text-xs text-gray-500">Balance Due</span>
            </div>
            <div className={`text-lg font-bold ${party.currentBalance > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
              {formatINR(Math.abs(party.currentBalance))}
            </div>
            {party.creditLimit > 0 && (
              <div className="mt-1">
                <div className="flex justify-between text-xs text-gray-400 mb-0.5">
                  <span>Credit limit</span>
                  <span className={creditWarning ? 'text-red-600 font-medium' : ''}>{creditUsedPct}% used</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${creditUsedPct >= 100 ? 'bg-red-600 w-full' : creditUsedPct >= 80 ? `bg-amber-500` : 'bg-green-500'}`}
                    ref={(el) => { if (el && creditUsedPct < 100) el.style.width = `${creditUsedPct}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-0.5">of {formatINR(party.creditLimit)}</div>
              </div>
            )}
          </div>
        </div>

        {creditWarning && (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Credit limit {creditUsedPct >= 100 ? 'exceeded' : 'nearly reached'} — collect payment before extending more credit.
            {waLink && (
              <a href={waLink} target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-green-700 font-medium hover:underline">
                <MessageCircle className="w-3.5 h-3.5" /> Remind on WhatsApp
              </a>
            )}
          </div>
        )}

        {/* ── Two-column layout: profile card left, ledger right ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left column: domain profile + quick actions */}
          <div className="space-y-4">
            {isServiceDomain && isCustomer && (
              <MetaProfileCard
                domainType={domainType}
                partyId={id!}
                meta={(party.meta as Record<string, unknown>) ?? {}}
                onSaved={() => refetch()}
              />
            )}

            {/* Contact card */}
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <User className="w-4 h-4 text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-700">Contact</h3>
              </div>
              <dl className="space-y-2 text-sm">
                {party.phone && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Phone</dt>
                    <dd className="font-medium">{party.phone}</dd>
                  </div>
                )}
                {party.email && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">Email</dt>
                    <dd className="font-medium text-xs">{party.email}</dd>
                  </div>
                )}
                {party.gstin && (
                  <div className="flex justify-between">
                    <dt className="text-gray-400">GSTIN</dt>
                    <dd className="font-mono text-xs">{party.gstin}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-gray-400">Member since</dt>
                  <dd>{party.createdAt ? format(new Date(party.createdAt), 'd MMM yyyy') : '—'}</dd>
                </div>
              </dl>
              {waLink && (
                <a
                  href={waLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 flex items-center gap-1.5 text-xs text-green-700 hover:text-green-800"
                >
                  <MessageCircle className="w-3.5 h-3.5" /> Open WhatsApp
                </a>
              )}
            </div>
          </div>

          {/* Right column: domain-specific history + ledger */}
          <div className="lg:col-span-2 space-y-6">

            {/* Domain-specific invoice history */}
            {isServiceDomain && isCustomer && (
              <DomainInvoiceHistory partyId={id!} domainType={domainType} />
            )}

            {/* Ledger */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
                <h3 className="text-sm font-semibold text-gray-700">Transaction Ledger</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left px-5 py-3 font-medium text-gray-500">Date</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-500">Description</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Billed</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Paid</th>
                    <th className="text-right px-5 py-3 font-medium text-gray-500">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.length === 0 && (
                    <tr><td colSpan={5} className="text-center py-12 text-gray-400">No transactions yet</td></tr>
                  )}
                  {ledger.map((entry: any) => (
                    <tr key={entry.id} className="table-row">
                      <td className="px-5 py-3 text-gray-500 whitespace-nowrap">{format(new Date(entry.date), 'd MMM yyyy')}</td>
                      <td className="px-5 py-3 text-gray-900">
                        {entry.type === 'invoice' ? (
                          <Link to={`/invoices/${entry.id}`} className="hover:text-primary-600 hover:underline">{entry.description}</Link>
                        ) : entry.description}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-700">
                        {entry.debit > 0 ? formatINR(entry.debit) : '—'}
                      </td>
                      <td className="px-5 py-3 text-right text-green-600">
                        {entry.credit > 0 ? formatINR(entry.credit) : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${entry.balance > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                        {formatINR(Math.abs(entry.balance))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
