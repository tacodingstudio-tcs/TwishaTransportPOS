// apps/api/src/workers/whatsapp.worker.ts
// Processes WhatsApp send jobs from the 'whatsapp-send' BullMQ queue.
//
// Two job types:
//   invoice_share   → sends PDF as WhatsApp document + invoice summary
//   payment_reminder → sends AI-drafted reminder text for overdue invoices
//
// WhatsApp Business API (WABA) requires:
//   1. Approved Meta Business Account
//   2. Phone number registered as WABA sender
//   3. Message templates approved by Meta (for outbound messages to non-contacts)
//
// Apply at: https://business.facebook.com (takes 2–4 weeks for approval)
// In development: log messages to console instead of actually sending

import { Worker, type Job } from 'bullmq'
import { redis } from '../lib/redis.js'
import { getTenantDb } from '../lib/tenant-db.js'
import { tbl } from '../lib/transport-helpers.js'

const WABA_TOKEN    = (process.env['WHATSAPP_TOKEN'] ?? '').startsWith('replace_with') ? undefined : process.env['WHATSAPP_TOKEN']
const WABA_PHONE_ID = (process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? '').startsWith('replace_with') ? undefined : process.env['WHATSAPP_PHONE_NUMBER_ID']
const IS_DEV        = process.env['NODE_ENV'] !== 'production'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceShareJob {
  type:       'invoice_share'
  invoiceId:  string
  tenantId:   string
  toPhone:    string          // E.164 format: "919876543210"
  partyName:  string
  invoiceNo:  string
  amount:     number
  businessName: string
}

interface PaymentReminderJob {
  type:       'payment_reminder'
  invoiceId:  string
  tenantId:   string
  toPhone:    string
  partyName:  string
  amount:     number
  daysOverdue:number
  draftMessage:string        // pre-drafted by AI, approved by owner
}

/** Transport module message: text, optionally with a PDF (base64) sent as a document. */
interface TransportMessageJob {
  type:           'transport_message'
  notificationId: string
  schemaName:     string
  toPhone:        string
  message:        string
  document?:      { base64: string; filename: string }
}

type WhatsAppJob = InvoiceShareJob | PaymentReminderJob | TransportMessageJob

// ── WABA API caller ───────────────────────────────────────────────────────────

async function sendWhatsAppText(toPhone: string, message: string): Promise<void> {
  if (IS_DEV || !WABA_TOKEN || !WABA_PHONE_ID) {
    // Development: log instead of sending
    console.log(`[WhatsApp DEV] To: ${toPhone}`)
    console.log(`[WhatsApp DEV] Message: ${message}`)
    return
  }

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${WABA_PHONE_ID}/messages`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${WABA_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:      toPhone,
        type:    'text',
        text:    { body: message },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error: ${res.status} ${err}`)
  }
}

