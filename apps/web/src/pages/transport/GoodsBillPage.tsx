// Goods bill — a trading firm's sale of goods (e.g. fly ash): customer, product / HSN / quantity / rate / GST %.
// It is a normal sale invoice made through the shared invoice engine, so numbering, GST split, customer balance,
// payments and GST reports all work as usual. Quantity can be pulled from a freight bill of the transport firm
// (same load, same tonnes) so nothing is typed twice.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Trash2, Truck, UserPlus, Copy, X, Loader2 } from 'lucide-react'
import { transportApi, partyApi, apiError } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { PageHeader } from '@/components/layout/PageHeader'
import { Modal } from '@/components/transport/Modal'
import { PartyCombobox, type PickedParty } from '@/components/ui/PartyCombobox'
import { useCurrentFirm } from '@/hooks/useFirms'
import { inr, fmtDate, todayIst } from '@/components/transport/format'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const UNITS = ['MT', 'kg', 'Qtl', 'Nos', 'Bag', 'Ltr', 'Box']
const GST_RATES = [0, 5, 12, 18, 28]

interface Line { description: string; hsn: string; qty: string; unit: string; rate: string; gst: string }
const blankLine = (): Line => ({ description: '', hsn: '', qty: '', unit: 'MT', rate: '', gst: '5' })

