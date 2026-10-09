// packages/pdf/src/templates/invoice.template.ts
// Renders an invoice as an HTML string.
// Puppeteer converts this HTML → PDF.
//
// Two formats:
//   a4      → standard A4 paper, used for B2B invoices and email attachments
//   thermal → 80mm wide roll paper, used by POS thermal printers
//
// Design principles:
//   - No external fonts (no network calls in Puppeteer)
//   - Inline CSS only (no external stylesheets)
//   - Works in both formats from one template function
//   - Supports Hindi/Gujarati product names (UTF-8)
//   - Correct GST invoice format as per Indian GST law

import { formatINR, INDIAN_STATE_CODES } from '@billing/shared'

export interface InvoiceData {
  // Invoice header
  number:      string
  date:        Date
  dueDate?:    Date | null
  txnType:     string
  status:      string

  // Seller (your business)
  branchName:  string
  branchGstin: string | null
  branchAddress: Record<string, string> | null
  stateCode:   string | null

  // Buyer
  partyName:   string | null
  partyPhone:  string | null
  partyGstin:  string | null
  partyAddress:Record<string, string> | null

  // Amounts
  subtotal:    number
  discountAmt: number
  taxableAmt:  number
  cgstTotal:   number
  sgstTotal:   number
  igstTotal:   number
  roundOff:    number
  grandTotal:  number
  paidAmt:     number

  // Line items
  items: Array<{
    description: string
    hsnSacCode:  string | null
    qty:         number
    unit:        string
    rate:        number
    discountPct: number
    taxableAmt:  number
    gstRate:     number
    cgstAmt:     number
    sgstAmt:     number
    igstAmt:     number
    total:       number
  }>

  // Meta
  notes?:      string | null
  isInterState:boolean
  format:      'a4' | 'thermal'
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toFixed(2) }

