// apps/api/src/routes/transport-fleet.ts
// Fleet master data: vehicles, drivers, route rate card, compliance alerts.
// Registered under /api/transport by routes/transport.ts.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { VEHICLE_TYPES } from '@billing/domain-registry'
import {
  tbl, q, q1, run, insertRow, updateRow, httpError, requireWrite, requireManager,
  todayStr, addDays, daysBetween, branchConfig, ymd, paidByExpr,
} from '../lib/transport-helpers.js'

const dateStr   = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const optDate   = dateStr.nullable().optional()
const optText   = z.string().max(300).nullable().optional()
const idParam   = z.object({ id: z.string().uuid() })

/** "gj 05-ab 1234" → "GJ05AB1234" */
const normReg = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

const isDuplicate = (err: unknown) =>
  err instanceof Error && /duplicate key|unique constraint|23505/i.test(`${err.message} ${(err as any)?.meta?.message ?? ''}`)

// ── Vehicle schema ────────────────────────────────────────────────────────────
const VehicleBody = z.object({
  regNo:                z.string().min(6).max(20).transform(normReg),
  vehicleType:          z.enum(VEHICLE_TYPES).default('hcv'),
  makeModel:            optText,
  yearOfMfg:            z.number().int().min(1980).max(2100).nullable().optional(),
  capacityTons:         z.number().positive().max(200).nullable().optional(),
  bodyType:             optText,
  ownership:            z.enum(['own', 'attached', 'market']).default('own'),
  ownerName:            optText,
  ownerPhone:           optText,
  ownerPan:             z.string().max(10).nullable().optional(),
  chassisNo:            optText,
  engineNo:             optText,
  fastagId:             optText,
  fitnessExpiry:        optDate,
  permitExpiry:         optDate,
  nationalPermitExpiry: optDate,
  insuranceExpiry:      optDate,
  pucExpiry:            optDate,
  roadTaxExpiry:        optDate,
  currentOdometer:      z.number().int().min(0).default(0),
  defaultDriverId:      z.string().uuid().nullable().optional(),
  notes:                z.string().max(1000).nullable().optional(),
})

const DriverBody = z.object({
  name:          z.string().min(1).max(100),
  phone:         z.string().max(15).nullable().optional(),
  altPhone:      z.string().max(15).nullable().optional(),
  licenseNo:     z.string().max(30).nullable().optional(),
  licenseClass:  z.string().max(30).nullable().optional(),
  licenseExpiry: optDate,
  bloodGroup:    z.string().max(5).nullable().optional(),
  address:       z.string().max(300).nullable().optional(),
  joinedOn:      optDate,
  salaryType:    z.enum(['monthly', 'per_trip', 'per_km']).default('monthly'),
  salaryAmount:  z.number().min(0).default(0),
  notes:         z.string().max(1000).nullable().optional(),
})

const RouteBody = z.object({
  fromCity:             z.string().min(1).max(100),
  toCity:               z.string().min(1).max(100),
  distanceKm:           z.number().int().positive().nullable().optional(),
  transitDays:          z.number().positive().max(60).nullable().optional(),
  vehicleType:          z.enum(VEHICLE_TYPES).nullable().optional(),
  partyId:              z.string().uuid().nullable().optional(),
  rateBasis:            z.enum(['fixed', 'per_ton', 'per_kg', 'per_km', 'per_pkg']).default('fixed'),
  rate:                 z.number().min(0),
  tollEstimate:         z.number().min(0).default(0),
  dieselLitresEstimate: z.number().min(0).nullable().optional(),
  notes:                z.string().max(500).nullable().optional(),
})

