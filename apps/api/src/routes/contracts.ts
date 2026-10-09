// apps/api/src/routes/contracts.ts
// Recurring billing contracts — auto-generate invoices on billing cycle
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { addDays, addMonths, addWeeks, addYears, startOfDay } from 'date-fns'

function nextBillingDate(from: Date, cycle: string, day: number): Date {
  const base = startOfDay(from)
  switch (cycle) {
    case 'weekly':      return addWeeks(base, 1)
    case 'monthly':     return addMonths(base, 1)
    case 'quarterly':   return addMonths(base, 3)
    case 'half_yearly': return addMonths(base, 6)
    case 'yearly':      return addYears(base, 1)
    default:            return addMonths(base, 1)
  }
}

const ContractSchema = z.object({
  partyId:         z.string().uuid(),
  title:           z.string().min(1).max(200),
  startDate:       z.string().date(),
  endDate:         z.string().date().optional(),
  billingCycle:    z.enum(['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']).default('monthly'),
  billingDay:      z.number().int().min(1).max(31).default(1),
  amount:          z.number().positive(),
  gstRate:         z.number().min(0).max(28).default(0),
  autoInvoice:     z.boolean().default(true),
  notes:           z.string().max(1000).optional(),
  terms:           z.string().max(2000).optional(),
})

export const contractRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/contracts
  app.get('/', async (req) => {
    const { status, partyId } = z.object({
      status:  z.string().optional(),
      partyId: z.string().uuid().optional(),
    }).parse(req.query)

    return req.db.contract.findMany({
      where: {
        branchId: req.branchId,
        ...(status  && { status }),
        ...(partyId && { partyId }),
      },
      include: { party: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
    })
  })

  // GET /api/contracts/:id
  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const c = await req.db.contract.findFirst({ where: { id, branchId: req.branchId } })
    if (!c) throw Object.assign(new Error('Contract not found'), { statusCode: 404 })
    return c
  })

  // POST /api/contracts
  app.post('/', async (req, reply) => {
    const input = ContractSchema.parse(req.body)

    // Auto-generate contract number
    const count = await req.db.contract.count({ where: { branchId: req.branchId } })
    const contractNo = `CNT-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const start = new Date(input.startDate)
    const next  = nextBillingDate(start, input.billingCycle, input.billingDay)

    const contract = await req.db.contract.create({
      data: {
        branchId:        req.branchId,
        partyId:         input.partyId,
        title:           input.title,
        contractNo,
        startDate:       start,
        endDate:         input.endDate ? new Date(input.endDate) : null,
        billingCycle:    input.billingCycle,
        billingDay:      input.billingDay,
        amount:          input.amount,
        gstRate:         input.gstRate,
        autoInvoice:     input.autoInvoice,
        notes:           input.notes ?? null,
        terms:           input.terms ?? null,
        status:          'active',
        nextBillingDate: next,
        createdBy:       req.userId,
      } as any,
    })
    return reply.status(201).send(contract)
  })

  // PATCH /api/contracts/:id
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input = ContractSchema.partial().parse(req.body)

    const existing = await req.db.contract.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) throw Object.assign(new Error('Contract not found'), { statusCode: 404 })

    return req.db.contract.update({
      where: { id },
      data: input as any,
    })
  })

  // POST /api/contracts/:id/pause
  app.post('/:id/pause', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    return req.db.contract.update({ where: { id }, data: { status: 'paused' } as any })
  })

  // POST /api/contracts/:id/resume
  app.post('/:id/resume', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const c = await req.db.contract.findFirst({ where: { id, branchId: req.branchId } })
    if (!c) throw Object.assign(new Error('Not found'), { statusCode: 404 })
    const next = nextBillingDate(new Date(), (c as any).billingCycle, (c as any).billingDay)
    return req.db.contract.update({ where: { id }, data: { status: 'active', nextBillingDate: next } as any })
  })

  // DELETE /api/contracts/:id
  app.delete('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await req.db.contract.update({ where: { id }, data: { status: 'cancelled' } as any })
    return reply.status(204).send()
  })

  // POST /api/contracts/:id/generate-invoice — manually trigger billing
  app.post('/:id/generate-invoice', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const c = await req.db.contract.findFirst({
      where: { id, branchId: req.branchId },
      include: { party: true },
    })
    if (!c) throw Object.assign(new Error('Contract not found'), { statusCode: 404 })
    if ((c as any).status !== 'active')
      throw Object.assign(new Error('Contract is not active'), { statusCode: 400 })

    const branch = await req.db.branch.findUniqueOrThrow({
      where: { id: req.branchId },
      select: { domainType: true },
    })

    // Import createInvoice dynamically to avoid circular dependency
    const { createInvoice } = await import('../services/invoice.service.js')

    const gstAmt = Number((c as any).amount) * Number((c as any).gstRate) / 100
    const totalAmt = Number((c as any).amount) + gstAmt

    const invoice = await createInvoice(
      {
        txnType:    'sale_invoice',
        partyId:    (c as any).partyId,
        date:       new Date().toISOString().split('T')[0],
        notes:      `Auto-generated from contract: ${(c as any).contractNo} — ${(c as any).title}`,
        domainData: {},
        aiMeta:     { contractId: id },
        items: [{
          description: (c as any).title,
          qty:         1,
          unit:        'month',
          rate:        Number((c as any).amount),
          discountPct: 0,
          gstRate:     Number((c as any).gstRate) as 0|5|12|18|28,
          gstExempt:   Number((c as any).gstRate) === 0,
          itemMeta:    { contractId: id },
        }],
      },
      {
        db: req.db, branchId: req.branchId,
        schemaName: req.schemaName, userId: req.userId, role: req.role,
        branchDomainType: branch.domainType,
      }
    )

    // Update last billed date and compute next billing
    const next = nextBillingDate(new Date(), (c as any).billingCycle, (c as any).billingDay)
    await req.db.contract.update({
      where: { id },
      data:  { lastBilledDate: new Date(), nextBillingDate: next } as any,
    })

    return reply.status(201).send(invoice)
  })
}
