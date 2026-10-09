// =============================================================================
// apps/api/src/services/product.service.ts
//
// All product operations: create, update, search, stock balance, HSN suggest.
//
// Search strategy:
//   1. Barcode → exact match (fastest, used at POS)
//   2. Name → Postgres trigram similarity (pg_trgm) — handles typos
//   3. Fuzzy — similarity() function returns ranked results
//
// Stock balance:
//   Never stored as a column — always computed from stock_ledger SUM.
//   For list views: use the stock_balance materialised view (fast).
//   For billing checkout: recompute live (accurate).
//
// HSN suggest:
//   Calls Claude claude-haiku-4-5 to suggest HSN code + GST rate from product name.
//   Result stored permanently in product master after one user confirmation.
// =============================================================================

import { Prisma } from '@billing/db'
import type { PrismaClient } from '@billing/db'
import { DOMAIN_REGISTRY, validateProductAttrs, type DomainType } from '@billing/domain-registry'
import { z } from 'zod'
import { ai, parseAIJson } from '../lib/ai-provider.js'

// ── Input schemas ─────────────────────────────────────────────────────────────

// Domain-specific fields accepted at the top level of the request body for
// convenience — they are folded into domainAttrs before being stored.
// This keeps the DB clean (one JSON column) while keeping the API ergonomic.
const domainFieldsSchema = z.object({
  // General Retail
  weightGrams:   z.number().nonnegative().optional(),
  packSize:      z.string().max(100).optional(),
  minOrderQty:   z.number().nonnegative().optional(),
  reorderQty:    z.number().nonnegative().optional(),
  shelfLocation: z.string().max(100).optional(),
  altUnit:       z.string().max(50).optional(),
  altUnitFactor: z.number().nonnegative().optional(),
  taxCategory:   z.string().max(100).optional(),
  // Pharmacy
  drugSchedule:         z.string().max(10).optional(),
  requiresPrescription: z.boolean().optional(),
  genericName:          z.string().max(300).optional(),
  manufacturer:         z.string().max(200).optional(),
  form:                 z.string().max(50).optional(),
  strengthDosage:       z.string().max(100).optional(),
  stripQty:             z.number().int().nonnegative().optional(),
  storageCondition:     z.string().max(50).optional(),
  isNarcotic:           z.boolean().optional(),
  dlNumber:             z.string().max(100).optional(),
  // Electronics
  modelNumber:      z.string().max(100).optional(),
  compatibleModels: z.array(z.string()).optional(),
  isSpare:          z.boolean().optional(),
  warrantyMonths:   z.number().int().nonnegative().optional(),
  colorOptions:     z.array(z.string()).optional(),
  storageOptions:   z.array(z.string()).optional(),
  taxClass:         z.string().max(50).optional(),
  // Tiffin / Food
  mealType:             z.string().max(20).optional(),
  cuisineType:          z.string().max(50).optional(),
  allergens:            z.array(z.string()).optional(),
  caloriesPer100g:      z.number().int().nonnegative().optional(),
  portionSizeGrams:     z.number().int().nonnegative().optional(),
  isAvailableBreakfast: z.boolean().optional(),
  isAvailableLunch:     z.boolean().optional(),
  isAvailableDinner:    z.boolean().optional(),
  preparationTimeMin:   z.number().int().nonnegative().optional(),
  isSeasonalItem:       z.boolean().optional(),
  // Petrol Pump
  fuelGrade:    z.string().max(20).optional(),
  tankId:       z.string().max(20).optional(),
  densityKgL:   z.number().nonnegative().optional(),
  octaneRating: z.number().int().nonnegative().optional(),
  // Gym / Fitness
  servingSizeG:       z.number().int().nonnegative().optional(),
  servingsPerPack:    z.number().int().nonnegative().optional(),
  flavour:            z.string().max(100).optional(),
  proteinPer100g:     z.number().nonnegative().optional(),
  isConsumable:       z.boolean().optional(),
  equipmentCondition: z.string().max(50).optional(),
  // Lab / Pathology
  testCode:                  z.string().max(50).optional(),
  sampleType:                z.string().max(50).optional(),
  turnaroundHours:           z.number().int().nonnegative().optional(),
  requiresFasting:           z.boolean().optional(),
  referenceRange:            z.record(z.unknown()).optional(),
  methodology:               z.string().max(100).optional(),
  isHomeCollectionAvailable: z.boolean().optional(),
  panelTests:                z.array(z.string()).optional(),
  nablAccredited:            z.boolean().optional(),
  // Pest Control
  activeIngredient:  z.string().max(200).optional(),
  concentrationPct:  z.number().nonnegative().optional(),
  applicationMethod: z.string().max(50).optional(),
  targetPest:        z.array(z.string()).optional(),
  toxicityLevel:     z.string().max(20).optional(),
  dilutionRatio:     z.string().max(100).optional(),
  dosePerSqft:       z.number().nonnegative().optional(),
  chemShelfLifeDays: z.number().int().nonnegative().optional(),
  isCertifiedSafe:   z.boolean().optional(),
})

