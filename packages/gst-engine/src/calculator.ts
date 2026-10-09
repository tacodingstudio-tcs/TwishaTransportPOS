// =============================================================================
// packages/gst-engine/src/calculator.ts
//
// Pure, deterministic GST calculation functions.
// NO database calls. NO AI. NO side effects.
// This is the ONLY source of truth for tax math in the entire platform.
//
// All AI-extracted invoice data MUST pass through these functions before
// being saved. The AI suggests, these functions confirm.
// =============================================================================

export type GSTRate = 0 | 5 | 12 | 18 | 28

export interface LineItemInput {
  qty: number
  rate: number
  discountPct: number   // 0–100
  gstRate: GSTRate
  gstExempt?: boolean
  isInterState: boolean // true → IGST only, false → CGST + SGST split
}

export interface LineItemResult {
  grossAmt: number      // qty × rate (before discount)
  discountAmt: number   // grossAmt × discountPct / 100
  taxableAmt: number    // grossAmt − discountAmt
  gstRate: number
  cgstAmt: number       // taxableAmt × (gstRate / 2) / 100  [intra-state]
  sgstAmt: number       // taxableAmt × (gstRate / 2) / 100  [intra-state]
  igstAmt: number       // taxableAmt × gstRate / 100         [inter-state]
  total: number         // taxableAmt + cgst + sgst (or + igst)
}

export interface InvoiceTotals {
  subtotal: number      // sum of all grossAmt
  discountTotal: number // sum of all discountAmt
  taxableTotal: number  // sum of all taxableAmt
  cgstTotal: number
  sgstTotal: number
  igstTotal: number
  grandTotalBeforeRound: number
  roundOff: number      // diff to make grandTotal a whole rupee
  grandTotal: number    // always a whole rupee
  lines: LineItemResult[]
}

// Round to 2 decimal places using banker's rounding
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

// =============================================================================
// calculateLineItem
// Calculates tax amounts for a single invoice line item.
// =============================================================================
export function calculateLineItem(input: LineItemInput): LineItemResult {
  const grossAmt   = round2(input.qty * input.rate)
  const discountAmt = round2(grossAmt * (input.discountPct / 100))
  const taxableAmt  = round2(grossAmt - discountAmt)

  if (input.gstExempt || input.gstRate === 0) {
    return { grossAmt, discountAmt, taxableAmt, gstRate: 0,
             cgstAmt: 0, sgstAmt: 0, igstAmt: 0, total: taxableAmt }
  }

  const gstAmount = round2(taxableAmt * (input.gstRate / 100))

  if (input.isInterState) {
    return { grossAmt, discountAmt, taxableAmt, gstRate: input.gstRate,
             cgstAmt: 0, sgstAmt: 0, igstAmt: gstAmount,
             total: round2(taxableAmt + gstAmount) }
  }

  const halfGst = round2(gstAmount / 2)
  // Ensure CGST + SGST exactly equals gstAmount (handle odd paisa)
  const cgstAmt = halfGst
  const sgstAmt = round2(gstAmount - halfGst)

  return { grossAmt, discountAmt, taxableAmt, gstRate: input.gstRate,
           cgstAmt, sgstAmt, igstAmt: 0,
           total: round2(taxableAmt + cgstAmt + sgstAmt) }
}

// =============================================================================
// calculateInvoice
// Calculates all totals for an entire invoice.
// grandTotal is always rounded to nearest rupee.
// =============================================================================
export function calculateInvoice(
  items: LineItemInput[]
): InvoiceTotals {
  const lines = items.map(calculateLineItem)

  const subtotal    = round2(lines.reduce((s, l) => s + l.grossAmt, 0))
  const discountTotal = round2(lines.reduce((s, l) => s + l.discountAmt, 0))
  const taxableTotal  = round2(lines.reduce((s, l) => s + l.taxableAmt, 0))
  const cgstTotal   = round2(lines.reduce((s, l) => s + l.cgstAmt, 0))
  const sgstTotal   = round2(lines.reduce((s, l) => s + l.sgstAmt, 0))
  const igstTotal   = round2(lines.reduce((s, l) => s + l.igstAmt, 0))

  const grandTotalBeforeRound = round2(taxableTotal + cgstTotal + sgstTotal + igstTotal)
  const grandTotal  = Math.round(grandTotalBeforeRound) // whole rupee
  const roundOff    = round2(grandTotal - grandTotalBeforeRound)

  return {
    subtotal, discountTotal, taxableTotal,
    cgstTotal, sgstTotal, igstTotal,
    grandTotalBeforeRound, roundOff, grandTotal, lines,
  }
}

// =============================================================================
// validateAIExtraction
// Call this on every AI-extracted invoice BEFORE saving.
// Returns the correctly calculated values — AI output for amounts is ignored.
// =============================================================================
export function validateAIExtraction(
  aiItems: Array<{ qty: number; rate: number; discountPct?: number; gstRate?: number }>,
  isInterState: boolean
): InvoiceTotals {
  const inputs: LineItemInput[] = aiItems.map((item) => ({
    qty: item.qty,
    rate: item.rate,
    discountPct: item.discountPct ?? 0,
    gstRate: (item.gstRate ?? 0) as GSTRate,
    isInterState,
  }))
  return calculateInvoice(inputs)
}
