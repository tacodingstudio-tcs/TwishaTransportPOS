// apps/api/src/services/party.service.ts
// Customers and suppliers in one service.
// balance > 0 → customer owes us (udhaar)
// balance < 0 → we owe supplier

import { Prisma } from '@billing/db'
import type { PrismaClient } from '@billing/db'
import { z } from 'zod'

export const CreatePartySchema = z.object({
  type:        z.enum(['customer', 'supplier', 'both']),
  name:        z.string().min(1).max(200),
  phone:       z.string().min(10).max(13).optional(),
  email:       z.string().email().optional(),
  gstin:       z.string().length(15).optional(),
  pan:         z.string().length(10).optional(),
  address:     z.object({
    line1:   z.string().optional(),
    city:    z.string().optional(),
    state:   z.string().optional(),
    pincode: z.string().optional(),
    stateCode: z.string().optional(),
  }).optional(),
  creditLimit: z.number().nonnegative().default(0),
  meta:        z.record(z.unknown()).default({}),
})

export const UpdatePartySchema = CreatePartySchema.partial()

export type CreatePartyInput = z.infer<typeof CreatePartySchema>

interface RequestCtx {
  db:       PrismaClient
  branchId: string
  userId:   string
  role:     string
}

// =============================================================================
// createParty
// =============================================================================
export async function createParty(input: CreatePartyInput, ctx: RequestCtx) {
  // Check for duplicate phone within this tenant's schema
  if (input.phone) {
    const existing = await ctx.db.party.findFirst({
      where: { phone: input.phone },
      select: { id: true, name: true },
    })
    if (existing) {
      throw Object.assign(
        new Error(`Phone ${input.phone} already registered to "${existing.name}"`),
        { code: 'DUPLICATE_PHONE', statusCode: 409 }
      )
    }
  }

  return ctx.db.party.create({
    data: {
      branchId:    ctx.branchId,
      type:        input.type,
      name:        input.name,
      phone:       input.phone    ?? null,
      email:       input.email    ?? null,
      gstin:       input.gstin    ?? null,
      pan:         input.pan      ?? null,
      address:     (input.address  ?? Prisma.JsonNull) as never,
      creditLimit: input.creditLimit,
      meta:        input.meta as never,
    },
  })
}

// =============================================================================
// listParties
// =============================================================================
export async function listParties(
  ctx: RequestCtx,
  filters: {
    type?:    string
    search?:  string
    hasDebt?: boolean  // only parties with balance > 0 (udhaar list)
    page?:    number
    limit?:   number
  }
) {
  const page  = Math.max(1, filters.page  ?? 1)
  const limit = Math.min(100, filters.limit ?? 20)
  const skip  = (page - 1) * limit

  const where: Prisma.PartyWhereInput = {
    isActive: true,
    ...(filters.type   && { type: filters.type }),
    ...(filters.search && {
      OR: [
        { name:  { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search } },
        { gstin: { contains: filters.search, mode: 'insensitive' } },
      ],
    }),
    ...(filters.hasDebt && { balance: { gt: 0 } }),
  }

  const [parties, total] = await Promise.all([
    ctx.db.party.findMany({
      where,
      orderBy: filters.hasDebt ? { balance: 'desc' } : { name: 'asc' },
      skip,
      take:  limit,
      select: {
        id: true, name: true, phone: true, type: true,
        gstin: true, balance: true, creditLimit: true, loyaltyPts: true, meta: true,
      },
    }),
    ctx.db.party.count({ where }),
  ])

  return { data: parties, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } }
}

