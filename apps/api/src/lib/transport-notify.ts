// apps/api/src/lib/transport-notify.ts
// WhatsApp notifications for the transport module.
//
// Every outbound message is a row in transport_notifications (so staff can see what went out, what
// failed, and retry), and a job on the existing `whatsapp-send` BullMQ queue. The worker
// (workers/whatsapp.worker.ts) does the actual Cloud-API call and updates the row.
//
// Automatic sends are OPT-IN per event (branch config keys below, default off): a transporter
// should decide whether customers start receiving messages from the system.
//
//   notify_lr_booked      → LR copy PDF to the consignor when an LR is booked
//   notify_lr_delivered   → "delivered" message to the consignor
//   notify_bill_created   → freight-bill PDF to the billing party
//   notify_bill_reminders → daily overdue-bill reminder to the party (every `notify_reminder_every_days`)
//   notify_owner_alerts   → daily digest to the owner: compliance / e-way bills expiring
//
// A failure to notify must never fail the business operation — callers use `safely()`.

import { whatsappQueue } from './queues.js'
import { tbl, q, q1, run, todayStr, type Ctx } from './transport-helpers.js'
import { lrPdf, billPdf, loadBusiness, loadLr, loadBill } from './transport-docs.js'

export type NotifyKind =
  | 'lr_booked' | 'lr_delivered' | 'bill_created' | 'bill_reminder'
  | 'compliance_expiry' | 'eway_expiring' | 'manual'

export const NOTIFY_SETTING_KEYS = [
  'notify_lr_booked', 'notify_lr_delivered', 'notify_bill_created', 'notify_bill_reminders', 'notify_owner_alerts',
] as const

export interface NotifySettings {
  notify_lr_booked: boolean
  notify_lr_delivered: boolean
  notify_bill_created: boolean
  notify_bill_reminders: boolean
  notify_owner_alerts: boolean
  notify_reminder_every_days: number
  notify_owner_phone: string | null
}

export function notifySettings(cfg: Record<string, any>): NotifySettings {
  return {
    notify_lr_booked:      cfg['notify_lr_booked'] === true,
    notify_lr_delivered:   cfg['notify_lr_delivered'] === true,
    notify_bill_created:   cfg['notify_bill_created'] === true,
    notify_bill_reminders: cfg['notify_bill_reminders'] === true,
    notify_owner_alerts:   cfg['notify_owner_alerts'] === true,
    notify_reminder_every_days: Math.min(60, Math.max(1, Number(cfg['notify_reminder_every_days'] ?? 7))),
    notify_owner_phone: cfg['notify_owner_phone'] ? String(cfg['notify_owner_phone']) : null,
  }
}

/** Indian mobile → E.164 digits ("91XXXXXXXXXX"), or null if it does not look like a mobile number. */
export function toWhatsAppPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null
}

/** Run a notification side-effect without ever failing the caller. */
export function safely(label: string, p: Promise<unknown>): void {
  p.catch((err) => console.error(`[transport-notify] ${label} failed:`, (err as Error).message))
}

type Attachment = { spec: 'lr_pdf' | 'bill_pdf'; id: string }

export interface SendArgs {
  kind: NotifyKind
  toPhone: string | null | undefined
  recipientName?: string | null
  message: string
  refType?: 'lr' | 'bill' | 'vehicle' | null
  refId?: string | null
  attachment?: Attachment | null
  /** Same key twice for one branch = send once (e.g. one overdue reminder per bill per day). */
  dedupeKey?: string | null
}

export interface SendResult { id: string | null; status: 'queued' | 'skipped' | 'duplicate'; reason?: string }

/**
 * Records the message and puts it on the queue. Returns `skipped` (with a reason, and a log row) when
 * the number is unusable, `duplicate` when the dedupe key was already used.
 */
