// apps/api/src/lib/razorpay.ts
//
// Singleton Razorpay SDK client. Reads test/live keys from environment —
// the SAME code path works in development (rzp_test_... keys, no real
// money moves) and production (rzp_live_... keys) with zero code changes,
// only an env var swap.

import Razorpay from 'razorpay'

const keyId     = process.env['RAZORPAY_KEY_ID']
const keySecret = process.env['RAZORPAY_KEY_SECRET']

if (!keyId || !keySecret) {
  console.warn(
    '[Razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — ' +
    'payment link generation will fail until these are configured in .env'
  )
}

let _razorpay: Razorpay | null = null

export function getRazorpay(): Razorpay {
  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env')
  }
  if (!_razorpay) {
    _razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret })
  }
  return _razorpay
}

// Keep backward-compatible export for any code that references razorpay directly
export const razorpay = new Proxy({} as Razorpay, {
  get(_target, prop) {
    return getRazorpay()[prop as keyof Razorpay]
  },
})

export function isRazorpayConfigured(): boolean {
  return !!(keyId && keySecret)
}
