// apps/api/src/workers/transport-alerts.worker.ts
//
// Daily at 09:30 IST: for every active tenant/branch, send the opt-in transport alerts —
// overdue freight-bill reminders to customers and a compliance / e-way digest to the owner.
// What is sent is controlled per business by the notify_* settings (all default off), and
// dedupe keys make a re-run on the same day harmless.

import cron from 'node-cron'
import { db } from '@billing/db'
import { getTenantDb } from '../lib/tenant-db.js'
import { runDailyAlerts } from '../lib/transport-notify.js'

export async function runTransportAlerts(): Promise<void> {
  const tenants = await db.tenant.findMany({ where: { isActive: true }, select: { id: true, schemaName: true } })
  let reminders = 0, ownerAlerts = 0
  for (const t of tenants) {
    try {
      const tdb = getTenantDb(t.schemaName)
      const branches = await tdb.branch.findMany({ where: { isActive: true }, select: { id: true } })
      for (const b of branches) {
        const r = await runDailyAlerts({ db: tdb, schemaName: t.schemaName, branchId: b.id })
        reminders += r.reminders
        ownerAlerts += r.ownerAlerts
      }
    } catch (err) {
      // One tenant failing (e.g. not a transport schema) must not stop the rest.
      console.error(`[Transport Alerts] tenant ${t.id} failed:`, (err as Error).message)
    }
  }
  console.log(`[Transport Alerts] done — ${reminders} customer reminders, ${ownerAlerts} owner alert lines queued`)
}

// 04:00 UTC = 09:30 IST
cron.schedule('0 4 * * *', () => {
  runTransportAlerts().catch((err) => console.error('[Transport Alerts] fatal:', err))
})
console.log('[Transport Alerts] Scheduled — runs daily at 09:30 IST')

if (process.argv.includes('--now')) {
  runTransportAlerts().then(() => process.exit(0))
}
