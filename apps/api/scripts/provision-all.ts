// Brings every existing tenant schema up to date with the latest provisioning DDL
// (new transport columns / tables / indexes). Safe to re-run — every statement is idempotent.
//
//   pnpm --filter @billing/api provision:all
import { db } from '@billing/db'
import { provisionTenantSchema } from '../src/lib/provision-schema.js'

const tenants = await db.$queryRawUnsafe<{ schemaName: string }[]>(
  `SELECT "schemaName" FROM public.tenants ORDER BY "createdAt"`,
)

let failed = 0
for (const t of tenants) {
  try {
    await provisionTenantSchema(t.schemaName)
    console.log('✓', t.schemaName)
  } catch (err: any) {
    failed++
    console.error('✗', t.schemaName, '—', err?.message ?? err)
  }
}

await db.$disconnect()
console.log(`${tenants.length - failed}/${tenants.length} tenant schemas up to date`)
process.exit(failed ? 1 : 0)
