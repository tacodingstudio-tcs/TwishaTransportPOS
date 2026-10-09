// apps/api/src/lib/__tests__/refreshToken.test.ts
//
// Exercises the refresh token rotation and reuse-detection logic against
// a real Postgres connection (via db from @billing/db) — the unique
// constraint and row-state transitions being tested ARE the database
// behavior, mocking them would test nothing meaningful.
//
// Requires: docker compose up, migrations applied including refresh-tokens.sql

import { db } from '@billing/db'
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../refreshToken.service.js'

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001'
const TEST_USER_ID   = '00000000-0000-0000-0000-000000000003'
const TEST_BRANCH_ID = '00000000-0000-0000-0000-000000000002'

const payload = {
  tenantId: TEST_TENANT_ID, userId: TEST_USER_ID, branchId: TEST_BRANCH_ID, role: 'cashier',
}

beforeEach(async () => {
  await db.$executeRaw`SELECT set_config('app.tenant_id', ${TEST_TENANT_ID}, true)`
})

describe('issueRefreshToken', () => {
  test('returns a non-empty raw token string', async () => {
    const token = await issueRefreshToken(payload)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(40)  // base64url of 48 bytes is ~64 chars
  })

  test('issuing twice produces different tokens (random, not deterministic)', async () => {
    const t1 = await issueRefreshToken(payload)
    const t2 = await issueRefreshToken(payload)
    expect(t1).not.toBe(t2)
  })
})

describe('rotateRefreshToken', () => {
  test('a freshly issued token rotates successfully and returns a new token', async () => {
    const original = await issueRefreshToken(payload)
    const result = await rotateRefreshToken(original)

    expect(result).not.toBeNull()
    expect(result!.payload.userId).toBe(TEST_USER_ID)
    expect(result!.newRefreshToken).not.toBe(original)
  })

  test('the OLD token cannot be used again after rotation (single use)', async () => {
    const original = await issueRefreshToken(payload)
    await rotateRefreshToken(original)  // first use — rotates successfully

    const secondAttempt = await rotateRefreshToken(original)  // reuse the SAME old token
    expect(secondAttempt).toBeNull()
  })

  test('reusing a rotated token revokes ALL of that users active tokens (reuse detection)', async () => {
    // Simulate: user has two active sessions (e.g. phone + tablet)
    const sessionA = await issueRefreshToken(payload)
    const sessionB = await issueRefreshToken(payload)

    // Session A rotates normally (legitimate use)
    const rotatedA = await rotateRefreshToken(sessionA)
    expect(rotatedA).not.toBeNull()

    // An attacker who stole the ORIGINAL sessionA token (before rotation)
    // tries to use it now — it's already revoked (rotated), triggering
    // reuse detection, which should revoke session B too as a safety measure.
    const attackerAttempt = await rotateRefreshToken(sessionA)
    expect(attackerAttempt).toBeNull()

    // Session B (the user's OTHER legitimate, still-active session) should
    // now ALSO be revoked, because the system cannot distinguish "this is
    // an attacker" from "this is the legitimate user's race condition" —
    // the safe response is to invalidate everything and force re-login.
    const sessionBAttempt = await rotateRefreshToken(sessionB)
    expect(sessionBAttempt).toBeNull()
  })

  test('an unknown/garbage token returns null without throwing', async () => {
    await expect(rotateRefreshToken('this-token-was-never-issued')).resolves.toBeNull()
  })

  test('rotated token preserves the original branchId', async () => {
    const original = await issueRefreshToken(payload)
    const result = await rotateRefreshToken(original)
    expect(result!.payload.branchId).toBe(TEST_BRANCH_ID)
  })
})

describe('revokeRefreshToken', () => {
  test('a revoked token cannot subsequently be rotated', async () => {
    const token = await issueRefreshToken(payload)
    await revokeRefreshToken(token)

    const result = await rotateRefreshToken(token)
    expect(result).toBeNull()
  })

  test('revoking an already-revoked token does not throw', async () => {
    const token = await issueRefreshToken(payload)
    await revokeRefreshToken(token)
    await expect(revokeRefreshToken(token)).resolves.not.toThrow()
  })
})

describe('revokeAllUserTokens', () => {
  test('revokes every active token for a user, leaving none usable', async () => {
    const tokenA = await issueRefreshToken(payload)
    const tokenB = await issueRefreshToken(payload)
    const tokenC = await issueRefreshToken(payload)

    await revokeAllUserTokens(TEST_TENANT_ID, TEST_USER_ID)

    expect(await rotateRefreshToken(tokenA)).toBeNull()
    expect(await rotateRefreshToken(tokenB)).toBeNull()
    expect(await rotateRefreshToken(tokenC)).toBeNull()
  })
})
