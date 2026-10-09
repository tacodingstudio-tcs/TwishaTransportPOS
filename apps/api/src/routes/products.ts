// apps/api/src/routes/products.ts

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { invalidateBranch } from '../lib/cache.js'
import {
  createProduct,
  updateProduct,
  searchProducts,
  getProduct,
  archiveProduct,
  adjustStock,
  suggestHSN,
  confirmHSN,
  getLowStockAlerts,
  bulkImportProducts,
  CreateProductSchema,
  UpdateProductSchema,
  SearchProductSchema,
  StockAdjustmentSchema,
  BulkImportSchema,
} from '../services/product.service.js'

export const productRoutes: FastifyPluginAsync = async (app) => {

  // Helper to build context from request (branch domain type needed for validation)
  async function buildCtx(req: { db: any; branchId: string; userId: string; role: string }) {
    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId },
      select: { domainType: true },
    })
    return {
      db:               req.db,
      branchId:         req.branchId,
      userId:           req.userId,
      role:             req.role,
      branchDomainType: branch.domainType,
    }
  }

  // ── GET /api/products ─────────────────────────────────────────────────────
  // Search and list products (supports barcode scan, fuzzy name, category filter)
  app.get('/', async (req) => {
    const query = SearchProductSchema.parse(req.query)
    const ctx   = await buildCtx(req)
    return searchProducts(query, ctx)
  })

  // ── POST /api/products ────────────────────────────────────────────────────
  // Create a new product with optional opening stock
  app.post('/', async (req, reply) => {
    const input = CreateProductSchema.parse(req.body)
    const ctx   = await buildCtx(req)
    const product = await createProduct(input, ctx)
    await invalidateBranch(req.schemaName, req.branchId)
    return reply.status(201).send(product)
  })

  // ── POST /api/products/bulk-import ───────────────────────────────────────
  // Import many products at once from a supplier bill (max 500 rows per call).
  // Partial success: skips duplicate barcodes, reports per-row failures without
  // aborting the rest of the batch.
  app.post('/bulk-import', async (req, reply) => {
    const { rows } = BulkImportSchema.parse(req.body)
    const ctx      = await buildCtx(req)
    const result   = await bulkImportProducts(rows, ctx)
    const status   = result.failed === rows.length ? 422 : 201
    await invalidateBranch(req.schemaName, req.branchId)
    return reply.status(status).send(result)
  })

  // ── GET /api/products/low-stock ───────────────────────────────────────────
  // Products below their reorder threshold — used for daily alerts
  // Must be defined BEFORE /:id to avoid route conflict
  app.get('/low-stock', async (req) => {
    const ctx = await buildCtx(req)
    return getLowStockAlerts(ctx)
  })

  // ── GET /api/products/:id ─────────────────────────────────────────────────
  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const ctx     = await buildCtx(req)
    return getProduct(id, ctx)
  })

  // ── PATCH /api/products/:id ───────────────────────────────────────────────
  // Partial update — only send fields you want to change
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = UpdateProductSchema.parse(req.body)
    const ctx     = await buildCtx(req)
    const result  = await updateProduct(id, input, ctx)
    await invalidateBranch(req.schemaName, req.branchId)
    return result
  })

  // ── DELETE /api/products/:id ──────────────────────────────────────────────
  // Archive (soft delete) or hard delete if never used in an invoice
  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const ctx     = await buildCtx(req)
    const result  = await archiveProduct(id, ctx)
    await invalidateBranch(req.schemaName, req.branchId)
    return result
  })

  // ── POST /api/products/:id/stock-adjustment ───────────────────────────────
  // Manual stock adjustment for physical count corrections
  app.post('/:id/stock-adjustment', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = StockAdjustmentSchema.parse({ ...(req.body as object), productId: id })
    const ctx     = await buildCtx(req)
    const result  = await adjustStock(input, ctx)
    await invalidateBranch(req.schemaName, req.branchId)
    return result
  })

  // ── GET /api/products/:id/stock-history ───────────────────────────────────
  // Full stock movement history for a product
  app.get('/:id/stock-history', async (req) => {
    const { id }    = z.object({ id: z.string().uuid() }).parse(req.params)
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query)

    const history = await req.db.stockLedger.findMany({
      where:   { productId: id },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    })

    return history
  })

  // ── POST /api/products/:id/suggest-hsn ───────────────────────────────────
  // AI suggests HSN code + GST rate based on product name
  app.post('/:id/suggest-hsn', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const ctx     = await buildCtx(req)

    const product = await req.db.product.findFirst({
      where:  { id },
      select: { name: true, hsnSacCode: true },
    })
    if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })

    // If HSN already confirmed, return it without AI call
    if (product.hsnSacCode) {
      return {
        alreadySet: true,
        hsnSacCode: product.hsnSacCode,
        suggestions: [],
      }
    }

    const suggestions = await suggestHSN(product.name, ctx)
    return { alreadySet: false, suggestions }
  })

  // ── POST /api/products/:id/confirm-hsn ───────────────────────────────────
  // User confirms an HSN suggestion — permanently stored on product
  app.post('/:id/confirm-hsn', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = z.object({
      hsnCode: z.string().min(4).max(20),
      gstRate: z.number().refine((v) => [0, 5, 12, 18, 28].includes(v)),
    }).parse(req.body)
    const ctx = await buildCtx(req)

    return confirmHSN(id, input.hsnCode, input.gstRate, ctx)
  })

  // ── GET /api/products/barcode/:code ──────────────────────────────────────
  // Dedicated barcode endpoint — used by mobile barcode scanner
  // Returns 404 if not found so scanner can show "product not found" UI
  app.get('/barcode/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.params)
    const ctx       = await buildCtx(req)

    const result = await searchProducts({ barcode: code, page: 1, limit: 1 }, ctx)

    if (result.data.length === 0) {
      return reply.status(404).send({
        error:   'Product not found',
        barcode: code,
        hint:    'Scan a different product or add this product manually',
      })
    }

    return result.data[0]
  })

  // GET /api/products/:id/image is handled as a public route in server.ts
  // (browser <img src> can't send Authorization headers)

  // ── PUT /api/products/:id/image ───────────────────────────────────────────
  // Upload or replace a product image. Accepts { imageBase64, imageMime }.
  app.put('/:id/image', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { imageBase64, imageMime } = z.object({
      // ~10MB in base64 ≈ 13_400_000 chars; reject anything larger to avoid storing
      // huge BLOBs in PostgreSQL BYTEA and exhausting the JSON body limit.
      imageBase64: z.string().min(1).max(13_400_000),
      imageMime:   z.string().default('image/jpeg'),
    }).parse(req.body)

    const imageBytes = Buffer.from(imageBase64, 'base64')
    await req.db.product.update({
      where: { id },
      data:  { image: imageBytes, imageMime },
    })
    return reply.status(200).send({ ok: true })
  })

}
