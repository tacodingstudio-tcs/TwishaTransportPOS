import { FastifyInstance } from 'fastify'
import { z } from 'zod'

export async function grnRoutes(app: FastifyInstance) {

  // ── GET /api/grn ──────────────────────────────────────────────────────────
  app.get('/', async (req) => {
    const { poId, status, limit = '20', offset = '0' } = z.object({
      poId:   z.string().uuid().optional(),
      status: z.string().optional(),
      limit:  z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query)

    return req.db.goodsReceipt.findMany({
      where: {
        branchId: req.branchId,
        ...(poId   && { purchaseOrderId: poId }),
        ...(status && { status }),
      },
      include: {
        items: { include: { product: { select: { id: true, name: true } } } },
        purchaseOrder: { select: { id: true, poNo: true, party: { select: { id: true, name: true } } } },
      },
      orderBy: { grnDate: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    })
  })

  // ── GET /api/grn/:id ──────────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const grn = await req.db.goodsReceipt.findFirst({
      where: { id, branchId: req.branchId },
      include: {
        items: { include: { product: { select: { id: true, name: true, unit: true } } } },
        purchaseOrder: {
          select: {
            id: true, poNo: true, grandTotal: true,
            party: { select: { id: true, name: true, phone: true } },
            items: true,
          },
        },
      },
    })
    if (!grn) return reply.status(404).send({ error: 'GRN not found' })
    return grn
  })

  // ── POST /api/grn ─────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const body = z.object({
      purchaseOrderId: z.string().uuid().optional(),
      grnDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      invoiceNo:       z.string().max(50).optional(),
      invoiceDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      notes:           z.string().max(500).optional(),
      items: z.array(z.object({
        purchaseOrderItemId: z.string().uuid().optional(),
        productId:           z.string().uuid().optional(),
        description:         z.string().min(1).max(300),
        receivedQty:         z.number().positive(),
        unit:                z.string().default('pcs'),
        rate:                z.number().nonnegative(),
        batchNo:             z.string().optional(),
        expiryDate:          z.string().optional(),
      })).min(1),
    }).parse(req.body)

    const db = req.db

    // Auto-generate GRN number
    const count = await db.goodsReceipt.count({ where: { branchId: req.branchId } })
    const grnNo = `GRN-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`

    // 3-way match validation: if PO given, check each item qty doesn't exceed ordered
    if (body.purchaseOrderId) {
      const po = await db.purchaseOrder.findFirst({
        where: { id: body.purchaseOrderId, branchId: req.branchId },
        include: { items: true },
      })
      if (!po) return reply.status(404).send({ error: 'Purchase order not found' })
      if (po.status === 'cancelled') return reply.status(422).send({ error: 'PO is cancelled' })

      for (const item of body.items) {
        if (!item.purchaseOrderItemId) continue
        const poItem = po.items.find(i => i.id === item.purchaseOrderItemId)
        if (!poItem) return reply.status(422).send({ error: `PO item ${item.purchaseOrderItemId} not found` })

        const alreadyReceived = Number(poItem.receivedQty)
        const ordered         = Number(poItem.orderedQty)
        const nowReceiving    = item.receivedQty

        if (alreadyReceived + nowReceiving > ordered * 1.05) {
          // Allow 5% tolerance over-receipt
          return reply.status(422).send({
            error: `Over-receipt: ${item.description} — ordered ${ordered}, already received ${alreadyReceived}, trying to receive ${nowReceiving}`,
          })
        }
      }
    }

    const grn = await db.$transaction(async (tx) => {
      const created = await tx.goodsReceipt.create({
        data: {
          branchId:        req.branchId,
          purchaseOrderId: body.purchaseOrderId ?? null,
          grnNo,
          grnDate:         new Date(body.grnDate),
          invoiceNo:       body.invoiceNo ?? null,
          invoiceDate:     body.invoiceDate ? new Date(body.invoiceDate) : null,
          notes:           body.notes ?? null,
          status:          'posted',
          createdBy:       req.userId,
          items: {
            create: body.items.map(item => ({
              purchaseOrderItemId: item.purchaseOrderItemId ?? null,
              productId:           item.productId ?? null,
              description:         item.description,
              receivedQty:         item.receivedQty,
              unit:                item.unit,
              rate:                item.rate,
              total:               item.receivedQty * item.rate,
              batchNo:             item.batchNo ?? null,
              expiryDate:          item.expiryDate ? new Date(item.expiryDate) : null,
            })),
          },
        },
        include: { items: true },
      })

      // Create stock ledger entries for each item that has a productId
      for (const item of body.items) {
        if (!item.productId) continue
        const product = await tx.product.findFirst({
          where:  { id: item.productId },
          select: { trackStock: true },
        })
        if (!product?.trackStock) continue

        await tx.stockLedger.create({
          data: {
            branchId:  req.branchId,
            productId: item.productId,
            txnType:   'purchase',
            qty:       item.receivedQty,
            rate:      item.rate,
            refType:   'grn',
            refId:     created.id,
          },
        })
      }

      // Update PO item receivedQty and PO status
      if (body.purchaseOrderId) {
        for (const item of body.items) {
          if (!item.purchaseOrderItemId) continue
          await tx.purchaseOrderItem.update({
            where: { id: item.purchaseOrderItemId },
            data: { receivedQty: { increment: item.receivedQty } },
          })
        }

        // Recalculate PO status
        const po = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: body.purchaseOrderId },
          include: { items: true },
        })
        const allReceived = po.items.every(i => Number(i.receivedQty) >= Number(i.orderedQty))
        const anyReceived = po.items.some(i => Number(i.receivedQty) > 0)
        const newStatus   = allReceived ? 'received' : anyReceived ? 'partial' : po.status
        await tx.purchaseOrder.update({
          where: { id: body.purchaseOrderId },
          data:  { status: newStatus },
        })
      }

      return created
    })

    return reply.status(201).send(grn)
  })

  // ── POST /api/grn/:id/cancel ──────────────────────────────────────────────
  app.post('/:id/cancel', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params)
    const grn = await req.db.goodsReceipt.findFirst({
      where:   { id, branchId: req.branchId },
      include: { items: true },
    })
    if (!grn) return reply.status(404).send({ error: 'GRN not found' })
    if (grn.status === 'cancelled') return reply.status(409).send({ error: 'Already cancelled' })

    await req.db.$transaction(async (tx) => {
      // Reverse stock ledger entries created by this GRN
      for (const item of grn.items) {
        if (!item.productId) continue
        const product = await tx.product.findFirst({
          where:  { id: item.productId },
          select: { trackStock: true },
        })
        if (!product?.trackStock) continue

        await tx.stockLedger.create({
          data: {
            branchId:  req.branchId,
            productId: item.productId,
            txnType:   'adjustment',
            qty:       -Number(item.receivedQty),
            rate:      Number(item.rate),
            refType:   'grn_cancel',
            refId:     id,
          },
        })
      }

      await tx.goodsReceipt.update({ where: { id }, data: { status: 'cancelled' } })
    })

    return reply.status(204).send()
  })

  // ── GET /api/grn/match/:invoiceId ─────────────────────────────────────────
  // Returns matching status for a purchase_invoice: does a GRN exist with same PO?
  app.get('/match/:invoiceId', async (req, reply) => {
    const { invoiceId } = z.object({ invoiceId: z.string().uuid() }).parse(req.params)

    const invoice = await req.db.invoice.findFirst({
      where: { id: invoiceId, branchId: req.branchId, txnType: 'purchase_invoice' },
      select: { id: true, linkedInvoiceId: true, domainData: true },
    })
    if (!invoice) return reply.status(404).send({ error: 'Purchase invoice not found' })

    const domainData = invoice.domainData as Record<string, unknown> | null
    const poId = domainData?.purchase_order_id as string | undefined

    if (!poId) return { matched: false, reason: 'No PO linked to this invoice' }

    const grns = await req.db.goodsReceipt.findMany({
      where: { purchaseOrderId: poId, branchId: req.branchId, status: 'posted' },
      select: { id: true, grnNo: true, grnDate: true, status: true },
    })

    return {
      matched: grns.length > 0,
      poId,
      grns,
      reason: grns.length === 0 ? 'No GRN found for this PO' : undefined,
    }
  })
}
