// apps/api/src/routes/webhooks.ts
//
// PUBLIC routes — no JWT, no tenantMiddleware. Razorpay's servers call
// these directly and cannot supply a user's auth token. Trust is
// established entirely through HMAC signature verification instead.
//
// CRITICAL: this route needs the RAW, unparsed request body to verify
// the signature correctly — Fastify's default JSON body parser would
// re-serialize the payload, and even a single whitespace difference
// between Razorpay's original bytes and our re-serialized JSON would
// make the HMAC comparison fail. See the addContentTypeParser override
// below.

import type { FastifyPluginAsync } from 'fastify'
import { verifyWebhookSignature, handleWebhook } from '../services/razorpayPayment.service.js'

export const webhookRoutes: FastifyPluginAsync = async (app) => {

  // Override the JSON body parser for this route only, to capture the
  // raw request body string BEFORE Fastify parses it into an object.
  // We still parse it ourselves afterward — we just need both the raw
  // string (for signature verification) and the parsed object (for logic).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const json = JSON.parse(body as string)
        // Stash the raw string alongside the parsed body for the handler below
        done(null, { raw: body as string, parsed: json })
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  // ── POST /api/webhooks/razorpay ───────────────────────────────────────────
  app.post('/razorpay', async (req, reply) => {
    const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET']

    if (!webhookSecret) {
      req.log.error('[Webhook] RAZORPAY_WEBHOOK_SECRET not configured — rejecting all webhooks')
      return reply.status(503).send({ error: 'Webhook not configured' })
    }

    const signature = req.headers['x-razorpay-signature'] as string | undefined
    if (!signature) {
      return reply.status(400).send({ error: 'Missing signature header' })
    }

    const { raw, parsed } = req.body as { raw: string; parsed: unknown }

    const isValid = verifyWebhookSignature(raw, signature, webhookSecret)
    if (!isValid) {
      // Log this — a failed signature check on a webhook endpoint is either
      // a misconfigured secret or someone probing your endpoint. Either way
      // worth knowing about, but never reveal WHY verification failed in
      // the response (don't leak whether the secret or payload was the issue).
      req.log.warn('[Webhook] Razorpay signature verification FAILED — request rejected')
      return reply.status(401).send({ error: 'Invalid signature' })
    }

    // Signature verified — safe to process.
    const result = await handleWebhook(parsed)

    req.log.info({ result }, '[Webhook] Razorpay event processed')

    // Always return 200 once we've successfully RECEIVED and verified the
    // webhook, even if our internal logic decided not to act on this
    // particular event (e.g. it's a payment.failed, or a duplicate retry).
    // Returning anything other than 2xx makes Razorpay retry the webhook
    // repeatedly, which is only useful for transient failures, not for
    // "this event type doesn't need action."
    return reply.status(200).send({ received: true })
  })
}
