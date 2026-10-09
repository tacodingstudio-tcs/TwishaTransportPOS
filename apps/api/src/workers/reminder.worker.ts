// apps/api/src/workers/reminder.worker.ts
//
// Runs daily at 10 AM IST. For every active branch in every active tenant:
//   1. Finds customers with overdue invoices
//   2. Drafts AI-personalised WhatsApp reminder messages
//   3. Writes them as Notification rows (type='payment_reminder_draft')
//
// The owner approves each draft via POST /api/notifications/:id/approve
// before any WhatsApp message is actually sent. Nothing auto-sends.

import cron from 'node-cron'
import { db } from '@billing/db'           // public schema — tenants table only
import { getTenantDb } from '../lib/tenant-db.js'
import { generateDailyReminders } from '../services/ai/paymentReminder.js'

async function runDailyReminderJob() {
  console.log('[Reminder Worker] Starting daily reminder generation...')

  // 1. Fetch all active tenants from the public schema
  const tenants = await db.tenant.findMany({
    where:  { isActive: true },
    select: { id: true, name: true, schemaName: true, settings: true },
  })

  let totalDrafts = 0

  for (const tenant of tenants) {
    const tenantDb = getTenantDb(tenant.schemaName)
    const lang = ((tenant.settings as Record<string, unknown>)?.['lang'] as
      'hi' | 'gu' | 'en' | 'mr' | 'ta') ?? 'hi'

    // 2. Get active branches from tenant schema
    let branches: Array<{ id: string; domainConfig: unknown }>
    try {
      branches = await tenantDb.branch.findMany({
        where:  { isActive: true },
        select: { id: true, domainConfig: true },
      })
    } catch (err) {
      console.error(`[Reminder Worker] Cannot read branches for tenant ${tenant.id}:`, (err as Error).message)
      continue
    }

    for (const branch of branches) {
      // Only run for domains where credit/udhaar tracking makes sense
      const config = branch.domainConfig as Record<string, unknown>
      if (config['udhaar_enabled'] === false) continue

      try {
        const reminders = await generateDailyReminders(
          tenantDb, branch.id, tenant.name, lang
        )

        for (const r of reminders) {
          // Check for duplicate — don't spam the notification list if already drafted today
          const today = new Date()
          today.setHours(0, 0, 0, 0)

          const existing = await tenantDb.notification.findFirst({
            where: {
              branchId:  branch.id,
              type:      'payment_reminder_draft',
              createdAt: { gte: today },
              payload:   { path: ['partyId'], equals: r.partyId },
            },
          })
          if (existing) continue

          await tenantDb.notification.create({
            data: {
              branchId: branch.id,
              type:     'payment_reminder_draft',
              title:    `Payment reminder draft — ${r.partyName}`,
              body:     r.draft.message,
              payload:  {
                partyId:     r.partyId,
                partyName:   r.partyName,
                phone:       r.phone,
                balance:     r.balance,
                daysOverdue: r.daysOverdue,
                tone:        r.draft.tone,
                language:    r.draft.language,
                draftMessage:r.draft.message,
              },
            },
          })

          totalDrafts++
        }

        console.log(`[Reminder Worker] Branch ${branch.id}: ${reminders.length} drafts created`)
      } catch (err) {
        console.error(`[Reminder Worker] Branch ${branch.id} failed:`, (err as Error).message)
        // Continue to next branch — one failure shouldn't block the whole run
      }
    }
  }

  console.log(`[Reminder Worker] Done. Total drafts: ${totalDrafts}`)
}

// Schedule: every day at 10:00 IST (04:30 UTC)
cron.schedule('30 4 * * *', () => {
  runDailyReminderJob().catch((err) =>
    console.error('[Reminder Worker] Fatal error:', err)
  )
})

console.log('[Reminder Worker] Scheduled — runs daily at 10:00 IST (04:30 UTC)')

// Allow manual trigger for testing: tsx reminder.worker.ts --now
if (process.argv.includes('--now')) {
  runDailyReminderJob().then(() => process.exit(0))
}
