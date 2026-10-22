// apps/api/src/routes/transport-trips.ts
// Trips (one vehicle run carrying one or more LRs) and trip/vehicle expenses.
// Registered under /api/transport.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { EXPENSE_CATEGORY_CODES } from './transport-shared.js'
import {
  tbl, q, q1, run, insertRow, updateRow, httpError, requireWrite, requireManager,
  nextSeq, fyLabel, todayStr, r2, branchConfig, daysBetween, ymd, paidByExpr,
} from '../lib/transport-helpers.js'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const idParam = z.object({ id: z.string().uuid() })
const money   = z.number().min(0).max(1e9)

const TripBody = z.object({
  vehicleId:       z.string().uuid(),
  driverId:        z.string().uuid().nullable().optional(),
  helperName:      z.string().max(100).nullable().optional(),
  fromCity:        z.string().min(1).max(100),
  toCity:          z.string().min(1).max(100),
  startDate:       dateStr.optional(),
  startOdometer:   z.number().int().min(0).nullable().optional(),
  driverAdvance:   money.default(0),
  hireCharges:     money.default(0),
  hireAdvancePaid: money.default(0),
  notes:           z.string().max(1000).nullable().optional(),
  lrIds:           z.array(z.string().uuid()).max(100).default([]),
})

const ExpenseBody = z.object({
  tripId:       z.string().uuid().nullable().optional(),
  vehicleId:    z.string().uuid().nullable().optional(),
  driverId:     z.string().uuid().nullable().optional(),
  category:     z.enum(EXPENSE_CATEGORY_CODES),
  amount:       z.number().positive().max(1e9).optional(),
  expenseDate:  dateStr.optional(),
  litres:       z.number().positive().max(5000).nullable().optional(),
  ratePerLitre: z.number().positive().max(500).nullable().optional(),
  odometer:     z.number().int().min(0).nullable().optional(),
  location:     z.string().max(150).nullable().optional(),
  paymentMode:  z.enum(['cash', 'upi', 'card', 'fastag', 'credit', 'bank_transfer']).default('cash'),
  billNo:       z.string().max(50).nullable().optional(),
  notes:        z.string().max(500).nullable().optional(),
  // driver = paid from driver's pocket/advance, company = owner paid directly, vendor_credit = on account at pump/shop
  paidBy:       z.enum(['driver', 'company', 'vendor_credit']).optional(),
  vendorName:   z.string().trim().max(100).nullable().optional(),
})

const SettleBody = z.object({
  ids:       z.array(z.string().uuid()).min(1).max(200),
  settledOn: dateStr.optional(),
  mode:      z.enum(['cash', 'upi', 'bank_transfer', 'cheque']).default('bank_transfer'),
})

const TRIP_LIST_SELECT = (s: string) => `
  SELECT t.*, v."regNo" AS "vehicleNo", v."vehicleType", v.ownership, d.name AS "driverName",
         COALESCE(lr.cnt, 0)::int      AS "lrCount",
         COALESCE(lr.freight, 0)       AS freight,
         COALESCE(ex.total, 0)         AS expenses
  FROM ${tbl(s, 'transport_trips')} t
  JOIN ${tbl(s, 'transport_vehicles')} v ON v.id = t."vehicleId"
  LEFT JOIN ${tbl(s, 'transport_drivers')} d ON d.id = t."driverId"
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt, SUM("totalAmount") AS freight
    FROM ${tbl(s, 'transport_lorry_receipts')} WHERE "tripId" = t.id AND status != 'cancelled'
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT SUM(amount) AS total FROM ${tbl(s, 'transport_expenses')} WHERE "tripId" = t.id
  ) ex ON true`

