// apps/api/src/workers/pdf.worker.ts
//
// Runs as a SEPARATE process from the API server.
// Start with: node dist/workers/index.js
//
// Uses getTenantDb(schemaName) to connect to the correct per-tenant schema.
// The job payload must include schemaName — invoice service always sends it.

import { Worker, type Job } from 'bullmq'
import { generateBothFormats, type InvoiceData } from '@billing/pdf'
import { getTenantDb } from '../lib/tenant-db.js'
import { redis } from '../lib/redis.js'
import type { PrismaClient } from '@billing/db'

interface PdfJob {
  invoiceId:  string
  branchId:   string
  schemaName: string
}

// =============================================================================
// fetchInvoiceData — queries the correct tenant schema
// =============================================================================
async function fetchInvoiceData(
  db:        PrismaClient,
  invoiceId: string,
  branchId:  string,
): Promise<InvoiceData> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, branchId },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: {
          product: { select: { name: true, unit: true } },
        },
      },
      party: {
        select: { name: true, phone: true, gstin: true, address: true },
      },
    },
  })

  if (!invoice) throw new Error(`Invoice ${invoiceId} not found in branchId ${branchId}`)

  // Branch info comes from the same tenant schema
  const branch = await db.branch.findUnique({
    where:  { id: branchId },
    select: { name: true, gstin: true, address: true, stateCode: true },
  })
  if (!branch) throw new Error(`Branch ${branchId} not found`)

  const branchAddr = branch.address as Record<string, string> | null
  const partyAddr  = (invoice.party?.address as Record<string, string> | null) ?? null
  const isInterState = !!(
    branch.stateCode && partyAddr?.['stateCode'] &&
    branch.stateCode !== partyAddr['stateCode']
  )

  return {
    number:      invoice.number,
    date:        invoice.date,
    dueDate:     invoice.dueDate,
    txnType:     invoice.txnType,
    status:      invoice.status,

    branchName:    branch.name,
    branchGstin:   branch.gstin,
    branchAddress: branchAddr,
    stateCode:     branch.stateCode,

    partyName:    invoice.party?.name   ?? null,
    partyPhone:   invoice.party?.phone  ?? null,
    partyGstin:   invoice.party?.gstin  ?? null,
    partyAddress: partyAddr,

    subtotal:    Number(invoice.subtotal),
    discountAmt: Number(invoice.discountAmt),
    taxableAmt:  Number(invoice.taxableAmt),
    cgstTotal:   Number(invoice.cgstTotal),
    sgstTotal:   Number(invoice.sgstTotal),
    igstTotal:   Number(invoice.igstTotal),
    roundOff:    Number(invoice.roundOff),
    grandTotal:  Number(invoice.grandTotal),
    paidAmt:     Number(invoice.paidAmt),

    notes:       invoice.notes,
    isInterState,

    items: invoice.items.map((item) => ({
      description: item.description,
      hsnSacCode:  item.hsnSacCode,
      qty:         Number(item.qty),
      unit:        item.unit,
      rate:        Number(item.rate),
      discountPct: Number(item.discountPct),
      taxableAmt:  Number(item.taxableAmt),
      gstRate:     Number(item.gstRate),
      cgstAmt:     Number(item.cgstAmt),
      sgstAmt:     Number(item.sgstAmt),
      igstAmt:     Number(item.igstAmt),
      total:       Number(item.total),
    })),

    format: 'a4',
  }
}

// =============================================================================
// PDF Worker
// =============================================================================
const worker = new Worker<PdfJob>(
  'pdf-generation',
  async (job: Job<PdfJob>) => {
    const { invoiceId, branchId, schemaName } = job.data

    if (!schemaName) throw new Error(`Job ${job.id} missing schemaName — cannot resolve tenant DB`)

    console.log(`[PDF Worker] Processing invoice ${invoiceId} (schema: ${schemaName})`)

    const db         = getTenantDb(schemaName)
    const invoiceData = await fetchInvoiceData(db, invoiceId, branchId)

    const { a4, thermal } = await generateBothFormats(invoiceId, invoiceData)

    console.log(
      `[PDF Worker] Done: ${invoiceId} ` +
      `A4=${(a4.sizeBytes / 1024).toFixed(0)}KB ` +
      `thermal=${(thermal.sizeBytes / 1024).toFixed(0)}KB ` +
      `in ${a4.durationMs + thermal.durationMs}ms`
    )

    // Store paths in Redis so the API's GET /:id/pdf can serve them
    await redis.setex(
      `pdf:${invoiceId}`,
      60 * 60 * 24,  // 24h TTL
      JSON.stringify({
        a4Path:      a4.filePath,
        thermalPath: thermal.filePath,
        generatedAt: new Date().toISOString(),
      })
    )

    // Production: upload to Azure Blob (uncomment when ready)
    // if (process.env['STORAGE_TYPE'] === 'azure') {
    //   const blobUrl = await uploadToAzureBlob(a4.filePath, `invoices/${invoiceId}-a4.pdf`)
    //   await redis.setex(`pdf:url:${invoiceId}`, 86400, blobUrl)
    // }

    return { a4Path: a4.filePath, thermalPath: thermal.filePath }
  },
  {
    connection:  redis,
    concurrency: 3,
    limiter: { max: 10, duration: 5000 },
  }
)

worker.on('completed', (job) => {
  console.log(`[PDF Worker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`[PDF Worker] Job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
  console.error('[PDF Worker] Worker error:', err.message)
})

console.log('[PDF Worker] Started — listening for pdf-generation queue')

process.on('SIGTERM', async () => {
  await worker.close()
  await redis.quit()
  process.exit(0)
})