export const transportFleetRoutes: FastifyPluginAsync = async (app) => {

  // ══════════════════════════════════════════════════════════════════════════
  // VEHICLES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/vehicles
  app.get('/vehicles', async (req) => {
    const qy = z.object({
      status:    z.string().optional(),
      ownership: z.string().optional(),
      search:    z.string().optional(),
    }).parse(req.query)

    const params: unknown[] = [req.branchId]
    let where = `WHERE v."branchId" = $1::uuid AND v."isActive" = true`
    if (qy.status)    { params.push(qy.status);    where += ` AND v.status = $${params.length}` }
    if (qy.ownership) { params.push(qy.ownership); where += ` AND v.ownership = $${params.length}` }
    if (qy.search)    { params.push(`%${qy.search}%`)
      where += ` AND (v."regNo" ILIKE $${params.length} OR v."makeModel" ILIKE $${params.length} OR v."ownerName" ILIKE $${params.length})` }

    return q(req,
      `SELECT v.*, d.name AS "defaultDriverName"
       FROM ${tbl(req.schemaName, 'transport_vehicles')} v
       LEFT JOIN ${tbl(req.schemaName, 'transport_drivers')} d ON d.id = v."defaultDriverId"
       ${where} ORDER BY v."regNo" ASC`,
      ...params)
  })

  // POST /api/transport/vehicles
  app.post('/vehicles', async (req, reply) => {
    requireWrite(req)
    const body = VehicleBody.parse(req.body)
    const dup = await q1(req,
      `SELECT id FROM ${tbl(req.schemaName, 'transport_vehicles')}
       WHERE "branchId" = $1::uuid AND "regNo" = $2`, req.branchId, body.regNo)
    if (dup) throw httpError(409, `Vehicle ${body.regNo} already exists`)
    try {
      const row = await insertRow(req, 'transport_vehicles', { branchId: req.branchId, ...body })
      return reply.status(201).send(row)
    } catch (err) {
      if (isDuplicate(err)) throw httpError(409, `Vehicle ${body.regNo} already exists`)
      throw err
    }
  })

  // GET /api/transport/vehicles/:id — profile with trip history + cost summary
  app.get('/vehicles/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const vehicle = await q1(req,
      `SELECT v.*, d.name AS "defaultDriverName"
       FROM ${tbl(req.schemaName, 'transport_vehicles')} v
       LEFT JOIN ${tbl(req.schemaName, 'transport_drivers')} d ON d.id = v."defaultDriverId"
       WHERE v.id = $1::uuid AND v."branchId" = $2::uuid`, id, req.branchId)
    if (!vehicle) throw httpError(404, 'Vehicle not found')

    const [trips, expenseByCat, fuel] = await Promise.all([
      q(req,
        `SELECT t.id, t."tripNo", t."fromCity", t."toCity", t."startDate", t."endDate", t.status,
                t."startOdometer", t."endOdometer",
                (SELECT COALESCE(SUM("totalAmount"),0) FROM ${tbl(req.schemaName, 'transport_lorry_receipts')} l
                  WHERE l."tripId" = t.id AND l.status != 'cancelled') AS freight
         FROM ${tbl(req.schemaName, 'transport_trips')} t
         WHERE t."vehicleId" = $1::uuid AND t."branchId" = $2::uuid
         ORDER BY t."startDate" DESC, t."createdAt" DESC LIMIT 20`, id, req.branchId),
      q(req,
        `SELECT category, COALESCE(SUM(amount),0) AS amount
         FROM ${tbl(req.schemaName, 'transport_expenses')}
         WHERE "vehicleId" = $1::uuid AND "branchId" = $2::uuid GROUP BY category ORDER BY amount DESC`,
        id, req.branchId),
      // Fuel efficiency: km driven between first and last fill ÷ litres (excluding the last fill)
      q(req,
        `SELECT MIN(odometer) AS "minOdo", MAX(odometer) AS "maxOdo",
                COALESCE(SUM(litres),0) AS "totalLitres",
                COALESCE(SUM(litres) FILTER (WHERE odometer IS NOT NULL AND odometer < (
                  SELECT MAX(odometer) FROM ${tbl(req.schemaName, 'transport_expenses')}
                  WHERE "vehicleId" = $1::uuid AND category = 'diesel')),0) AS "litresForKm"
         FROM ${tbl(req.schemaName, 'transport_expenses')}
         WHERE "vehicleId" = $1::uuid AND "branchId" = $2::uuid AND category = 'diesel' AND litres > 0`,
        id, req.branchId),
    ])
    const f = fuel[0] ?? {}
    const km = f.maxOdo != null && f.minOdo != null ? f.maxOdo - f.minOdo : 0
    const kmpl = km > 0 && f.litresForKm > 0 ? Math.round((km / f.litresForKm) * 100) / 100 : null
    return { ...vehicle, recentTrips: trips, expenseByCategory: expenseByCat, fuelEfficiencyKmpl: kmpl }
  })

  // PATCH /api/transport/vehicles/:id
  app.patch('/vehicles/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = VehicleBody.partial().extend({
      status:   z.enum(['available', 'maintenance', 'inactive']).optional(),   // 'on_trip' is set by trips only
      isActive: z.boolean().optional(),
    }).parse(req.body)
    if (Object.keys(body).length === 0) throw httpError(400, 'Nothing to update')
    try {
      const row = await updateRow(req, 'transport_vehicles', id, body)
      if (!row) throw httpError(404, 'Vehicle not found')
      return row
    } catch (err) {
      if (isDuplicate(err)) throw httpError(409, 'Another vehicle already has that registration number')
      throw err
    }
  })

  // DELETE /api/transport/vehicles/:id — soft delete; blocked while on a trip
  app.delete('/vehicles/:id', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const v = await q1<{ status: string }>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_vehicles')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!v) throw httpError(404, 'Vehicle not found')
    if (v.status === 'on_trip') throw httpError(422, 'Vehicle is on a running trip — complete the trip first')
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_vehicles')} SET "isActive" = false, status = 'inactive', "updatedAt" = NOW()
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    return { ok: true }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // DRIVERS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/drivers
  app.get('/drivers', async (req) => {
    const qy = z.object({ status: z.string().optional(), search: z.string().optional() }).parse(req.query)
    const params: unknown[] = [req.branchId]
    let where = `WHERE "branchId" = $1::uuid AND "isActive" = true`
    if (qy.status) { params.push(qy.status); where += ` AND status = $${params.length}` }
    if (qy.search) { params.push(`%${qy.search}%`)
      where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR "licenseNo" ILIKE $${params.length})` }
    return q(req, `SELECT * FROM ${tbl(req.schemaName, 'transport_drivers')} ${where} ORDER BY name ASC`, ...params)
  })

  // POST /api/transport/drivers
  app.post('/drivers', async (req, reply) => {
    requireWrite(req)
    const body = DriverBody.parse(req.body)
    const row = await insertRow(req, 'transport_drivers', { branchId: req.branchId, ...body })
    return reply.status(201).send(row)
  })

  // GET /api/transport/drivers/:id — profile + trip history + advance ledger
  app.get('/drivers/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const driver = await q1(req,
      `SELECT * FROM ${tbl(req.schemaName, 'transport_drivers')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!driver) throw httpError(404, 'Driver not found')
    const trips = await q(req,
      `SELECT t.id, t."tripNo", t."fromCity", t."toCity", t."startDate", t.status, t."driverAdvance",
              v."regNo" AS "vehicleNo",
              (SELECT COALESCE(SUM(e.amount),0) FROM ${tbl(req.schemaName, 'transport_expenses')} e
                WHERE e."tripId" = t.id AND ${paidByExpr('e')} = 'driver') AS "cashSpent"
       FROM ${tbl(req.schemaName, 'transport_trips')} t
       LEFT JOIN ${tbl(req.schemaName, 'transport_vehicles')} v ON v.id = t."vehicleId"
       WHERE t."driverId" = $1::uuid AND t."branchId" = $2::uuid AND t.status != 'cancelled'
       ORDER BY t."startDate" DESC LIMIT 30`, id, req.branchId)
    const ledger = trips.map((t: any) => ({ ...t, balance: Math.round((t.driverAdvance - t.cashSpent) * 100) / 100 }))
    return { ...driver, trips: ledger }
  })

  // PATCH /api/transport/drivers/:id
  app.patch('/drivers/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = DriverBody.partial().extend({
      status:   z.enum(['available', 'off_duty', 'inactive']).optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body)
    if (Object.keys(body).length === 0) throw httpError(400, 'Nothing to update')
    const row = await updateRow(req, 'transport_drivers', id, body)
    if (!row) throw httpError(404, 'Driver not found')
    return row
  })

  // DELETE /api/transport/drivers/:id (soft)
  app.delete('/drivers/:id', async (req) => {
    requireManager(req)
    const { id } = idParam.parse(req.params)
    const d = await q1<{ status: string }>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_drivers')} WHERE id = $1::uuid AND "branchId" = $2::uuid`,
      id, req.branchId)
    if (!d) throw httpError(404, 'Driver not found')
    if (d.status === 'on_trip') throw httpError(422, 'Driver is on a running trip — complete the trip first')
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_drivers')} SET "isActive" = false, status = 'inactive', "updatedAt" = NOW()
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    return { ok: true }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // ROUTE RATE CARD
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/routes
  app.get('/routes', async (req) => {
    const qy = z.object({ search: z.string().optional(), partyId: z.string().uuid().optional() }).parse(req.query)
    const params: unknown[] = [req.branchId]
    let where = `WHERE r."branchId" = $1::uuid AND r."isActive" = true`
    if (qy.partyId) { params.push(qy.partyId); where += ` AND r."partyId" = $${params.length}::uuid` }
    if (qy.search)  { params.push(`%${qy.search}%`)
      where += ` AND (r."fromCity" ILIKE $${params.length} OR r."toCity" ILIKE $${params.length})` }
    return q(req,
      `SELECT r.*, p.name AS "partyName"
       FROM ${tbl(req.schemaName, 'transport_routes')} r
       LEFT JOIN ${tbl(req.schemaName, 'parties')} p ON p.id = r."partyId"
       ${where} ORDER BY r."fromCity", r."toCity", r."vehicleType" NULLS FIRST`, ...params)
  })

  // GET /api/transport/routes/lookup?from=&to=&partyId=&vehicleType=
  // Best-match rate for LR auto-fill: party+vehicle specific beats party beats vehicle beats generic.
  app.get('/routes/lookup', async (req) => {
    const qy = z.object({
      from:        z.string().min(1),
      to:          z.string().min(1),
      partyId:     z.string().uuid().optional(),
      vehicleType: z.string().optional(),
    }).parse(req.query)
    const row = await q1(req,
      `SELECT *,
              (CASE WHEN "partyId" = $4::uuid THEN 2 ELSE 0 END
             + CASE WHEN "vehicleType" = $5     THEN 1 ELSE 0 END) AS score
       FROM ${tbl(req.schemaName, 'transport_routes')}
       WHERE "branchId" = $1::uuid AND "isActive" = true
         AND LOWER("fromCity") = LOWER($2) AND LOWER("toCity") = LOWER($3)
         AND ("partyId" IS NULL OR "partyId" = $4::uuid)
         AND ("vehicleType" IS NULL OR "vehicleType" = $5)
       ORDER BY score DESC, "updatedAt" DESC LIMIT 1`,
      req.branchId, qy.from, qy.to, qy.partyId ?? null, qy.vehicleType ?? null)
    return row ?? null
  })

  // POST /api/transport/routes
  app.post('/routes', async (req, reply) => {
    requireWrite(req)
    const body = RouteBody.parse(req.body)
    const row = await insertRow(req, 'transport_routes', { branchId: req.branchId, ...body })
    return reply.status(201).send(row)
  })

  // PATCH /api/transport/routes/:id
  app.patch('/routes/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = RouteBody.partial().extend({ isActive: z.boolean().optional() }).parse(req.body)
    if (Object.keys(body).length === 0) throw httpError(400, 'Nothing to update')
    const row = await updateRow(req, 'transport_routes', id, body)
    if (!row) throw httpError(404, 'Route not found')
    return row
  })

  // DELETE /api/transport/routes/:id (soft)
  app.delete('/routes/:id', async (req) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_routes')} SET "isActive" = false, "updatedAt" = NOW()
       WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    return { ok: true }
  })

  // GET /api/transport/cities — distinct city names for autocomplete
  app.get('/cities', async (req) => {
    const rows = await q<{ city: string }>(req,
      `SELECT DISTINCT city FROM (
         SELECT "fromCity" AS city FROM ${tbl(req.schemaName, 'transport_routes')}          WHERE "branchId" = $1::uuid
         UNION SELECT "toCity"       FROM ${tbl(req.schemaName, 'transport_routes')}          WHERE "branchId" = $1::uuid
         UNION SELECT "fromCity"     FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}  WHERE "branchId" = $1::uuid
         UNION SELECT "toCity"       FROM ${tbl(req.schemaName, 'transport_lorry_receipts')}  WHERE "branchId" = $1::uuid
       ) c WHERE city IS NOT NULL AND city <> '' ORDER BY city`, req.branchId)
    return rows.map((r) => r.city)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // COMPLIANCE — vehicle documents + driver licences expiring or expired
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/transport/compliance?days=30
  app.get('/compliance', async (req) => {
    const qy = z.object({ days: z.coerce.number().int().min(0).max(365).optional() }).parse(req.query)
    const cfg  = await branchConfig(req)
    const days = qy.days ?? Number(cfg['compliance_alert_days'] ?? 30)
    const today = todayStr()
    const horizon = addDays(today, days)

    const [vehicleDocs, licences] = await Promise.all([
      q<{ id: string; regNo: string; doc: string; expiry: Date }>(req,
        `SELECT v.id, v."regNo", d.doc, d.expiry
         FROM ${tbl(req.schemaName, 'transport_vehicles')} v
         CROSS JOIN LATERAL (VALUES
           ('Fitness',         v."fitnessExpiry"),
           ('Permit',          v."permitExpiry"),
           ('National Permit', v."nationalPermitExpiry"),
           ('Insurance',       v."insuranceExpiry"),
           ('PUC',             v."pucExpiry"),
           ('Road Tax',        v."roadTaxExpiry")
         ) AS d(doc, expiry)
         WHERE v."branchId" = $1::uuid AND v."isActive" = true
           AND d.expiry IS NOT NULL AND d.expiry <= $2::date
         ORDER BY d.expiry ASC`, req.branchId, horizon),
      q<{ id: string; name: string; licenseNo: string | null; licenseExpiry: Date }>(req,
        `SELECT id, name, "licenseNo", "licenseExpiry"
         FROM ${tbl(req.schemaName, 'transport_drivers')}
         WHERE "branchId" = $1::uuid AND "isActive" = true
           AND "licenseExpiry" IS NOT NULL AND "licenseExpiry" <= $2::date
         ORDER BY "licenseExpiry" ASC`, req.branchId, horizon),
    ])

    const items = [
      ...vehicleDocs.map((v) => ({
        kind: 'vehicle' as const, entityId: v.id, entityName: v.regNo, doc: v.doc,
        expiry: ymd(v.expiry),
      })),
      ...licences.map((d) => ({
        kind: 'driver' as const, entityId: d.id, entityName: d.name, doc: 'Driving Licence',
        expiry: ymd(d.licenseExpiry),
      })),
    ].map((i) => {
      const daysLeft = daysBetween(today, i.expiry)
      return { ...i, daysLeft, severity: daysLeft < 0 ? 'expired' : daysLeft <= 7 ? 'critical' : 'warning' }
    }).sort((a, b) => a.daysLeft - b.daysLeft)

    return {
      asOf: today,
      windowDays: days,
      counts: {
        expired:  items.filter((i) => i.severity === 'expired').length,
        critical: items.filter((i) => i.severity === 'critical').length,
        warning:  items.filter((i) => i.severity === 'warning').length,
      },
      items,
    }
  })
}
