// apps/api/src/services/expense.service.ts
import type { PrismaClient } from '@billing/db'
import { getExpenseCategories, type DomainType } from '@billing/domain-registry'
import { z } from 'zod'

// ── Schemas ───────────────────────────────────────────────────────────────────

export const CreateExpenseSchema = z.object({
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD, defaults to today
  category:      z.string().min(1),
  description:   z.string().max(500).optional(),
  amount:        z.number().positive(),
  gstRate:       z.number().refine((v) => [0, 5, 12, 18, 28].includes(v)).default(0),
  paymentMode:   z.enum(['cash', 'upi', 'bank', 'credit']).default('cash'),
  partyId:       z.string().uuid().optional(),
  referenceNo:   z.string().max(100).optional(),
  notes:         z.string().max(1000).optional(),
  attachmentUrl: z.string().max(2000).optional(),
  isRecurring:   z.boolean().default(false),
  recurrence:    z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
})

export const UpdateExpenseSchema = CreateExpenseSchema.partial()

export const ListExpenseSchema = z.object({
  from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  category:    z.string().optional(),
  paymentMode: z.string().optional(),
  partyId:     z.string().uuid().optional(),
  branchId:    z.string().optional(),   // owner only: uuid or 'all'
  page:        z.coerce.number().default(1),
  limit:       z.coerce.number().min(1).max(100).default(50),
})

export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>
export type ListExpenseInput   = z.infer<typeof ListExpenseSchema>

export interface ExpenseCtx {
  db:               PrismaClient
  branchId:         string
  userId:           string
  branchDomainType: string
}

// ── createExpense ─────────────────────────────────────────────────────────────
export async function createExpense(input: CreateExpenseInput, ctx: ExpenseCtx) {
  const gstAmount = +(input.amount * input.gstRate / (100 + input.gstRate)).toFixed(2)
  const date = input.date ? new Date(input.date) : new Date()

  return ctx.db.expense.create({
    data: {
      branchId:      ctx.branchId,
      date,
      category:      input.category,
      description:   input.description   ?? null,
      amount:        input.amount,
      gstAmount,
      gstRate:       input.gstRate,
      paymentMode:   input.paymentMode,
      partyId:       input.partyId       ?? null,
      referenceNo:   input.referenceNo   ?? null,
      notes:         input.notes         ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      isRecurring:   input.isRecurring,
      recurrence:    input.recurrence    ?? null,
      createdBy:     ctx.userId,
    },
  })
}

// ── updateExpense ─────────────────────────────────────────────────────────────
export async function updateExpense(id: string, input: UpdateExpenseInput, ctx: ExpenseCtx) {
  const existing = await ctx.db.expense.findFirst({ where: { id, branchId: ctx.branchId } })
  if (!existing) throw Object.assign(new Error('Expense not found'), { statusCode: 404 })

  const amount  = input.amount  ?? Number(existing.amount)
  const gstRate = input.gstRate ?? existing.gstRate
  const gstAmount = +(amount * gstRate / (100 + gstRate)).toFixed(2)

  return ctx.db.expense.update({
    where: { id },
    data: {
      ...(input.date        && { date: new Date(input.date) }),
      ...(input.category    !== undefined && { category:    input.category }),
      ...(input.description !== undefined && { description: input.description }),
      amount,
      gstAmount,
      gstRate,
      ...(input.paymentMode !== undefined && { paymentMode:   input.paymentMode }),
      ...(input.partyId     !== undefined && { partyId:       input.partyId ?? null }),
      ...(input.referenceNo !== undefined && { referenceNo:   input.referenceNo ?? null }),
      ...(input.notes       !== undefined && { notes:         input.notes ?? null }),
      ...(input.attachmentUrl !== undefined && { attachmentUrl: input.attachmentUrl ?? null }),
      ...(input.isRecurring !== undefined && { isRecurring:   input.isRecurring }),
      ...(input.recurrence  !== undefined && { recurrence:    input.recurrence ?? null }),
    },
  })
}

