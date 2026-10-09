// Shared helpers for the transport routes (routes/transport*.ts).
//
// The transport_* tables are raw-SQL tables (not Prisma models), so these
// helpers give routes:
//   • q()/run()       — schema-safe raw queries that return plain JSON values
//   • insertRow()/updateRow() — parameterised INSERT/UPDATE builders with the
//                       right ::casts (Postgres rejects text → uuid/date)
//   • nextNo()        — atomic, per-financial-year document numbers
//   • IST date helpers — the server may run in UTC; business dates are IST

import type { FastifyRequest } from 'fastify'
import type { PrismaClient } from '@billing/db'

/**
 * The slice of a request the helpers need. A FastifyRequest satisfies it, and so does a
 * hand-built context wrapping a Prisma transaction client (used for all-or-nothing bulk writes).
 */
export interface Ctx {
  db: Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>
  schemaName: string
  branchId: string
  userId?: string
}

// ── Errors ────────────────────────────────────────────────────────────────────
export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

// ── Schema-qualified table name ───────────────────────────────────────────────
const SAFE_SCHEMA_RE = /^t_[a-z0-9_]{1,60}$/
export function tbl(schemaName: string, table: string): string {
  if (!SAFE_SCHEMA_RE.test(schemaName)) throw new Error(`Invalid tenant schema name: "${schemaName}"`)
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Invalid table name: "${table}"`)
  return `"${schemaName}"."${table}"`
}

// ── Result normalisation ──────────────────────────────────────────────────────
// Prisma returns NUMERIC as Decimal and COUNT()/SUM(int) as BigInt. Decimal
// serialises to a *string* in JSON (the UI then string-concatenates instead of
// adding) and BigInt makes JSON.stringify throw. Convert both to plain numbers.
function normValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'object') {
    const o = v as { toNumber?: () => number }
    if (typeof o.toNumber === 'function') return o.toNumber()
    if (Array.isArray(v)) return v.map(normValue)
  }
  return v
}

export function norm<T = any>(rows: any[]): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) out[k] = normValue(v)
    return out as T
  })
}

export async function q<T = any>(req: Ctx, sql: string, ...params: unknown[]): Promise<T[]> {
  return norm<T>(await req.db.$queryRawUnsafe<any[]>(sql, ...params))
}

export async function q1<T = any>(req: Ctx, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await q<T>(req, sql, ...params))[0] ?? null
}

export async function run(req: Ctx, sql: string, ...params: unknown[]): Promise<number> {
  return req.db.$executeRawUnsafe(sql, ...params)
}

// ── Column casts for dynamic INSERT/UPDATE ────────────────────────────────────
const COL_CAST: Record<string, string> = {
  // uuid
  branchId: 'uuid', vehicleId: 'uuid', driverId: 'uuid', tripId: 'uuid', partyId: 'uuid',
  consignorId: 'uuid', consigneeId: 'uuid', invoiceId: 'uuid', defaultDriverId: 'uuid', createdBy: 'uuid',
  // date
  fitnessExpiry: 'date', permitExpiry: 'date', nationalPermitExpiry: 'date', insuranceExpiry: 'date',
  pucExpiry: 'date', roadTaxExpiry: 'date', licenseExpiry: 'date', joinedOn: 'date',
  lrDate: 'date', startDate: 'date', endDate: 'date', expenseDate: 'date',
  // timestamptz
  ewayValidUpto: 'timestamptz', dispatchedAt: 'timestamptz', deliveredAt: 'timestamptz',
  podReceivedAt: 'timestamptz', toPayCollectedAt: 'timestamptz',
}

const COL_RE = /^[A-Za-z]+$/

function ph(col: string, n: number): string {
  const cast = COL_CAST[col]
  return cast ? `$${n}::${cast}` : `$${n}`
}

/** INSERT a row; keys with undefined values are skipped. Returns the new row. */
export async function insertRow<T = any>(
  req: Ctx, table: string, data: Record<string, unknown>,
): Promise<T> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined)
  for (const [k] of entries) if (!COL_RE.test(k)) throw new Error(`Bad column name: ${k}`)
  const cols   = entries.map(([k]) => `"${k}"`).join(', ')
  const places = entries.map(([k], i) => ph(k, i + 1)).join(', ')
  const rows = await q<T>(
    req,
    `INSERT INTO ${tbl(req.schemaName, table)} (${cols}) VALUES (${places}) RETURNING *`,
    ...entries.map(([, v]) => v),
  )
  return rows[0]!
}

/** UPDATE a row scoped to the caller's branch. Returns the row or null. */
export async function updateRow<T = any>(
  req: Ctx, table: string, id: string, data: Record<string, unknown>,
): Promise<T | null> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return null
  for (const [k] of entries) if (!COL_RE.test(k)) throw new Error(`Bad column name: ${k}`)
  const sets = entries.map(([k], i) => `"${k}" = ${ph(k, i + 3)}`)
  sets.push(`"updatedAt" = NOW()`)
  const rows = await q<T>(
    req,
    `UPDATE ${tbl(req.schemaName, table)} SET ${sets.join(', ')}
     WHERE id = $1::uuid AND "branchId" = $2::uuid RETURNING *`,
    id, req.branchId, ...entries.map(([, v]) => v),
  )
  return rows[0] ?? null
}

// ── IST dates ─────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** Current date-time shifted so that getUTC*() returns IST wall-clock parts. */
function istNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + IST_OFFSET_MS)
}

/** Today's date in IST as YYYY-MM-DD. */
export function todayStr(now: Date = new Date()): string {
  return istNow(now).toISOString().slice(0, 10)
}

/** Date | ISO string | YYYY-MM-DD → YYYY-MM-DD. Postgres DATE columns arrive as Date at UTC midnight. */
export function ymd(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v ?? '').slice(0, 10)
}

/** Add days to a YYYY-MM-DD string. */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (both YYYY-MM-DD or Date at UTC midnight). */
export function daysBetween(from: string | Date, to: string | Date): number {
  const a = typeof from === 'string' ? new Date(`${from.slice(0, 10)}T00:00:00Z`) : from
  const b = typeof to   === 'string' ? new Date(`${to.slice(0, 10)}T00:00:00Z`)   : to
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** Indian financial-year label for a date: 2025-06-01 → "2526", 2026-02-01 → "2526". */
export function fyLabel(dateStr: string = todayStr()): string {
  const y = Number(dateStr.slice(0, 4))
  const m = Number(dateStr.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}

// ── Document numbering ────────────────────────────────────────────────────────
/**
 * Atomically allocate the next number for (branch, kind, financial year).
 * One UPSERT statement ⇒ safe under concurrent requests without extra locks.
 */
export async function nextSeq(
  req: Ctx, kind: 'lr' | 'trip', fy: string,
): Promise<number> {
  const rows = await q<{ lastVal: number }>(
    req,
    `INSERT INTO ${tbl(req.schemaName, 'transport_counters')} ("branchId","kind","fy","lastVal")
     VALUES ($1::uuid, $2, $3, 1)
     ON CONFLICT ("branchId","kind","fy")
     DO UPDATE SET "lastVal" = ${tbl(req.schemaName, 'transport_counters')}."lastVal" + 1
     RETURNING "lastVal"`,
    req.branchId, kind, fy,
  )
  return rows[0]!.lastVal
}

/** Branch-level transport config (domainConfig JSON) with safe defaults. */
export async function branchConfig(req: Ctx): Promise<Record<string, any>> {
  const rows = await q<{ domainConfig: Record<string, any> | null }>(
    req,
    `SELECT "domainConfig" FROM ${tbl(req.schemaName, 'branches')} WHERE id = $1::uuid`,
    req.branchId,
  )
  return rows[0]?.domainConfig ?? {}
}

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

// ── Freight-bill cancellation ─────────────────────────────────────────────────
/**
 * When a freight bill is cancelled, its LRs go back to the unbilled pool
 * (delivered / POD received) so they can be edited or billed again.
 * Best-effort: a tenant without transport tables simply has nothing to release.
 */
export async function releaseLrsForInvoice(req: FastifyRequest, invoiceId: string): Promise<number> {
  try {
    return await run(req,
      `UPDATE ${tbl(req.schemaName, 'transport_lorry_receipts')}
       SET "invoiceId" = NULL,
           status = CASE WHEN "podReceivedAt" IS NOT NULL THEN 'pod_received' ELSE 'delivered' END,
           "updatedAt" = NOW()
       WHERE "invoiceId" = $1::uuid AND "branchId" = $2::uuid AND status = 'billed'`,
      invoiceId, req.branchId)
  } catch (err) {
    req.log.warn({ err, invoiceId }, 'releaseLrsForInvoice failed')
    return 0
  }
}

// ── Role guards ───────────────────────────────────────────────────────────────
/** Throws 403 for read-only users. */
export function requireWrite(req: FastifyRequest): void {
  if (req.role === 'viewer') throw httpError(403, 'Read-only users cannot modify transport records')
}

/** Throws 403 unless owner/manager. */
export function requireManager(req: FastifyRequest): void {
  if (req.role !== 'owner' && req.role !== 'manager') {
    throw httpError(403, 'Only an owner or manager can do this')
  }
}
