// Printable consignment note (Lorry Receipt). Opens outside the app shell so only the document prints.
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { branchApi, transportApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { inr, num, fmtDate, fmtDateTime, FREIGHT_TYPE_LABEL, RATE_BASIS_LABEL } from '@/components/transport/format'

const COPIES = ['Consignor copy', 'Consignee copy', 'Driver copy']

const TERMS = [
  'Goods are accepted for carriage at owner\'s risk unless insured; the carrier is not liable for leakage, breakage or damage from natural causes.',
  'Freight, detention and demurrage are payable as stated above. Goods may be retained until all dues are cleared.',
  'The consignee must record any shortage or damage on this receipt at the time of delivery.',
  'Subject to jurisdiction of the carrier\'s city courts.',
]

function Cell({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`border border-gray-400 px-2 py-1 ${className}`}>
      <div className="text-[9px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-[12px] text-gray-900 min-h-[16px]">{children}</div>
    </div>
  )
}

export function LrPrintPage() {
  const { id } = useParams<{ id: string }>()
  const [sp] = useSearchParams()
  const tenant = useAuthStore((s) => s.tenant)
  const user = useAuthStore((s) => s.user)

  const { data: lr } = useQuery({ queryKey: ['transport-lr', id], queryFn: () => transportApi.getLr(id!) })
  const { data: branches } = useQuery({ queryKey: ['branches-print'], queryFn: branchApi.list })
  const branch = Array.isArray(branches) ? branches[0] : undefined

  useEffect(() => {
    if (lr && sp.get('auto') === '1') setTimeout(() => window.print(), 400)
  }, [lr, sp])

  if (!lr) return <div className="p-8 text-center text-gray-400">Loading…</div>

  const address = branch?.address ? [branch.address.line1, branch.address.city, /^\d+$/.test(String(branch.address.state ?? '')) ? null : branch.address.state, branch.address.pincode].filter(Boolean).join(', ') : ''
  const balance = Number(lr.totalAmount) - Number(lr.advancePaid)
  const charges: Array<[string, number]> = [
    [`Freight (${RATE_BASIS_LABEL[lr.rateBasis]}${lr.rateBasis !== 'fixed' ? ` @ ${inr(lr.rate)}` : ''})`, Number(lr.freightAmount)],
    ['Loading', Number(lr.loadingCharges)], ['Unloading', Number(lr.unloadingCharges)],
    ['Detention', Number(lr.detentionCharges)], ['Other', Number(lr.otherCharges)],
  ]

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <div className="max-w-[820px] mx-auto mb-4 flex justify-end print:hidden">
        <button type="button" className="btn-primary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Print (3 copies)</button>
      </div>

      {COPIES.map((copy, i) => (
        <section key={copy}
          className="max-w-[820px] mx-auto bg-white border border-gray-400 p-4 mb-6 print:mb-0 print:border-0 print:break-after-page last:print:break-after-auto">
          {/* Letterhead */}
          <header className="flex items-start justify-between border-b-2 border-gray-800 pb-2 mb-2">
            <div>
              <div className="text-xl font-bold tracking-wide text-gray-900">{tenant?.name ?? branch?.name}</div>
              {address && <div className="text-[11px] text-gray-600">{address}</div>}
              <div className="text-[11px] text-gray-600">
                {[branch?.gstin && `GSTIN: ${branch.gstin}`, user?.phone && `Ph: ${user.phone}`].filter(Boolean).join('  ·  ')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-bold uppercase tracking-wider text-gray-900">Consignment Note</div>
              <div className="text-[10px] uppercase text-gray-500">(Lorry Receipt)</div>
              <div className="mt-1 inline-block border border-gray-800 px-2 py-0.5 text-[10px] font-semibold uppercase">{copy}</div>
            </div>
          </header>

          <div className="grid grid-cols-4 gap-0">
            <Cell label="LR No." className="font-bold"><span className="font-mono text-sm font-bold">{lr.lrNo}</span></Cell>
            <Cell label="Date">{fmtDate(lr.lrDate)}</Cell>
            <Cell label="From">{lr.fromCity}</Cell>
            <Cell label="To">{lr.toCity}</Cell>

            <Cell label="Consignor" className="col-span-2">
              <div className="font-semibold">{lr.consignorName}</div>
              <div className="text-[11px] text-gray-600">{lr.consignorAddress}</div>
              <div className="text-[11px] text-gray-600">{[lr.consignorGstin && `GSTIN ${lr.consignorGstin}`, lr.consignorPhone].filter(Boolean).join(' · ')}</div>
            </Cell>
            <Cell label="Consignee" className="col-span-2">
              <div className="font-semibold">{lr.consigneeName}</div>
              <div className="text-[11px] text-gray-600">{lr.consigneeAddress}</div>
              <div className="text-[11px] text-gray-600">{[lr.consigneeGstin && `GSTIN ${lr.consigneeGstin}`, lr.consigneePhone].filter(Boolean).join(' · ')}</div>
            </Cell>

            <Cell label="Vehicle No.">{lr.vehicleNo}</Cell>
            <Cell label="Driver">{lr.driverName}</Cell>
            <Cell label="E-way bill no.">{lr.ewayBillNo}</Cell>
            <Cell label="E-way valid upto">{lr.ewayValidUpto ? fmtDateTime(lr.ewayValidUpto) : ''}</Cell>
          </div>

          {/* Goods */}
          <table className="w-full border border-gray-400 border-t-0 text-[12px]">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-600">
              <tr>
                <th className="border border-gray-400 px-2 py-1 text-left w-20">Packages</th>
                <th className="border border-gray-400 px-2 py-1 text-left">Description of goods</th>
                <th className="border border-gray-400 px-2 py-1 text-right w-24">Actual wt (kg)</th>
                <th className="border border-gray-400 px-2 py-1 text-right w-24">Charged wt (kg)</th>
                <th className="border border-gray-400 px-2 py-1 text-right w-28">Declared value</th>
              </tr>
            </thead>
            <tbody>
              <tr className="align-top h-16">
                <td className="border border-gray-400 px-2 py-1">{lr.packages ? `${num(lr.packages)} ${lr.packageType ?? ''}` : ''}</td>
                <td className="border border-gray-400 px-2 py-1">
                  {lr.goodsDescription}
                  {lr.invoiceRefs && <div className="text-[11px] text-gray-500">Invoice(s): {lr.invoiceRefs}</div>}
                </td>
                <td className="border border-gray-400 px-2 py-1 text-right">{num(lr.actualWeightKg)}</td>
                <td className="border border-gray-400 px-2 py-1 text-right">{num(lr.chargedWeightKg)}</td>
                <td className="border border-gray-400 px-2 py-1 text-right">{Number(lr.declaredValue) > 0 ? inr(lr.declaredValue) : ''}</td>
              </tr>
            </tbody>
          </table>

          {/* Freight */}
          <div className="grid grid-cols-3 border border-gray-400 border-t-0">
            <div className="col-span-2 border-r border-gray-400 p-2">
              <div className="text-[9px] uppercase tracking-wide text-gray-500 mb-1">Freight basis</div>
              <div className="flex gap-4 text-[12px]">
                {(['paid', 'to_pay', 'tbb'] as const).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1">
                    <span className={`inline-block w-3 h-3 border border-gray-800 ${lr.freightType === t ? 'bg-gray-800' : ''}`} />
                    {FREIGHT_TYPE_LABEL[t]}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-gray-500 mt-2">GST, where applicable, is charged on the freight bill / payable by the recipient under reverse charge.</div>
              {lr.remarks && <div className="text-[11px] mt-2"><strong>Remarks:</strong> {lr.remarks}</div>}
            </div>
            <div className="p-2 text-[12px]">
              {charges.filter(([, v], idx) => idx === 0 || v > 0).map(([label, v]) => (
                <div key={label} className="flex justify-between"><span className="text-gray-600">{label}</span><span>{inr(v, 2)}</span></div>
              ))}
              <div className="flex justify-between font-bold border-t border-gray-400 mt-1 pt-1"><span>Total</span><span>{inr(lr.totalAmount, 2)}</span></div>
              {Number(lr.advancePaid) > 0 && <div className="flex justify-between"><span className="text-gray-600">Advance</span><span>− {inr(lr.advancePaid, 2)}</span></div>}
              {lr.freightType === 'to_pay' && <div className="flex justify-between font-semibold"><span>To pay</span><span>{inr(balance, 2)}</span></div>}
            </div>
          </div>

          {/* Terms + signatures */}
          <ol className="list-decimal pl-4 mt-2 text-[9px] leading-snug text-gray-600 space-y-0.5">
            {TERMS.map((t) => <li key={t}>{t}</li>)}
          </ol>
          <div className="grid grid-cols-3 gap-6 mt-8 text-[10px] text-gray-600">
            <div className="border-t border-gray-500 pt-1">Consignor / Booking clerk</div>
            <div className="border-t border-gray-500 pt-1">Driver</div>
            <div className="border-t border-gray-500 pt-1 text-right">For {tenant?.name ?? 'carrier'} — authorised signatory</div>
          </div>
          <div className="mt-6 border border-dashed border-gray-400 p-2 text-[10px] text-gray-600 grid grid-cols-3 gap-4">
            <span>Received in good condition: ☐ Yes ☐ No (remarks)</span>
            <span>Date & time: ______________</span>
            <span className="text-right">Consignee seal & signature</span>
          </div>
          <div className="text-right text-[9px] text-gray-400 mt-1">Page {i + 1}/{COPIES.length}</div>
        </section>
      ))}
    </div>
  )
}