export async function sendMessage(ctx: Ctx, a: SendArgs): Promise<SendResult> {
  const phone = toWhatsAppPhone(a.toPhone)
  const attachmentSpec = a.attachment ? `${a.attachment.spec}:${a.attachment.id}` : null

  const rows = await q<{ id: string }>(ctx,
    `INSERT INTO ${tbl(ctx.schemaName, 'transport_notifications')}
       ("branchId","kind","refType","refId","recipientName","toPhone","message","attachment","dedupeKey","status","error","createdBy")
     VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::uuid)
     ON CONFLICT ("branchId","dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING
     RETURNING id`,
    ctx.branchId, a.kind, a.refType ?? null, a.refId ?? null, a.recipientName ?? null,
    phone ?? String(a.toPhone ?? ''), a.message, attachmentSpec, a.dedupeKey ?? null,
    phone ? 'queued' : 'skipped', phone ? null : 'No valid mobile number for this recipient', ctx.userId ?? null)
  const id = rows[0]?.id
  if (!id) return { id: null, status: 'duplicate' }
  if (!phone) return { id, status: 'skipped', reason: 'No valid mobile number for this recipient' }

  await enqueue(ctx, { id, toPhone: phone, message: a.message, attachment: a.attachment ?? null })
  return { id, status: 'queued' }
}

async function enqueue(ctx: Ctx, m: { id: string; toPhone: string; message: string; attachment: Attachment | null }) {
  let document: { base64: string; filename: string } | undefined
  if (m.attachment) {
    const built = m.attachment.spec === 'lr_pdf'
      ? await lrPdf(ctx, m.attachment.id, ['Consignor copy'])
      : await billPdf(ctx, m.attachment.id)
    document = { base64: built.buffer.toString('base64'), filename: built.filename }
  }
  await whatsappQueue.add('transport_message', {
    type: 'transport_message',
    notificationId: m.id,
    schemaName: ctx.schemaName,
    toPhone: m.toPhone,
    message: m.message,
    document,
  })
}

