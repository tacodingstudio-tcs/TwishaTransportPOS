import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const ConditionsSchema = z.object({
  minQty:      z.number().nonnegative().optional(),
  minAmt:      z.number().nonnegative().optional(),
  productIds:  z.array(z.string().uuid()).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
  partyIds:    z.array(z.string().uuid()).optional(),
  dayOfWeek:   z.array(z.number().int().min(0).max(6)).optional(), // 0=Sun
}).default({})

const ActionSchema = z.object({
  discountPct: z.number().min(0).max(100).optional(),
  discountAmt: z.number().nonnegative().optional(),
  freeQty:     z.number().nonnegative().optional(),    // for BOGO
  slabs:       z.array(z.object({                      // for qty_slab
    minQty:     z.number().nonnegative(),
    discountPct: z.number().min(0).max(100),
  })).optional(),
}).default({})

const RuleBodySchema = z.object({
  name:       z.string().min(1).max(200),
  type:       z.enum(['percentage', 'flat', 'bogo', 'qty_slab']),
  isActive:   z.boolean().default(true),
  priority:   z.number().int().min(0).max(100).default(0),
  conditions: ConditionsSchema,
  action:     ActionSchema,
  validFrom:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const discountRulesRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/discount-rules
  app.get('/', async (req) => {
    const { active } = req.query as Record<string, string>
    const where: any = { branchId: req.branchId }
    if (active === 'true') where.isActive = true
    const rules = await req.db.discountRule.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    })
    return rules
  })

  // POST /api/discount-rules
  app.post('/', async (req, reply) => {
    const body = RuleBodySchema.parse(req.body)
    const rule = await req.db.discountRule.create({
      data: {
        branchId:   req.branchId,
        name:       body.name,
        type:       body.type,
        isActive:   body.isActive,
        priority:   body.priority,
        conditions: body.conditions as any,
        action:     body.action as any,
        validFrom:  body.validFrom ? new Date(body.validFrom) : null,
        validTo:    body.validTo   ? new Date(body.validTo)   : null,
      },
    })
    return reply.status(201).send(rule)
  })

  // PATCH /api/discount-rules/:id
  app.patch('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = RuleBodySchema.partial().parse(req.body)
    const existing = await req.db.discountRule.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) return reply.status(404).send({ error: 'Rule not found' })
    const updated = await req.db.discountRule.update({
      where: { id },
      data: {
        ...body,
        conditions: body.conditions as any,
        action:     body.action     as any,
        validFrom:  body.validFrom ? new Date(body.validFrom) : undefined,
        validTo:    body.validTo   ? new Date(body.validTo)   : undefined,
      },
    })
    return updated
  })

  // DELETE /api/discount-rules/:id
  app.delete('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const existing = await req.db.discountRule.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) return reply.status(404).send({ error: 'Rule not found' })
    await req.db.discountRule.delete({ where: { id } })
    return reply.status(204).send()
  })
}
