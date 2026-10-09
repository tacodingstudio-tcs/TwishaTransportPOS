import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { db } from '@billing/db'               // public-schema client (tenants table only)
import { getTenantDb, schemaFromSlug } from '../lib/tenant-db.js'
import { verifyPin } from '../lib/password.js'
import { redis } from '../lib/redis.js'
import { invalidateBranch } from '../lib/cache.js'
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
} from '../lib/refreshToken.service.js'

// =============================================================================
// Login schema — tenantPhone identifies the business (owner's registered phone)
//               phone is the staff member's own phone (same as tenantPhone for owner)
// =============================================================================
const LoginSchema = z.object({
  tenantPhone: z.string().min(10).max(13),  // identifies the tenant
  phone:       z.string().min(10).max(13),  // staff/owner phone within that tenant
  pin:         z.string().length(4),
})

const RefreshSchema = z.object({
  refreshToken: z.string().min(20),
})

const LogoutSchema = z.object({
  refreshToken: z.string().min(20),
})

// ── Login throttle ────────────────────────────────────────────────────────────
const MAX_ATTEMPTS    = 5
const LOCKOUT_SECONDS = 15 * 60

async function checkLoginThrottle(key: string) {
  const attempts = await redis.get(`login_attempts:${key}`)
  const count = attempts ? parseInt(attempts, 10) : 0
  if (count >= MAX_ATTEMPTS) {
    const ttl = await redis.ttl(`login_attempts:${key}`)
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : LOCKOUT_SECONDS }
  }
  return { allowed: true }
}
async function recordFailedAttempt(key: string) {
  const k = `login_attempts:${key}`
  const n = await redis.incr(k)
  if (n === 1) await redis.expire(k, LOCKOUT_SECONDS)
}
async function clearLoginAttempts(key: string) {
  await redis.del(`login_attempts:${key}`)
}

