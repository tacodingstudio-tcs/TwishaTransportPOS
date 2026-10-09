// apps/api/src/services/ai/extraction.schemas.ts
//
// Zod schemas for AI output validation.
// Claude's response is ALWAYS parsed through these before touching any
// business logic. If Claude returns malformed JSON or hallucinated fields,
// this layer catches it and the request fails cleanly rather than
// corrupting an invoice.

import { z } from 'zod'

// ── Conversational invoice extraction ────────────────────────────────────────
export const ExtractedLineItemSchema = z.object({
  name:         z.string().min(1).max(200),
  qty:          z.number().positive(),
  unit:         z.string().default('pcs'),
  rate:         z.number().nonnegative().nullable(), // null = "use catalogue price"
  discountPct:  z.number().min(0).max(100).default(0),
})

export const ExtractedInvoiceSchema = z.object({
  intent: z.enum([
    'CREATE_INVOICE', 'ADD_PAYMENT', 'CHECK_STOCK',
    'QUERY_REPORT', 'CREATE_PARTY', 'UNKNOWN',
  ]),
  partyHint:   z.string().nullable(),       // raw name as the user said it
  items:       z.array(ExtractedLineItemSchema).default([]),
  dateHint:    z.string().nullable(),       // "aaj", "kal", "Monday" — resolved separately
  notes:       z.string().nullable(),
  confidence:  z.number().min(0).max(1),
  ambiguities: z.array(z.string()).default([]),
})

export type ExtractedInvoice   = z.infer<typeof ExtractedInvoiceSchema>
export type ExtractedLineItem  = z.infer<typeof ExtractedLineItemSchema>

// ── OCR bill scanning ─────────────────────────────────────────────────────────
export const OCRLineItemSchema = z.object({
  name:    z.string().min(1).max(200),
  qty:     z.number().positive(),
  unit:    z.string().default('pcs'),
  rate:    z.number().nonnegative(),
  hsnCode: z.string().nullable(),
  gstRate: z.number().refine((v) => [0,5,12,18,28].includes(v)).nullable(),
  total:   z.number().nonnegative().nullable(),
})

export const OCRBillSchema = z.object({
  supplierName:  z.string().nullable(),
  supplierGstin: z.string().nullable(),
  billNo:        z.string().nullable(),
  billDate:      z.string().nullable(),  // ISO date string if confidently parsed
  items:         z.array(OCRLineItemSchema).min(1),
  grandTotal:    z.number().nonnegative().nullable(),
  confidence:    z.number().min(0).max(1),
})

export type OCRBill = z.infer<typeof OCRBillSchema>

// ── HSN suggestion (already used by product.service.ts) ─────────────────────
export const HSNSuggestionSchema = z.object({
  hsnCode:     z.string().min(4).max(20),
  description: z.string().max(120),
  gstRate:     z.number().refine((v) => [0,5,12,18,28].includes(v)),
  confidence:  z.number().min(0).max(1),
})

export const HSNSuggestionListSchema = z.array(HSNSuggestionSchema).max(5)

// ── Payment reminder drafting ─────────────────────────────────────────────────
export const PaymentReminderDraftSchema = z.object({
  message:  z.string().min(10).max(500),
  tone:     z.enum(['friendly', 'firm', 'urgent']),
  language: z.enum(['hi', 'gu', 'en', 'mr', 'ta']),
})

export type PaymentReminderDraft = z.infer<typeof PaymentReminderDraftSchema>
