// packages/pdf/src/__tests__/invoice.template.test.ts
// Tests the HTML template output — checks that key content appears correctly.
// Does NOT test PDF rendering (that requires Puppeteer, tested manually).

import { renderInvoiceHTML, type InvoiceData } from '../templates/invoice.template.js'

const baseInvoice: InvoiceData = {
  number:    'INV-25-00001',
  date:      new Date('2025-06-14'),
  dueDate:   null,
  txnType:   'sale_invoice',
  status:    'confirmed',
  branchName:    'Test Store',
  branchGstin:   '24AABCT1234A1Z5',
  branchAddress: { city: 'Vadodara', state: 'Gujarat', pincode: '390007' },
  stateCode:     '24',
  partyName:     'Test Customer',
  partyPhone:    '9712345678',
  partyGstin:    null,
  partyAddress:  { city: 'Vadodara', stateCode: '24' },
  subtotal:      100,
  discountAmt:   0,
  taxableAmt:    100,
  cgstTotal:     9,
  sgstTotal:     9,
  igstTotal:     0,
  roundOff:      0,
  grandTotal:    118,
  paidAmt:       0,
  isInterState:  false,
  items: [{
    description: 'Test Product',
    hsnSacCode:  '12345678',
    qty: 1, unit: 'pcs', rate: 100, discountPct: 0,
    taxableAmt: 100, gstRate: 18, cgstAmt: 9, sgstAmt: 9, igstAmt: 0, total: 118,
  }],
  notes:  null,
  format: 'a4',
}

describe('renderInvoiceHTML — A4', () => {
  let html: string

  beforeAll(() => { html = renderInvoiceHTML(baseInvoice) })

  test('produces valid HTML structure', () => {
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
    expect(html).toContain('</html>')
  })

  test('includes invoice number', () => {
    expect(html).toContain('INV-25-00001')
  })

  test('includes branch name prominently', () => {
    expect(html).toContain('Test Store')
  })

  test('shows TAX INVOICE label for sale_invoice', () => {
    expect(html).toContain('TAX INVOICE')
  })

  test('includes customer name', () => {
    expect(html).toContain('Test Customer')
  })

  test('includes GSTIN', () => {
    expect(html).toContain('24AABCT1234A1Z5')
  })

  test('includes product description', () => {
    expect(html).toContain('Test Product')
  })

  test('includes HSN code', () => {
    expect(html).toContain('HSN: 12345678')
  })

  test('shows CGST and SGST (intra-state)', () => {
    expect(html).toContain('CGST')
    expect(html).toContain('SGST')
    expect(html).not.toContain('IGST')
  })

  test('shows grand total', () => {
    expect(html).toContain('118')
    expect(html).toContain('Grand Total')
  })

  test('UTF-8 charset declared', () => {
    expect(html).toContain('UTF-8')
  })
})

describe('renderInvoiceHTML — label variants', () => {
  const labels: Array<[string, string]> = [
    ['sale_invoice',     'TAX INVOICE'],
    ['purchase_invoice', 'PURCHASE INVOICE'],
    ['sale_return',      'CREDIT NOTE'],
    ['purchase_return',  'DEBIT NOTE'],
    ['quotation',        'QUOTATION'],
    ['delivery_challan', 'DELIVERY CHALLAN'],
  ]

  test.each(labels)('txnType %s → label %s', (txnType, label) => {
    const html = renderInvoiceHTML({ ...baseInvoice, txnType })
    expect(html).toContain(label)
  })
})

describe('renderInvoiceHTML — inter-state invoice', () => {
  test('shows IGST instead of CGST/SGST', () => {
    const html = renderInvoiceHTML({
      ...baseInvoice,
      isInterState: true,
      cgstTotal:    0,
      sgstTotal:    0,
      igstTotal:    18,
      items: [{ ...baseInvoice.items[0]!, cgstAmt: 0, sgstAmt: 0, igstAmt: 18 }],
    })
    expect(html).toContain('IGST')
  })
})

describe('renderInvoiceHTML — paid invoice', () => {
  test('shows PAID IN FULL when paidAmt >= grandTotal', () => {
    const html = renderInvoiceHTML({ ...baseInvoice, paidAmt: 118 })
    expect(html).toContain('PAID')
  })

  test('shows balance due when partially paid', () => {
    const html = renderInvoiceHTML({ ...baseInvoice, paidAmt: 50 })
    expect(html).toContain('Balance due')
    expect(html).toContain('68')  // 118 - 50
  })
})

describe('renderInvoiceHTML — walk-in cash sale', () => {
  test('handles null partyName gracefully', () => {
    const html = renderInvoiceHTML({
      ...baseInvoice,
      partyName: null, partyPhone: null, partyGstin: null, partyAddress: null,
    })
    expect(html).toContain('Cash / Walk-in Sale')
    expect(html).not.toContain('null')
  })
})

describe('renderInvoiceHTML — discount', () => {
  test('shows discount column when discount > 0', () => {
    const html = renderInvoiceHTML({
      ...baseInvoice,
      discountAmt: 10,
      items: [{ ...baseInvoice.items[0]!, discountPct: 10, taxableAmt: 90, total: 106.2 }],
    })
    expect(html).toContain('Discount')
  })

  test('no discount column when no discounts', () => {
    const html = renderInvoiceHTML(baseInvoice)
    // Discount row should not appear in totals (no discountAmt)
    const discountCount = (html.match(/Discount/g) ?? []).length
    expect(discountCount).toBe(0)
  })
})

describe('renderInvoiceHTML — thermal format', () => {
  let html: string
  beforeAll(() => { html = renderInvoiceHTML({ ...baseInvoice, format: 'thermal' }) })

  test('produces valid HTML', () => {
    expect(html).toContain('<!DOCTYPE html>')
  })

  test('includes invoice number', () => {
    expect(html).toContain('INV-25-00001')
  })

  test('uses 76mm width (thermal)', () => {
    expect(html).toContain('76mm')
  })

  test('shows TOTAL in uppercase (thermal style)', () => {
    expect(html).toContain('TOTAL')
  })

  test('shows PAID when fully paid (thermal)', () => {
    const paidHtml = renderInvoiceHTML({ ...baseInvoice, format: 'thermal', paidAmt: 118 })
    expect(paidHtml).toContain('PAID')
  })
})

describe('renderInvoiceHTML — round-off', () => {
  test('shows round-off line when non-zero', () => {
    const html = renderInvoiceHTML({ ...baseInvoice, roundOff: -0.4, grandTotal: 118 })
    expect(html).toContain('Round off')
    expect(html).toContain('0.40')
  })

  test('no round-off line when zero', () => {
    const html = renderInvoiceHTML(baseInvoice)
    expect(html).not.toContain('Round off')
  })
})

describe('renderInvoiceHTML — notes', () => {
  test('shows notes when present', () => {
    const html = renderInvoiceHTML({ ...baseInvoice, notes: 'Please pay within 7 days' })
    expect(html).toContain('Please pay within 7 days')
  })

  test('no notes section when null', () => {
    const html = renderInvoiceHTML({ ...baseInvoice, notes: null })
    expect(html).not.toContain('Notes:')
  })
})
