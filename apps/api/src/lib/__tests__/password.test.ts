// apps/api/src/lib/__tests__/password.test.ts

import { hashPin, verifyPin } from '../password.js'

describe('hashPin / verifyPin', () => {
  test('hashing the same PIN twice produces different hashes (salted)', async () => {
    const hash1 = await hashPin('1234')
    const hash2 = await hashPin('1234')
    // bcrypt generates a random salt per call — hashes must differ
    // even for identical input. This is what makes rainbow-table
    // attacks against a leaked database ineffective.
    expect(hash1).not.toBe(hash2)
  })

  test('verifyPin returns true for the correct PIN', async () => {
    const hash = await hashPin('5678')
    expect(await verifyPin('5678', hash)).toBe(true)
  })

  test('verifyPin returns false for an incorrect PIN', async () => {
    const hash = await hashPin('5678')
    expect(await verifyPin('0000', hash)).toBe(false)
  })

  test('verifyPin returns false for a PIN that differs by one digit', async () => {
    const hash = await hashPin('1234')
    expect(await verifyPin('1235', hash)).toBe(false)
  })

  test('hash output is a bcrypt-format string, not a raw SHA-256 hex digest', async () => {
    const hash = await hashPin('1111')
    // bcrypt hashes always start with $2a$, $2b$, or $2y$ followed by cost factor
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/)
    // A SHA-256 hex digest would be exactly 64 lowercase hex chars with no $ —
    // confirm we are NOT producing that format anymore
    expect(hash).not.toMatch(/^[a-f0-9]{64}$/)
  })

  test('verifyPin against a malformed hash does not throw, returns false', async () => {
    // Defends the login route's dummy-hash timing-safety trick: even if
    // somehow passed garbage, this must fail closed, not crash the request
    await expect(verifyPin('1234', 'not-a-real-hash')).resolves.toBe(false)
  })
})
