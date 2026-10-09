// apps/api/src/services/razorpayPayment.service.ts
//
// Two responsibilities, kept deliberately separate:
//
//   1. createPaymentLink — cashier-initiated. Creates a Razorpay Payment
//      Link for an invoice's outstanding balance and returns a shareable
//      URL (sent via WhatsApp using the existing whatsapp.worker.ts).
//
//   2. handleWebhook — Razorpay-initiated. Called when the customer
//      actually completes payment. This is the ONLY place a Razorpay
//      payment becomes a real Payment row in your ledger — never trust
//      a client-side "payment succeeded" callback for money, only the
//      server-to-server webhook with a verified signature.
//
// SECURITY: webhook signature verification is non-negotiable. Without it,
// anyone who discovers your webhook URL could POST a fake "payment
// succeeded" event and mark any invoice as paid for free. Razorpay signs
// every webhook with HMAC-SHA256 using your webhook secret — verifying
// this signature is what proves the request actually came from Razorpay.

import crypto from 'crypto'
import { db } from '@billing/db'
import { razorpay, isRazorpayConfigured } from '../lib/razorpay.js'
import { recordPayment } from './invoice.service.js'
import { z } from 'zod'

interface RequestCtx {
  db:         import('@billing/db').PrismaClient
  schemaName: string
  branchId:   string
  userId:     string
  role:       string
}

// =============================================================================
// createPaymentLink
// =============================================================================
export async function createPaymentLink(invoiceId: string, ctx: RequestCtx) {
  if (!isRazorpayConfigured()) {
    throw Object.assign(
      new Error('Online payments are not configured for this server'),
      { statusCode: 503, code: 'RAZORPAY_NOT_CONFIGURED' }
    )
  }

  const invoice = await ctx.db.invoice.findFirst({
    where: { id: invoiceId, branchId: ctx.branchId },
    include: { party: { select: { name: true, phone: true } } },
  })

  if (!invoice) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 })
  if (invoice.status === 'cancelled') {
    throw Object.assign(new Error('Cannot create a payment link for a cancelled invoice'), { statusCode: 400 })
  }

  const balanceDue = Number(invoice.grandTotal) - Number(invoice.paidAmt)
  if (balanceDue <= 0) {
    throw Object.assign(new Error('This invoice is already fully paid'), { statusCode: 400 })
  }

  // Razorpay amounts are in paise (smallest currency unit), not rupees
  const amountInPaise = Math.round(balanceDue * 100)

  // Create the Razorpay order. This is a "draft" — no money has moved yet.
  const order = await razorpay.orders.create({
    amount:   amountInPaise,
    currency: 'INR',
    receipt:  `inv-${invoice.number}`,
    notes: {
      schemaName: ctx.schemaName,
      branchId:   ctx.branchId,
      invoiceId:  invoice.id,
      invoiceNumber: invoice.number,
    },
  })

  // Create a Payment Link (the customer-facing shareable URL) tied to this order.
  // Razorpay Payment Links are simpler for a WhatsApp-share workflow than
  // raw Orders + Checkout.js, since they don't require any frontend SDK —
  // just a URL the customer opens in their own browser/UPI app.
  const paymentLink = await razorpay.paymentLink.create({
    amount:   amountInPaise,
    currency: 'INR',
    accept_partial: false,
    description: `Payment for ${invoice.number}`,
    customer: {
      name:    invoice.party?.name ?? 'Customer',
      contact: invoice.party?.phone ?? undefined,
    },
    notify: { sms: false, email: false }, // we send via our own WhatsApp worker instead
    reference_id: invoice.number,
    notes: {
      schemaName: ctx.schemaName,
      invoiceId:  invoice.id,
    },
  })

  // Persist the order so the webhook handler can find it later by
  // razorpay_order_id and know which invoice/tenant it belongs to.
  await ctx.db.$executeRaw`
    INSERT INTO razorpay_orders
      (branch_id, invoice_id, razorpay_order_id, amount, status, short_url, created_by)
    VALUES (
      ${ctx.branchId}::uuid, ${invoice.id}::uuid,
      ${order.id}, ${balanceDue}, 'created', ${paymentLink.short_url}, ${ctx.userId}::uuid
    )
  `

  return {
    paymentLinkUrl: paymentLink.short_url,
    razorpayOrderId: order.id,
    amount: balanceDue,
    invoiceNumber: invoice.number,
  }
}

