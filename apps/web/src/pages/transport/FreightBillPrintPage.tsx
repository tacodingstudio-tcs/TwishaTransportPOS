// Printable freight statement (GTA bill) — one row per LR: date, truck, LR, gate pass, destination,
// shipment no, load / unload qty, rate, amount; then GST, TDS and net receivable.
// Opens outside the app shell so only the document prints (landscape A4).
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { api } from '@/lib/api'
import { useFirms } from '@/hooks/useFirms'
import { PrintToolbar } from '@/components/transport/PrintToolbar'
import { PoweredBy } from '@/components/PoweredBy'
import { useAuthStore } from '@/store/auth.store'
import { amountInWords, fmtDate, inr, mt } from '@/components/transport/format'

const DEFAULT_TERMS = [
  'Interest @18% p.a. will be charged if payment is not made within the due date.',
  'Our responsibility ceases as soon as the goods are delivered to the consignee.',
  'Subject to local jurisdiction only. E. & O.E.',
]

const RATE_UNIT: Record<string, string> = { per_ton: '/MT', per_kg: '/kg', per_pkg: '/pkg', fixed: '' }

const addrText = (a: any): string => (a ? [a.line1, a.line2, a.city, /^\d+$/.test(String(a.state ?? '')) ? null : a.state, a.pincode].filter(Boolean).join(', ') : '')