/** Re-queue a failed/skipped message (rebuilding its PDF so the attachment is current). */
export async function retryMessage(ctx: Ctx, id: string): Promise<SendResult> {
  const n = await q1<any>(ctx,
    `SELECT * FROM ${tbl(ctx.schemaName, 'transport_notifications')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, ctx.branchId)
  if (!n) return { id: null, status: 'skipped', reason: 'Notification not found' }
  const phone = toWhatsAppPhone(n.toPhone)
  if (!phone) return { id, status: 'skipped', reason: 'No valid mobile number for this recipient' }
  let attachment: Attachment | null = null
  if (n.attachment) {
    const [spec, refId] = String(n.attachment).split(':')
    attachment = { spec: spec as Attachment['spec'], id: refId! }
  }
  await run(ctx,
    `UPDATE ${tbl(ctx.schemaName, 'transport_notifications')} SET status = 'queued', error = NULL WHERE id = $1::uuid`, id)
  await enqueue(ctx, { id, toPhone: phone, message: n.message, attachment })
  return { id, status: 'queued' }
}

// ── Message builders ──────────────────────────────────────────────────────────

const inr = (n: unknown) => `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmt = (v: unknown) => {
  const d = v instanceof Date ? v : new Date(String(v))
  return isNaN(d.getTime()) ? String(v ?? '') : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
}

/** Automatic LR events — a no-op unless the branch enabled the matching setting (or `force`). */
export async function notifyLr(ctx: Ctx, lrId: string, kind: 'lr_booked' | 'lr_delivered', opts: { force?: boolean; toPhone?: string } = {}): Promise<SendResult | null> {
  const biz = await loadBusiness(ctx)
  const s = notifySettings(biz.config)
  if (!opts.force && !(kind === 'lr_booked' ? s.notify_lr_booked : s.notify_lr_delivered)) return null
  const lr = await loadLr(ctx, lrId)
  const name = biz.header.name

  const message = kind === 'lr_booked'
    ? [`*${name}*`, `LR ${lr.lrNo} booked on ${fmt(lr.lrDate)}`, `${lr.fromCity} → ${lr.toCity}`, `Goods: ${lr.goodsDescription}`,
       lr.vehicleNo ? `Vehicle: ${lr.vehicleNo}` : null,
       `Freight: ${inr(lr.totalAmount)} (${({ paid: 'Paid', to_pay: 'To pay', tbb: 'To be billed' } as Record<string, string>)[lr.freightType] ?? lr.freightType})`,
       'LR copy attached.'].filter(Boolean).join('\n')
    : [`*${name}*`, `LR ${lr.lrNo} has been delivered at ${lr.toCity}${lr.deliveredAt ? ` on ${fmt(lr.deliveredAt)}` : ''}.`,
       lr.receivedBy ? `Received by: ${lr.receivedBy}` : null,
       lr.damageNotes ? `Remarks: ${lr.damageNotes}` : null,
       'Thank you for choosing us.'].filter(Boolean).join('\n')

  return sendMessage(ctx, {
    kind, toPhone: opts.toPhone ?? lr.consignorPhone, recipientName: lr.consignorName, message,
    refType: 'lr', refId: lrId,
    attachment: kind === 'lr_booked' ? { spec: 'lr_pdf', id: lrId } : null,
    dedupeKey: opts.force ? null : `${kind}:${lrId}`,
  })
}

export async function notifyBill(ctx: Ctx, invoiceId: string, opts: { force?: boolean; toPhone?: string } = {}): Promise<SendResult | null> {
  const biz = await loadBusiness(ctx)
  if (!opts.force && !notifySettings(biz.config).notify_bill_created) return null
  const { data, invoice } = await loadBill(ctx, invoiceId)
  const net = data.grandTotal - data.tdsAmount
  const message = [
    `*${biz.header.name}*`, `Freight bill ${data.number} dated ${fmt(data.date)}`,
    `${data.lines.length} LR${data.lines.length === 1 ? '' : 's'} · Total ${inr(data.grandTotal)}${data.tdsAmount > 0 ? ` · Net of TDS ${inr(net)}` : ''}`,
    data.dueDate ? `Due: ${fmt(data.dueDate)}` : null,
    'Bill PDF attached. Kindly arrange payment.',
  ].filter(Boolean).join('\n')
  return sendMessage(ctx, {
    kind: 'bill_created', toPhone: opts.toPhone ?? invoice.partyPhone, recipientName: data.partyName, message,
    refType: 'bill', refId: invoiceId, attachment: { spec: 'bill_pdf', id: invoiceId },
    dedupeKey: opts.force ? null : `bill_created:${invoiceId}`,
  })
}

/**
 * Daily job body for one business: overdue-bill reminders to customers + a digest to the owner.
 * Dedupe keys make it safe to run more than once a day.
 */
export async function runDailyAlerts(ctx: Ctx): Promise<{ reminders: number; ownerAlerts: number }> {
  const biz = await loadBusiness(ctx)
  const s = notifySettings(biz.config)
  const today = todayStr()
  let reminders = 0, ownerAlerts = 0

  if (s.notify_bill_reminders) {
    const due = await q<any>(ctx,
      `SELECT i.id, i.number, i."dueDate", i."grandTotal"::float AS "grandTotal", i."paidAmt"::float AS "paidAmt",
              p.name AS "partyName", p.phone AS "partyPhone",
              ($2::date - i."dueDate")::int AS "daysOverdue"
       FROM ${tbl(ctx.schemaName, 'invoices')} i
       JOIN ${tbl(ctx.schemaName, 'parties')} p ON p.id = i."partyId"
       WHERE i."branchId" = $1::uuid AND i."txnType" = 'sale_invoice'
         AND i.status NOT IN ('cancelled','draft','paid')
         AND i."dueDate" IS NOT NULL AND i."dueDate" < $2::date
         AND i."grandTotal" - i."paidAmt" > 0.5
         AND EXISTS (SELECT 1 FROM ${tbl(ctx.schemaName, 'transport_lorry_receipts')} lr WHERE lr."invoiceId" = i.id)`,
      ctx.branchId, today)
    for (const b of due) {
      // One reminder every N days per bill: the bucket number is the dedupe key.
      const bucket = Math.floor(b.daysOverdue / s.notify_reminder_every_days)
      const outstanding = b.grandTotal - b.paidAmt
      const r = await sendMessage(ctx, {
        kind: 'bill_reminder', toPhone: b.partyPhone, recipientName: b.partyName,
        message: [`*${biz.header.name}*`, `Payment reminder: freight bill ${b.number} — ${inr(outstanding)} outstanding, overdue by ${b.daysOverdue} day${b.daysOverdue === 1 ? '' : 's'}.`,
                  'Please arrange payment at the earliest. Ignore if already paid.'].join('\n'),
        refType: 'bill', refId: b.id, dedupeKey: `bill_reminder:${b.id}:${bucket}`,
      })
      if (r.status === 'queued') reminders++
    }
  }

  if (s.notify_owner_alerts) {
    const ownerPhone = s.notify_owner_phone ?? biz.header.phone
    const lines: string[] = []

    const docs = await q<any>(ctx,
      `SELECT "regNo", doc, expiry FROM (
         SELECT "regNo", 'Fitness' AS doc, "fitnessExpiry" AS expiry FROM ${tbl(ctx.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND status != 'inactive'
         UNION ALL SELECT "regNo", 'Permit', "permitExpiry" FROM ${tbl(ctx.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND status != 'inactive'
         UNION ALL SELECT "regNo", 'Insurance', "insuranceExpiry" FROM ${tbl(ctx.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND status != 'inactive'
         UNION ALL SELECT "regNo", 'PUC', "pucExpiry" FROM ${tbl(ctx.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND status != 'inactive'
         UNION ALL SELECT "regNo", 'Road tax', "roadTaxExpiry" FROM ${tbl(ctx.schemaName, 'transport_vehicles')} WHERE "branchId" = $1::uuid AND status != 'inactive'
       ) x WHERE expiry IS NOT NULL AND expiry <= ($2::date + 15) ORDER BY expiry`, ctx.branchId, today)
    for (const d of docs) {
      const days = Math.round((new Date(d.expiry).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)
      lines.push(`• ${d.regNo} ${d.doc}: ${days < 0 ? `EXPIRED ${-days}d ago` : days === 0 ? 'expires today' : `expires in ${days}d`}`)
    }
    const eway = await q<any>(ctx,
      `SELECT "lrNo", "vehicleNo", "ewayBillNo", "ewayValidUpto" FROM ${tbl(ctx.schemaName, 'transport_lorry_receipts')}
       WHERE "branchId" = $1::uuid AND status IN ('booked','in_transit') AND "ewayValidUpto" IS NOT NULL
         AND "ewayValidUpto" <= NOW() + INTERVAL '24 hours' ORDER BY "ewayValidUpto"`, ctx.branchId)
    for (const e of eway) lines.push(`• E-way ${e.ewayBillNo} (LR ${e.lrNo}${e.vehicleNo ? `, ${e.vehicleNo}` : ''}) lapses ${fmt(e.ewayValidUpto)}`)

    if (lines.length) {
      const r = await sendMessage(ctx, {
        kind: 'compliance_expiry', toPhone: ownerPhone, recipientName: 'Owner',
        message: [`*${biz.header.name} — daily alerts*`, ...lines.slice(0, 25), lines.length > 25 ? `…and ${lines.length - 25} more` : null].filter(Boolean).join('\n'),
        dedupeKey: `owner_alerts:${today}`,
      })
      if (r.status === 'queued') ownerAlerts = lines.length
    }
  }
  return { reminders, ownerAlerts }
}
