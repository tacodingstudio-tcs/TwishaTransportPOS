// Quick entry — a spreadsheet-style grid to book many LRs for one customer at once
// (monthly dispatch register). Paste straight from Excel: Date, Truck, LR no, Gate pass,
// Destination, Shipment no, Load, Unload, Rate.
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Plus, Trash2, ClipboardPaste, Save } from 'lucide-react'
import { transportApi, apiError } from '@/lib/api'
import { PageHeader } from '@/components/layout/PageHeader'
import { PartyPicker, type PickedParty } from '@/components/transport/PartyPicker'
import { CityInput } from '@/components/transport/CityInput'
import { inr, todayIst, toKg, fromKg, RATE_BASIS_LABEL, WEIGHT_BASIS_LABEL, FREIGHT_TYPE_LABEL, type QtyUnit } from '@/components/transport/format'

interface Row {
  date: string; vehicleNo: string; lrNo: string; gatePassNo: string
  toCity: string; shipmentNo: string; load: string; unload: string; rate: string
}
const COLS: Array<keyof Row> = ['date', 'vehicleNo', 'lrNo', 'gatePassNo', 'toCity', 'shipmentNo', 'load', 'unload', 'rate']
const HEAD: Record<keyof Row, string> = {
  date: 'Date', vehicleNo: 'Truck no', lrNo: 'LR no', gatePassNo: 'Gate pass', toCity: 'Destination',
  shipmentNo: 'Shipment no', load: 'Load', unload: 'Unload', rate: 'Rate',
}
const WIDTH: Record<keyof Row, string> = {
  date: 'w-36', vehicleNo: 'w-32', lrNo: 'w-36', gatePassNo: 'w-32', toCity: 'w-40', shipmentNo: 'w-28', load: 'w-24', unload: 'w-24', rate: 'w-24',
}

const blank = (date = ''): Row => ({ date, vehicleNo: '', lrNo: '', gatePassNo: '', toCity: '', shipmentNo: '', load: '', unload: '', rate: '' })
const isBlank = (r: Row) => COLS.every((c) => c === 'date' || r[c].trim() === '')
const num = (v: string) => (v.trim() === '' ? 0 : Number(v.replace(/,/g, '')))
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

/** 14-08-2026 | 14/08/26 | 2026-08-14 → 2026-08-14 (empty string if unrecognised) */
function parseDate(v: string): string {
  const t = v.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t)
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return ''
}