// =============================================================================
// verifyWebhookSignature
//
// Razorpay sends an X-Razorpay-Signature header containing an HMAC-SHA256
// hash of the raw request body, signed with your webhook secret. We
// recompute the same hash server-side and compare — if they don't match
// byte-for-byte, the request did not genuinely come from Razorpay and
// must be rejected before any business logic runs.
// =============================================================================
export function verifyWebhookSignature(
  rawBody:   string,
  signature: string,
  secret:    string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')

  // Timing-safe comparison — a naive `===` string comparison leaks timing
  // information about how many leading characters matched, which an
  // attacker could exploit to forge a valid signature byte-by-byte over
  // many requests. crypto.timingSafeEqual closes that side channel.
  const expectedBuffer = Buffer.from(expectedSignature, 'hex')
  const actualBuffer   = Buffer.from(signature, 'hex')

  if (expectedBuffer.length !== actualBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer)
}

// =============================================================================
// Webhook payload schema (only the fields we actually use)
// =============================================================================
const WebhookPayloadSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({
      entity: z.object({
        id:        z.string(),
        order_id:  z.string(),
        amount:    z.number(),
        status:    z.string(),
        method:    z.string().optional(),
      }),
    }).optional(),
  }),
})

// =============================================================================
// handleWebhook
//
// Called by routes/payments.ts for every incoming Razorpay webhook POST.
// Only acts on 'payment.captured' — that is Razorpay's confirmation that
// money has actually settled, not just that a checkout form was submitted
// (which can still fail, e.g. insufficient funds, bank decline).
// =============================================================================
export async function handleWebhook(payload: unknown): Promise<{ processed: boolean; reason?: string }> {
  const parsed = WebhookPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return { processed: false, reason: 'Unrecognized webhook payload shape' }
  }

  const { event, payload: webhookPayload } = parsed.data

  if (event !== 'payment.captured') {
    // We only act on captured payments. Other events (payment.failed,
    // order.paid, etc.) are logged but not acted upon — acting only on
    // payment.captured is what guarantees we never credit a payment that
    // didn't actually settle.
    return { processed: false, reason: `Ignored event type: ${event}` }
  }

  const paymentEntity = webhookPayload.payment?.entity
  if (!paymentEntity) {
    return { processed: false, reason: 'Missing payment entity in webhook payload' }
  }

  // Look up which invoice this Razorpay order belongs to
  const orders = await db.$queryRaw<Array<{
    id: string; branchId: string; invoiceId: string
    status: string; createdBy: string
  }>>`
    SELECT id::text, "branchId"::text, "invoiceId"::text, status, "createdBy"::text
    FROM razorpay_orders
    WHERE "razorpayOrderId" = ${paymentEntity.order_id}
  `

  if (orders.length === 0) {
    // This can legitimately happen if the order was created by a different
    // system, or is stale test data — log and move on rather than throwing,
    // since a thrown error would make Razorpay retry this webhook forever.
    return { processed: false, reason: `No matching order for ${paymentEntity.order_id}` }
  }

  const order = orders[0]!

  // Idempotency: if this order was already marked paid (e.g. Razorpay
  // retried the webhook because our 200 response was slow/lost), don't
  // record a second Payment row for the same money.
  if (order.status === 'paid') {
    return { processed: false, reason: 'Order already processed (webhook retry)' }
  }

  // Convert paise back to rupees for our internal Payment record
  const amountInRupees = paymentEntity.amount / 100

  await recordPayment(
    {
      invoiceId: order.invoiceId,
      amount:    amountInRupees,
      method:    'upi',
      refNo:     paymentEntity.id,
    },
    {
      db:         db as never,
      schemaName: `t_${order.branchId}`,
      branchId:   order.branchId,
      userId:     order.createdBy,
      role:       'system' as const,
    }
  )

  await db.$executeRaw`
    UPDATE razorpay_orders
    SET status = 'paid', "razorpayPaymentId" = ${paymentEntity.id}, "paidAt" = now()
    WHERE id = ${order.id}::uuid
  `

  return { processed: true }
}
