// apps/api/src/services/ai/paymentReminder.ts
//
// Drafts personalised WhatsApp payment reminders for overdue udhaar.
// Runs as a daily cron job via reminder.worker.ts.
//
// CRITICAL: drafts are NEVER auto-sent. They are written to the notifications
// table as type='payment_reminder_draft'. The owner approves each one (or
// batch-approves) via POST /api/notifications/:id/approve before the actual
// WhatsApp message is queued. This prevents a badly-worded AI draft from
// reaching a real customer unsupervised.

import type { PrismaClient } from '@billing/db'
import { ai, parseAIJson } from '../../lib/ai-provider.js'
import { PaymentReminderDraftSchema, type PaymentReminderDraft } from './extraction.schemas.js'

interface OverdueParty {
  id:          string
  name:        string
  phone:       string | null
  balance:     number
  daysOverdue: number
}

// =============================================================================
// findOverdueParties
// Uses the tenant-scoped db client — no tenantId filter needed since every
// table in the tenant schema is already isolated to that tenant.
// =============================================================================
export async function findOverdueParties(
  tenantDb:      PrismaClient,
  branchId:      string,
  minDaysOverdue = 7
): Promise<OverdueParty[]> {
  const results = await tenantDb.$queryRaw<Array<{
    id: string; name: string; phone: string | null; balance: number; days_overdue: number
  }>>`
    SELECT
      p.id::text,
      p.name,
      p.phone,
      p.balance::float,
      EXTRACT(DAY FROM NOW() - MIN(i."dueDate"))::int AS days_overdue
    FROM parties p
    JOIN invoices i ON i."partyId" = p.id
    WHERE p."branchId" = ${branchId}::uuid
      AND p.balance    > 0
      AND i.status     IN ('confirmed', 'partial')
      AND i."dueDate"  IS NOT NULL
      AND i."dueDate"  < NOW()
    GROUP BY p.id, p.name, p.phone, p.balance
    HAVING EXTRACT(DAY FROM NOW() - MIN(i."dueDate")) >= ${minDaysOverdue}
    ORDER BY days_overdue DESC
  `

  return results.map((r) => ({
    id:          r.id,
    name:        r.name,
    phone:       r.phone,
    balance:     r.balance,
    daysOverdue: r.days_overdue,
  }))
}

// =============================================================================
// draftReminderMessage
// Tone escalates with days overdue:
//   7–14  → friendly nudge
//   15–30 → firm but polite
//   30+   → urgent, direct
// =============================================================================
export async function draftReminderMessage(
  party:        OverdueParty,
  language:     'hi' | 'gu' | 'en' | 'mr' | 'ta' = 'hi',
  businessName: string
): Promise<PaymentReminderDraft> {
  const suggestedTone =
    party.daysOverdue >= 30 ? 'urgent' :
    party.daysOverdue >= 15 ? 'firm'   : 'friendly'

  const rawText = await ai.chat({
    system: `You write polite, culturally appropriate WhatsApp payment reminder
messages for Indian small businesses. Keep the relationship warm — these are
regular, valued customers. Never be rude or threatening, even at "urgent"
tone — Indian business culture values relationship preservation.

Return ONLY JSON: { "message": "...", "tone": "...", "language": "..." }

Guidelines by tone:
- friendly: light reminder, assume they simply forgot, warm and brief
- firm: clear ask for payment by a specific timeframe, still respectful
- urgent: direct but never threatening, may mention impact on continued credit

Keep messages under 3-4 short lines. Use the customer's name. Include the
amount in Indian Rupee format (₹). Sign off with the business name.`,
    prompt: `Business: ${businessName}
Customer: ${party.name}
Amount due: ₹${party.balance.toFixed(0)}
Days overdue: ${party.daysOverdue}
Suggested tone: ${suggestedTone}
Language: ${language}`,
    maxTokens: 400,
    quality:   'fast',
  })

  try {
    const parsed = parseAIJson<unknown>(rawText)
    const result = PaymentReminderDraftSchema.safeParse(parsed)
    if (result.success) return result.data
    return fallbackReminder(party, businessName, language)
  } catch {
    return fallbackReminder(party, businessName, language)
  }
}

function fallbackReminder(
  party: OverdueParty, businessName: string, language: 'hi'|'gu'|'en'|'mr'|'ta'
): PaymentReminderDraft {
  const msgs: Record<string, string> = {
    hi: `Namaste ${party.name} ji, aapka ₹${party.balance.toFixed(0)} ka payment baaki hai. Kripya jald bhugtan karein. Dhanyawad - ${businessName}`,
    en: `Hi ${party.name}, your payment of ₹${party.balance.toFixed(0)} is outstanding. Please settle at your earliest. Thank you - ${businessName}`,
    gu: `Namaste ${party.name}, tamaru ₹${party.balance.toFixed(0)} nu chukvanu baaki che. Krupa kari jaldi chukvi do. Aabhar - ${businessName}`,
    mr: `Namaskar ${party.name}, tumache ₹${party.balance.toFixed(0)} baki ahe. Krupaya lavkar bhara. Dhanyavad - ${businessName}`,
    ta: `Vanakkam ${party.name}, ungal ₹${party.balance.toFixed(0)} nilai irukku. Sariyana naal seluthungal. Nandri - ${businessName}`,
  }
  return { message: msgs[language] ?? msgs['en']!, tone: 'friendly', language }
}

// =============================================================================
// generateDailyReminders — called by reminder.worker.ts
// Returns reminder drafts; the caller persists them as Notification rows.
// =============================================================================
export interface ReminderDraftResult {
  partyId:     string
  partyName:   string
  phone:       string | null
  balance:     number
  daysOverdue: number
  draft:       PaymentReminderDraft
}

export async function generateDailyReminders(
  tenantDb:     PrismaClient,
  branchId:     string,
  businessName: string,
  language:     'hi' | 'gu' | 'en' | 'mr' | 'ta' = 'hi'
): Promise<ReminderDraftResult[]> {
  const overdueParties = await findOverdueParties(tenantDb, branchId)
  const results: ReminderDraftResult[] = []

  for (const party of overdueParties) {
    if (!party.phone) continue

    const draft = await draftReminderMessage(party, language, businessName)
    results.push({
      partyId:    party.id,
      partyName:  party.name,
      phone:      party.phone,
      balance:    party.balance,
      daysOverdue:party.daysOverdue,
      draft,
    })
  }

  return results
}