export const CreateProductSchema = z.object({
  itemType:     z.enum(['product', 'service', 'combo']).default('product'),
  name:         z.string().min(1).max(300),
  nameLocal:    z.string().max(300).optional(),
  categoryId:   z.string().uuid().optional(),
  brandId:      z.string().uuid().optional(),
  sku:          z.string().max(100).optional(),
  barcode:      z.string().max(100).optional(),
  hsnSacCode:   z.string().max(20).optional(),
  gstRate:      z.number().min(0).max(100).default(0),
  gstExempt:    z.boolean().default(false),
  unit:         z.string().default('pcs'),
  purchasePrice:z.number().nonnegative().optional(),
  salePrice:    z.number().nonnegative().default(0),
  mrp:          z.number().nonnegative().optional(),
  trackStock:   z.boolean().default(true),
  lowStockQty:  z.number().nonnegative().default(0),
  hasVariants:  z.boolean().optional(),
  // domainAttrs accepts the JSON object directly, OR individual domain fields
  // are provided at top level and get merged in by buildDomainAttrs().
  domainAttrs:  z.record(z.unknown()).default({}),
  // Opening stock (optional — creates first stock_ledger entry)
  openingStock: z.number().nonnegative().optional(),
  openingRate:  z.number().nonnegative().optional(),
}).merge(domainFieldsSchema)

export const UpdateProductSchema = CreateProductSchema.partial().omit({ openingStock: true, openingRate: true })

export const SearchProductSchema = z.object({
  q:        z.string().optional(),         // name / nameLocal search
  barcode:  z.string().optional(),         // exact barcode lookup
  category: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(), // alias for category
  brandId:  z.string().uuid().optional(),
  itemType:     z.string().optional(),
  lowStock:     z.enum(['true','false']).transform(v => v === 'true').optional(),
  isConsumable: z.enum(['true','false']).transform(v => v === 'true').optional(),
  page:         z.coerce.number().default(1),
  limit:        z.coerce.number().min(1).max(500).default(20),
})

export type CreateProductInput = z.infer<typeof CreateProductSchema>
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>
export type SearchProductInput = z.infer<typeof SearchProductSchema>

export const BulkImportRowSchema = CreateProductSchema
export type BulkImportRow = z.infer<typeof BulkImportRowSchema>

export const BulkImportSchema = z.object({
  rows: z.array(BulkImportRowSchema).min(1).max(500),
})

export interface RequestCtx {
  db:              PrismaClient
  branchId:        string
  userId:          string
  role:            string
  branchDomainType:string
}

// Extracts all domain-specific top-level fields from the input and merges them
// into the domainAttrs object. undefined values are stripped so they don't
// overwrite existing JSON keys with null on partial updates.
function buildDomainAttrs(
  input: Partial<z.infer<typeof domainFieldsSchema>> & { domainAttrs?: Record<string, unknown> }
): Record<string, unknown> {
  const domainKeys: Array<keyof z.infer<typeof domainFieldsSchema>> = [
    'weightGrams','packSize','minOrderQty','reorderQty','shelfLocation','altUnit','altUnitFactor','taxCategory',
    'drugSchedule','requiresPrescription','genericName','manufacturer','form','strengthDosage','stripQty','storageCondition','isNarcotic','dlNumber',
    'modelNumber','compatibleModels','isSpare','warrantyMonths','colorOptions','storageOptions','taxClass',
    'mealType','cuisineType','allergens','caloriesPer100g','portionSizeGrams','isAvailableBreakfast','isAvailableLunch','isAvailableDinner','preparationTimeMin','isSeasonalItem',
    'fuelGrade','tankId','densityKgL','octaneRating',
    'servingSizeG','servingsPerPack','flavour','proteinPer100g','isConsumable','equipmentCondition',
    'testCode','sampleType','turnaroundHours','requiresFasting','referenceRange','methodology','isHomeCollectionAvailable','panelTests','nablAccredited',
    'activeIngredient','concentrationPct','applicationMethod','targetPest','toxicityLevel','dilutionRatio','dosePerSqft','chemShelfLifeDays','isCertifiedSafe',
  ]

  const fromTopLevel: Record<string, unknown> = {}
  for (const key of domainKeys) {
    if (input[key] !== undefined) fromTopLevel[key] = input[key]
  }

  return { ...(input.domainAttrs ?? {}), ...fromTopLevel }
}