// ── deleteExpense ─────────────────────────────────────────────────────────────
export async function deleteExpense(id: string, ctx: ExpenseCtx) {
  const existing = await ctx.db.expense.findFirst({ where: { id, branchId: ctx.branchId } })
  if (!existing) throw Object.assign(new Error('Expense not found'), { statusCode: 404 })
  await ctx.db.expense.delete({ where: { id } })
  return { deleted: true }
}

// ── listExpenses ──────────────────────────────────────────────────────────────
export async function listExpenses(input: ListExpenseInput, ctx: ExpenseCtx & { allBranches?: boolean }) {
  const page  = Math.max(1, input.page)
  const limit = Math.min(100, input.limit)
  const skip  = (page - 1) * limit

  const where: any = ctx.allBranches ? {} : { branchId: ctx.branchId }
  if (input.from || input.to) {
    where.date = {
      ...(input.from && { gte: new Date(input.from) }),
      ...(input.to   && { lte: new Date(input.to + 'T23:59:59') }),
    }
  }
  if (input.category)    where.category    = input.category
  if (input.paymentMode) where.paymentMode = input.paymentMode
  if (input.partyId)     where.partyId     = input.partyId

  const [expenses, total] = await Promise.all([
    ctx.db.expense.findMany({ where, orderBy: { date: 'desc' }, skip, take: limit }),
    ctx.db.expense.count({ where }),
  ])

  // Attach branch names when viewing across branches
  let data: any[] = expenses
  if (ctx.allBranches) {
    const branchIds = [...new Set(expenses.map((e: any) => e.branchId))]
    const branches  = branchIds.length
      ? await ctx.db.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } })
      : []
    const branchMap = new Map(branches.map((b: any) => [b.id, b.name]))
    data = expenses.map((e: any) => ({ ...e, branchName: branchMap.get(e.branchId) ?? e.branchId }))
  }

  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } }
}

// ── getExpenseSummary ─────────────────────────────────────────────────────────
export async function getExpenseSummary(
  from: string | undefined,
  to:   string | undefined,
  ctx:  ExpenseCtx & { allBranches?: boolean }
) {
  const where: any = ctx.allBranches ? {} : { branchId: ctx.branchId }
  if (from || to) {
    where.date = {
      ...(from && { gte: new Date(from) }),
      ...(to   && { lte: new Date(to + 'T23:59:59') }),
    }
  }

  const [byCategory, byMode, totals] = await Promise.all([
    ctx.db.expense.groupBy({
      by:    ['category'],
      where,
      _sum:  { amount: true, gstAmount: true },
      orderBy: { _sum: { amount: 'desc' } },
    }),
    ctx.db.expense.groupBy({
      by:    ['paymentMode'],
      where,
      _sum:  { amount: true },
    }),
    ctx.db.expense.aggregate({
      where,
      _sum: { amount: true, gstAmount: true },
      _count: true,
    }),
  ])

  // Enrich category rows with label + icon from domain registry
  const categories = getExpenseCategories(ctx.branchDomainType as DomainType)
  const catMap = new Map(categories.map((c) => [c.code, c]))

  return {
    totalAmount:    Number(totals._sum.amount    ?? 0),
    totalGst:       Number(totals._sum.gstAmount ?? 0),
    totalCount:     totals._count,
    byCategory: byCategory.map((r) => ({
      category:  r.category,
      label:     catMap.get(r.category)?.label ?? r.category,
      icon:      catMap.get(r.category)?.icon  ?? '📎',
      total:     Number(r._sum.amount    ?? 0),
      gstTotal:  Number(r._sum.gstAmount ?? 0),
    })),
    byPaymentMode: Object.fromEntries(
      byMode.map((r) => [r.paymentMode, Number(r._sum.amount ?? 0)])
    ),
  }
}

// ── getExpenseCategories ──────────────────────────────────────────────────────
export function listExpenseCategories(domainType: string) {
  return getExpenseCategories(domainType as DomainType)
}