export function GoodsBillPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const readOnly = useAuthStore((s) => s.user?.role === 'viewer')
  const canManage = useAuthStore((s) => s.canManage())
  const { firm, firms } = useCurrentFirm()

  const [party, setParty] = useState<PickedParty>({ name: '' })
  const [date, setDate] = useState(todayIst())
  const [creditDays, setCreditDays] = useState('30')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<Line[]>([blankLine()])
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [showCopy, setShowCopy] = useState(false)

  const { data: suggestions = [] } = useQuery<any[]>({ queryKey: ['goods-suggestions'], queryFn: transportApi.goodsSuggestions })

  // Freight bills of the transport firm(s): pick one to pull the customer and tonnes from.
  const others = firms.filter((f) => f.id !== firm?.id)
  const sources = others.filter((f) => f.kind === 'transport')
  const [sourceFirmId, setSourceFirmId] = useState('')
  useEffect(() => { if (!sourceFirmId && sources[0]) setSourceFirmId(sources[0].id) }, [sources, sourceFirmId])
  const { data: sourceBills = [] } = useQuery<any[]>({
    queryKey: ['firm-bills', sourceFirmId], queryFn: () => transportApi.firmBills(sourceFirmId), enabled: !!sourceFirmId && canManage,
  })

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)))

  function applySuggestion(i: number, s: any) {
    setLine(i, {
      description: s.description, hsn: s.hsnSacCode ?? '', unit: s.unit || 'MT',
      gst: String(s.gstRate ?? 5), rate: s.rate ? String(s.rate) : '',
    })
  }
  function onProductChange(i: number, value: string) {
    const hit = suggestions.find((s) => s.description.toLowerCase() === value.trim().toLowerCase())
    if (hit && !lines[i]!.hsn && !lines[i]!.rate) applySuggestion(i, hit)
    else setLine(i, { description: value })
  }

  async function fromFreightBill(bill: any) {
    try {
      if (bill.partyId) {
        const c = await transportApi.copyParty(bill.partyId)
        setParty({ id: c.id, name: c.name, gstin: c.gstin })
        if (c.copied) toast.success(`${c.name} copied into ${firm?.name ?? 'this firm'}`)
      }
      if (bill.date) setDate(bill.date)
      setLines((ls) => {
        const first = ls[0] ?? blankLine()
        const filled = first.description ? first : { ...first, ...(suggestions[0] ? {
          description: suggestions[0].description, hsn: suggestions[0].hsnSacCode ?? '', unit: suggestions[0].unit || 'MT',
          gst: String(suggestions[0].gstRate ?? 5), rate: suggestions[0].rate ? String(suggestions[0].rate) : '' } : {}) }
        return [{ ...filled, qty: bill.qtyMt ? String(bill.qtyMt) : filled.qty, unit: bill.qtyMt ? 'MT' : filled.unit }, ...ls.slice(1)]
      })
    } catch (e) { toast.error(apiError(e)) }
  }

  // ── Preview (the server works the real numbers out; this just shows what to expect) ─────────────────────────
  const partyState = (party.address as any)?.stateCode as string | undefined
  const interState = !!(firm?.stateCode && partyState && firm.stateCode !== partyState)
  const calc = useMemo(() => {
    let taxable = 0, cgst = 0, sgst = 0, igst = 0
    for (const l of lines) {
      const t = r2((Number(l.qty) || 0) * (Number(l.rate) || 0))
      const g = r2(t * (Number(l.gst) || 0) / 100)
      taxable += t
      if (interState) igst += g
      else { const half = r2(g / 2); cgst += half; sgst += r2(g - half) }
    }
    taxable = r2(taxable); cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst)
    const before = r2(taxable + cgst + sgst + igst)
    const grand = Math.round(before)
    return { taxable, cgst, sgst, igst, roundOff: r2(grand - before), grand }
  }, [lines, interState])

  const validLines = lines.every((l) => l.description.trim() && Number(l.qty) > 0 && Number(l.rate) >= 0 && l.rate !== '')
  const canSave = !!party.id && validLines && !readOnly

  const create = useMutation({
    mutationFn: () => transportApi.createGoodsBill({
      partyId: party.id, date, creditDays: Number(creditDays) || 0, notes: notes.trim() || undefined,
      items: lines.map((l) => ({
        description: l.description.trim(), hsnSacCode: l.hsn.trim() || null, qty: Number(l.qty), unit: l.unit,
        rate: Number(l.rate), gstRate: Number(l.gst),
      })),
    }),
    onSuccess: (r: any) => {
      for (const k of ['invoices', 'firms', 'goods-suggestions', 'parties', 'aging']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(`Bill ${r.invoice.number} created`)
      navigate(`/invoices/${r.invoice.id}`)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  const nextNo = firm?.numbering?.style === 'plain' && firm.numbering.next != null ? `${firm.numbering.prefix ?? ''}${firm.numbering.next}` : null

  return (
    <div>
      <PageHeader
        title="Goods bill"
        subtitle={`${firm?.name ?? ''}${nextNo ? ` · next bill number ${nextNo}` : ''}`}
      />
      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6 max-w-7xl">
        <div className="xl:col-span-2 space-y-6">

          {/* Customer */}
          <section className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Customer</h2>
              <span className="flex-1" />
              {!readOnly && (
                <>
                  <button type="button" className="btn-ghost text-sm" onClick={() => setShowAddCustomer(true)}><UserPlus className="w-4 h-4" /> New customer</button>
                  {canManage && others.length > 0 && (
                    <button type="button" className="btn-ghost text-sm" onClick={() => setShowCopy(true)}><Copy className="w-4 h-4" /> Copy from {others.length === 1 ? others[0]!.name : 'another firm'}</button>
                  )}
                </>
              )}
            </div>
            <PartyCombobox value={party} onChange={(p) => setParty(p)} type="customer" allowFreeText={false} required placeholder="Search customer by name, phone or GSTIN…" />
            {party.id && (
              <p className="text-xs text-gray-500 mt-2">
                {party.gstin ? `GSTIN ${party.gstin} · ` : ''}{interState ? 'Other state — IGST' : 'Same state — CGST + SGST'}
              </p>
            )}
          </section>

          {/* Pull from a freight bill */}
          {canManage && sources.length > 0 && sourceBills.length > 0 && !readOnly && (
            <section className="card p-5">
              <div className="flex items-center gap-2 mb-1">
                <Truck className="w-4 h-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-900">Same load as a freight bill?</h2>
              </div>
              <p className="text-xs text-gray-500 mb-3">Pick the transport bill for this delivery — the customer and tonnes fill in here.</p>
              {sources.length > 1 && (
                <select className="input mb-2 w-60" value={sourceFirmId} onChange={(e) => setSourceFirmId(e.target.value)}>
                  {sources.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              )}
              <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg max-h-56 overflow-y-auto">
                {sourceBills.map((b) => (
                  <button key={b.id} type="button" onClick={() => fromFreightBill(b)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50">
                    <span className="font-mono text-xs text-gray-500 w-16 shrink-0">{b.number}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-900 truncate">{b.partyName ?? 'Customer'}</span>
                      <span className="block text-xs text-gray-500">{fmtDate(b.date)}{b.origin ? ` · from ${b.origin}` : ''}</span>
                    </span>
                    <span className="text-xs text-gray-600 text-right shrink-0">{b.qtyMt != null ? `${b.qtyMt} MT` : ''}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Items */}
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">What you are selling</h2>
            <datalist id="goods-products">{suggestions.map((s) => <option key={s.description} value={s.description} />)}</datalist>
            <div className="space-y-3">
              {lines.map((l, i) => {
                const amount = r2((Number(l.qty) || 0) * (Number(l.rate) || 0))
                return (
                  <div key={i} className="grid grid-cols-12 gap-2 items-end border border-gray-100 rounded-lg p-3">
                    <div className="col-span-12 md:col-span-6">
                      <label className="label">Product *</label>
                      <input className="input" list="goods-products" value={l.description} placeholder="e.g. Flyash from Kutch"
                        onChange={(e) => onProductChange(i, e.target.value)} />
                    </div>
                    <div className="col-span-6 md:col-span-3">
                      <label className="label">HSN</label>
                      <input className="input" maxLength={8} inputMode="numeric" value={l.hsn} onChange={(e) => setLine(i, { hsn: e.target.value.replace(/\D/g, '') })} />
                    </div>
                    <div className="col-span-6 md:col-span-3">
                      <label className="label">GST %</label>
                      <select className="input" value={l.gst} onChange={(e) => setLine(i, { gst: e.target.value })}>
                        {GST_RATES.map((g) => <option key={g} value={g}>{g}%</option>)}
                      </select>
                    </div>
                    <div className="col-span-5 md:col-span-3">
                      <label className="label">Quantity *</label>
                      <input className="input" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </div>
                    <div className="col-span-3 md:col-span-2">
                      <label className="label">Unit</label>
                      <select className="input" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })}>
                        {[...new Set([...UNITS, l.unit])].map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                    <div className="col-span-4 md:col-span-3">
                      <label className="label">Rate (₹) *</label>
                      <input className="input" type="number" min="0" step="any" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
                    </div>
                    <div className="col-span-10 md:col-span-3 text-right">
                      <div className="text-xs text-gray-400">Amount</div>
                      <div className="text-sm font-semibold text-gray-900">{inr(amount, 2)}</div>
                    </div>
                    <div className="col-span-2 md:col-span-1 flex justify-end">
                      {lines.length > 1 && (
                        <button type="button" title="Remove" className="p-2 text-gray-300 hover:text-red-600" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}><Trash2 className="w-4 h-4" /></button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <button type="button" className="btn-ghost text-sm mt-3" onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus className="w-4 h-4" /> Add another product</button>
          </section>
        </div>

        {/* Summary */}
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Bill details</h2>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">Bill date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div><label className="label">Credit (days)</label><input type="number" min="0" max="180" className="input" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} /></div>
              <div className="col-span-2"><label className="label">Note <span className="text-gray-400 font-normal">(printed on the bill)</span></label>
                <input className="input" maxLength={800} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Total</h2>
            <dl className="text-sm space-y-2">
              <div className="flex justify-between"><dt className="text-gray-500">Taxable amount</dt><dd>{inr(calc.taxable, 2)}</dd></div>
              {interState
                ? <div className="flex justify-between"><dt className="text-gray-500">IGST</dt><dd>{inr(calc.igst, 2)}</dd></div>
                : <>
                    <div className="flex justify-between"><dt className="text-gray-500">CGST</dt><dd>{inr(calc.cgst, 2)}</dd></div>
                    <div className="flex justify-between"><dt className="text-gray-500">SGST</dt><dd>{inr(calc.sgst, 2)}</dd></div>
                  </>}
              <div className="flex justify-between"><dt className="text-gray-500">Round off</dt><dd>{calc.roundOff.toFixed(2)}</dd></div>
              <div className="flex justify-between border-t border-gray-100 pt-2 text-base font-bold"><dt>Grand total</dt><dd>{inr(calc.grand, 2)}</dd></div>
            </dl>
            <button type="button" className="btn-primary w-full justify-center mt-4" disabled={!canSave || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create bill'}
            </button>
            {!party.id && <p className="text-xs text-gray-400 mt-2 text-center">Pick a customer first.</p>}
          </section>
        </div>
      </div>

      {showAddCustomer && <NewCustomerModal stateCode={firm?.stateCode ?? ''} onClose={() => setShowAddCustomer(false)}
        onCreated={(p) => { setParty(p); setShowAddCustomer(false) }} />}
      {showCopy && <CopyCustomerModal firms={others} onClose={() => setShowCopy(false)}
        onCopied={(p) => { setParty(p); setShowCopy(false) }} />}
    </div>
  )
}

function NewCustomerModal({ stateCode, onClose, onCreated }: { stateCode: string; onClose: () => void; onCreated: (p: PickedParty) => void }) {
  const [f, setF] = useState({ name: '', gstin: '', phone: '', city: '', stateCode })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))
  const m = useMutation({
    mutationFn: () => partyApi.create({
      type: 'customer', name: f.name.trim(), gstin: f.gstin.trim().toUpperCase() || undefined, phone: f.phone.trim() || undefined,
      address: { city: f.city.trim() || undefined, stateCode: f.stateCode || undefined },
    }),
    onSuccess: (p: any) => onCreated({ id: p.id, name: p.name, gstin: p.gstin, phone: p.phone, address: p.address }),
    onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="New customer" width="md" onClose={onClose}
      footer={<>
        <button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary flex-1 justify-center" disabled={f.name.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>Save customer</button>
      </>}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><label className="label">Name *</label><input className="input" value={f.name} onChange={set('name')} autoFocus /></div>
        <div className="col-span-2"><label className="label">GSTIN</label><input className="input" maxLength={15} value={f.gstin} onChange={set('gstin')} placeholder="24AAAAA0000A1Z5" /></div>
        <div><label className="label">Phone</label><input className="input" inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => setF((p) => ({ ...p, phone: e.target.value.replace(/\D/g, '') }))} /></div>
        <div><label className="label">City</label><input className="input" value={f.city} onChange={set('city')} /></div>
        <div><label className="label">State code</label><input className="input" maxLength={2} value={f.stateCode} onChange={(e) => setF((p) => ({ ...p, stateCode: e.target.value.replace(/\D/g, '') }))} placeholder="24" /></div>
      </div>
    </Modal>
  )
}

function CopyCustomerModal({ firms, onClose, onCopied }: { firms: Array<{ id: string; name: string }>; onClose: () => void; onCopied: (p: PickedParty) => void }) {
  const [firmId, setFirmId] = useState(firms[0]?.id ?? '')
  const [search, setSearch] = useState('')
  const { data = [], isFetching } = useQuery<any[]>({ queryKey: ['firm-parties', firmId, search], queryFn: () => transportApi.firmParties(firmId, search || undefined), enabled: !!firmId })
  const copy = useMutation({
    mutationFn: (id: string) => transportApi.copyParty(id),
    onSuccess: (c: any) => { toast.success(c.copied ? `${c.name} copied` : `${c.name} was already here`); onCopied({ id: c.id, name: c.name, gstin: c.gstin }) },
    onError: (e) => toast.error(apiError(e)),
  })
  return (
    <Modal title="Copy a customer from another firm" width="md" onClose={onClose}
      footer={<button type="button" className="btn-ghost flex-1 justify-center" onClick={onClose}><X className="w-4 h-4" /> Close</button>}>
      <p className="text-xs text-gray-500 mb-3">The copy starts with a zero balance — each firm keeps its own accounts.</p>
      {firms.length > 1 && (
        <select className="input mb-2" value={firmId} onChange={(e) => setFirmId(e.target.value)}>
          {firms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
      <input className="input mb-2" placeholder="Search by name or GSTIN…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg max-h-72 overflow-y-auto">
        {isFetching && data.length === 0 ? <div className="p-4 text-sm text-gray-400 text-center">Loading…</div>
          : data.length === 0 ? <div className="p-4 text-sm text-gray-400 text-center">No customers found</div>
          : data.map((p) => (
            <button key={p.id} type="button" disabled={copy.isPending} onClick={() => copy.mutate(p.id)} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50">
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-gray-900 truncate">{p.name}</span>
                <span className="block text-xs text-gray-500">{[p.gstin, p.city].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="text-xs text-primary-600 font-medium">Copy</span>
            </button>
          ))}
      </div>
    </Modal>
  )
}