// =============================================================================
// createProduct
// =============================================================================
export async function createProduct(input: CreateProductInput, ctx: RequestCtx) {
  const mergedAttrs = buildDomainAttrs(input)
  const validatedAttrs = validateProductAttrs(ctx.branchDomainType, mergedAttrs)

  // Check for duplicate barcode within this tenant's schema
  if (input.barcode) {
    const existing = await ctx.db.product.findFirst({
      where: { barcode: input.barcode },
      select: { id: true, name: true },
    })
    if (existing) {
      throw Object.assign(
        new Error(`Barcode ${input.barcode} already assigned to "${existing.name}"`),
        { code: 'DUPLICATE_BARCODE', statusCode: 409 }
      )
    }
  }

  return ctx.db.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        branchId:      ctx.branchId,
        itemType:      input.itemType,
        name:          input.name,
        nameLocal:     input.nameLocal     ?? null,
        categoryId:    input.categoryId    ?? null,
        brandId:       input.brandId       ?? null,
        sku:           input.sku           ?? null,
        barcode:       input.barcode       ?? null,
        hsnSacCode:    input.hsnSacCode    ?? null,
        gstRate:       input.gstRate,
        gstExempt:     input.gstExempt,
        unit:          input.unit,
        purchasePrice: input.purchasePrice ?? null,
        salePrice:     input.salePrice,
        mrp:           input.mrp           ?? null,
        trackStock:    input.trackStock,
        lowStockQty:   input.lowStockQty,
        hasVariants:   input.hasVariants   ?? false,
        domainAttrs:   validatedAttrs,
      },
    })

    // Create opening stock entry if provided
    if (input.openingStock && input.openingStock > 0) {
      await tx.stockLedger.create({
        data: {
          branchId:  ctx.branchId,
          productId: product.id,
          txnType:   'opening',
          qty:       input.openingStock,
          rate:      input.openingRate ?? input.purchasePrice ?? 0,
          refType:   'opening_stock',
          refId:     product.id,
        },
      })
    }

    return product
  })
}

// =============================================================================
// updateProduct
// =============================================================================
export async function updateProduct(
  productId: string,
  input: UpdateProductInput,
  ctx: RequestCtx
) {
  // Ensure product exists in this tenant's schema
  const existing = await ctx.db.product.findFirst({
    where: { id: productId },
  })
  if (!existing) throw Object.assign(new Error('Product not found'), { statusCode: 404 })

  // Merge top-level domain fields + domainAttrs into existing JSON, then validate
  const incomingAttrs = buildDomainAttrs(input)
  let validatedAttrs: Record<string, unknown> | undefined
  if (Object.keys(incomingAttrs).length > 0) {
    validatedAttrs = validateProductAttrs(
      ctx.branchDomainType,
      { ...(existing.domainAttrs as object), ...incomingAttrs }
    )
  }

  // Barcode uniqueness check (exclude self)
  if (input.barcode && input.barcode !== existing.barcode) {
    const dup = await ctx.db.product.findFirst({
      where: { barcode: input.barcode, id: { not: productId } },
    })
    if (dup) {
      throw Object.assign(
        new Error(`Barcode ${input.barcode} already assigned to "${dup.name}"`),
        { code: 'DUPLICATE_BARCODE', statusCode: 409 }
      )
    }
  }

  // Build update payload — only include fields present in the request
  const p = (key: keyof typeof input) =>
    input[key] !== undefined ? { [key]: input[key] } : {}

  return ctx.db.product.update({
    where: { id: productId },
    data: {
      ...p('name'), ...p('nameLocal'), ...p('sku'), ...p('barcode'),
      ...p('hsnSacCode'), ...p('gstRate'), ...p('gstExempt'),
      ...p('unit'), ...p('purchasePrice'), ...p('salePrice'),
      ...p('mrp'), ...p('trackStock'), ...p('lowStockQty'), ...p('hasVariants'),
      ...p('categoryId'),
      ...(validatedAttrs !== undefined && { domainAttrs: validatedAttrs as never }),
    },
  })
}

