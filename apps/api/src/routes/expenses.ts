// apps/api/src/routes/expenses.ts
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  createExpense,
  updateExpense,
  deleteExpense,
  listExpenses,
  getExpenseSummary,
  listExpenseCategories,
  CreateExpenseSchema,
  UpdateExpenseSchema,
  ListExpenseSchema,
} from '../services/expense.service.js'

export const expenseRoutes: FastifyPluginAsync = async (app) => {

  async function buildCtx(req: { db: any; branchId: string; userId: string; role: string }) {
    const branch = await req.db.branch.findUniqueOrThrow({
      where:  { id: req.branchId },
      select: { domainType: true },
    })
    return {
      db:               req.db,
      branchId:         req.branchId,
      userId:           req.userId,
      branchDomainType: branch.domainType,
    }
  }

  // ── GET /api/expenses/categories ──────────────────────────────────────────
  // Returns domain-specific expense categories for this branch.
  // Must be registered BEFORE /:id to avoid route conflict.
  app.get('/categories', async (req) => {
    const ctx = await buildCtx(req)
    return listExpenseCategories(ctx.branchDomainType)
  })

  // ── GET /api/expenses/summary ─────────────────────────────────────────────
  app.get('/summary', async (req) => {
    const { from, to, branchId } = z.object({
      from:     z.string().optional(),
      to:       z.string().optional(),
      branchId: z.string().optional(),
    }).parse(req.query)
    const base = await buildCtx(req)
    const ctx: any = { ...base }
    if (branchId && req.role === 'owner') {
      if (branchId === 'all') ctx.allBranches = true
      else                    ctx.branchId = branchId
    }
    return getExpenseSummary(from, to, ctx)
  })

  // ── GET /api/expenses ─────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const query = ListExpenseSchema.parse(req.query)
    const base  = await buildCtx(req)
    const ctx: any = { ...base }
    // Owner can filter by a specific branch or see all branches
    if (query.branchId && req.role === 'owner') {
      if (query.branchId === 'all') ctx.allBranches = true
      else                          ctx.branchId = query.branchId
    }
    return listExpenses(query, ctx)
  })

  // ── POST /api/expenses ────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const input = CreateExpenseSchema.parse(req.body)
    const ctx   = await buildCtx(req)
    const expense = await createExpense(input, ctx)
    return reply.status(201).send(expense)
  })

  // ── PATCH /api/expenses/:id ───────────────────────────────────────────────
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = UpdateExpenseSchema.parse(req.body)
    const ctx     = await buildCtx(req)
    return updateExpense(id, input, ctx)
  })

  // ── DELETE /api/expenses/:id ──────────────────────────────────────────────
  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const ctx     = await buildCtx(req)
    return deleteExpense(id, ctx)
  })
}
