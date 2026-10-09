import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { seedDomainCategories } from '../lib/provision-schema.js'

export const categoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const db = req.db
    const branchId = req.branchId

    const existing = await db.category.findMany({
      where: {
        isActive: true,
        OR: [{ branchId }, { branchId: null }],
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })

    // Lazy seed: if this branch has no branch-owned categories yet, seed domain defaults
    const hasBranchCategories = existing.some(c => c.branchId === branchId)
    if (!hasBranchCategories) {
      const branch = await db.branch.findUnique({
        where: { id: branchId },
        select: { domainType: true },
      })
      if (branch?.domainType) {
        await seedDomainCategories(db, branchId, branch.domainType)
        return db.category.findMany({
          where: {
            isActive: true,
            OR: [{ branchId }, { branchId: null }],
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        })
      }
    }

    return existing
  })

  app.post('/', async (req, reply) => {
    const input = z.object({
      name: z.string().min(1),
      slug: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      parentId: z.string().uuid().optional(),
      sortOrder: z.number().default(0),
    }).parse(req.body)
    const slug = input.slug ?? input.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    const cat = await req.db.category.create({
      data: { ...input, slug, branchId: req.branchId },
    })
    return reply.status(201).send(cat)
  })

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input = z.object({
      name: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      sortOrder: z.number().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body)
    return req.db.category.update({ where: { id }, data: input })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    await req.db.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } })
    await req.db.category.update({ where: { id }, data: { isActive: false } })
    return reply.status(204).send()
  })
}
