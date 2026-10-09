// =============================================================================
// cleanup-test-tenants.ts
//
// Removes all test tenants created on or after 2026-06-26 (the day test runs
// started generating bulk fake data). Drops their PostgreSQL schemas and
// removes all related rows from the public schema tables.
//
// Safe to re-run — DROP SCHEMA IF EXISTS, DELETE are idempotent.
//
// Usage:
//   npx tsx apps/api/src/lib/cleanup-test-tenants.ts
//   npx tsx apps/api/src/lib/cleanup-test-tenants.ts --dry-run
// =============================================================================

const DRY_RUN = process.argv.includes('--dry-run')

import { PrismaClient } from '@prisma/client'

const DB_URL = 'postgresql://billing_app:localdev123@localhost:5432/billing_db'

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } })

  // Identify test tenants — everything created on 2026-06-26 or later
  const testTenants = await db.$queryRawUnsafe<Array<{ id: string; name: string; schemaName: string }>>(
    `SELECT id, name, "schemaName" FROM public.tenants WHERE "createdAt" >= '2026-06-26' ORDER BY "createdAt"`
  )

  console.log(`\nFound ${testTenants.length} test tenants to remove.\n`)
  if (DRY_RUN) {
    console.log('DRY RUN — no changes will be made.\n')
    testTenants.slice(0, 10).forEach(t => console.log(`  ${t.schemaName}  (${t.name})`))
    if (testTenants.length > 10) console.log(`  ... and ${testTenants.length - 10} more`)
    await db.$disconnect()
    return
  }

  const ids = testTenants.map(t => `'${t.id}'`).join(',')
  const schemas = testTenants.map(t => t.schemaName)

  // Step 1 — Drop each PostgreSQL schema (CASCADE removes all tables inside)
  console.log('Step 1: Dropping tenant schemas...')
  let dropped = 0
  for (const schemaName of schemas) {
    try {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      process.stdout.write('.')
      dropped++
    } catch (err: any) {
      console.error(`\n  WARN: could not drop ${schemaName}: ${err.message}`)
    }
  }
  console.log(`\n  Dropped ${dropped} schemas.\n`)

  // Step 2 — branches, users etc. live inside tenant schemas (t_{slug}),
  // which were already dropped with CASCADE above. Only public.tenants remains.
  console.log('Step 2: Cleaning public.tenants records...')

  // Step 3 — Delete the tenant rows themselves
  const delTenants = await db.$executeRawUnsafe(
    `DELETE FROM public.tenants WHERE id IN (${ids})`
  )
  console.log(`  Deleted ${delTenants} tenants`)

  // Final count
  const remaining = await db.$queryRawUnsafe<Array<{ cnt: bigint }>>(
    `SELECT COUNT(*) as cnt FROM public.tenants`
  )
  console.log(`\nDone. ${remaining[0]?.cnt ?? 0} tenants remain in the database.`)

  await db.$disconnect()
}

main().catch(err => {
  console.error('\nFatal:', err)
  process.exit(1)
})
