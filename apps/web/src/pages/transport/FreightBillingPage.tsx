// Freight billing — pick a customer's LRs and raise one GST freight bill through the shared invoice engine.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ReceiptText, Users } from 'lucide-react'
import { transportApi, branchApi, partyApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { PartyPicker, type PickedParty } from '@/components/transport/PartyPicker'
import { StatusPill } from '@/components/transport/StatusPill'
import { inr, mt, fmtDate, todayIst, GST_MODE_LABEL, FREIGHT_TYPE_LABEL } from '@/components/transport/format'

const GST_RATE: Record<string, number> = { rcm: 0, exempt: 0, forward_5: 5, forward_12: 12, forward_18: 18 }
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function FreightBillingPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [sp] = useSearchParams()
  const { data: branches } = useQuery({ queryKey: ['branches'], queryFn: branchApi.list })
  const branch = Array.isArray(branches) ? branches[0] : undefined
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')

  const [party, setParty] = useState<PickedParty>({ name: '' })
  const [freightType, setFreightType] = useState<string>('tbb')
  const [picked, setPicked] = useState<string[]>([])
  const [gstMode, setGstMode] = useState<string>('rcm')
  const [gstTouched, setGstTouched] = useState(false)
  useEffect(() => {
    const m = (branch?.domainConfig as any)?.default_gst_mode
    if (m && !gstTouched) setGstMode(String(m))
  }, [branch, gstTouched])
  const [creditDays, setCreditDays] = useState('30')
  const [billDate, setBillDate] = useState(todayIst())
  const [notes, setNotes] = useState('')
  const [tds, setTds] = useState(false)
  const [tdsRate, setTdsRate] = useState('1')

  // Deep link from quick entry / an LR: ?partyId=…
  const partyParam = sp.get('partyId')
  const { data: linkedParty } = useQuery({ queryKey: ['party', partyParam], queryFn: () => partyApi.get(partyParam!), enabled: !!partyParam })
  useEffect(() => { if (linkedParty?.id) setParty((p) => (p.id ? p : { id: linkedParty.id, name: linkedParty.name, gstin: linkedParty.gstin, phone: linkedParty.phone })) }, [linkedParty])

  // Deep link from an LR: ?partyId=…&lr=…
  const lrParam = sp.get('lr')
  const { data: linkedLr } = useQuery({ queryKey: ['transport-lr', lrParam], queryFn: () => transportApi.getLr(lrParam!), enabled: !!lrParam })
  useEffect(() => {
    if (!linkedLr) return
    if (linkedLr.consignorId) setParty({ id: linkedLr.consignorId, name: linkedLr.consignorName })
    setFreightType(linkedLr.freightType)
    setPicked([linkedLr.id])
  }, [linkedLr])

  const { data, isLoading } = useQuery({
    queryKey: ['transport-bill-candidates', party.id, freightType],
    queryFn:  () => transportApi.billCandidates({ partyId: party.id, freightType, as: 'any' }),
  })
  const rows: any[] = data?.data ?? []

  // Customers with billable LRs (shown when no customer is chosen yet)
  const byParty = useMemo(() => {
    const m = new Map<string, { id?: string; name: string; count: number; amount: number }>()
    for (const l of rows) {
      const key = l.consignorId ?? l.consignorName
      const cur = m.get(key) ?? { id: l.consignorId ?? undefined, name: l.consignorName, count: 0, amount: 0 }
      cur.count += 1; cur.amount += Number(l.totalAmount)
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount)
  }, [rows])

  const selected = rows.filter((l) => picked.includes(l.id))
  const subtotal = r2(selected.reduce((s, l) => s + Number(l.totalAmount), 0))
  const advance = r2(selected.reduce((s, l) => s + Number(l.advancePaid), 0))
  const gstRate = GST_RATE[gstMode] ?? 0
  const gst = r2(subtotal * gstRate / 100)
  const grand = Math.round(subtotal + gst)          // invoices round to the nearest rupee
  const tdsAmt = tds ? Math.round(subtotal * Number(tdsRate) / 100) : 0
  const undelivered = selected.filter((l) => l.status === 'booked' || l.status === 'in_transit')

  const bill = useMutation({
    mutationFn: () => transportApi.createBill({
      partyId: party.id, lrIds: picked, gstMode, date: billDate, creditDays: Number(creditDays || 0),
      notes: notes || undefined, tdsApplicable: tds, tdsRatePct: Number(tdsRate),
    }),
    onSuccess: (r: any) => {
      for (const k of ['transport-bill-candidates', 'transport-lrs', 'transport-dashboard', 'invoices']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(`Freight bill ${r.invoice.number} created`)
      navigate(`/invoices/${r.invoice.id}`)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const canSubmit = !!party.id && picked.length > 0 && !bill.isPending && !readOnly

  return (
    <div>
      <PageHeader title="Make bill" subtitle="Pick the delivered loads of a party and make one GST bill" />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-4">
          <div className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            <PartyPicker label="Bill to (party)" value={party}
              onChange={(p) => { setParty(p.id ? p : { name: p.name }); setPicked([]) }} required />
            <div>
              <label className="label">Who pays the freight?</label>
              <div className="flex gap-2">
                {Object.entries(FREIGHT_TYPE_LABEL).map(([v, l]) => (
                  <button key={v} type="button" onClick={() => { setFreightType(v); setPicked([]) }}
                    className={`px-3 py-2 rounded-lg text-sm border transition-colors ${freightType === v ? 'bg-primary-50 border-primary-300 text-primary-700 font-medium' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>{l}</button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">For regular parties choose “Bill later” — you make one bill for the whole month.</p>
            </div>
          </div>

          {!party.id && !isLoading && byParty.length > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2"><Users className="w-4 h-4 text-gray-400" /><h2 className="text-sm font-semibold text-gray-900">Parties whose bill is not made yet</h2></div>
              <ul className="divide-y divide-gray-50">
                {byParty.map((p) => (
                  <li key={p.id ?? p.name}>
                    <button type="button" disabled={!p.id} onClick={() => p.id && setParty({ id: p.id, name: p.name })}
                      className="w-full flex items-center gap-3 px-5 py-3 hover:bg-gray-50 text-left disabled:opacity-60">
                      <span className="flex-1 text-sm font-medium text-gray-900">{p.name}{!p.id && <span className="ml-2 text-xs text-amber-600">not a saved party</span>}</span>
                      <span className="text-xs text-gray-500">{p.count} LR{p.count > 1 ? 's' : ''}</span>
                      <span className="text-sm font-semibold w-28 text-right">{inr(p.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {party.id && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center">
                <h2 className="text-sm font-semibold text-gray-900">Loads without a bill ({rows.length})</h2>
                {rows.length > 0 && (
                  <button type="button" className="ml-auto text-xs text-primary-600 hover:underline"
                    onClick={() => setPicked(picked.length === rows.length ? [] : rows.map((l) => l.id))}>
                    {picked.length === rows.length ? 'Clear' : 'Select all'}
                  </button>
                )}
              </div>
              {isLoading ? <p className="p-6 text-sm text-gray-400 text-center">Loading…</p>
                : rows.length === 0 ? <p className="p-6 text-sm text-gray-400 text-center">No loads waiting for a bill for this party.</p>
                : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                      <tr>
                        <th className="px-4 py-2 w-8" />
                        <th className="px-4 py-2 text-left">LR</th>
                        <th className="px-4 py-2 text-left">From → To / goods</th>
                        <th className="px-4 py-2 text-right">Quantity</th>
                        <th className="px-4 py-2 text-left">Status</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {rows.map((l) => (
                        <tr key={l.id} className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => setPicked((p) => p.includes(l.id) ? p.filter((x) => x !== l.id) : [...p, l.id])}>
                          <td className="px-4 py-3"><input type="checkbox" readOnly checked={picked.includes(l.id)} /></td>
                          <td className="px-4 py-3"><div className="font-mono text-xs text-gray-700">{l.lrNo}</div><div className="text-xs text-gray-400">{fmtDate(l.lrDate)}</div></td>
                          <td className="px-4 py-3"><div className="text-gray-900">{l.fromCity} → {l.toCity}</div><div className="text-xs text-gray-500 truncate max-w-[260px]">{l.goodsDescription}</div></td>
                          <td className="px-4 py-3 text-right text-gray-600 whitespace-nowrap">{mt(l.actualWeightKg)} MT{l.unloadWeightKg != null && Number(l.unloadWeightKg) !== Number(l.actualWeightKg) && <span className="block text-xs text-amber-600">unload {mt(l.unloadWeightKg)}</span>}</td>
                          <td className="px-4 py-3"><StatusPill kind="lr" status={l.status} /></td>
                          <td className="px-4 py-3 text-right font-medium">{inr(l.totalAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          )}
        </div>

        {/* Bill options */}
        <aside>
          <div className="card p-5 space-y-4 xl:sticky xl:top-24">
            <h2 className="text-sm font-semibold text-gray-900">Bill details</h2>
            <div>
              <label className="label">How is GST charged?</label>
              <select className="input" value={gstMode} onChange={(e) => { setGstTouched(true); setGstMode(e.target.value) }}>
                {Object.entries(GST_MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {gstMode === 'rcm' && <p className="text-xs text-gray-400 mt-1">Your bill will show no GST. The party pays the 5% GST himself to the government.</p>}
              {gstMode !== 'rcm' && gstMode !== 'exempt' && <p className="text-xs text-gray-400 mt-1">CGST+SGST or IGST is chosen automatically from the party’s state.</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Bill date</label><input type="date" className="input" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></div>
              <div><label className="label">Days to pay</label><input type="number" min="0" className="input" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} /></div>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <label className="flex items-center gap-2"><input type="checkbox" checked={tds} onChange={(e) => setTds(e.target.checked)} /> Party will keep TDS (tax) from payment</label>
              {tds && (
                <select className="input !w-auto !py-1" value={tdsRate} onChange={(e) => setTdsRate(e.target.value)} aria-label="TDS rate">
                  <option value="1">1%</option><option value="2">2%</option><option value="0.5">0.5%</option>
                </select>
              )}
            </div>
            <div><label className="label">Notes</label><textarea className="input h-16 resize-none" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>

            <dl className="text-sm space-y-2 border-t border-gray-100 pt-3">
              <div className="flex justify-between"><dt className="text-gray-500">{selected.length} LR{selected.length === 1 ? '' : 's'}</dt><dd>{inr(subtotal, 2)}</dd></div>
              {gstRate > 0 && <div className="flex justify-between"><dt className="text-gray-500">GST @ {gstRate}%</dt><dd>{inr(gst, 2)}</dd></div>}
              <div className="flex justify-between font-semibold text-gray-900 border-t border-gray-100 pt-2"><dt>Bill total</dt><dd>{inr(grand, 2)}</dd></div>
              {tdsAmt > 0 && <div className="flex justify-between"><dt className="text-gray-500">Less TDS (tax kept) @ {tdsRate}%</dt><dd>− {inr(tdsAmt, 2)}</dd></div>}
              {tdsAmt > 0 && <div className="flex justify-between font-semibold text-primary-700"><dt>Money you will get</dt><dd>{inr(grand - tdsAmt, 2)}</dd></div>}
              {advance > 0 && <div className="flex justify-between text-xs text-gray-500"><dt>Advance already taken</dt><dd>{inr(advance, 2)}</dd></div>}
            </dl>
            {undelivered.length > 0 && (
              <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
                {undelivered.length} selected load{undelivered.length > 1 ? 's are' : ' is'} not delivered yet — you can still make the bill.
              </p>
            )}
            <button type="button" className="btn-primary w-full justify-center" disabled={!canSubmit} onClick={() => bill.mutate()}>
              <ReceiptText className="w-4 h-4" /> {bill.isPending ? 'Making bill…' : 'Make bill'}
            </button>
            {!party.id && <p className="text-xs text-gray-400 text-center">Pick a party to start.</p>}
          </div>
        </aside>
      </div>
    </div>
  )
}
