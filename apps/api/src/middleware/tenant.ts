import type { FastifyRequest, FastifyReply } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { getTenantDb } from '../lib/tenant-db.js'

declare module 'fastify' {
  interface FastifyRequest {
    tenantId:   string
    schemaName: string
    branchId:   string
    userId:     string
    role:       'owner' | 'manager' | 'cashier' | 'viewer'
    db:         PrismaClient   // tenant-scoped Prisma client — use this in all routes
  }
}

export interface JWTPayload {
  tenantId:   string
  schemaName: string   // e.g. "t_ramesh_kirana"
  branchId:   string
  userId:     string
  role:       'owner' | 'manager' | 'cashier' | 'viewer'
}

// =============================================================================
// tenantMiddleware
// Runs before every protected route handler.
//
// 1. Verifies the JWT (throws → 401 if invalid / expired)
// 2. Attaches tenant context fields to req
// 3. Attaches a per-tenant PrismaClient (req.db) scoped to the correct
//    PostgreSQL schema — no RLS, no set_config needed.
//    Each tenant's data is physically isolated in its own schema.
// =============================================================================
export async function tenantMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const payload = await req.jwtVerify<JWTPayload>()

    req.tenantId   = payload.tenantId
    req.schemaName = payload.schemaName
    req.branchId   = payload.branchId
    req.userId     = payload.userId
    req.role       = payload.role

    // getTenantDb is cached — no new connection pool per request
    req.db = getTenantDb(payload.schemaName)
  } catch (err) {
    // JWT errors (invalid signature, expiry) are expected — log at debug level.
    // Non-JWT errors (DB connection down, getTenantDb crash) are unexpected —
    // log at error so they appear in production monitoring, not silently masked as 401s.
    const isJwtError = err instanceof Error && (
      err.message.includes('jwt') ||
      err.message.includes('signature') ||
      err.message.includes('expired') ||
      err.message.includes('token')
    )
    if (!isJwtError) {
      req.log.error({ err }, 'tenantMiddleware: unexpected error (not a JWT error)')
    }
    return reply.status(401).send({
      error:   'Unauthorized',
      message: 'Invalid or expired token',
    })
  }
}
