// apps/api/src/routes/transport-eway.ts
// E-way bill generation / cancellation / Part-B update / extension for an LR, through the configured
// GSP (see lib/eway-provider.ts). Registered under /api/transport.
//
// The LR is the source of truth for the consignment; the extra fields the portal needs (HSN,
// pincodes, distance, supplier invoice no/date) live on the LR too and are remembered once entered.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  tbl, q, q1, insertRow, updateRow, httpError, requireWrite, requireManager, ymd, type Ctx,
} from '../lib/transport-helpers.js'
import {
  getEwayProvider, ewayProviderStatus, EwayError, GSTIN_RE, GST_STATE_NAMES, type EwayParty,
} from '../lib/eway-provider.js'

const idParam = z.object({ id: z.string().uuid() })
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const pincode = z.string().regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits')
const vehicleNo = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,11}$/, 'Enter the registration number without spaces or dashes')

const GenerateBody = z.object({
  hsnCode:       z.string().regex(/^\d{4,8}$/, 'HSN must be 4-8 digits').optional(),
  fromPincode:   pincode.optional(),
  toPincode:     pincode.optional(),
  fromStateCode: z.string().regex(/^\d{2}$/).optional(),   // only needed for unregistered parties
  toStateCode:   z.string().regex(/^\d{2}$/).optional(),
  distanceKm:    z.number().int().min(0).max(4000).optional(),   // 0 = portal computes from pincodes
  supplyDocNo:   z.string().max(16).optional(),
  supplyDocDate: dateStr.optional(),
  docType:       z.enum(['Tax Invoice', 'Bill of Supply', 'Delivery Challan', 'Others']).default('Tax Invoice'),
  goodsGstRate:  z.number().min(0).max(28).default(0),
  unit:          z.string().max(5).default('KGS'),
  vehicleNo:     vehicleNo.optional(),
}).default({})

const stateOf = (gstin: string | null | undefined, fallback?: string) =>
  gstin && GSTIN_RE.test(gstin.toUpperCase()) ? gstin.slice(0, 2) : fallback

