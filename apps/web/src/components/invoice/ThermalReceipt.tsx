// src/components/invoice/ThermalReceipt.tsx
// Print-only thermal receipt — hidden on screen, visible only via window.print()
// Width defaults to 80mm (configurable via localStorage key pos_thermal_width)

import { useAuthStore } from '@/store/auth.store'

function getThermalWidth() {
  return localStorage.getItem('pos_thermal_width') ?? '80mm'
}

interface InvoiceItem {
  description: string
  qty: number
  rate: number
  discountPct?: number
  gstRate?: number
  unit?: string
  amount?: number
}

interface InvoiceData {
  number: string
  date: string
  txnType: string
  grandTotal: number | string
  paidAmt?: number | string
  notes?: string
  party?: { name?: string; phone?: string; gstin?: string } | null
  items?: InvoiceItem[]
  domainData?: Record<string, unknown>
}

export function ThermalReceipt({ invoice }: { invoice: InvoiceData }) {
  const branchName = useAuthStore((s) => s.branch?.name ?? 'Our Store')
  const width = getThermalWidth()
  const items: InvoiceItem[] = invoice.items ?? []
  const grandTotal = Number(invoice.grandTotal)
  const paidAmt = Number(invoice.paidAmt ?? grandTotal)
  const balanceDue = grandTotal - paidAmt

  const paymentSplits: Array<{ method: string; amount: number }> =
    (invoice.domainData as any)?.payment_splits ?? []

  const receiptStyle: React.CSSProperties = {
    display: 'none',
    width,
    maxWidth: width,
    fontFamily: 'monospace',
    fontSize: '12px',
    color: '#000',
    backgroundColor: '#fff',
    padding: '4mm 2mm',
    lineHeight: '1.4',
  }

  const dividerStyle: React.CSSProperties = {
    borderTop: '1px dashed #000',
    margin: '4px 0',
  }

  const centerStyle: React.CSSProperties = { textAlign: 'center' }
  const rightStyle: React.CSSProperties = { textAlign: 'right' }
  const boldStyle: React.CSSProperties = { fontWeight: 'bold' }
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between' }

  return (
    <>
      <style>{`
        @media print {
          body > * { display: none !important; }
          .thermal-receipt { display: block !important; }
          @page { margin: 0; size: ${width} auto; }
        }
      `}</style>
      <div className="thermal-receipt" style={receiptStyle}>
        {/* Header */}
        <div style={centerStyle}>
          <div style={{ ...boldStyle, fontSize: '15px' }}>{branchName}</div>
          <div style={{ fontSize: '11px', marginTop: '2px' }}>Tax Receipt</div>
        </div>

        <div style={dividerStyle} />

        {/* Invoice info */}
        <div style={rowStyle}>
          <span>Bill No:</span>
          <span style={boldStyle}>{invoice.number}</span>
        </div>
        <div style={rowStyle}>
          <span>Date:</span>
          <span>{new Date(invoice.date).toLocaleDateString('en-IN')}</span>
        </div>
        {invoice.party?.name && (
          <div style={rowStyle}>
            <span>Customer:</span>
            <span>{invoice.party.name}</span>
          </div>
        )}
        {invoice.party?.phone && (
          <div style={rowStyle}>
            <span>Phone:</span>
            <span>{invoice.party.phone}</span>
          </div>
        )}

        <div style={dividerStyle} />

        {/* Items */}
        <div style={{ ...boldStyle, fontSize: '11px', marginBottom: '2px' }}>
          {'Item'.padEnd(16)} {'Qty'.padStart(4)} {'Rate'.padStart(6)} {'Amt'.padStart(7)}
        </div>
        {items.map((item, i) => {
          const gross = item.qty * item.rate
          const disc = gross * ((item.discountPct ?? 0) / 100)
          const taxable = gross - disc
          const gst = taxable * ((item.gstRate ?? 0) / 100)
          const total = Math.round(taxable + gst)
          const name = item.description.length > 16
            ? item.description.slice(0, 15) + '…'
            : item.description
          return (
            <div key={i} style={{ fontSize: '11px' }}>
              <div style={rowStyle}>
                <span>{name}</span>
                <span style={boldStyle}>₹{total}</span>
              </div>
              <div style={{ color: '#555', fontSize: '10px' }}>
                {item.qty} {item.unit ?? ''} × ₹{item.rate}
                {item.discountPct ? ` − ${item.discountPct}% disc` : ''}
                {item.gstRate ? ` + ${item.gstRate}% GST` : ''}
              </div>
            </div>
          )
        })}

        <div style={dividerStyle} />

        {/* Totals */}
        <div style={{ ...rowStyle, ...boldStyle, fontSize: '13px' }}>
          <span>TOTAL</span>
          <span>₹{grandTotal.toFixed(0)}</span>
        </div>

        {paymentSplits.length > 0 && (
          <>
            <div style={{ fontSize: '11px', marginTop: '2px' }}>Payment:</div>
            {paymentSplits.map((sp, i) => (
              <div key={i} style={{ ...rowStyle, fontSize: '11px' }}>
                <span style={{ textTransform: 'capitalize' }}>{sp.method}</span>
                <span>₹{sp.amount}</span>
              </div>
            ))}
          </>
        )}

        {balanceDue > 0.5 && (
          <div style={{ ...rowStyle, color: '#c00', fontSize: '11px' }}>
            <span>Balance Due</span>
            <span>₹{balanceDue.toFixed(0)}</span>
          </div>
        )}

        {invoice.notes && (
          <>
            <div style={dividerStyle} />
            <div style={{ fontSize: '11px' }}>{invoice.notes}</div>
          </>
        )}

        <div style={dividerStyle} />

        {/* Footer */}
        <div style={{ ...centerStyle, fontSize: '11px' }}>
          <div>Thank you for your purchase!</div>
          <div style={{ marginTop: '2px' }}>Visit again</div>
        </div>
      </div>
    </>
  )
}
