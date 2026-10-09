// apps/api/src/routes/transport-lr.ts
// Lorry Receipts (consignment notes): booking, trip assignment, delivery, POD,
// to-pay collection, cancellation. Registered under /api/transport.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { FREIGHT_TYPES, GST_MODES } from '@billing/domain-registry'
import {
  tbl, q, q1, run, insertRow, updateRow, httpError, requireWrite, requireManager,
  nextSeq, fyLabel, todayStr, r2, branchConfig, type Ctx,
} from '../lib/transport-helpers.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const idParam = z.object({ id: z.string().uuid() })
const money   = z.number().min(0).max(1e9)

/**
 * Which weight the freight is charged on:
 *   manual — the charged weight typed in (falls back to load qty)      [default]
 *   load   — loaded quantity           unload — quantity received at destination (falls back to load)
 *   lower  — the smaller of load and unload (customer's shortage allowance)
 */
export const WEIGHT_BASES = ['manual', 'load', 'unload', 'lower'] as const

const LrBody = z.object({
  lrDate:           dateStr.optional(),
  consignorId:      z.string().uuid().nullable().optional(),
  consignorName:    z.string().min(1).max(150).optional(),
  consignorGstin:   z.string().max(15).nullable().optional(),
  consignorPhone:   z.string().max(15).nullable().optional(),
  consignorAddress: z.string().max(400).nullable().optional(),
  consigneeId:      z.string().uuid().nullable().optional(),
  consigneeName:    z.string().min(1).max(150).optional(),
  consigneeGstin:   z.string().max(15).nullable().optional(),
  consigneePhone:   z.string().max(15).nullable().optional(),
  consigneeAddress: z.string().max(400).nullable().optional(),
  fromCity:         z.string().min(1).max(100),
  toCity:           z.string().min(1).max(100),
  goodsDescription: z.string().min(1).max(300),
  packages:         z.number().int().min(0).default(0),
  packageType:      z.string().max(50).nullable().optional(),
  actualWeightKg:   z.number().min(0).default(0),          // load quantity
  unloadWeightKg:   z.number().min(0).nullable().optional(),
  chargedWeightKg:  z.number().min(0).optional(),
  weightBasis:      z.enum(WEIGHT_BASES).default('manual'),
  lrNo:             z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 \-\/._]*$/, 'LR number may use letters, digits and - / . _').optional(),
  gatePassNo:       z.string().max(40).nullable().optional(),
  shipmentNo:       z.string().max(40).nullable().optional(),
  declaredValue:    money.default(0),
  invoiceRefs:      z.string().max(300).nullable().optional(),
  ewayBillNo:       z.string().max(20).nullable().optional(),
  ewayValidUpto:    z.string().datetime({ offset: true }).or(dateStr).nullable().optional(),
  freightType:      z.enum(FREIGHT_TYPES).default('tbb'),
  rateBasis:        z.enum(['fixed', 'per_ton', 'per_kg', 'per_pkg']).default('fixed'),
  rate:             money.default(0),
  freightAmount:    money.optional(),          // used only when rateBasis = fixed
  loadingCharges:   money.default(0),
  unloadingCharges: money.default(0),
  detentionCharges: money.default(0),
  otherCharges:     money.default(0),
  advancePaid:      money.default(0),
  gstMode:          z.enum(GST_MODES).optional(),
  tripId:           z.string().uuid().nullable().optional(),
  remarks:          z.string().max(500).nullable().optional(),
})

type Money = {
  rateBasis: string; rate: number; freightAmount?: number
  actualWeightKg: number; unloadWeightKg?: number | null; chargedWeightKg?: number
  weightBasis?: string; packages: number
  loadingCharges: number; unloadingCharges: number; detentionCharges: number; otherCharges: number
}

