// apps/api/src/routes/transport-billing.ts
// Freight billing (LRs → GST invoice), dashboard, and transport reports.
// Registered under /api/transport.
//
// A freight bill is a normal `sale_invoice` created through the shared invoice
// service — so numbering, GST split (CGST/SGST vs IGST), party balance, payments,
// aging, GSTR-1 and PDF all work exactly as in the rest of the platform. The LRs
// simply point at the invoice via transport_lorry_receipts."invoiceId".

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { createHash } from 'crypto'
import { z } from 'zod'
import { GST_MODES, gstRateForMode, FREIGHT_TYPES, type GstMode } from '@billing/domain-registry'
import { createInvoice, recordPayment } from '../services/invoice.service.js'
import { withIdempotency, IdempotencyConflictError } from '../lib/idempotency.js'
import { notifyBill, safely } from '../lib/transport-notify.js'
import {
  tbl, q, q1, run, httpError, requireWrite, todayStr, addDays, r2, branchConfig, ymd,
} from '../lib/transport-helpers.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const BillBody = z.object({
  partyId:    z.string().uuid(),
  lrIds:      z.array(z.string().uuid()).min(1).max(200),
  gstMode:    z.enum(GST_MODES).optional(),
  date:       dateStr.optional(),
  creditDays: z.number().int().min(0).max(180).default(30),
  notes:      z.string().max(800).optional(),
  tdsApplicable: z.boolean().default(false),
  tdsRatePct:    z.number().min(0).max(10).default(1),
})

function paymentTerms(days: number) {
  if (days <= 0)  return 'immediate' as const
  if (days <= 7)  return '7_days'    as const
  if (days <= 15) return '15_days'   as const
  if (days <= 30) return '30_days'   as const
  if (days <= 45) return '45_days'   as const
  return '60_days' as const
}

const RCM_NOTE =
  'GST on this transport service is payable by the recipient under reverse charge (RCM) where applicable — ' +
  'Notification 13/2017-Central Tax (Rate).'

/** LRs that can still be put on a freight bill (not cancelled, no live invoice). */
const BILLABLE = (s: string) => `
  FROM ${tbl(s, 'transport_lorry_receipts')} lr
  LEFT JOIN ${tbl(s, 'invoices')} i ON i.id = lr."invoiceId"
  WHERE lr."branchId" = $1::uuid
    AND lr.status != 'cancelled'
    AND (lr."invoiceId" IS NULL OR i.status = 'cancelled')`

/**
 * Builds the freight bill for the given LRs. Throws httpError for any business-rule violation.
 * `useDerivedKey` is false when the caller already wraps this in a client-supplied Idempotency-Key.
 */
