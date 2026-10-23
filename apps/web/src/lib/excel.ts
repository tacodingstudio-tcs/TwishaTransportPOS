// Spreadsheet helpers (SheetJS): read a bank statement file, write the CA's Excel files.
// SheetJS is ~400 KB, so it is imported on first use instead of being part of the app everyone downloads.
import type * as XLSXTypes from 'xlsx'

type Xlsx = typeof XLSXTypes
const loadXlsx = (): Promise<Xlsx> => import('xlsx') as Promise<Xlsx>

/** Rows of cells from the first sheet that has any (xlsx, xls or csv). Dates stay as the file has them (serial numbers or text). */
export async function readSpreadsheet(file: File): Promise<unknown[][]> {
  const XLSX = await loadXlsx()
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: true })
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '', blankrows: true })
    if (rows.some((r) => r.some((c) => String(c ?? '').trim() !== ''))) return rows
  }
  return []
}

export interface SheetSpec {
  name: string
  rows: Array<Record<string, unknown>>
  columns?: string[]
  totals?: Record<string, number>
  notes?: string[]
  /** Free text lines above the table (title, firm, period). */
  heading?: string[]
}

const safeName = (n: string, used: Set<string>) => {
  let base = n.replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet'
  let name = base, i = 2
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${i++}`
  used.add(name.toLowerCase())
  return name
}

function toSheet(XLSX: Xlsx, spec: SheetSpec): XLSXTypes.WorkSheet {
  const cols = spec.columns ?? Object.keys(spec.rows[0] ?? {})
  const aoa: unknown[][] = []
  for (const h of spec.heading ?? []) aoa.push([h])
  if (spec.heading?.length) aoa.push([])
  const headerAt = aoa.length
  aoa.push(cols)
  for (const r of spec.rows) aoa.push(cols.map((c) => r[c] ?? ''))
  let totalsAt = -1
  if (spec.totals && Object.keys(spec.totals).length) {
    totalsAt = aoa.length
    const labelled = cols.filter((c) => c in spec.totals!)
    if (labelled.length) aoa.push(cols.map((c, i) => (i === 0 && !(c in spec.totals!) ? 'TOTAL' : c in spec.totals! ? spec.totals![c] : '')))
    else aoa.push(['TOTALS', ...Object.entries(spec.totals).flatMap(([k, v]) => [k, v])])      // totals that are not columns (e.g. GSTR-3B)
  }
  if (spec.notes?.length) { aoa.push([]); for (const n of spec.notes) aoa.push([n]) }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // column widths from the longest cell (capped); number formats per column
  ws['!cols'] = cols.map((c, ci) => {
    const longest = Math.max(String(c).length, ...spec.rows.slice(0, 400).map((r) => String(r[c] ?? '').length))
    return { wch: Math.min(60, Math.max(8, longest + 2)) }
  })
  cols.forEach((c, ci) => {
    const values = spec.rows.map((r) => r[c]).filter((v) => v !== '' && v != null)
    if (!values.length || !values.every((v) => typeof v === 'number')) return
    const fmt = values.some((v) => !Number.isInteger(v as number)) || /amount|total|tax|cgst|sgst|igst|value|received|outstanding|balance|money|rate|owed|paid|pending|tds/i.test(c) ? '#,##0.00' : '#,##0'
    const bottom = (totalsAt >= 0 ? totalsAt : headerAt + spec.rows.length)
    for (let r = headerAt + 1; r <= bottom; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: ci })]
      if (cell && typeof cell.v === 'number') cell.z = fmt
    }
  })
  ws['!freeze'] = { xSplit: 0, ySplit: headerAt + 1 } as never
  return ws
}

/** Writes an .xlsx with one sheet per spec and starts the download. */
export async function downloadWorkbook(filename: string, sheets: SheetSpec[]): Promise<void> {
  const XLSX = await loadXlsx()
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, toSheet(XLSX, s), safeName(s.name, used))
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
}

/** The workbook's bytes, for tests and previews. */
export async function workbookBytes(sheets: SheetSpec[]): Promise<Uint8Array> {
  const XLSX = await loadXlsx()
  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, toSheet(XLSX, s), safeName(s.name, used))
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array
}

/** Filesystem-safe piece of a firm name for a download name. */
export const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'firm'