/** Server is the authority on freight maths — the UI only previews it. */
export function computeFreight(b: Money) {
  const load = b.actualWeightKg
  const unload = b.unloadWeightKg != null && b.unloadWeightKg > 0 ? b.unloadWeightKg : null
  let chargedWeightKg: number
  switch (b.weightBasis) {
    case 'load':   chargedWeightKg = load; break
    case 'unload': chargedWeightKg = unload ?? load; break
    case 'lower':  chargedWeightKg = unload != null ? Math.min(load, unload) : load; break
    default:       chargedWeightKg = b.chargedWeightKg && b.chargedWeightKg > 0 ? b.chargedWeightKg : load
  }
  let freightAmount: number
  switch (b.rateBasis) {
    case 'per_ton': freightAmount = (chargedWeightKg / 1000) * b.rate; break
    case 'per_kg':  freightAmount = chargedWeightKg * b.rate;          break
    case 'per_pkg': freightAmount = b.packages * b.rate;               break
    default:        freightAmount = b.freightAmount ?? b.rate
  }
  freightAmount = r2(freightAmount)
  const totalAmount = r2(freightAmount + b.loadingCharges + b.unloadingCharges + b.detentionCharges + b.otherCharges)
  return { chargedWeightKg, freightAmount, totalAmount }
}