/** Revenue, cost and net for one trip (GST excluded — freight is the transporter's income). */
async function tripPnl(req: any, tripId: string) {
  const row = await q1<{ freight: number; expenses: number; hire: number; cashSpent: number; unpaid: number; advance: number }>(req,
    `SELECT
       (SELECT COALESCE(SUM("totalAmount"),0) FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
         WHERE "tripId" = $1::uuid AND status != 'cancelled')                              AS freight,
       (SELECT COALESCE(SUM(amount),0) FROM ${tbl(req.schemaName, 'transport_expenses')}
         WHERE "tripId" = $1::uuid)                                                        AS expenses,
       (SELECT COALESCE(SUM(e.amount),0) FROM ${tbl(req.schemaName, 'transport_expenses')} e
         WHERE e."tripId" = $1::uuid AND ${paidByExpr('e')} = 'driver')                    AS "cashSpent",
       (SELECT COALESCE(SUM(e.amount),0) FROM ${tbl(req.schemaName, 'transport_expenses')} e
         WHERE e."tripId" = $1::uuid AND ${paidByExpr('e')} = 'vendor_credit'
           AND e."settledOn" IS NULL)                                                      AS unpaid,
       t."hireCharges"                                                                     AS hire,
       t."driverAdvance"                                                                   AS advance
     FROM ${tbl(req.schemaName, 'transport_trips')} t WHERE t.id = $1::uuid`, tripId)
  const f = row ?? { freight: 0, expenses: 0, hire: 0, cashSpent: 0, unpaid: 0, advance: 0 }
  const cost = r2(f.expenses + f.hire)
  const net  = r2(f.freight - cost)
  return {
    freight: r2(f.freight), expenses: r2(f.expenses), hireCharges: r2(f.hire),
    totalCost: cost, net, marginPct: f.freight > 0 ? r2((net / f.freight) * 100) : 0,
    driverAdvance: r2(f.advance), driverCashSpent: r2(f.cashSpent),
    // on-account (pump/shop) costs still unpaid — already inside `expenses`/`net`, shown so profit isn't mistaken for cash in hand
    vendorUnpaid: r2(f.unpaid),
    // positive = driver still holds cash that must be returned; negative = company owes the driver
    driverBalance: r2(f.advance - f.cashSpent),
  }
}

async function loadTrip(req: any, id: string) {
  const trip = await q1<any>(req, `${TRIP_LIST_SELECT(req.schemaName)} WHERE t.id = $1::uuid AND t."branchId" = $2::uuid`,
    id, req.branchId)
  if (!trip) throw httpError(404, 'Trip not found')
  return trip
}

/** Attach LRs that are still unassigned+booked to a trip. */
async function attachLrs(req: any, trip: any, lrIds: string[]) {
  if (lrIds.length === 0) return
  const rows = await q<{ id: string; lrNo: string; status: string; tripId: string | null }>(req,
    `SELECT id, "lrNo", status, "tripId" FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
     WHERE "branchId" = $1::uuid AND id = ANY($2::uuid[])`, req.branchId, lrIds)
  const found = new Set(rows.map((r) => r.id))
  const missing = lrIds.filter((id) => !found.has(id))
  if (missing.length) throw httpError(404, `Lorry receipt not found: ${missing.join(', ')}`)
  const bad = rows.filter((r) => r.status !== 'booked' || r.tripId)
  if (bad.length) throw httpError(422, `Not available for a trip (already assigned or not "booked"): ${bad.map((r) => r.lrNo).join(', ')}`)
  const running = trip.status === 'running'
  await run(req,
    `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
     SET "tripId" = $2::uuid, "vehicleId" = $3::uuid, "vehicleNo" = $4, "driverName" = $5,
         status = $6, "dispatchedAt" = CASE WHEN $6 = 'in_transit' THEN NOW() ELSE "dispatchedAt" END,
         "updatedAt" = NOW()
     WHERE "branchId" = $1::uuid AND id = ANY($7::uuid[])`,
    req.branchId, trip.id, trip.vehicleId, trip.vehicleNo, trip.driverName ?? null,
    running ? 'in_transit' : 'booked', lrIds)
}