async function createFreightBill(
  req: FastifyRequest, body: z.infer<typeof BillBody>, cfg: Record<string, any>, useDerivedKey: boolean,
): Promise<{ invoice: any; advanceReceived: number; lrCount: number; tdsAmount: number; netReceivable: number }> {
  const lrs = await q<any>(req,
    `SELECT lr.*, i.status AS "invoiceStatus"
     FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} lr
     LEFT JOIN ${tbl(req.schemaName, 'invoices')} i ON i.id = lr."invoiceId"
     WHERE lr."branchId" = $1::uuid AND lr.id = ANY($2::uuid[])`, req.branchId, body.lrIds)

  const found = new Set(lrs.map((l: any) => l.id))
  const missing = body.lrIds.filter((id) => !found.has(id))
  if (missing.length) throw httpError(404, `Lorry receipt not found: ${missing.join(', ')}`)

  const cancelled = lrs.filter((l: any) => l.status === 'cancelled')
  if (cancelled.length) throw httpError(422, `Cancelled LRs cannot be billed: ${cancelled.map((l: any) => l.lrNo).join(', ')}`)
  const alreadyBilled = lrs.filter((l: any) => l.invoiceId && l.invoiceStatus !== 'cancelled')
  if (alreadyBilled.length) throw httpError(409, `Already on a freight bill: ${alreadyBilled.map((l: any) => l.lrNo).join(', ')}`)
  if (cfg['pod_required_before_billing']) {
    const noPod = lrs.filter((l: any) => l.status !== 'pod_received')
    if (noPod.length) throw httpError(422, `POD not received yet for: ${noPod.map((l: any) => l.lrNo).join(', ')}`)
  }

  const party = await q1<any>(req,
    `SELECT id, name FROM ${tbl(req.schemaName, 'parties')} WHERE id = $1::uuid`, body.partyId)
  if (!party) throw httpError(404, 'Billing party not found')

  const gstMode = (body.gstMode ?? cfg['default_gst_mode'] ?? 'rcm') as GstMode
  const gstRate = gstRateForMode(gstMode)
  const sac     = String(cfg['default_sac_code'] ?? '996791')

  const sorted = [...lrs].sort((a: any, b: any) => ymd(a.lrDate).localeCompare(ymd(b.lrDate)) || a.lrNo.localeCompare(b.lrNo, undefined, { numeric: true }))
  const items = sorted.map((l: any) => {
    const wt = Number(l.chargedWeightKg || l.actualWeightKg)
    const bits = [
      `LR ${l.lrNo} dt ${ymd(l.lrDate)}`,
      `${l.fromCity} → ${l.toCity}`,
      l.goodsDescription,
      wt > 0 ? `${wt.toLocaleString('en-IN')} kg` : null,
      l.vehicleNo ? `Veh ${l.vehicleNo}` : null,
    ].filter(Boolean)
    return {
      description: bits.join(' | ').slice(0, 500),
      qty: 1, unit: 'trip', rate: Number(l.totalAmount),
      discountPct: 0, gstRate, gstExempt: gstMode === 'exempt', hsnSacCode: sac,
      itemMeta: {
        lr_id: l.id, lr_no: l.lrNo, lr_date: ymd(l.lrDate), trip_id: l.tripId ?? undefined,
        gate_pass_no: l.gatePassNo ?? undefined, shipment_no: l.shipmentNo ?? undefined,
        load_kg: Number(l.actualWeightKg) || undefined, unload_kg: l.unloadWeightKg != null ? Number(l.unloadWeightKg) : undefined,
        charged_kg: Number(l.chargedWeightKg) || undefined, rate: Number(l.rate) || undefined, rate_basis: l.rateBasis,
        from_city: l.fromCity, to_city: l.toCity, vehicle_no: l.vehicleNo ?? undefined,
        weight_kg: wt || undefined, packages: l.packages || undefined, eway_bill_no: l.ewayBillNo ?? undefined,
      },
    }
  })

  const advanceReceived = r2(sorted.reduce((s: number, l: any) => s + Number(l.advancePaid), 0))
  const taxable   = r2(sorted.reduce((s: number, l: any) => s + Number(l.totalAmount), 0))
  const tdsAmount = body.tdsApplicable ? Math.round(taxable * body.tdsRatePct / 100) : 0
  const date    = body.date ?? todayStr()
  const dueDate = addDays(date, body.creditDays)
  const vehicleNos = [...new Set(sorted.map((l: any) => l.vehicleNo).filter(Boolean))] as string[]
  const notes = [
    gstMode === 'rcm' ? RCM_NOTE : null,
    advanceReceived > 0 ? `Advance received against these LRs: ₹${advanceReceived.toLocaleString('en-IN')}` : null,
    body.notes ?? null,
  ].filter(Boolean).join('\n') || undefined

  // Without a client Idempotency-Key, a click-happy double submit must still not raise two
  // bills: key on the LR set plus each LR's last-modified time, so a re-bill after a
  // cancellation (which touches the LRs) gets a fresh key.
  const derivedKey = 'tbill:' + createHash('sha1').update(
    [...body.lrIds].sort().join(',') + '|' + sorted.map((l: any) => `${l.id}:${new Date(l.updatedAt).getTime()}`).sort().join(',')
  ).digest('hex')

  // Claim the LRs atomically so two different clients billing the same LR at the same instant
  // cannot both pass the "already billed?" read above. A claim older than 2 minutes is treated
  // as abandoned (crashed request) and can be taken over.
  const claimed = await q<{ id: string }>(req,
    `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
     SET "billLockedAt" = NOW()
     WHERE "branchId" = $1::uuid AND id = ANY($2::uuid[]) AND status != 'cancelled' AND "invoiceId" IS NULL
       AND ("billLockedAt" IS NULL OR "billLockedAt" < NOW() - INTERVAL '2 minutes')
     RETURNING id`, req.branchId, body.lrIds)
  const unlock = (ids: string[]) => run(req,
    `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')} SET "billLockedAt" = NULL
     WHERE "branchId" = $1::uuid AND id = ANY($2::uuid[]) AND "invoiceId" IS NULL`, req.branchId, ids)
  if (claimed.length !== body.lrIds.length) {
    if (claimed.length) await unlock(claimed.map((c) => c.id))
    throw httpError(409, 'These LRs are being billed by someone else right now — refresh and try again')
  }

  const make = () => createInvoice({
    txnType: 'sale_invoice',
    partyId: body.partyId,
    date, dueDate, notes,
    domainData: {
      bill_kind:   sorted.length > 1 ? 'monthly_consolidated' : 'lr_bill',
      lr_ids:      sorted.map((l: any) => l.id),
      lr_nos:      sorted.map((l: any) => l.lrNo),
      period_from: ymd(sorted[0].lrDate),
      period_to:   ymd(sorted[sorted.length - 1].lrDate),
      vehicle_nos: vehicleNos,
      gst_mode:    gstMode,
      tds_applicable: body.tdsApplicable,
      tds_rate_pct:   body.tdsRatePct,
      tds_amount:     tdsAmount,
      payment_terms:  paymentTerms(body.creditDays),
      credit_days:    body.creditDays,
    },
    aiMeta: {},
    items,
  } as Parameters<typeof createInvoice>[0], {
    db: req.db, branchId: req.branchId, schemaName: req.schemaName,
    userId: req.userId, role: req.role, branchDomainType: 'transport',
  })

  let invoice: any
  try {
    invoice = useDerivedKey
      ? (await withIdempotency({ branchId: req.branchId, endpoint: 'POST /transport/bills', key: derivedKey }, make)).result
      : await make()
  } catch (err) {
    await unlock(body.lrIds)          // never leave LRs locked after a failure
    throw err
  }

  // Link the LRs to the bill. If this ever fails after the invoice exists, a retry replays the
  // same invoice (same key) and completes the link — the LRs are never double-billed.
  await run(req,
    `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
     SET "invoiceId" = $2::uuid, status = 'billed', "billLockedAt" = NULL, "updatedAt" = NOW()
     WHERE "branchId" = $1::uuid AND id = ANY($3::uuid[]) AND status != 'cancelled'`,
    req.branchId, invoice.id, body.lrIds)

  const netReceivable = r2(Number(invoice.grandTotal) - tdsAmount)
  return { invoice, advanceReceived, lrCount: sorted.length, tdsAmount, netReceivable }
}