// =============================================================================
// searchProducts
// Core product search used by POS billing screen.
// Three modes depending on what's in the query:
//   barcode → exact match, returns 1 result instantly
//   q       → trigram similarity search on name + nameLocal
//   (none)  → paginated list filtered by category / type / low stock
// =============================================================================
export async function searchProducts(input: SearchProductInput, ctx: RequestCtx) {
  const page  = Math.max(1, input.page)
  const limit = Math.min(100, input.limit)
  const skip  = (page - 1) * limit

  // ── Mode 1: Barcode scan → exact match ───────────────────────────────────
  if (input.barcode) {
    const product = await ctx.db.product.findFirst({
      where: { barcode: input.barcode, isActive: true },
      include: { _count: false },
    })

    if (!product) {
      return { data: [], meta: { page: 1, limit, total: 0, totalPages: 0 } }
    }

    const stock = await getStockBalance(ctx.db, product.id, ctx.branchId)
    return {
      data: [{ ...product, stockOnHand: stock }],
      meta: { page: 1, limit, total: 1, totalPages: 1 },
    }
  }

  // ── Mode 2: Fuzzy text search using pg_trgm ───────────────────────────────
  if (input.q && input.q.trim().length >= 2) {
    const searchTerm = input.q.trim()

    // ILIKE-based search — pg_trgm operators are not available when Prisma
    // sets search_path to only the tenant schema (public not included).
    const likePattern = `%${searchTerm}%`
    const results = await ctx.db.$queryRaw<Array<{
      id: string; name: string; nameLocal: string | null
      sku: string | null; barcode: string | null
      hsnSacCode: string | null; gstRate: number
      gstExempt: boolean; unit: string
      purchasePrice: number | null; salePrice: number
      mrp: number | null; trackStock: boolean
      lowStockQty: number; domainAttrs: Record<string, unknown>
      itemType: string; categoryId: string | null
    }>>`
      SELECT
        id::text, name, "nameLocal", sku, barcode, "hsnSacCode",
        "gstRate"::float, "gstExempt", unit,
        "purchasePrice"::float, "salePrice"::float, mrp::float,
        "trackStock", "lowStockQty"::float, "domainAttrs", "itemType", "categoryId"
      FROM products
      WHERE
        "isActive" = true
        AND (
          name         ILIKE ${likePattern}
          OR "nameLocal" ILIKE ${likePattern}
          OR sku         ILIKE ${likePattern}
        )
      ORDER BY
        CASE WHEN name ILIKE ${likePattern} THEN 0 ELSE 1 END,
        name ASC
      LIMIT ${limit}
      OFFSET ${skip}
    `

    // Batch fetch stock balances — one query instead of N
    const stockMap = await getBatchStockBalances(ctx.db, results.map((p) => p.id), ctx.branchId)

    return {
      data: results.map((p) => ({ ...p, stockOnHand: stockMap.get(p.id) ?? 0 })),
      meta: { page, limit, total: results.length, totalPages: 1 },
    }
  }

  // ── Mode 3: Paginated list with filters ───────────────────────────────────
  const where: Prisma.ProductWhereInput = {
    isActive: true,
    ...((input.categoryId || input.category) && { categoryId: input.categoryId ?? input.category }),
    ...(input.brandId                        && { brandId:  input.brandId }),
    ...(input.itemType                       && { itemType: input.itemType }),
    ...(input.isConsumable === true && {
      domainAttrs: { path: ['isConsumable'], equals: true },
    }),
    // NOTE: isConsumable === false is handled by post-filtering below.
    // Prisma JSON path filters exclude rows where the key is absent (NULL comparison
    // in Postgres returns NULL, not true), so we can't use a where clause for this.
  }

  // When filtering for "For Sale" (isConsumable === false) we must post-filter in JS
  // because Prisma JSON path comparisons exclude rows where the key is absent — Postgres
  // returns NULL for missing keys, and NULL != true is still NULL (not true), so those
  // rows get dropped. We fetch all active products and filter in memory instead.
  const needsJsFilter = input.isConsumable === false || !!input.lowStock

  const [products, total] = await Promise.all([
    ctx.db.product.findMany({
      where,
      orderBy: { name: 'asc' },
      ...(needsJsFilter ? {} : { skip, take: limit }),
    }),
    needsJsFilter ? Promise.resolve(0) : ctx.db.product.count({ where }),
  ])

  // Batch fetch stock balances for all products in one query
  const stockMap = await getBatchStockBalances(
    ctx.db,
    products.map((p) => p.id),
    ctx.branchId
  )

  let data = products.map((p) => ({
    ...p,
    stockOnHand: stockMap.get(p.id) ?? 0,
  }))

  if (input.isConsumable === false) {
    data = data.filter((p) => !(p.domainAttrs as any)?.isConsumable)
  }

  if (input.lowStock) {
    data = data.filter(
      (p) => p.trackStock && p.stockOnHand <= p.lowStockQty.toNumber()
    )
  }

  const filteredTotal = needsJsFilter ? data.length : total
  const pagedData     = needsJsFilter ? data.slice(skip, skip + limit) : data

  return {
    data: pagedData,
    meta: { page, limit, total: filteredTotal, totalPages: Math.ceil(filteredTotal / limit) },
  }
}

