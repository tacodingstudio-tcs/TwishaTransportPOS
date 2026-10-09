// Book / edit a Lorry Receipt (consignment note) with a live freight preview.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Info, Wand2 } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { PartyPicker, type PickedParty } from '@/components/transport/PartyPicker'
import { CityInput } from '@/components/transport/CityInput'
import {
  inr, todayIst, toInputDate, fmtDate, toKg, fromKg, RATE_BASIS_LABEL, FREIGHT_TYPE_LABEL, WEIGHT_BASIS_LABEL, type QtyUnit,
} from '@/components/transport/format'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const n = (v: string) => (v === '' ? 0 : Number(v))

type Form = typeof EMPTY

/** Weight (kg) the freight is charged on — mirrors the server's computeFreight(); the server decides. */
function chargedKg(f: Form, unit: QtyUnit): number {
  const load = toKg(n(f.loadQty), unit)
  const unload = n(f.unloadQty) > 0 ? toKg(n(f.unloadQty), unit) : null
  switch (f.weightBasis) {
    case 'load':   return load
    case 'unload': return unload ?? load
    case 'lower':  return unload != null ? Math.min(load, unload) : load
    default:       return n(f.chargedQty) > 0 ? toKg(n(f.chargedQty), unit) : load
  }
}

function previewFreight(f: Form, unit: QtyUnit) {
  const kg = chargedKg(f, unit)
  switch (f.rateBasis) {
    case 'per_ton': return r2((kg / 1000) * n(f.rate))
    case 'per_kg':  return r2(kg * n(f.rate))
    case 'per_pkg': return r2(n(f.packages) * n(f.rate))
    default:        return r2(f.freight !== '' ? n(f.freight) : n(f.rate))
  }
}

const EMPTY = {
  lrNo: '', lrDate: todayIst(), fromCity: '', toCity: '', goodsDescription: '', packages: '', packageType: '',
  loadQty: '', unloadQty: '', chargedQty: '', weightBasis: 'manual', declaredValue: '', invoiceRefs: '',
  gatePassNo: '', shipmentNo: '', ewayBillNo: '', ewayValidUpto: '',
  freightType: 'tbb', rateBasis: 'per_ton', rate: '', freight: '',
  loading: '', unloading: '', detention: '', other: '', advance: '', remarks: '', tripId: '',
  consignorGstin: '', consignorPhone: '', consignorAddress: '', consigneeGstin: '', consigneePhone: '', consigneeAddress: '',
}

const addr = (a: any): string => (a ? [a.line1, a.city, a.state, a.pincode].filter(Boolean).join(', ') : '')
const show = (kg: number, unit: QtyUnit) => (kg ? String(fromKg(kg, unit)) : '')