export const transportTripRoutes: FastifyPluginAsync = async (app) => {

  // ══════════════════════════════════════════════════════════════════════════
  // TRIPS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/trips
  app.get('/trips', async (req) => {
    const qy = z.object({
      status:    z.string().optional(),
      vehicleId: z.string().uuid().optional(),
      driverId:  z.string().uuid().optional(),
      from:      dateStr.optional(),
      to:        dateStr.optional(),
      search:    z.string().optional(),
      page:      z.coerce.number().int().min(1).default(1),
      limit:     z.coerce.number().int().min(1).max(200).default(20),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = `WHERE t."branchId" = $1::uuid`
    if (qy.status) { params.push(qy.status.split(',').map((s) => s.trim())); where += ` AND t.status = ANY($${params.length}::text[])` }
    if (qy.vehicleId) { params.push(qy.vehicleId); where += ` AND t."vehicleId" = $${params.length}::uuid` }
    if (qy.driverId)  { params.push(qy.driverId);  where += ` AND t."driverId" = $${params.length}::uuid` }
    if (qy.from) { params.push(qy.from); where += ` AND t."startDate" >= $${params.length}::date` }
    if (qy.to)   { params.push(qy.to);   where += ` AND t."startDate" <= $${params.length}::date` }
    if (qy.search) {
      params.push(`%${qy.search}%`)
      const n = params.length
      where += ` AND (t."tripNo" ILIKE $${n} OR v."regNo" ILIKE $${n} OR d.name ILIKE $${n}
                  OR t."fromCity" ILIKE $${n} OR t."toCity" ILIKE $${n})`
    }
    const offset = (qy.page - 1) * qy.limit
    const [rows, total] = await Promise.all([
      q(req, `${TRIP_LIST_SELECT(req.schemaName)} ${where}
              ORDER BY t."startDate" DESC, t."createdAt" DESC
              LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, qy.limit, offset),
      q<{ count: number }>(req,
        `SELECT COUNT(*) AS count FROM ${tbl(req.schemaName, 'transport_trips')} t
         JOIN ${tbl(req.schemaName, 'transport_vehicles')} v ON v.id = t."vehicleId"
         LEFT JOIN ${tbl(req.schemaName, 'transport_drivers')} d ON d.id = t."driverId" ${where}`, ...params),
    ])
    return {
      data: rows.map((t: any) => ({ ...t, net: r2(t.freight - t.expenses - t.hireCharges) })),
      total: total[0]?.count ?? 0, page: qy.page, limit: qy.limit,
    }
  })

  // POST /api/transport/trips
  app.post('/trips', async (req, reply) => {
    requireWrite(req)
    const body = TripBody.parse(req.body)

    const vehicle = await q1<any>(req,
      `SELECT id, "regNo", status, ownership, "currentOdometer" FROM ${tbl(req.schemaName, 'transport_vehicles')}
       WHERE id = $1::uuid AND "branchId" = $2::uuid AND "isActive" = true`, body.vehicleId, req.branchId)
    if (!vehicle) throw httpError(404, 'Vehicle not found')
    if (vehicle.status === 'inactive') throw httpError(422, `Vehicle ${vehicle.regNo} is inactive`)
    if (body.driverId) {
      const d = await q1(req,
        `SELECT id FROM ${tbl(req.schemaName, 'transport_drivers')} WHERE id = $1::uuid AND "branchId" = $2::uuid AND "isActive" = true`,
        body.driverId, req.branchId)
      if (!d) throw httpError(404, 'Driver not found')
    }
    if (body.hireAdvancePaid > body.hireCharges) throw httpError(422, 'Hire advance cannot exceed hire charges')

    const startDate = body.startDate ?? todayStr()
    const cfg = await branchConfig(req)
    const seq = await nextSeq(req, 'trip', fyLabel(startDate))
    const tripNo = `${cfg['trip_prefix'] ?? 'TRP'}-${fyLabel(startDate)}-${String(seq).padStart(4, '0')}`

    const { lrIds, ...fields } = body
    const trip = await insertRow(req, 'transport_trips', {
      branchId: req.branchId, tripNo, ...fields, startDate,
      startOdometer: body.startOdometer ?? vehicle.currentOdometer, createdBy: req.userId,
    })
    try {
      const full = await loadTrip(req, trip.id)
      await attachLrs(req, full, lrIds)
    } catch (err) {
      // Don't leave an empty orphan trip behind if the LR attach was rejected.
      await run(req, `DELETE FROM ${tbl(req.schemaName, 'transport_trips')} WHERE id = $1::uuid`, trip.id)
      throw err
    }
    return reply.status(201).send(await loadTrip(req, trip.id))
  })

  // GET /api/transport/trips/:id — full trip sheet
  app.get('/trips/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const trip = await loadTrip(req, id)
    const [lrs, expenses, pnl] = await Promise.all([
      q(req, `SELECT * FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
              WHERE "tripId" = $1::uuid ORDER BY "lrDate", "lrNo"`, id),
      q(req, `SELECT e.*, ${paidByExpr('e')} AS "paidByEff" FROM ${tbl(req.schemaName, 'transport_expenses')} e
              WHERE e."tripId" = $1::uuid ORDER BY e."expenseDate", e."createdAt"`, id),
      tripPnl(req, id),
    ])
    return { ...trip, lrs, expenses, pnl }
  })

  // PATCH /api/transport/trips/:id
  app.patch('/trips/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const trip = await loadTrip(req, id)
    if (trip.status === 'completed' || trip.status === 'cancelled') {
      throw httpError(422, `A ${trip.status} trip cannot be edited`)
    }
    const body = TripBody.omit({ lrIds: true }).partial().parse(req.body)
    if (body.vehicleId && body.vehicleId !== trip.vehicleId && trip.status === 'running') {
      throw httpError(422, 'Cannot change the vehicle of a running trip')
    }
    const hire = body.hireCharges ?? trip.hireCharges
    if ((body.hireAdvancePaid ?? trip.hireAdvancePaid) > hire) throw httpError(422, 'Hire advance cannot exceed hire charges')
    const row = await updateRow(req, 'transport_trips', id, body)
    // Keep the denormalised vehicle/driver snapshot on this trip's LRs in sync.
    if (body.vehicleId || body.driverId !== undefined) {
      const t = await loadTrip(req, id)
      await run(req,
        `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
         SET "vehicleId" = $2::uuid, "vehicleNo" = $3, "driverName" = $4, "updatedAt" = NOW()
         WHERE "tripId" = $1::uuid`, id, t.vehicleId, t.vehicleNo, t.driverName ?? null)
    }
    return row
  })

  // POST /api/transport/trips/:id/start
  app.post('/trips/:id/start', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({ startOdometer: z.number().int().min(0).optional() }).parse(req.body ?? {})
    const trip = await loadTrip(req, id)
    if (trip.status !== 'planned') throw httpError(422, `Only a planned trip can be started (this one is ${trip.status})`)

    // Atomically claim the vehicle so two dispatchers can't start trips on the same truck.
    const claimed = await q(req,
      `UPDATE ${tbl(req.schemaName, 'transport_vehicles')} SET status = 'on_trip', "updatedAt" = NOW()
       WHERE id = $1::uuid AND "branchId" = $2::uuid AND status = 'available' RETURNING "regNo", "currentOdometer",
             "fitnessExpiry", "permitExpiry", "insuranceExpiry"`, trip.vehicleId, req.branchId)
    if (claimed.length === 0) {
      const v = await q1<any>(req, `SELECT "regNo", status FROM ${tbl(req.schemaName, 'transport_vehicles')} WHERE id = $1::uuid`, trip.vehicleId)
      throw httpError(422, `Vehicle ${v?.regNo ?? ''} is not available (status: ${v?.status ?? 'unknown'})`)
    }
    if (trip.driverId) {
      const drv = await q(req,
        `UPDATE ${tbl(req.schemaName, 'transport_drivers')} SET status = 'on_trip', "updatedAt" = NOW()
         WHERE id = $1::uuid AND status IN ('available','off_duty') RETURNING id`, trip.driverId)
      if (drv.length === 0) {
        await run(req, `UPDATE ${tbl(req.schemaName, 'transport_vehicles')} SET status = 'available' WHERE id = $1::uuid`, trip.vehicleId)
        throw httpError(422, 'Driver is not available (already on another trip or inactive)')
      }
    }

    try {
      await updateRow(req, 'transport_trips', id, {
        status: 'running',
        startOdometer: body.startOdometer ?? trip.startOdometer ?? claimed[0].currentOdometer,
      })
      await run(req,
        `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
         SET status = 'in_transit', "dispatchedAt" = NOW(), "updatedAt" = NOW()
         WHERE "tripId" = $1::uuid AND status = 'booked'`, id)
    } catch (err) {
      await run(req, `UPDATE ${tbl(req.schemaName, 'transport_vehicles')} SET status = 'available' WHERE id = $1::uuid`, trip.vehicleId)
      if (trip.driverId) await run(req, `UPDATE ${tbl(req.schemaName, 'transport_drivers')} SET status = 'available' WHERE id = $1::uuid`, trip.driverId)
      throw err
    }

    // Soft warnings — dispatching is the operator's call, but surface the risk.
    const today = todayStr()
    const warnings: string[] = []
    const v = claimed[0]
    for (const [label, d] of [['Fitness', v.fitnessExpiry], ['Permit', v.permitExpiry], ['Insurance', v.insuranceExpiry]] as const) {
      if (d && daysBetween(today, ymd(d)) < 0) warnings.push(`${label} of ${v.regNo} expired on ${ymd(d)}`)
    }
    const cfg = await branchConfig(req)
    const threshold = Number(cfg['eway_threshold'] ?? 50000)
    const noEway = await q<{ lrNo: string }>(req,
      `SELECT "lrNo" FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE "tripId" = $1::uuid AND status = 'in_transit' AND "declaredValue" > $2 AND ("ewayBillNo" IS NULL OR "ewayBillNo" = '')`,
      id, threshold)
    if (noEway.length) warnings.push(`E-way bill missing for ${noEway.map((r) => r.lrNo).join(', ')} (value above ₹${threshold.toLocaleString('en-IN')})`)

    return { ...(await loadTrip(req, id)), warnings }
  })

  // POST /api/transport/trips/:id/complete
  app.post('/trips/:id/complete', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      endDate:          dateStr.optional(),
      endOdometer:      z.number().int().min(0).optional(),
      markLrsDelivered: z.boolean().default(false),
    }).parse(req.body ?? {})
    const trip = await loadTrip(req, id)
    if (trip.status !== 'running') throw httpError(422, `Only a running trip can be completed (this one is ${trip.status})`)
    if (body.endOdometer != null && trip.startOdometer != null && body.endOdometer < trip.startOdometer) {
      throw httpError(422, 'End odometer cannot be lower than the start odometer')
    }

    const pending = await q<{ id: string; lrNo: string }>(req,
      `SELECT id, "lrNo" FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE "tripId" = $1::uuid AND status IN ('booked','in_transit')`, id)
    if (pending.length && !body.markLrsDelivered) {
      throw httpError(422, `These LRs are not delivered yet: ${pending.map((p) => p.lrNo).join(', ')}. Mark them delivered first (or tick "mark all delivered").`)
    }
    if (pending.length) {
      await run(req,
        `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
         SET status = 'delivered', "deliveredAt" = NOW(), "updatedAt" = NOW()
         WHERE "tripId" = $1::uuid AND status IN ('booked','in_transit')`, id)
    }

    await updateRow(req, 'transport_trips', id, {
      status: 'completed', endDate: body.endDate ?? todayStr(), endOdometer: body.endOdometer,
    })
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_vehicles')}
       SET status = 'available', "currentOdometer" = GREATEST("currentOdometer", COALESCE($2::int, 0)), "updatedAt" = NOW()
       WHERE id = $1::uuid`, trip.vehicleId, body.endOdometer ?? null)
    if (trip.driverId) {
      await run(req, `UPDATE ${tbl(req.schemaName, 'transport_drivers')} SET status = 'available', "updatedAt" = NOW() WHERE id = $1::uuid`, trip.driverId)
    }
    const pnl = await tripPnl(req, id)
    return { ...(await loadTrip(req, id)), pnl }
  })

  // POST /api/transport/trips/:id/cancel
  app.post('/trips/:id/cancel', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body ?? {})
    const trip = await loadTrip(req, id)
    if (trip.status === 'completed' || trip.status === 'cancelled') throw httpError(422, `Trip already ${trip.status}`)
    const billed = await q(req,
      `SELECT "lrNo" FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}
       WHERE "tripId" = $1::uuid AND status IN ('delivered','pod_received','billed')`, id)
    if (billed.length) throw httpError(422, 'This trip has delivered/billed LRs and cannot be cancelled')

    await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
       SET "tripId" = NULL, "vehicleId" = NULL, "vehicleNo" = NULL, "driverName" = NULL,
           status = 'booked', "dispatchedAt" = NULL, "updatedAt" = NOW()
       WHERE "tripId" = $1::uuid`, id)
    await updateRow(req, 'transport_trips', id, { status: 'cancelled', notes: `Cancelled: ${reason}` })
    if (trip.status === 'running') {
      await run(req, `UPDATE ${tbl(req.schemaName, 'transport_vehicles')} SET status = 'available', "updatedAt" = NOW() WHERE id = $1::uuid`, trip.vehicleId)
      if (trip.driverId) await run(req, `UPDATE ${tbl(req.schemaName, 'transport_drivers')} SET status = 'available', "updatedAt" = NOW() WHERE id = $1::uuid`, trip.driverId)
    }
    return loadTrip(req, id)
  })

  // POST /api/transport/trips/:id/lrs { lrIds }
  app.post('/trips/:id/lrs', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const { lrIds } = z.object({ lrIds: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body)
    const trip = await loadTrip(req, id)
    if (trip.status !== 'planned' && trip.status !== 'running') throw httpError(422, `Cannot add LRs to a ${trip.status} trip`)
    await attachLrs(req, trip, lrIds)
    return loadTrip(req, id)
  })

  // DELETE /api/transport/trips/:id/lrs/:lrId
  app.delete('/trips/:id/lrs/:lrId', async (req) => {
    requireWrite(req)
    const { id, lrId } = z.object({ id: z.string().uuid(), lrId: z.string().uuid() }).parse(req.params)
    const trip = await loadTrip(req, id)
    if (trip.status !== 'planned' && trip.status !== 'running') throw httpError(422, `Cannot change LRs on a ${trip.status} trip`)
    const n = await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
       SET "tripId" = NULL, "vehicleId" = NULL, "vehicleNo" = NULL, "driverName" = NULL,
           status = 'booked', "dispatchedAt" = NULL, "updatedAt" = NOW()
       WHERE id = $1::uuid AND "tripId" = $2::uuid AND status IN ('booked','in_transit')`, lrId, id)
    if (n === 0) throw httpError(404, 'That LR is not on this trip (or already delivered)')
    return loadTrip(req, id)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // EXPENSES (trip-level or vehicle-level)
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/expenses
  app.get('/expenses', async (req) => {
    const qy = z.object({
      tripId:    z.string().uuid().optional(),
      vehicleId: z.string().uuid().optional(),
      driverId:  z.string().uuid().optional(),
      category:  z.string().optional(),
      paidBy:    z.enum(['driver', 'company', 'vendor_credit']).optional(),
      unsettled: z.enum(['true']).optional(),
      from:      dateStr.optional(),
      to:        dateStr.optional(),
      page:      z.coerce.number().int().min(1).default(1),
      limit:     z.coerce.number().int().min(1).max(500).default(50),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = `WHERE e."branchId" = $1::uuid`
    if (qy.tripId)    { params.push(qy.tripId);    where += ` AND e."tripId" = $${params.length}::uuid` }
    if (qy.vehicleId) { params.push(qy.vehicleId); where += ` AND e."vehicleId" = $${params.length}::uuid` }
    if (qy.driverId)  { params.push(qy.driverId);  where += ` AND e."driverId" = $${params.length}::uuid` }
    if (qy.category)  { params.push(qy.category);  where += ` AND e.category = $${params.length}` }
    if (qy.paidBy)    { params.push(qy.paidBy);    where += ` AND ${paidByExpr('e')} = $${params.length}` }
    if (qy.unsettled) where += ` AND ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL`
    if (qy.from)      { params.push(qy.from);      where += ` AND e."expenseDate" >= $${params.length}::date` }
    if (qy.to)        { params.push(qy.to);        where += ` AND e."expenseDate" <= $${params.length}::date` }
    const offset = (qy.page - 1) * qy.limit
    const [rows, totals] = await Promise.all([
      q(req,
        `SELECT e.*, ${paidByExpr('e')} AS "paidByEff", v."regNo" AS "vehicleNo", t."tripNo", d.name AS "driverName"
         FROM ${tbl(req.schemaName, 'transport_expenses')} e
         LEFT JOIN ${tbl(req.schemaName, 'transport_vehicles')} v ON v.id = e."vehicleId"
         LEFT JOIN ${tbl(req.schemaName, 'transport_trips')}    t ON t.id = e."tripId"
         LEFT JOIN ${tbl(req.schemaName, 'transport_drivers')}  d ON d.id = e."driverId"
         ${where} ORDER BY e."expenseDate" DESC, e."createdAt" DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, ...params, qy.limit, offset),
      q<{ count: number; amount: number }>(req,
        `SELECT COUNT(*) AS count, COALESCE(SUM(e.amount),0) AS amount
         FROM ${tbl(req.schemaName, 'transport_expenses')} e ${where}`, ...params),
    ])
    return { data: rows, total: totals[0]?.count ?? 0, totalAmount: totals[0]?.amount ?? 0, page: qy.page, limit: qy.limit }
  })

  // POST /api/transport/expenses
  app.post('/expenses', async (req, reply) => {
    requireWrite(req)
    const body = ExpenseBody.parse(req.body)

    let { vehicleId, driverId } = body
    if (body.tripId) {
      const t = await q1<any>(req,
        `SELECT "vehicleId", "driverId", status FROM ${tbl(req.schemaName, 'transport_trips')}
         WHERE id = $1::uuid AND "branchId" = $2::uuid`, body.tripId, req.branchId)
      if (!t) throw httpError(404, 'Trip not found')
      if (t.status === 'cancelled') throw httpError(422, 'Cannot add expenses to a cancelled trip')
      vehicleId = t.vehicleId
      driverId  = driverId ?? t.driverId
    } else if (!vehicleId) {
      throw httpError(422, 'Pick a trip or a vehicle for this expense')
    }
    if (vehicleId) {
      const v = await q1(req, `SELECT id FROM ${tbl(req.schemaName, 'transport_vehicles')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, vehicleId, req.branchId)
      if (!v) throw httpError(404, 'Vehicle not found')
    }

    const amount = body.amount ?? (body.litres && body.ratePerLitre ? r2(body.litres * body.ratePerLitre) : undefined)
    if (!amount || amount <= 0) throw httpError(422, 'Amount is required (or give litres × rate for fuel)')

    // Who paid: explicit, else inferred from the payment mode (keeps older clients working).
    const paidBy = body.paidBy ?? (body.paymentMode === 'credit' ? 'vendor_credit' : body.paymentMode === 'cash' ? 'driver' : 'company')
    const vendorName = body.vendorName?.trim() || null
    if (paidBy === 'vendor_credit' && !vendorName) throw httpError(422, 'Enter the pump / shop name for a credit purchase')
    if (paidBy !== 'vendor_credit' && body.paymentMode === 'credit') throw httpError(422, 'Credit purchases must be marked “on account”')

    const row = await insertRow(req, 'transport_expenses', {
      branchId: req.branchId, ...body, vehicleId, driverId, amount, createdBy: req.userId,
      paidBy, vendorName, paymentMode: paidBy === 'vendor_credit' ? 'credit' : body.paymentMode,
    })
    if (vehicleId && body.odometer) {
      await run(req,
        `UPDATE ${tbl(req.schemaName, 'transport_vehicles')}
         SET "currentOdometer" = GREATEST("currentOdometer", $2::int) WHERE id = $1::uuid`, vehicleId, body.odometer)
    }
    return reply.status(201).send(row)
  })

  // GET /api/transport/expenses/payables — unpaid on-account bills grouped by pump / shop
  app.get('/expenses/payables', async (req) => {
    const rows = await q<any>(req,
      `SELECT e.id, e."expenseDate", e.category, e.amount, e.litres, e."billNo", e."vendorName",
              t."tripNo", e."tripId", v."regNo" AS "vehicleNo"
       FROM ${tbl(req.schemaName, 'transport_expenses')} e
       LEFT JOIN ${tbl(req.schemaName, 'transport_trips')}    t ON t.id = e."tripId"
       LEFT JOIN ${tbl(req.schemaName, 'transport_vehicles')} v ON v.id = e."vehicleId"
       WHERE e."branchId" = $1::uuid AND ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL
       ORDER BY e."expenseDate", e."createdAt"`, req.branchId)
    type Group = { vendor: string; total: number; count: number; oldest: unknown; bills: any[] }
    const groups = new Map<string, Group>()
    for (const r of rows) {
      const name = (r.vendorName ?? '').trim() || 'Unknown'
      const key = name.toLowerCase()
      const g: Group = groups.get(key) ?? { vendor: name, total: 0, count: 0, oldest: r.expenseDate, bills: [] }
      g.total = r2(g.total + r.amount); g.count++; g.bills.push(r)
      groups.set(key, g)
    }
    const data = [...groups.values()].sort((a, b) => b.total - a.total)
    return { data, totalPayable: r2(data.reduce((s, g) => s + g.total, 0)) }
  })

  // POST /api/transport/expenses/settle — mark on-account bills as paid (atomic claim: only still-unpaid rows)
  app.post('/expenses/settle', async (req) => {
    requireWrite(req)
    const body = SettleBody.parse(req.body)
    const rows = await q<{ id: string }>(req,
      `UPDATE ${tbl(req.schemaName, 'transport_expenses')} e
       SET "settledOn" = $3::date, "settledMode" = $4
       WHERE e.id = ANY($1::uuid[]) AND e."branchId" = $2::uuid
         AND ${paidByExpr('e')} = 'vendor_credit' AND e."settledOn" IS NULL
       RETURNING e.id`, body.ids, req.branchId, body.settledOn ?? todayStr(), body.mode)
    if (rows.length === 0) throw httpError(422, 'These bills are already paid')
    return { settled: rows.length }
  })

  // DELETE /api/transport/expenses/:id
  app.delete('/expenses/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const n = await run(req,
      `DELETE FROM ${tbl(req.schemaName, 'transport_expenses')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (n === 0) throw httpError(404, 'Expense not found')
    return { ok: true }
  })
}

export { tripPnl }