// =============================================================================
// getProduct
// =============================================================================
export async function getProduct(productId: string, ctx: RequestCtx) {
  const product = await ctx.db.product.findFirst({
    where: { id: productId },
  })
  if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })

  const stockOnHand = await getStockBalance(ctx.db, productId, ctx.branchId)
  return { ...product, stockOnHand }
}

// =============================================================================
// archiveProduct (soft delete)
// =============================================================================
export async function archiveProduct(productId: string, ctx: RequestCtx) {
  const product = await ctx.db.product.findFirst({
    where: { id: productId },
  })
  if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })

  // Check if product has been used in any confirmed invoice
  const usedInInvoice = await ctx.db.invoiceItem.findFirst({
    where: { productId },
    select: { id: true },
  })

  if (usedInInvoice) {
    // Soft delete only — cannot hard delete products used in invoices (audit trail)
    await ctx.db.product.update({
      where: { id: productId },
      data:  { isActive: false },
    })
    return { archived: true, hardDeleted: false }
  }

  // No invoices — safe to hard delete
  await ctx.db.product.delete({ where: { id: productId } })
  return { archived: true, hardDeleted: true }
}

// =============================================================================
// adjustStock
// Manual stock adjustment (e.g. physical count differs from system count)
// =============================================================================
export const StockAdjustmentSchema = z.object({
  productId:  z.string().uuid(),
  batchId:    z.string().uuid().optional(),
  qty:        z.number(),           // positive = add, negative = remove
  reason:     z.string().min(1),    // "Physical count", "Damaged", "Expired", etc.
  notes:      z.string().optional(),
})

export async function adjustStock(
  input: z.infer<typeof StockAdjustmentSchema>,
  ctx: RequestCtx
) {
  // Verify product exists in this tenant's schema
  const product = await ctx.db.product.findFirst({
    where: { id: input.productId },
    select: { id: true, name: true, trackStock: true },
  })
  if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })
  if (!product.trackStock) throw new Error('Stock tracking is disabled for this product')

  await ctx.db.stockLedger.create({
    data: {
      branchId:  ctx.branchId,
      productId: input.productId,
      batchId:   input.batchId ?? null,
      txnType:   'adjustment',
      qty:       input.qty,
      refType:   'manual_adjustment',
    },
  })

  const newBalance = await getStockBalance(ctx.db, input.productId, ctx.branchId)
  return { productId: input.productId, newBalance, adjustment: input.qty }
}

// =============================================================================
// suggestHSN
// Uses Claude claude-haiku-4-5 to suggest the correct HSN code and GST rate
// for a product based on its name. Returns top-3 suggestions.
// Cost: ~$0.000075 per call (under ₹0.01)
// =============================================================================
export async function suggestHSN(productName: string, _ctx: RequestCtx): Promise<{
  hsnCode:     string
  description: string
  gstRate:     0 | 5 | 12 | 18 | 28
  confidence:  number
}[]> {
  const text = await ai.chat({
    system: `You are an Indian GST expert.
For a given product name, suggest the correct HSN code and GST rate.
Return ONLY a JSON array with up to 3 suggestions, nothing else:
[
  {
    "hsn_code": "8-digit HSN code as string",
    "description": "official HSN description (max 80 chars)",
    "gst_rate": one of [0, 5, 12, 18, 28],
    "confidence": float 0.0-1.0
  }
]
Rules:
- Only return valid Indian GST rates: 0, 5, 12, 18, or 28
- Sort by confidence descending
- If unsure, lower the confidence score
- Common items: atta/rice/dal = 0%, packed food = 5-12%, FMCG = 12-18%, luxury = 28%`,
    prompt: `Product name: "${productName}"`,
    maxTokens: 800,
    quality: 'fast',
  })

  try {
    const parsed = parseAIJson<Array<{
      hsn_code: string; description: string; gst_rate: number; confidence: number
    }>>(text) ?? []

    return parsed.map((s) => ({
      hsnCode:     s.hsn_code,
      description: s.description,
      gstRate:     s.gst_rate as 0 | 5 | 12 | 18 | 28,
      confidence:  s.confidence,
    }))
  } catch {
    return []
  }
}

