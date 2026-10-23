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
import { OFFICE_COST_CODES } from '@billing/domain-registry'

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

  /** Office Costs of a transport business are overhead only; trip costs are entered against a trip. null = no restriction. */
  async function allowedCodes(req: { db: any; branchId: string }, domainType: string): Promise<readonly string[] | null> {
    if (domainType !== 'transport') return null
    const b = await req.db.branch.findUnique({ where: { id: req.branchId }, select: { domainConfig: true } })
    const kind = (b?.domainConfig as Record<string, unknown> | null)?.['firm_kind'] === 'goods' ? 'goods' : 'transport'
    return OFFICE_COST_CODES[kind]
  }
  async function assertOfficeCategory(req: { db: any; branchId: string }, domainType: string, category: string | undefined) {
    if (!category) return
    const allowed = await allowedCodes(req, domainType)
    if (allowed && !allowed.includes(category))
      throw Object.assign(
        new Error('That is a trip cost — enter it against a trip in Diesel & Trip Costs so it reaches that truck\'s profit. Office Costs is for overheads like rent, salary and EMI.'),
        { statusCode: 422 }
      )
  }

  // ── GET /api/expenses/categories ──────────────────────────────────────────
  // Returns domain-specific expense categories for this branch.
  // Must be registered BEFORE /:id to avoid route conflict.
  app.get('/categories', async (req) => {
    const ctx = await buildCtx(req)
    const all = listExpenseCategories(ctx.branchDomainType)
    const allowed = await allowedCodes(req, ctx.branchDomainType)
    return allowed ? all.filter((c: { code: string }) => allowed.includes(c.code)) : all
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

  // ── GET /api/expenses/:id ─────────────────────────────────────────────────
  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const row = await req.db.expense.findFirst({ where: { id, branchId: req.branchId } })
    if (!row) throw Object.assign(new Error('Expense not found'), { statusCode: 404 })
    return row
  })

  // ── POST /api/expenses ────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const input = CreateExpenseSchema.parse(req.body)
    const ctx   = await buildCtx(req)
    await assertOfficeCategory(req, ctx.branchDomainType, input.category)
    const expense = await createExpense(input, ctx)
    return reply.status(201).send(expense)
  })

  // ── PATCH /api/expenses/:id ───────────────────────────────────────────────
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const input   = UpdateExpenseSchema.parse(req.body)
    const ctx     = await buildCtx(req)
    await assertOfficeCategory(req, ctx.branchDomainType, input.category)
    return updateExpense(id, input, ctx)
  })

  // ── DELETE /api/expenses/:id ──────────────────────────────────────────────
  app.delete('/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const ctx     = await buildCtx(req)
    return deleteExpense(id, ctx)
  })
}
