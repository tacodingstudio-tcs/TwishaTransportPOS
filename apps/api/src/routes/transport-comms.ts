// apps/api/src/routes/transport-comms.ts
// Server-side PDFs and WhatsApp notifications for the transport module. Registered under /api/transport.
//
//   GET  /lrs/:id/pdf?copies=1|3        consignment note PDF
//   GET  /bills/:id/pdf                 freight bill PDF
//   POST /lrs/:id/notify                send the LR copy / delivery update now (manual, always allowed)
//   POST /bills/:id/notify              send the freight bill now
//   GET  /notifications                 delivery log (filter by status / ref)
//   POST /notifications/:id/retry       re-queue a failed or skipped message
//   GET/PUT /notify-settings            which automatic messages are on
//   POST /notify/run-alerts             run today's reminder/owner-alert job for this business now

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { tbl, q, q1, httpError, requireWrite, requireManager, branchConfig, type Ctx } from '../lib/transport-helpers.js'
import { lrPdf, billPdf } from '../lib/transport-docs.js'
import {
  notifyLr, notifyBill, retryMessage, runDailyAlerts, notifySettings, NOTIFY_SETTING_KEYS,
} from '../lib/transport-notify.js'

const idParam = z.object({ id: z.string().uuid() })

export const transportCommsRoutes: FastifyPluginAsync = async (app) => {

  // ── PDFs ────────────────────────────────────────────────────────────────────
  app.get('/lrs/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const { copies } = z.object({ copies: z.enum(['1', '3']).default('3') }).parse(req.query)
    const { buffer, filename } = await lrPdf(req, id,
      copies === '1' ? ['Consignor copy'] : ['Consignor copy', 'Consignee copy', 'Driver copy'])
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${filename}"`)
      .header('Cache-Control', 'private, no-store')
      .send(buffer)
  })

  app.get('/bills/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const { buffer, filename } = await billPdf(req, id)
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="${filename}"`)
      .header('Cache-Control', 'private, no-store')
      .send(buffer)
  })

  // ── Manual sends ────────────────────────────────────────────────────────────
  app.post('/lrs/:id/notify', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({
      kind:    z.enum(['lr_booked', 'lr_delivered']).default('lr_booked'),
      toPhone: z.string().max(20).optional(),            // override the consignor's number
    }).parse(req.body ?? {})
    const r = await notifyLr(req, id, body.kind, { force: true, toPhone: body.toPhone })
    return reply.status(r?.status === 'skipped' ? 422 : 202).send(r)
  })

  app.post('/bills/:id/notify', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const body = z.object({ toPhone: z.string().max(20).optional() }).parse(req.body ?? {})
    const r = await notifyBill(req, id, { force: true, toPhone: body.toPhone })
    return reply.status(r?.status === 'skipped' ? 422 : 202).send(r)
  })

  // ── Delivery log ────────────────────────────────────────────────────────────
  app.get('/notifications', async (req) => {
    const qy = z.object({
      status: z.enum(['queued', 'sent', 'failed', 'skipped']).optional(),
      refType: z.enum(['lr', 'bill', 'vehicle']).optional(),
      refId: z.string().uuid().optional(),
      page:  z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(req.query)
    const params: unknown[] = [req.branchId]
    let where = `WHERE "branchId" = $1::uuid`
    if (qy.status)  { params.push(qy.status);  where += ` AND status = $${params.length}` }
    if (qy.refType) { params.push(qy.refType); where += ` AND "refType" = $${params.length}` }
    if (qy.refId)   { params.push(qy.refId);   where += ` AND "refId" = $${params.length}::uuid` }
    const [rows, total] = await Promise.all([
      q(req, `SELECT id, kind, "refType", "refId", "recipientName", "toPhone", message, attachment, status, error, attempts, "createdAt", "sentAt"
              FROM ${tbl(req.schemaName, 'transport_notifications')} ${where}
              ORDER BY "createdAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...params, qy.limit, (qy.page - 1) * qy.limit),
      q<{ count: number }>(req, `SELECT COUNT(*) AS count FROM ${tbl(req.schemaName, 'transport_notifications')} ${where}`, ...params),
    ])
    return { data: rows, total: total[0]?.count ?? 0, page: qy.page, limit: qy.limit }
  })

  app.post('/notifications/:id/retry', async (req, reply) => {
    requireWrite(req)
    const { id } = idParam.parse(req.params)
    const n = await q1<any>(req,
      `SELECT status FROM ${tbl(req.schemaName, 'transport_notifications')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, req.branchId)
    if (!n) throw httpError(404, 'Notification not found')
    if (n.status === 'sent' || n.status === 'queued') throw httpError(422, `This message is already ${n.status}`)
    const r = await retryMessage(req, id)
    return reply.status(r.status === 'skipped' ? 422 : 202).send(r)
  })

  // ── Settings ────────────────────────────────────────────────────────────────
  app.get('/notify-settings', async (req) => notifySettings(await branchConfig(req)))

  app.put('/notify-settings', async (req) => {
    requireManager(req)
    const body = z.object({
      notify_lr_booked:      z.boolean().optional(),
      notify_lr_delivered:   z.boolean().optional(),
      notify_bill_created:   z.boolean().optional(),
      notify_bill_reminders: z.boolean().optional(),
      notify_owner_alerts:   z.boolean().optional(),
      notify_reminder_every_days: z.number().int().min(1).max(60).optional(),
      notify_owner_phone:    z.string().max(20).nullable().optional(),
    }).strict().parse(req.body ?? {})
    void NOTIFY_SETTING_KEYS
    const patch = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))
    await req.db.$executeRawUnsafe(
      `UPDATE ${tbl(req.schemaName, 'branches')}
       SET "domainConfig" = COALESCE("domainConfig", '{}'::jsonb) || $2::jsonb, "updatedAt" = NOW()
       WHERE id = $1::uuid`, req.branchId, patch)
    return notifySettings(await branchConfig(req))
  })

  // Run today's reminder / owner-alert job for this business on demand (it is also a daily cron).
  app.post('/notify/run-alerts', async (req) => {
    requireManager(req)
    return runDailyAlerts(req as unknown as Ctx)
  })
}