// =============================================================================
// getPartyStatement
// Full ledger for one party: all invoices + payments, running balance
// =============================================================================
export async function getPartyStatement(
  partyId: string,
  ctx:     RequestCtx,
  filters: { fromDate?: string; toDate?: string }
) {
  const party = await ctx.db.party.findFirst({
    where:  { id: partyId },
  })
  if (!party) throw Object.assign(new Error('Party not found'), { statusCode: 404 })

  const dateFilter = {
    ...(filters.fromDate && { gte: new Date(filters.fromDate) }),
    ...(filters.toDate   && { lte: new Date(filters.toDate)   }),
  }

  // Fetch all invoices for this party in this branch (exclude cancelled)
  const invoices = await ctx.db.invoice.findMany({
    where: {
      partyId,
      branchId: ctx.branchId,
      status: { not: 'cancelled' },
      ...(Object.keys(dateFilter).length && { date: dateFilter }),
    },
    select: {
      id: true, number: true, txnType: true,
      date: true, grandTotal: true, paidAmt: true, status: true,
    },
    orderBy: { date: 'asc' },
  })

  // Fetch only active (non-voided) payments for this party in this branch
  const payments = await ctx.db.payment.findMany({
    where: {
      partyId,
      branchId: ctx.branchId,
      status: 'active',
      ...(Object.keys(dateFilter).length && { paymentDate: dateFilter }),
    },
    select: { id: true, amount: true, method: true, paymentDate: true, refNo: true, type: true },
    orderBy: { paymentDate: 'asc' },
  })

  // Debit = party owes us more (sale); Credit = party is owed / we owe them (return / payment)
  function invoiceDebitCredit(txnType: string, grandTotal: number): { debit: number; credit: number } {
    switch (txnType) {
      case 'sale_invoice':
      case 'delivery_challan':
      case 'debit_note':        return { debit: grandTotal, credit: 0 }
      case 'credit_note':
      case 'sale_return':
      case 'purchase_return':   return { debit: 0, credit: grandTotal }
      case 'purchase_invoice':  return { debit: 0, credit: grandTotal }  // we owe supplier
      default:                  return { debit: 0, credit: 0 }
    }
  }

  // Merge and sort by date, compute running balance
  type LedgerEntry = {
    date: Date; type: 'invoice' | 'payment'
    description: string; debit: number; credit: number
    id: string
  }

  const entries: LedgerEntry[] = [
    ...invoices.map((inv) => {
      const { debit, credit } = invoiceDebitCredit(inv.txnType, Number(inv.grandTotal))
      return {
        date:        inv.date,
        type:        'invoice' as const,
        description: `${inv.number} (${inv.txnType.replace(/_/g, ' ')})`,
        debit,
        credit,
        id:          inv.id,
      }
    }),
    ...payments.map((pay) => ({
      date:        pay.paymentDate,
      type:        'payment' as const,
      description: `Payment (${pay.method})${pay.refNo ? ' · ' + pay.refNo : ''}`,
      debit:       0,
      credit:      Number(pay.amount),
      id:          pay.id,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime())

  // Compute running balance (positive = party owes us)
  let runningBalance = 0
  const ledger = entries.map((e) => {
    runningBalance += e.debit - e.credit
    return { ...e, balance: runningBalance }
  })

  const saleInvoices = invoices.filter((inv) =>
    ['sale_invoice', 'delivery_challan', 'debit_note'].includes(inv.txnType)
  )
  const totalDebit  = ledger.reduce((s, e) => s + e.debit, 0)
  const totalCredit = ledger.reduce((s, e) => s + e.credit, 0)

  return {
    party: {
      id:             party.id,
      name:           party.name,
      phone:          party.phone,
      gstin:          party.gstin,
      type:           party.type,
      meta:           party.meta,
      currentBalance: Number(party.balance),
      creditLimit:    Number(party.creditLimit),
      loyaltyPts:     party.loyaltyPts,
    },
    ledger,
    summary: {
      totalDebit,
      totalCredit,
      closingBalance:  runningBalance,
      invoiceCount:    saleInvoices.length,
      totalPurchases:  totalDebit,
      avgInvoiceValue: saleInvoices.length > 0
        ? Math.round(totalDebit / saleInvoices.length)
        : 0,
      lastPurchaseDate: saleInvoices.length > 0
        ? saleInvoices[saleInvoices.length - 1]!.date
        : null,
    },
  }
}
