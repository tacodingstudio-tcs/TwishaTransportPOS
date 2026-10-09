// apps/api/src/routes/users.ts
//
// User management within a tenant — create staff, set branch access,
// update roles, reset PINs, deactivate.
//
// Role hierarchy enforced here:
//   owner   → can do everything
//   manager → can read users; cannot create/modify other managers or the owner
//   cashier/viewer → cannot access user management at all
//
//  GET    /api/users          list users (owner/manager)
//  GET    /api/users/me       current user's own profile
//  POST   /api/users          create staff user (owner only)
//  GET    /api/users/:id      single user (owner/manager)
//  PATCH  /api/users/:id      update name / role / branchIds / lang (owner only)
//  POST   /api/users/:id/reset-pin    reset PIN (owner only)
//  POST   /api/users/:id/deactivate   deactivate user (owner only)
//  POST   /api/users/:id/activate     reactivate user (owner only)

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { hashPin } from '../lib/password.js'
import { revokeAllUserTokens } from '../lib/refreshToken.service.js'

const ROLES = ['owner', 'manager', 'cashier', 'viewer'] as const

export const userRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /me — own profile ─────────────────────────────────────────────────
  // Available to all authenticated users.
  app.get('/me', async (req, reply) => {
    const user = await req.db.user.findUnique({
      where:  { id: req.userId },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })
    if (!user) return reply.status(404).send({ error: 'User not found' })
    return user
  })

  // ── GET / — list users ────────────────────────────────────────────────────
  app.get('/', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required' })

    const q = z.object({
      role:     z.enum(ROLES).optional(),
      isActive: z.coerce.boolean().optional(),
      search:   z.string().optional(),
      page:     z.coerce.number().int().min(1).default(1),
      limit:    z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)

    const skip = (q.page - 1) * q.limit

    const where: Record<string, unknown> = {}
    if (q.role     !== undefined) where['role']     = q.role
    if (q.isActive !== undefined) where['isActive'] = q.isActive
    if (q.search) {
      where['OR'] = [
        { name:  { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
      ]
    }

    const [total, users] = await Promise.all([
      req.db.user.count({ where }),
      req.db.user.findMany({
        where,
        select: {
          id: true, name: true, phone: true, email: true,
          role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
          // pin intentionally excluded from list
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: q.limit,
      }),
    ])

    return { total, page: q.page, limit: q.limit, users }
  })

  // ── POST / — create staff user (owner only) ───────────────────────────────
  // The new user can immediately log in with the phone + PIN.
  // `branchIds: []` means the user has access to all branches.
  app.post('/', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can create users' })

    const body = z.object({
      name:      z.string().min(2).max(100).trim(),
      phone:     z.string().min(10).max(13),
      email:     z.string().email().optional(),
      pin:       z.string().length(4).regex(/^\d{4}$/, 'PIN must be 4 digits'),
      role:      z.enum(['manager', 'cashier', 'viewer']).default('cashier'),
      branchIds: z.array(z.string().uuid()).default([]),
      lang:      z.enum(['hi', 'en', 'gu', 'mr', 'ta', 'te', 'kn', 'bn']).default('hi'),
    }).parse(req.body)

    const db = req.db

    // Validate that all specified branchIds actually exist
    if (body.branchIds.length > 0) {
      const existing = await db.branch.findMany({
        where:  { id: { in: body.branchIds } },
        select: { id: true },
      })
      if (existing.length !== body.branchIds.length) {
        const found    = new Set(existing.map((b) => b.id))
        const missing  = body.branchIds.filter((id) => !found.has(id))
        return reply.status(422).send({ error: 'Branch not found', branchIds: missing })
      }
    }

    // Check phone uniqueness within this tenant schema
    const dup = await db.user.findUnique({ where: { phone: body.phone }, select: { id: true } })
    if (dup) return reply.status(409).send({ error: 'A user with this phone already exists' })

    const user = await db.user.create({
      data: {
        name:      body.name,
        phone:     body.phone,
        email:     body.email ?? null,
        role:      body.role,
        branchIds: body.branchIds,
        pin:       await hashPin(body.pin),
        lang:      body.lang,
        isActive:  true,
      },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })

    return reply.status(201).send(user)
  })

  // ── GET /:id — single user ────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const user = await req.db.user.findUnique({
      where:  { id },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true, createdAt: true,
      },
    })
    if (!user) return reply.status(404).send({ error: 'User not found' })
    return user
  })

  // ── PATCH /:id — update user ──────────────────────────────────────────────
  // Owner can update anyone. Managers cannot be updated by other managers.
  app.patch('/:id', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can update users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      name:      z.string().min(2).max(100).trim().optional(),
      email:     z.string().email().optional().nullable(),
      role:      z.enum(['manager', 'cashier', 'viewer']).optional(),
      branchIds: z.array(z.string().uuid()).optional(),
      lang:      z.enum(['hi', 'en', 'gu', 'mr', 'ta', 'te', 'kn', 'bn']).optional(),
    }).parse(req.body)

    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { role: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    // Cannot demote or reassign the owner account
    if (existing.role === 'owner')
      return reply.status(409).send({ error: 'The owner account role cannot be changed via this endpoint' })

    // Validate branchIds if provided
    if (body.branchIds && body.branchIds.length > 0) {
      const found = await db.branch.findMany({
        where:  { id: { in: body.branchIds } },
        select: { id: true },
      })
      if (found.length !== body.branchIds.length) {
        const foundIds = new Set(found.map((b) => b.id))
        return reply.status(422).send({ error: 'Branch not found', branchIds: body.branchIds.filter((id) => !foundIds.has(id)) })
      }
    }

    return db.user.update({
      where: { id },
      data: {
        ...(body.name      !== undefined && { name:      body.name }),
        ...(body.email     !== undefined && { email:     body.email }),
        ...(body.role      !== undefined && { role:      body.role }),
        ...(body.branchIds !== undefined && { branchIds: body.branchIds }),
        ...(body.lang      !== undefined && { lang:      body.lang }),
      },
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, branchIds: true, lang: true, isActive: true,
      },
    })
  })

  // ── POST /:id/reset-pin — change a user's PIN (owner only) ────────────────
  app.post('/:id/reset-pin', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can reset PINs' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const { pin } = z.object({
      pin: z.string().length(4).regex(/^\d{4}$/, 'PIN must be 4 digits'),
    }).parse(req.body)

    const db = req.db
    const existing = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    await db.user.update({
      where: { id },
      data:  { pin: await hashPin(pin) },
    })

    // Revoke all active refresh tokens for this user so an attacker who held
    // a stolen token is forced to re-authenticate with the new PIN immediately.
    await revokeAllUserTokens(req.tenantId, id)

    return reply.send({ success: true, userId: id, message: 'PIN updated successfully' })
  })

  // ── POST /:id/deactivate ──────────────────────────────────────────────────
  app.post('/:id/deactivate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can deactivate users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { role: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })
    if (existing.role === 'owner')
      return reply.status(409).send({ error: 'Cannot deactivate the owner account' })
    if (id === req.userId)
      return reply.status(409).send({ error: 'Cannot deactivate your own account' })

    await db.user.update({ where: { id }, data: { isActive: false } })
    // Revoke all active refresh tokens immediately so the deactivated user
    // cannot continue to get new access tokens after the current one expires.
    await revokeAllUserTokens(req.tenantId, id)
    return reply.send({ success: true, userId: id })
  })

  // ── POST /:id/activate ────────────────────────────────────────────────────
  app.post('/:id/activate', async (req, reply) => {
    if (req.role !== 'owner')
      return reply.status(403).send({ error: 'Only the owner can activate users' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db

    const existing = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return reply.status(404).send({ error: 'User not found' })

    await db.user.update({ where: { id }, data: { isActive: true } })
    return reply.send({ success: true, userId: id })
  })
}
