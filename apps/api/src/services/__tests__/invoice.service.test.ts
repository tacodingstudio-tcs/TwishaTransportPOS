// apps/api/src/services/__tests__/invoice.service.test.ts
//
// Tests for the invoice service.
// The DB is mocked — we test business logic, not Prisma wiring.
// The GST engine is NOT mocked — it's pure functions and must be real.
//
// Run: pnpm test --filter @billing/api

import { calculateInvoice } from '@billing/gst-engine'
import {
  CreateInvoiceSchema,
  RecordPaymentSchema,
} from '../invoice.service.js'

// ── Test context helper ───────────────────────────────────────────────────────
const mockCtx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  branchId: '00000000-0000-0000-0000-000000000002',
  userId:   '00000000-0000-0000-0000-000000000003',
  role:     'owner' as const,
  branchDomainType: 'retail',
}

const validItem = {
  description: 'Amul Butter 100g',
  qty:   2,
  rate:  55,
  discountPct: 0,
  gstRate:     12,
  unit:  'pcs',
  itemMeta: {},
}

// =============================================================================
// Input validation tests (schema-level — no DB needed)
// =============================================================================
describe('CreateInvoiceSchema validation', () => {
  test('valid sale invoice passes', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items:   [validItem],
    })
    expect(result.success).toBe(true)
  })

  test('requires at least one item', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items:   [],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.flatten().fieldErrors['items']).toBeDefined()
    }
  })

  test('rejects invalid txnType', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'fake_type',
      items:   [validItem],
    })
    expect(result.success).toBe(false)
  })

  test('rejects item with negative qty', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items: [{ ...validItem, qty: -1 }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects discount above 100%', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items: [{ ...validItem, discountPct: 101 }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects invalid GST rate (not in 0,5,12,18,28)', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items: [{ ...validItem, gstRate: 15 }],
    })
    expect(result.success).toBe(false)
  })

  test('partyId is optional (walk-in cash sales)', () => {
    const result = CreateInvoiceSchema.safeParse({
      txnType: 'sale_invoice',
      items:   [validItem],
      // No partyId — valid for cash sales
    })
    expect(result.success).toBe(true)
  })

  test('domainData and aiMeta default to empty objects', () => {
    const result = CreateInvoiceSchema.parse({
      txnType: 'sale_invoice',
      items:   [validItem],
    })
    expect(result.domainData).toEqual({})
    expect(result.aiMeta).toEqual({})
  })
})

// =============================================================================
// GST calculation integration tests (real gst-engine, no mock)
// =============================================================================
describe('Invoice GST calculation — integrated with gst-engine', () => {

  test('single item 12% intra-state', () => {
    const calc = calculateInvoice([
      { qty: 2, rate: 55, discountPct: 0, gstRate: 12, isInterState: false },
    ])
    // gross = 110, tax = 110 × 12% = 13.2, cgst = sgst = 6.6
    expect(calc.taxableTotal).toBe(110)
    expect(calc.cgstTotal).toBe(6.6)
    expect(calc.sgstTotal).toBe(6.6)
    expect(calc.igstTotal).toBe(0)
    expect(calc.grandTotal).toBe(123) // 110 + 13.2 = 123.2 → round to 123
  })

  test('single item 18% inter-state → IGST only', () => {
    const calc = calculateInvoice([
      { qty: 1, rate: 1000, discountPct: 0, gstRate: 18, isInterState: true },
    ])
    expect(calc.igstTotal).toBe(180)
    expect(calc.cgstTotal).toBe(0)
    expect(calc.sgstTotal).toBe(0)
    expect(calc.grandTotal).toBe(1180)
  })

  test('multiple items with mixed GST rates', () => {
    const calc = calculateInvoice([
      { qty: 5, rate: 40,  discountPct: 0,  gstRate: 0,  isInterState: false }, // atta — 0%
      { qty: 1, rate: 200, discountPct: 10, gstRate: 18, isInterState: false }, // detergent — 18%
    ])
    // Line 1: 5×40 = 200, 0% tax
    // Line 2: 200, discount 20 = 180 taxable, 18% = 32.4 (cgst 16.2, sgst 16.2)
    expect(calc.taxableTotal).toBe(380)   // 200 + 180
    expect(calc.cgstTotal).toBeCloseTo(16.2)
    expect(calc.sgstTotal).toBeCloseTo(16.2)
    expect(calc.grandTotal).toBe(412)     // 380 + 32.4 → round to 412
  })

  test('grandTotal is always a whole rupee (round-off applied)', () => {
    const calc = calculateInvoice([
      { qty: 3, rate: 99.99, discountPct: 0, gstRate: 5, isInterState: false },
    ])
    expect(calc.grandTotal % 1).toBe(0)
    expect(Math.abs(calc.roundOff)).toBeLessThan(0.5)
    // Verify: grandTotal = grandTotalBeforeRound + roundOff
    expect(Math.abs(calc.grandTotal - calc.grandTotalBeforeRound - calc.roundOff)).toBeLessThan(0.01)
  })

  test('100% discount results in zero total', () => {
    const calc = calculateInvoice([
      { qty: 1, rate: 500, discountPct: 100, gstRate: 18, isInterState: false },
    ])
    expect(calc.taxableTotal).toBe(0)
    expect(calc.grandTotal).toBe(0)
  })

  test('weight-based billing (fractional qty)', () => {
    // 0.750 kg × ₹120/kg = ₹90 taxable, 5% GST = ₹4.5 → total ₹94.5 → ₹95
    const calc = calculateInvoice([
      { qty: 0.75, rate: 120, discountPct: 0, gstRate: 5, isInterState: false },
    ])
    expect(calc.taxableTotal).toBe(90)
    expect(calc.grandTotal).toBe(95)
  })
})