function fmtDate(d: Date) {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function txnLabel(type: string) {
  const labels: Record<string, string> = {
    sale_invoice:      'TAX INVOICE',
    purchase_invoice:  'PURCHASE INVOICE',
    sale_return:       'CREDIT NOTE',
    purchase_return:   'DEBIT NOTE',
    quotation:         'QUOTATION',
    delivery_challan:  'DELIVERY CHALLAN',
  }
  return labels[type] ?? 'INVOICE'
}

function stateName(code: string | null) {
  if (!code) return ''
  return INDIAN_STATE_CODES[code] ?? code
}

// ── A4 template ───────────────────────────────────────────────────────────────

function renderA4(inv: InvoiceData): string {
  const hasGST     = inv.cgstTotal > 0 || inv.sgstTotal > 0 || inv.igstTotal > 0
  const hasDiscount = inv.discountAmt > 0
  const isInterState = inv.isInterState

  const itemRows = inv.items.map((item, i) => `
    <tr style="background:${i % 2 === 0 ? '#fff' : '#fafafa'}">
      <td style="padding:7px 8px;border-bottom:1px solid #eee">${i + 1}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #eee">
        <div style="font-weight:500;color:#111">${item.description}</div>
        ${item.hsnSacCode ? `<div style="font-size:10px;color:#888;margin-top:2px">HSN: ${item.hsnSacCode}</div>` : ''}
      </td>
      <td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:center">${fmt(item.qty)} ${item.unit}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right">₹${fmt(item.rate)}</td>
      ${hasDiscount ? `<td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:center">${item.discountPct > 0 ? item.discountPct + '%' : '—'}</td>` : ''}
      <td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right">₹${fmt(item.taxableAmt)}</td>
      ${hasGST ? `
        <td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:center">${item.gstRate}%</td>
        ${isInterState
          ? `<td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right">₹${fmt(item.igstAmt)}</td>`
          : `<td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right">₹${fmt(item.cgstAmt)}<br/>₹${fmt(item.sgstAmt)}</td>`
        }
      ` : ''}
      <td style="padding:7px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:500">₹${fmt(item.total)}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size:12px; color:#222; background:#fff }
  .page { width:210mm; min-height:297mm; padding:12mm; background:#fff }
  table { width:100%; border-collapse:collapse }
  th { background:#f5f5f5; padding:8px; text-align:left; font-size:11px; color:#555; font-weight:600; border-top:2px solid #333; border-bottom:1px solid #ddd }
  th.right { text-align:right }
  th.center { text-align:center }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <table style="margin-bottom:20px">
    <tr>
      <td style="width:60%">
        <div style="font-size:22px;font-weight:700;color:#1a1a1a;letter-spacing:-0.5px">${inv.branchName}</div>
        ${inv.branchGstin ? `<div style="font-size:11px;color:#555;margin-top:4px">GSTIN: ${inv.branchGstin}</div>` : ''}
        ${inv.branchAddress ? `<div style="font-size:11px;color:#555;margin-top:2px;line-height:1.5">
          ${[inv.branchAddress['line1'], inv.branchAddress['city'], inv.branchAddress['state'], inv.branchAddress['pincode']].filter(Boolean).join(', ')}
        </div>` : ''}
        ${inv.stateCode ? `<div style="font-size:11px;color:#555">State: ${stateName(inv.stateCode)} (${inv.stateCode})</div>` : ''}
      </td>
      <td style="text-align:right">
        <div style="font-size:18px;font-weight:700;color:#333;text-transform:uppercase;letter-spacing:1px">${txnLabel(inv.txnType)}</div>
        <div style="margin-top:8px">
          <table style="margin-left:auto">
            <tr>
              <td style="color:#888;padding:3px 8px 3px 0;font-size:11px">Invoice No.</td>
              <td style="font-weight:600;font-size:12px">${inv.number}</td>
            </tr>
            <tr>
              <td style="color:#888;padding:3px 8px 3px 0;font-size:11px">Date</td>
              <td style="font-size:11px">${fmtDate(inv.date)}</td>
            </tr>
            ${inv.dueDate ? `<tr>
              <td style="color:#888;padding:3px 8px 3px 0;font-size:11px">Due Date</td>
              <td style="font-size:11px;color:#c0392b;font-weight:500">${fmtDate(inv.dueDate)}</td>
            </tr>` : ''}
          </table>
        </div>
      </td>
    </tr>
  </table>

  <!-- Divider -->
  <div style="border-top:2px solid #222;margin-bottom:16px"></div>

  <!-- Bill to -->
  ${inv.partyName ? `
  <div style="margin-bottom:16px">
    <div style="font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Bill To</div>
    <div style="font-size:13px;font-weight:600;color:#111">${inv.partyName}</div>
    ${inv.partyPhone  ? `<div style="font-size:11px;color:#555">📞 ${inv.partyPhone}</div>` : ''}
    ${inv.partyGstin  ? `<div style="font-size:11px;color:#555">GSTIN: ${inv.partyGstin}</div>` : ''}
    ${inv.partyAddress ? `<div style="font-size:11px;color:#555;line-height:1.5">
      ${[inv.partyAddress['line1'], inv.partyAddress['city'], inv.partyAddress['state'], inv.partyAddress['pincode']].filter(Boolean).join(', ')}
    </div>` : ''}
    ${inv.partyAddress?.['stateCode'] ? `<div style="font-size:11px;color:#555">State: ${stateName(inv.partyAddress['stateCode'])} (${inv.partyAddress['stateCode']})</div>` : ''}
  </div>
  ` : `<div style="margin-bottom:16px"><div style="font-size:11px;color:#888">Cash / Walk-in Sale</div></div>`}

  <!-- Line items table -->
  <table style="margin-bottom:20px;font-size:11px">
    <thead>
      <tr>
        <th style="width:30px">#</th>
        <th>Item description</th>
        <th class="center" style="width:80px">Qty</th>
        <th class="right" style="width:80px">Rate</th>
        ${hasDiscount ? `<th class="center" style="width:60px">Disc%</th>` : ''}
        <th class="right" style="width:90px">Taxable</th>
        ${hasGST ? `
          <th class="center" style="width:50px">GST%</th>
          <th class="right" style="width:90px">${isInterState ? 'IGST' : 'CGST/SGST'}</th>
        ` : ''}
        <th class="right" style="width:90px">Total</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <!-- Totals -->
  <table style="width:300px;margin-left:auto;font-size:12px;margin-bottom:20px">
    <tr><td style="padding:4px 8px;color:#555">Subtotal</td><td style="padding:4px 8px;text-align:right">₹${fmt(inv.subtotal)}</td></tr>
    ${hasDiscount ? `<tr><td style="padding:4px 8px;color:#555">Discount</td><td style="padding:4px 8px;text-align:right;color:#27ae60">−₹${fmt(inv.discountAmt)}</td></tr>` : ''}
    ${hasGST ? `<tr><td style="padding:4px 8px;color:#555">Taxable amount</td><td style="padding:4px 8px;text-align:right">₹${fmt(inv.taxableAmt)}</td></tr>` : ''}
    ${inv.cgstTotal > 0 ? `
      <tr><td style="padding:4px 8px;color:#555">CGST</td><td style="padding:4px 8px;text-align:right">₹${fmt(inv.cgstTotal)}</td></tr>
      <tr><td style="padding:4px 8px;color:#555">SGST</td><td style="padding:4px 8px;text-align:right">₹${fmt(inv.sgstTotal)}</td></tr>
    ` : ''}
    ${inv.igstTotal > 0 ? `<tr><td style="padding:4px 8px;color:#555">IGST</td><td style="padding:4px 8px;text-align:right">₹${fmt(inv.igstTotal)}</td></tr>` : ''}
    ${Math.abs(inv.roundOff) > 0 ? `<tr><td style="padding:4px 8px;color:#555">Round off</td><td style="padding:4px 8px;text-align:right">${inv.roundOff > 0 ? '+' : ''}₹${fmt(Math.abs(inv.roundOff))}</td></tr>` : ''}
    <tr style="border-top:2px solid #222">
      <td style="padding:8px;font-size:14px;font-weight:700">Grand Total</td>
      <td style="padding:8px;text-align:right;font-size:14px;font-weight:700">₹${fmt(inv.grandTotal)}</td>
    </tr>
    ${inv.paidAmt > 0 && inv.paidAmt < inv.grandTotal ? `
      <tr><td style="padding:4px 8px;color:#27ae60">Paid</td><td style="padding:4px 8px;text-align:right;color:#27ae60">₹${fmt(inv.paidAmt)}</td></tr>
      <tr style="border-top:1px solid #eee"><td style="padding:6px 8px;font-weight:600;color:#c0392b">Balance due</td><td style="padding:6px 8px;text-align:right;font-weight:600;color:#c0392b">₹${fmt(inv.grandTotal - inv.paidAmt)}</td></tr>
    ` : ''}
    ${inv.paidAmt >= inv.grandTotal ? `<tr><td colspan="2" style="padding:6px 8px;text-align:center;color:#27ae60;font-weight:600">✓ PAID IN FULL</td></tr>` : ''}
  </table>

  ${inv.notes ? `<div style="margin-bottom:16px;padding:10px 14px;background:#f9f9f9;border-left:3px solid #ddd;font-size:11px;color:#555"><strong>Notes:</strong> ${inv.notes}</div>` : ''}

  <!-- Footer -->
  <div style="border-top:1px solid #ddd;padding-top:12px;text-align:center;font-size:10px;color:#aaa">
    This is a computer generated invoice · No signature required
  </div>

</div>
</body>
</html>`
}

// ── Thermal 80mm template ─────────────────────────────────────────────────────

function renderThermal(inv: InvoiceData): string {
  const itemRows = inv.items.map((item) => `
    <div style="margin-bottom:4px">
      <div style="font-weight:500">${item.description}</div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#333">
        <span>${fmt(item.qty)} ${item.unit} × ₹${fmt(item.rate)}${item.discountPct > 0 ? ` (-${item.discountPct}%)` : ''}</span>
        <span>₹${fmt(item.total)}</span>
      </div>
      ${item.gstRate > 0 ? `<div style="font-size:9px;color:#777">GST ${item.gstRate}%: ₹${fmt(item.cgstAmt + item.sgstAmt + item.igstAmt)}</div>` : ''}
    </div>
    <div style="border-bottom:1px dashed #ccc;margin-bottom:4px"></div>
  `).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family:Arial,sans-serif; font-size:11px; color:#000; background:#fff }
  .receipt { width:76mm; padding:4mm; }
  .center { text-align:center }
  .right  { text-align:right }
  .row    { display:flex; justify-content:space-between; padding:2px 0 }
  .divider{ border-top:1px dashed #999; margin:6px 0 }
  .bold   { font-weight:700 }
</style>
</head>
<body>
<div class="receipt">

  <div class="center bold" style="font-size:14px;margin-bottom:2px">${inv.branchName}</div>
  ${inv.branchGstin ? `<div class="center" style="font-size:9px;color:#555">GSTIN: ${inv.branchGstin}</div>` : ''}
  ${inv.branchAddress ? `<div class="center" style="font-size:9px;color:#555">${[inv.branchAddress['city'], inv.branchAddress['pincode']].filter(Boolean).join(' - ')}</div>` : ''}

  <div class="divider"></div>

  <div class="center bold" style="font-size:10px;letter-spacing:1px">${txnLabel(inv.txnType)}</div>
  <div class="row" style="font-size:10px"><span>No: ${inv.number}</span><span>${fmtDate(inv.date)}</span></div>
  ${inv.partyName ? `<div style="font-size:10px">Customer: <strong>${inv.partyName}</strong></div>` : ''}

  <div class="divider"></div>

  ${itemRows}

  <div class="row"><span>Subtotal</span><span>₹${fmt(inv.subtotal)}</span></div>
  ${inv.discountAmt > 0 ? `<div class="row"><span>Discount</span><span>-₹${fmt(inv.discountAmt)}</span></div>` : ''}
  ${inv.cgstTotal > 0 ? `
    <div class="row"><span>CGST</span><span>₹${fmt(inv.cgstTotal)}</span></div>
    <div class="row"><span>SGST</span><span>₹${fmt(inv.sgstTotal)}</span></div>
  ` : ''}
  ${inv.igstTotal > 0 ? `<div class="row"><span>IGST</span><span>₹${fmt(inv.igstTotal)}</span></div>` : ''}
  ${Math.abs(inv.roundOff) > 0 ? `<div class="row"><span>Round off</span><span>${inv.roundOff > 0 ? '+' : '-'}₹${fmt(Math.abs(inv.roundOff))}</span></div>` : ''}

  <div class="divider"></div>
  <div class="row bold" style="font-size:14px"><span>TOTAL</span><span>₹${fmt(inv.grandTotal)}</span></div>
  ${inv.paidAmt > 0 ? `<div class="row" style="font-size:10px"><span>Paid</span><span>₹${fmt(inv.paidAmt)}</span></div>` : ''}
  ${inv.paidAmt < inv.grandTotal ? `<div class="row bold" style="font-size:11px;color:#000"><span>Balance</span><span>₹${fmt(inv.grandTotal - inv.paidAmt)}</span></div>` : ''}
  ${inv.paidAmt >= inv.grandTotal ? `<div class="center bold" style="margin-top:4px">*** PAID ***</div>` : ''}

  ${inv.notes ? `<div class="divider"></div><div style="font-size:9px">${inv.notes}</div>` : ''}

  <div class="divider"></div>
  <div class="center" style="font-size:9px;color:#777">Thank you for your business!</div>
  <div style="margin-top:8px"></div>

</div>
</body>
</html>`
}

// ── Main export ───────────────────────────────────────────────────────────────

export function renderInvoiceHTML(inv: InvoiceData): string {
  return inv.format === 'thermal' ? renderThermal(inv) : renderA4(inv)
}