export function QuickEntryPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [party, setParty] = useState<PickedParty>({ name: '' })
  const [fromCity, setFromCity] = useState('')
  const [goods, setGoods] = useState('')
  const [unit, setUnit] = useState<QtyUnit>('MT')
  const [rateBasis, setRateBasis] = useState('per_ton')
  const [defaultRate, setDefaultRate] = useState('')
  const [weightBasis, setWeightBasis] = useState('load')
  const [freightType, setFreightType] = useState('tbb')
  const [delivered, setDelivered] = useState(true)
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: 6 }, () => blank(todayIst())))
  const gridRef = useRef<HTMLTableElement>(null)

  const setCell = (i: number, c: keyof Row, v: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [c]: v } : r)))
  const addRow = () => setRows((rs) => [...rs, blank(rs[rs.length - 1]?.date ?? todayIst())])

  /** Pasting tab/newline-separated cells fills the grid from the focused cell. */
  function onPaste(e: React.ClipboardEvent, startRow: number, startCol: number) {
    const text = e.clipboardData.getData('text')
    if (!/[\t\n]/.test(text)) return                      // plain single value: let the input handle it
    e.preventDefault()
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
    setRows((rs) => {
      const next = [...rs]
      lines.forEach((line, li) => {
        const ri = startRow + li
        while (next.length <= ri) next.push(blank(next[next.length - 1]?.date ?? todayIst()))
        const cells = line.split('\t')
        const row = { ...next[ri]! }
        cells.forEach((cell, ci) => {
          const col = COLS[startCol + ci]
          if (!col) return
          const v = cell.trim()
          row[col] = col === 'date' ? parseDate(v) || row.date : col === 'load' || col === 'unload' || col === 'rate' ? v.replace(/,/g, '') : v
        })
        next[ri] = row
      })
      return next
    })
    toast.success(`Pasted ${lines.length} row${lines.length > 1 ? 's' : ''}`)
  }

  /** Enter moves down a row; the last row grows the grid. */
  function onKey(e: React.KeyboardEvent<HTMLInputElement>, i: number, c: number) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (i === rows.length - 1) addRow()
    setTimeout(() => {
      const inputs = gridRef.current?.querySelectorAll<HTMLInputElement>(`tbody tr:nth-child(${i + 2}) input`)
      inputs?.[c]?.focus()
    }, 0)
  }

  const calc = (r: Row) => {
    const rate = r.rate.trim() !== '' ? num(r.rate) : num(defaultRate)
    const load = toKg(num(r.load), unit)
    const unload = r.unload.trim() !== '' ? toKg(num(r.unload), unit) : null
    const kg = weightBasis === 'unload' ? (unload ?? load) : weightBasis === 'lower' ? (unload != null ? Math.min(load, unload) : load) : load
    const amount = rateBasis === 'per_ton' ? (kg / 1000) * rate : rateBasis === 'per_kg' ? kg * rate : rate
    return { rate, kg, amount: r2(amount) }
  }

  const live = rows.filter((r) => !isBlank(r))
  const totals = useMemo(() => ({
    load:   live.reduce((s, r) => s + toKg(num(r.load), unit), 0),
    unload: live.reduce((s, r) => s + (r.unload.trim() ? toKg(num(r.unload), unit) : 0), 0),
    amount: r2(live.reduce((s, r) => s + calc(r).amount, 0)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rows, unit, rateBasis, defaultRate, weightBasis])

  const save = useMutation({
    mutationFn: () => transportApi.bulkLrs({
      common: {
        consignorId: party.id, fromCity: fromCity.trim(), goodsDescription: goods.trim(),
        rateBasis, rate: num(defaultRate), weightBasis, freightType,
      },
      markDelivered: delivered,
      rows: live.map((r) => ({
        lrDate: r.date || todayIst(),
        vehicleNo: r.vehicleNo.trim() || undefined, lrNo: r.lrNo.trim() || undefined,
        gatePassNo: r.gatePassNo.trim() || undefined, shipmentNo: r.shipmentNo.trim() || undefined,
        toCity: r.toCity.trim(),
        actualWeightKg: toKg(num(r.load), unit),
        unloadWeightKg: r.unload.trim() ? toKg(num(r.unload), unit) : undefined,
        ...(r.rate.trim() ? { rate: num(r.rate) } : {}),
      })),
    }),
    onSuccess: (r: any) => {
      for (const k of ['transport-lrs', 'transport-dashboard', 'transport-bill-candidates']) qc.invalidateQueries({ queryKey: [k] })
      toast.success(`${r.count} LRs booked · ${inr(r.totalAmount)}`)
      navigate(delivered ? `/transport/billing?partyId=${party.id}` : '/transport/lrs')
    },
    onError: (e) => toast.error(apiError(e, 'Could not save the batch')),
  })

  function submit() {
    if (!party.id) return toast.error('Pick the party from your list')
    if (!fromCity.trim()) return toast.error('Enter where the goods were loaded (From)')
    if (!goods.trim()) return toast.error('Describe the goods')
    if (live.length === 0) return toast.error('Enter at least one row')
    const bad = live.findIndex((r) => !r.toCity.trim() || num(r.load) <= 0)
    if (bad >= 0) return toast.error(`Row ${rows.indexOf(live[bad]!) + 1}: destination and load quantity are required`)
    if (rateBasis !== 'fixed' && live.some((r) => calc(r).rate <= 0)) return toast.error('Every row needs a rate — fill the default rate above or the Rate column')
    save.mutate()
  }

  return (
    <div>
      <PageHeader
        title="Enter many loads"
        subtitle="Type or paste a whole month of trips of one party at once"
        action={
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => navigate('/transport/lrs')}>Cancel</button>
            <button type="button" className="btn-primary" onClick={submit} disabled={save.isPending}>
              <Save className="w-4 h-4" /> {save.isPending ? 'Saving…' : `Save ${live.length || ''} load${live.length === 1 ? '' : 's'}`}
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-5">
        <section className="card p-5 grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-2"><PartyPicker label="Party (sender)" required value={party} onChange={(p) => setParty(p.id ? p : { name: p.name })} /></div>
          <div><label className="label">Loaded from *</label><CityInput value={fromCity} onChange={setFromCity} placeholder="Kodinar" /></div>
          <div><label className="label">Goods *</label><input className="input" value={goods} onChange={(e) => setGoods(e.target.value)} placeholder="Fly ash" /></div>

          <div>
            <label className="label">Rate is</label>
            <select className="input" value={rateBasis} onChange={(e) => setRateBasis(e.target.value)}>
              {['per_ton', 'per_kg', 'fixed'].map((v) => <option key={v} value={v}>{RATE_BASIS_LABEL[v]}</option>)}
            </select>
          </div>
          <div><label className="label">Default rate (₹)</label><input type="number" min="0" step="any" className="input" value={defaultRate} onChange={(e) => setDefaultRate(e.target.value)} placeholder="per row override below" /></div>
          <div>
            <label className="label">Charge on which weight?</label>
            <select className="input" value={weightBasis} onChange={(e) => setWeightBasis(e.target.value)}>
              {['load', 'unload', 'lower'].map((v) => <option key={v} value={v}>{WEIGHT_BASIS_LABEL[v]}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Who pays freight?</label>
            <select className="input" value={freightType} onChange={(e) => setFreightType(e.target.value)}>
              {Object.entries(FREIGHT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          <label className="md:col-span-3 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} />
            These trips are already done <span className="text-gray-400">(old trips — they are saved as delivered, ready for the bill)</span>
          </label>
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="text-gray-500">Quantity unit</span>
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden" role="group" aria-label="Quantity unit">
              {(['MT', 'kg'] as const).map((u) => (
                <button key={u} type="button"
                  onClick={() => { if (u !== unit) { setRows((rs) => rs.map((r) => ({ ...r,
                    load: r.load ? String(fromKg(toKg(num(r.load), unit), u)) : '', unload: r.unload ? String(fromKg(toKg(num(r.unload), unit), u)) : '' }))); setUnit(u) } }}
                  className={`px-3 py-1.5 font-medium ${unit === u ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{u}</button>
              ))}
            </div>
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 text-sm">
            <ClipboardPaste className="w-4 h-4 text-gray-400" />
            <span className="text-gray-600">You can copy from Excel and paste into any box. Order of columns: <strong>Date, Truck, LR no, Gate pass, Destination, Shipment no, Load, Unload, Rate</strong>. Enter moves down.</span>
          </div>
          <div className="overflow-x-auto">
            <table ref={gridRef} className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-2 py-2 w-8 text-left">#</th>
                  {COLS.map((c) => (
                    <th key={c} className="px-1 py-2 text-left font-medium">{HEAD[c]}{c === 'load' || c === 'unload' ? ` (${unit})` : c === 'rate' ? ' (₹)' : ''}</th>
                  ))}
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r, i) => {
                  const blankRow = isBlank(r)
                  const c = calc(r)
                  return (
                    <tr key={i} className={blankRow ? 'opacity-70' : ''}>
                      <td className="px-2 py-1 text-xs text-gray-400">{i + 1}</td>
                      {COLS.map((col, ci) => (
                        <td key={col} className="px-1 py-1">
                          <input
                            className={`input !py-1.5 !px-2 ${WIDTH[col]} ${col === 'load' || col === 'unload' || col === 'rate' ? 'text-right' : ''}`}
                            type={col === 'date' ? 'date' : 'text'}
                            inputMode={col === 'load' || col === 'unload' || col === 'rate' ? 'decimal' : undefined}
                            value={r[col]}
                            onChange={(e) => setCell(i, col, e.target.value)}
                            onPaste={(e) => onPaste(e, i, ci)}
                            onKeyDown={(e) => onKey(e, i, ci)}
                            aria-label={`${HEAD[col]} row ${i + 1}`}
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1 text-right font-medium text-gray-900 whitespace-nowrap">{blankRow ? '' : inr(c.amount, 2)}</td>
                      <td className="px-1 py-1">
                        <button type="button" title="Remove row" className="p-1 text-gray-300 hover:text-red-600"
                          onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [blank(todayIst())]))}><Trash2 className="w-4 h-4" /></button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="bg-gray-50 text-sm font-semibold">
                <tr>
                  <td />
                  <td className="px-2 py-2" colSpan={6}>{live.length} trip{live.length === 1 ? '' : 's'}</td>
                  <td className="px-2 py-2 text-right">{fromKg(totals.load, unit).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</td>
                  <td className="px-2 py-2 text-right">{totals.unload ? fromKg(totals.unload, unit).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : ''}</td>
                  <td />
                  <td className="px-2 py-2 text-right text-primary-700">{inr(totals.amount, 2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="px-5 py-3 border-t border-gray-100">
            <button type="button" className="btn-ghost text-sm" onClick={addRow}><Plus className="w-4 h-4" /> Add row</button>
          </div>
        </section>
        <p className="text-xs text-gray-400">
          The receiver is taken as the same party. Leave LR no empty to number it automatically, or type your own number (same number twice is not allowed).
          Truck numbers that match your trucks are linked. Everything is saved together — if one row is wrong, nothing is saved and it tells you which row.
        </p>
      </div>
    </div>
  )
}
