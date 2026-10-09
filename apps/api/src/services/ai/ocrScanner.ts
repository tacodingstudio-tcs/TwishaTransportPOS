// apps/api/src/services/ai/ocrScanner.ts
//
// Photo of a supplier bill -> structured purchase entry.
// Uses Claude's vision capability (Sonnet, not Haiku — vision needs the
// larger model). Output is validated through the same defensive pattern
// as invoiceExtractor: Zod schema, graceful failure, never trusted for
// final amounts without the rule engine confirming GST math.
//
// Flow:
//   1. Image (base64) -> Claude vision -> structured JSON
//   2. Zod validates shape
//   3. Entity resolution: match extracted item names to existing products
//      (new products get flagged for manual creation, not auto-created)
//   4. Match supplier name to existing party (or flag as new supplier)
//   5. Return a draft purchase_invoice for human review before saving

import { db } from '@billing/db'
import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { OCRBillSchema, type OCRBill } from './extraction.schemas.js'

const OCR_SYSTEM_PROMPT = `You are reading a photo of a supplier invoice/bill
for an Indian small business. Extract all information as structured JSON.

Return ONLY valid JSON matching this exact shape, nothing else:

{
  "supplierName": "name of the company/shop that issued this bill, or null",
  "supplierGstin": "15-character GSTIN if visible, or null",
  "billNo": "invoice/bill number if visible, or null",
  "billDate": "YYYY-MM-DD if confidently readable, or null",
  "items": [
    {
      "name": "product/item name exactly as printed",
      "qty": number,
      "unit": "kg|pcs|box|ltr|etc — use what's printed or infer reasonably",
      "rate": number (per-unit price),
      "hsnCode": "HSN code if printed, or null",
      "gstRate": one of [0,5,12,18,28] if shown, or null if not visible,
      "total": number (line total if printed, or null)
    }
  ],
  "grandTotal": number if visible, or null,
  "confidence": 0.0 to 1.0 — your overall confidence in this extraction
}

RULES:
- If handwriting is illegible, lower confidence and do your best guess —
  never refuse to extract.
- If a quantity or rate is genuinely unreadable, omit that item rather
  than guessing wildly, and mention it would need manual entry.
- Indian bills often print MRP separately from rate — extract the actual
  billed rate, not MRP, when both are shown.
- Numbers may use Indian formatting (1,00,000 = 100000) — parse correctly.`

// =============================================================================
// scanBillImage
// =============================================================================
export async function scanBillImage(
  imageBase64: string,
  mediaType:   'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg'
): Promise<OCRBill> {
  const rawText = await ai.vision({
    system:      OCR_SYSTEM_PROMPT,
    prompt:      'Extract this bill as JSON per the schema in your instructions.',
    imageBase64,
    mediaType,
    maxTokens:   2048,
    quality:     'best',
  })

  let parsed: unknown
  try {
    parsed = parseAIJson(rawText) ?? JSON.parse('{}')
    if (!parsed) throw new Error('empty')
  } catch {
    throw Object.assign(
      new Error('Could not read this bill image — try a clearer photo'),
      { statusCode: 422, code: 'OCR_PARSE_FAILED' }
    )
  }

  const result = OCRBillSchema.safeParse(parsed)
  if (!result.success) {
    throw Object.assign(
      new Error('Bill image was read but did not contain valid line items'),
      { statusCode: 422, code: 'OCR_VALIDATION_FAILED', issues: result.error.flatten() }
    )
  }

  return result.data
}

// =============================================================================
// Resolved purchase draft types
// =============================================================================
export interface OCRResolvedItem {
  raw:             OCRBill['items'][number]
  matchedProduct:  { id: string; name: string; purchasePrice: number | null; gstRate: number } | null
  isNewProduct:    boolean   // true => not found, will need manual product creation
}

export interface OCRResolvedSupplier {
  id:   string
  name: string
} 

export interface PurchaseDraft {
  resolvedSupplier: OCRResolvedSupplier | null
  supplierNameRaw:   string | null
  billNo:             string | null
  billDate:            string | null
  resolvedItems:        OCRResolvedItem[]
  ocrGrandTotal:          number | null
  newProductCount:          number
  confidence:                number
  needsReview:                boolean
}

// =============================================================================
// resolveOCRBill
// Matches extracted supplier and items against the database.
// Items with no match are NOT auto-created — flagged for the purchasing
// screen to handle ("3 items not found in catalogue — add them now?")
// =============================================================================
export async function resolveOCRBill(
  bill:     OCRBill,
  branchId: string,
  tenantDb: typeof db,
): Promise<PurchaseDraft> {
  // Resolve supplier by fuzzy name match
  let resolvedSupplier: OCRResolvedSupplier | null = null
  if (bill.supplierName) {
    const matches = await tenantDb.$queryRaw<Array<{ id: string; name: string; similarity: number }>>`
      SELECT id::text, name, similarity(name, ${bill.supplierName}) AS similarity
      FROM parties
      WHERE "branchId" = ${branchId}::uuid
        AND type IN ('supplier', 'both')
        AND "isActive" = true
        AND name % ${bill.supplierName}
      ORDER BY similarity DESC LIMIT 1
    `.catch(() => [] as any[])
    if (matches.length > 0 && matches[0]!.similarity > 0.35) {
      resolvedSupplier = { id: matches[0]!.id, name: matches[0]!.name }
    }
  }

  // Resolve each item against the product catalogue
  const resolvedItems: OCRResolvedItem[] = []
  for (const item of bill.items) {
    const matches = await tenantDb.$queryRaw<Array<{
      id: string; name: string; purchase_price: number | null; gst_rate: number; similarity: number
    }>>`
      SELECT id::text, name, "purchasePrice"::float AS purchase_price, "gstRate"::float AS gst_rate,
             similarity(name, ${item.name}) AS similarity
      FROM products
      WHERE "branchId" = ${branchId}::uuid AND "isActive" = true
        AND name % ${item.name}
      ORDER BY similarity DESC LIMIT 1
    `.catch(() => [] as any[])

    const match = matches[0] && matches[0].similarity > 0.4 ? matches[0] : undefined

    resolvedItems.push({
      raw: item,
      matchedProduct: match
        ? { id: match.id, name: match.name, purchasePrice: match.purchase_price, gstRate: match.gst_rate }
        : null,
      isNewProduct: !match,
    })
  }

  const newProductCount = resolvedItems.filter((r) => r.isNewProduct).length

  return {
    resolvedSupplier,
    supplierNameRaw: bill.supplierName,
    billNo:           bill.billNo,
    billDate:          bill.billDate,
    resolvedItems,
    ocrGrandTotal:      bill.grandTotal,
    newProductCount,
    confidence:           bill.confidence,
    needsReview: bill.confidence < 0.75 || newProductCount > 0 || !resolvedSupplier,
  }
}
