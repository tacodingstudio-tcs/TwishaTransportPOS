// apps/api/src/routes/transport-firms.ts
// Firms: one login, several business names (e.g. a transport firm and a trading firm owned by the same person).
// A firm is a branch of the tenant — every row in the app is already scoped to a branch, so each firm keeps its
// own LRs, trips, customers, bills and bill numbers. The user switches firm with POST /api/auth/switch-branch.
// Registered under /api/transport.
//
//   GET  /firms                    firms this user can work in (with kind, logo, bill-number setting)
//   POST /firms                    owner: add a firm
//   POST /firms/:id/numbering      owner: bill-number prefix + next number ("F-" / 4  →  F-4, F-5 …)
//   POST /firms/:id/logo           owner: set / remove the logo printed on this firm's bills
//   GET  /firms/:id/parties        another firm's customers (to copy one over)
//   GET  /firms/:id/bills          another firm's recent bills (to pre-fill a goods bill from a freight bill)
//   POST /parties/copy             copy another firm's customer into the current firm (balance starts at 0)
//   POST /goods-bills              raise a goods sale bill (product / HSN / qty / rate / GST %)
//   GET  /goods-bills/suggestions  products used before, with their last HSN, unit, GST % and rate

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { DOMAIN_REGISTRY } from '@billing/domain-registry'
import { createInvoice } from '../services/invoice.service.js'
import { seedDomainCategories } from '../lib/provision-schema.js'
import { tbl, q, q1, run, httpError, requireWrite, requireManager, todayStr, addDays, r2, ymd, configForClient } from '../lib/transport-helpers.js'

const idParam = z.object({ id: z.string().uuid() })
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const MAX_FIRMS = 5
const MAX_LOGO_CHARS = 160_000          // a ~240px logo is well under this; keeps the firm list light
export const FIRM_KINDS = ['transport', 'goods'] as const
type FirmKind = (typeof FIRM_KINDS)[number]

/** Firms this user may work in. `branchIds = []` means all of them (the owner, and staff not pinned to a firm). */
async function accessibleFirmIds(req: FastifyRequest): Promise<string[] | 'all'> {
  const u = await q1<{ branchIds: string[] | null }>(req,
    `SELECT "branchIds" FROM ${tbl(req.schemaName, 'users')} WHERE id = $1::uuid`, req.userId)
  const ids = u?.branchIds ?? []
  return ids.length === 0 ? 'all' : ids
}

async function assertFirmAccess(req: FastifyRequest, firmId: string): Promise<void> {
  const acc = await accessibleFirmIds(req)
  if (acc !== 'all' && !acc.includes(firmId)) throw httpError(403, 'You do not have access to that firm')
  const b = await q1(req, `SELECT id FROM ${tbl(req.schemaName, 'branches')} WHERE id = $1::uuid AND "isActive" = true`, firmId)
  if (!b) throw httpError(404, 'Firm not found')
}

const kindOf = (cfg: Record<string, any> | null | undefined): FirmKind => (cfg?.['firm_kind'] === 'goods' ? 'goods' : 'transport')

/** Highest number already used by this firm's sale invoices (same rule the number generator applies). */
async function maxUsedNumber(req: FastifyRequest, branchId: string): Promise<number> {
  const r = await q1<{ m: number }>(req,
    `SELECT COALESCE(MAX(NULLIF(SUBSTRING("number" FROM '[0-9]+$'), '')::bigint), 0) AS m
     FROM ${tbl(req.schemaName, 'invoices')} WHERE "branchId" = $1::uuid AND "txnType" = 'sale_invoice'`, branchId)
  return Number(r?.m ?? 0)
}

