// apps/api/src/lib/refreshToken.service.ts
//
// Refresh token issuance, verification, and rotation.
//
// THE PATTERN:
//   Access token  (JWT, signed, 15 min)  — sent on every API request,
//                                          verified statelessly, never
//                                          touches the database.
//   Refresh token (random string, 30d)   — sent ONLY to /auth/refresh,
//                                          looked up in the database,
//                                          rotated (old one invalidated,
//                                          new one issued) on every use.
//
// WHY ROTATE ON EVERY USE (not just on expiry):
//   If an attacker steals a refresh token (e.g. from a compromised phone's
//   storage) and the legitimate user later refreshes normally, ONE of two
//   things happens: whichever party refreshes FIRST gets a new valid
//   token and invalidates the old one. The other party's next refresh
//   attempt fails immediately — at which point your app can detect
//   "a revoked token was reused" and force a full re-login + alert,
//   rather than silently allowing two parties to share one session
//   indefinitely (which is what a non-rotating refresh token allows).

import crypto from 'crypto'
import { db } from '@billing/db'

const REFRESH_TOKEN_BYTES = 48          // 384 bits of entropy — generous, cheap
const REFRESH_TOKEN_TTL_DAYS = 30

export interface RefreshTokenPayload {
  tenantId:   string
  schemaName: string
  userId:     string
  branchId:   string
  role:       string
}

function generateRawToken(): string {
  return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
}

function hashToken(rawToken: string): string {
  // SHA-256 is fine here (unlike PIN hashing) — refresh tokens have ~384
  // bits of entropy from crypto.randomBytes, making brute-force attacks
  // on the hash computationally infeasible regardless of hash speed.
  // bcrypt's slowness exists to defend LOW-entropy secrets (4-digit PINs);
  // a 384-bit random token doesn't need that property.
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

// =============================================================================
// issueRefreshToken
// Called on login and on every successful refresh (rotation).
// =============================================================================
export async function issueRefreshToken(
  payload: RefreshTokenPayload,
  deviceInfo?: string
): Promise<string> {
  const rawToken = generateRawToken()
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  const payloadJson = JSON.stringify({ branchId: payload.branchId, role: payload.role })

  await db.$executeRaw`
    INSERT INTO refresh_tokens
      (token_hash, tenant_id, schema_name, user_id, payload, user_agent, expires_at)
    VALUES (
      ${tokenHash}, ${payload.tenantId}::uuid, ${payload.schemaName},
      ${payload.userId}::uuid, ${payloadJson}::jsonb,
      ${deviceInfo ?? null}, ${expiresAt}
    )
  `

  // The RAW token is what's returned to the client and stored on-device.
  // Only the HASH is ever stored server-side — even a full database leak
  // does not expose usable refresh tokens, same principle as password hashing.
  return rawToken
}

// =============================================================================
// rotateRefreshToken
//
// Verifies a presented refresh token, and if valid:
//   1. Marks it revoked (reason: 'rotated')
//   2. Issues a brand new refresh token
//   3. Returns both the new refresh token and the payload needed to sign
//      a new access token JWT
//
// Returns null if the token is invalid, expired, or already revoked —
// the caller (routes/auth.ts) is responsible for treating null as "force
// the user to log in again."
// =============================================================================
export async function rotateRefreshToken(
  rawToken:   string,
  deviceInfo?: string
): Promise<{ payload: RefreshTokenPayload; newRefreshToken: string } | null> {
  const tokenHash = hashToken(rawToken)

  // Atomic revocation: UPDATE + RETURNING in one statement.
  // Two concurrent refresh requests with the same token both hit this UPDATE.
  // PostgreSQL ensures only ONE of them updates the row (the one that gets
  // the write lock first). The other sees 0 rows returned and falls through
  // to the reuse-detection SELECT below — triggering a full session wipe.
  const claimed = await db.$queryRaw<Array<{
    tenant_id:  string
    schema_name: string
    user_id:    string
    payload:    { branchId: string; role: string }
    expires_at: Date
  }>>`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE token_hash  = ${tokenHash}
      AND revoked     = false
      AND expires_at  > NOW()
    RETURNING tenant_id::text, schema_name, user_id::text, payload, expires_at
  `

  if (claimed.length === 0) {
    // Either: token doesn't exist, already expired, or already revoked.
    // Check which case — revoked = reuse detection.
    const existing = await db.$queryRaw<Array<{ revoked: boolean }>>`
      SELECT revoked FROM refresh_tokens WHERE token_hash = ${tokenHash}
    `

    if (existing.length > 0 && existing[0]!.revoked) {
      // ── TOKEN REUSE DETECTED ────────────────────────────────────────────
      // A revoked token being presented means either a double-fire (harmless)
      // or a replay attack. The safe response is to revoke ALL of this user's
      // active sessions — forcing everyone (attacker and victim) to re-login.
      const meta = await db.$queryRaw<Array<{ tenant_id: string; user_id: string }>>`
        SELECT tenant_id::text, user_id::text FROM refresh_tokens WHERE token_hash = ${tokenHash}
      `
      if (meta[0]) {
        await db.$executeRaw`
          UPDATE refresh_tokens
          SET revoked = true
          WHERE tenant_id = ${meta[0].tenant_id}::uuid
            AND user_id   = ${meta[0].user_id}::uuid
            AND revoked   = false
        `
      }
    }
    // Token not found, expired, or reuse — all result in forced re-login.
    return null
  }

  const record = claimed[0]!

  // Fetch current role from tenant schema — role may have changed since token
  // was issued (e.g. demoted from manager → cashier). New access token always
  // reflects the CURRENT role, not the one stored in the refresh token payload.
  const { getTenantDb } = await import('./tenant-db.js')
  const tenantDb = getTenantDb(record.schema_name)
  const user = await tenantDb.user.findUnique({
    where:  { id: record.user_id },
    select: { role: true, isActive: true },
  })

  if (!user || !user.isActive) {
    // User deactivated since this token was issued — token is already revoked
    // by the UPDATE above; just reject without issuing a new one.
    return null
  }

  const newPayload: RefreshTokenPayload = {
    tenantId:   record.tenant_id,
    schemaName: record.schema_name,
    userId:     record.user_id,
    branchId:   record.payload.branchId,
    role:       user.role,
  }

  const newRefreshToken = await issueRefreshToken(newPayload, deviceInfo)
  return { payload: newPayload, newRefreshToken }
}

// =============================================================================
// revokeRefreshToken — used by /auth/logout
// =============================================================================
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken)
  await db.$executeRaw`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE token_hash = ${tokenHash} AND revoked = false
  `
}

// =============================================================================
// revokeAllUserTokens — used for "log out all devices" / security incidents
// =============================================================================
export async function revokeAllUserTokens(tenantId: string, userId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE refresh_tokens
    SET revoked = true
    WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid AND revoked = false
  `
}
