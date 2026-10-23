// Pick the period a screen shows: a week, a month, a year (financial year, April–March) or any custom range.
// The three calendar modes have ‹ › arrows (never into the future); custom has two date boxes.
//   const period = usePeriod('month')            // { mode, from, to, label, … }
//   <PeriodBar period={period} />
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { todayIst } from '@/components/transport/format'

export type PeriodMode = 'all' | 'week' | 'month' | 'year' | 'custom'

const ms = (d: string) => new Date(`${d}T00:00:00Z`).getTime()
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10)
const addDays = (d: string, n: number) => ymd(ms(d) + n * 86_400_000)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n
  return `${y + Math.floor(m / 12)}-${String(((m % 12) + 12) % 12 + 1).padStart(2, '0')}-01`
}

/** The period of `mode` that contains `anchor`. */
export function periodOf(mode: 'week' | 'month' | 'year', anchor: string): { from: string; to: string; label: string } {
  const y = Number(anchor.slice(0, 4)), m = Number(anchor.slice(5, 7))
  if (mode === 'week') {
    const dow = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7          // Monday = 0
    const from = addDays(anchor, -dow), to = addDays(from, 6)
    const f = new Date(`${from}T00:00:00Z`), t = new Date(`${to}T00:00:00Z`)
    const sameMonth = f.getUTCMonth() === t.getUTCMonth()
    return { from, to, label: `${f.getUTCDate()}${sameMonth ? '' : ` ${MON[f.getUTCMonth()]}`} – ${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}` }
  }
  if (mode === 'month') {
    const from = `${y}-${String(m).padStart(2, '0')}-01`
    return { from, to: addDays(addMonths(from, 1), -1), label: `${MONTH[m - 1]} ${y}` }
  }
  const fy = m >= 4 ? y : y - 1
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31`, label: `FY ${fy}-${String(fy + 1).slice(2)}` }
}

/** `all` adds an "All dates" mode (from / to come back empty) — for lists that should not hide older entries by default. */
export function usePeriod(initial: PeriodMode = 'month', opts: { all?: boolean } = {}) {
  const today = todayIst()
  const [mode, setModeState] = useState<PeriodMode>(initial)
  const [anchor, setAnchor] = useState(today)
  const [custom, setCustom] = useState({ from: `${today.slice(0, 7)}-01`, to: today })

  return useMemo(() => {
    const p = mode === 'all' ? { from: '', to: '', label: 'All dates' }
      : mode === 'custom' ? { ...custom, label: `${custom.from} to ${custom.to}` }
      : periodOf(mode, anchor)
    const calendar = mode === 'week' || mode === 'month' || mode === 'year'
    const canNext = calendar && p.to < today
    const shift = (delta: number) => {
      if (mode === 'week') setAnchor(addDays(anchor, 7 * delta))
      else if (mode === 'month') setAnchor(addMonths(anchor, delta))
      else if (mode === 'year') setAnchor(addMonths(anchor, 12 * delta))
    }
    return {
      mode, setMode: (m: PeriodMode) => { setModeState(m); if (m === 'custom' && mode !== 'all') setCustom({ from: p.from, to: p.to > today ? today : p.to }) },
      from: p.from, to: p.to, label: p.label, canNext, shift, custom, setCustom, today, allowAll: !!opts.all,
    }
  }, [mode, anchor, custom, today, opts.all])
}

export type Period = ReturnType<typeof usePeriod>

const MODES: Array<[PeriodMode, string]> = [['all', 'All'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom']]

export function PeriodBar({ period }: { period: Period }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
        {MODES.filter(([k]) => k !== 'all' || period.allowAll).map(([k, l]) => (
          <button key={k} type="button" onClick={() => period.setMode(k)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${period.mode === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{l}</button>
        ))}
      </div>
      {period.mode === 'all' ? null : period.mode === 'custom' ? (
        <div className="flex items-center gap-2">
          <input type="date" className="input w-36 py-1" value={period.custom.from} max={period.custom.to}
            onChange={(e) => e.target.value && period.setCustom({ ...period.custom, from: e.target.value })} />
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input w-36 py-1" value={period.custom.to} min={period.custom.from} max={period.today}
            onChange={(e) => e.target.value && period.setCustom({ ...period.custom, to: e.target.value })} />
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => period.shift(-1)} className="btn-ghost px-2 py-1" aria-label="Previous"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-medium text-gray-700 min-w-[150px] text-center">{period.label}</span>
          <button type="button" onClick={() => period.shift(1)} disabled={!period.canNext} className="btn-ghost px-2 py-1 disabled:opacity-30" aria-label="Next"><ChevronRight className="w-4 h-4" /></button>
        </div>
      )}
    </div>
  )
}
