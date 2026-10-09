// apps/api/src/services/ai/invoiceExtractor.ts
//
// Conversational invoice creation: free-text or voice-transcribed input
// ("Ramesh ne 10 kilo chawal liya 50 rupaye kilo") becomes a structured,
// validated, ready-to-confirm invoice draft.
//
// PIPELINE (mirrors the architecture diagram built earlier):
//   1. Claude (Haiku) extracts intent + raw entities — NEVER calculates totals
//   2. Zod validates the shape of what Claude returned
//   3. Entity resolution: fuzzy-match partyHint -> real party, item names -> real products
//   4. Rule-based GST engine recalculates ALL amounts independently
//   5. Return a structured draft for the cashier to review and confirm
//
// CRITICAL RULE: Claude's output never reaches the database directly.
// It only ever produces a *draft* that a human confirms, and even then,
// every numeric value is recalculated by the deterministic engine before
// the invoice is saved (see invoice.service.ts createInvoice flow).

import { db } from '@billing/db'
import { calculateInvoice, type GSTRate } from '@billing/gst-engine'
import { ai, parseAIJson } from '../../lib/ai-provider.js'

type TenantDb = typeof db
import {
  ExtractedInvoiceSchema,
  type ExtractedInvoice,
} from './extraction.schemas.js'

const SYSTEM_PROMPT = `You are a billing assistant for an Indian small business.
Extract a structured invoice draft from the user's message, which may be in
Hindi, Gujarati, Marathi, Tamil, or English, often mixed together.

Return ONLY valid JSON matching this exact shape, nothing else — no markdown
fences, no explanation:

{
  "intent": "CREATE_INVOICE" | "ADD_PAYMENT" | "CHECK_STOCK" | "QUERY_REPORT" | "CREATE_PARTY" | "UNKNOWN",
  "partyHint": "customer name as the user said it, or null",
  "items": [
    { "name": "product name as mentioned", "qty": number, "unit": "kg|pcs|l|box|etc",
      "rate": number or null if not mentioned, "discountPct": number, default 0 }
  ],
  "dateHint": "aaj | kal | a specific date mentioned | null",
  "notes": "anything else relevant, or null",
  "confidence": 0.0 to 1.0,
  "ambiguities": ["list any unclear fields, e.g. 'party name unclear', 'rate not given for chawal'"]
}

STRICT RULES:
- NEVER calculate or guess GST amounts, taxable amounts, or totals. Leave rate as
  null if the user didn't state a price — the system will use the catalogue price.
- If the party name is ambiguous or could match multiple people, lower confidence
  below 0.7 and list it in ambiguities.
- "aaj" = today, "kal" can mean yesterday OR tomorrow depending on context — if
  unclear, put the raw word in dateHint and let the system resolve it.
- If the message doesn't look like a billing request at all, set intent to UNKNOWN.
- Quantities like "do kilo" = 2 kg, "ek dozen" = 12 pcs — convert spoken numbers.
- Do not invent products or customers that weren't mentioned.`

// =============================================================================
// extractInvoiceIntent
// Step 1+2: Claude extraction + Zod validation
// =============================================================================
export async function extractInvoiceIntent(
  userText: string
): Promise<ExtractedInvoice> {
  const rawText = await ai.chat({ system: SYSTEM_PROMPT, prompt: userText, maxTokens: 1024, quality: 'fast' })

  let parsed: unknown
  try {
    parsed = parseAIJson(rawText) ?? JSON.parse('{}')
  } catch {
    return {
      intent: 'UNKNOWN', partyHint: null, items: [], dateHint: null,
      notes: null, confidence: 0, ambiguities: ['AI returned unparseable response'],
    }
  }

  const result = ExtractedInvoiceSchema.safeParse(parsed)
  if (!result.success) {
    return {
      intent: 'UNKNOWN', partyHint: null, items: [], dateHint: null,
      notes: null, confidence: 0,
      ambiguities: ['AI response did not match expected schema'],
    }
  }

  return result.data
}

// =============================================================================
// Entity resolution types
// =============================================================================
export interface ResolvedLineItem {
  raw:            { name: string; qty: number; unit: string; rate: number | null; discountPct: number }
  matchedProduct: { id: string; name: string; salePrice: number; gstRate: number; unit: string; hsnSacCode: string | null } | null
  matchConfidence: number   // 0-1, from pg_trgm similarity
  needsConfirmation: boolean
}

export interface ResolvedParty {
  id:   string
  name: string
  matchConfidence: number
}

export interface InvoiceDraft {
  intent:          ExtractedInvoice['intent']
  resolvedParty:   ResolvedParty | null
  partyHint:        string | null
  resolvedItems:     ResolvedLineItem[]
  calculatedTotals:   ReturnType<typeof calculateInvoice> | null
  dateResolved:        string  // ISO date
  notes:                string | null
  overallConfidence:     number
  needsReview:             boolean
  ambiguities:               string[]
}

