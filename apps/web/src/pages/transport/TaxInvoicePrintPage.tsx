// Printable TAX INVOICE (A4 portrait) — the layout the firms' paper bills use: grey title band with logo,
// "Debit Memo / TAX INVOICE / Original", customer block, one tall item table, bank + totals, then terms (goods) or the
// GTA declaration (freight). Works for both firms: the data and wording come from buildTaxInvoice, shared with the PDF.
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { buildTaxInvoice } from '@billing/shared'
import { api } from '@/lib/api'
import { useFirms } from '@/hooks/useFirms'
import { PrintToolbar } from '@/components/transport/PrintToolbar'
import { PoweredBy } from '@/components/PoweredBy'

const COPIES = [['original', 'Original'], ['duplicate', 'Duplicate'], ['triplicate', 'Triplicate']] as const
const LINE = '#111827'
const GREY = '#d9d9d9'

const cell = (extra: React.CSSProperties = {}): React.CSSProperties => ({ padding: '3px 8px', ...extra })

export function TaxInvoicePrintPage() {
  const { id } = useParams<{ id: string }>()
  const [sp, setSp] = useSearchParams()
  const copy = COPIES.find(([k]) => k === sp.get('copy')) ?? COPIES[0]

  const { data: inv } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get(`/invoices/${id}`).then((r) => r.data) })
  const { data: firmData } = useFirms()

  const view = useMemo(() => {
    if (!inv) return null
    const firm = firmData?.firms.find((f) => f.id === inv.branchId) ?? firmData?.firms.find((f) => f.id === firmData.currentFirmId)
    if (!firm) return null
    return buildTaxInvoice({ invoice: inv, party: inv.party ?? null, firm })
  }, [inv, firmData])

  useEffect(() => {
    if (view) document.title = `${view.docKind === 'invoice' ? 'Invoice' : view.docKind === 'credit_note' ? 'Credit note' : 'Debit note'} ${view.number}`
    if (view && sp.get('auto') === '1') setTimeout(() => window.print(), 500)
  }, [view, sp])

  if (!view) return <div className="p-8 text-center text-gray-400">Loading…</div>

  const v = view
  const hasTax = v.totals.taxRows.length > 0

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <style>{`
        @media print { @page { size: A4 portrait; margin: 8mm } html, body { background: #fff } }
        .inv, .inv * { box-sizing: border-box }
        .inv { font-family: Arial, Helvetica, sans-serif; color: ${LINE}; font-size: 13px; }
      `}</style>

      <PrintToolbar width={794}>
        <select className="input w-40" value={copy[0]} onChange={(e) => { const n = new URLSearchParams(sp); n.set('copy', e.target.value); setSp(n, { replace: true }) }}>
          {COPIES.map(([k, l]) => <option key={k} value={k}>{l} copy</option>)}
        </select>
        <button type="button" className="btn-primary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Print</button>
      </PrintToolbar>

      <div className="inv max-w-[794px] mx-auto bg-white print:max-w-none" style={{ border: `2px solid ${LINE}`, minHeight: '281mm', display: 'flex', flexDirection: 'column' }}>

        {/* Title band: firm name, logo, address */}
        <div style={{ background: GREY, borderBottom: `1px solid ${LINE}`, position: 'relative', textAlign: 'center', padding: '10px 70px 8px' }}>
          {v.firm.logo && (
            <img src={v.firm.logo} alt="" style={{ position: 'absolute', left: 10, top: 6, height: 46, maxWidth: 110, objectFit: 'contain' }} />
          )}
          <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 700, fontSize: 30, letterSpacing: 0.5, textTransform: 'uppercase', lineHeight: 1.15 }}>{v.firm.name}</div>
        </div>
        <div style={{ textAlign: 'center', padding: '8px 12px', borderBottom: `1px solid ${LINE}`, fontSize: 15 }}>{v.firm.addressLine}</div>

        {/* Debit Memo · TAX INVOICE · Original */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', borderBottom: `1px solid ${LINE}`, padding: '5px 8px' }}>
          <strong style={{ fontSize: 14 }}>{v.topLeft}</strong>
          <strong style={{ fontSize: 21, letterSpacing: 0.3 }}>{v.docTitle}</strong>
          <strong style={{ fontSize: 14, textAlign: 'right' }}>{copy[1]}</strong>
        </div>

        {/* Bill to · invoice no / date */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.9fr 1fr', borderBottom: `1px solid ${LINE}` }}>
          <div style={{ padding: '6px 8px', borderRight: `1px solid ${LINE}`, lineHeight: 1.45 }}>
            <div><strong style={{ fontSize: 15 }}>M/s. :</strong>&nbsp; <strong style={{ fontSize: 17 }}>{v.billTo.name.toUpperCase()}</strong></div>
            {v.billTo.addressLines.map((l, i) => <div key={i} style={{ marginLeft: 38, textTransform: 'uppercase' }}>{l}</div>)}
            {v.billTo.placeOfSupply && <div style={{ marginTop: 3 }}><strong>Place of Supply :</strong> {v.billTo.placeOfSupply}</div>}
            {v.billTo.gstin && <div><strong>GSTIN No.</strong> &nbsp;&nbsp;&nbsp; : {v.billTo.gstin}</div>}
          </div>
          <div>
            <div style={{ background: GREY, padding: '6px 10px', lineHeight: 1.7, fontSize: 14 }}>
              <div><strong>{v.numberLabel}</strong> &nbsp;&nbsp; : &nbsp;&nbsp; {v.number}</div>
              <div><strong>Date</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; : &nbsp;&nbsp; {v.date}</div>
            </div>
            {v.reference && <div style={{ padding: '6px 10px', fontSize: 13, fontWeight: 700 }}>{v.reference}</div>}
          </div>
        </div>

        {/* Items — the table grows to fill the page, like the paper bill */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 360 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '6% 1fr 13% 11% 11% 8% 15%', background: GREY, borderBottom: `1px solid ${LINE}`, fontWeight: 700 }}>
            {['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'Amount'].map((h, i) => (
              <div key={h} style={cell({ textAlign: i >= 3 ? 'right' : i === 1 ? 'center' : 'left', borderRight: i < 6 ? `1px solid ${LINE}` : undefined })}>{h}</div>
            ))}
          </div>
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '6% 1fr 13% 11% 11% 8% 15%' }}>
            {([0, 1, 2, 3, 4, 5, 6] as const).map((col) => (
              <div key={col} style={{ borderRight: col < 6 ? `1px solid ${LINE}` : undefined }}>
                {v.lines.map((l) => {
                  const text = [String(l.sr), l.description, l.hsn, l.qty, l.rate, l.gst, l.amount][col]!
                  return <div key={l.sr} style={cell({ textAlign: col >= 3 ? 'right' : 'left', textTransform: col === 1 ? 'uppercase' : undefined, paddingTop: 5 })}>{text}</div>
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Bank + words | totals */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.75fr 1fr', borderTop: `1px solid ${LINE}` }}>
          <div style={{ borderRight: `1px solid ${LINE}` }}>
            <div style={{ background: GREY, borderBottom: `1px solid ${LINE}`, padding: '5px 8px', fontWeight: 700, fontSize: 15 }}>GSTIN No.: {v.firm.gstin}</div>
            {v.firm.bank && (
              <div style={{ padding: '5px 8px', borderBottom: `1px solid ${LINE}`, lineHeight: 1.55 }}>
                <div><strong>Bank Name</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; : &nbsp; {v.firm.bank.name}</div>
                <div><strong>Bank A/c No.</strong>&nbsp;&nbsp; : &nbsp; {v.firm.bank.account}</div>
                <div><strong>RTGS/IFSC Code</strong> : &nbsp; {v.firm.bank.ifsc}</div>
              </div>
            )}
            <div style={{ padding: '6px 8px', borderBottom: `1px solid ${LINE}`, lineHeight: 1.6 }}>
              <div><strong>Total GST</strong> &nbsp;&nbsp;&nbsp;: &nbsp; {v.words.gst}</div>
              <div style={{ marginTop: 10 }}><strong>{v.totalLabel}</strong> : &nbsp; {v.words.total}</div>
            </div>
            <div style={{ padding: '6px 8px', minHeight: 40 }}><strong>Note :</strong> <span style={{ whiteSpace: 'pre-line' }}>{v.note}</span></div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ background: GREY, borderBottom: `1px solid ${LINE}`, padding: '5px 8px', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15 }}>
              <span>Sub Total</span><span>{v.totals.subTotal}</span>
            </div>
            <div style={{ flex: 1, padding: '8px 8px 4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 }}><span>Taxable Amount</span><span>{v.totals.taxable}</span></div>
              {hasTax && v.totals.taxRows.map((r) => (
                <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '1fr 54px auto', marginTop: 3 }}>
                  <span>{r.label}</span><span style={{ textAlign: 'right', paddingRight: 8 }}>{r.rate}</span><span>{r.amount}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}><span>Round Off</span><span>{v.totals.roundOff}</span></div>
            </div>
            <div style={{ background: GREY, borderTop: `1px solid ${LINE}`, padding: '7px 8px', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 17 }}>
              <span>Grand Total</span><span>{v.totals.grand}</span>
            </div>
          </div>
        </div>

        {/* Terms / GTA declaration · signature */}
        <div style={{ borderTop: `1px solid ${LINE}`, padding: '6px 8px 8px', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'end' }}>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <strong style={{ fontSize: 13 }}>{v.footer.heading} :</strong>
            {v.footer.numbered
              ? v.footer.lines.map((t, i) => <div key={i}>{i + 1}. {t}</div>)
              : v.footer.lines.map((t, i) => <div key={i} style={{ fontStyle: 'italic' }}>{t}</div>)}
          </div>
          <div style={{ textAlign: 'right', fontSize: 12, minWidth: 190 }}>
            {v.signFor ? <div>For, <strong style={{ textTransform: 'uppercase' }}>{v.signFor}</strong></div> : null}
            <div style={{ height: 46 }} />
            <div>(Authorised Signatory)</div>
          </div>
        </div>
      </div>
      <PoweredBy className="text-center mt-1.5 !text-[10px]" />
    </div>
  )
}