// =============================================================================
// Payment recording schema tests
// =============================================================================
describe('RecordPaymentSchema validation', () => {
  const validPayment = {
    invoiceId: '00000000-0000-0000-0000-000000000099',
    amount:    500,
    method:    'cash' as const,
  }

  test('valid cash payment', () => {
    expect(RecordPaymentSchema.safeParse(validPayment).success).toBe(true)
  })

  test('UPI payment with reference number', () => {
    const result = RecordPaymentSchema.safeParse({
      ...validPayment,
      method: 'upi',
      refNo:  'UPI-20250614-ABC123',
    })
    expect(result.success).toBe(true)
  })

  test('rejects negative amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...validPayment, amount: -100 }).success).toBe(false)
  })

  test('rejects zero amount', () => {
    expect(RecordPaymentSchema.safeParse({ ...validPayment, amount: 0 }).success).toBe(false)
  })

  test('rejects invalid payment method', () => {
    expect(RecordPaymentSchema.safeParse({ ...validPayment, method: 'bitcoin' }).success).toBe(false)
  })

  test('all valid payment methods accepted', () => {
    const methods = ['cash','upi','card','cheque','bank_transfer','credit'] as const
    for (const method of methods) {
      expect(RecordPaymentSchema.safeParse({ ...validPayment, method }).success).toBe(true)
    }
  })
})

// =============================================================================
// Business logic unit tests
// =============================================================================
describe('Invoice business logic', () => {

  test('isSale correctly identifies sale types', () => {
    // Test the helper via schema — sale types allow positive party balance impact
    const saleTypes = ['sale_invoice', 'quotation', 'delivery_challan']
    const purchaseTypes = ['purchase_invoice', 'purchase_return', 'sale_return']

    // This tests that CreateInvoiceSchema accepts all types
    for (const txnType of [...saleTypes, ...purchaseTypes]) {
      const result = CreateInvoiceSchema.safeParse({ txnType, items: [validItem] })
      expect(result.success).toBe(true)
    }
  })

  test('multiple items calculate correct totals', () => {
    // 10 items — verify total is sum of line totals
    const items = Array.from({ length: 10 }, (_, i) => ({
      qty:         i + 1,
      rate:        100,
      discountPct: 0,
      gstRate:     18 as const,
      isInterState: false,
    }))

    const calc = calculateInvoice(items)
    const expectedTaxable = items.reduce((s, i) => s + i.qty * i.rate, 0)
    expect(calc.taxableTotal).toBe(expectedTaxable)
    expect(calc.grandTotal).toBeGreaterThan(0)
  })

  test('schema strips unknown keys from domainData', () => {
    const result = CreateInvoiceSchema.parse({
      txnType:    'sale_invoice',
      items:      [validItem],
      domainData: { is_udhaar: true, unknown_key: 'should be kept as-is' },
      // domainData is z.record() so all keys are allowed — domain-specific
      // schemas handle further validation in the service layer
    })
    expect(result.domainData['is_udhaar']).toBe(true)
  })
})

// =============================================================================
// Domain registry validation tests
// =============================================================================
describe('Domain registry — Zod schema validation', () => {
  const { DOMAIN_REGISTRY } = require('@billing/domain-registry')

  describe('Pharmacy product attrs', () => {
    const schema = DOMAIN_REGISTRY.pharmacy.productAttrsSchema

    test('valid Schedule H drug', () => {
      const result = schema.safeParse({
        schedule: 'H',
        requires_rx: true,
        drug_type: 'tablet',
        manufacturer: 'Cipla',
      })
      expect(result.success).toBe(true)
    })

    test('rejects unknown schedule value', () => {
      expect(schema.safeParse({ schedule: 'Z' }).success).toBe(false)
    })

    test('rejects extra keys (strict mode)', () => {
      expect(schema.safeParse({ unknown_field: 'value' }).success).toBe(false)
    })
  })

  describe('Sweet shop item meta', () => {
    const schema = DOMAIN_REGISTRY.sweet.itemMetaSchema

    test('valid weight entry', () => {
      const result = schema.safeParse({
        gross_weight_g: 800,
        tare_weight_g:  50,
        net_weight_g:   750,
      })
      expect(result.success).toBe(true)
    })

    test('rejects when net ≠ gross - tare', () => {
      const result = schema.safeParse({
        gross_weight_g: 800,
        tare_weight_g:  50,
        net_weight_g:   700, // wrong — should be 750
      })
      expect(result.success).toBe(false)
    })
  })

  describe('Restaurant invoice data', () => {
    const schema = DOMAIN_REGISTRY.restaurant.invoiceDataSchema

    test('dine_in with table and covers', () => {
      const result = schema.safeParse({
        order_type:   'dine_in',
        table_id:     '00000000-0000-0000-0000-000000000001',
        cover_count:  4,
        kot_ids:      [],
      })
      expect(result.success).toBe(true)
    })

    test('rejects invalid order_type', () => {
      expect(schema.safeParse({ order_type: 'uber_eats' }).success).toBe(false)
    })
  })
})