async function firmView(req: FastifyRequest, b: any) {
  const cfg = (b.domainConfig ?? {}) as Record<string, any>
  const plain = cfg['invoice_style'] === 'plain'
  let nextNumber: number | null = null
  if (plain) {
    const seq = await q1<{ v: number }>(req,
      `SELECT current_val AS v FROM ${tbl(req.schemaName, 'invoice_sequences')}
       WHERE branch_id = $1::uuid AND txn_type = 'sale_invoice' AND fy = 'plain'`, b.id)
    nextNumber = Math.max(Number(seq?.v ?? 0), await maxUsedNumber(req, b.id)) + 1
  }
  return {
    id: b.id, name: b.name, kind: kindOf(cfg), gstin: b.gstin ?? null, stateCode: b.stateCode ?? null,
    address: b.address ?? null, domainConfig: configForClient(cfg),
    logo: typeof cfg['logo_data_url'] === 'string' ? cfg['logo_data_url'] : null,
    numbering: { style: plain ? 'plain' : 'standard', prefix: plain ? String(cfg['invoice_prefix'] ?? '') : null, next: nextNumber },
  }
}

const AddFirmBody = z.object({
  name:      z.string().trim().min(2).max(200),
  kind:      z.enum(FIRM_KINDS),
  gstin:     z.string().trim().toUpperCase().max(15).nullable().optional(),
  stateCode: z.string().regex(/^\d{2}$/).nullable().optional(),
  address:   z.object({
    line1: z.string().max(200).optional(), city: z.string().max(100).optional(), pincode: z.string().max(10).optional(),
  }).optional(),
  /** Start from this firm's bank details, PAN, terms and GST defaults (same owner, same bank usually). */
  copySettingsFrom: z.string().uuid().optional(),
})

const NumberingBody = z.object({
  prefix: z.string().max(12).regex(/^[A-Za-z0-9\-\/._]*$/, 'Letters, digits and - / . _ only'),
  next:   z.number().int().min(1).max(99_999_999),
})

const GoodsBillBody = z.object({
  partyId:    z.string().uuid(),
  date:       dateStr.optional(),
  creditDays: z.number().int().min(0).max(180).default(30),
  notes:      z.string().max(800).optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(200),
    hsnSacCode:  z.string().trim().max(8).nullable().optional(),
    qty:         z.number().positive().max(1e9),
    unit:        z.string().trim().min(1).max(10).default('MT'),
    rate:        z.number().nonnegative().max(1e9),
    gstRate:     z.number().refine((v) => [0, 5, 12, 18, 28].includes(v), 'GST must be 0, 5, 12, 18 or 28'),
  })).min(1).max(30),
})

function paymentTerms(days: number) {
  if (days <= 0)  return 'immediate' as const
  if (days <= 7)  return '7_days'    as const
  if (days <= 15) return '15_days'   as const
  if (days <= 30) return '30_days'   as const
  if (days <= 45) return '45_days'   as const
  return '60_days' as const
}

