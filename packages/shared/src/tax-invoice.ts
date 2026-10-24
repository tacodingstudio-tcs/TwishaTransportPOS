// packages/shared/src/tax-invoice.ts
// One place that turns a saved invoice + its firm into what the printed "TAX INVOICE" shows. The browser print page
// and the server-built PDF (WhatsApp / download) both render this view, so the two can never disagree.
//
// Two kinds of bill share the layout:
//   • freight — a transport firm's bill. Its per-LR lines collapse into ONE summary line
//     ("TRANSPORTATION CHARGE FROM KUTCH", total tonnes, average rate) with the GTA declaration at the foot.
//   • goods   — a trading firm's sale of goods: the saved lines as they are, terms & conditions at the foot.

import { INDIAN_STATE_CODES } from './states.js'

export interface TaxInvoiceItem {
  description: string
  hsnSacCode?: string | null
  qty: number | string
  unit?: string | null
  rate: number | string
  gstRate: number | string
  taxableAmt: number | string
  itemMeta?: Record<string, any> | null
}

export interface TaxInvoiceInput {
  invoice: {
    number: string
    date: string | Date
    taxableAmt: number | string
    cgstTotal: number | string
    sgstTotal: number | string
    igstTotal: number | string
    roundOff: number | string
    grandTotal: number | string
    notes?: string | null
    domainData?: Record<string, any> | null
    items: TaxInvoiceItem[]
  }
  party: { name: string; gstin?: string | null; address?: Record<string, any> | null } | null
  firm: {
    name: string
    gstin?: string | null
    stateCode?: string | null
    address?: Record<string, any> | null
    domainConfig?: Record<string, any> | null
    logo?: string | null
  }
}

export interface TaxInvoiceLine { sr: number; description: string; hsn: string; qty: string; rate: string; gst: string; amount: string }

export interface TaxInvoiceView {
  kind: 'freight' | 'goods'
  /** A bill, or the credit / debit note that corrects one — same layout, different title. */
  docKind: 'invoice' | 'credit_note' | 'debit_note'
  docTitle: string        // TAX INVOICE · CREDIT NOTE · DEBIT NOTE
  topLeft: string         // "Debit Memo" on a bill; empty on a note
  numberLabel: string     // Invoice No. · Credit Note No. · Debit Note No.
  reference: string       // notes only: "Against Invoice No. X dated dd/mm/yyyy"
  firm: { name: string; addressLine: string; gstin: string; pan: string; logo: string | null; bank: { name: string; account: string; ifsc: string } | null }
  billTo: { name: string; addressLines: string[]; placeOfSupply: string; gstin: string }
  number: string
  date: string
  lines: TaxInvoiceLine[]
  totals: {
    subTotal: string; taxable: string
    taxRows: Array<{ label: string; rate: string; amount: string }>
    roundOff: string; grand: string
  }
  words: { gst: string; total: string }
  totalLabel: string
  note: string
  footer: { heading: string; lines: string[]; numbered: boolean }
  signFor: string          // "For, <firm>" above the signature; empty on the trading firm's paper bill, which has none
}

const n = (v: unknown): number => Number(v ?? 0) || 0
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
const money = (x: number, dp = 2) => x.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })

const DEFAULT_TERMS = [
  'Goods once sold will not be taken back.',
  'Interest @18% p.a. will be charged if payment is not made within due date.',
  'Our risk and responsibility ceases as soon as the goods leave our premises.',
  'Subject to local jurisdiction only. E. & O.E.',
]

/** "24-Gujarat" — from the customer's state code, else their GSTIN, else the firm's own state. */
function placeOfSupply(partyAddr: Record<string, any> | null | undefined, gstin: string, firmState: string): string {
  const raw = String(partyAddr?.['stateCode'] ?? '') || gstin.slice(0, 2) || firmState
  const code = /^\d{2}$/.test(raw) ? raw : firmState
  return code ? `${code}-${INDIAN_STATE_CODES[code] ?? ''}`.replace(/-$/, '') : ''
}

const addrLine = (a: Record<string, any> | null | undefined): string =>
  a ? [a['line1'], a['line2'], a['city'], a['pincode']].filter(Boolean).join(', ') : ''

function below1000(x: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const parts: string[] = []
  if (x >= 100) { parts.push(`${ones[Math.floor(x / 100)]} Hundred`); x %= 100 }
  if (x >= 20) { parts.push(tens[Math.floor(x / 10)]! + (x % 10 ? ` ${ones[x % 10]}` : '')) }
  else if (x > 0) parts.push(ones[x]!)
  return parts.join(' ')
}