// =============================================================================
// confirmHSN
// After user selects an HSN suggestion, permanently store it on the product.
// Called once — never needs suggesting again for this product.
// =============================================================================
export async function confirmHSN(
  productId: string,
  hsnCode:   string,
  gstRate:   number,
  ctx:       RequestCtx
) {
  const product = await ctx.db.product.findFirst({
    where: { id: productId },
  })
  if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })

  return ctx.db.product.update({
    where: { id: productId },
    data: {
      hsnSacCode: hsnCode,
      gstRate:    gstRate,
    },
  })
}

// =============================================================================
// getLowStockAlerts
// Returns products below their lowStockQty threshold.
// Used by the daily alert notification.
// =============================================================================
export async function getLowStockAlerts(ctx: RequestCtx) {
  // Get all products with stock tracking enabled
  const products = await ctx.db.product.findMany({
    where:  { isActive: true, trackStock: true },
    select: { id: true, name: true, unit: true, lowStockQty: true, salePrice: true, domainAttrs: true },
  })

  const stockMap = await getBatchStockBalances(
    ctx.db,
    products.map((p) => p.id),
    ctx.branchId
  )

  const alerts = products
    .map((p) => ({
      ...p,
      stockOnHand:  stockMap.get(p.id) ?? 0,
      lowStockQty:  p.lowStockQty.toNumber(),
    }))
    .filter((p) => p.stockOnHand <= p.lowStockQty)
    .sort((a, b) => a.stockOnHand - b.stockOnHand)

  return alerts
}

// =============================================================================
// bulkImportProducts
// Processes up to 500 rows from a supplier bill in one call.
// Each row is attempted independently — one failure never aborts the rest.
// Returns a per-row result so the client can show a summary table.
// =============================================================================
export interface BulkImportResult {
  created: number
  skipped: number
  failed:  number
  rows: Array<{
    index:   number
    status:  'created' | 'skipped' | 'failed'
    id?:     string
    name?:   string
    reason?: string
  }>
}

export async function bulkImportProducts(
  rows: BulkImportRow[],
  ctx:  RequestCtx
): Promise<BulkImportResult> {
  const results: BulkImportResult['rows'] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    try {
      // Skip duplicate barcodes silently — common in supplier bills
      if (row.barcode) {
        const existing = await ctx.db.product.findFirst({
          where:  { barcode: row.barcode },
          select: { id: true, name: true },
        })
        if (existing) {
          results.push({
            index:  i,
            status: 'skipped',
            id:     existing.id,
            name:   existing.name,
            reason: `Barcode ${row.barcode} already assigned to "${existing.name}"`,
          })
          continue
        }
      }

      const product = await createProduct(row, ctx)
      results.push({ index: i, status: 'created', id: product.id, name: product.name })
    } catch (err) {
      results.push({
        index:  i,
        status: 'failed',
        name:   row.name,
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return {
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed:  results.filter((r) => r.status === 'failed').length,
    rows:    results,
  }
}

// =============================================================================
// Private helpers
// =============================================================================

// Get current stock balance for a single product in a branch
// Queries stock_ledger directly — always accurate
async function getStockBalance(db: PrismaClient, productId: string, branchId: string): Promise<number> {
  const result = await db.stockLedger.aggregate({
    where:  { productId, branchId },
    _sum:   { qty: true },
  })
  return Number(result._sum.qty ?? 0)
}

// Batch fetch stock balances for multiple products — one query instead of N
async function getBatchStockBalances(
  db:         PrismaClient,
  productIds: string[],
  branchId:   string
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map()

  const results = await db.$queryRaw<Array<{ productId: string; qty_on_hand: number }>>`
    SELECT "productId"::text, COALESCE(SUM(qty), 0)::float AS qty_on_hand
    FROM stock_ledger
    WHERE "branchId"  = ${branchId}::uuid
      AND "productId" = ANY(${productIds}::uuid[])
    GROUP BY "productId"
  `

  return new Map(results.map((r) => [r.productId, r.qty_on_hand]))
}