export function FreightBillPrintPage() {
  const { id } = useParams<{ id: string }>()
  const [sp] = useSearchParams()
  const tenant = useAuthStore((s) => s.tenant)

  const { data: inv } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get(`/invoices/${id}`).then((r) => r.data) })
  const { data: firmData } = useFirms()
  const branch = firmData?.firms.find((f) => f.id === inv?.branchId) ?? firmData?.firms.find((f) => f.id === firmData.currentFirmId)

  useEffect(() => {
    if (inv && sp.get('auto') === '1') setTimeout(() => window.print(), 400)
  }, [inv, sp])

  if (!inv) return <div className="p-8 text-center text-gray-400">Loading…</div>

  const cfg = (branch?.domainConfig ?? {}) as Record<string, any>
  const dd = (inv.domainData ?? {}) as Record<string, any>
  const items: any[] = inv.items ?? []
  const gstMode: string = dd['gst_mode'] ?? 'rcm'
  const gstRate = Number(items[0]?.gstRate ?? 0)
  const sac = items[0]?.hsnSacCode ?? cfg['default_sac_code'] ?? '996791'
  const cgst = Number(inv.cgstTotal), sgst = Number(inv.sgstTotal), igst = Number(inv.igstTotal)
  const taxable = Number(inv.taxableAmt)
  const grand = Number(inv.grandTotal)
  const tds = Number(dd['tds_amount'] ?? 0)
  const net = grand - tds
  const loadKg = items.reduce((s, it) => s + Number(it.itemMeta?.load_kg ?? 0), 0)
  const unloadKg = items.reduce((s, it) => s + Number(it.itemMeta?.unload_kg ?? 0), 0)
  const hasUnload = items.some((it) => it.itemMeta?.unload_kg != null)
  const pan = cfg['pan'] ?? ''
  const terms: string[] = (cfg['bill_terms'] ? String(cfg['bill_terms']).split('\n').filter(Boolean) : DEFAULT_TERMS)
  const declaration: string = cfg['gta_declaration'] ||
    (gstMode === 'rcm'
      ? 'GTA declaration: GST on this service is payable by the recipient under reverse charge (RCM) as applicable, at the rate notified for goods transport agency services.'
      : gstMode === 'exempt'
        ? 'This supply of goods transport service is exempt from GST.'
        : 'GTA declaration: GST is levied on forward-charge basis on this bill; the consignee is not to pay GST under RCM on it.')

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm } }'}</style>
      <PrintToolbar width={1120}>
        <button type="button" className="btn-primary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Print</button>
      </PrintToolbar>

      <div className="max-w-[1120px] mx-auto bg-white border border-gray-400 p-5 print:border-0 text-[12px] text-gray-900">
        {/* Letterhead */}
        <header className="border-b-2 border-gray-800 pb-2 mb-3 text-center relative">
          {branch?.logo && <img src={branch.logo} alt="" className="absolute left-0 top-0 h-12 max-w-[120px] object-contain" />}
          <div className="text-2xl font-extrabold tracking-wide uppercase">{branch?.name ?? tenant?.name}</div>
          <div className="text-[11px] text-gray-600">{addrText(branch?.address)}</div>
          <div className="text-[11px] text-gray-600">
            {[branch?.gstin && `GSTIN: ${branch.gstin}`, pan && `PAN: ${pan}`].filter(Boolean).join('   ·   ')}
          </div>
        </header>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="col-span-2 border border-gray-400 p-2">
            <div className="text-[10px] uppercase text-gray-500">To</div>
            <div className="text-sm font-bold uppercase">{inv.party?.name}</div>
            <div className="text-[11px] text-gray-700">{addrText(inv.party?.address)}</div>
            <div className="text-[11px] text-gray-700">
              {[inv.party?.gstin && `GSTIN: ${inv.party.gstin}`, inv.party?.pan && `PAN: ${inv.party.pan}`].filter(Boolean).join('   ·   ')}
            </div>
          </div>
          <div className="border border-gray-400 p-2 text-[12px]">
            <div className="text-center font-bold uppercase border border-gray-800 py-0.5 mb-1">Tax Invoice</div>
            <div className="flex justify-between"><span className="text-gray-500">Bill no</span><strong>{inv.number}</strong></div>
            <div className="flex justify-between"><span className="text-gray-500">Date</span><strong>{fmtDate(inv.date)}</strong></div>
            {dd['period_from'] && (
              <div className="flex justify-between"><span className="text-gray-500">Period</span><span>{fmtDate(dd['period_from'])} – {fmtDate(dd['period_to'])}</span></div>
            )}
            <div className="flex justify-between"><span className="text-gray-500">SAC</span><span>{sac}</span></div>
          </div>
        </div>

        {/* Trips */}
        <table className="w-full border border-gray-400 border-collapse">
          <thead className="bg-gray-100 text-[10px] uppercase">
            <tr>
              {['Sr', 'Date', 'Truck no', 'LR no', 'G.P. no', 'Destination', 'Shipment no'].map((h) => (
                <th key={h} className="border border-gray-400 px-1.5 py-1 text-left">{h}</th>
              ))}
              <th className="border border-gray-400 px-1.5 py-1 text-right">Load (MT)</th>
              {hasUnload && <th className="border border-gray-400 px-1.5 py-1 text-right">Unload (MT)</th>}
              <th className="border border-gray-400 px-1.5 py-1 text-right">Rate</th>
              <th className="border border-gray-400 px-1.5 py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const m = it.itemMeta ?? {}
              return (
                <tr key={it.id} className="align-top">
                  <td className="border border-gray-400 px-1.5 py-1">{i + 1}</td>
                  <td className="border border-gray-400 px-1.5 py-1 whitespace-nowrap">{m.lr_date ? fmtDate(m.lr_date) : ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1 whitespace-nowrap">{m.vehicle_no ?? ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1 whitespace-nowrap">{m.lr_no ?? ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1">{m.gate_pass_no ?? ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1 uppercase">{m.to_city ?? it.description}</td>
                  <td className="border border-gray-400 px-1.5 py-1">{m.shipment_no ?? ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1 text-right">{m.load_kg != null ? mt(m.load_kg, 2) : ''}</td>
                  {hasUnload && <td className="border border-gray-400 px-1.5 py-1 text-right">{m.unload_kg != null ? mt(m.unload_kg, 2) : ''}</td>}
                  <td className="border border-gray-400 px-1.5 py-1 text-right whitespace-nowrap">{m.rate != null ? `${Number(m.rate).toLocaleString('en-IN')}${RATE_UNIT[m.rate_basis] ?? ''}` : ''}</td>
                  <td className="border border-gray-400 px-1.5 py-1 text-right">{Number(it.taxableAmt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              )
            })}
            <tr className="font-semibold bg-gray-50">
              <td className="border border-gray-400 px-1.5 py-1" colSpan={7}>Total</td>
              <td className="border border-gray-400 px-1.5 py-1 text-right">{loadKg ? mt(loadKg, 2) : ''}</td>
              {hasUnload && <td className="border border-gray-400 px-1.5 py-1 text-right">{unloadKg ? mt(unloadKg, 2) : ''}</td>}
              <td className="border border-gray-400 px-1.5 py-1" />
              <td className="border border-gray-400 px-1.5 py-1 text-right">{taxable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>

        {/* Totals + words + bank */}
        <div className="grid grid-cols-5 gap-3 mt-3">
          <div className="col-span-3 space-y-2">
            <div className="border border-gray-400 p-2">
              <div className="text-[10px] uppercase text-gray-500">Amount in words</div>
              <div className="font-semibold">{amountInWords(grand)}</div>
            </div>
            {(cfg['bank_name'] || cfg['bank_account_no']) && (
              <div className="border border-gray-400 p-2 text-[11px]">
                <div className="text-[10px] uppercase text-gray-500">Bank details</div>
                <div>Bank: <strong>{cfg['bank_name']}</strong></div>
                <div>A/c no: <strong>{cfg['bank_account_no']}</strong></div>
                <div>IFSC: <strong>{cfg['bank_ifsc']}</strong></div>
              </div>
            )}
            <div className="border border-gray-400 p-2 text-[10px] leading-snug text-gray-700">{declaration}</div>
          </div>

          <div className="col-span-2 border border-gray-400">
            {[
              ['Total freight', taxable],
              ...(cgst ? [[`CGST ${gstRate / 2}%`, cgst]] : []),
              ...(sgst ? [[`SGST ${gstRate / 2}%`, sgst]] : []),
              ...(igst ? [[`IGST ${gstRate}%`, igst]] : []),
              ...(Number(inv.roundOff) ? [['Round off', Number(inv.roundOff)]] : []),
            ].map(([label, v]) => (
              <div key={String(label)} className="flex justify-between px-2 py-1 border-b border-gray-200">
                <span>{label}</span><span>{Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            ))}
            {gstMode === 'rcm' && <div className="px-2 py-1 text-[10px] text-gray-500 border-b border-gray-200">GST payable by recipient under RCM</div>}
            <div className="flex justify-between px-2 py-1.5 font-bold bg-gray-100 border-b border-gray-300">
              <span>Grand total</span><span>{inr(grand, 2)}</span>
            </div>
            {tds > 0 && (
              <>
                <div className="flex justify-between px-2 py-1 border-b border-gray-200">
                  <span>Less: TDS ({dd['tds_rate_pct']}%)</span><span>− {inr(tds, 2)}</span>
                </div>
                <div className="flex justify-between px-2 py-1.5 font-bold">
                  <span>Net receivable</span><span>{inr(net, 2)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <ol className="list-decimal pl-4 mt-3 text-[10px] text-gray-600 space-y-0.5">
          {terms.map((t) => <li key={t}>{t}</li>)}
        </ol>
        <div className="flex justify-end mt-10 text-[11px]">
          <div className="text-center">
            <div className="border-t border-gray-600 pt-1 px-10">For {branch?.name ?? tenant?.name}</div>
            <div className="text-gray-500">Authorised signatory</div>
          </div>
        </div>
      </div>
      <PoweredBy className="text-center mt-1.5 !text-[10px]" />
    </div>
  )
}
