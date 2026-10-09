// packages/pdf/src/generator.ts
// Converts an InvoiceData object → PDF buffer using Puppeteer.
//
// Local (dev):  saves to /tmp/billing-files/invoices/{id}.pdf
// Production:   upload to Azure Blob, return public URL
//
// Puppeteer is intentionally in a separate package so:
//   1. It can be excluded from the API bundle (it's heavy — ~180 MB)
//   2. The worker process runs in a separate Node.js process from the API
//   3. A Puppeteer crash doesn't take down the API

import puppeteer, { type Browser } from 'puppeteer'
import fs from 'fs/promises'
import path from 'path'
import { renderInvoiceHTML, type InvoiceData } from './templates/invoice.template.js'

// Singleton browser — reused across multiple PDF jobs for performance.
// Creating a new browser per job adds 800ms–2s overhead.
let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser

  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',     // prevents crashes in Docker/limited memory
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  })

  // Clean up on process exit
  process.on('exit',    () => browser?.close())
  process.on('SIGTERM', () => browser?.close())

  return browser
}

export interface GeneratePDFOptions {
  invoiceId:  string
  data:       InvoiceData
  format?:    'a4' | 'thermal'
  outputDir?: string  // defaults to /tmp/billing-files/invoices
}

export interface GeneratePDFResult {
  filePath:    string
  sizeBytes:   number
  durationMs:  number
}

// =============================================================================
// generatePDF
// =============================================================================
export async function generatePDF(opts: GeneratePDFOptions): Promise<GeneratePDFResult> {
  const startTime = Date.now()
  const format    = opts.format ?? 'a4'
  const outputDir = opts.outputDir ?? '/tmp/billing-files/invoices'

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true })

  const fileName = `${opts.invoiceId}-${format}.pdf`
  const filePath = path.join(outputDir, fileName)

  const browser = await getBrowser()
  const page    = await browser.newPage()

  try {
    // Render the HTML template
    const html = renderInvoiceHTML({ ...opts.data, format })

    await page.setContent(html, {
      waitUntil: 'networkidle0',  // wait for all resources (no network calls in template)
      timeout:   10_000,
    })

    // Paper settings
    const pdfOptions =
      format === 'thermal'
        ? {
            // 80mm wide thermal roll — height auto (no page breaks)
            width:       '80mm',
            height:      '400mm',   // generous height, content clips naturally
            printBackground: true,
            margin: { top: '2mm', bottom: '2mm', left: '2mm', right: '2mm' },
          }
        : {
            format:      'A4' as const,
            printBackground: true,
            margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
          }

    const pdfBuffer = await page.pdf(pdfOptions)

    // Write to disk
    await fs.writeFile(filePath, pdfBuffer)

    const stats = await fs.stat(filePath)

    return {
      filePath,
      sizeBytes:  stats.size,
      durationMs: Date.now() - startTime,
    }
  } finally {
    await page.close()
  }
}

// =============================================================================
// generateBothFormats
// Generates A4 and thermal PDF simultaneously (Promise.all)
// =============================================================================
export async function generateBothFormats(
  invoiceId: string,
  data:       InvoiceData,
  outputDir?: string
): Promise<{ a4: GeneratePDFResult; thermal: GeneratePDFResult }> {
  const [a4, thermal] = await Promise.all([
    generatePDF({ invoiceId, data, format: 'a4',     outputDir }),
    generatePDF({ invoiceId, data, format: 'thermal', outputDir }),
  ])
  return { a4, thermal }
}
