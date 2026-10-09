import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

export const brandRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    return req.db.brand.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    })
  })

  app.post('/', async (req, reply) => {
    const input = z.object({
      name: z.string().min(1),
      slug: z.string().optional(),
    }).parse(req.body)
    const slug = input.slug ?? input.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    const brand = await req.db.brand.create({
      data: { ...input, slug, branchId: req.branchId },
    })
    return reply.status(201).send(brand)
  })

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input = z.object({
      name: z.string().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body)
    return req.db.brand.update({ where: { id }, data: input })
  })
}
