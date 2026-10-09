// packages/pdf/src/test-render.ts
// Quick local test: generates sample A4 + thermal PDFs without a running server.
// Run with: pnpm --filter @billing/pdf test:render
// Opens the generated PDFs automatically on macOS.

import { generateBothFormats, type InvoiceData } from './index.js'
import { execSync } from 'child_process'

const sampleInvoice: InvoiceData = {
  number:    'RK-ALK-25-00001',
  date:      new Date('2025-06-14'),
  dueDate:   null,
  txnType:   'sale_invoice',
  status:    'confirmed',

  branchName:    'Ramesh Kirana Store',
  branchGstin:   '24AABCR1234A1Z5',
  branchAddress: {
    line1:   'Shop 12, Alkapuri',
    city:    'Vadodara',
    state:   'Gujarat',
    pincode: '390007',
  },
  stateCode: '24',

  partyName:    'Mukesh Sharma',
  partyPhone:   '9712345678',
  partyGstin:   null,
  partyAddress: {
    city:      'Vadodara',
    state:     'Gujarat',
    stateCode: '24',
  },

  subtotal:    360,
  discountAmt: 0,
  taxableAmt:  360,
  cgstTotal:   13.2,
  sgstTotal:   13.2,
  igstTotal:   0,
  roundOff:    -0.4,
  grandTotal:  386,
  paidAmt:     0,

  isInterState: false,

  items: [
    {
      description: 'Amul Butter 100g',
      hsnSacCode:  '04051000',
      qty:         2,
      unit:        'pcs',
      rate:        55,
      discountPct: 0,
      taxableAmt:  110,
      gstRate:     12,
      cgstAmt:     6.6,
      sgstAmt:     6.6,
      igstAmt:     0,
      total:       123.2,
    },
    {
      description: 'Aashirvaad Atta 5kg',
      hsnSacCode:  '11010000',
      qty:         1,
      unit:        'pcs',
      rate:        210,
      discountPct: 0,
      taxableAmt:  210,
      gstRate:     0,
      cgstAmt:     0,
      sgstAmt:     0,
      igstAmt:     0,
      total:       210,
    },
    {
      description: 'Fortune Sunflower Oil 1L',
      hsnSacCode:  '15121100',
      qty:         1,
      unit:        'pcs',
      rate:        130,
      discountPct: 0,
      taxableAmt:  130,
      gstRate:     5,
      cgstAmt:     3.25,
      sgstAmt:     3.25,
      igstAmt:     0,
      total:       136.5,
    },
  ],

  notes:  'Please pay within 7 days. Thank you for shopping with us!',
  format: 'a4',
}

async function main() {
  console.log('Generating sample invoice PDFs...')

  const { a4, thermal } = await generateBothFormats(
    'test-invoice-001',
    sampleInvoice,
    '/tmp/billing-files/invoices'
  )

  console.log(`✓ A4 PDF:      ${a4.filePath} (${(a4.sizeBytes / 1024).toFixed(0)} KB, ${a4.durationMs}ms)`)
  console.log(`✓ Thermal PDF: ${thermal.filePath} (${(thermal.sizeBytes / 1024).toFixed(0)} KB, ${thermal.durationMs}ms)`)

  // Open in default PDF viewer on macOS
  if (process.platform === 'darwin') {
    execSync(`open "${a4.filePath}"`)
    execSync(`open "${thermal.filePath}"`)
  }

  console.log('\nDone! Check /tmp/billing-files/invoices/')
  process.exit(0)
}

main().catch((err) => {
  console.error('Failed:', err.message)
  process.exit(1)
})