export function LrFormPage() {
  const { id } = useParams<{ id: string }>()
  const editing = !!id
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [f, setF] = useState<Form>(EMPTY)
  const [unit, setUnit] = useState<QtyUnit>('MT')
  const [consignor, setConsignor] = useState<PickedParty>({ name: '' })
  const [consignee, setConsignee] = useState<PickedParty>({ name: '' })
  const [distance, setDistance] = useState('')

  const set = (k: keyof Form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }))

  /** Switch the quantity unit and convert whatever is already typed. */
  function changeUnit(next: QtyUnit) {
    if (next === unit) return
    const conv = (v: string) => (v === '' ? '' : String(fromKg(toKg(Number(v), unit), next)))
    setF((p) => ({ ...p, loadQty: conv(p.loadQty), unloadQty: conv(p.unloadQty), chargedQty: conv(p.chargedQty) }))
    setUnit(next)
  }

  // ── edit mode: load the LR ────────────────────────────────────────────────
  const { data: existing } = useQuery({
    queryKey: ['transport-lr', id], queryFn: () => transportApi.getLr(id!), enabled: editing,
  })
  useEffect(() => {
    if (!existing) return
    const u: QtyUnit = existing.rateBasis === 'per_ton' ? 'MT' : 'kg'
    setUnit(u)
    setF({
      lrNo: existing.lrNo, lrDate: toInputDate(existing.lrDate), fromCity: existing.fromCity, toCity: existing.toCity,
      goodsDescription: existing.goodsDescription, packages: String(existing.packages || ''), packageType: existing.packageType ?? '',
      loadQty: show(Number(existing.actualWeightKg), u),
      unloadQty: existing.unloadWeightKg != null ? show(Number(existing.unloadWeightKg), u) : '',
      chargedQty: show(Number(existing.chargedWeightKg), u), weightBasis: existing.weightBasis ?? 'manual',
      declaredValue: String(existing.declaredValue || ''), invoiceRefs: existing.invoiceRefs ?? '',
      gatePassNo: existing.gatePassNo ?? '', shipmentNo: existing.shipmentNo ?? '',
      ewayBillNo: existing.ewayBillNo ?? '',
      ewayValidUpto: existing.ewayValidUpto ? new Date(existing.ewayValidUpto).toISOString().slice(0, 16) : '',
      freightType: existing.freightType, rateBasis: existing.rateBasis, rate: String(existing.rate || ''),
      freight: existing.rateBasis === 'fixed' ? String(existing.freightAmount || '') : '',
      loading: String(existing.loadingCharges || ''), unloading: String(existing.unloadingCharges || ''),
      detention: String(existing.detentionCharges || ''), other: String(existing.otherCharges || ''),
      advance: String(existing.advancePaid || ''), remarks: existing.remarks ?? '', tripId: '',
      consignorGstin: existing.consignorGstin ?? '', consignorPhone: existing.consignorPhone ?? '', consignorAddress: existing.consignorAddress ?? '',
      consigneeGstin: existing.consigneeGstin ?? '', consigneePhone: existing.consigneePhone ?? '', consigneeAddress: existing.consigneeAddress ?? '',
    })
    setConsignor({ id: existing.consignorId ?? undefined, name: existing.consignorName, gstin: existing.consignorGstin, phone: existing.consignorPhone })
    setConsignee({ id: existing.consigneeId ?? undefined, name: existing.consigneeName, gstin: existing.consigneeGstin, phone: existing.consigneePhone })
  }, [existing])

  // ── rate-card lookup ──────────────────────────────────────────────────────
  const canLookup = f.fromCity.trim().length > 1 && f.toCity.trim().length > 1
  const { data: ratecard } = useQuery({
    queryKey: ['transport-rate-lookup', f.fromCity, f.toCity, consignor.id],
    queryFn:  () => transportApi.lookupRoute({ from: f.fromCity.trim(), to: f.toCity.trim(), partyId: consignor.id }),
    enabled:  canLookup && !editing,
  })

  // ── open trips to attach to (new LRs only) ───────────────────────────────
  const { data: openTrips } = useQuery({
    queryKey: ['transport-trips-open'],
    queryFn:  () => transportApi.listTrips({ status: 'planned,running', limit: 50 }),
    enabled:  !editing,
  })

  const freight = useMemo(() => previewFreight(f, unit), [f, unit])
  const charged = chargedKg(f, unit)
  const shortageKg = n(f.unloadQty) > 0 ? toKg(n(f.loadQty), unit) - toKg(n(f.unloadQty), unit) : 0
  const total = r2(freight + n(f.loading) + n(f.unloading) + n(f.detention) + n(f.other))
  const balance = r2(total - n(f.advance))

  const ewayLimit = 50000
  const needsEway = n(f.declaredValue) > ewayLimit && !f.ewayBillNo.trim()

  const save = useMutation({
    mutationFn: (body: any) => (editing ? transportApi.updateLr(id!, body) : transportApi.createLr(body)),
    onSuccess: (lr: any) => {
      qc.invalidateQueries({ queryKey: ['transport-lrs'] })
      qc.invalidateQueries({ queryKey: ['transport-dashboard'] })
      qc.invalidateQueries({ queryKey: ['transport-lr', lr.id] })
      toast.success(editing ? 'LR updated' : `LR ${lr.lrNo} booked`)
      for (const w of lr.warnings ?? []) toast(w, { icon: '⚠️', duration: 6000 })
      navigate(`/transport/lrs/${lr.id}`)
    },
    onError: (e) => toast.error(apiError(e, 'Could not save the LR')),
  })

  const calcEway = useMutation({
    mutationFn: () => transportApi.ewayValidity({ distanceKm: Number(distance), from: new Date().toISOString() }),
    onSuccess: (r: any) => {
      setF((p) => ({ ...p, ewayValidUpto: new Date(r.validUpto).toISOString().slice(0, 16) }))
      toast.success(`Validity ${r.days} day${r.days > 1 ? 's' : ''} (${r.kmPerDay} km/day)`)
    },
    onError: (e) => toast.error(apiError(e)),
  })

  function applyRateCard() {
    if (!ratecard) return
    const basis = ratecard.rateBasis === 'per_km' ? 'fixed' : ratecard.rateBasis
    setF((p) => ({ ...p, rateBasis: basis, rate: String(ratecard.rate) }))
    if (basis === 'per_ton') changeUnit('MT')
    if (ratecard.distanceKm) setDistance(String(ratecard.distanceKm))
    toast.success('Rate card applied')
  }

  function submit() {
    if (!consignor.name.trim()) return toast.error('Consignor is required')
    if (!consignee.name.trim()) return toast.error('Consignee is required')
    if (!f.fromCity.trim() || !f.toCity.trim()) return toast.error('From and To cities are required')
    if (!f.goodsDescription.trim()) return toast.error('Describe the goods')
    if (n(f.advance) > total) return toast.error('Advance cannot exceed the total freight')
    if (f.weightBasis === 'unload' && n(f.unloadQty) <= 0 && !editing) {
      toast('Freight will use the load quantity until the unload quantity is recorded at delivery.', { icon: 'ℹ️' })
    }

    save.mutate({
      ...(f.lrNo.trim() && (!editing || f.lrNo.trim() !== existing?.lrNo) ? { lrNo: f.lrNo.trim() } : {}),
      lrDate: f.lrDate || undefined,
      consignorId: consignor.id ?? null, consignorName: consignor.name.trim(),
      consignorGstin: (consignor.id ? undefined : f.consignorGstin) || undefined,
      consignorPhone: (consignor.id ? undefined : f.consignorPhone) || undefined,
      consignorAddress: (consignor.id ? undefined : f.consignorAddress) || undefined,
      consigneeId: consignee.id ?? null, consigneeName: consignee.name.trim(),
      consigneeGstin: (consignee.id ? undefined : f.consigneeGstin) || undefined,
      consigneePhone: (consignee.id ? undefined : f.consigneePhone) || undefined,
      consigneeAddress: (consignee.id ? undefined : f.consigneeAddress) || undefined,
      fromCity: f.fromCity.trim(), toCity: f.toCity.trim(),
      goodsDescription: f.goodsDescription.trim(), packages: n(f.packages), packageType: f.packageType || undefined,
      actualWeightKg: toKg(n(f.loadQty), unit),
      unloadWeightKg: f.unloadQty === '' ? (editing ? null : undefined) : toKg(n(f.unloadQty), unit),
      chargedWeightKg: f.weightBasis === 'manual' && f.chargedQty !== '' ? toKg(n(f.chargedQty), unit) : undefined,
      weightBasis: f.weightBasis,
      gatePassNo: f.gatePassNo.trim() || undefined, shipmentNo: f.shipmentNo.trim() || undefined,
      declaredValue: n(f.declaredValue), invoiceRefs: f.invoiceRefs || undefined,
      ewayBillNo: f.ewayBillNo.trim() || undefined,
      ewayValidUpto: f.ewayValidUpto ? new Date(f.ewayValidUpto).toISOString() : undefined,
      freightType: f.freightType, rateBasis: f.rateBasis, rate: n(f.rate),
      freightAmount: f.rateBasis === 'fixed' ? (f.freight !== '' ? n(f.freight) : n(f.rate)) : undefined,
      loadingCharges: n(f.loading), unloadingCharges: n(f.unloading), detentionCharges: n(f.detention), otherCharges: n(f.other),
      advancePaid: n(f.advance), remarks: f.remarks || undefined,
      ...(editing || !f.tripId ? {} : { tripId: f.tripId }),
    })
  }

  return (
    <div>
      <PageHeader
        title={editing ? `Edit ${existing?.lrNo ?? 'LR'}` : 'New Load (LR)'}
        subtitle={editing ? 'A load that has a bill (or is cancelled) cannot be changed' : 'Fill the details and tap Book. Leave LR number empty and it will be numbered for you'}
        action={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => navigate(-1)}>Cancel</button>
            <button type="button" className="btn-primary" onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Save load'}
            </button>
          </div>
        }
      />

      <div className="p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">

          {/* Parties */}
          <section className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Parties</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <PartyPicker label="Sender (party sending the goods)" required value={consignor} onChange={setConsignor} />
                {!consignor.id && consignor.name && (
                  <div className="grid grid-cols-2 gap-2">
                    <input className="input" placeholder="GSTIN" value={f.consignorGstin} onChange={set('consignorGstin')} />
                    <input className="input" placeholder="Phone" value={f.consignorPhone} onChange={set('consignorPhone')} />
                    <input className="input col-span-2" placeholder="Address" value={f.consignorAddress} onChange={set('consignorAddress')} />
                  </div>
                )}
                {consignor.id && <p className="text-xs text-gray-400">{addr(consignor.address)}</p>}
              </div>
              <div className="space-y-3">
                <PartyPicker label="Receiver (party getting the goods)" required value={consignee} onChange={setConsignee} />
                {!consignee.id && consignee.name && (
                  <div className="grid grid-cols-2 gap-2">
                    <input className="input" placeholder="GSTIN" value={f.consigneeGstin} onChange={set('consigneeGstin')} />
                    <input className="input" placeholder="Phone" value={f.consigneePhone} onChange={set('consigneePhone')} />
                    <input className="input col-span-2" placeholder="Address" value={f.consigneeAddress} onChange={set('consigneeAddress')} />
                  </div>
                )}
                {consignee.id && <p className="text-xs text-gray-400">{addr(consignee.address)}</p>}
              </div>
            </div>
          </section>

          {/* Route + goods */}
          <section className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Where from, where to & what goods</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><label className="label">LR number (optional)</label><input className="input" value={f.lrNo} onChange={set('lrNo')} placeholder="Auto" maxLength={30} /></div>
              <div><label className="label">Date</label><input type="date" className="input" value={f.lrDate} onChange={set('lrDate')} /></div>
              <div><label className="label">From *</label><CityInput value={f.fromCity} onChange={(v) => setF((p) => ({ ...p, fromCity: v }))} placeholder="Surat" /></div>
              <div><label className="label">To *</label><CityInput value={f.toCity} onChange={(v) => setF((p) => ({ ...p, toCity: v }))} placeholder="Mumbai" /></div>
              <div className="col-span-2 md:col-span-3">
                <label className="label">Goods description *</label>
                <input className="input" value={f.goodsDescription} onChange={set('goodsDescription')} placeholder="e.g. Fly ash, Grey fabric rolls" />
              </div>
              <div>
                <label className="label">Truck trip (optional)</label>
                <select className="input" value={f.tripId} onChange={set('tripId')} disabled={editing}>
                  <option value="">Give a truck later</option>
                  {(openTrips?.data ?? []).map((t: any) => (
                    <option key={t.id} value={t.id}>{t.tripNo} · {t.vehicleNo} · {t.fromCity}→{t.toCity}</option>
                  ))}
                </select>
              </div>
              <div><label className="label">Gate pass no (optional)</label><input className="input" value={f.gatePassNo} onChange={set('gatePassNo')} maxLength={40} /></div>
              <div><label className="label">Shipment / DO no (optional)</label><input className="input" value={f.shipmentNo} onChange={set('shipmentNo')} maxLength={40} /></div>
              <div className="col-span-2"><label className="label">Sender's bill no (optional)</label><input className="input" value={f.invoiceRefs} onChange={set('invoiceRefs')} placeholder="INV/2041, INV/2042" /></div>
            </div>
          </section>

          {/* Quantity */}
          <section className="card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Quantity</h2>
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs" role="group" aria-label="Quantity unit">
                {(['MT', 'kg'] as const).map((u) => (
                  <button key={u} type="button" onClick={() => changeUnit(u)}
                    className={`px-3 py-1.5 font-medium ${unit === u ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{u}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div><label className="label">Quantity loaded ({unit})</label><input type="number" min="0" step="any" className="input" value={f.loadQty} onChange={set('loadQty')} /></div>
              <div><label className="label">Quantity received ({unit})</label><input type="number" min="0" step="any" className="input" value={f.unloadQty} onChange={set('unloadQty')} placeholder="after delivery" /></div>
              <div className="col-span-2">
                <label className="label">Charge freight on which weight?</label>
                <select className="input" value={f.weightBasis} onChange={set('weightBasis')}>
                  {Object.entries(WEIGHT_BASIS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {f.weightBasis === 'manual' && (
                <div><label className="label">Quantity to charge ({unit})</label><input type="number" min="0" step="any" className="input" value={f.chargedQty} onChange={set('chargedQty')} placeholder="= load" /></div>
              )}
              <div><label className="label">Packages</label><input type="number" min="0" className="input" value={f.packages} onChange={set('packages')} /></div>
              <div><label className="label">Package type</label><input className="input" value={f.packageType} onChange={set('packageType')} placeholder="Bales / Cartons" /></div>
              <div><label className="label">Value of goods (₹)</label><input type="number" min="0" className="input" value={f.declaredValue} onChange={set('declaredValue')} /></div>
            </div>
            {shortageKg !== 0 && (
              <p className={`text-xs rounded-lg px-3 py-2 border ${shortageKg > 0 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-blue-50 border-blue-100 text-blue-800'}`}>
                {shortageKg > 0 ? 'Short by' : 'Extra'} {Math.abs(fromKg(shortageKg, unit))} {unit} (loaded vs received).
                {f.weightBasis === 'manual' || f.weightBasis === 'load' ? ' Freight is charged on the load quantity.' : ''}
              </p>
            )}
          </section>

          {/* E-way */}
          <section className="card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">E-way bill</h2>
            {needsEway && (
              <div className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                Consignment value is above ₹{ewayLimit.toLocaleString('en-IN')} — an e-way bill is needed before the vehicle moves.
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div className="md:col-span-1"><label className="label">E-way bill no</label><input className="input" value={f.ewayBillNo} onChange={set('ewayBillNo')} maxLength={12} /></div>
              <div className="md:col-span-1"><label className="label">Valid till</label><input type="datetime-local" className="input" value={f.ewayValidUpto} onChange={set('ewayValidUpto')} /></div>
              <div className="md:col-span-1"><label className="label">Distance (km) — to find e-way validity</label><input type="number" min="0" className="input" value={distance} onChange={(e) => setDistance(e.target.value)} /></div>
              <button type="button" className="btn-ghost justify-center" disabled={!distance || calcEway.isPending} onClick={() => calcEway.mutate()}>
                <Wand2 className="w-4 h-4" /> Find validity
              </button>
            </div>
            <p className="text-xs text-gray-400">Validity: 1 day per 200 km (100 km for over-dimensional cargo). Always confirm against the e-way bill portal.</p>
          </section>

          {/* Freight */}
          <section className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Freight (bhada)</h2>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(FREIGHT_TYPE_LABEL).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setF((p) => ({ ...p, freightType: v }))}
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    f.freightType === v ? 'bg-primary-50 border-primary-300 text-primary-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}>{label}</button>
              ))}
            </div>
            {ratecard && !editing && (
              <div className="flex items-center justify-between gap-3 text-sm bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                <span className="text-blue-800">
                  Your usual rate: <strong>{inr(ratecard.rate)}</strong> {RATE_BASIS_LABEL[ratecard.rateBasis]?.toLowerCase()}
                  {ratecard.distanceKm ? ` · ${ratecard.distanceKm} km` : ''}{ratecard.partyId ? ' · party rate' : ''}
                </span>
                <button type="button" className="text-blue-700 font-medium hover:underline" onClick={applyRateCard}>Apply</button>
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="label">Rate is</label>
                <select className="input" value={f.rateBasis} onChange={set('rateBasis')}>
                  {['per_ton', 'per_kg', 'per_pkg', 'fixed'].map((v) => <option key={v} value={v}>{RATE_BASIS_LABEL[v]}</option>)}
                </select>
              </div>
              <div><label className="label">Rate (₹)</label><input type="number" min="0" step="any" className="input" value={f.rate} onChange={set('rate')} /></div>
              {f.rateBasis === 'fixed' && (
                <div><label className="label">Freight (₹)</label><input type="number" min="0" className="input" value={f.freight} onChange={set('freight')} placeholder="= rate" /></div>
              )}
              <div><label className="label">Loading (₹)</label><input type="number" min="0" className="input" value={f.loading} onChange={set('loading')} /></div>
              <div><label className="label">Unloading (₹)</label><input type="number" min="0" className="input" value={f.unloading} onChange={set('unloading')} /></div>
              <div><label className="label">Waiting charges (₹)</label><input type="number" min="0" className="input" value={f.detention} onChange={set('detention')} /></div>
              <div><label className="label">Other (₹)</label><input type="number" min="0" className="input" value={f.other} onChange={set('other')} /></div>
              <div><label className="label">Advance received (₹)</label><input type="number" min="0" className="input" value={f.advance} onChange={set('advance')} /></div>
            </div>
            <div><label className="label">Remarks</label><textarea className="input h-16 resize-none" value={f.remarks} onChange={set('remarks')} /></div>
          </section>
        </div>

        {/* Live summary */}
        <aside className="xl:col-span-1">
          <div className="card p-5 xl:sticky xl:top-24 space-y-3">
            <h2 className="text-sm font-semibold text-gray-900">Amount summary</h2>
            <dl className="text-sm space-y-2">
              {f.rateBasis !== 'fixed' && f.rateBasis !== 'per_pkg' && (
                <div className="flex justify-between text-xs text-gray-500">
                  <dt>Charged on</dt><dd>{unit === 'MT' ? `${fromKg(charged, 'MT')} MT` : `${charged} kg`} × {inr(n(f.rate), 2)}</dd>
                </div>
              )}
              <div className="flex justify-between"><dt className="text-gray-500">Freight</dt><dd>{inr(freight, 2)}</dd></div>
              {n(f.loading) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Loading</dt><dd>{inr(n(f.loading), 2)}</dd></div>}
              {n(f.unloading) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Unloading</dt><dd>{inr(n(f.unloading), 2)}</dd></div>}
              {n(f.detention) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Waiting charges</dt><dd>{inr(n(f.detention), 2)}</dd></div>}
              {n(f.other) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Other</dt><dd>{inr(n(f.other), 2)}</dd></div>}
              <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold text-gray-900">
                <dt>Total (before GST)</dt><dd>{inr(total, 2)}</dd>
              </div>
              {n(f.advance) > 0 && <div className="flex justify-between"><dt className="text-gray-500">Advance</dt><dd>− {inr(n(f.advance), 2)}</dd></div>}
              <div className={`flex justify-between font-semibold ${balance < 0 ? 'text-red-600' : 'text-primary-700'}`}>
                <dt>{f.freightType === 'to_pay' ? 'Receiver will pay' : 'Balance'}</dt><dd>{inr(balance, 2)}</dd>
              </div>
            </dl>
            <p className="text-xs text-gray-400">
              GST is added later, when you make the bill. The amount is checked again when you save.
            </p>
            {editing && existing && <p className="text-xs text-gray-400">Booked {fmtDate(existing.lrDate)}</p>}
          </div>
        </aside>
      </div>
    </div>
  )
}
