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
import type { TaxInvoiceView } from '@billing/shared'

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
  creditLine(doc)
}

// ══════════════════════════════════════════════════════════════════════════════
// Tax invoice — the layout the firms' paper bills use (see buildTaxInvoice in @billing/shared).
// For a freight bill the LR statement above is appended as a second page ("Encl. statement").
// ══════════════════════════════════════════════════════════════════════════════

const GREY = '#D9D9D9'

function drawTaxInvoice(doc: PDFKit.PDFDocument, v: TaxInvoiceView, copyLabel: string): void {
  const X0 = 24, Y0 = 24, W = doc.page.width - 48, H = doc.page.height - 48
  const BOT = Y0 + H
  const set = (font: string, size: number, color = INK) => doc.font(font).fontSize(size).fillColor(color)
  const rule = (x1: number, y1: number, x2: number, y2: number, w = 0.8) => doc.lineWidth(w).strokeColor(INK).moveTo(x1, y1).lineTo(x2, y2).stroke()
  const fill = (x: number, y: number, w: number, h: number) => doc.rect(x, y, w, h).fill(GREY)

  doc.lineWidth(1.6).strokeColor(INK).rect(X0, Y0, W, H).stroke()

  // Title band: firm name + logo, then address
  let y = Y0
  fill(X0 + 1, y + 1, W - 2, 41)
  if (v.firm.logo) {
    try {
      const b64 = v.firm.logo.split(',')[1] ?? ''
      doc.image(Buffer.from(b64, 'base64'), X0 + 8, y + 5, { fit: [78, 33] })
    } catch { /* an unsupported image (e.g. WebP) must never stop the bill from printing */ }
  }
  set('Times-Bold', 22).text(v.firm.name.toUpperCase(), X0 + 90, y + 10, { width: W - 180, align: 'center', lineBreak: false })
  y += 42; rule(X0, y, X0 + W, y)
  set('Helvetica', 10.5).text(v.firm.addressLine, X0 + 8, y + 8, { width: W - 16, align: 'center', lineBreak: false })
  y += 26; rule(X0, y, X0 + W, y)

  // Debit Memo · TAX INVOICE · copy
  if (v.topLeft) set('Helvetica-Bold', 10).text(v.topLeft, X0 + 8, y + 9, { lineBreak: false })
  set('Helvetica-Bold', 15).text(v.docTitle, X0, y + 6, { width: W, align: 'center', lineBreak: false })
  set('Helvetica-Bold', 10).text(copyLabel, X0, y + 9, { width: W - 8, align: 'right', lineBreak: false })
  y += 26; rule(X0, y, X0 + W, y)

  // Bill-to · invoice no / date
  const split = X0 + W * 0.64
  const billH = 92
  rule(split, y, split, y + billH)
  set('Helvetica-Bold', 10).text('M/s. :', X0 + 8, y + 7, { lineBreak: false })
  set('Helvetica-Bold', 12).text(v.billTo.name.toUpperCase(), X0 + 44, y + 5, { width: split - X0 - 52 })
  set('Helvetica', 9)
  let ly = doc.y + 1
  for (const l of v.billTo.addressLines) { doc.text(l.toUpperCase(), X0 + 44, ly, { width: split - X0 - 52 }); ly = doc.y }
  ly = Math.max(ly + 3, y + 54)
  if (v.billTo.placeOfSupply) { set('Helvetica-Bold', 9).text('Place of Supply : ', X0 + 8, ly, { continued: true }).font('Helvetica').text(v.billTo.placeOfSupply); ly = doc.y + 1 }
  if (v.billTo.gstin) { set('Helvetica-Bold', 9).text('GSTIN No. : ', X0 + 8, ly, { continued: true }).font('Helvetica').text(v.billTo.gstin) }
  fill(split + 1, y, X0 + W - split - 2, 46)
  set('Helvetica-Bold', 10.5).text(`${v.numberLabel}   :   `, split + 10, y + 9, { continued: true }).font('Helvetica').text(v.number)
  set('Helvetica-Bold', 10.5).text('Date              :   ', split + 10, y + 27, { continued: true }).font('Helvetica').text(v.date)
  if (v.reference) set('Helvetica-Bold', 9).text(v.reference, split + 10, y + 54, { width: X0 + W - split - 20 })
  y += billH; rule(X0, y, X0 + W, y)

  // Items table
  const cw = [36, W - 36 - 66 - 62 - 62 - 44 - 80, 66, 62, 62, 44, 80]
  const heads = ['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'Amount']
  const termsH = 94, totalsH = 156
  const footerTop = BOT - termsH - totalsH
  fill(X0 + 1, y, W - 2, 18)
  let cx = X0
  heads.forEach((h, i) => {
    set('Helvetica-Bold', 9).text(h, cx + 4, y + 5, { width: cw[i]! - 8, align: i >= 3 ? 'right' : i === 1 ? 'center' : 'left', lineBreak: false })
    cx += cw[i]!
    if (i < heads.length - 1) rule(cx, y, cx, footerTop, 0.6)
  })
  y += 18; rule(X0, y, X0 + W, y)
  const rowH = v.lines.length > 16 ? 13 : 18
  v.lines.forEach((l, k) => {
    const vals = [String(l.sr), l.description.toUpperCase(), l.hsn, l.qty, l.rate, l.gst, l.amount]
    let x = X0
    vals.forEach((t, i) => {
      set('Helvetica', 9).text(t, x + 4, y + 5 + k * rowH, { width: cw[i]! - 8, align: i >= 3 ? 'right' : 'left', lineBreak: i === 1, height: i === 1 ? rowH * 2 : undefined, ellipsis: i === 1 })
      x += cw[i]!
    })
  })

  // Bank + words | totals
  let ty = footerTop
  rule(X0, ty, X0 + W, ty)
  rule(split, ty, split, BOT - termsH)
  fill(X0 + 1, ty + 1, split - X0 - 1, 22)
  set('Helvetica-Bold', 11).text(`GSTIN No.: ${v.firm.gstin}`, X0 + 8, ty + 6, { lineBreak: false })
  let by = ty + 22; rule(X0, by, split, by)
  if (v.firm.bank) {
    set('Helvetica-Bold', 9).text('Bank Name', X0 + 8, by + 6, { lineBreak: false }).font('Helvetica').text(`:   ${v.firm.bank.name}`, X0 + 92, by + 6, { lineBreak: false })
    set('Helvetica-Bold', 9).text('Bank A/c No.', X0 + 8, by + 19, { lineBreak: false }).font('Helvetica').text(`:   ${v.firm.bank.account}`, X0 + 92, by + 19, { lineBreak: false })
    set('Helvetica-Bold', 9).text('RTGS/IFSC Code', X0 + 8, by + 32, { lineBreak: false }).font('Helvetica').text(`:   ${v.firm.bank.ifsc}`, X0 + 92, by + 32, { lineBreak: false })
    by += 50; rule(X0, by, split, by)
  }
  const ww = split - X0 - 16
  set('Helvetica-Bold', 9).text('Total GST', X0 + 8, by + 7, { continued: true, width: ww }).font('Helvetica').text(`   :   ${v.words.gst}`, { width: ww })
  set('Helvetica-Bold', 9).text(v.totalLabel, X0 + 8, doc.y + 7, { continued: true, width: ww }).font('Helvetica').text(`   :   ${v.words.total}`, { width: ww })
  by = Math.max(doc.y + 6, by + 52); rule(X0, by, split, by)
  if (v.note) { set('Helvetica-Bold', 8.5).text('Note :', X0 + 8, by + 5, { continued: true, width: ww, height: BOT - termsH - by - 8 }).font('Helvetica').text(` ${v.note}`, { width: ww, height: BOT - termsH - by - 8 }) }
  else set('Helvetica-Bold', 8.5).text('Note :', X0 + 8, by + 5, { lineBreak: false })

  const rx = split + 8, rw = X0 + W - split - 16
  fill(split + 1, ty + 1, X0 + W - split - 2, 22)
  set('Helvetica-Bold', 11).text('Sub Total', rx, ty + 6, { lineBreak: false }).text(v.totals.subTotal, rx, ty + 6, { width: rw, align: 'right', lineBreak: false })
  let ry = ty + 32
  set('Helvetica-Bold', 10).text('Taxable Amount', rx, ry, { lineBreak: false }).text(v.totals.taxable, rx, ry, { width: rw, align: 'right', lineBreak: false })
  ry += 16
  for (const t of v.totals.taxRows) {
    set('Helvetica', 9).text(t.label, rx, ry, { lineBreak: false })
    if (t.rate) doc.text(t.rate, rx + 78, ry, { width: 44, align: 'right', lineBreak: false })
    doc.text(t.amount, rx, ry, { width: rw, align: 'right', lineBreak: false })
    ry += 13
  }
  set('Helvetica', 9).text('Round Off', rx, ry, { lineBreak: false }).text(v.totals.roundOff, rx, ry, { width: rw, align: 'right', lineBreak: false })
  const gy = BOT - termsH - 28
  fill(split + 1, gy, X0 + W - split - 2, 27); rule(split, gy, X0 + W, gy)
  set('Helvetica-Bold', 12.5).text('Grand Total', rx, gy + 8, { lineBreak: false }).text(v.totals.grand, rx, gy + 8, { width: rw, align: 'right', lineBreak: false })

  // Terms / GTA declaration · signature
  const fy = BOT - termsH
  rule(X0, fy, X0 + W, fy)
  set('Helvetica-Bold', 9).text(`${v.footer.heading} :`, X0 + 8, fy + 6, { lineBreak: false })
  set(v.footer.numbered ? 'Helvetica' : 'Helvetica-Oblique', 8)
  let ty2 = fy + 19
  v.footer.lines.forEach((t, i) => { doc.text(v.footer.numbered ? `${i + 1}. ${t}` : t, X0 + 8, ty2, { width: W - 230, height: termsH - 24 }); ty2 = doc.y + 1 })
  if (v.signFor) set('Helvetica-Bold', 9).text(`For, ${v.signFor.toUpperCase()}`, X0 + W - 210, fy + 8, { width: 202, align: 'right', lineBreak: false })
  set('Helvetica', 8.5).text('(Authorised Signatory)', X0 + W - 210, BOT - 18, { width: 202, align: 'right', lineBreak: false })
  creditLine(doc, doc.page.height - 17)
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
