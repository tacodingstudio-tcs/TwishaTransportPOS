// apps/api/src/routes/ai.ts
// All AI-powered endpoints. Every response here is a DRAFT requiring
// human confirmation before it touches invoices, products, or sends
// any message — consistent with the rest of the platform's safety model.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { buildInvoiceDraft } from '../services/ai/invoiceExtractor.js'
import { scanBillImage, resolveOCRBill } from '../services/ai/ocrScanner.js'
import { generateDailyReminders } from '../services/ai/paymentReminder.js'
import {
  generateDashboardInsight,
  getReorderSuggestions,
  detectInvoiceAnomalies,
  getCreditRisk,
} from '../services/ai/insights.js'
import {
  categorizeExpense,
  cashflowForecast,
  findPartyDuplicates,
  detectPriceAnomaly,
  gstFilingSummary,
  demandForecast,
  chatWithData,
} from '../services/ai/advanced.js'
import { db } from '@billing/db'
import { whatsappQueue } from '../lib/queues.js'

export const aiRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/ai/extract-invoice ──────────────────────────────────────────
  // Body: { text: "Ramesh ne 10 kilo chawal liya 50 rupaye kilo" }
  // Returns a draft invoice for the cashier to review before confirming.
  // This is the endpoint the mobile app's voice/text billing screen calls.
  app.post('/extract-invoice', async (req) => {
    const { text } = z.object({ text: z.string().min(2).max(2000) }).parse(req.body)

    const draft = await buildInvoiceDraft(text, req.tenantId, req.branchId, req.db)
    return draft
  })

  // ── POST /api/ai/scan-bill ─────────────────────────────────────────────────
  // Body: { imageBase64: "...", mediaType: "image/jpeg" }
  // Returns a resolved purchase draft from a photographed supplier bill.
  app.post('/scan-bill', async (req) => {
    const input = z.object({
      imageBase64: z.string().min(100),
      mediaType:   z.enum(['image/jpeg','image/png','image/webp']).default('image/jpeg'),
    }).parse(req.body)

    const bill  = await scanBillImage(input.imageBase64, input.mediaType)
    const draft = await resolveOCRBill(bill, req.branchId, req.db)
    return draft
  })

  // ── POST /api/ai/extract-supplier-bill ───────────────────────────────────
  // Scans a supplier bill image, extracts supplier + line items, auto-upserts
  // the supplier into the suppliers table, and returns a structured PO draft.
  app.post('/extract-supplier-bill', async (req, reply) => {
    const input = z.object({
      imageBase64: z.string().min(100),
      mediaType:   z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // 1. Vision extraction
    const bill = await scanBillImage(input.imageBase64, input.mediaType)

    // 2. Auto-upsert supplier by GSTIN (most reliable) or fuzzy name match
    let supplier: { id: string; name: string; isNew: boolean } | null = null

    if (bill.supplierName || bill.supplierGstin) {
      // Try GSTIN match first
      if (bill.supplierGstin) {
        const existing = await db.party.findFirst({
          where: { branchId, gstin: bill.supplierGstin, type: 'supplier' },
          select: { id: true, name: true },
        })
        if (existing) {
          supplier = { ...existing, isNew: false }
        }
      }

      // Fuzzy name match if no GSTIN hit
      if (!supplier && bill.supplierName) {
        const candidates = await db.party.findMany({
          where: { branchId, isActive: true, type: 'supplier' },
          select: { id: true, name: true },
        })
        const name = bill.supplierName.toLowerCase()
        const match = candidates.find((s) =>
          s.name.toLowerCase().includes(name) || name.includes(s.name.toLowerCase())
        )
        if (match) supplier = { ...match, isNew: false }
      }

      // Auto-create supplier if not found
      if (!supplier && bill.supplierName) {
        const created = await db.party.create({
          data: {
            branchId,
            type:    'supplier',
            name:    bill.supplierName.trim(),
            gstin:   bill.supplierGstin ?? null,
            phone:   (bill as any).supplierPhone ?? null,
            address: (bill as any).supplierAddress
              ? { line1: (bill as any).supplierAddress }
              : undefined,
            meta: {},
          },
          select: { id: true, name: true },
        })
        supplier = { ...created, isNew: true }
      }
    }

    // 3. Match each item against existing products (by name similarity)
    const items = await Promise.all(
      bill.items.map(async (item) => {
        const products = await db.product.findMany({
          where:  { isActive: true },
          select: { id: true, name: true, unit: true, purchasePrice: true, gstRate: true },
          take:   200,
        })
        const nameLc  = item.name.toLowerCase()
        const matched = products.find(
          (p) => p.name.toLowerCase().includes(nameLc) || nameLc.includes(p.name.toLowerCase())
        )
        const gstRate  = item.gstRate  ?? Number(matched?.gstRate  ?? 0)
        const rate     = item.rate     ?? Number(matched?.purchasePrice ?? 0)
        const qty      = item.qty      ?? 1
        const taxable  = qty * rate
        const cgst     = taxable * gstRate / 200
        return {
          productId:   matched?.id ?? null,
          productName: matched?.name ?? item.name,
          isNewProduct:!matched,
          description: item.name,
          orderedQty:  qty,
          unit:        item.unit   ?? matched?.unit ?? 'pcs',
          rate,
          gstRate,
          taxableAmt:  taxable,
          cgstAmt:     cgst,
          sgstAmt:     cgst,
          igstAmt:     0,
          total:       taxable + cgst * 2,
          hsnCode:     item.hsnCode ?? null,
        }
      })
    )

    return reply.send({
      supplier,
      billNo:      bill.billNo,
      billDate:    bill.billDate,
      items,
      grandTotal:  bill.grandTotal,
      confidence:  bill.confidence,
      needsReview: bill.confidence < 0.75 || items.some((i) => i.isNewProduct) || !supplier,
      newProductCount: items.filter((i) => i.isNewProduct).length,
    })
  })

  // ── POST /api/ai/reminders/generate ──────────────────────────────────────
  // Triggers AI drafting of payment reminders for all overdue customers.
  // Drafts are saved to ai_suggestions table for owner review — not sent yet.
  app.post('/reminders/generate', async (req) => {
    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId }, select: { domainConfig: true },
    })
    // Tenant info lives in the public schema — use the global db client
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: req.tenantId }, select: { name: true, settings: true },
    })

    const lang = ((tenant.settings as Record<string, unknown>)?.['lang'] as 'hi'|'gu'|'en'|'mr'|'ta') ?? 'hi'

    const reminders = await generateDailyReminders(
      req.db, req.branchId, tenant.name, lang
    )

    // Persist as pending suggestions for the owner to review/approve
    for (const r of reminders) {
      await req.db.$executeRaw`
        INSERT INTO ai_suggestions (type, payload, accepted)
        VALUES (
          'payment_reminder',
          ${JSON.stringify({
            partyId: r.partyId, partyName: r.partyName, phone: r.phone,
            balance: r.balance, daysOverdue: r.daysOverdue, draft: r.draft,
          })}::jsonb,
          false
        )
      `
    }

    return { generated: reminders.length, reminders }
  })

  // ── GET /api/ai/reminders/pending ─────────────────────────────────────────
  // List pending reminder drafts awaiting owner approval
  app.get('/reminders/pending', async (req) => {
    const pending = await req.db.$queryRaw<Array<{
      id: string; payload: Record<string, unknown>; created_at: Date
    }>>`
      SELECT id::text, payload, created_at
      FROM ai_suggestions
      WHERE type = 'payment_reminder'
        AND accepted = false
      ORDER BY created_at DESC
    `.catch(() => [] as Array<any>)
    return pending
  })

  // ── POST /api/ai/reminders/:id/approve ────────────────────────────────────
  // Owner approves a drafted reminder — queues the actual WhatsApp send.
  app.post('/reminders/:id/approve', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)

    const rows = await req.db.$queryRaw<Array<{ payload: any }>>`
      SELECT payload FROM ai_suggestions
      WHERE id = ${id}::uuid
    `
    if (rows.length === 0) {
      throw Object.assign(new Error('Reminder draft not found'), { statusCode: 404 })
    }

    const payload = rows[0]!.payload

    await whatsappQueue.add('payment-reminder', {
      type:       'payment_reminder',
      invoiceId:  payload.partyId,  // grouped by party, not a single invoice
      tenantId:   req.tenantId,
      toPhone:    payload.phone,
      partyName:  payload.partyName,
      amount:     payload.balance,
      daysOverdue:payload.daysOverdue,
      draftMessage: payload.draft.message,
    })

    await req.db.$executeRaw`
      UPDATE ai_suggestions SET accepted = true
      WHERE id = ${id}::uuid
    `

    return { approved: true, queued: true }
  })

  // ── POST /api/ai/reminders/:id/reject ─────────────────────────────────────
  app.post('/reminders/:id/reject', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await req.db.$executeRaw`
      DELETE FROM ai_suggestions
      WHERE id = ${id}::uuid
    `
    return { rejected: true }
  })

  // ── GET /api/ai/insight ────────────────────────────────────────────────────
  // Natural language dashboard summary for today
  app.get('/insight', async (req) => {
    // Tenant settings live in the public schema — use the global db client
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: req.tenantId }, select: { settings: true },
    })
    const lang = ((tenant.settings as Record<string, unknown>)?.['lang'] as
      'hi' | 'gu' | 'en' | 'mr' | 'ta') ?? 'en'
    try {
      return await generateDashboardInsight(req.tenantId, req.branchId, lang, req.db)
    } catch (err) {
      // No AI provider key / provider outage: the dashboard simply shows no insight card.
      req.log.warn({ err }, 'AI insight unavailable')
      return { insights: [], aiUnavailable: true }
    }
  })

  // ── GET /api/ai/reorder ────────────────────────────────────────────────────
  // Smart reorder suggestions based on stock + sales velocity
  app.get('/reorder', async (req) => {
    const suggestions = await getReorderSuggestions(req.tenantId, req.branchId, req.db)
    return suggestions
  })

  // ── POST /api/ai/check-invoice ─────────────────────────────────────────────
  // Anomaly detection — call before confirming a new invoice
  app.post('/check-invoice', async (req) => {
    const input = z.object({
      partyId:    z.string().uuid().nullable(),
      grandTotal: z.number().positive(),
      items: z.array(z.object({
        productId:   z.string().uuid().nullable(),
        qty:         z.number().positive(),
        rate:        z.number().nonnegative(),
        discountPct: z.number().min(0).max(100).default(0),
      })),
    }).parse(req.body)

    const anomalies = await detectInvoiceAnomalies(req.tenantId, req.branchId, input)
    return { anomalies, safe: anomalies.filter((a) => a.severity === 'error').length === 0 }
  })

  // ── GET /api/ai/credit-risk/:partyId ──────────────────────────────────────
  app.get('/credit-risk/:partyId', async (req) => {
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(req.params)
    return getCreditRisk(req.db as never, partyId, req.branchId)
  })

  // ── POST /api/ai/categorize-expense ───────────────────────────────────────
  // Auto-tag an expense category from its description + amount
  app.post('/categorize-expense', async (req) => {
    const { description, amount } = z.object({
      description: z.string().min(2).max(500),
      amount:      z.number().positive(),
    }).parse(req.body)
    return categorizeExpense(description, amount)
  })

  // ── GET /api/ai/cashflow-forecast ─────────────────────────────────────────
  // 7 or 30-day cash flow projection
  app.get('/cashflow-forecast', async (req) => {
    const { horizon } = z.object({
      horizon: z.coerce.number().refine((n) => n === 7 || n === 30).default(7),
    }).parse(req.query)
    return cashflowForecast(req.branchId, horizon as 7 | 30, req.db)
  })

  // ── GET /api/ai/party-duplicates ──────────────────────────────────────────
  // Detect duplicate party records (same phone / GSTIN / similar name)
  app.get('/party-duplicates', async (req) => {
    return findPartyDuplicates(req.branchId, req.db)
  })

  // ── POST /api/ai/price-anomaly ────────────────────────────────────────────
  // Check whether purchase rates deviate from historical averages
  app.post('/price-anomaly', async (req) => {
    const { items } = z.object({
      items: z.array(z.object({
        productId: z.string().uuid(),
        rate:      z.number().positive(),
      })),
    }).parse(req.body)
    return detectPriceAnomaly(req.branchId, items, req.db)
  })

  // ── GET /api/ai/gst-summary ───────────────────────────────────────────────
  // Structured GST filing data for a given month (YYYY-MM)
  app.get('/gst-summary', async (req) => {
    const { month } = z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).default(
        new Date().toISOString().slice(0, 7)
      ),
    }).parse(req.query)
    return gstFilingSummary(req.branchId, month, req.db)
  })

  // ── GET /api/ai/demand-forecast ───────────────────────────────────────────
  // Predict which SKUs will stock out and when
  app.get('/demand-forecast', async (req) => {
    return demandForecast(req.branchId, req.db)
  })

  // ── POST /api/ai/chat ─────────────────────────────────────────────────────
  // Free-form Q&A over the tenant's own business data
  app.post('/chat', async (req) => {
    const { question, history } = z.object({
      question: z.string().min(2).max(1000),
      history:  z.array(z.object({
        role:    z.enum(['user', 'assistant']),
        content: z.string(),
      })).max(20).default([]),
    }).parse(req.body)
    const answer = await chatWithData(question, history, req.branchId, req.db)
    return { answer }
  })
}
