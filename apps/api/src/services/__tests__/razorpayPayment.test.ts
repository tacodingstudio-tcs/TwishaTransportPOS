// apps/api/src/services/__tests__/razorpayPayment.test.ts
//
// Tests focus on the signature verification logic — this is the actual
// security boundary of the entire webhook system. Everything else
// (createPaymentLink, handleWebhook business logic) requires a live
// Postgres + Razorpay test account and is exercised via billing.http
// manual testing instead.

import crypto from 'crypto'
import { verifyWebhookSignature } from '../razorpayPayment.service.js'

function computeSignature(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyWebhookSignature', () => {
  const secret = 'test_webhook_secret_12345'
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_test123', order_id: 'order_test123', amount: 38600, status: 'captured' } } },
  })

  test('valid signature passes verification', () => {
    const signature = computeSignature(body, secret)
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
  })

  test('signature computed with the WRONG secret fails verification', () => {
    const wrongSignature = computeSignature(body, 'a_completely_different_secret')
    expect(verifyWebhookSignature(body, wrongSignature, secret)).toBe(false)
  })

  test('signature for DIFFERENT body content fails verification', () => {
    const signature = computeSignature(body, secret)
    const tamperedBody = body.replace('38600', '1')  // attacker tries to reduce amount
    expect(verifyWebhookSignature(tamperedBody, signature, secret)).toBe(false)
  })

  test('a single-character difference in the body invalidates the signature', () => {
    const signature = computeSignature(body, secret)
    const almostSameBody = body + ' '  // trailing whitespace — even this breaks it
    expect(verifyWebhookSignature(almostSameBody, signature, secret)).toBe(false)
  })

  test('malformed hex signature does not crash, returns false', () => {
    expect(verifyWebhookSignature(body, 'not-valid-hex-at-all!!', secret)).toBe(false)
  })

  test('empty signature string fails cleanly', () => {
    expect(verifyWebhookSignature(body, '', secret)).toBe(false)
  })

  test('signature of different LENGTH than expected fails without throwing', () => {
    // Tests the length-check branch in verifyWebhookSignature before
    // timingSafeEqual is called (which throws on mismatched buffer lengths
    // if not guarded)
    const shortSignature = 'abc123'
    expect(() => verifyWebhookSignature(body, shortSignature, secret)).not.toThrow()
    expect(verifyWebhookSignature(body, shortSignature, secret)).toBe(false)
  })

  test('replaying a captured valid signature against a different payload fails', () => {
    // Simulates an attacker who saw one legitimate webhook (and its valid
    // signature) trying to reuse that signature to forge a DIFFERENT
    // payment event — e.g. a higher amount, or a different order_id.
    const legitSignature = computeSignature(body, secret)
    const forgedBody = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_FORGED', order_id: 'order_DIFFERENT', amount: 999999900, status: 'captured' } } },
    })
    expect(verifyWebhookSignature(forgedBody, legitSignature, secret)).toBe(false)
  })
})
