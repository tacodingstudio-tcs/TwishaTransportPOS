// apps/api/src/lib/transport-pdf.ts
// Server-side PDFs for the transport module: the consignment note (LR) and the GST freight bill.
//
// Pure-JS (pdfkit) on purpose: the production image has no Chromium, and a headless browser is far
// too heavy for a small hosting plan. Output is a Buffer, so the same bytes can be streamed to the
// browser, attached to a WhatsApp message or stored.
//
// pdfkit's built-in fonts have no ₹ glyph, so amounts are printed as "Rs." — a standard convention
// on Indian transport paperwork.

import PDFDocument from 'pdfkit'
import { BILL_LAYOUT, type TaxInvoiceView } from '@billing/shared'

export interface BusinessHeader {
  name: string
  address?: string | null
  gstin?: string | null
  phone?: string | null
}

const INK = '#111827'
const MUTED = '#6B7280'
const LINE = '#9CA3AF'

const rs = (n: unknown, dp = 2): string =>
  `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
const num = (n: unknown): string => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const date = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}
const dateTime = (v: unknown): string => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return String(v)
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

const FREIGHT_LABEL: Record<string, string> = { paid: 'Paid', to_pay: 'To Pay', tbb: 'To be billed' }
const BASIS_LABEL: Record<string, string> = { fixed: 'Fixed', per_ton: 'Per ton', per_kg: 'Per kg', per_pkg: 'Per package' }

/** "Powered by Twisha Consultancy Services · https://…" — same default and env overrides as the screens. */
const POWERED_BY = `Powered by ${process.env['POWERED_BY_NAME'] || 'Twisha Consultancy Services'} · ${process.env['POWERED_BY_URL'] || 'https://www.twishaconsultancyservices.com/'}`

/** One small grey line centred at the foot of the page, inside the bottom margin (so it never starts a new page). */
function creditLine(doc: PDFKit.PDFDocument, y = doc.page.height - 16): void {
  const m = doc.page.margins.bottom
  doc.page.margins.bottom = 0
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(6.5).text(POWERED_BY, 0, y, { width: doc.page.width, align: 'center', lineBreak: false })
  doc.page.margins.bottom = m
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}

/** A bordered cell with a small caption and a value, returns nothing (fixed height). */
function cell(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, label: string, value: string, bold = false) {
  doc.lineWidth(0.5).strokeColor(LINE).rect(x, y, w, h).stroke()
  doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text(label.toUpperCase(), x + 4, y + 3, { width: w - 8, lineBreak: false })
  doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .text(value || '', x + 4, y + 13, { width: w - 8, height: h - 15, ellipsis: true })
}

function letterhead(doc: PDFKit.PDFDocument, biz: BusinessHeader, title: string, subtitle: string, x: number, y: number, w: number): number {
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(biz.name, x, y, { width: w * 0.6 })
  let ly = y + 19
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  if (biz.address) { doc.text(biz.address, x, ly, { width: w * 0.6 }); ly = doc.y }
  const meta = [biz.gstin && `GSTIN: ${biz.gstin}`, biz.phone && `Ph: ${biz.phone}`].filter(Boolean).join('   ')
  if (meta) { doc.text(meta, x, ly, { width: w * 0.6 }); ly = doc.y }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), x + w * 0.6, y, { width: w * 0.4, align: 'right' })
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(subtitle, x + w * 0.6, y + 14, { width: w * 0.4, align: 'right' })
  const bottom = Math.max(ly, y + 30) + 4
  doc.lineWidth(1.5).strokeColor(INK).moveTo(x, bottom).lineTo(x + w, bottom).stroke()
  return bottom + 6
}

// ══════════════════════════════════════════════════════════════════════════════
// Lorry receipt
// ══════════════════════════════════════════════════════════════════════════════

const LR_TERMS = [
  'Goods are accepted for carriage at owner\'s risk unless insured; the carrier is not liable for leakage, breakage or damage from natural causes.',
  'Freight, detention and demurrage are payable as stated above. Goods may be retained until all dues are cleared.',
  'The consignee must record any shortage or damage on this receipt at the time of delivery.',
  'Subject to jurisdiction of the carrier\'s city courts.',
]

/** One page per copy (consignor / consignee / driver). Pass a single copy for a customer-facing PDF. */
export async function renderLrPdf(lr: any, biz: BusinessHeader, copies: string[] = ['Consignor copy', 'Consignee copy', 'Driver copy']): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `LR ${lr.lrNo}`, Author: biz.name } })
  const done = collect(doc)
  const X = 30, W = doc.page.width - 60

  copies.forEach((copy, idx) => {
    if (idx > 0) doc.addPage()
    let y = letterhead(doc, biz, 'Consignment Note', `(Lorry Receipt) — ${copy}`, X, 30, W)

    const q = W / 4
    cell(doc, X, y, q, 30, 'LR No.', lr.lrNo, true)
    cell(doc, X + q, y, q, 30, 'Date', date(lr.lrDate))
    cell(doc, X + q * 2, y, q, 30, 'From', lr.fromCity)
    cell(doc, X + q * 3, y, q, 30, 'To', lr.toCity)
    y += 30

    cell(doc, X, y, W / 2, 62, 'Consignor',
      [lr.consignorName, lr.consignorAddress, [lr.consignorGstin && `GSTIN ${lr.consignorGstin}`, lr.consignorPhone].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), false)
    cell(doc, X + W / 2, y, W / 2, 62, 'Consignee',
      [lr.consigneeName, lr.consigneeAddress, [lr.consigneeGstin && `GSTIN ${lr.consigneeGstin}`, lr.consigneePhone].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), false)
    y += 62

    cell(doc, X, y, q, 30, 'Vehicle No.', lr.vehicleNo ?? '', true)
    cell(doc, X + q, y, q, 30, 'Driver', lr.driverName ?? '')
    cell(doc, X + q * 2, y, q, 30, 'E-way bill no.', lr.ewayBillNo ?? '')
    cell(doc, X + q * 3, y, q, 30, 'E-way valid upto', lr.ewayValidUpto ? dateTime(lr.ewayValidUpto) : '')
    y += 30

    // Goods table
    const cols = [60, W - 60 - 80 - 80 - 90, 80, 80, 90]
    const heads = ['Packages', 'Description of goods', 'Actual wt (kg)', 'Charged wt (kg)', 'Declared value']
    let cx = X
    doc.rect(X, y, W, 16).fillAndStroke('#F3F4F6', LINE)
    heads.forEach((h, i) => {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(h.toUpperCase(), cx + 4, y + 5, { width: cols[i]! - 8, align: i >= 2 ? 'right' : 'left', lineBreak: false })
      cx += cols[i]!
    })
    y += 16
    const rowH = 54
    doc.lineWidth(0.5).strokeColor(LINE).rect(X, y, W, rowH).stroke()
    const vals = [
      lr.packages ? `${num(lr.packages)} ${lr.packageType ?? ''}`.trim() : '',
      [lr.goodsDescription, lr.invoiceRefs && `Invoice(s): ${lr.invoiceRefs}`].filter(Boolean).join('\n'),
      num(lr.actualWeightKg), num(lr.chargedWeightKg),
      Number(lr.declaredValue) > 0 ? rs(lr.declaredValue, 0) : '',
    ]
    cx = X
    vals.forEach((v, i) => {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(v, cx + 4, y + 5, { width: cols[i]! - 8, height: rowH - 8, align: i >= 2 ? 'right' : 'left' })
      cx += cols[i]!
    })
    y += rowH

    // Freight panel
    const panelH = 92
    const leftW = W * 0.62
    doc.lineWidth(0.5).strokeColor(LINE).rect(X, y, leftW, panelH).stroke().rect(X + leftW, y, W - leftW, panelH).stroke()
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text('FREIGHT BASIS', X + 6, y + 5)
    ;(['paid', 'to_pay', 'tbb'] as const).forEach((t, i) => {
      const bx = X + 6 + i * 92
      doc.lineWidth(0.8).strokeColor(INK).rect(bx, y + 18, 8, 8).stroke()
      if (lr.freightType === t) doc.rect(bx + 1.5, y + 19.5, 5, 5).fill(INK)
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(FREIGHT_LABEL[t]!, bx + 13, y + 17, { lineBreak: false })
    })
    doc.fillColor(MUTED).fontSize(7).text('GST, where applicable, is charged on the freight bill / payable by the recipient under reverse charge.', X + 6, y + 36, { width: leftW - 12 })
    if (lr.remarks) doc.fillColor(INK).fontSize(8).text(`Remarks: ${lr.remarks}`, X + 6, y + 58, { width: leftW - 12, height: 30 })

    const charges: Array<[string, number]> = [
      [`Freight (${BASIS_LABEL[lr.rateBasis] ?? lr.rateBasis}${lr.rateBasis !== 'fixed' ? ` @ ${rs(lr.rate, 2)}` : ''})`, Number(lr.freightAmount)],
      ['Loading', Number(lr.loadingCharges)], ['Unloading', Number(lr.unloadingCharges)],
      ['Detention', Number(lr.detentionCharges)], ['Other', Number(lr.otherCharges)],
    ]
    let py = y + 5
    const px = X + leftW + 6, pw = W - leftW - 12
    charges.filter(([, v], i) => i === 0 || v > 0).forEach(([label, v]) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label, px, py, { width: pw * 0.62, lineBreak: false })
      doc.fillColor(INK).text(rs(v), px, py, { width: pw, align: 'right', lineBreak: false })
      py += 11
    })
    doc.lineWidth(0.5).strokeColor(LINE).moveTo(px, py + 1).lineTo(px + pw, py + 1).stroke()
    py += 4
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text('Total', px, py, { lineBreak: false })
    doc.text(rs(lr.totalAmount), px, py, { width: pw, align: 'right', lineBreak: false })
    py += 12
    if (Number(lr.advancePaid) > 0) {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Advance', px, py, { lineBreak: false })
      doc.fillColor(INK).text(`- ${rs(lr.advancePaid)}`, px, py, { width: pw, align: 'right', lineBreak: false })
      py += 11
    }
    if (lr.freightType === 'to_pay') {
      const bal = Number(lr.totalAmount) - Number(lr.advancePaid)
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('To pay', px, py, { lineBreak: false })
      doc.text(rs(bal), px, py, { width: pw, align: 'right', lineBreak: false })
    }
    y += panelH + 8

    // Terms
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('TERMS', X, y)
    doc.font('Helvetica').fontSize(7)
    LR_TERMS.forEach((t, i) => doc.text(`${i + 1}. ${t}`, X, doc.y + 1, { width: W }))
    y = doc.y + 24

    // Signatures
    const sw = W / 3
    ;['Consignor / Booking clerk', 'Driver', 'Receiver (name, date & signature)'].forEach((s, i) => {
      const sx = X + i * sw
      doc.lineWidth(0.5).strokeColor(INK).moveTo(sx + 8, y).lineTo(sx + sw - 8, y).stroke()
      doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(s, sx + 8, y + 3, { width: sw - 16, align: 'center' })
    })
    creditLine(doc)
  })

  doc.end()
  return done
}

// ══════════════════════════════════════════════════════════════════════════════
// Freight bill (GST invoice with one row per LR)
// ══════════════════════════════════════════════════════════════════════════════

export interface FreightBillData {
  number: string
  date: unknown
  dueDate?: unknown
  status: string
  partyName: string
  partyGstin?: string | null
  partyAddress?: string | null
  gstMode?: string | null
  isInterState: boolean
  subtotal: number
  cgstTotal: number
  sgstTotal: number
  igstTotal: number
  roundOff: number
  grandTotal: number
  paidAmt: number
  tdsAmount: number
  notes?: string | null
  terms?: string[]
  lines: Array<{
    lrNo: string; lrDate: unknown; vehicleNo?: string | null; route: string; goods?: string | null
    weightKg?: number | null; amount: number; sac?: string | null; gatePassNo?: string | null
  }>
}

export async function renderFreightBillPdf(b: FreightBillData, biz: BusinessHeader): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: `Freight bill ${b.number}`, Author: biz.name } })
  const done = collect(doc)
  drawFreightBill(doc, b, biz)
  doc.end()
  return done
}

/** The freight statement (one row per LR) drawn from the current page of `doc`. */
function drawFreightBill(doc: PDFKit.PDFDocument, b: FreightBillData, biz: BusinessHeader, annexure = false): void {
  const X = 30, W = doc.page.width - 60
  const pageBottom = () => doc.page.height - 40

  const sac = b.lines.find((l) => l.sac)?.sac ?? '996791'
  let y = annexure
    ? letterhead(doc, biz, 'Statement of loads', `Annexure to invoice ${b.number} — goods transport service, SAC ${sac}`, X, 30, W)
    : letterhead(doc, biz, b.gstMode === 'rcm' || b.gstMode === 'exempt' ? 'Freight Bill' : 'Tax Invoice',
      `Goods transport agency service — SAC ${sac}`, X, 30, W)

  // Bill-to / meta
  doc.lineWidth(0.5).strokeColor(LINE).rect(X, y, W * 0.6, 70).stroke().rect(X + W * 0.6, y, W * 0.4, 70).stroke()
  doc.fillColor(MUTED).font('Helvetica').fontSize(6.5).text('BILL TO', X + 5, y + 4)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(b.partyName, X + 5, y + 14, { width: W * 0.6 - 10 })
  doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  if (b.partyAddress) doc.text(b.partyAddress, X + 5, doc.y, { width: W * 0.6 - 10 })
  if (b.partyGstin) doc.text(`GSTIN: ${b.partyGstin}`, X + 5, doc.y, { width: W * 0.6 - 10 })
  const mx = X + W * 0.6 + 6
  const meta: Array<[string, string]> = [['Bill no.', b.number], ['Bill date', date(b.date)], ['Due date', date(b.dueDate)], ['Status', b.status.replace(/_/g, ' ')]]
  meta.forEach(([k, v], i) => {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(k, mx, y + 6 + i * 15, { lineBreak: false })
    doc.fillColor(INK).font('Helvetica-Bold').text(v, mx, y + 6 + i * 15, { width: W * 0.4 - 12, align: 'right', lineBreak: false })
  })
  y += 78

  // Lines table
  const cols = [22, 58, 62, 80, W - 22 - 58 - 62 - 80 - 58 - 70, 58, 70]
  const heads = ['#', 'LR no.', 'LR date', 'Vehicle', 'Route / goods', 'Wt (kg)', 'Amount']
  const drawHead = () => {
    doc.rect(X, y, W, 16).fillAndStroke('#F3F4F6', LINE)
    let cx = X
    heads.forEach((h, i) => {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(h.toUpperCase(), cx + 3, y + 5, { width: cols[i]! - 6, align: i >= 5 ? 'right' : 'left', lineBreak: false })
      cx += cols[i]!
    })
    y += 16
  }
  drawHead()
  b.lines.forEach((l, n) => {
    const route = [l.route, l.goods].filter(Boolean).join(' · ')
    const rowH = Math.max(18, doc.heightOfString(route, { width: cols[4]! - 6 }) + 8)
    if (y + rowH > pageBottom() - 150) { doc.addPage(); y = 30; drawHead() }
    const cells = [String(n + 1), l.lrNo, date(l.lrDate), l.vehicleNo ?? '', route, l.weightKg ? num(l.weightKg) : '', rs(l.amount)]
    let cx = X
    doc.lineWidth(0.4).strokeColor('#E5E7EB')
    cells.forEach((v, i) => {
      doc.fillColor(INK).font('Helvetica').fontSize(8).text(v, cx + 3, y + 4, { width: cols[i]! - 6, align: i >= 5 ? 'right' : 'left' })
      cx += cols[i]!
    })
    doc.moveTo(X, y + rowH).lineTo(X + W, y + rowH).stroke()
    y += rowH
  })

  // Totals
  if (y + 150 > pageBottom()) { doc.addPage(); y = 30 }
  y += 8
  const tw = 230, tx = X + W - tw
  const trows: Array<[string, string, boolean?]> = [['Taxable freight', rs(b.subtotal)]]
  if (b.igstTotal > 0) trows.push(['IGST', rs(b.igstTotal)])
  if (b.cgstTotal > 0) trows.push(['CGST', rs(b.cgstTotal)], ['SGST', rs(b.sgstTotal)])
  if (b.roundOff) trows.push(['Round off', rs(b.roundOff)])
  trows.push(['Grand total', rs(b.grandTotal), true])
  if (b.tdsAmount > 0) trows.push(['Less: TDS deducted by customer', `- ${rs(b.tdsAmount)}`], ['Net receivable', rs(b.grandTotal - b.tdsAmount), true])
  if (b.paidAmt > 0) trows.push(['Received', rs(b.paidAmt)])
  trows.forEach(([k, v, bold]) => {
    doc.fillColor(bold ? INK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5).text(k, tx, y, { width: tw * 0.6, lineBreak: false })
    doc.fillColor(INK).text(v, tx, y, { width: tw, align: 'right', lineBreak: false })
    y += bold ? 16 : 13
  })

  if (b.notes) {
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('NOTES', X, y - 4 - trows.length * 0)
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(b.notes, X, doc.y + 1, { width: W - tw - 12 })
  }
  y = Math.max(doc.y, y) + 14
  if (b.terms?.length) {
    if (y + 60 > pageBottom()) { doc.addPage(); y = 30 }
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('TERMS', X, y)
    doc.font('Helvetica').fontSize(7)
    b.terms.forEach((t, i) => doc.text(`${i + 1}. ${t}`, X, doc.y + 1, { width: W }))
  }
  doc.fillColor(MUTED).font('Helvetica').fontSize(7)
    .text(`For ${biz.name}   —   Authorised signatory`, X, pageBottom() - 6, { width: W, align: 'right', lineBreak: false })
}

// ══════════════════════════════════════════════════════════════════════════════
// Tax invoice — the layout the firms' paper bills use (see buildTaxInvoice in @billing/shared).
// For a freight bill the LR statement above is appended as a second page ("Encl. statement").
// ══════════════════════════════════════════════════════════════════════════════

const GREY = BILL_LAYOUT.grey

/**
 * The tax invoice, drawn from BILL_LAYOUT (the measured paper bill) scaled to the page width — the same spec the browser print page
 * uses, so the PDF that goes out on WhatsApp looks like the printed bill. Only the item table stretches, to fill the page.
 */
function drawTaxInvoice(doc: PDFKit.PDFDocument, v: TaxInvoiceView, copyLabel: string): void {
  const L = BILL_LAYOUT, F = L.font
  const M = 24, OUTW = doc.page.width - 2 * M, OUTH = doc.page.height - 2 * M
  const s = OUTW / (L.W + 2 * L.frame)                 // points per scan pixel
  const fr = L.frame * s, lw = L.line * s
  const ix = M + fr, iy = M + fr, IW = L.W * s, IH = OUTH - 2 * fr
  const fixed = L.rows.band + L.rows.address + L.rows.top + L.rows.bill + L.rows.head + L.rows.gstin + L.rows.bank + L.rows.words + L.rows.note + L.rows.decl + L.rows.tail
  const bodyH = Math.max(L.bodyMin * s, IH - fixed * s)
  const freight = v.kind === 'freight'

  // row tops
  const top: Record<string, number> = {}
  let yy = iy
  for (const [k, h] of [['band', L.rows.band], ['address', L.rows.address], ['top', L.rows.top], ['bill', L.rows.bill], ['head', L.rows.head]] as const) { top[k] = yy; yy += h * s }
  top['body'] = yy; yy += bodyH
  for (const [k, h] of [['gstin', L.rows.gstin], ['bank', L.rows.bank], ['words', L.rows.words], ['note', L.rows.note], ['decl', L.rows.decl], ['tail', L.rows.tail]] as const) { top[k] = yy; yy += h * s }
  const bottomOf = (k: keyof typeof L.rows | 'body') => (k === 'body' ? top['body']! + bodyH : top[k]! + L.rows[k] * s)

  const colEdges = L.cols.reduce<number[]>((a, c) => [...a, (a[a.length - 1] ?? 0) + c], [])
  const boundsX = colEdges.slice(0, -1).map((b) => ix + b * s)
  const fill = (x: number, y: number, w: number, h: number) => doc.save().rect(x, y, w, h).fill(GREY).restore()
  const hrule = (y: number, x1 = ix, x2 = ix + IW) => doc.lineWidth(lw).strokeColor(INK).moveTo(x1, y - lw / 2).lineTo(x2, y - lw / 2).stroke()
  const vrule = (x: number, y1: number, y2: number) => doc.lineWidth(lw).strokeColor(INK).moveTo(x, y1).lineTo(x, y2).stroke()
  const SERIF = 'Times-Bold'
  /** text whose vertical centre is `cy` (scan px below `rowTop`), left edge `x` (scan px from the inner left) or right edge at `right` px from the inner right */
  const tx = (str: string, rowTop: number, cy: number, size: number, o: { x?: number; right?: number; bold?: boolean; italic?: boolean; font?: string; center?: [number, number] } = {}) => {
    const font = o.font ?? (o.bold ? 'Helvetica-Bold' : o.italic ? 'Helvetica-Oblique' : 'Helvetica')
    const pt = size * s
    doc.font(font).fontSize(pt).fillColor(INK)
    const y = rowTop + (cy + L.textNudge) * s - pt * 0.36
    if (o.center) doc.text(str, ix + o.center[0] * s, y, { width: o.center[1] * s, align: 'center', lineBreak: false })
    else if (o.right !== undefined) doc.text(str, ix + IW - o.right * s - 420, y, { width: 420, align: 'right', lineBreak: false })
    else doc.text(str, ix + (o.x ?? 0) * s, y, { lineBreak: false })
  }
  /** a wrapped block whose FIRST line is centred at `cy` */
  const block = (str: string, rowTop: number, cy: number, x: number, width: number, size: number, pitch: number, italic: boolean) => {
    const pt = size * s
    doc.font(italic ? 'Helvetica-Oblique' : 'Helvetica').fontSize(pt).fillColor(INK)
    const lh = doc.currentLineHeight()
    doc.text(str, ix + x * s, rowTop + (cy + L.textNudge) * s - pt * 0.36, { width: width * s, lineGap: Math.max(0, pitch * s - lh) })
  }

  // frame
  doc.lineWidth(fr).strokeColor(INK).rect(M + fr / 2, M + fr / 2, OUTW - fr, OUTH - fr).stroke()

  // ── title band: logo, firm name · address ────────────────────────────────────────────────────────────────────────
  fill(ix, top['band']!, IW, L.rows.band * s)
  hrule(bottomOf('band'))
  tx(v.firm.name.toUpperCase(), top['band']!, L.title.y, F.firm, { font: SERIF, center: [0, L.W] })
  tx(v.firm.addressLine, top['address']!, L.address.y, F.address, { center: [0, L.W] })
  hrule(bottomOf('address'))
  if (v.firm.logo) {
    try {
      const b64 = v.firm.logo.split(',')[1] ?? ''
      doc.image(Buffer.from(b64, 'base64'), ix + L.logo.x * s, iy + L.logo.y * s, { fit: [150 * s, L.logo.h * s] })
    } catch { /* an unsupported image (e.g. WebP) must never stop the bill from printing */ }
  }

  // ── Debit Memo · TAX INVOICE · copy ─────────────────────────────────────────────────────────────────────────────
  if (v.topLeft) tx(v.topLeft, top['top']!, L.topRow.y, F.topSide, { x: L.padL, bold: true })
  tx(v.docTitle, top['top']!, L.topRow.y, F.topTitle, { bold: true, center: [0, L.W] })
  tx(copyLabel, top['top']!, L.topRow.y, F.topSide, { right: L.padR, bold: true })
  hrule(bottomOf('top'))

  // ── bill to · invoice no / date ─────────────────────────────────────────────────────────────────────────────────
  const bt = top['bill']!, B = L.billBlock
  fill(ix + L.billSplit * s, bt, IW - L.billSplit * s, L.invBox.height * s)
  hrule(bt + L.invBox.height * s, ix + L.billSplit * s)
  tx('M/s. :', bt, B.ms, F.ms, { x: L.padL, bold: true })
  tx(v.billTo.name.toUpperCase(), bt, B.ms, F.name, { x: B.nameX, bold: true })
  v.billTo.addressLines.forEach((a, k) => tx(a.toUpperCase(), bt, B.addr + k * B.addrPitch, F.addr, { x: B.nameX }))
  if (v.billTo.placeOfSupply) { tx('Place of Supply :', bt, B.place, F.place, { x: L.padL, bold: true }); tx(v.billTo.placeOfSupply, bt, B.place, F.place, { x: B.placeValueX }) }
  if (v.billTo.gstin) { tx('GSTIN No.', bt, B.gstin, F.place, { x: L.padL, bold: true }); tx(':', bt, B.gstin, F.place, { x: B.gstinColon }); tx(v.billTo.gstin, bt, B.gstin, F.place, { x: B.placeValueX }) }
  const bx = L.billSplit
  tx(v.numberLabel, bt, L.invBox.label.y1, F.box, { x: bx + L.invBox.label.x, bold: true }); tx(':', bt, L.invBox.label.y1, F.box, { x: bx + L.invBox.colon }); tx(v.number, bt, L.invBox.label.y1, F.box, { x: bx + L.invBox.value })
  tx('Date', bt, L.invBox.label.y2, F.box, { x: bx + L.invBox.label.x, bold: true }); tx(':', bt, L.invBox.label.y2, F.box, { x: bx + L.invBox.colon }); tx(v.date, bt, L.invBox.label.y2, F.box, { x: bx + L.invBox.value })
  if (v.reference) tx(v.reference, bt, L.invBox.height + 24, F.addr, { x: bx + L.invBox.label.x, bold: true })
  hrule(bottomOf('bill'))

  // ── items: header, then the table that fills the page ───────────────────────────────────────────────────────────
  fill(ix, top['head']!, IW, L.rows.head * s)
  ;['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'Amount'].forEach((h, k) => {
    if (k === 0) tx(h, top['head']!, L.rows.head / 2, F.head, { x: L.padL, bold: true })
    else tx(h, top['head']!, L.rows.head / 2, F.head, { bold: true, center: [colEdges[k - 1]!, L.cols[k]!] })
  })
  hrule(bottomOf('head'))
  const padR = [0, 0, 0, 10, 11, 10, L.padR]
  v.lines.forEach((l, k) => {
    const cy = L.body.firstY + k * L.body.pitch
    const vals = [String(l.sr), l.description.toUpperCase(), l.hsn, l.qty, l.rate, l.gst, l.amount]
    vals.forEach((t, c) => {
      const left = c === 0 ? 0 : colEdges[c - 1]!
      if (c === 0) tx(t, top['body']!, cy, F.body, { x: L.body.srPad })
      else if (c === 1) { doc.font('Helvetica').fontSize(F.body * s); tx(t.length > 62 ? `${t.slice(0, 61)}…` : t, top['body']!, cy, F.body, { x: left + L.body.padText }) }
      else if (c === 2) tx(t, top['body']!, cy, F.body, { center: [left, L.cols[c]!] })
      else tx(t, top['body']!, cy, F.body, { right: L.W - colEdges[c]! + padR[c]! })
    })
  })
  hrule(bottomOf('body'))

  // ── footer: bank, words, note | totals ──────────────────────────────────────────────────────────────────────────
  const fx = ix + L.footSplit * s
  fill(ix, top['gstin']!, L.footSplit * s, L.rows.gstin * s)
  tx(`GSTIN No.: ${v.firm.gstin}`, top['gstin']!, L.rows.gstin / 2, F.gstin, { x: L.padL, bold: true })
  hrule(bottomOf('gstin'))
  if (v.firm.bank) {
    ;([['Bank Name', v.firm.bank.name], ['Bank A/c No.', v.firm.bank.account], ['RTGS/IFSC Code', v.firm.bank.ifsc]] as const).forEach(([lab, val], k) => {
      tx(lab, top['bank']!, L.bank.y + k * L.bank.pitch, F.bankL, { x: L.padL, bold: true }); tx(':', top['bank']!, L.bank.y + k * L.bank.pitch, F.bankV, { x: L.bank.colon }); tx(val, top['bank']!, L.bank.y + k * L.bank.pitch, F.bankV, { x: L.bank.value })
    })
  }
  hrule(bottomOf('bank'), ix, fx)
  ;([['Total GST', v.words.gst, L.words.gstY], [v.totalLabel, v.words.total, L.words.totalY]] as const).forEach(([lab, txt, y]) => {
    tx(lab, top['words']!, y, F.wordsLabel, { x: L.padL, bold: true }); tx(':', top['words']!, y, F.wordsLabel, { x: L.words.colon })
    block(txt, top['words']!, y, L.words.x, L.words.width, freight ? F.wordsFreight : F.wordsGoods, L.words.pitch, freight)
  })
  hrule(bottomOf('words'))
  doc.font('Helvetica').fontSize(F.note * s).fillColor(INK)
  doc.text(`Note : ${v.note}`, ix + L.padL * s, top['note']! + (L.note.y + L.textNudge) * s - F.note * s * 0.36, { width: (L.footSplit - 2 * L.padL) * s, height: (L.rows.note - L.note.y) * s })
  hrule(bottomOf('note'))
  vrule(fx, top['gstin']!, bottomOf('note'))

  // totals (right column)
  const T = L.totals
  fill(fx, top['gstin']!, IW - L.footSplit * s, L.rows.gstin * s)
  tx('Sub Total', top['gstin']!, T.subY, F.subL, { x: L.footSplit + T.padL, bold: true }); tx(v.totals.subTotal, top['gstin']!, T.subY, F.subV, { right: T.padR, bold: true })
  hrule(bottomOf('gstin'), fx)
  const taxTop = top['bank']!
  tx('Taxable Amount', taxTop, T.taxableY, F.taxable, { x: L.footSplit + T.padL, bold: true }); tx(v.totals.taxable, taxTop, T.taxableY, F.taxable, { right: T.padR, bold: true })
  v.totals.taxRows.forEach((r, k) => {
    tx(r.label, taxTop, T.taxY + k * T.taxPitch, F.tax, { x: L.footSplit + T.padL })
    if (r.rate) tx(r.rate, taxTop, T.taxY + k * T.taxPitch, F.tax, { right: T.rateRight })
    tx(r.amount, taxTop, T.taxY + k * T.taxPitch, F.tax, { right: T.padR })
  })
  const ro = T.taxY + v.totals.taxRows.length * T.taxPitch
  tx('Round Off', taxTop, ro, F.tax, { x: L.footSplit + T.padL }); tx(v.totals.roundOff, taxTop, ro, F.tax, { right: T.padR })
  fill(fx, top['note']!, IW - L.footSplit * s, L.rows.note * s)
  hrule(top['words']! + L.rows.words * s)           // the rule above the grand-total bar
  tx('Grand Total', top['note']!, T.grandY, F.grandL, { x: L.footSplit + T.padL, bold: true }); tx(v.totals.grand, top['note']!, T.grandY, F.grandV, { right: T.padR, bold: true })
  hrule(bottomOf('note'), fx)

  // ── terms / GTA declaration · signature ─────────────────────────────────────────────────────────────────────────
  const D = L.decl
  tx(`${v.footer.heading} :`, top['decl']!, D.headY, F.declHead, { x: L.padL, bold: true })
  block(v.footer.numbered ? v.footer.lines.map((t, i) => `${i + 1}. ${t}`).join('\n') : v.footer.lines.join('\n'), top['decl']!, D.firstY, L.padL, D.width, F.decl, D.pitch, !v.footer.numbered)
  if (v.signFor) tx(`For, ${v.signFor.toUpperCase()}`, top['decl']!, D.forY, F.sign, { right: D.forRight })
  tx('(Authorised Signatory)', top['decl']!, D.signY, F.sign, { right: D.signRight })
  hrule(bottomOf('decl'))

  // the vertical lines of the item table run from the header to the footer
  for (const x of boundsX) vrule(x, top['head']!, bottomOf('body'))
  vrule(ix + L.billSplit * s, top['bill']!, top['head']!)
}

/** Page 1: the tax invoice. Freight bills get the LR statement as page 2 (the declaration says "Encl. statement"). */
export async function renderTaxInvoicePdf(
  v: TaxInvoiceView, copyLabel = 'Original', statement?: { data: FreightBillData; biz: BusinessHeader } | null,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 24, info: { Title: `Invoice ${v.number}`, Author: v.firm.name } })
  const done = collect(doc)
  drawTaxInvoice(doc, v, copyLabel)
  if (statement) { doc.addPage({ size: 'A4', margin: 30 }); drawFreightBill(doc, statement.data, statement.biz, true) }
  doc.end()
  return done
}