// =============================================================================
// resolveParty
// Fuzzy-matches the AI-extracted party name against real parties using
// the same pg_trgm similarity index used by the regular product search.
// =============================================================================
async function resolveParty(
  partyHint: string | null,
  branchId:  string,
  tenantDb:  TenantDb
): Promise<ResolvedParty | null> {
  if (!partyHint) return null

  const parties = await tenantDb.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id::text, name FROM parties
    WHERE "branchId" = ${branchId}::uuid AND "isActive" = true LIMIT 500
  `.catch(() => [] as any[])

  const query = partyHint.toLowerCase().trim()
  let best: (typeof parties)[number] | null = null
  let bestScore = 0
  for (const p of parties) {
    const pName = p.name.toLowerCase()
    if (pName.includes(query) || query.includes(pName)) {
      const score = Math.min(query.length, pName.length) / Math.max(query.length, pName.length)
      if (score > bestScore) { bestScore = score; best = p }
    }
  }

  if (!best || bestScore < 0.4) return null
  return { id: best.id, name: best.name, matchConfidence: bestScore }
}

// =============================================================================
// convertUnits
// When user says "2 kg" but product is sold as "100g pcs", convert to 20 pcs.
// Parses weight from product name (e.g. "Amul Butter 100g" → 100g per piece).
// Returns null if no conversion needed or not possible.
// =============================================================================
function convertUnits(
  userQty:     number,
  userUnit:    string,
  productName: string,
  productUnit: string,
): number | null {
  const u = (userUnit ?? '').toLowerCase().trim()
  const p = (productUnit ?? '').toLowerCase().trim()

  // Same unit — no conversion needed
  if (u === p || u === '' || p === '') return null

  // User said weight (kg/g), product sold as pieces — parse weight from product name
  if ((u === 'kg' || u === 'g') && p === 'pcs') {
    // Extract weight from name like "100g", "250g", "500g", "1kg"
    const match = productName.match(/(\d+(?:\.\d+)?)\s*(g|gm|gram|kg)/i)
    if (!match) return null

    const [, num, unit] = match
    const perPieceGrams = unit!.toLowerCase().startsWith('kg')
      ? parseFloat(num!) * 1000
      : parseFloat(num!)

    const userGrams = u === 'kg' ? userQty * 1000 : userQty
    return Math.round(userGrams / perPieceGrams)
  }

  // User said pieces, product sold per kg — rare but handle
  if (u === 'pcs' && (p === 'kg' || p === 'g')) {
    return null   // can't convert without knowing piece weight
  }

  // kg ↔ g
  if (u === 'kg' && p === 'g') return userQty * 1000
  if (u === 'g'  && p === 'kg') return userQty / 1000

  // ltr ↔ ml
  if (u === 'ltr' && p === 'ml') return userQty * 1000
  if (u === 'ml'  && p === 'ltr') return userQty / 1000

  return null
}

// =============================================================================
// resolveLineItems
// Fuzzy-matches each AI-extracted item name against the product catalogue.
// =============================================================================
async function resolveLineItems(
  items:    ExtractedInvoice['items'],
  branchId: string,
  tenantDb: TenantDb
): Promise<ResolvedLineItem[]> {
  const resolved: ResolvedLineItem[] = []

  // Load all active products once, then match in JS (avoids pg_trgm dependency)
  const allProducts = await tenantDb.$queryRaw<Array<{
    id: string; name: string; sale_price: number; gst_rate: number
    unit: string; hsn_sac_code: string | null
  }>>`
    SELECT id::text, name, "salePrice"::float AS sale_price, "gstRate"::float AS gst_rate,
           unit, "hsnSacCode" AS hsn_sac_code
    FROM products
    WHERE "branchId" = ${branchId}::uuid AND "isActive" = true
    LIMIT 500
  `.catch(() => [] as any[])

  for (const item of items) {
    const query = item.name.toLowerCase().trim()
    const queryWords = query.split(/\s+/).filter(w => w.length > 2)

    // Score each product: count matching words
    let bestMatch: (typeof allProducts)[number] | null = null
    let bestScore = 0

    for (const p of allProducts) {
      const pName = p.name.toLowerCase()
      // Exact substring match scores highest
      if (pName.includes(query) || query.includes(pName)) {
        const score = Math.min(query.length, pName.length) / Math.max(query.length, pName.length)
        if (score > bestScore) { bestScore = score; bestMatch = p }
      } else {
        // Word overlap score
        const wordScore = queryWords.filter(w => pName.includes(w)).length / Math.max(queryWords.length, 1)
        if (wordScore >= 0.5 && wordScore > bestScore) { bestScore = wordScore; bestMatch = p }
      }
    }

    // Unit conversion: e.g. user says "2 kg", product is "Amul Butter 100g" (pcs)
    // → convert 2 kg = 2000g → 2000/100 = 20 pcs
    let resolvedQty = item.qty
    if (bestMatch && bestScore > 0.4) {
      const converted = convertUnits(item.qty, item.unit, bestMatch.name, bestMatch.unit)
      if (converted !== null) resolvedQty = converted
    }

    resolved.push({
      raw: { name: item.name, qty: resolvedQty, unit: item.unit, rate: item.rate, discountPct: item.discountPct },
      matchedProduct: bestMatch && bestScore > 0.4
        ? { id: bestMatch.id, name: bestMatch.name, salePrice: bestMatch.sale_price,
            gstRate: bestMatch.gst_rate, unit: bestMatch.unit, hsnSacCode: bestMatch.hsn_sac_code }
        : null,
      matchConfidence: bestScore,
      needsConfirmation: !bestMatch || bestScore < 0.4,
    })
  }

  return resolved
}

// =============================================================================
// resolveDateHint
// =============================================================================
function resolveDateHint(hint: string | null): string {
  const today = new Date()
  if (!hint) return today.toISOString().slice(0, 10)

  const normalized = hint.toLowerCase().trim()
  if (['aaj', 'today', 'aj'].includes(normalized)) {
    return today.toISOString().slice(0, 10)
  }
  if (['kal', 'yesterday'].includes(normalized)) {
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    return yesterday.toISOString().slice(0, 10)
  }
  // Anything else — fall back to today, flagged in ambiguities upstream
  return today.toISOString().slice(0, 10)
}

// =============================================================================
// buildInvoiceDraft — the full pipeline, steps 1 through 4
// =============================================================================
export async function buildInvoiceDraft(
  userText: string,
  tenantId: string,
  branchId: string,
  tenantDb?: TenantDb
): Promise<InvoiceDraft> {
  const tdb = tenantDb ?? db
  // Step 1+2: extract + validate
  const extracted = await extractInvoiceIntent(userText)

  if (extracted.intent !== 'CREATE_INVOICE' || extracted.items.length === 0) {
    return {
      intent: extracted.intent,
      resolvedParty: null,
      partyHint: extracted.partyHint,
      resolvedItems: [],
      calculatedTotals: null,
      dateResolved: resolveDateHint(extracted.dateHint),
      notes: extracted.notes,
      overallConfidence: extracted.confidence,
      needsReview: true,
      ambiguities: extracted.ambiguities,
    }
  }

  // Step 3: entity resolution (fuzzy match against real DB records)
  const [resolvedParty, resolvedItems] = await Promise.all([
    resolveParty(extracted.partyHint, branchId, tdb),
    resolveLineItems(extracted.items, branchId, tdb),
  ])

  // Step 4: rule-based GST calculation — ONLY using resolved/confirmed data.
  // Uses catalogue price when AI didn't extract a rate (rate === null).
  const allItemsResolved = resolvedItems.every((r) => r.matchedProduct !== null)

  let calculatedTotals: ReturnType<typeof calculateInvoice> | null = null
  if (allItemsResolved) {
    calculatedTotals = calculateInvoice(
      resolvedItems.map((r) => ({
        qty:          r.raw.qty,
        rate:         r.raw.rate ?? r.matchedProduct!.salePrice,
        discountPct:  r.raw.discountPct,
        gstRate:      r.matchedProduct!.gstRate as GSTRate,
        isInterState: false,  // mobile/voice billing assumes intra-state; corrected if needed at confirm
      }))
    )
  }

  // Aggregate ambiguities: AI's own flags + any item that needs human confirmation
  const itemAmbiguities = resolvedItems
    .filter((r) => r.needsConfirmation)
    .map((r) => `Could not confidently match "${r.raw.name}" to a product`)

  const partyAmbiguity =
    extracted.partyHint && !resolvedParty
      ? [`Could not find a customer matching "${extracted.partyHint}"`]
      : []

  const allAmbiguities = [...extracted.ambiguities, ...itemAmbiguities, ...partyAmbiguity]

  return {
    intent:          extracted.intent,
    resolvedParty,
    partyHint:        extracted.partyHint,
    resolvedItems,
    calculatedTotals,
    dateResolved:       resolveDateHint(extracted.dateHint),
    notes:                extracted.notes,
    overallConfidence:      Math.min(
      extracted.confidence,
      resolvedItems.length > 0
        ? resolvedItems.reduce((s, r) => s + r.matchConfidence, 0) / resolvedItems.length
        : 0
    ),
    needsReview: allAmbiguities.length > 0 || !allItemsResolved,
    ambiguities: allAmbiguities,
  }
}
