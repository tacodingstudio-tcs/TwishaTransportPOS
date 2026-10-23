// Shows any CA report ({ columns, rows, totals, notes, plus extra tables }) as a table, and turns it into Excel sheets.
import type { SheetSpec } from '@/lib/excel'

export type ReportRow = Record<string, string | number | null>
export interface CaReport {
  title: string; from: string; to: string; firm: { name: string; gstin: string | null }
  columns: string[]; rows: ReportRow[]; totals: Record<string, number>; notes: string[]
  summary?: ReportRow[]; mileage?: ReportRow[]; vehicleSummary?: ReportRow[]
  /** set when only the first rows were sent for the screen (`?preview=`) — the real number of rows */
  totalRows?: number; truncated?: boolean
}

/** Extra tables some reports carry, with the heading each is shown under. */
const EXTRAS: Array<[keyof CaReport, string]> = [
  ['summary', 'Summary'], ['vehicleSummary', 'By truck'], ['mileage', 'Mileage by trip'],
]

const fmtNum = (v: number, dp: number) => v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })

function columnDecimals(rows: ReportRow[], col: string): number | null {
  const vals = rows.map((r) => r[col]).filter((v) => v !== '' && v != null)
  if (!vals.length || !vals.every((v) => typeof v === 'number')) return null
  return vals.some((v) => !Number.isInteger(v as number)) ? 2 : 0
}

function Table({ title, columns, rows, totals }: { title?: string; columns: string[]; rows: ReportRow[]; totals?: Record<string, number> }) {
  const dec = columns.map((c) => columnDecimals(rows, c))
  const totalKeys = totals ? Object.keys(totals).filter((k) => columns.includes(k)) : []
  return (
    <div className="space-y-2">
      {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
      <div className="border border-gray-200 rounded-lg overflow-auto max-h-[28rem] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase sticky top-0">
            <tr>{columns.map((c, i) => <th key={c} className={`px-3 py-2 whitespace-nowrap ${dec[i] != null ? 'text-right' : 'text-left'}`}>{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.length === 0 && <tr><td className="px-3 py-6 text-center text-gray-400" colSpan={columns.length}>Nothing in this period</td></tr>}
            {rows.map((r, ri) => (
              <tr key={ri} className="hover:bg-gray-50">
                {columns.map((c, i) => {
                  const v = r[c]
                  const neg = typeof v === 'number' && v < 0
                  return (
                    <td key={c} className={`px-3 py-1.5 whitespace-nowrap ${dec[i] != null ? 'text-right tabular-nums' : ''} ${neg ? 'text-red-600' : 'text-gray-800'}`}>
                      {v == null || v === '' ? '' : typeof v === 'number' ? fmtNum(v, dec[i] ?? 2) : v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          {totalKeys.length > 0 && rows.length > 0 && (
            <tfoot className="bg-gray-50 font-semibold sticky bottom-0">
              <tr>
                {columns.map((c, i) => (
                  <td key={c} className={`px-3 py-2 whitespace-nowrap ${dec[i] != null ? 'text-right tabular-nums' : ''}`}>
                    {i === 0 && !totalKeys.includes(c) ? 'Total' : totalKeys.includes(c) ? fmtNum(totals![c]!, dec[i] ?? 2) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}

export function ReportTable({ report }: { report: CaReport }) {
  const colsOf = (rows: ReportRow[]) => Object.keys(rows[0] ?? {})
  const totalsNotInColumns = Object.entries(report.totals).filter(([k]) => !report.columns.includes(k))
  return (
    <div className="space-y-4">
      <Table columns={report.columns} rows={report.rows} totals={report.totals} />
      {report.truncated && report.totalRows != null && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Showing the first {report.rows.length.toLocaleString('en-IN')} of {report.totalRows.toLocaleString('en-IN')} rows. The totals below cover all of them; download the Excel file to get every row.
        </p>
      )}
      {totalsNotInColumns.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 text-sm bg-gray-50 rounded-lg p-3">
          {totalsNotInColumns.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3"><dt className="text-gray-500">{k}</dt><dd className="font-semibold tabular-nums">{fmtNum(v, Number.isInteger(v) ? 0 : 2)}</dd></div>
          ))}
        </dl>
      )}
      {EXTRAS.map(([key, title]) => {
        const rows = report[key] as ReportRow[] | undefined
        return rows && rows.length ? <Table key={key} title={title} columns={colsOf(rows)} rows={rows} /> : null
      })}
      {report.notes.length > 0 && <ul className="text-xs text-gray-500 list-disc pl-5 space-y-0.5">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  )
}

/** The Excel sheets for one report: the main table (with totals and notes) plus any extra tables. */
export function reportSheets(report: CaReport, name: string): SheetSpec[] {
  const heading = [`${report.title} — ${report.firm.name}${report.firm.gstin ? ` (GSTIN ${report.firm.gstin})` : ''}`, `Period: ${report.from} to ${report.to}`]
  const sheets: SheetSpec[] = [{ name, heading, columns: report.columns, rows: report.rows, totals: report.totals, notes: report.notes }]
  for (const [key, title] of EXTRAS) {
    const rows = report[key] as ReportRow[] | undefined
    if (rows?.length) sheets.push({ name: `${name} — ${title}`, heading: [`${report.title} — ${title}`, `Period: ${report.from} to ${report.to}`], rows })
  }
  return sheets
}
