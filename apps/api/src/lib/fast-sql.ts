// Fast path for the few reads that return tens of thousands of rows (the CA registers).
//
// Prisma's raw-query layer turns every row into JSON inside its engine and back into objects: ~1 s for 80,000 rows although the database
// answers in ~0.15 s. The plain `pg` driver reads the same rows ~5× faster. It is used ONLY for those big registers; everything else
// stays on Prisma. The SQL is the same (fully schema-qualified through tbl(), so no search_path is needed, and it carries the same
// branchId filters), and values are shaped like Prisma's: numbers for NUMERIC/BIGINT, 'YYYY-MM-DD' text for DATE, UTC for TIMESTAMP.

import pg from 'pg'

const PRISMA_ONLY_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'idle_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size']

function connectionString(): string {
  const raw = process.env['DATABASE_URL']
  if (!raw) throw new Error('DATABASE_URL is not set')
  const u = new URL(raw)
  for (const k of PRISMA_ONLY_PARAMS) u.searchParams.delete(k)          // options only Prisma understands
  return u.toString()
}

const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 1700 || oid === 20) return (v: string) => Number(v)    // NUMERIC, BIGINT → number (rule 1: never leave Decimal / BigInt in a response)
    if (oid === 1082) return (v: string) => v                            // DATE stays 'YYYY-MM-DD' (no timezone shifting)
    if (oid === 1114) return (v: string) => new Date(`${v.replace(' ', 'T')}Z`)   // TIMESTAMP without zone is stored as UTC
    return pg.types.getTypeParser(oid, format as 'text')
  },
}

let pool: pg.Pool | undefined
function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: connectionString(), max: Number(process.env['FAST_SQL_POOL'] ?? 4), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    application_name: 'transport-registers', types: types as pg.CustomTypesConfig,
  })
  pool.on('error', (e) => console.error('[fast-sql] idle client error', e.message))   // never let an idle drop crash the process
  return pool
}

/** Same call shape as q(): `qFast(req, sql, ...params)`. `req` is only there so call sites read like the rest of the code. */
export async function qFast<T = any>(_req: unknown, sql: string, ...params: unknown[]): Promise<T[]> {
  const [text, values] = compactParams(sql, params)
  return (await getPool().query(text, values)).rows as T[]
}

/**
 * Prisma accepts a parameter the SQL never mentions; PostgreSQL itself refuses ("could not determine data type of parameter $2").
 * Renumber the placeholders that ARE used ($1, $3 → $1, $2) and drop the rest, so existing queries run unchanged on this path.
 */
export function compactParams(sql: string, params: unknown[]): [string, unknown[]] {
  const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  if (used.length === params.length && used.every((n, i) => n === i + 1)) return [sql, params]
  const renumber = new Map(used.map((n, i) => [n, i + 1]))
  return [sql.replace(/\$(\d+)/g, (_m, n) => `$${renumber.get(Number(n))}`), used.map((n) => params[n - 1])]
}

export async function closeFastSql(): Promise<void> { await pool?.end(); pool = undefined }
