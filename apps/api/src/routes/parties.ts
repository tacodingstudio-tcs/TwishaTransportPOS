// apps/api/src/routes/parties.ts

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  createParty,
  listParties,
  getPartyStatement,
  CreatePartySchema,
  UpdatePartySchema,
} from '../services/party.service.js'

export const partyRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/parties
  app.get('/', async (req) => {
    const query = z.object({
      type:    z.string().optional(),
      search:  z.string().optional(),
      hasDebt: z.coerce.boolean().optional(),
      page:    z.coerce.number().default(1),
      limit:   z.coerce.number().default(20),
    }).parse(req.query)

    return listParties(
      { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role },
      query
    )
  })

  // POST /api/parties
  app.post('/', async (req, reply) => {
    const input = CreatePartySchema.parse(req.body)
    const party = await createParty(input, {
      db: req.db, branchId: req.branchId,
      userId: req.userId, role: req.role,
    })
    return reply.status(201).send(party)
  })

  // GET /api/parties/:id — tenant-scoped (accessible from any branch within the same tenant)
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const party   = await req.db.party.findFirst({
      where: { id },
    })
    if (!party) return reply.status(404).send({ error: 'Party not found' })
    return party
  })

  // PATCH /api/parties/:id
  app.patch('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = UpdatePartySchema.parse(req.body)

    const existing = await req.db.party.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) return reply.status(404).send({ error: 'Party not found' })

    return req.db.party.update({ where: { id }, data: input as Parameters<typeof req.db.party.update>[0]['data'] })
  })

  // GET /api/parties/:id/statement
  app.get('/:id/statement', async (req) => {
    const { id }  = z.object({ id: z.string().uuid() }).parse(req.params)
    const filters = z.object({
      fromDate: z.string().optional(),
      toDate:   z.string().optional(),
    }).parse(req.query)

    return getPartyStatement(id,
      { db: req.db, branchId: req.branchId, userId: req.userId, role: req.role },
      filters
    )
  })

  // GET /api/parties/udhaar/summary
  // Quick udhaar summary — total outstanding for this branch
  app.get('/udhaar/summary', async (req) => {
    const result = await req.db.party.aggregate({
      where:  { branchId: req.branchId, type: { in: ['customer','both'] }, balance: { gt: 0 } },
      _sum:   { balance: true },
      _count: { id: true },
    })

    return {
      totalOutstanding: Number(result._sum.balance ?? 0),
      customerCount:    result._count.id,
    }
  })

  // POST /api/parties/:id/send-statement
  // Generates a WhatsApp share link pre-filled with the outstanding statement.
  // No external API needed — the link opens WhatsApp on the owner's device
  // pointing directly to the customer's chat with the message ready to send.
  app.post('/:id/send-statement', async (req, reply) => {
    const { id }  = z.object({ id: z.string().uuid() }).parse(req.params)
    const body    = z.object({
      // Include only unpaid invoices, or full ledger
      mode:      z.enum(['outstanding_only','full_ledger']).default('outstanding_only'),
      fromDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      toDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Business signature line shown at bottom of message
      signature: z.string().max(100).optional(),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId

    const party = await db.party.findFirst({
      where: { id, branchId },
      select: { name: true, phone: true, balance: true },
    })
    if (!party) return reply.status(404).send({ error: 'Party not found' })
    if (!party.phone)
      return reply.status(422).send({ error: 'Party has no phone number — cannot generate WhatsApp link' })

    // Fetch pending invoices for this branch
    const invoices = await db.invoice.findMany({
      where: {
        partyId:  id,
        branchId,
        txnType:  'sale_invoice',
        status:  { in: body.mode === 'outstanding_only'
          ? ['confirmed','partial']
          : ['confirmed','partial','paid'] },
        ...(body.fromDate && { date: { gte: new Date(body.fromDate) } }),
        ...(body.toDate   && { date: { lte: new Date(body.toDate)   } }),
      },
      select: { number: true, date: true, grandTotal: true, paidAmt: true, status: true },
      orderBy: { date: 'asc' },
    })

    const branch = await db.branch.findUnique({
      where: { id: branchId }, select: { name: true },
    })

    const totalOutstanding = Number(party.balance)

    // Build WhatsApp message text
    const lines: string[] = [
      `*${branch?.name ?? 'Our Store'} — Account Statement*`,
      `Customer: *${party.name}*`,
      `Date: ${new Date().toLocaleDateString('en-IN')}`,
      '',
    ]

    if (invoices.length === 0) {
      lines.push('No pending invoices. Your account is clear. 🙏')
    } else {
      lines.push(`*${body.mode === 'outstanding_only' ? 'Pending Invoices' : 'Invoices'}:*`)
      for (const inv of invoices) {
        const balance = Number(inv.grandTotal) - Number(inv.paidAmt)
        const dateStr = new Date(inv.date).toLocaleDateString('en-IN')
        if (body.mode === 'outstanding_only' && balance <= 0) continue
        lines.push(
          `• ${inv.number} (${dateStr}) — ` +
          `₹${Number(inv.grandTotal).toLocaleString('en-IN')}` +
          (balance > 0 ? ` | *Due: ₹${balance.toLocaleString('en-IN')}*` : ' ✓ Paid'),
        )
      }
      lines.push('')
      lines.push(`*Total Outstanding: ₹${totalOutstanding.toLocaleString('en-IN')}*`)
    }

    if (body.signature) {
      lines.push('', body.signature)
    }

    const message = lines.join('\n')

    // Normalize phone: strip +91, spaces, dashes → 10 digits
    const rawPhone  = party.phone.replace(/\D/g, '')
    const phone10   = rawPhone.length === 12 && rawPhone.startsWith('91')
      ? rawPhone.slice(2)
      : rawPhone.length === 11 && rawPhone.startsWith('0')
      ? rawPhone.slice(1)
      : rawPhone
    const waPhone   = `91${phone10}`  // WhatsApp needs country code without +
    const waLink    = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`

    return reply.send({
      partyName:   party.name,
      phone:       party.phone,
      outstanding: totalOutstanding,
      invoiceCount: invoices.length,
      message,
      whatsapp_link: waLink,
    })
  })
}