/** Indian-system amount in words: "One Lakh Fifty Six Thousand Three Hundred Forty Two Only". */
export function rupeesInWords(amount: number): string {
  const a = Math.abs(amount)
  const rupees = Math.floor(a + 1e-9)
  const paise = Math.round((a - rupees) * 100)
  if (rupees === 0 && paise === 0) return 'Zero Only'
  const words: string[] = []
  let rest = rupees
  for (const [size, name] of [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']] as Array<[number, string]>) {
    if (rest >= size) { words.push(`${below1000(Math.floor(rest / size))} ${name}`); rest %= size }
  }
  if (rest > 0) words.push(below1000(rest))
  const rupeeText = words.join(' ')
  const paiseText = paise > 0 ? `${below1000(paise)} Paise` : ''
  return [rupeeText, rupeeText && paiseText ? 'And' : '', paiseText].filter(Boolean).join(' ') + ' Only'
}

const ddmmyyyy = (v: string | Date): string => {
  const s = typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10)
  const [y, m, d] = s.split('-')
  return y && m && d ? `${d}/${m}/${y}` : String(v)
}

/** The firm's paper-bill declaration for forward charge, with its typos corrected (`_x_` = underlined). */
const forwardDeclaration = (sac: string) => [
  'TAX IS PAYABLE ON FORWARD _CHARGES_ TICK=YES',
  'Declaration for forwarding charges : GST is levied on forwarding charges',
  'basis as notification no. 20/2017, hence GST is not to be paid under RCM by consignee.',
  `1.Encl. (a) statement (b) ir-01 SAC CODE:- ${sac}- To be mentioned as category belongs`,
]

const GTA_DEFAULTS: Record<string, string> = {
  rcm: 'GTA declaration: GST on this service is payable by the recipient under reverse charge (RCM) as applicable, at the rate notified for goods transport agency services.',
  exempt: 'This supply of goods transport service is exempt from GST.',
  forward: 'GTA declaration: tax is payable on forward charge — GST is levied on forwarding charges as per notification no. 20/2017, hence GST is not to be paid under RCM by the consignee.',
}

