import React from 'react'
import { useInvoices } from '@/hooks/useApi'
import { Clock, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

interface Props {
  partyId: string
  partyName: string
  domainType: string
}

// Domain-specific label for the history panel header
const HISTORY_LABEL: Record<string, string> = {
  clinic:         'Patient Visit History',
  diagnostic_lab: 'Patient Test History',
  optical:        'Patient History',
  pharmacy:       'Prescription History',
  salon:          'Service History',
  gym:            'Member History',
  repair:         'Repair History',
  coaching:       'Fee History',
  tiffin:         'Billing History',
  hotel:          'Stay History',
  pest_control:   'Service History',
  photography:    'Booking History',
  transport:      'Freight Bill History',
}

// Which domainData fields to surface as a subtitle line
function getSubtitle(domainType: string, domainData: Record<string, unknown> | null): string | null {
  if (!domainData) return null
  const d = domainData as Record<string, unknown>
  switch (domainType) {
    case 'clinic':
      return [d.visit_type ? String(d.visit_type).toUpperCase() : null, d.patient_age ? `Age ${d.patient_age}` : null, d.referral_doctor ? String(d.referral_doctor) : null].filter(Boolean).join(' · ') || null
    case 'diagnostic_lab':
      return [d.ref_doctor ? String(d.ref_doctor) : null, d.home_collection ? 'Home Collection' : null].filter(Boolean).join(' · ') || null
    case 'optical':
      if (d.re_sph) return `RE: ${d.re_sph}/${d.re_cyl ?? '0'}  LE: ${d.le_sph ?? '—'}/${d.le_cyl ?? '0'}`
      return null
    case 'pharmacy':
      return [d.doctor_name ? String(d.doctor_name) : null, d.prescription_id ? String(d.prescription_id) : null].filter(Boolean).join(' · ') || null
    case 'salon':
      return d.staff_name ? `Staff: ${d.staff_name}` : null
    case 'gym':
      return [d.membership_from ? `From ${d.membership_from}` : null, d.membership_to ? `To ${d.membership_to}` : null].filter(Boolean).join(' → ') || null
    case 'repair':
      return [d.device_brand, d.device_model, d.problem_reported].filter(Boolean).map(String).slice(0, 2).join(' ') || null
    case 'coaching':
      return [d.batch_name, d.fee_month].filter(Boolean).map(String).join(' · ') || null
    case 'hotel':
      return [d.room_no ? `Room ${d.room_no}` : null, d.check_in ? `${d.check_in} → ${d.check_out ?? '?'}` : null].filter(Boolean).join('  ') || null
    case 'pest_control':
      return d.service_address ? String(d.service_address).slice(0, 40) + (String(d.service_address).length > 40 ? '…' : '') : null
    case 'photography':
      return [d.event_type ? String(d.event_type) : null, d.event_date ? String(d.event_date) : null, d.photographer_name ? String(d.photographer_name) : null].filter(Boolean).join(' · ') || null
    default:
      return null
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}

function fmtAmt(n: number): string {
  return `₹${Number(n).toLocaleString('en-IN')}`
}

export function PartyHistory({ partyId, partyName: _partyName, domainType }: Props) {
  const navigate  = useNavigate()
  const { data, isLoading } = useInvoices({ partyId, txnType: 'sale_invoice', limit: 5 })

  const label = HISTORY_LABEL[domainType] ?? 'Purchase History'
  const invoices: any[] = (data as any)?.data ?? []

  if (isLoading) {
    return (
      <div className="card p-4">
        <p className="text-xs text-gray-400 animate-pulse">Loading history…</p>
      </div>
    )
  }

  if (invoices.length === 0) {
    return (
      <div className="card p-4">
        <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
        <p className="text-xs text-gray-400">No previous invoices found.</p>
      </div>
    )
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Clock className="w-3.5 h-3.5 text-gray-400" />
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</p>
      </div>

      <ul className="space-y-2">
        {invoices.map((inv: any) => {
          const total    = Number(inv.grandTotal ?? 0)
          const itemsCnt = inv._count?.items ?? null
          const subtitle = getSubtitle(domainType, inv.domainData ?? null)
          return (
            <li
              key={inv.id}
              onClick={() => navigate(`/invoices/${inv.id}`)}
              className="flex items-start justify-between gap-2 cursor-pointer rounded-lg px-2 py-2 hover:bg-gray-50 group -mx-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-800">{inv.number}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${inv.status === 'paid' ? 'bg-green-50 text-green-700' : inv.status === 'partial' ? 'bg-yellow-50 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>
                    {inv.status}
                  </span>
                </div>
                {subtitle && <p className="text-[11px] text-indigo-600 mt-0.5 truncate">{subtitle}</p>}
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {inv.date ? fmtDate(inv.date) : ''}
                  {itemsCnt != null ? <span className="ml-2">{itemsCnt} item{itemsCnt !== 1 ? 's' : ''}</span> : null}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-xs font-semibold text-gray-800">{fmtAmt(total)}</span>
                <ChevronRight className="w-3 h-3 text-gray-300 group-hover:text-gray-500" />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
