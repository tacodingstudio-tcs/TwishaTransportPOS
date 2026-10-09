// apps/api/src/routes/inventory.ts
// Covers: suppliers, purchase orders, GRN, stock adjustments, stock transfers

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

export const inventoryRoutes: FastifyPluginAsync = async (app) => {

  // ════════════════════════════════════════════════════════════
  // SUPPLIERS — now served from parties (type=supplier)
  // These routes are kept for backward compatibility but delegate to parties
  // ════════════════════════════════════════════════════════════

  app.get('/suppliers', async (req) => {
    const { q, limit = '50', offset = '0' } = req.query as Record<string, string>
    const where: any = { branchId: req.branchId, isActive: true, type: 'supplier' }
    if (q) where.name = { contains: q, mode: 'insensitive' }
    const [data, total] = await Promise.all([
      req.db.party.findMany({ where, orderBy: { name: 'asc' }, take: Math.min(+limit, 500), skip: +offset }),
      req.db.party.count({ where }),
    ])
    return { data, meta: { total, limit: +limit, offset: +offset } }
  })

  app.get('/suppliers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const s = await req.db.party.findFirst({ where: { id, branchId: req.branchId, type: 'supplier' } })
    if (!s) return reply.status(404).send({ error: 'Supplier not found' })
    return s
  })

  app.post('/suppliers', async (req, reply) => {
    const body = z.object({
      name:          z.string().min(1).max(200).trim(),
      phone:         z.string().max(20).optional(),
      email:         z.string().email().optional(),
      gstin:         z.string().max(15).optional(),
      pan:           z.string().max(10).optional(),
      address:       z.record(z.unknown()).optional(),
      creditLimit:   z.coerce.number().nonnegative().optional(),
      meta:          z.record(z.unknown()).optional(),
    }).parse(req.body)
    const s = await req.db.party.create({
      data: {
        ...body,
        type:     'supplier',
        branchId: req.branchId,
        address:  body.address as any ?? undefined,
        meta:     body.meta as any ?? {},
      },
    })
    return reply.status(201).send(s)
  })

  app.patch('/suppliers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      name:        z.string().min(1).max(200).trim().optional(),
      phone:       z.string().max(20).optional(),
      email:       z.string().email().optional(),
      gstin:       z.string().max(15).optional(),
      creditLimit: z.coerce.number().nonnegative().optional(),
      isActive:    z.boolean().optional(),
    }).parse(req.body)
    const existing = await req.db.party.findFirst({ where: { id, branchId: req.branchId, type: 'supplier' } })
    if (!existing) return reply.status(404).send({ error: 'Supplier not found' })
    return req.db.party.update({ where: { id }, data: body })
  })

  app.delete('/suppliers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const existing = await req.db.party.findFirst({ where: { id, branchId: req.branchId, type: 'supplier' } })
    if (!existing) return reply.status(404).send({ error: 'Supplier not found' })
    await req.db.party.update({ where: { id }, data: { isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════
  // PURCHASE ORDERS
  // ════════════════════════════════════════════════════════════

  app.get('/purchase-orders', async (req) => {
    const { q, status, limit = '50', offset = '0' } = req.query as Record<string, string>
    const db    = req.db
    const where: any = { branchId: req.branchId }
    if (status) where.status = status
    if (q) where.OR = [
      { poNo:  { contains: q, mode: 'insensitive' } },
      { party: { name: { contains: q, mode: 'insensitive' } } },
    ]
    const [data, total] = await Promise.all([
      db.purchaseOrder.findMany({
        where,
        include: { party: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { poDate: 'desc' },
        take: Math.min(+limit, 200),
        skip: +offset,
      }),
      db.purchaseOrder.count({ where }),
    ])
    return { data, meta: { total, limit: +limit, offset: +offset } }
  })

  app.get('/purchase-orders/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const po = await req.db.purchaseOrder.findUnique({
      where:   { id },
      include: {
        party: true,
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } },
      },
    })
    if (!po) return reply.status(404).send({ error: 'Purchase order not found' })
    return po
  })

  app.post('/purchase-orders', async (req, reply) => {
    const body = z.object({
      partyId:      z.string().uuid().optional(),
      poDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes:        z.string().max(1000).optional(),
      items: z.array(z.object({
        productId:   z.string().uuid().optional(),
        description: z.string().min(1).max(500),
        orderedQty:  z.number().positive(),
        unit:        z.string().max(20).default('pcs'),
        rate:        z.number().nonnegative(),
        taxableAmt:  z.number().nonnegative(),
        gstRate:     z.number().min(0).max(28).default(0),
        cgstAmt:     z.number().nonnegative().default(0),
        sgstAmt:     z.number().nonnegative().default(0),
        igstAmt:     z.number().nonnegative().default(0),
        total:       z.number().nonnegative(),
      })).min(1),
    }).parse(req.body)

    const db   = req.db
    const count = await db.purchaseOrder.count({ where: { branchId: req.branchId } })
    const poNo  = `PO-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const subtotal   = body.items.reduce((s, i) => s + i.taxableAmt, 0)
    const cgstTotal  = body.items.reduce((s, i) => s + i.cgstAmt, 0)
    const sgstTotal  = body.items.reduce((s, i) => s + i.sgstAmt, 0)
    const igstTotal  = body.items.reduce((s, i) => s + i.igstAmt, 0)
    const grandTotal = subtotal + cgstTotal + sgstTotal + igstTotal

    const po = await db.purchaseOrder.create({
      data: {
        poNo,
        branchId:     req.branchId,
        partyId:      body.partyId ?? null,
        poDate:       new Date(body.poDate),
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        notes:        body.notes ?? null,
        status:       'draft',
        subtotal,
        taxableAmt:   subtotal,
        cgstTotal,
        sgstTotal,
        igstTotal,
        grandTotal,
        paidAmt:      0,
        createdBy:    req.userId,
        items: {
          create: body.items.map((item, idx) => ({
            productId:   item.productId ?? null,
            description: item.description,
            orderedQty:  item.orderedQty,
            receivedQty: 0,
            unit:        item.unit,
            rate:        item.rate,
            taxableAmt:  item.taxableAmt,
            gstRate:     item.gstRate,
            cgstAmt:     item.cgstAmt,
            sgstAmt:     item.sgstAmt,
            igstAmt:     item.igstAmt,
            total:       item.total,
            sortOrder:   idx,
          })),
        },
      },
      include: { items: true, party: { select: { id: true, name: true } } },
    })
    return reply.status(201).send(po)
  })

  app.patch('/purchase-orders/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      status:       z.enum(['draft', 'sent', 'partial', 'received', 'cancelled']).optional(),
      expectedDate: z.string().optional(),
      notes:        z.string().optional(),
    }).parse(req.body)
    const existing = await req.db.purchaseOrder.findFirst({ where: { id, branchId: req.branchId } })
    if (!existing) return reply.status(404).send({ error: 'Purchase order not found' })
    return req.db.purchaseOrder.update({ where: { id }, data: body })
  })

  app.post('/purchase-orders/:id/payment', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      amount:      z.number().positive(),
      paymentMode: z.enum(['cash', 'upi', 'bank', 'credit']).default('cash'),
      paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      referenceNo: z.string().max(100).optional(),
      notes:       z.string().max(500).optional(),
    }).parse(req.body)

    const db          = req.db
    const branchId    = req.branchId
    const paymentDate = body.paymentDate ? new Date(body.paymentDate) : new Date()

    // Fast pre-flight outside tx for obvious rejects
    const check = await db.purchaseOrder.findFirst({
      where:  { id, branchId },
      select: { status: true },
    })
    if (!check)                       return reply.status(404).send({ error: 'Purchase order not found' })
    if (check.status === 'cancelled') return reply.status(409).send({ error: 'Cannot record payment on a cancelled PO' })

    const result = await db.$transaction(async (tx) => {
      // Lock PO row — concurrent payment requests both read the same stale paidAmt
      // without this lock, passing the overpayment check independently.
      const locked = await tx.$queryRaw<Array<{
        paid_amt: number; grand_total: number; status: string; po_no: string; supplier_name: string | null
      }>>`
        SELECT
          "paidAmt"::float    AS paid_amt,
          "grandTotal"::float AS grand_total,
          status,
          "poNo"              AS po_no,
          (SELECT name FROM parties WHERE id = po."partyId") AS supplier_name
        FROM purchase_orders po
        WHERE id = ${id}::uuid AND "branchId" = ${branchId}::uuid
        FOR UPDATE
      `
      const po = locked[0]
      if (!po) throw Object.assign(new Error('Purchase order not found'), { statusCode: 404 })
      if (po.status === 'cancelled')
        throw Object.assign(new Error('Cannot record payment on a cancelled PO'), { statusCode: 409 })

      const newPaid   = po.paid_amt + body.amount
      const remaining = po.grand_total - newPaid
      if (newPaid > po.grand_total + 0.01)
        throw Object.assign(
          new Error(`Payment exceeds PO total. Outstanding: ₹${(po.grand_total - po.paid_amt).toFixed(2)}`),
          { statusCode: 422 }
        )

      await tx.purchaseOrder.update({ where: { id }, data: { paidAmt: newPaid } })

      await tx.expense.create({
        data: {
          branchId,
          date:        paymentDate,
          category:    'purchases',
          description: `Payment to ${po.supplier_name ?? 'supplier'} — ${po.po_no}`,
          amount:      body.amount,
          gstAmount:   0,
          gstRate:     0,
          paymentMode: body.paymentMode,
          referenceNo: body.referenceNo ?? po.po_no,
          notes:       body.notes ?? null,
          createdBy:   req.userId,
        },
      })

      return { newPaid, grandTotal: po.grand_total, remaining }
    })

    return {
      success:     true,
      paidAmt:     result.newPaid,
      grandTotal:  result.grandTotal,
      outstanding: Math.max(0, result.remaining),
      fullyPaid:   result.remaining <= 0.01,
    }
  })

  app.post('/purchase-orders/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const po = await req.db.purchaseOrder.findUnique({ where: { id } })
    if (!po) return reply.status(404).send({ error: 'Purchase order not found' })
    if (po.status === 'received') return reply.status(409).send({ error: 'Cannot cancel a fully received PO' })
    return req.db.purchaseOrder.update({ where: { id }, data: { status: 'cancelled' } })
  })

  // ════════════════════════════════════════════════════════════
  // GOODS RECEIPT (GRN)
  // ════════════════════════════════════════════════════════════

  app.get('/grn', async (req) => {
    const { limit = '50', offset = '0' } = req.query as Record<string, string>
    const db    = req.db
    const where = { branchId: req.branchId }
    const [data, total] = await Promise.all([
      db.goodsReceipt.findMany({
        where,
        include: { purchaseOrder: { select: { id: true, poNo: true } } },
        orderBy: { grnDate: 'desc' },
        take: Math.min(+limit, 200),
        skip: +offset,
      }),
      db.goodsReceipt.count({ where }),
    ])
    return { data, meta: { total } }
  })

  app.post('/grn', async (req, reply) => {
    const body = z.object({
      purchaseOrderId: z.string().uuid().optional(),
      grnDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      invoiceNo:       z.string().max(50).optional(),
      notes:           z.string().max(1000).optional(),
      items: z.array(z.object({
        productId:          z.string().uuid().optional(),
        purchaseOrderItemId:z.string().uuid().optional(),
        description:        z.string().max(500).default(''),
        receivedQty:        z.number().positive(),
        unit:               z.string().max(20).default('pcs'),
        rate:               z.number().nonnegative(),
        total:              z.number().nonnegative(),
      })).min(1),
    }).parse(req.body)

    const db       = req.db
    const branchId = req.branchId
    const count    = await db.goodsReceipt.count({ where: { branchId } })
    const grnNo    = `GRN-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const grn = await db.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          branchId,
          grnNo,
          purchaseOrderId: body.purchaseOrderId ?? null,
          grnDate:         new Date(body.grnDate),
          invoiceNo:       body.invoiceNo ?? null,
          notes:           body.notes ?? null,
          status:          'posted',
          createdBy:       req.userId,
          items: {
            create: body.items.map((i) => ({
              productId:          i.productId ?? null,
              purchaseOrderItemId:i.purchaseOrderItemId ?? null,
              description:        i.description,
              receivedQty:        i.receivedQty,
              unit:               i.unit,
              rate:               i.rate,
              total:              i.total,
            })),
          },
        },
        include: { items: true },
      })

      // Credit stock ledger — only for products with trackStock enabled
      const itemsWithProduct = body.items.filter((i) => i.productId)
      if (itemsWithProduct.length > 0) {
        const productIds   = itemsWithProduct.map((i) => i.productId!)
        const trackedProds = await tx.product.findMany({
          where:  { id: { in: productIds }, trackStock: true },
          select: { id: true },
        })
        const trackedSet = new Set(trackedProds.map((p) => p.id))
        const stockItems = itemsWithProduct.filter((i) => trackedSet.has(i.productId!))
        if (stockItems.length > 0) {
          await tx.stockLedger.createMany({
            data: stockItems.map((i) => ({
              branchId,
              productId: i.productId!,
              txnType:   'purchase',
              qty:       i.receivedQty,
              rate:      i.rate,
              refType:   'grn',
              refId:     receipt.id,
            })),
          })
        }
      }

      // Update PO received qtys + status
      if (body.purchaseOrderId) {
        const po = await tx.purchaseOrder.findUnique({
          where:   { id: body.purchaseOrderId },
          include: { items: true },
        })
        if (po) {
          const receivedMap = new Map(body.items.map((i) => [i.purchaseOrderItemId, i.receivedQty]))
          for (const item of po.items) {
            const extra = receivedMap.get(item.id) ?? 0
            if (extra > 0) {
              await tx.purchaseOrderItem.update({
                where: { id: item.id },
                data:  { receivedQty: Number(item.receivedQty) + extra },
              })
            }
          }
          const updated    = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } })
          const allDone    = updated.every((i) => Number(i.receivedQty) >= Number(i.orderedQty))
          const anyDone    = updated.some((i) => Number(i.receivedQty) > 0)
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data:  { status: allDone ? 'received' : anyDone ? 'partial' : po.status },
          })
        }
      }

      return receipt
    })

    return reply.status(201).send(grn)
  })

  // ════════════════════════════════════════════════════════════
  // STOCK ADJUSTMENTS
  // ════════════════════════════════════════════════════════════

  app.get('/adjustments', async (req) => {
    const { limit = '50', offset = '0' } = req.query as Record<string, string>
    const where = { branchId: req.branchId }
    const [data, total] = await Promise.all([
      req.db.stockAdjustment.findMany({
        where,
        include: { _count: { select: { items: true } } },
        orderBy: { adjDate: 'desc' },
        take: Math.min(+limit, 200),
        skip: +offset,
      }),
      req.db.stockAdjustment.count({ where }),
    ])
    return { data, meta: { total } }
  })

  app.get('/adjustments/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const adj = await req.db.stockAdjustment.findUnique({
      where:   { id },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    })
    if (!adj) return reply.status(404).send({ error: 'Adjustment not found' })
    return adj
  })

  app.post('/adjustments', async (req, reply) => {
    const body = z.object({
      adjDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason:  z.string().min(2).max(500),
      notes:   z.string().max(1000).optional(),
      items: z.array(z.object({
        productId:   z.string().uuid(),
        systemQty:   z.number(),
        physicalQty: z.number().nonnegative(),
        unit:        z.string().max(20).default('pcs'),
        rate:        z.number().nonnegative().optional(),
      })).min(1),
    }).parse(req.body)

    const db    = req.db
    const count = await db.stockAdjustment.count({ where: { branchId: req.branchId } })
    const adjNo = `ADJ-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const adj = await db.stockAdjustment.create({
      data: {
        branchId:  req.branchId,
        adjNo,
        adjDate:   new Date(body.adjDate),
        reason:    body.reason,
        notes:     body.notes ?? null,
        status:    'draft',
        createdBy: req.userId,
        items: {
          create: body.items.map((i) => ({
            productId:    i.productId,
            systemQty:    i.systemQty,
            physicalQty:  i.physicalQty,
            differenceQty:i.physicalQty - i.systemQty,
            rate:         i.rate ?? null,
          })),
        },
      },
      include: { items: true },
    })
    return reply.status(201).send(adj)
  })

  app.post('/adjustments/:id/post', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db  = req.db
    const adj = await db.stockAdjustment.findUnique({ where: { id }, include: { items: true } })
    if (!adj)                   return reply.status(404).send({ error: 'Adjustment not found' })
    if (adj.status !== 'draft') return reply.status(409).send({ error: 'Only draft adjustments can be posted' })

    await db.$transaction(async (tx) => {
      const nonZero = adj.items.filter((i) => Number(i.differenceQty) !== 0)
      if (nonZero.length > 0) {
        await tx.stockLedger.createMany({
          data: nonZero.map((i) => ({
            branchId:  req.branchId,
            productId: i.productId,
            txnType:   Number(i.differenceQty) > 0 ? 'adjustment_in' : 'adjustment_out',
            qty:       Number(i.differenceQty),
            rate:      i.rate ? Number(i.rate) : null,
            refType:   'stock_adjustment',
            refId:     adj.id,
          })),
        })
      }
      await tx.stockAdjustment.update({ where: { id }, data: { status: 'posted', approvedBy: req.userId, approvedAt: new Date() } })
    })

    return { success: true }
  })

  app.post('/adjustments/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const adj = await req.db.stockAdjustment.findUnique({ where: { id } })
    if (!adj)                    return reply.status(404).send({ error: 'Adjustment not found' })
    if (adj.status === 'posted') return reply.status(409).send({ error: 'Cannot cancel a posted adjustment' })
    return req.db.stockAdjustment.update({ where: { id }, data: { status: 'cancelled' } })
  })

  // ════════════════════════════════════════════════════════════
  // STOCK TRANSFERS
  // ════════════════════════════════════════════════════════════

  app.get('/transfers', async (req) => {
    const { q, status, limit = '50', offset = '0' } = req.query as Record<string, string>
    const db    = req.db
    const where: any = {
      OR: [{ fromBranchId: req.branchId }, { toBranchId: req.branchId }],
    }
    if (status) where.status = status
    if (q)      where.transferNo = { contains: q, mode: 'insensitive' }

    const [transfers, total] = await Promise.all([
      db.stockTransfer.findMany({
        where,
        include: { items: true, _count: { select: { items: true } } },
        orderBy: { transferDate: 'desc' },
        take: Math.min(+limit, 200),
        skip: +offset,
      }),
      db.stockTransfer.count({ where }),
    ])

    // Fetch branch names separately (no Prisma relation on model)
    const branchIds = [...new Set(transfers.flatMap((t) => [t.fromBranchId, t.toBranchId]))]
    const branches  = branchIds.length
      ? await db.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } })
      : []
    const branchMap = new Map(branches.map((b) => [b.id, b]))

    const data = transfers.map((t) => ({
      ...t,
      fromBranch: branchMap.get(t.fromBranchId) ?? { id: t.fromBranchId, name: t.fromBranchId },
      toBranch:   branchMap.get(t.toBranchId)   ?? { id: t.toBranchId,   name: t.toBranchId },
    }))

    return { data, meta: { total } }
  })

  app.get('/transfers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db = req.db
    const tr = await db.stockTransfer.findUnique({
      where:   { id },
      include: { items: { include: { product: { select: { id: true, name: true, sku: true, unit: true } } } } },
    })
    if (!tr) return reply.status(404).send({ error: 'Transfer not found' })

    const branches  = await db.branch.findMany({
      where:  { id: { in: [tr.fromBranchId, tr.toBranchId] } },
      select: { id: true, name: true },
    })
    const branchMap = new Map(branches.map((b) => [b.id, b]))

    return {
      ...tr,
      fromBranch: branchMap.get(tr.fromBranchId) ?? null,
      toBranch:   branchMap.get(tr.toBranchId)   ?? null,
    }
  })

  app.post('/transfers', async (req, reply) => {
    const body = z.object({
      toBranchId:   z.string().uuid(),
      transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      notes:        z.string().max(1000).optional(),
      items: z.array(z.object({
        productId: z.string().uuid(),
        sentQty:   z.number().positive(),
        unit:      z.string().max(20).default('pcs'),
        rate:      z.number().nonnegative().default(0),
      })).min(1),
    }).parse(req.body)

    const db           = req.db
    const fromBranchId = req.branchId

    if (fromBranchId === body.toBranchId)
      return reply.status(422).send({ error: 'Source and destination branch must be different' })

    const toBranch = await db.branch.findUnique({ where: { id: body.toBranchId } })
    if (!toBranch)          return reply.status(404).send({ error: 'Destination branch not found' })
    if (!toBranch.isActive) return reply.status(409).send({ error: 'Destination branch is inactive' })

    // ── Stock availability check ──────────────────────────────────────────────
    const productIds = body.items.map((i) => i.productId)
    const stockRows  = await db.$queryRaw<Array<{ productId: string; onHand: number }>>`
      SELECT "productId"::text, COALESCE(SUM(qty), 0)::float AS "onHand"
      FROM stock_ledger
      WHERE "branchId"  = ${fromBranchId}::uuid
        AND "productId" = ANY(${productIds}::uuid[])
      GROUP BY "productId"
    `
    const onHandMap    = new Map(stockRows.map((r) => [r.productId, r.onHand]))
    const insufficient = body.items.filter((i) => (onHandMap.get(i.productId) ?? 0) < i.sentQty)

    if (insufficient.length > 0) {
      const products  = await db.product.findMany({
        where:  { id: { in: insufficient.map((i) => i.productId) } },
        select: { id: true, name: true, unit: true },
      })
      const productMap = new Map(products.map((p) => [p.id, p]))
      return reply.status(422).send({
        error: 'Insufficient stock for one or more items',
        items: insufficient.map((i) => ({
          productId:   i.productId,
          productName: productMap.get(i.productId)?.name ?? i.productId,
          available:   onHandMap.get(i.productId) ?? 0,
          requested:   i.sentQty,
          unit:        productMap.get(i.productId)?.unit ?? i.unit,
        })),
      })
    }

    // ── Create transfer ───────────────────────────────────────────────────────
    const count      = await db.stockTransfer.count({ where: { fromBranchId } })
    const transferNo = `TRF-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    const transfer = await db.stockTransfer.create({
      data: {
        transferNo,
        fromBranchId,
        toBranchId:   body.toBranchId,
        transferDate: new Date(body.transferDate),
        notes:        body.notes ?? null,
        status:       'draft',
        createdBy:    req.userId,
        items: {
          create: body.items.map((i) => ({
            productId: i.productId,
            sentQty:   i.sentQty,
            receivedQty: 0,
            unit:      i.unit,
            rate:      i.rate,
          })),
        },
      },
      include: { items: { include: { product: { select: { id: true, name: true, unit: true } } } } },
    })

    return reply.status(201).send({
      ...transfer,
      fromBranch: { id: fromBranchId, name: 'Current branch' },
      toBranch:   { id: toBranch.id,  name: toBranch.name },
    })
  })

  app.post('/transfers/:id/dispatch', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const db       = req.db
    const transfer = await db.stockTransfer.findUnique({ where: { id }, include: { items: true } })
    if (!transfer)                   return reply.status(404).send({ error: 'Transfer not found' })
    if (transfer.status !== 'draft') return reply.status(409).send({ error: 'Only draft transfers can be dispatched' })

    await db.$transaction(async (tx) => {
      // Lock transfer row — prevent concurrent dispatches
      const lockedTransfer = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM stock_transfers WHERE id = ${id}::uuid FOR UPDATE
      `
      if (!lockedTransfer[0] || lockedTransfer[0].status !== 'draft')
        throw Object.assign(new Error('Only draft transfers can be dispatched'), { statusCode: 409 })

      // Stock check inside tx — prevents TOCTOU where a concurrent sale or
      // another dispatch depletes stock between the pre-flight check and the deduction.
      const productIds = transfer.items.map((i) => i.productId)
      // Lock product rows in sorted order (deadlock prevention)
      const sortedIds  = [...productIds].sort()
      await tx.$queryRaw`
        SELECT id FROM products WHERE id = ANY(${sortedIds}::uuid[]) ORDER BY id FOR UPDATE
      `
      const stockRows = await tx.$queryRaw<Array<{ productId: string; onHand: number }>>`
        SELECT "productId"::text, COALESCE(SUM(qty), 0)::float AS "onHand"
        FROM stock_ledger
        WHERE "branchId"  = ${transfer.fromBranchId}::uuid
          AND "productId" = ANY(${productIds}::uuid[])
        GROUP BY "productId"
      `
      const onHandMap    = new Map(stockRows.map((r) => [r.productId, r.onHand]))
      const insufficient = transfer.items.filter((i) => (onHandMap.get(i.productId) ?? 0) < Number(i.sentQty))
      if (insufficient.length > 0)
        throw Object.assign(
          new Error('Insufficient stock — quantities may have changed since draft was created'),
          { statusCode: 422 }
        )

      await tx.stockLedger.createMany({
        data: transfer.items.map((i) => ({
          branchId:  transfer.fromBranchId,
          productId: i.productId,
          txnType:   'transfer_out',
          qty:       -Number(i.sentQty),
          rate:      Number(i.rate),
          refType:   'stock_transfer',
          refId:     transfer.id,
        })),
      })
      await tx.stockTransfer.update({ where: { id }, data: { status: 'in_transit' } })
    })

    return { success: true, status: 'in_transit' }
  })

  app.post('/transfers/:id/receive', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const body = z.object({
      receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      items: z.array(z.object({
        id:          z.string().uuid(),
        receivedQty: z.number().nonnegative(),
      })).min(1),
    }).parse(req.body)

    const db       = req.db
    const transfer = await db.stockTransfer.findUnique({ where: { id }, include: { items: true } })
    if (!transfer)                        return reply.status(404).send({ error: 'Transfer not found' })
    if (transfer.status !== 'in_transit') return reply.status(409).send({ error: 'Transfer is not in transit' })

    const receivedMap = new Map(body.items.map((i) => [i.id, i.receivedQty]))

    await db.$transaction(async (tx) => {
      const creditItems = transfer.items.filter((i) => (receivedMap.get(i.id) ?? 0) > 0)
      if (creditItems.length > 0) {
        await tx.stockLedger.createMany({
          data: creditItems.map((i) => ({
            branchId:  transfer.toBranchId,
            productId: i.productId,
            txnType:   'transfer_in',
            qty:       receivedMap.get(i.id) ?? Number(i.sentQty),
            rate:      Number(i.rate),
            refType:   'stock_transfer',
            refId:     transfer.id,
          })),
        })
      }

      for (const item of transfer.items) {
        await tx.stockTransferItem.update({
          where: { id: item.id },
          data:  { receivedQty: receivedMap.get(item.id) ?? Number(item.sentQty) },
        })
      }

      await tx.stockTransfer.update({
        where: { id },
        data:  { status: 'received', receivedDate: new Date(body.receivedDate), receivedBy: req.userId },
      })
    })

    return { success: true, status: 'received' }
  })
}
