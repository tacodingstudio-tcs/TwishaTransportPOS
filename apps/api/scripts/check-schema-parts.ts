// Provisions a full and a lean (core+transport) throwaway schema and checks: no retail table in lean, and every shared table has
// identical columns in both. Run after touching provision-schema.ts / schema-parts.ts:  npx tsx --env-file=.env scripts/check-schema-parts.ts
import { db } from '@billing/db'
import { createTenantSchema } from '../src/lib/provision-schema.js'
import { RETAIL_TABLES, ALL_PARTS } from '../src/lib/schema-parts.js'

const full = 'zz_parts_full', lean = 'zz_parts_lean'
for (const s of [full, lean]) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
await createTenantSchema(full, ALL_PARTS)
await createTenantSchema(lean, ['core', 'transport'])

const cols = async (s: string) => {
  const r = (await db.$queryRawUnsafe(
    `SELECT table_name t, column_name c, data_type d, is_nullable n, column_default df FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1, ordinal_position`, s)) as any[]
  const m = new Map<string, string[]>()
  for (const x of r) { if (!m.has(x.t)) m.set(x.t, []); m.get(x.t)!.push(`${x.c}|${x.d}|${x.n}|${x.df ?? ''}`) }
  return m
}
const F = await cols(full), L = await cols(lean)
console.log('full tables', F.size, '| lean tables', L.size)
console.log('retail tables present in lean:', [...L.keys()].filter((t) => RETAIL_TABLES.has(t)))
console.log('tables only in full:', [...F.keys()].filter((t) => !L.has(t)).sort().join(', '))
console.log('tables only in lean:', [...L.keys()].filter((t) => !F.has(t)))
let diffs = 0
for (const [t, c] of L) {
  const f = F.get(t); if (!f) continue
  const a = new Set(c), b = new Set(f)
  const onlyL = c.filter((x) => !b.has(x)), onlyF = f.filter((x) => !a.has(x))
  if (onlyL.length || onlyF.length) { diffs++; console.log('DIFF', t, { onlyLean: onlyL, onlyFull: onlyF }) }
}
console.log('column-level differences in shared tables:', diffs)
for (const s of [full, lean]) await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
await db.$disconnect()
const bad = [...L.keys()].some((t) => RETAIL_TABLES.has(t)) || diffs > 0 || [...L.keys()].some((t) => !F.has(t))
console.log(bad ? 'FAIL' : 'PASS')
process.exit(bad ? 1 : 0)