export const transportFirmRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/transport/firms
  app.get('/firms', async (req) => {
    const acc = await accessibleFirmIds(req)
    const rows = await q<any>(req,
      `SELECT id, name, gstin, "stateCode", address, "domainConfig"
       FROM ${tbl(req.schemaName, 'branches')} WHERE "isActive" = true ORDER BY "createdAt" ASC`)
    const mine = rows.filter((b: any) => acc === 'all' || acc.includes(b.id))
    return { currentFirmId: req.branchId, firms: await Promise.all(mine.map((b: any) => firmView(req, b))) }
  })

  // POST /api/transport/firms — owner adds a firm
  app.post('/firms', async (req, reply) => {
    if (req.role !== 'owner') throw httpError(403, 'Only the owner can add a firm')
    const body = AddFirmBody.parse(req.body)

    const existing = await q<any>(req,
      `SELECT id, name, "domainConfig" FROM ${tbl(req.schemaName, 'branches')} WHERE "isActive" = true`)
    if (existing.length >= MAX_FIRMS) throw httpError(422, `You can have at most ${MAX_FIRMS} firms`)
    if (existing.some((b: any) => String(b.name).trim().toLowerCase() === body.name.toLowerCase()))
      throw httpError(409, 'You already have a firm with this name')

    // Settings that carry over (bank, PAN, terms, GST defaults) — never the logo, numbering or LR prefix.
    let inherited: Record<string, any> = {}
    if (body.copySettingsFrom) {
      const src = existing.find((b: any) => b.id === body.copySettingsFrom)
      if (!src) throw httpError(404, 'The firm to copy settings from was not found')
      const c = (src.domainConfig ?? {}) as Record<string, any>
      for (const k of ['pan', 'bank_name', 'bank_account_no', 'bank_ifsc', 'bill_terms', 'default_gst_mode', 'default_sac_code'])
        if (c[k] !== undefined) inherited[k] = c[k]
    }

    const defaults = (DOMAIN_REGISTRY as any)['transport']?.defaultDomainConfig ?? {}
    const prefix = body.name.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'FIRM'
    const branch = await req.db.branch.create({
      data: {
        name: body.name, gstin: body.gstin || null, stateCode: body.stateCode ?? null, domainType: 'transport',
        address: body.address && Object.values(body.address).some(Boolean) ? (body.address as never) : undefined,
        domainConfig: { ...defaults, ...inherited, firm_kind: body.kind, invoice_prefix: prefix } as never,
      },
    })

    // Same pre-seeded number counters a freshly registered business gets.
    const fy = (() => { const n = new Date(Date.now() + 5.5 * 3600_000); return String(n.getUTCMonth() >= 3 ? n.getUTCFullYear() : n.getUTCFullYear() - 1).slice(-2) })()
    for (const t of ['sale_invoice', 'purchase_invoice', 'proforma', 'quotation', 'credit_note', 'delivery_challan'])
      await run(req,
        `INSERT INTO ${tbl(req.schemaName, 'invoice_sequences')} (branch_id, txn_type, fy, current_val)
         VALUES ($1::uuid, $2, $3, 0) ON CONFLICT (branch_id, txn_type, fy) DO NOTHING`, branch.id, t, fy)
    await seedDomainCategories(req.db as any, branch.id, 'transport')

    const row = await q1<any>(req,
      `SELECT id, name, gstin, "stateCode", address, "domainConfig" FROM ${tbl(req.schemaName, 'branches')} WHERE id = $1::uuid`, branch.id)
    return reply.status(201).send(await firmView(req, row))
  })

  // POST /api/transport/firms/:id/numbering — "F-" + next 4  →  F-4, F-5 …
  app.post('/firms/:id/numbering', async (req) => {
    if (req.role !== 'owner') throw httpError(403, 'Only the owner can change bill numbering')
    const { id } = idParam.parse(req.params)
    const body = NumberingBody.parse(req.body)
    await assertFirmAccess(req, id)

    const used = await maxUsedNumber(req, id)
    if (body.next <= used)
      throw httpError(422, `This firm already has bills up to number ${used}. Start from ${used + 1} or higher.`)

    await run(req,
      `UPDATE ${tbl(req.schemaName, 'branches')}
       SET "domainConfig" = COALESCE("domainConfig", '{}'::jsonb) || jsonb_build_object('invoice_style', 'plain', 'invoice_prefix', $2::text),
           "updatedAt" = NOW()
       WHERE id = $1::uuid`, id, body.prefix)
    await run(req,
      `INSERT INTO ${tbl(req.schemaName, 'invoice_sequences')} (branch_id, txn_type, fy, current_val)
       VALUES ($1::uuid, 'sale_invoice', 'plain', $2::int)
       ON CONFLICT (branch_id, txn_type, fy) DO UPDATE SET current_val = EXCLUDED.current_val`, id, body.next - 1)
    return { prefix: body.prefix, next: body.next, example: `${body.prefix}${body.next}` }
  })

  // POST /api/transport/firms/:id/logo — { dataUrl } or { dataUrl: null } to remove
  app.post('/firms/:id/logo', async (req) => {
    if (req.role !== 'owner') throw httpError(403, 'Only the owner can change the logo')
    const { id } = idParam.parse(req.params)
    const { dataUrl } = z.object({ dataUrl: z.string().nullable() }).parse(req.body)
    await assertFirmAccess(req, id)
    if (dataUrl !== null) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw httpError(422, 'Logo must be a PNG, JPEG or WebP image')
      if (dataUrl.length > MAX_LOGO_CHARS) throw httpError(422, 'Logo is too large — use a smaller image (about 300 px wide)')
    }
    await run(req,
      dataUrl === null
        ? `UPDATE ${tbl(req.schemaName, 'branches')} SET "domainConfig" = "domainConfig" - 'logo_data_url', "updatedAt" = NOW() WHERE id = $1::uuid`
        : `UPDATE ${tbl(req.schemaName, 'branches')}
           SET "domainConfig" = COALESCE("domainConfig", '{}'::jsonb) || jsonb_build_object('logo_data_url', $2::text), "updatedAt" = NOW()
           WHERE id = $1::uuid`,
      ...(dataUrl === null ? [id] : [id, dataUrl]))
    return { ok: true }
  })

  // GET /api/transport/firms/:id/parties?search=
  app.get('/firms/:id/parties', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const { search } = z.object({ search: z.string().max(100).optional() }).parse(req.query)
    await assertFirmAccess(req, id)
    const params: unknown[] = [id]
    let where = `WHERE "branchId" = $1::uuid AND "isActive" = true AND type IN ('customer','both')`
    if (search) { params.push(`%${search}%`); where += ` AND (name ILIKE $2 OR gstin ILIKE $2)` }
    return q(req,
      `SELECT id, name, gstin, phone, address->>'city' AS city FROM ${tbl(req.schemaName, 'parties')} ${where} ORDER BY name LIMIT 30`, ...params)
  })

  // POST /api/transport/parties/copy — bring another firm's customer into this firm (balance starts at 0)
  app.post('/parties/copy', async (req, reply) => {
    requireWrite(req)
    const { fromPartyId } = z.object({ fromPartyId: z.string().uuid() }).parse(req.body)
    const src = await q1<any>(req, `SELECT * FROM ${tbl(req.schemaName, 'parties')} WHERE id = $1::uuid`, fromPartyId)
    if (!src || !src.branchId) throw httpError(404, 'Customer not found')
    if (src.branchId === req.branchId) throw httpError(422, 'That customer is already in this firm')
    await assertFirmAccess(req, src.branchId)

    // Already copied (or typed in by hand)? Reuse it rather than make a duplicate.
    const dupe = await q1<any>(req,
      `SELECT id, name, gstin FROM ${tbl(req.schemaName, 'parties')}
       WHERE "branchId" = $1::uuid AND "isActive" = true AND lower(name) = lower($2) AND COALESCE(gstin, '') = COALESCE($3, '')`,
      req.branchId, src.name, src.gstin)
    if (dupe) return reply.status(200).send({ ...dupe, copied: false })

    const created = await req.db.party.create({
      data: {
        branchId: req.branchId, type: src.type, name: src.name, phone: src.phone, email: src.email,
        gstin: src.gstin, pan: src.pan, address: src.address ?? undefined, creditLimit: src.creditLimit ?? 0,
        meta: (src.meta ?? {}) as never,
      },
      select: { id: true, name: true, gstin: true },
    })
    return reply.status(201).send({ ...created, copied: true })
  })

  // GET /api/transport/firms/:id/bills — another firm's recent bills, with what a matching goods bill needs
  app.get('/firms/:id/bills', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    await assertFirmAccess(req, id)
    const bills = await q<any>(req,
      `SELECT i.id, i.number, i.date, i."taxableAmt" AS taxable, i."grandTotal" AS grand, p.id AS "partyId", p.name AS "partyName", p.gstin AS "partyGstin"
       FROM ${tbl(req.schemaName, 'invoices')} i LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice' AND i.status <> 'cancelled'
         AND COALESCE(i."domainData"->>'bill_kind', '') <> 'goods_sale'
       ORDER BY i.date DESC, i."createdAt" DESC LIMIT 20`, id)
    if (bills.length === 0) return []
    const items = await q<any>(req,
      `SELECT "invoiceId", "itemMeta" FROM ${tbl(req.schemaName, 'invoice_items')} WHERE "invoiceId" = ANY($1::uuid[])`, bills.map((b: any) => b.id))
    return bills.map((b: any) => {
      const its = items.filter((x: any) => x.invoiceId === b.id)
      const kg = its.reduce((s: number, x: any) => s + Number(x.itemMeta?.charged_kg ?? x.itemMeta?.weight_kg ?? 0), 0)
      const from = new Map<string, number>()
      for (const x of its) { const c = x.itemMeta?.from_city; if (c) from.set(c, (from.get(c) ?? 0) + 1) }
      const origin = [...from.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? null
      return {
        id: b.id, number: b.number, date: ymd(b.date), partyId: b.partyId, partyName: b.partyName, partyGstin: b.partyGstin,
        taxable: r2(Number(b.taxable)), grand: r2(Number(b.grand)), qtyMt: kg > 0 ? r2(kg / 1000) : null, origin,
      }
    })
  })

  // GET /api/transport/goods-bills/suggestions
  app.get('/goods-bills/suggestions', async (req) => {
    const rows = await q<any>(req,
      `SELECT it.description, it."hsnSacCode" AS hsn, it.unit, it."gstRate" AS "gstRate", it.rate
       FROM ${tbl(req.schemaName, 'invoice_items')} it JOIN ${tbl(req.schemaName, 'invoices')} i ON i.id = it."invoiceId"
       WHERE i."branchId" = $1::uuid AND i."domainData"->>'bill_kind' = 'goods_sale' AND i.status <> 'cancelled'
       ORDER BY i."createdAt" DESC LIMIT 200`, req.branchId)
    const seen = new Map<string, any>()
    for (const r of rows) if (!seen.has(r.description)) seen.set(r.description, { description: r.description, hsnSacCode: r.hsn, unit: r.unit, gstRate: Number(r.gstRate), rate: Number(r.rate) })
    return [...seen.values()].slice(0, 20)
  })

  // POST /api/transport/goods-bills
  app.post('/goods-bills', async (req, reply) => {
    requireWrite(req)
    const body = GoodsBillBody.parse(req.body)

    const party = await q1<any>(req,
      `SELECT id, name, "branchId" FROM ${tbl(req.schemaName, 'parties')} WHERE id = $1::uuid`, body.partyId)
    if (!party) throw httpError(404, 'Customer not found')
    if (party.branchId && party.branchId !== req.branchId)
      throw httpError(422, 'This customer belongs to another firm — copy it into this firm first')

    const date = body.date ?? todayStr()
    const invoice = await createInvoice({
      txnType: 'sale_invoice', partyId: body.partyId, date, dueDate: addDays(date, body.creditDays), notes: body.notes,
      domainData: { bill_kind: 'goods_sale', payment_terms: paymentTerms(body.creditDays), credit_days: body.creditDays },
      aiMeta: {},
      items: body.items.map((it) => ({
        description: it.description, qty: it.qty, unit: it.unit, rate: it.rate, discountPct: 0,
        gstRate: it.gstRate, gstExempt: it.gstRate === 0, hsnSacCode: it.hsnSacCode || undefined, itemMeta: {},
      })),
    } as Parameters<typeof createInvoice>[0], {
      db: req.db, branchId: req.branchId, schemaName: req.schemaName,
      userId: req.userId, role: req.role, branchDomainType: 'transport',
    })
    return reply.status(201).send({ invoice })
  })
}
