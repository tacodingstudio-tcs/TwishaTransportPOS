// apps/api/src/routes/staff.ts
//
// Staff shift planning and daily attendance tracking.
//
//  GET  /api/staff/users                         — list users in this branch
//  GET  /api/staff/attendance?date=|month=        — get attendance records
//  POST /api/staff/attendance                     — create / upsert attendance
//  PATCH /api/staff/attendance/:id                — update entry (clock-out, status)
//  GET  /api/staff/shifts?from=&to=               — list planned shifts
//  POST /api/staff/shifts                         — create shift
//  DELETE /api/staff/shifts/:id                   — remove shift

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'

export const staffRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/staff/users ──────────────────────────────────────────────────
  // Returns all active users whose branchIds includes the current branch.
  app.get('/users', async (req, reply) => {
    const db       = req.db
    const branchId = req.branchId

    const users = await db.$queryRaw<Array<{
      id: string; name: string; phone: string; role: string; is_active: boolean
    }>>`
      SELECT id::text, name, phone, role, "isActive" AS is_active
      FROM users
      WHERE "isActive" = true
        AND (
          array_length("branchIds", 1) IS NULL
          OR "branchIds" = '{}'
          OR "branchIds" @> ARRAY[${branchId}::uuid]
        )
      ORDER BY name ASC
    `.catch(() => [] as Array<any>)

    return reply.send({ users })
  })

  // ── GET /api/staff/attendance ─────────────────────────────────────────────
  // Accepts either ?date=YYYY-MM-DD (single day) or ?month=YYYY-MM.
  app.get('/attendance', async (req, reply) => {
    const q = z.object({
      date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      month:  z.string().regex(/^\d{4}-\d{2}$/).optional(),
      userId: z.string().uuid().optional(),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    let from: string, to: string
    if (q.date) {
      from = q.date; to = q.date
    } else if (q.month) {
      const [yr, mo] = q.month.split('-').map(Number) as [number, number]
      from = `${q.month}-01`
      to   = new Date(yr, mo, 0).toISOString().slice(0, 10)
    } else {
      from = to = new Date().toISOString().slice(0, 10)
    }

    const rows = await db.$queryRaw<Array<{
      id: string; user_id: string; user_name: string; user_role: string
      date: string; clock_in: string | null; clock_out: string | null
      hours_worked: number | null; status: string; notes: string | null
    }>>`
      SELECT
        sa.id::text,
        u.id::text                                 AS user_id,
        u.name                                     AS user_name,
        u.role                                     AS user_role,
        TO_CHAR(sa.date, 'YYYY-MM-DD')             AS date,
        TO_CHAR(sa."clockIn",  'HH24:MI')          AS clock_in,
        TO_CHAR(sa."clockOut", 'HH24:MI')          AS clock_out,
        EXTRACT(EPOCH FROM (sa."clockOut" - sa."clockIn")) / 3600.0 AS hours_worked,
        sa.status,
        sa.notes
      FROM staff_attendance sa
      JOIN users u ON u.id = sa."userId"
      WHERE sa."branchId" = ${branchId}::uuid
        AND sa.date >= ${from}::date
        AND sa.date <= ${to}::date
        ${q.userId ? Prisma.sql`AND sa."userId" = ${q.userId}::uuid` : Prisma.empty}
      ORDER BY sa.date DESC, u.name ASC
    `.catch(() => [] as Array<any>)

    // Summary for the period
    const total   = rows.length
    const present = rows.filter(r => r.status === 'present' || r.status === 'late').length
    const absent  = rows.filter(r => r.status === 'absent').length
    const late    = rows.filter(r => r.status === 'late').length

    return reply.send({ from, to, summary: { total, present, absent, late }, records: rows })
  })

  // ── POST /api/staff/attendance ────────────────────────────────────────────
  // Create or update an attendance record (upsert by branchId+userId+date).
  app.post('/attendance', async (req, reply) => {
    const body = z.object({
      userId:   z.string().uuid(),
      date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      clockIn:  z.string().optional(),   // "HH:MM" or ISO timestamp
      clockOut: z.string().optional(),
      status:   z.enum(['present','absent','late','half_day','holiday']).default('present'),
      notes:    z.string().max(300).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // Build clock timestamps — combine date + time string
    const clockInTs  = body.clockIn
      ? `${body.date}T${body.clockIn.length === 5 ? body.clockIn + ':00' : body.clockIn}+05:30`
      : null
    const clockOutTs = body.clockOut
      ? `${body.date}T${body.clockOut.length === 5 ? body.clockOut + ':00' : body.clockOut}+05:30`
      : null

    const rows = await db.$queryRaw<[{ id: string }]>`
      INSERT INTO staff_attendance
        ("branchId", "userId", date, "clockIn", "clockOut", status, notes, "updatedAt")
      VALUES
        (${branchId}::uuid, ${body.userId}::uuid, ${body.date}::date,
         ${clockInTs}::timestamptz, ${clockOutTs}::timestamptz,
         ${body.status}, ${body.notes ?? null}, now())
      ON CONFLICT ("branchId", "userId", date)
      DO UPDATE SET
        "clockIn"   = COALESCE(EXCLUDED."clockIn",   staff_attendance."clockIn"),
        "clockOut"  = COALESCE(EXCLUDED."clockOut",  staff_attendance."clockOut"),
        status      = EXCLUDED.status,
        notes       = COALESCE(EXCLUDED.notes, staff_attendance.notes),
        "updatedAt" = now()
      RETURNING id::text
    `

    return reply.code(201).send({ id: rows[0]!.id })
  })

  // ── PATCH /api/staff/attendance/:id ───────────────────────────────────────
  app.patch('/attendance/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({
      clockOut: z.string().optional(),
      status:   z.enum(['present','absent','late','half_day','holiday']).optional(),
      notes:    z.string().max(300).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    // Fetch the existing record to get its date for timestamp construction
    const existing = await db.$queryRaw<[{ date: string; clock_in: string | null }]>`
      SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR("clockIn", 'HH24:MI') AS clock_in
      FROM staff_attendance
      WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
    `.catch(() => [])

    if (!existing[0]) return reply.code(404).send({ error: 'Not found' })

    const dateStr = existing[0].date
    const clockOutTs = body.clockOut
      ? `${dateStr}T${body.clockOut.length === 5 ? body.clockOut + ':00' : body.clockOut}+05:30`
      : null

    const clockOutSet = clockOutTs ? Prisma.sql`"clockOut" = ${clockOutTs}::timestamptz,` : Prisma.empty
    const statusSet   = body.status  ? Prisma.sql`status = ${body.status},`                : Prisma.empty
    const notesSet    = body.notes   ? Prisma.sql`notes = ${body.notes},`                  : Prisma.empty

    await db.$executeRaw`
      UPDATE staff_attendance
      SET ${clockOutSet} ${statusSet} ${notesSet} "updatedAt" = now()
      WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
    `

    return reply.send({ ok: true })
  })

  // ── GET /api/staff/shifts ─────────────────────────────────────────────────
  app.get('/shifts', async (req, reply) => {
    const q = z.object({
      from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
              .default(new Date().toISOString().slice(0, 10)),
      to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
              .default(new Date().toISOString().slice(0, 10)),
      userId: z.string().uuid().optional(),
    }).parse(req.query)

    const db       = req.db
    const branchId = req.branchId

    const shifts = await db.$queryRaw<Array<{
      id: string; user_id: string; user_name: string
      date: string; shift_type: string
      shift_start: string | null; shift_end: string | null; notes: string | null
    }>>`
      SELECT
        ss.id::text,
        u.id::text                       AS user_id,
        u.name                           AS user_name,
        TO_CHAR(ss.date, 'YYYY-MM-DD')   AS date,
        ss."shiftType"                   AS shift_type,
        TO_CHAR(ss."shiftStart", 'HH24:MI') AS shift_start,
        TO_CHAR(ss."shiftEnd",   'HH24:MI') AS shift_end,
        ss.notes
      FROM staff_shifts ss
      JOIN users u ON u.id = ss."userId"
      WHERE ss."branchId" = ${branchId}::uuid
        AND ss.date >= ${q.from}::date
        AND ss.date <= ${q.to}::date
        ${q.userId ? Prisma.sql`AND ss."userId" = ${q.userId}::uuid` : Prisma.empty}
      ORDER BY ss.date ASC, u.name ASC
    `.catch(() => [] as Array<any>)

    return reply.send({ shifts })
  })

  // ── POST /api/staff/shifts ────────────────────────────────────────────────
  app.post('/shifts', async (req, reply) => {
    const body = z.object({
      userId:     z.string().uuid(),
      date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      shiftType:  z.enum(['morning','evening','night','full_day']).default('full_day'),
      shiftStart: z.string().optional(),
      shiftEnd:   z.string().optional(),
      notes:      z.string().max(300).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const rows = await db.$queryRaw<[{ id: string }]>`
      INSERT INTO staff_shifts ("branchId", "userId", date, "shiftType", "shiftStart", "shiftEnd", notes)
      VALUES (${branchId}::uuid, ${body.userId}::uuid, ${body.date}::date,
              ${body.shiftType},
              ${body.shiftStart ? body.shiftStart : null}::time,
              ${body.shiftEnd   ? body.shiftEnd   : null}::time,
              ${body.notes ?? null})
      RETURNING id::text
    `

    return reply.code(201).send({ id: rows[0]!.id })
  })

  // ── DELETE /api/staff/shifts/:id ──────────────────────────────────────────
  app.delete('/shifts/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const db       = req.db
    const branchId = req.branchId

    await db.$executeRaw`
      DELETE FROM staff_shifts
      WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
    `

    return reply.send({ ok: true })
  })
}
