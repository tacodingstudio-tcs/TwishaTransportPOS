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
import fs from 'fs/promises'

const WABA_TOKEN    = process.env['WHATSAPP_TOKEN']
const WABA_PHONE_ID = process.env['WHATSAPP_PHONE_NUMBER_ID']
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

type WhatsAppJob = InvoiceShareJob | PaymentReminderJob

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

// ── Worker ────────────────────────────────────────────────────────────────────

const worker = new Worker<WhatsAppJob>(
  'whatsapp-send',
  async (job: Job<WhatsAppJob>) => {
    const data = job.data

    if (data.type === 'invoice_share') {
      await handleInvoiceShare(data)
    } else if (data.type === 'payment_reminder') {
      await handlePaymentReminder(data)
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
})

console.log('[WhatsApp Worker] Started — listening for whatsapp-send queue')

process.on('SIGTERM', async () => {
  await worker.close()
  await redis.quit()
  process.exit(0)
})