export function buildTaxInvoice({ invoice, party, firm }: TaxInvoiceInput): TaxInvoiceView {
  const dd = (invoice.domainData ?? {}) as Record<string, any>
  const cfg = (firm.domainConfig ?? {}) as Record<string, any>
  const docKind: TaxInvoiceView['docKind'] = dd['bill_kind'] === 'credit_note' ? 'credit_note' : dd['bill_kind'] === 'debit_note' ? 'debit_note' : 'invoice'
  const isNote = docKind !== 'invoice'
  // a note follows the layout of the bill it corrects (GTA declaration for freight, terms for goods)
  const kind: 'freight' | 'goods' = (isNote ? dd['parent_kind'] === 'goods' : dd['bill_kind'] === 'goods_sale') ? 'goods' : 'freight'
  const items = invoice.items ?? []

  const taxable = r2(n(invoice.taxableAmt))
  const cgst = r2(n(invoice.cgstTotal)), sgst = r2(n(invoice.sgstTotal)), igst = r2(n(invoice.igstTotal))
  const grand = n(invoice.grandTotal)
  const rates = [...new Set(items.map((i) => n(i.gstRate)))]

  // ── lines ────────────────────────────────────────────────────────────────────
  let lines: TaxInvoiceLine[]
  const kgOf = (i: TaxInvoiceItem) => n(i.itemMeta?.['charged_kg'] ?? i.itemMeta?.['weight_kg'])
  const haveWeights = !isNote && kind === 'freight' && items.length > 0 && items.every((i) => kgOf(i) > 0)
  if (!isNote && kind === 'freight' && !haveWeights && items.length > 0) {
    // No weights recorded (fixed-rate loads): one summary line by trips. The LR statement lists each load.
    const origins = [...new Set(items.map((i) => String(i.itemMeta?.['from_city'] ?? '').trim().toUpperCase()).filter(Boolean))]
    lines = [{
      sr: 1,
      description: `TRANSPORTATION CHARGE${origins.length ? ` FROM ${origins.join(', ')}` : ''} — ${items.length} trip${items.length === 1 ? '' : 's'}`,
      hsn: String(items[0]?.hsnSacCode ?? cfg['default_sac_code'] ?? ''),
      qty: String(items.length), rate: money(r2(taxable / items.length)),
      gst: money(n(items[0]?.gstRate)), amount: money(taxable),
    }]
  } else if (!isNote && kind === 'freight' && haveWeights) {
    const tonnes = r2(items.reduce((s, i) => s + kgOf(i), 0) / 1000)
    const origins = [...new Set(items.map((i) => String(i.itemMeta?.['from_city'] ?? '').trim().toUpperCase()).filter(Boolean))]
    lines = [{
      sr: 1,
      description: `TRANSPORTATION CHARGE${origins.length ? ` FROM ${origins.join(', ')}` : ''}`,
      hsn: String(items[0]?.hsnSacCode ?? cfg['default_sac_code'] ?? ''),
      qty: money(tonnes), rate: money(tonnes > 0 ? r2(taxable / tonnes) : taxable),
      gst: money(n(items[0]?.gstRate)), amount: money(taxable),
    }]
  } else {
    lines = items.map((i, k) => ({
      sr: k + 1, description: i.description, hsn: String(i.hsnSacCode ?? ''),
      qty: money(n(i.qty), n(i.qty) % 1 ? 2 : 0), rate: money(n(i.rate)),
      gst: money(n(i.gstRate)), amount: money(r2(n(i.taxableAmt))),
    }))
  }

  // ── tax rows ─────────────────────────────────────────────────────────────────
  const single = rates.length === 1 ? rates[0]! : null
  const taxRows: TaxInvoiceView['totals']['taxRows'] = []
  const pct = (r: number | null) => (r == null ? '' : `${money(r, r % 1 ? 2 : 2)}%`)
  if (igst > 0) taxRows.push({ label: 'IGST', rate: pct(single), amount: money(igst) })
  if (cgst > 0 || sgst > 0) {
    const half = single == null ? null : single / 2
    if (kind === 'goods') {
      taxRows.push({ label: 'Central Tax', rate: pct(half), amount: money(cgst) })
      taxRows.push({ label: 'State/UT Tax', rate: pct(half), amount: money(sgst) })
    } else {
      const h = half == null ? '' : ` (${half % 1 ? half.toFixed(1) : half}%)`
      taxRows.push({ label: `CGST${h}`, rate: '', amount: money(cgst) })
      taxRows.push({ label: `SGST${h}`, rate: '', amount: money(sgst) })
    }
  }
  const totalGst = r2(cgst + sgst + igst)
  const roundOff = r2(n(invoice.roundOff))

  // ── foot ─────────────────────────────────────────────────────────────────────
  const mode = String(dd['gst_mode'] ?? 'rcm')
  const custom = String(cfg['gta_declaration'] ?? '').trim()
  const declaration = custom ||
    (mode === 'rcm' ? GTA_DEFAULTS['rcm']! : mode === 'exempt' ? GTA_DEFAULTS['exempt']! : GTA_DEFAULTS['forward']!)
  const terms = String(cfg['bill_terms'] ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  const partyGstin = String(party?.gstin ?? '')
  const bank = cfg['bank_name'] || cfg['bank_account_no']
    ? { name: String(cfg['bank_name'] ?? ''), account: String(cfg['bank_account_no'] ?? ''), ifsc: String(cfg['bank_ifsc'] ?? '') }
    : null

  return {
    kind,
    docKind,
    docTitle: docKind === 'credit_note' ? 'CREDIT NOTE' : docKind === 'debit_note' ? 'DEBIT NOTE' : 'TAX INVOICE',
    topLeft: isNote ? '' : 'Debit Memo',
    numberLabel: docKind === 'credit_note' ? 'Credit Note No.' : docKind === 'debit_note' ? 'Debit Note No.' : 'Invoice No.',
    reference: isNote && dd['against_number'] ? `Against Invoice No. ${dd['against_number']}${dd['against_date'] ? ` dated ${ddmmyyyy(String(dd['against_date']))}` : ''}` : '',
    firm: { name: firm.name, addressLine: addrLine(firm.address).toUpperCase(), gstin: String(firm.gstin ?? ''), pan: String(cfg['pan'] ?? ''), logo: firm.logo ?? null, bank },
    billTo: {
      name: party?.name ?? '',
      addressLines: [party?.address?.['line1'], party?.address?.['line2'], [party?.address?.['city'], party?.address?.['pincode']].filter(Boolean).join(' ')].filter(Boolean) as string[],
      placeOfSupply: placeOfSupply(party?.address, partyGstin, String(firm.stateCode ?? '')),
      gstin: partyGstin,
    },
    number: invoice.number,
    date: ddmmyyyy(invoice.date),
    lines,
    totals: { subTotal: money(taxable), taxable: money(taxable), taxRows, roundOff: money(roundOff), grand: money(grand) },
    // The trading firm's paper bill spells the GST total in whole rupees ("Seven Thousand Four Hundred Forty Four Only" for 7,444.86);
    // the freight bill spells the paise as well.
    words: { gst: totalGst > 0 ? rupeesInWords(kind === 'goods' ? Math.floor(totalGst + 1e-9) : totalGst) : 'Nil', total: rupeesInWords(grand) },
    totalLabel: docKind === 'credit_note' ? 'Credit Amount' : docKind === 'debit_note' ? 'Debit Amount' : kind === 'goods' ? 'Total Amount' : 'Bill Amount',
    note: String(invoice.notes ?? '').trim(),
    footer: kind === 'freight'
      ? { heading: 'GTA Declaration', lines: custom ? [custom] : mode === 'rcm' || mode === 'exempt' ? [declaration] : forwardDeclaration(String(items[0]?.hsnSacCode ?? cfg['default_sac_code'] ?? '996511')), numbered: false }
      : { heading: 'Terms & Condition', lines: terms.length ? terms : DEFAULT_TERMS, numbered: true },
    signFor: kind === 'goods' ? '' : firm.name,
  }
}

/**
 * Geometry of the firms' paper bill, measured off the two scanned samples (Rajhansh Roadways invoice 15, Rajhansh Enterprise F-3)
 * in the scan's own pixels. Origin: just inside the outer frame. The browser print page and the server PDF both draw from this,
 * scaled to the paper width, so the printed bill keeps the paper bill's proportions line for line. The tall item table is the only
 * part that stretches (to fill the page), exactly like the paper bill.
 *
 * Row heights include their bottom rule. x values are from the inner left edge; "y" values are the vertical CENTRE of the text,
 * measured from the top of its row.
 */
export const BILL_LAYOUT = {
  W: 1065,                   // inner width
  frame: 3,                  // outer frame thickness
  line: 1.5,                 // every inner rule
  grey: '#d9d9d9',
  rows: { band: 53.5, address: 60, top: 38, bill: 161, head: 36, gstin: 34, bank: 74, words: 103, note: 51, decl: 160, tail: 5 },
  bodyMin: 638,              // the item table, in the scan (it grows on a taller page)
  cols: [68, 466, 103.5, 98.5, 109, 75, 145],         // SrNo · Product Name · HSN/SAC · Qty · Rate · GST % · Amount (sum = W)
  billSplit: 637.5,          // customer block | invoice-no box (the start of the Qty column)
  footSplit: 736,            // bank / words / note | totals (the start of the Rate column)
  padL: 11, padR: 12,
  textNudge: 2,               // the scan's text sits a touch lower than the centre of its row
  invBox: { height: 69, label: { x: 14, y1: 20, y2: 52 }, colon: 156, value: 181 },
  logo: { x: 63, y: 8, h: 70 },
  title: { y: 26 }, address: { y: 24 }, topRow: { y: 19 },
  billBlock: { ms: 16, addr: 46, addrPitch: 20, place: 117, gstin: 142, nameX: 85, placeValueX: 167, gstinColon: 152 },
  body: { firstY: 24, pitch: 30, padText: 8, srPad: 18, hsnCentered: true },
  bank: { y: 12, pitch: 24, colon: 172, value: 190 },
  words: { gstY: 19, totalY: 70, colon: 134, x: 150, width: 575, pitch: 18 },
  note: { y: 20 },
  totals: { subY: 17, taxableY: 85, taxY: 110, taxPitch: 24, rateRight: 128, grandY: 22, padL: 11, padR: 12 },
  decl: { headY: 12, firstY: 35, pitch: 22.5, width: 690, forY: 29, forRight: 12, signY: 132, signRight: 21 },
  font: {                    // sizes in scan pixels
    firm: 35.5, address: 20, topSide: 19, topTitle: 25, ms: 20, name: 22, addr: 18, place: 18.5, box: 19, head: 18, body: 17.5,
    gstin: 21.5, bankL: 18.5, bankV: 19, wordsLabel: 18, wordsFreight: 16, wordsGoods: 19, note: 19,
    subL: 19, subV: 22, taxable: 19, tax: 18, grandL: 23, grandV: 23, declHead: 18, decl: 17, sign: 17,
  },
} as const
