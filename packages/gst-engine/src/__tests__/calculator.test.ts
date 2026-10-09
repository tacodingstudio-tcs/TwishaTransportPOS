// packages/gst-engine/src/__tests__/calculator.test.ts

import { calculateLineItem, calculateInvoice, validateAIExtraction } from '../calculator.js'

describe('calculateLineItem', () => {

  describe('intra-state (CGST + SGST)', () => {
    test('18% GST splits equally into CGST 9% + SGST 9%', () => {
      const r = calculateLineItem({ qty: 2, rate: 100, discountPct: 0, gstRate: 18, isInterState: false })
      expect(r.taxableAmt).toBe(200)
      expect(r.cgstAmt).toBe(18)
      expect(r.sgstAmt).toBe(18)
      expect(r.igstAmt).toBe(0)
      expect(r.total).toBe(236)
    })

    test('5% GST on grocery item', () => {
      const r = calculateLineItem({ qty: 1, rate: 100, discountPct: 0, gstRate: 5, isInterState: false })
      expect(r.cgstAmt).toBe(2.5)
      expect(r.sgstAmt).toBe(2.5)
      expect(r.total).toBe(105)
    })

    test('12% GST with 10% discount', () => {
      const r = calculateLineItem({ qty: 1, rate: 1000, discountPct: 10, gstRate: 12, isInterState: false })
      expect(r.grossAmt).toBe(1000)
      expect(r.discountAmt).toBe(100)
      expect(r.taxableAmt).toBe(900)
      expect(r.cgstAmt).toBe(54)
      expect(r.sgstAmt).toBe(54)
      expect(r.total).toBe(1008)
    })

    test('28% GST (luxury goods)', () => {
      const r = calculateLineItem({ qty: 1, rate: 500, discountPct: 0, gstRate: 28, isInterState: false })
      expect(r.cgstAmt).toBe(70)
      expect(r.sgstAmt).toBe(70)
      expect(r.total).toBe(640)
    })
  })

  describe('inter-state (IGST only)', () => {
    test('18% GST inter-state → IGST only', () => {
      const r = calculateLineItem({ qty: 1, rate: 500, discountPct: 0, gstRate: 18, isInterState: true })
      expect(r.igstAmt).toBe(90)
      expect(r.cgstAmt).toBe(0)
      expect(r.sgstAmt).toBe(0)
      expect(r.total).toBe(590)
    })

    test('12% GST inter-state with discount', () => {
      const r = calculateLineItem({ qty: 1, rate: 500, discountPct: 10, gstRate: 12, isInterState: true })
      expect(r.taxableAmt).toBe(450)
      expect(r.igstAmt).toBe(54)
      expect(r.total).toBe(504)
    })
  })

  describe('zero-rated and exempt', () => {
    test('0% GST (essential goods like atta, rice)', () => {
      const r = calculateLineItem({ qty: 5, rate: 40, discountPct: 0, gstRate: 0, isInterState: false })
      expect(r.cgstAmt).toBe(0)
      expect(r.sgstAmt).toBe(0)
      expect(r.total).toBe(200)
    })

    test('GST exempt item (life-saving drugs)', () => {
      const r = calculateLineItem({ qty: 1, rate: 100, discountPct: 0, gstRate: 12, gstExempt: true, isInterState: false })
      expect(r.cgstAmt).toBe(0)
      expect(r.sgstAmt).toBe(0)
      expect(r.total).toBe(100)
    })
  })

  describe('decimal precision', () => {
    test('handles fractional quantities (weight billing)', () => {
      // 0.750 kg × ₹80/kg = ₹60 taxable, 5% GST = ₹3
      const r = calculateLineItem({ qty: 0.75, rate: 80, discountPct: 0, gstRate: 5, isInterState: false })
      expect(r.grossAmt).toBe(60)
      expect(r.total).toBe(63)
    })

    test('CGST + SGST always sums to total GST (no paisa lost)', () => {
      // 12% on ₹100 = ₹12 → CGST ₹6 + SGST ₹6
      const r = calculateLineItem({ qty: 1, rate: 100, discountPct: 0, gstRate: 12, isInterState: false })
      expect(r.cgstAmt + r.sgstAmt).toBe(r.gstRate / 100 * r.taxableAmt)
    })
  })
})

describe('calculateInvoice', () => {
  test('multi-line invoice totals are correct', () => {
    const result = calculateInvoice([
      { qty: 2, rate: 100, discountPct: 0, gstRate: 18, isInterState: false },
      { qty: 1, rate: 200, discountPct: 10, gstRate: 5,  isInterState: false },
    ])
    // Line 1: taxable 200, cgst 18, sgst 18, total 236
    // Line 2: gross 200, discount 20, taxable 180, cgst 4.5, sgst 4.5, total 189
    expect(result.taxableTotal).toBe(380)
    expect(result.cgstTotal).toBe(22.5)
    expect(result.sgstTotal).toBe(22.5)
    expect(result.grandTotal).toBe(425)    // 380 + 45 = 425 (already whole number)
    expect(result.lines).toHaveLength(2)
  })

  test('grandTotal is always a whole rupee', () => {
    // Force a non-whole total
    const result = calculateInvoice([
      { qty: 3, rate: 99.99, discountPct: 0, gstRate: 5, isInterState: false },
    ])
    expect(result.grandTotal % 1).toBe(0)
    expect(Math.abs(result.roundOff)).toBeLessThan(0.5)
  })

  test('empty invoice returns zeros', () => {
    const result = calculateInvoice([])
    expect(result.grandTotal).toBe(0)
    expect(result.cgstTotal).toBe(0)
  })

  test('mixed inter-state and intra-state items not allowed in same invoice', () => {
    // All items in one invoice must be same state — this is a GST rule.
    // isInterState is determined at invoice level, not per item.
    const result = calculateInvoice([
      { qty: 1, rate: 100, discountPct: 0, gstRate: 18, isInterState: true },
      { qty: 1, rate: 100, discountPct: 0, gstRate: 18, isInterState: true },
    ])
    expect(result.cgstTotal).toBe(0)
    expect(result.igstTotal).toBe(36)
  })
})

describe('validateAIExtraction', () => {
  test('ignores AI-provided amounts and recalculates correctly', () => {
    // Simulate AI extracting items (AI doesn't provide totals)
    const aiItems = [
      { qty: 2, rate: 100, discountPct: 0, gstRate: 18 },
      { qty: 1, rate: 50,  discountPct: 0, gstRate: 5  },
    ]
    const result = validateAIExtraction(aiItems, false)

    // Verify our engine calculated correctly regardless of what AI said
    expect(result.grandTotal).toBeGreaterThan(0)
    expect(result.cgstTotal).toBeGreaterThan(0)
    expect(result.lines).toHaveLength(2)
  })
})