function addressText(a: any): string | null {
  if (!a) return null
  if (typeof a === 'string') return a
  const parts = [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** Resolve consignor/consignee from a party record, letting explicit body values win. */
async function partySnapshot(
  req: any, partyId: string | null | undefined,
): Promise<{ name: string; gstin: string | null; phone: string | null; address: string | null } | null> {
  if (!partyId) return null
  const p = await q1<any>(req,
    `SELECT name, gstin, phone, address FROM ${tbl(req.schemaName, 'parties')} WHERE id = $1::uuid`, partyId)
  if (!p) throw httpError(404, 'Party not found')
  return { name: p.name, gstin: p.gstin ?? null, phone: p.phone ?? null, address: addressText(p.address) }
}

const LR_SELECT = (schema: string) => `
  SELECT lr.*, t."tripNo", i.number AS "invoiceNo", i.status AS "invoiceStatus"
  FROM ${tbl(schema, 'transport_lorry_receipts')} lr
  LEFT JOIN ${tbl(schema, 'transport_trips')} t ON t.id = lr."tripId"
  LEFT JOIN ${tbl(schema, 'invoices')}        i ON i.id = lr."invoiceId"`


// ── Booking ───────────────────────────────────────────────────────────────────

const BulkRow = LrBody.partial().extend({
  vehicleNo: z.string().max(20).optional(),
})

const BulkBody = z.object({
  common: LrBody.partial().extend({ consignorId: z.string().uuid() }),   // customer + defaults shared by every row
  rows:   z.array(BulkRow).min(1).max(200),
  markDelivered: z.boolean().default(false),                              // entering history: LRs are already delivered
})

/** Books one LR. Works inside a transaction when given a ctx wrapping a tx client. */
async function bookLr(
  ctx: Ctx, body: z.infer<typeof LrBody> & { vehicleNo?: string; vehicleId?: string },
  cfg: Record<string, any>, opts: { markDelivered?: boolean; consigneeFromConsignor?: boolean } = {},
) {
  const [consignor, consignee] = await Promise.all([
    partySnapshot(ctx, body.consignorId), partySnapshot(ctx, body.consigneeId),
  ])
  const consignorName = body.consignorName ?? consignor?.name
  // Bulk/monthly entry: the receiver is usually the customer's own plant — default to the consignor.
  const consigneeName = body.consigneeName ?? consignee?.name ?? (opts.consigneeFromConsignor ? consignorName : undefined)
  if (!consignorName) throw httpError(422, 'Consignor is required (pick a party or type a name)')
  if (!consigneeName) throw httpError(422, 'Consignee is required (pick a party or type a name)')
  if (!body.fromCity || !body.toCity) throw httpError(422, 'From and To cities are required')
  if (!body.goodsDescription) throw httpError(422, 'Goods description is required')

  const calc = computeFreight(body)
  if (body.advancePaid > calc.totalAmount) throw httpError(422, 'Advance cannot exceed the total freight')

  // Optional trip attachment at booking
  let trip: any = null
  if (body.tripId) trip = await loadAttachableTrip(ctx, body.tripId)

  const lrDate = body.lrDate ?? todayStr()
  let lrNo: string
  if (body.lrNo) {
    // Operators keep their own LR book — accept their number, but never two LRs with the same one.
    lrNo = body.lrNo
    const dup = await q1(ctx,
      `SELECT id FROM ${tbl(ctx.schemaName, 'transport_lorry_receipts')} WHERE "branchId" = $1::uuid AND UPPER("lrNo") = UPPER($2)`,
      ctx.branchId, lrNo)
    if (dup) throw httpError(409, `LR number ${lrNo} already exists`)
  } else {
    const seq = await nextSeq(ctx, 'lr', fyLabel(lrDate))
    lrNo = `${cfg['lr_prefix'] ?? 'LR'}-${fyLabel(lrDate)}-${String(seq).padStart(4, '0')}`
  }

  const warnings: string[] = []
  const threshold = Number(cfg['eway_threshold'] ?? 50000)
  if (body.declaredValue > threshold && !body.ewayBillNo) {
    warnings.push(`Consignment value is above ₹${threshold.toLocaleString('en-IN')} — an e-way bill is required before the vehicle moves`)
  }

  const delivered = !!opts.markDelivered
  const row = await insertRow(ctx, 'transport_lorry_receipts', {
    branchId: ctx.branchId, lrNo, lrDate,
    consignorId: body.consignorId ?? null, consignorName,
    consignorGstin:   body.consignorGstin   ?? consignor?.gstin   ?? null,
    consignorPhone:   body.consignorPhone   ?? consignor?.phone   ?? null,
    consignorAddress: body.consignorAddress ?? consignor?.address ?? null,
    consigneeId: body.consigneeId ?? (opts.consigneeFromConsignor && !body.consigneeName ? body.consignorId ?? null : null), consigneeName,
    consigneeGstin:   body.consigneeGstin   ?? consignee?.gstin   ?? null,
    consigneePhone:   body.consigneePhone   ?? consignee?.phone   ?? null,
    consigneeAddress: body.consigneeAddress ?? consignee?.address ?? null,
    fromCity: body.fromCity, toCity: body.toCity,
    goodsDescription: body.goodsDescription,
    packages: body.packages, packageType: body.packageType ?? null,
    actualWeightKg: body.actualWeightKg, unloadWeightKg: body.unloadWeightKg ?? null,
    chargedWeightKg: calc.chargedWeightKg, weightBasis: body.weightBasis,
    gatePassNo: body.gatePassNo ?? null, shipmentNo: body.shipmentNo ?? null,
    declaredValue: body.declaredValue, invoiceRefs: body.invoiceRefs ?? null,
    ewayBillNo: body.ewayBillNo ?? null,
    ewayValidUpto: body.ewayValidUpto ? new Date(body.ewayValidUpto) : null,
    freightType: body.freightType, rateBasis: body.rateBasis, rate: body.rate,
    freightAmount: calc.freightAmount,
    loadingCharges: body.loadingCharges, unloadingCharges: body.unloadingCharges,
    detentionCharges: body.detentionCharges, otherCharges: body.otherCharges,
    advancePaid: body.advancePaid, totalAmount: calc.totalAmount,
    gstMode: body.gstMode ?? cfg['default_gst_mode'] ?? 'rcm',
    remarks: body.remarks ?? null,
    createdBy: ctx.userId,
    ...(trip ? tripFields(trip) : {}),
    ...(!trip && body.vehicleNo ? { vehicleNo: body.vehicleNo, vehicleId: body.vehicleId ?? null } : {}),
    status: delivered ? 'delivered' : trip?.status === 'running' ? 'in_transit' : 'booked',
    dispatchedAt: delivered || trip?.status === 'running' ? new Date(`${lrDate}T00:00:00Z`) : undefined,
    deliveredAt: delivered ? new Date(`${lrDate}T00:00:00Z`) : undefined,
  })
  return { ...row, warnings }
}

export const transportLrRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/transport/lrs
  app.get('/lrs', async (req) => {
    const qy = z.object({
      status:      z.string().optional(),                 // comma-separated
      freightType: z.string().optional(),
      partyId:     z.string().uuid().optional(),          // consignor OR consignee
      tripId:      z.string().uuid().optional(),
      unbilled:    z.enum(['true', 'false']).optional(),
      unassigned:  z.enum(['true', 'false']).optional(),
      toPayPending: z.enum(['true', 'false']).optional(),
      from:        dateStr.optional(),
      to:          dateStr.optional(),
      search:      z.string().optional(),
      page:        z.coerce.number().int().min(1).default(1),
      limit:       z.coerce.number().int().min(1).max(200).default(20),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = `WHERE lr."branchId" = $1::uuid`
    if (qy.status) {
      const list = qy.status.split(',').map((s) => s.trim()).filter(Boolean)
      params.push(list)
      where += ` AND lr.status = ANY($${params.length}::text[])`
    }
    if (qy.freightType) { params.push(qy.freightType); where += ` AND lr."freightType" = $${params.length}` }
    if (qy.partyId)     { params.push(qy.partyId)
      where += ` AND (lr."consignorId" = $${params.length}::uuid OR lr."consigneeId" = $${params.length}::uuid)` }
    if (qy.tripId)      { params.push(qy.tripId);  where += ` AND lr."tripId" = $${params.length}::uuid` }
    if (qy.from)        { params.push(qy.from);    where += ` AND lr."lrDate" >= $${params.length}::date` }
    if (qy.to)          { params.push(qy.to);      where += ` AND lr."lrDate" <= $${params.length}::date` }
    if (qy.unbilled === 'true')    where += ` AND (lr."invoiceId" IS NULL OR i.status = 'cancelled') AND lr.status != 'cancelled'`
    if (qy.toPayPending === 'true') where += ` AND lr."freightType" = 'to_pay' AND lr.status != 'cancelled' AND lr."totalAmount" - lr."advancePaid" - lr."toPayCollected" > 0`
    if (qy.unassigned === 'true')  where += ` AND lr."tripId" IS NULL AND lr.status = 'booked'`
    if (qy.search) {
      params.push(`%${qy.search}%`)
      const n = params.length
      where += ` AND (lr."lrNo" ILIKE $${n} OR lr."consignorName" ILIKE $${n} OR lr."consigneeName" ILIKE $${n}
                  OR lr."vehicleNo" ILIKE $${n} OR lr."ewayBillNo" ILIKE $${n} OR lr."goodsDescription" ILIKE $${n})`
    }

    const offset = (qy.page - 1) * qy.limit
    const [rows, total] = await Promise.all([
      q(req, `${LR_SELECT(req.schemaName)} ${where}
              ORDER BY lr."lrDate" DESC, lr."createdAt" DESC
              LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, qy.limit, offset),
      q<{ count: number; amount: number }>(req,
        `SELECT COUNT(*) AS count, COALESCE(SUM(lr."totalAmount"),0) AS amount
         FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} lr
         LEFT JOIN ${tbl(req.schemaName, 'invoices')} i ON i.id = lr."invoiceId" ${where}`, ...params),
    ])
    return { data: rows, total: total[0]?.count ?? 0, totalAmount: total[0]?.amount ?? 0, page: qy.page, limit: qy.limit }
  })

  // POST /api/transport/lrs — book a consignment
  app.post('/lrs', async (req, reply) => {
    requireWrite(req)
    const body = LrBody.parse(req.body)
    const cfg  = await branchConfig(req)
    return reply.status(201).send(await bookLr(req, body, cfg))
  })

  // POST /api/transport/lrs/bulk — enter many consignments for one customer in one go
  // (monthly dispatch register). All-or-nothing: one bad row rejects the whole batch.
  app.post('/lrs/bulk', async (req, reply) => {
    requireWrite(req)
    const body = BulkBody.parse(req.body)
    const cfg  = await branchConfig(req)

    // Resolve fleet vehicles once so a typed registration links to the vehicle record.
    const fleet = await q<{ id: string; regNo: string }>(req,
      `SELECT id, "regNo" FROM ${tbl(req.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid`, req.branchId)
    const byReg = new Map(fleet.map((v) => [v.regNo, v.id]))

    // Reject duplicate manual numbers inside the batch before touching the database.
    const typed = body.rows.map((r) => r.lrNo).filter(Boolean) as string[]
    if (new Set(typed.map((n) => n.toUpperCase())).size !== typed.length) throw httpError(422, 'Duplicate LR numbers in this batch')

    const created = await req.db.$transaction(async (tx) => {
      const ctx = { db: tx, schemaName: req.schemaName, branchId: req.branchId, userId: req.userId }
      const out: any[] = []
      for (const [i, r] of body.rows.entries()) {
        try {
          const { vehicleNo, ...rowFields } = r
          // Re-validate the merged row so defaults (charges = 0, freight type…) apply and bad rows are named.
          const parsed = LrBody.safeParse({ ...body.common, ...rowFields })
          if (!parsed.success) {
            throw httpError(422, parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; '))
          }
          const reg = vehicleNo ? vehicleNo.toUpperCase().replace(/[^A-Z0-9]/g, '') : undefined
          out.push(await bookLr(ctx, { ...parsed.data, vehicleNo: reg, vehicleId: reg ? byReg.get(reg) : undefined }, cfg, {
            markDelivered: body.markDelivered, consigneeFromConsignor: true,
          }))
        } catch (err) {
          const e = err as Error & { statusCode?: number }
          throw httpError(e.statusCode ?? 422, `Row ${i + 1}: ${e.message}`)
        }
      }
      return out
    }, { timeout: 60_000 })

    return reply.status(201).send({
      count: created.length,
      totalAmount: r2(created.reduce((s, l) => s + Number(l.totalAmount), 0)),
      lrs: created,
    })
  })

  // GET /api/transport/lrs/:id
  app.get('/lrs/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const lr = await q1(req, `${LR_SELECT(req.schemaName)} WHERE lr.id = $1::uuid AND lr."branchId" = $2::uuid`, id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    return lr
  })

  // PATCH /api/transport/lrs/:id — edit before billing
  app.patch('/lrs/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const existing = await q1<any>(req,
      `SELECT * FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!existing) throw httpError(404, 'Lorry receipt not found')
    if (existing.status === 'billed')    throw httpError(422, 'Billed LRs cannot be edited — cancel the freight bill first')
    if (existing.status === 'cancelled') throw httpError(422, 'Cancelled LRs cannot be edited')

    const body = LrBody.partial().parse(req.body)
    // Never let a PATCH move trip/status — dedicated endpoints do that.
    delete (body as any).tripId

    const merged = { ...existing, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as any
    const calc = computeFreight({
      rateBasis: merged.rateBasis, rate: Number(merged.rate),
      freightAmount: body.freightAmount ?? (merged.rateBasis === 'fixed' ? Number(body.rate ?? merged.freightAmount) : undefined),
      actualWeightKg: Number(merged.actualWeightKg),
      unloadWeightKg: merged.unloadWeightKg == null ? null : Number(merged.unloadWeightKg),
      weightBasis: merged.weightBasis,
      chargedWeightKg: body.chargedWeightKg ?? Number(merged.chargedWeightKg),
      packages: Number(merged.packages),
      loadingCharges: Number(merged.loadingCharges), unloadingCharges: Number(merged.unloadingCharges),
      detentionCharges: Number(merged.detentionCharges), otherCharges: Number(merged.otherCharges),
    })
    if (Number(merged.advancePaid) > calc.totalAmount) throw httpError(422, 'Advance cannot exceed the total freight')

    if (body.lrNo && body.lrNo.toUpperCase() !== String(existing.lrNo).toUpperCase()) {
      const dup = await q1(req,
        `SELECT id FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
         WHERE "branchId" = $1::uuid AND UPPER("lrNo") = UPPER($2) AND id != $3::uuid`, req.branchId, body.lrNo, id)
      if (dup) throw httpError(409, `LR number ${body.lrNo} already exists`)
    }

    const { freightAmount: _fa, ...rest } = body as any
    const row = await updateRow(req, 'transport_lorry_receipts', id, {
      ...rest,
      ewayValidUpto: body.ewayValidUpto === undefined ? undefined : (body.ewayValidUpto ? new Date(body.ewayValidUpto) : null),
      chargedWeightKg: calc.chargedWeightKg,
      freightAmount: calc.freightAmount,
      totalAmount: calc.totalAmount,
    })
    return row
  })

  // POST /api/transport/lrs/:id/assign { tripId } — put an LR on a trip
  app.post('/lrs/:id/assign', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const { tripId } = z.object({ tripId: z.string().uuid() }).parse(req.body)
    const lr = await q1<any>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status !== 'booked' && lr.status !== 'in_transit') {
      throw httpError(422, `An LR in status "${lr.status}" cannot be (re)assigned to a trip`)
    }
    const trip = await loadAttachableTrip(req, tripId)
    return updateRow(req, 'transport_lorry_receipts', id, {
      ...tripFields(trip),
      status: trip.status === 'running' ? 'in_transit' : 'booked',
      dispatchedAt: trip.status === 'running' ? new Date() : null,
    })
  })

  // POST /api/transport/lrs/:id/unassign — back to unassigned
  app.post('/lrs/:id/unassign', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const lr = await q1<any>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status !== 'booked' && lr.status !== 'in_transit') {
      throw httpError(422, `An LR in status "${lr.status}" cannot be removed from its trip`)
    }
    return updateRow(req, 'transport_lorry_receipts', id, {
      tripId: null, vehicleId: null, vehicleNo: null, driverName: null, status: 'booked', dispatchedAt: null,
    })
  })

  // POST /api/transport/lrs/:id/deliver
  app.post('/lrs/:id/deliver', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      deliveredAt: z.string().datetime({ offset: true }).or(dateStr).optional(),
      receivedBy:  z.string().max(100).optional(),
      damageNotes: z.string().max(500).optional(),
      toPayCollected: money.optional(),
      unloadWeightKg: z.number().min(0).optional(),     // quantity actually received — may re-price the LR
    }).parse(req.body ?? {})
    const lr = await q1<any>(req,
      `SELECT * FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status !== 'booked' && lr.status !== 'in_transit') {
      throw httpError(422, `An LR in status "${lr.status}" cannot be marked delivered`)
    }

    // Receiving-end quantity: if freight is charged on unload / the lower weight, re-price now.
    let repriced: Record<string, unknown> = {}
    let total = Number(lr.totalAmount)
    if (body.unloadWeightKg != null) {
      const calc = computeFreight({
        rateBasis: lr.rateBasis, rate: Number(lr.rate), freightAmount: Number(lr.freightAmount),
        actualWeightKg: Number(lr.actualWeightKg), unloadWeightKg: body.unloadWeightKg, weightBasis: lr.weightBasis,
        chargedWeightKg: Number(lr.chargedWeightKg), packages: Number(lr.packages),
        loadingCharges: Number(lr.loadingCharges), unloadingCharges: Number(lr.unloadingCharges),
        detentionCharges: Number(lr.detentionCharges), otherCharges: Number(lr.otherCharges),
      })
      repriced = { unloadWeightKg: body.unloadWeightKg }
      if (lr.weightBasis === 'unload' || lr.weightBasis === 'lower') {
        if (Number(lr.advancePaid) > calc.totalAmount) throw httpError(422, 'Re-priced freight would fall below the advance already received')
        repriced = { ...repriced, chargedWeightKg: calc.chargedWeightKg, freightAmount: calc.freightAmount, totalAmount: calc.totalAmount }
        total = calc.totalAmount
      }
    }

    const due = r2(total - Number(lr.advancePaid))
    if (body.toPayCollected != null && body.toPayCollected > due) {
      throw httpError(422, `Collected amount exceeds the balance due (₹${due})`)
    }
    return updateRow(req, 'transport_lorry_receipts', id, {
      ...repriced,
      status: 'delivered',
      deliveredAt: body.deliveredAt ? new Date(body.deliveredAt) : new Date(),
      receivedBy: body.receivedBy,
      damageNotes: body.damageNotes,
      ...(body.toPayCollected != null && body.toPayCollected > 0
        ? { toPayCollected: body.toPayCollected, toPayCollectedAt: new Date() } : {}),
    })
  })

  // POST /api/transport/lrs/:id/pod — signed proof of delivery received back
  app.post('/lrs/:id/pod', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      podReceivedAt: z.string().datetime({ offset: true }).or(dateStr).optional(),
      podNotes:      z.string().max(500).optional(),
    }).parse(req.body ?? {})
    const lr = await q1<any>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status !== 'delivered') throw httpError(422, 'Mark the LR delivered before recording its POD')
    return updateRow(req, 'transport_lorry_receipts', id, {
      status: 'pod_received',
      podReceivedAt: body.podReceivedAt ? new Date(body.podReceivedAt) : new Date(),
      podNotes: body.podNotes,
    })
  })

  // POST /api/transport/lrs/:id/collect — record To-Pay cash collected on delivery
  app.post('/lrs/:id/collect', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const { amount } = z.object({ amount: z.number().positive().max(1e9) }).parse(req.body)
    const lr = await q1<any>(req,
      `SELECT "totalAmount", "advancePaid", "toPayCollected", status FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status === 'cancelled') throw httpError(422, 'Cancelled LR')
    const due = r2(lr.totalAmount - lr.advancePaid - lr.toPayCollected)
    if (amount > due) throw httpError(422, `Amount exceeds the balance due (₹${due})`)
    return updateRow(req, 'transport_lorry_receipts', id, {
      toPayCollected: r2(lr.toPayCollected + amount), toPayCollectedAt: new Date(),
    })
  })

  // POST /api/transport/lrs/:id/cancel
  app.post('/lrs/:id/cancel', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body ?? {})
    const lr = await q1<any>(req,
      `SELECT lr.status, i.status AS "invoiceStatus"
       FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} lr
       LEFT JOIN ${tbl(req.schemaName, 'invoices')} i ON i.id = lr."invoiceId"
       WHERE lr.id = $1::uuid AND lr."branchId" = $2::uuid`, id, req.branchId)
    if (!lr) throw httpError(404, 'Lorry receipt not found')
    if (lr.status === 'cancelled') throw httpError(422, 'Already cancelled')
    if (lr.status === 'billed' && lr.invoiceStatus !== 'cancelled') {
      throw httpError(422, 'This LR is on a freight bill — cancel the bill first')
    }
    return updateRow(req, 'transport_lorry_receipts', id, {
      status: 'cancelled', remarks: `Cancelled: ${reason}`, tripId: null,
    })
  })

  // GET /api/transport/lrs-eway-expiring?hours=24 — in-transit LRs whose e-way bill is about to lapse
  app.get('/lrs-eway-expiring', async (req) => {
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).parse(req.query)
    return q(req,
      `SELECT id, "lrNo", "consignorName", "consigneeName", "fromCity", "toCity", "vehicleNo",
              "ewayBillNo", "ewayValidUpto"
       FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE "branchId" = $1::uuid AND status IN ('booked','in_transit') AND "ewayValidUpto" IS NOT NULL
         AND "ewayValidUpto" <= NOW() + ($2 || ' hours')::interval
       ORDER BY "ewayValidUpto" ASC`, req.branchId, String(hours))
  })

  // GET /api/transport/utils/eway-validity?distanceKm=550&odc=false&from=ISO
  // Validity per CGST Rule 138(10): 1 day per 200 km (100 km for over-dimensional cargo), min 1 day.
  app.get('/utils/eway-validity', async (req) => {
    const qy = z.object({
      distanceKm: z.coerce.number().positive().max(10000),
      odc:        z.enum(['true', 'false']).default('false'),
      from:       z.string().datetime({ offset: true }).optional(),
    }).parse(req.query)
    const perDay = qy.odc === 'true' ? 100 : 200
    const days   = Math.max(1, Math.ceil(qy.distanceKm / perDay))
    const start  = qy.from ? new Date(qy.from) : new Date()
    // Validity runs to midnight at the end of the last day.
    const istMs  = start.getTime() + 5.5 * 3600_000
    const endIst = new Date(istMs); endIst.setUTCHours(23, 59, 59, 0); endIst.setUTCDate(endIst.getUTCDate() + days - 1)
    return { days, validUpto: new Date(endIst.getTime() - 5.5 * 3600_000).toISOString(), kmPerDay: perDay }
  })
}

// ── Helpers shared with trips ─────────────────────────────────────────────────

async function loadAttachableTrip(req: any, tripId: string) {
  const trip = await q1<any>(req,
    `SELECT t.id, t.status, t."vehicleId", v."regNo" AS "vehicleNo", d.name AS "driverName"
     FROM ${tbl(req.schemaName, 'transport_trips')} t
     JOIN ${tbl(req.schemaName, 'transport_vehicles')} v ON v.id = t."vehicleId"
     LEFT JOIN ${tbl(req.schemaName, 'transport_drivers')} d ON d.id = t."driverId"
     WHERE t.id = $1::uuid AND t."branchId" = $2::uuid`, tripId, req.branchId)
  if (!trip) throw httpError(404, 'Trip not found')
  if (trip.status !== 'planned' && trip.status !== 'running') {
    throw httpError(422, `Cannot add LRs to a ${trip.status} trip`)
  }
  return trip
}

function tripFields(trip: any) {
  return { tripId: trip.id, vehicleId: trip.vehicleId, vehicleNo: trip.vehicleNo, driverName: trip.driverName ?? null }
}

export { loadAttachableTrip, tripFields }