async function loadLrAndBusiness(req: Ctx, id: string) {
  const lr = await q1<any>(req,
    `SELECT * FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
  if (!lr) throw httpError(404, 'Lorry receipt not found')
  const biz = await q1<any>(req,
    `SELECT name, gstin, "stateCode", "domainConfig" FROM ${tbl(req.schemaName, 'branches')} WHERE id = $1::uuid`, req.branchId)
  return { lr, biz }
}

async function logEvent(req: Ctx, lrId: string, action: string, ok: boolean, provider: string, extra: {
  ewayBillNo?: string | null; message?: string | null; request?: unknown; response?: unknown
}) {
  await insertRow(req, 'transport_eway_events', {
    branchId: req.branchId, lrId, action, ok, provider,
    ewayBillNo: extra.ewayBillNo ?? null, message: extra.message ?? null,
    request: extra.request === undefined ? null : JSON.stringify(extra.request),
    response: extra.response === undefined ? null : JSON.stringify(extra.response),
    createdBy: req.userId ?? null,
  })
}

/** Runs a provider call, logs success/failure to the audit trail, and maps errors to HTTP errors. */
async function withProvider<T extends { request?: unknown; raw?: unknown }>(
  req: Ctx, lrId: string, action: string, ewayBillNo: string | null, fn: () => Promise<T>,
): Promise<T> {
  let providerName: string
  try { providerName = getEwayProvider().name } catch (err) {
    const e = err as EwayError
    throw httpError(e.statusCode ?? 503, e.message)
  }
  try {
    const out = await fn()
    await logEvent(req, lrId, action, true, providerName, { ewayBillNo, request: out.request, response: out.raw })
    return out
  } catch (err) {
    const e = err as EwayError
    await logEvent(req, lrId, action, false, providerName, { ewayBillNo, message: e.message, response: e.raw })
    throw httpError(e.statusCode ?? 502, e.message)
  }
}

export const transportEwayRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/transport/eway/status — which provider is active (mock vs live)
  app.get('/eway/status', async () => ewayProviderStatus())

  // POST /api/transport/lrs/:id/eway/generate
  app.post('/lrs/:id/eway/generate', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = GenerateBody.parse(req.body ?? {})
    const { lr, biz } = await loadLrAndBusiness(req, id)

    if (!['booked', 'in_transit'].includes(lr.status)) {
      throw httpError(422, `An e-way bill cannot be generated for an LR in status "${lr.status}"`)
    }
    if (lr.ewayBillNo) throw httpError(409, `This LR already has e-way bill ${lr.ewayBillNo}`)

    const status = ewayProviderStatus()
    const userGstin = String(biz?.gstin ?? '').toUpperCase()
    if (status.live && !GSTIN_RE.test(userGstin)) {
      throw httpError(422, 'Set a valid business GSTIN (Business & Users) before generating e-way bills')
    }

    // Anything supplied now is remembered on the LR so it is never asked for twice.
    const hsnCode       = body.hsnCode       ?? lr.hsnCode
    const fromPincode   = body.fromPincode   ?? lr.fromPincode
    const toPincode     = body.toPincode     ?? lr.toPincode
    const distanceKm    = body.distanceKm    ?? lr.distanceKm ?? 0
    const supplyDocNo   = body.supplyDocNo   ?? lr.supplyDocNo
    const supplyDocDate = body.supplyDocDate ?? (lr.supplyDocDate ? ymd(lr.supplyDocDate) : null)
    const vNo           = body.vehicleNo     ?? (lr.vehicleNo ? String(lr.vehicleNo).toUpperCase().replace(/[^A-Z0-9]/g, '') : null)

    const missing: string[] = []
    if (!hsnCode) missing.push('HSN code of the goods')
    if (!fromPincode) missing.push('pickup pincode')
    if (!toPincode) missing.push('delivery pincode')
    if (!(Number(lr.declaredValue) > 0)) missing.push('declared value of the goods')
    const fromState = stateOf(lr.consignorGstin, body.fromStateCode)
    const toState   = stateOf(lr.consigneeGstin, body.toStateCode)
    if (!fromState || !GST_STATE_NAMES[fromState]) missing.push('consignor state (give a GSTIN or the state code)')
    if (!toState || !GST_STATE_NAMES[toState])     missing.push('consignee state (give a GSTIN or the state code)')
    if (missing.length) throw httpError(422, `Cannot generate an e-way bill - missing: ${missing.join(', ')}`)

    const lrDateStr = ymd(lr.lrDate)
    const party = (name: string, gstin: string | null, address: string | null, city: string, pin: string, state: string): EwayParty => ({
      name, gstin: gstin && GSTIN_RE.test(gstin.toUpperCase()) ? gstin.toUpperCase() : null,
      address: address || city, place: city, pincode: pin, stateCode: state,
    })

    const result = await withProvider(req, id, 'generate', null, () => getEwayProvider().generate({
      userGstin: userGstin || 'MOCK00000000000',
      docType: supplyDocNo ? body.docType : 'Others',
      docNo: supplyDocNo || lr.lrNo,
      docDate: supplyDocNo && supplyDocDate ? supplyDocDate : lrDateStr,
      from: party(lr.consignorName, lr.consignorGstin, lr.consignorAddress, lr.fromCity, fromPincode, fromState!),
      to:   party(lr.consigneeName, lr.consigneeGstin, lr.consigneeAddress, lr.toCity, toPincode, toState!),
      hsnCode, productName: lr.goodsDescription,
      quantity: Number(lr.actualWeightKg) > 0 ? Number(lr.actualWeightKg) : Math.max(1, Number(lr.packages)),
      unit: Number(lr.actualWeightKg) > 0 ? body.unit : 'NOS',
      taxableValue: Number(lr.declaredValue), gstRatePct: body.goodsGstRate,
      vehicleNo: vNo, distanceKm,
      transporterName: String(biz?.domainConfig?.business_name ?? biz?.name ?? 'Transporter'),
      transDocNo: lr.lrNo, transDocDate: lrDateStr,
    }))

    const updated = await updateRow(req, 'transport_lorry_receipts', id, {
      hsnCode, fromPincode, toPincode, distanceKm, supplyDocNo, supplyDocDate,
      ewayBillNo: result.ewayBillNo, ewayValidUpto: result.validUpto,
      ewayStatus: 'active', ewayGeneratedAt: result.generatedAt, ewayCancelledAt: null,
    })
    return reply.status(201).send({
      ewayBillNo: result.ewayBillNo, validUpto: result.validUpto, generatedAt: result.generatedAt,
      provider: status.provider, lr: updated,
    })
  })

  // POST /api/transport/lrs/:id/eway/cancel - only valid within 24h of generation and before verification
  app.post('/lrs/:id/eway/cancel', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      reason: z.enum(['duplicate', 'order_cancelled', 'data_entry_mistake', 'others']),
      remark: z.string().min(3).max(100),
    }).parse(req.body ?? {})
    const { lr, biz } = await loadLrAndBusiness(req, id)
    if (!lr.ewayBillNo || lr.ewayStatus !== 'active') throw httpError(422, 'This LR has no active e-way bill to cancel')

    await withProvider(req, id, 'cancel', lr.ewayBillNo, () => getEwayProvider().cancel({
      userGstin: String(biz?.gstin ?? 'MOCK00000000000'), ewayBillNo: lr.ewayBillNo, reason: body.reason, remark: body.remark,
    }))
    // The number stays in the audit trail; the LR is freed so a corrected bill can be generated.
    return updateRow(req, 'transport_lorry_receipts', id, {
      ewayBillNo: null, ewayValidUpto: null, ewayStatus: 'cancelled', ewayCancelledAt: new Date(),
    })
  })

  // POST /api/transport/lrs/:id/eway/vehicle - Part-B update (breakdown / transhipment / first assignment)
  app.post('/lrs/:id/eway/vehicle', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      vehicleNo,
      reason: z.enum(['breakdown', 'transhipment', 'others', 'first_time']).default('first_time'),
      remark: z.string().min(3).max(100).default('Vehicle assigned'),
      fromPlace: z.string().max(60).optional(),
      fromStateCode: z.string().regex(/^\d{2}$/).optional(),
    }).parse(req.body ?? {})
    const { lr, biz } = await loadLrAndBusiness(req, id)
    if (!lr.ewayBillNo || lr.ewayStatus !== 'active') throw httpError(422, 'This LR has no active e-way bill')

    const stateCode = body.fromStateCode ?? stateOf(biz?.gstin) ?? stateOf(lr.consignorGstin) ?? '24'
    await withProvider(req, id, 'vehicle', lr.ewayBillNo, () => getEwayProvider().updateVehicle({
      userGstin: String(biz?.gstin ?? 'MOCK00000000000'), ewayBillNo: lr.ewayBillNo, vehicleNo: body.vehicleNo,
      fromPlace: body.fromPlace ?? lr.fromCity, fromStateCode: stateCode,
      reason: body.reason, remark: body.remark, transDocNo: lr.lrNo, transDocDate: ymd(lr.lrDate),
    }))
    return updateRow(req, 'transport_lorry_receipts', id, { vehicleNo: body.vehicleNo })
  })

  // POST /api/transport/lrs/:id/eway/extend - extend validity (allowed from 8h before to 8h after expiry)
  app.post('/lrs/:id/eway/extend', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      remainingKm: z.number().int().min(1).max(4000),
      reason: z.enum(['Natural Calamity', 'Law and Order Situation', 'Transshipment', 'Accident', 'Others']).default('Others'),
      remark: z.string().min(3).max(100),
      currentPlace: z.string().max(60).optional(),
      currentStateCode: z.string().regex(/^\d{2}$/).optional(),
    }).parse(req.body ?? {})
    const { lr, biz } = await loadLrAndBusiness(req, id)
    if (!lr.ewayBillNo || lr.ewayStatus !== 'active') throw httpError(422, 'This LR has no active e-way bill')
    if (!lr.vehicleNo) throw httpError(422, 'Add the vehicle number (Part-B) before extending validity')

    const out = await withProvider(req, id, 'extend', lr.ewayBillNo, () => getEwayProvider().extend({
      userGstin: String(biz?.gstin ?? 'MOCK00000000000'), ewayBillNo: lr.ewayBillNo,
      vehicleNo: String(lr.vehicleNo).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      fromPlace: body.currentPlace ?? lr.fromCity,
      fromStateCode: body.currentStateCode ?? stateOf(biz?.gstin) ?? stateOf(lr.consignorGstin) ?? '24',
      remainingKm: body.remainingKm, reason: body.reason, remark: body.remark, inTransit: lr.status === 'in_transit',
    }))
    return updateRow(req, 'transport_lorry_receipts', id, { ewayValidUpto: out.validUpto })
  })

  // GET /api/transport/lrs/:id/eway/events - audit trail of every provider call for this LR
  app.get('/lrs/:id/eway/events', async (req) => {
    const { id } = idParam.parse(req.params)
    return q(req,
      `SELECT id, action, ok, provider, "ewayBillNo", message, "createdAt"
       FROM ${tbl(req.schemaName, 'transport_eway_events')}
       WHERE "lrId" = $1::uuid AND "branchId" = $2::uuid ORDER BY "createdAt" DESC LIMIT 50`, id, req.branchId)
  })
}