async function sendWhatsAppDocument(
  toPhone:  string,
  pdfPath:  string,
  filename: string,
  caption:  string
): Promise<void> {
  if (IS_DEV || !WABA_TOKEN || !WABA_PHONE_ID) {
    console.log(`[WhatsApp DEV] Document to: ${toPhone}, file: ${filename}`)
    console.log(`[WhatsApp DEV] Caption: ${caption}`)
    return
  }

  // In production: first upload the PDF to WhatsApp media API,
  // then send as document message.
  // For now we send a text message with a download link.
  // TODO: implement media upload when going to production.
  await sendWhatsAppText(toPhone, `${caption}\n\nPDF: [Download link — add your file server URL here]`)
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function handleInvoiceShare(job: InvoiceShareJob): Promise<void> {
  // Get PDF path from Redis (set by PDF worker after generation)
  const pdfMeta = await redis.get(`pdf:${job.invoiceId}`)

  const caption = `*${job.businessName}*\n` +
    `Invoice No: ${job.invoiceNo}\n` +
    `Amount: ₹${job.amount.toFixed(0)}\n\n` +
    `Dear ${job.partyName}, please find your invoice attached. 🙏`

  if (pdfMeta) {
    const { a4Path } = JSON.parse(pdfMeta) as { a4Path: string }
    await sendWhatsAppDocument(
      job.toPhone,
      a4Path,
      `${job.invoiceNo}.pdf`,
      caption
    )
  } else {
    // PDF not ready yet — send text summary instead
    await sendWhatsAppText(job.toPhone, caption)
  }
}

async function handlePaymentReminder(job: PaymentReminderJob): Promise<void> {
  // The draftMessage was pre-approved by the business owner before this job was queued
  await sendWhatsAppText(job.toPhone, job.draftMessage)
}

// ── Transport messages (real Cloud-API delivery + delivery log) ──────────────────
//
// Free-form text/documents can only be delivered inside WhatsApp's 24-hour customer-service window.
// To message a customer who has not written to the business recently, Meta requires an approved
// template: set WHATSAPP_TEMPLATE_NAME (one body variable {{1}} = the message, newlines folded) and,
// if the template has a document header, WHATSAPP_TEMPLATE_DOC_HEADER=true.

const WABA_TEMPLATE      = process.env['WHATSAPP_TEMPLATE_NAME']
const WABA_TEMPLATE_LANG = process.env['WHATSAPP_TEMPLATE_LANG'] ?? 'en'
const WABA_TEMPLATE_DOC  = process.env['WHATSAPP_TEMPLATE_DOC_HEADER'] === 'true'
const GRAPH = 'https://graph.facebook.com/v19.0'

async function graph(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${WABA_TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* keep raw text */ }
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${typeof body === 'string' ? body : (body?.error?.message ?? text)}`)
  return body
}

async function uploadMedia(base64: string, filename: string): Promise<string> {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'application/pdf')
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: 'application/pdf' }), filename)
  const out = await graph(`${WABA_PHONE_ID}/media`, { method: 'POST', body: form })
  if (!out?.id) throw new Error('WhatsApp media upload returned no id')
  return out.id as string
}

async function sendTransportMessage(job: TransportMessageJob): Promise<string> {
  let payload: Record<string, unknown>
  const mediaId = job.document ? await uploadMedia(job.document.base64, job.document.filename) : null

  if (WABA_TEMPLATE) {
    const components: unknown[] = []
    if (mediaId && WABA_TEMPLATE_DOC) {
      components.push({ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: job.document!.filename } }] })
    }
    components.push({ type: 'body', parameters: [{ type: 'text', text: job.message.replace(/\s*\n+\s*/g, ' | ').slice(0, 1000) }] })
    payload = {
      messaging_product: 'whatsapp', to: job.toPhone, type: 'template',
      template: { name: WABA_TEMPLATE, language: { code: WABA_TEMPLATE_LANG }, components },
    }
  } else if (mediaId) {
    payload = {
      messaging_product: 'whatsapp', to: job.toPhone, type: 'document',
      document: { id: mediaId, filename: job.document!.filename, caption: job.message.slice(0, 1000) },
    }
  } else {
    payload = { messaging_product: 'whatsapp', to: job.toPhone, type: 'text', text: { body: job.message.slice(0, 4000) } }
  }

  const out = await graph(`${WABA_PHONE_ID}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  return String(out?.messages?.[0]?.id ?? '')
}

async function markNotification(schemaName: string, id: string, status: 'sent' | 'failed' | 'queued' | 'skipped', error: string | null) {
  const db = getTenantDb(schemaName)
  await db.$executeRawUnsafe(
    `UPDATE ${tbl(schemaName, 'transport_notifications')}
     SET status = $2, error = $3, attempts = attempts + 1,
         "sentAt" = CASE WHEN $2 = 'sent' THEN NOW() ELSE "sentAt" END
     WHERE id = $1::uuid`, id, status, error)
}

async function handleTransportMessage(job: TransportMessageJob): Promise<void> {
  if (!WABA_TOKEN || !WABA_PHONE_ID) {
    // Not configured: say so in the log instead of pretending it was delivered.
    console.log(`[WhatsApp] (not configured) would send to ${job.toPhone}${job.document ? ` [${job.document.filename}]` : ''}:\n${job.message}`)
    await markNotification(job.schemaName, job.notificationId, 'skipped',
      'WhatsApp is not configured on the server (set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID)')
    return
  }
  await sendTransportMessage(job)
  await markNotification(job.schemaName, job.notificationId, 'sent', null)
}

// ── Worker ────────────────────────────────────────────────────────────────────

const worker = new Worker<WhatsAppJob>(
  'whatsapp-send',
  async (job: Job<WhatsAppJob>) => {
    const data = job.data

    if (data.type === 'invoice_share') {
      await handleInvoiceShare(data)
    } else if (data.type === 'payment_reminder') {
      await handlePaymentReminder(data)
    } else if (data.type === 'transport_message') {
      await handleTransportMessage(data)
    } else {
      throw new Error(`Unknown job type: ${(data as WhatsAppJob & { type: string }).type}`)
    }
  },
  {
    connection:  redis,
    concurrency: 5,   // WABA rate limit: ~80 messages/second, 5 is safe
    limiter: {
      max:      20,
      duration: 1000,  // max 20 messages per second
    },
  }
)

worker.on('completed', (job) => {
  console.log(`[WhatsApp Worker] Job ${job.id} (${job.data.type}) sent to ${(job.data as WhatsAppJob).toPhone}`)
})

worker.on('failed', (job, err) => {
  console.error(`[WhatsApp Worker] Job ${job?.id} failed:`, err.message)
  // Transport messages: surface the failure in the delivery log (final state once retries run out).
  const d = job?.data as TransportMessageJob | undefined
  if (d?.type === 'transport_message') {
    const final = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1)
    markNotification(d.schemaName, d.notificationId, final ? 'failed' : 'queued', err.message.slice(0, 500))
      .catch((e) => console.error('[WhatsApp Worker] could not update delivery log:', e.message))
  }
})

console.log('[WhatsApp Worker] Started — listening for whatsapp-send queue')

process.on('SIGTERM', async () => {
  await worker.close()
  await redis.quit()
  process.exit(0)
})
