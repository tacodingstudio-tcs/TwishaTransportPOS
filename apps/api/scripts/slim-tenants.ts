// Removes the empty retail tables (products, stock, purchasing, suppliers… — see lib/schema-parts.ts) from existing tenant schemas.
//
//   npx tsx --env-file=.env scripts/slim-tenants.ts                 # DRY RUN: report only, changes nothing
//   npx tsx --env-file=.env scripts/slim-tenants.ts --apply         # do it
//   npx tsx --env-file=.env scripts/slim-tenants.ts --only=t_abc    # one schema
//
// Safe by construction:
//   * a tenant is skipped (and reported) if ANY retail table has rows, or any invoice line points at a product;
//   * foreign keys from kept tables to retail tables are dropped explicitly; the tables are dropped WITHOUT cascade, so anything
//     unexpected that depends on them makes the transaction fail instead of being silently removed;
//   * one transaction per tenant, and inside it the row count of every remaining table is compared before/after — a difference rolls back;
//   * already-slim tenants are left alone, so it is safe to re-run.
// Take a database backup first (Neon: create a branch; local: pg_dump). Afterwards `provision:all` keeps slim tenants slim.
import { db } from '@billing/db'
import { RETAIL_TABLES } from '../src/lib/schema-parts.js'

const apply = process.argv.includes('--apply')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

const tenants = (await db.$queryRawUnsafe(`SELECT "schemaName" FROM public.tenants ORDER BY "createdAt"`)) as Array<{ schemaName: string }>
const tablesOf = async (schema: string) =>
  ((await db.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, schema)) as Array<{ table_name: string }>).map((r) => r.table_name)
const count = async (schema: string, table: string) =>
  Number(((await db.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS n FROM "${schema}"."${table}"`)) as any[])[0].n)

let done = 0, skipped = 0, blocked = 0, failed = 0
console.log(apply ? 'APPLY MODE — changes will be made\n' : 'DRY RUN — nothing will be changed (add --apply to do it)\n')

for (const { schemaName: schema } of tenants) {
  if (only && schema !== only) continue
  try {
    const have = await tablesOf(schema)
    const retail = have.filter((t) => RETAIL_TABLES.has(t))
    if (have.length === 0) { console.log(`- ${schema}: schema missing, skipped`); skipped++; continue }
    if (retail.length === 0) { console.log(`✓ ${schema}: already slim (${have.length} tables)`); skipped++; continue }

    const problems: string[] = []
    for (const t of retail) { const n = await count(schema, t); if (n > 0) problems.push(`${t} has ${n} rows`) }
    if (have.includes('invoice_items')) {
      const n = Number(((await db.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS n FROM "${schema}"."invoice_items" WHERE "productId" IS NOT NULL`)) as any[])[0].n)
      if (n > 0) problems.push(`${n} invoice lines point at a product`)
    }
    if (problems.length) { console.log(`✗ ${schema}: BLOCKED — ${problems.join('; ')}`); blocked++; continue }

    // foreign keys from tables we KEEP to tables we drop
    const fks = (await db.$queryRawUnsafe(
      `SELECT c.conname, src.relname AS src_table, dst.relname AS dst_table
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid JOIN pg_class dst ON dst.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = $1`, schema)) as Array<{ conname: string; src_table: string; dst_table: string }>
    const dropFks = fks.filter((f) => RETAIL_TABLES.has(f.dst_table) && !RETAIL_TABLES.has(f.src_table))

    console.log(`${apply ? '→' : '·'} ${schema}: ${retail.length} empty retail tables to drop (${have.length} → ${have.length - retail.length}), ${dropFks.length} foreign key(s) to remove`)
    if (!apply) { done++; continue }

    const keep = have.filter((t) => !RETAIL_TABLES.has(t))
    await db.$transaction(async (tx) => {
      const before = new Map<string, number>()
      for (const t of keep) before.set(t, Number(((await tx.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS n FROM "${schema}"."${t}"`)) as any[])[0].n))
      for (const f of dropFks) await tx.$executeRawUnsafe(`ALTER TABLE "${schema}"."${f.src_table}" DROP CONSTRAINT "${f.conname}"`)
      // one statement, no cascade: foreign keys between the retail tables themselves are fine, anything else unexpected fails and rolls back
      await tx.$executeRawUnsafe(`DROP TABLE ${retail.map((t) => `"${schema}"."${t}"`).join(', ')}`)
      for (const t of keep) {
        const n = Number(((await tx.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS n FROM "${schema}"."${t}"`)) as any[])[0].n)
        if (n !== before.get(t)) throw new Error(`row count of ${t} changed (${before.get(t)} → ${n}) — rolled back`)
      }
    }, { timeout: 10 * 60 * 1000, maxWait: 60_000 })
    console.log(`  ✓ done — ${keep.length} tables remain, every row count unchanged`)
    done++
  } catch (err: any) {
    failed++
    console.error(`✗ ${schema}: FAILED, nothing changed for this tenant — ${err?.message ?? err}`)
  }
}

await db.$disconnect()
console.log(`\n${apply ? 'slimmed' : 'would slim'} ${done} · already slim/skipped ${skipped} · blocked ${blocked} · failed ${failed}`)
process.exit(failed || blocked ? 1 : 0)