/** TDS position of a freight bill: how much the customer said they deducted vs how much is recorded. */
async function tdsPosition(req: FastifyRequest, invoiceId: string) {
  const inv = await q1<any>(req,
    `SELECT id, status, "grandTotal"::float AS "grandTotal", "paidAmt"::float AS "paidAmt", "domainData"
     FROM ${tbl(req.schemaName, 'invoices')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, invoiceId, req.branchId)
  if (!inv) throw httpError(404, 'Invoice not found')
  const tdsAmount = Number(inv.domainData?.tds_amount ?? 0)
  const rec = await q1<{ recorded: number }>(req,
    `SELECT COALESCE(SUM(pa.amount), 0) AS recorded
     FROM ${tbl(req.schemaName, 'payment_allocations')} pa
     JOIN ${tbl(req.schemaName, 'payments')} p ON p.id = pa."paymentId"
     WHERE pa."invoiceId" = $1::uuid AND p.method = 'tds' AND p.status = 'active'`, invoiceId)
  const recorded = r2(rec?.recorded ?? 0)
  return {
    invoiceId, tdsAmount, recorded, remaining: r2(Math.max(0, tdsAmount - recorded)),
    outstanding: r2(inv.grandTotal - inv.paidAmt), cancelled: inv.status === 'cancelled',
  }
}

export const transportBillingRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/transport/bills/:id/tds — what the customer deducted vs what has been recorded
  app.get('/bills/:id/tds', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return tdsPosition(req, id)
  })

  // POST /api/transport/bills/:id/tds — record the TDS the customer deducted when paying the net amount.
  // Booked as a payment of method "tds" against the bill, so outstanding, status, party balance and
  // aging all move through the normal payment path. Void that payment to undo it.
  app.post('/bills/:id/tds', async (req, reply) => {
    requireWrite(req)
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      amount:      z.number().positive().max(1e9).optional(),       // defaults to the whole remaining TDS
      certificateNo: z.string().max(60).optional(),                 // Form 16A / challan reference
      paymentDate: dateStr.optional(),
    }).parse(req.body ?? {})

    const pos = await tdsPosition(req, id)
    if (pos.cancelled) throw httpError(422, 'This bill is cancelled')
    if (pos.tdsAmount <= 0) throw httpError(422, 'No TDS was marked on this bill')
    if (pos.remaining <= 0) throw httpError(422, 'The TDS on this bill has already been recorded')
    const amount = body.amount ?? pos.remaining
    if (amount > pos.remaining + 0.005) throw httpError(422, `Only ₹${pos.remaining} of TDS is left to record on this bill`)

    const paid = await recordPayment({
      invoiceId: id, amount, method: 'tds',
      refNo: body.certificateNo || 'TDS', paymentDate: body.paymentDate,
      notes: 'TDS deducted by customer (Sec 194C)',
    }, { db: req.db, branchId: req.branchId, schemaName: req.schemaName, userId: req.userId, role: req.role } as Parameters<typeof recordPayment>[1])

    return reply.status(201).send({ payment: paid.payment, invoiceStatus: paid.invoiceStatus, ...(await tdsPosition(req, id)) })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // FREIGHT BILLING
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/bills/candidates?partyId=&freightType=tbb&as=any
  app.get('/bills/candidates', async (req) => {
    const qy = z.object({
      partyId:     z.string().uuid().optional(),
      freightType: z.enum(FREIGHT_TYPES).optional(),
      as:          z.enum(['consignor', 'consignee', 'any']).default('any'),
      upTo:        dateStr.optional(),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = BILLABLE(req.schemaName)
    if (qy.partyId) {
      params.push(qy.partyId)
      const n = params.length
      where += qy.as === 'consignor' ? ` AND lr."consignorId" = $${n}::uuid`
             : qy.as === 'consignee' ? ` AND lr."consigneeId" = $${n}::uuid`
             : ` AND (lr."consignorId" = $${n}::uuid OR lr."consigneeId" = $${n}::uuid)`
    }
    if (qy.freightType) { params.push(qy.freightType); where += ` AND lr."freightType" = $${params.length}` }
    if (qy.upTo)        { params.push(qy.upTo);        where += ` AND lr."lrDate" <= $${params.length}::date` }

    const rows = await q(req,
      `SELECT lr.id, lr."lrNo", lr."lrDate", lr."consignorId", lr."consignorName", lr."consigneeId", lr."consigneeName",
              lr."fromCity", lr."toCity", lr."goodsDescription", lr."actualWeightKg", lr."chargedWeightKg", lr.packages,
              lr."vehicleNo", lr."freightType", lr.status, lr."totalAmount", lr."advancePaid", lr."toPayCollected",
              lr."unloadWeightKg", lr."gatePassNo", lr."shipmentNo", lr."rate", lr."rateBasis", lr."weightBasis"
       ${where} ORDER BY lr."lrDate", lr."lrNo"`, ...params)
    return {
      data: rows,
      totals: {
        count:  rows.length,
        amount: r2(rows.reduce((s: number, r: any) => s + r.totalAmount, 0)),
        advance: r2(rows.reduce((s: number, r: any) => s + r.advancePaid, 0)),
      },
    }
  })

  // POST /api/transport/bills — raise a GST freight bill for one or more LRs
  app.post('/bills', async (req, reply) => {
    requireWrite(req)
    const body = BillBody.parse(req.body)
    const cfg  = await branchConfig(req)
    const headerKey = req.headers['idempotency-key'] as string | undefined

    try {
      if (headerKey) {
        // Whole operation under the client's key: a retry after a timeout returns the original bill.
        const { result, replayed } = await withIdempotency(
          { branchId: req.branchId, endpoint: 'POST /transport/bills', key: headerKey },
          () => createFreightBill(req, body, cfg, false),
        )
        if (!replayed) safely('bill_created', notifyBill(req, result.invoice.id))
        return reply.status(replayed ? 200 : 201).send(result)
      }
      const created = await createFreightBill(req, body, cfg, true)
      safely('bill_created', notifyBill(req, created.invoice.id))   // opt-in; deduped per bill
      return reply.status(201).send(created)
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw httpError(409, 'This bill is already being created — wait a moment')
      throw err
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/dashboard
  app.get('/dashboard', async (req) => {
    const s = req.schemaName
    const b = req.branchId
    const today = todayStr()
    const monthStart = `${today.slice(0, 7)}-01`
    const cfg = await branchConfig(req)
    const alertDays = Number(cfg['compliance_alert_days'] ?? 30)
    const horizon = addDays(today, alertDays)

    const [fleet, drivers, running, todayLr, pendingPod, unbilled, toPay, unassigned, month, monthExp, compliance, eway, recent] =
      await Promise.all([
        q<{ status: string; count: number }>(req,
          `SELECT status, COUNT(*) AS count FROM ${tbl(s, 'transport_vehicles')}
           WHERE "branchId" = $1::uuid AND "isActive" = true GROUP BY status`, b),
        q<{ status: string; count: number }>(req,
          `SELECT status, COUNT(*) AS count FROM ${tbl(s, 'transport_drivers')}
           WHERE "branchId" = $1::uuid AND "isActive" = true GROUP BY status`, b),
        q(req,
          `SELECT t.id, t."tripNo", t."fromCity", t."toCity", t."startDate", v."regNo" AS "vehicleNo", d.name AS "driverName",
                  (SELECT COUNT(*) FROM ${tbl(s, 'transport_lorry_receipts')} l WHERE l."tripId" = t.id AND l.status != 'cancelled')::int AS "lrCount"
           FROM ${tbl(s, 'transport_trips')} t
           JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = t."vehicleId"
           LEFT JOIN ${tbl(s, 'transport_drivers')} d ON d.id = t."driverId"
           WHERE t."branchId" = $1::uuid AND t.status = 'running'
           ORDER BY t."startDate" ASC LIMIT 10`, b),
        q<{ count: number; amount: number }>(req,
          `SELECT COUNT(*) AS count, COALESCE(SUM("totalAmount"),0) AS amount FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND "lrDate" = $2::date AND status != 'cancelled'`, b, today),
        q<{ count: number }>(req,
          `SELECT COUNT(*) AS count FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND status = 'delivered'`, b),
        q<{ count: number; amount: number }>(req,
          `SELECT COUNT(*) AS count, COALESCE(SUM(lr."totalAmount" - lr."advancePaid"),0) AS amount ${BILLABLE(s)}
             AND lr."freightType" = 'tbb' AND lr.status IN ('delivered','pod_received')`, b),
        q<{ count: number; amount: number }>(req,
          `SELECT COUNT(*) AS count, COALESCE(SUM("totalAmount" - "advancePaid" - "toPayCollected"),0) AS amount
           FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND "freightType" = 'to_pay' AND status IN ('delivered','pod_received','billed')
             AND "totalAmount" - "advancePaid" - "toPayCollected" > 0`, b),
        q<{ count: number }>(req,
          `SELECT COUNT(*) AS count FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND status = 'booked' AND "tripId" IS NULL`, b),
        q<{ count: number; freight: number }>(req,
          `SELECT COUNT(*) AS count, COALESCE(SUM("totalAmount"),0) AS freight FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND "lrDate" >= $2::date AND status != 'cancelled'`, b, monthStart),
        q<{ expenses: number }>(req,
          `SELECT (SELECT COALESCE(SUM(amount),0) FROM ${tbl(s, 'transport_expenses')}
                    WHERE "branchId" = $1::uuid AND "expenseDate" >= $2::date)
                + (SELECT COALESCE(SUM("hireCharges"),0) FROM ${tbl(s, 'transport_trips')}
                    WHERE "branchId" = $1::uuid AND "startDate" >= $2::date AND status != 'cancelled') AS expenses`, b, monthStart),
        q<{ count: number; expired: number }>(req,
          `SELECT COUNT(*) AS count, COUNT(*) FILTER (WHERE d.expiry < $3::date) AS expired
           FROM ${tbl(s, 'transport_vehicles')} v
           CROSS JOIN LATERAL (VALUES (v."fitnessExpiry"), (v."permitExpiry"), (v."nationalPermitExpiry"),
                                      (v."insuranceExpiry"), (v."pucExpiry"), (v."roadTaxExpiry")) AS d(expiry)
           WHERE v."branchId" = $1::uuid AND v."isActive" = true AND d.expiry IS NOT NULL AND d.expiry <= $2::date`,
          b, horizon, today),
        q<{ count: number }>(req,
          `SELECT COUNT(*) AS count FROM ${tbl(s, 'transport_lorry_receipts')}
           WHERE "branchId" = $1::uuid AND status IN ('booked','in_transit') AND "ewayValidUpto" IS NOT NULL
             AND "ewayValidUpto" <= NOW() + INTERVAL '24 hours'`, b),
        q(req,
          `SELECT id, "lrNo", "lrDate", "consignorName", "consigneeName", "fromCity", "toCity", "totalAmount", status, "freightType"
           FROM ${tbl(s, 'transport_lorry_receipts')} WHERE "branchId" = $1::uuid
           ORDER BY "createdAt" DESC LIMIT 8`, b),
      ])

    const by = (rows: { status: string; count: number }[], k: string) => rows.find((r) => r.status === k)?.count ?? 0
    const fleetTotal = fleet.reduce((a, r) => a + r.count, 0)
    const freight = r2(month[0]?.freight ?? 0)
    const expenses = r2(monthExp[0]?.expenses ?? 0)

    return {
      asOf: today,
      fleet: {
        total: fleetTotal, available: by(fleet, 'available'), onTrip: by(fleet, 'on_trip'),
        maintenance: by(fleet, 'maintenance'),
        utilisationPct: fleetTotal ? Math.round((by(fleet, 'on_trip') / fleetTotal) * 100) : 0,
      },
      drivers: { total: drivers.reduce((a, r) => a + r.count, 0), available: by(drivers, 'available'), onTrip: by(drivers, 'on_trip') },
      runningTrips: running,
      today: { lrCount: todayLr[0]?.count ?? 0, freight: r2(todayLr[0]?.amount ?? 0) },
      attention: {
        pendingPod:      pendingPod[0]?.count ?? 0,
        unassignedLrs:   unassigned[0]?.count ?? 0,
        unbilledCount:   unbilled[0]?.count ?? 0,
        unbilledAmount:  r2(unbilled[0]?.amount ?? 0),
        toPayCount:      toPay[0]?.count ?? 0,
        toPayAmount:     r2(toPay[0]?.amount ?? 0),
        complianceDue:   compliance[0]?.count ?? 0,
        complianceExpired: compliance[0]?.expired ?? 0,
        ewayExpiring:    eway[0]?.count ?? 0,
      },
      month: {
        lrCount: month[0]?.count ?? 0, freight, expenses,
        net: r2(freight - expenses), marginPct: freight > 0 ? r2(((freight - expenses) / freight) * 100) : 0,
      },
      recentLrs: recent,
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // REPORTS
  // ══════════════════════════════════════════════════════════════════════════

  const RangeQ = z.object({ from: dateStr.optional(), to: dateStr.optional() })
  const range = (qy: z.infer<typeof RangeQ>) => {
    const to = qy.to ?? todayStr()
    return { from: qy.from ?? `${to.slice(0, 7)}-01`, to }
  }

  // GET /api/transport/reports/trip-pnl?from=&to=
  app.get('/reports/trip-pnl', async (req) => {
    const { from, to } = range(RangeQ.parse(req.query))
    const s = req.schemaName
    const rows = await q<any>(req,
      `SELECT t.id, t."tripNo", t."startDate", t."endDate", t.status, t."fromCity", t."toCity",
              v."regNo" AS "vehicleNo", d.name AS "driverName",
              (t."endOdometer" - t."startOdometer") AS km,
              COALESCE(lr.freight,0) AS freight, COALESCE(ex.total,0) AS expenses, t."hireCharges" AS hire
       FROM ${tbl(s, 'transport_trips')} t
       JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = t."vehicleId"
       LEFT JOIN ${tbl(s, 'transport_drivers')} d ON d.id = t."driverId"
       LEFT JOIN LATERAL (SELECT SUM("totalAmount") AS freight FROM ${tbl(s, 'transport_lorry_receipts')}
                          WHERE "tripId" = t.id AND status != 'cancelled') lr ON true
       LEFT JOIN LATERAL (SELECT SUM(amount) AS total FROM ${tbl(s, 'transport_expenses')} WHERE "tripId" = t.id) ex ON true
       WHERE t."branchId" = $1::uuid AND t.status != 'cancelled'
         AND t."startDate" BETWEEN $2::date AND $3::date
       ORDER BY t."startDate" DESC, t."tripNo" DESC`, req.branchId, from, to)
    const data = rows.map((r: any) => {
      const cost = r2(r.expenses + r.hire)
      const net = r2(r.freight - cost)
      return { ...r, totalCost: cost, net, marginPct: r.freight > 0 ? r2((net / r.freight) * 100) : 0,
               perKm: r.km > 0 ? r2(net / r.km) : null }
    })
    const sum = (k: string) => r2(data.reduce((a: number, r: any) => a + (r[k] ?? 0), 0))
    return { from, to, data, totals: { freight: sum('freight'), totalCost: sum('totalCost'), net: sum('net'), trips: data.length } }
  })

  // GET /api/transport/reports/vehicle-pnl?from=&to=
  app.get('/reports/vehicle-pnl', async (req) => {
    const { from, to } = range(RangeQ.parse(req.query))
    const s = req.schemaName
    const rows = await q<any>(req,
      `SELECT v.id, v."regNo", v."vehicleType", v.ownership,
              (SELECT COUNT(*) FROM ${tbl(s, 'transport_trips')} t
                WHERE t."vehicleId" = v.id AND t.status != 'cancelled' AND t."startDate" BETWEEN $2::date AND $3::date)::int AS trips,
              (SELECT COALESCE(SUM(t."endOdometer" - t."startOdometer"),0) FROM ${tbl(s, 'transport_trips')} t
                WHERE t."vehicleId" = v.id AND t.status = 'completed' AND t."startDate" BETWEEN $2::date AND $3::date) AS km,
              (SELECT COALESCE(SUM(l."totalAmount"),0) FROM ${tbl(s, 'transport_lorry_receipts')} l
                WHERE l."vehicleId" = v.id AND l.status != 'cancelled' AND l."lrDate" BETWEEN $2::date AND $3::date) AS freight,
              (SELECT COALESCE(SUM(e.amount),0) FROM ${tbl(s, 'transport_expenses')} e
                WHERE e."vehicleId" = v.id AND e."expenseDate" BETWEEN $2::date AND $3::date) AS expenses,
              (SELECT COALESCE(SUM(t."hireCharges"),0) FROM ${tbl(s, 'transport_trips')} t
                WHERE t."vehicleId" = v.id AND t.status != 'cancelled' AND t."startDate" BETWEEN $2::date AND $3::date) AS hire
       FROM ${tbl(s, 'transport_vehicles')} v
       WHERE v."branchId" = $1::uuid AND v."isActive" = true
       ORDER BY v."regNo"`, req.branchId, from, to)
    const data = rows.map((r: any) => {
      const cost = r2(r.expenses + r.hire)
      const net = r2(r.freight - cost)
      return { ...r, totalCost: cost, net, perKm: r.km > 0 ? r2(net / r.km) : null,
               marginPct: r.freight > 0 ? r2((net / r.freight) * 100) : 0 }
    })
    const sum = (k: string) => r2(data.reduce((a: number, r: any) => a + (r[k] ?? 0), 0))
    return { from, to, data, totals: { freight: sum('freight'), totalCost: sum('totalCost'), net: sum('net') } }
  })

  // GET /api/transport/reports/party-business?from=&to= — freight by consignor
  app.get('/reports/party-business', async (req) => {
    const { from, to } = range(RangeQ.parse(req.query))
    const s = req.schemaName
    const rows = await q<any>(req,
      `SELECT COALESCE(lr."consignorId"::text, lr."consignorName") AS key, lr."consignorName" AS name,
              COUNT(*)::int AS "lrCount", COALESCE(SUM(lr."totalAmount"),0) AS freight,
              COALESCE(SUM(lr."chargedWeightKg"),0) AS "weightKg",
              COALESCE(SUM(lr."totalAmount") FILTER (WHERE lr.status = 'billed'),0) AS billed
       FROM ${tbl(s, 'transport_lorry_receipts')} lr
       WHERE lr."branchId" = $1::uuid AND lr.status != 'cancelled' AND lr."lrDate" BETWEEN $2::date AND $3::date
       GROUP BY 1, 2 ORDER BY freight DESC`, req.branchId, from, to)
    return { from, to, data: rows.map((r: any) => ({ ...r, unbilled: r2(r.freight - r.billed) })) }
  })
}
