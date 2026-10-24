// apps/api/src/lib/transport-docs.ts
// Loads an LR / freight bill from the tenant schema and renders it to a PDF buffer.
// Shared by the PDF download routes and the WhatsApp notifier so both produce identical documents.

import { tbl, q1, q, httpError, ymd, type Ctx } from './transport-helpers.js'
import { buildTaxInvoice } from '@billing/shared'
import { renderLrPdf, renderTaxInvoicePdf, type BusinessHeader, type FreightBillData } from './transport-pdf.js'

const DEFAULT_BILL_TERMS = [
  'Payment is due within the credit period stated on this bill; interest may be charged on delayed payments.',
  'Please quote the bill number in all payment remittances.',
  'Disputes, if any, must be raised in writing within 7 days of receipt of this bill.',
  'Subject to jurisdiction of the carrier\'s city courts.',
]

function addrText(a: any): string {
  if (!a) return ''
  if (typeof a === 'string') return a
  return [a.line1, a.line2, a.city, /^\d+$/.test(String(a.state ?? '')) ? null : a.state, a.pincode].filter(Boolean).join(', ')
}

export async function loadBusiness(ctx: Ctx): Promise<{ header: BusinessHeader; config: Record<string, any> }> {
  const b = await q1<any>(ctx,
    `SELECT name, gstin, address, "domainConfig" FROM ${tbl(ctx.schemaName, 'branches')} WHERE id = $1::uuid`, ctx.branchId)
  const owner = await q1<any>(ctx,
    `SELECT phone FROM ${tbl(ctx.schemaName, 'users')} WHERE role = 'owner' AND "isActive" = true ORDER BY "createdAt" LIMIT 1`)
  const config = (b?.domainConfig ?? {}) as Record<string, any>
  return {
    config,
    header: {
      name: String(config['business_name'] ?? b?.name ?? 'Transport'),
      address: addrText(b?.address) || null,
      gstin: b?.gstin ?? null,
      phone: config['business_phone'] ?? owner?.phone ?? null,
    },
  }
}

export async function loadLr(ctx: Ctx, id: string): Promise<any> {
  const lr = await q1<any>(ctx,
    `SELECT * FROM ${tbl(ctx.schemaName, 'transport_lorry_receipts')} WHERE id = $1::uuid AND "branchId" = $2::uuid`, id, ctx.branchId)
  if (!lr) throw httpError(404, 'Lorry receipt not found')
  return lr
}

export async function lrPdf(ctx: Ctx, id: string, copies?: string[]): Promise<{ buffer: Buffer; filename: string; lr: any }> {
  const [lr, biz] = await Promise.all([loadLr(ctx, id), loadBusiness(ctx)])
  const buffer = await renderLrPdf(lr, biz.header, copies)
  return { buffer, filename: `LR-${String(lr.lrNo).replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`, lr }
}

export async function loadBill(ctx: Ctx, invoiceId: string): Promise<{ data: FreightBillData; invoice: any }> {
  const inv = await q1<any>(ctx,
    `SELECT i.*, p.name AS "partyName", p.gstin AS "partyGstin", p.phone AS "partyPhone", p.address AS "partyAddress"
     FROM ${tbl(ctx.schemaName, 'invoices')} i
     LEFT JOIN ${tbl(ctx.schemaName, 'parties')} p ON p.id = i."partyId"
     WHERE i.id = $1::uuid AND i."branchId" = $2::uuid`, invoiceId, ctx.branchId)
  if (!inv) throw httpError(404, 'Freight bill not found')
  const items = await q<any>(ctx,
    `SELECT description, "hsnSacCode", total, "itemMeta" FROM ${tbl(ctx.schemaName, 'invoice_items')}
     WHERE "invoiceId" = $1::uuid ORDER BY "sortOrder", id`, invoiceId)
  const dd = (inv.domainData ?? {}) as Record<string, any>
  const { config } = await loadBusiness(ctx)

  const data: FreightBillData = {
    number: inv.number, date: inv.date, dueDate: inv.dueDate, status: inv.status,
    partyName: inv.partyName ?? 'Customer', partyGstin: inv.partyGstin ?? null, partyAddress: addrText(inv.partyAddress) || null,
    gstMode: dd['gst_mode'] ?? null,
    isInterState: Number(inv.igstTotal) > 0,
    subtotal: Number(inv.taxableAmt), cgstTotal: Number(inv.cgstTotal), sgstTotal: Number(inv.sgstTotal), igstTotal: Number(inv.igstTotal),
    roundOff: Number(inv.roundOff), grandTotal: Number(inv.grandTotal), paidAmt: Number(inv.paidAmt),
    tdsAmount: Number(dd['tds_amount'] ?? 0),
    notes: inv.notes ?? null,
    terms: config['bill_terms'] ? String(config['bill_terms']).split('\n').filter(Boolean) : DEFAULT_BILL_TERMS,
    lines: items.map((it) => {
      const m = (it.itemMeta ?? {}) as Record<string, any>
      return {
        lrNo: m['lr_no'] ?? '', lrDate: m['lr_date'] ?? null, vehicleNo: m['vehicle_no'] ?? null,
        route: m['from_city'] && m['to_city'] ? `${m["from_city"]} to ${m["to_city"]}` : String(it.description ?? ''),
        goods: null,
        weightKg: m['charged_kg'] ?? m['weight_kg'] ?? null,
        amount: Number(it.total), sac: it.hsnSacCode ?? null, gatePassNo: m['gate_pass_no'] ?? null,
      }
    }),
  }
  return { data, invoice: inv }
}

/** "Original" / "Duplicate" / "Triplicate" — printed in the corner of the invoice. */
export const COPY_LABELS: Record<string, string> = { original: 'Original', duplicate: 'Duplicate', triplicate: 'Triplicate' }

/**
 * The bill as a PDF: the firm's TAX INVOICE, one page, in the layout of its paper bills (no statement of loads is added).
 */
export async function billPdf(ctx: Ctx, invoiceId: string, copy = 'original'): Promise<{ buffer: Buffer; filename: string; invoice: any; data: FreightBillData }> {
  const [{ data, invoice }, biz] = await Promise.all([loadBill(ctx, invoiceId), loadBusiness(ctx)])
  const [items, firm] = await Promise.all([
    q<any>(ctx,
      `SELECT description, "hsnSacCode", qty, unit, rate, "gstRate", "taxableAmt", "itemMeta"
       FROM ${tbl(ctx.schemaName, 'invoice_items')} WHERE "invoiceId" = $1::uuid ORDER BY "sortOrder", id`, invoiceId),
    q1<any>(ctx, `SELECT "stateCode", address FROM ${tbl(ctx.schemaName, 'branches')} WHERE id = $1::uuid`, ctx.branchId),
  ])
  const view = buildTaxInvoice({
    invoice: { ...invoice, items },
    party: { name: invoice.partyName ?? 'Customer', gstin: invoice.partyGstin, address: invoice.partyAddress },
    firm: {
      name: biz.header.name, gstin: biz.header.gstin, stateCode: firm?.stateCode, address: firm?.address,
      domainConfig: biz.config, logo: typeof biz.config['logo_data_url'] === 'string' ? biz.config['logo_data_url'] : null,
    },
  })
  const label = COPY_LABELS[copy] ?? 'Original'
  const buffer = await renderTaxInvoicePdf(view, label)      // the bill alone — no statement of loads is added
  const prefix = view.docKind === 'credit_note' ? 'CreditNote' : view.docKind === 'debit_note' ? 'DebitNote' : 'Bill'
  return { buffer, filename: `${prefix}-${String(invoice.number).replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`, invoice, data }
}

export { ymd }