export const authRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/auth/login ────────────────────────────────────────────────
  // Two-step resolution:
  //   1. Find tenant in public.tenants by ownerPhone  → get schemaName
  //   2. Find user in that tenant's schema by phone   → verify PIN
  // This is required by per-schema multi-tenancy: we must know which schema
  // to search before we can authenticate the user.
  app.post('/login', async (req, reply) => {
    const { tenantPhone, phone, pin } = LoginSchema.parse(req.body)
    const throttleKey = `${tenantPhone}:${phone}`

    const throttle = await checkLoginThrottle(throttleKey)
    if (!throttle.allowed) {
      return reply.status(429).send({
        error: 'Too many failed attempts',
        message: `Account temporarily locked. Try again in ${Math.ceil((throttle.retryAfterSec ?? LOCKOUT_SECONDS) / 60)} minutes.`,
        retryAfterSec: throttle.retryAfterSec,
      })
    }

    // 1. Resolve tenant from public schema
    const tenant = await db.tenant.findFirst({
      where: { ownerPhone: tenantPhone, isActive: true },
    })

    const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8z5GfQ6F8K8m8QyD9X9q9X9q9X9q9X'

    if (!tenant) {
      await verifyPin(pin, DUMMY_HASH) // constant-time dummy check
      await recordFailedAttempt(throttleKey)
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    // 2. Resolve user from tenant schema
    const tenantDb = getTenantDb(tenant.schemaName)
    const user = await tenantDb.user.findFirst({
      where: { phone, isActive: true },
    })

    const pinValid = user
      ? await verifyPin(pin, user.pin ?? DUMMY_HASH)
      : await verifyPin(pin, DUMMY_HASH)

    if (!user || !pinValid) {
      await recordFailedAttempt(throttleKey)
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    await clearLoginAttempts(throttleKey)

    // Resolve active branchId
    let branchId = user.branchIds[0] ?? null
    if (!branchId) {
      const branch = await tenantDb.branch.findFirst({
        where: { isActive: true },
        select: { id: true },
      })
      branchId = branch?.id ?? null
    }
    if (!branchId) {
      return reply.status(400).send({ error: 'No active branch found for this tenant' })
    }

    const branch = await tenantDb.branch.findUnique({ where: { id: branchId } })

    const jwtPayload = {
      tenantId:   tenant.id,
      schemaName: tenant.schemaName,
      branchId,
      userId:     user.id,
      role:       user.role,
    }

    const accessToken  = await reply.jwtSign(jwtPayload)
    const refreshToken = await issueRefreshToken(jwtPayload, req.headers['user-agent'])

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: 15 * 60,
      user:   { id: user.id, name: user.name, phone: user.phone, role: user.role, lang: user.lang },
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan, schemaName: tenant.schemaName },
      branch: {
        id: branch?.id, name: branch?.name,
        domainType: branch?.domainType, domainConfig: branch?.domainConfig, stateCode: branch?.stateCode,
      },
    }
  })

  // ── POST /api/auth/refresh ──────────────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = RefreshSchema.parse(req.body)
    const result = await rotateRefreshToken(refreshToken, req.headers['user-agent'])

    if (!result) {
      return reply.status(401).send({
        error: 'Invalid or expired refresh token',
        message: 'Please log in again',
      })
    }

    const newAccessToken = await reply.jwtSign({
      tenantId:   result.payload.tenantId,
      schemaName: (result.payload as any).schemaName,
      branchId:   result.payload.branchId,
      userId:     result.payload.userId,
      role:       result.payload.role,
    })

    return {
      accessToken: newAccessToken,
      refreshToken: result.newRefreshToken,
      accessTokenExpiresIn: 15 * 60,
    }
  })

  // ── POST /api/auth/logout ───────────────────────────────────────────────
  app.post('/logout', async (req, reply) => {
    const { refreshToken } = LogoutSchema.parse(req.body)
    await revokeRefreshToken(refreshToken)
    return reply.status(200).send({ loggedOut: true })
  })

  // ── POST /api/auth/logout-all-devices ───────────────────────────────────
  app.post('/logout-all-devices', async (req, reply) => {
    const payload = await req.jwtVerify<{ tenantId: string; userId: string }>()
    await revokeAllUserTokens(payload.tenantId, payload.userId)
    return reply.status(200).send({ loggedOutAllDevices: true })
  })

  // ── GET /api/auth/branches — list branches available to the current user ──
  // The client calls this before showing the branch-picker screen so the user
  // knows which branches they can switch to without guessing IDs.
  app.get('/branches', async (req, reply) => {
    const payload = await req.jwtVerify<{
      tenantId: string; schemaName: string; userId: string; role: string; branchId: string
    }>()

    const tenantDb = getTenantDb(payload.schemaName)
    const user = await tenantDb.user.findUnique({
      where:  { id: payload.userId },
      select: { role: true, branchIds: true },
    })
    if (!user) return reply.status(404).send({ error: 'User not found' })

    const where = user.role === 'owner' || user.branchIds.length === 0
      ? { isActive: true }
      : { isActive: true, id: { in: user.branchIds } }

    const branches = await tenantDb.branch.findMany({
      where,
      select: { id: true, name: true, domainType: true, stateCode: true, gstin: true },
      orderBy: { createdAt: 'asc' },
    })

    return { branches, currentBranchId: payload.branchId }
  })

  // ── POST /api/auth/switch-branch ────────────────────────────────────────
  app.post('/switch-branch', async (req, reply) => {
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(req.body)
    const payload = await req.jwtVerify<{
      tenantId: string; schemaName: string; userId: string; role: string; branchId: string
    }>()

    const tenantDb = getTenantDb(payload.schemaName)

    // Re-fetch user from DB — role or branch access may have changed since JWT was issued
    const user = await tenantDb.user.findUnique({
      where:  { id: payload.userId },
      select: { role: true, isActive: true, branchIds: true },
    })
    if (!user)          return reply.status(404).send({ error: 'User not found' })
    if (!user.isActive) return reply.status(403).send({ error: 'Account is inactive' })

    if (user.branchIds.length > 0 && !user.branchIds.includes(branchId)) {
      return reply.status(403).send({ error: 'No access to this branch' })
    }

    // Verify branch exists and is still active
    const branch = await tenantDb.branch.findFirst({ where: { id: branchId, isActive: true } })
    if (!branch) return reply.status(404).send({ error: 'Branch not found or inactive' })

    const token = await reply.jwtSign({
      tenantId:   payload.tenantId,
      schemaName: payload.schemaName,
      branchId,
      userId:     payload.userId,
      role:       user.role,   // always use current DB role, not stale JWT claim
    })

    // Flush cached analytics for the branch being switched into so the
    // first dashboard load always reflects the current state.
    await invalidateBranch(payload.schemaName, branchId)

    return { accessToken: token, branch: { id: branch.id, name: branch.name, domainType: branch.domainType } }
  })
}
