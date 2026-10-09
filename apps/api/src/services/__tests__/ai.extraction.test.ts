// apps/api/src/services/__tests__/ai.extraction.test.ts
//
// Tests the Zod validation layer for AI outputs — the most important
// safety net in the AI pipeline. These tests verify that malformed or
// out-of-range AI responses are REJECTED, not silently accepted.

import {
  ExtractedInvoiceSchema,
  OCRBillSchema,
  HSNSuggestionSchema,
  HSNSuggestionListSchema,
  PaymentReminderDraftSchema,
} from '../ai/extraction.schemas.js'

// =============================================================================
// ExtractedInvoiceSchema — conversational billing extraction
// =============================================================================
describe('ExtractedInvoiceSchema', () => {
  const validExtraction = {
    intent: 'CREATE_INVOICE',
    partyHint: 'Ramesh',
    items: [
      { name: 'chawal', qty: 10, unit: 'kg', rate: 50, discountPct: 0 },
    ],
    dateHint: 'aaj',
    notes: null,
    confidence: 0.9,
    ambiguities: [],
  }

  test('valid extraction passes', () => {
    expect(ExtractedInvoiceSchema.safeParse(validExtraction).success).toBe(true)
  })

  test('rejects invalid intent', () => {
    const result = ExtractedInvoiceSchema.safeParse({ ...validExtraction, intent: 'DELETE_EVERYTHING' })
    expect(result.success).toBe(false)
  })

  test('rejects confidence above 1.0', () => {
    expect(ExtractedInvoiceSchema.safeParse({ ...validExtraction, confidence: 1.5 }).success).toBe(false)
  })

  test('rejects negative confidence', () => {
    expect(ExtractedInvoiceSchema.safeParse({ ...validExtraction, confidence: -0.1 }).success).toBe(false)
  })

  test('allows null partyHint (walk-in customer)', () => {
    const result = ExtractedInvoiceSchema.safeParse({ ...validExtraction, partyHint: null })
    expect(result.success).toBe(true)
  })

  test('allows null rate on a line item (use catalogue price)', () => {
    const result = ExtractedInvoiceSchema.safeParse({
      ...validExtraction,
      items: [{ name: 'chawal', qty: 10, unit: 'kg', rate: null, discountPct: 0 }],
    })
    expect(result.success).toBe(true)
  })

  test('rejects negative quantity', () => {
    const result = ExtractedInvoiceSchema.safeParse({
      ...validExtraction,
      items: [{ name: 'chawal', qty: -5, unit: 'kg', rate: 50, discountPct: 0 }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects discount over 100%', () => {
    const result = ExtractedInvoiceSchema.safeParse({
      ...validExtraction,
      items: [{ name: 'chawal', qty: 1, unit: 'kg', rate: 50, discountPct: 150 }],
    })
    expect(result.success).toBe(false)
  })

  test('empty items array defaults correctly for non-CREATE_INVOICE intents', () => {
    const result = ExtractedInvoiceSchema.parse({
      intent: 'CHECK_STOCK', partyHint: null, dateHint: null,
      notes: null, confidence: 0.8, ambiguities: [],
    })
    expect(result.items).toEqual([])
  })

  test('UNKNOWN intent is a valid safe fallback', () => {
    const result = ExtractedInvoiceSchema.safeParse({
      intent: 'UNKNOWN', partyHint: null, items: [], dateHint: null,
      notes: null, confidence: 0, ambiguities: ['gibberish input'],
    })
    expect(result.success).toBe(true)
  })
})

// =============================================================================
// OCRBillSchema — bill photo extraction
// =============================================================================
describe('OCRBillSchema', () => {
  const validBill = {
    supplierName: 'Metro Cash & Carry',
    supplierGstin: '24AAACC5678B1Z1',
    billNo: 'INV-9981',
    billDate: '2025-06-10',
    items: [
      { name: 'Amul Butter 100g', qty: 50, unit: 'pcs', rate: 48, hsnCode: '04051000', gstRate: 12, total: 2400 },
    ],
    grandTotal: 2688,
    confidence: 0.88,
  }

  test('valid bill passes', () => {
    expect(OCRBillSchema.safeParse(validBill).success).toBe(true)
  })

  test('requires at least one item', () => {
    expect(OCRBillSchema.safeParse({ ...validBill, items: [] }).success).toBe(false)
  })

  test('rejects invalid GST rate from OCR (e.g. misread as 15%)', () => {
    const result = OCRBillSchema.safeParse({
      ...validBill,
      items: [{ ...validBill.items[0], gstRate: 15 }],
    })
    expect(result.success).toBe(false)
  })

  test('allows null gstRate when not visible on bill', () => {
    const result = OCRBillSchema.safeParse({
      ...validBill,
      items: [{ ...validBill.items[0], gstRate: null }],
    })
    expect(result.success).toBe(true)
  })

  test('allows null supplierName for illegible bills', () => {
    expect(OCRBillSchema.safeParse({ ...validBill, supplierName: null }).success).toBe(true)
  })

  test('rejects negative rate', () => {
    const result = OCRBillSchema.safeParse({
      ...validBill,
      items: [{ ...validBill.items[0], rate: -10 }],
    })
    expect(result.success).toBe(false)
  })
})

// =============================================================================
// HSNSuggestionSchema
// =============================================================================
describe('HSNSuggestionSchema', () => {
  test('valid suggestion', () => {
    const result = HSNSuggestionSchema.safeParse({
      hsnCode: '04051000', description: 'Butter', gstRate: 12, confidence: 0.95,
    })
    expect(result.success).toBe(true)
  })

  test('rejects HSN code under 4 chars', () => {
    expect(HSNSuggestionSchema.safeParse({
      hsnCode: '04', description: 'Butter', gstRate: 12, confidence: 0.9,
    }).success).toBe(false)
  })

  test('list schema caps at 5 suggestions', () => {
    const sixSuggestions = Array.from({ length: 6 }, (_, i) => ({
      hsnCode: `0405100${i}`, description: 'Item', gstRate: 12, confidence: 0.8,
    }))
    expect(HSNSuggestionListSchema.safeParse(sixSuggestions).success).toBe(false)
  })

  test('list of 3 suggestions is valid', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({
      hsnCode: `0405100${i}`, description: 'Item', gstRate: 12, confidence: 0.8,
    }))
    expect(HSNSuggestionListSchema.safeParse(three).success).toBe(true)
  })
})

// =============================================================================
// PaymentReminderDraftSchema
// =============================================================================
describe('PaymentReminderDraftSchema', () => {
  test('valid Hindi reminder', () => {
    const result = PaymentReminderDraftSchema.safeParse({
      message: 'Namaste Ramesh ji, aapka Rs 500 baaki hai. Dhanyawad.',
      tone: 'friendly',
      language: 'hi',
    })
    expect(result.success).toBe(true)
  })

  test('rejects invalid tone', () => {
    expect(PaymentReminderDraftSchema.safeParse({
      message: 'test message here', tone: 'angry', language: 'hi',
    }).success).toBe(false)
  })

  test('rejects unsupported language', () => {
    expect(PaymentReminderDraftSchema.safeParse({
      message: 'test message here', tone: 'friendly', language: 'fr',
    }).success).toBe(false)
  })

  test('rejects message under 10 chars (too short to be useful)', () => {
    expect(PaymentReminderDraftSchema.safeParse({
      message: 'pay now', tone: 'urgent', language: 'en',
    }).success).toBe(false)
  })

  test('rejects message over 500 chars (too long for WhatsApp reminder)', () => {
    expect(PaymentReminderDraftSchema.safeParse({
      message: 'x'.repeat(501), tone: 'friendly', language: 'en',
    }).success).toBe(false)
  })

  test('all five supported languages are valid', () => {
    for (const language of ['hi', 'gu', 'en', 'mr', 'ta'] as const) {
      const result = PaymentReminderDraftSchema.safeParse({
        message: 'A valid reminder message here for testing.', tone: 'friendly', language,
      })
      expect(result.success).toBe(true)
    }
  })
})

// =============================================================================
// Malformed AI response simulation
// Tests the kind of garbage a real LLM call might occasionally return,
// and confirms our schemas correctly reject it.
// =============================================================================
describe('Defensive parsing — simulated malformed AI responses', () => {
  test('extra unexpected fields do not break extraction (non-strict)', () => {
    // ExtractedInvoiceSchema is intentionally NOT .strict() since AI may add
    // harmless extra commentary fields — only domain attribute schemas are strict
    const withExtra = {
      intent: 'CREATE_INVOICE', partyHint: 'Ramesh',
      items: [{ name: 'chawal', qty: 1, unit: 'kg', rate: 50, discountPct: 0 }],
      dateHint: null, notes: null, confidence: 0.9, ambiguities: [],
      unexpectedExtraField: 'should be ignored, not crash',
    }
    expect(ExtractedInvoiceSchema.safeParse(withExtra).success).toBe(true)
  })

  test('completely empty object fails validation', () => {
    expect(ExtractedInvoiceSchema.safeParse({}).success).toBe(false)
  })

  test('null instead of object fails validation', () => {
    expect(ExtractedInvoiceSchema.safeParse(null).success).toBe(false)
  })

  test('array instead of object fails validation', () => {
    expect(ExtractedInvoiceSchema.safeParse([]).success).toBe(false)
  })

  test('hallucinated GST rate of 99% is rejected by OCR schema', () => {
    const result = OCRBillSchema.safeParse({
      supplierName: 'Test', supplierGstin: null, billNo: null, billDate: null,
      items: [{ name: 'Item', qty: 1, unit: 'pcs', rate: 100, hsnCode: null, gstRate: 99, total: null }],
      grandTotal: null, confidence: 0.5,
    })
    expect(result.success).toBe(false)
  })
})
