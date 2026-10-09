// apps/api/src/routes/notifications.ts
//
// In-app notification centre. Surfaces reminder drafts, low-stock alerts,
// renewal dues, and overdue service visits to the owner / manager.
//
//  GET    /api/notifications              list (type / isRead / page filters)
//  GET    /api/notifications/unread-count quick badge count
//  POST   /api/notifications/mark-all-read mark everything read
//  GET    /api/notifications/:id          single notification
//  POST   /api/notifications/:id/read     mark one read
//  POST   /api/notifications/:id/approve  approve a payment_reminder_draft → queues WhatsApp
//  POST   /api/notifications/:id/dismiss  dismiss (sets approved=false)

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { whatsappQueue } from '../lib/queues.js'

const NOTIF_TYPES = [
  'payment_reminder_draft',
  'low_stock',
  'renewal_due',
  'visit_overdue',
  'generic',
] as const

export const notificationRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /unread-count — badge number ─────────────────────────────────────
  app.get('/unread-count', async (req) => {
    const count = await req.db.notification.count({
      where: { branchId: req.branchId, isRead: false },
    })
    return { count }
  })

  // ── GET / — list notifications ────────────────────────────────────────────
  app.get('/', async (req) => {
    const q = z.object({
      type:     z.enum(NOTIF_TYPES).optional(),
      isRead:   z.coerce.boolean().optional(),
      approved: z.enum(['pending', 'approved', 'dismissed']).optional(),
      page:     z.coerce.number().int().min(1).default(1),
      limit:    z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query)

    const skip = (q.page - 1) * q.limit

    const where: Record<string, unknown> = { branchId: req.branchId }
    if (q.type   !== undefined) where['type']   = q.type
    if (q.isRead !== undefined) where['isRead'] = q.isRead
    if (q.approved === 'pending')   where['approved'] = null
    if (q.approved === 'approved')  where['approved'] = true
    if (q.approved === 'dismissed') where['approved'] = false

    const [total, items] = await Promise.all([
      req.db.notification.count({ where }),
      req.db.notification.findMany({
        where,
        orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: q.limit,
      }),
    ])

    return { total, page: q.page, limit: q.limit, items }
  })

  // ── POST /mark-all-read ───────────────────────────────────────────────────
  app.post('/mark-all-read', async (req) => {
    const { count } = await req.db.notification.updateMany({
      where: { branchId: req.branchId, isRead: false },
      data:  { isRead: true, readAt: new Date() },
    })
    return { markedRead: count }
  })

  // ── GET /:id — single notification ───────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const notif = await req.db.notification.findFirst({
      where: { id, branchId: req.branchId },
    })
    if (!notif) return reply.status(404).send({ error: 'Notification not found' })
    return notif
  })

  // ── POST /:id/read — mark one notification read ───────────────────────────
  app.post('/:id/read', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const notif = await req.db.notification.findFirst({
      where: { id, branchId: req.branchId },
    })
    if (!notif) return reply.status(404).send({ error: 'Notification not found' })
    if (notif.isRead) return notif  // already read — idempotent

    return req.db.notification.update({
      where: { id },
      data:  { isRead: true, readAt: new Date() },
    })
  })

  // ── POST /:id/approve — approve a payment_reminder_draft ─────────────────
  // Marks the notification approved and pushes a payment_reminder job to the
  // whatsapp-send queue. The WhatsApp worker then sends the pre-drafted message.
  // Only owner and manager can approve.
  app.post('/:id/approve', async (req, reply) => {
    if (!['owner', 'manager'].includes(req.role))
      return reply.status(403).send({ error: 'Manager or owner access required to approve reminders' })

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      // Optional override of the draft message before sending
      message: z.string().min(1).max(1000).optional(),
    }).parse(req.body)

    const notif = await req.db.notification.findFirst({
      where: { id, branchId: req.branchId },
    })
    if (!notif) return reply.status(404).send({ error: 'Notification not found' })
    if (notif.type !== 'payment_reminder_draft')
      return reply.status(422).send({ error: 'Only payment_reminder_draft notifications can be approved' })
    if (notif.approved === true)
      return reply.status(409).send({ error: 'This reminder has already been approved and queued' })
    if (notif.approved === false)
      return reply.status(409).send({ error: 'This reminder has been dismissed — create a new draft if needed' })

    const payload = notif.payload as Record<string, unknown>
    const phone   = payload['phone'] as string | null

    if (!phone)
      return reply.status(422).send({ error: 'Party has no phone number — cannot send WhatsApp' })

    const draftMessage = body.message ?? (payload['draftMessage'] as string)

    // Normalize phone to E.164 for WhatsApp (91XXXXXXXXXX)
    const digits  = phone.replace(/\D/g, '')
    const phone10 = digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith('0')
      ? digits.slice(1)
      : digits
    const toPhone = `91${phone10}`

    // Get branch name for the job
    const branch = await req.db.branch.findUnique({
      where:  { id: req.branchId },
      select: { name: true },
    })

    // Queue the WhatsApp send job
    await whatsappQueue.add('send', {
      type:         'payment_reminder',
      invoiceId:    payload['partyId'] as string,  // used as a reference key in the worker
      tenantId:     req.tenantId,
      toPhone,
      partyName:    payload['partyName'] as string,
      amount:       payload['balance']  as number,
      daysOverdue:  payload['daysOverdue'] as number,
      draftMessage,
    })

    // Mark notification approved
    const updated = await req.db.notification.update({
      where: { id },
      data: {
        approved:   true,
        approvedAt: new Date(),
        isRead:     true,
        readAt:     new Date(),
        // Store the final sent message in payload for audit
        payload: { ...payload, sentMessage: draftMessage, sentAt: new Date().toISOString() },
      },
    })

    return reply.send({
      success:   true,
      notifId:   id,
      toPhone,
      partyName: payload['partyName'],
      message:   draftMessage,
      notification: updated,
    })
  })

  // ── POST /:id/dismiss — dismiss a draft without sending ───────────────────
  app.post('/:id/dismiss', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const notif = await req.db.notification.findFirst({
      where: { id, branchId: req.branchId },
    })
    if (!notif) return reply.status(404).send({ error: 'Notification not found' })
    if (notif.approved === true)
      return reply.status(409).send({ error: 'Cannot dismiss an already-approved reminder' })

    return req.db.notification.update({
      where: { id },
      data: { approved: false, isRead: true, readAt: new Date() },
    })
  })
}
