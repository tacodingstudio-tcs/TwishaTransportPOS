// apps/api/src/services/email.service.ts
//
// Sends invoice receipt emails via SMTP (nodemailer).
// Required env vars:
//   SMTP_HOST      — e.g. smtp.gmail.com
//   SMTP_PORT      — e.g. 587
//   SMTP_USER      — sender email address
//   SMTP_PASS      — app password or SMTP password
//   SMTP_FROM_NAME — display name (optional, defaults to business name)
//
// In development (no SMTP env set): logs to console instead of sending.

const IS_DEV = !process.env['SMTP_HOST'] || process.env['NODE_ENV'] !== 'production'

interface ReceiptEmailParams {
  to:          string
  partyName:   string
  invoiceNo:   string
  invoiceDate: string | Date
  grandTotal:  number
  paidAmt:     number
  businessName: string
  items:       Array<{
    description: string
    qty:         number | string
    rate:        number | string
    total:       number | string
    unit?:       string
  }>
}

function formatINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function buildHtml(p: ReceiptEmailParams): string {
  const balanceDue = p.grandTotal - p.paidAmt
  const dateStr    = typeof p.invoiceDate === 'string'
    ? p.invoiceDate.slice(0, 10)
    : p.invoiceDate.toISOString().slice(0, 10)

  const itemRows = p.items.map(item => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${item.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:center;">${Number(item.qty)} ${item.unit ?? ''}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;">${formatINR(Number(item.rate))}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${formatINR(Number(item.total))}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);">

    <!-- Header -->
    <div style="background:#4f46e5;padding:24px 32px;">
      <div style="color:#fff;font-size:22px;font-weight:700;">${p.businessName}</div>
      <div style="color:#c7d2fe;font-size:13px;margin-top:4px;">Invoice Receipt</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="margin:0 0 16px;color:#374151;">Dear <strong>${p.partyName}</strong>,</p>
      <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">
        Thank you for your business! Please find your invoice receipt below.
      </p>

      <!-- Invoice meta -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="color:#6b7280;font-size:13px;padding:4px 0;">Invoice No</td>
          <td style="color:#111827;font-weight:600;text-align:right;">${p.invoiceNo}</td>
        </tr>
        <tr>
          <td style="color:#6b7280;font-size:13px;padding:4px 0;">Date</td>
          <td style="color:#111827;text-align:right;">${dateStr}</td>
        </tr>
      </table>

      <!-- Items table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;font-size:12px;">Item</th>
            <th style="padding:10px 12px;text-align:center;color:#6b7280;font-weight:600;font-size:12px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;font-size:12px;">Rate</th>
            <th style="padding:10px 12px;text-align:right;color:#6b7280;font-weight:600;font-size:12px;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <!-- Totals -->
      <table style="width:220px;margin-left:auto;border-collapse:collapse;font-size:14px;">
        <tr>
          <td style="padding:4px 0;color:#6b7280;">Grand Total</td>
          <td style="padding:4px 0;text-align:right;font-weight:700;font-size:16px;color:#111827;">${formatINR(p.grandTotal)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0;color:#6b7280;">Paid</td>
          <td style="padding:4px 0;text-align:right;color:#16a34a;font-weight:600;">${formatINR(p.paidAmt)}</td>
        </tr>
        ${balanceDue > 0.01 ? `
        <tr style="border-top:2px solid #f0f0f0;">
          <td style="padding:8px 0 4px;color:#dc2626;font-weight:600;">Balance Due</td>
          <td style="padding:8px 0 4px;text-align:right;color:#dc2626;font-weight:700;">${formatINR(balanceDue)}</td>
        </tr>` : `
        <tr style="border-top:2px solid #f0f0f0;">
          <td colspan="2" style="padding:8px 0 4px;color:#16a34a;font-weight:600;text-align:center;">✓ Fully Paid</td>
        </tr>`}
      </table>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:16px 32px;text-align:center;color:#9ca3af;font-size:12px;border-top:1px solid #f0f0f0;">
      ${p.businessName} · This is a computer-generated receipt
    </div>
  </div>
</body>
</html>`
}

export async function sendReceiptEmail(params: ReceiptEmailParams): Promise<void> {
  if (IS_DEV) {
    console.log(`[Email DEV] To: ${params.to}`)
    console.log(`[Email DEV] Subject: Invoice ${params.invoiceNo} from ${params.businessName}`)
    console.log(`[Email DEV] Grand Total: ${formatINR(params.grandTotal)}`)
    return
  }

  // Lazy-import nodemailer only in production so dev startup stays fast
  const nodemailer = await import('nodemailer')

  const transporter = nodemailer.createTransport({
    host:   process.env['SMTP_HOST']!,
    port:   Number(process.env['SMTP_PORT'] ?? 587),
    secure: Number(process.env['SMTP_PORT'] ?? 587) === 465,
    auth: {
      user: process.env['SMTP_USER']!,
      pass: process.env['SMTP_PASS']!,
    },
  })

  const fromName = process.env['SMTP_FROM_NAME'] ?? params.businessName
  const subject  = `Invoice ${params.invoiceNo} from ${params.businessName} — ${formatINR(params.grandTotal)}`

  await transporter.sendMail({
    from:    `"${fromName}" <${process.env['SMTP_USER']}>`,
    to:      params.to,
    subject,
    html:    buildHtml(params),
    text:    `Invoice ${params.invoiceNo} from ${params.businessName}. Amount: ${formatINR(params.grandTotal)}. Paid: ${formatINR(params.paidAmt)}.`,
  })
}
