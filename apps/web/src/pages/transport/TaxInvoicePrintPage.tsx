// Printable TAX INVOICE (A4 portrait) — drawn to the proportions of the firms' paper bill. Every row height, column line, text position
// and font size comes from BILL_LAYOUT (@billing/shared), measured off the scanned samples, and is scaled with the paper width
// (container-query units), so the bill keeps the paper bill's look at any size. The server PDF draws from the same spec.
// Works for both firms: the data and wording come from buildTaxInvoice, shared with the PDF.
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router-dom'
import { Printer } from 'lucide-react'
import { buildTaxInvoice, BILL_LAYOUT as L } from '@billing/shared'
import { api } from '@/lib/api'
import { useFirms } from '@/hooks/useFirms'
import { PrintToolbar } from '@/components/transport/PrintToolbar'

const COPIES = [['original', 'Original'], ['duplicate', 'Duplicate'], ['triplicate', 'Triplicate']] as const
const INK = '#111827'
const OUTER = L.W + 2 * L.frame                       // the frame's outer width, in scan pixels = 100cqw
const u = (px: number) => `${((px * 100) / OUTER).toFixed(4)}cqw`

/** A text label placed by its vertical centre (and its left or right edge), like the measured paper bill. */
function Tx({ x, right, y, size, b, i, serif, w, align, children, style }: {
  x?: number; right?: number; y: number; size: number; b?: boolean; i?: boolean; serif?: boolean; w?: number; align?: 'left' | 'center' | 'right'
  children: React.ReactNode; style?: React.CSSProperties
}) {
  return (
    <span style={{
      position: 'absolute', top: u(y + L.textNudge), transform: 'translateY(-50%)', fontSize: u(size), fontWeight: b ? 700 : 400, fontStyle: i ? 'italic' : undefined,
      lineHeight: 1, whiteSpace: 'nowrap', ...(right !== undefined ? { right: u(right) } : { left: u(x ?? 0) }),
      ...(w ? { width: u(w) } : {}), ...(align ? { textAlign: align } : {}),
      ...(serif ? { fontFamily: 'Georgia, "Times New Roman", serif' } : {}), ...style,
    }}>{children}</span>
  )
}

const Row = ({ h, grey, last, children, style }: { h: number; grey?: boolean; last?: boolean; children?: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ position: 'relative', height: u(h), flexShrink: 0, boxSizing: 'border-box', background: grey ? L.grey : undefined, borderBottom: last ? undefined : `${u(L.line)} solid ${INK}`, ...style }}>{children}</div>
)
const VLine = ({ x }: { x: number }) => <div style={{ position: 'absolute', top: 0, bottom: 0, left: u(x - L.line / 2), width: u(L.line), background: INK }} />

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
  const F = L.font
  const freight = v.kind === 'freight'
  const colX = L.cols.reduce<number[]>((a, c) => [...a, (a[a.length - 1] ?? 0) + c], [])      // right edge of each column
  const bounds = colX.slice(0, -1)                                                          // the six column lines
  const padOf = [L.body.srPad, 8, 0, 10, 11, 10, L.padR]                                          // text padding per column (left for 0-1, right for 3-6)
  const rightPaneW = L.W - L.footSplit

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <style>{`
        @media print { @page { size: A4 portrait; margin: 8mm } html, body { background: #fff } }
        .inv, .inv * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact }
        .inv { font-family: Arial, Helvetica, sans-serif; color: ${INK}; }
      `}</style>

      <PrintToolbar width={794}>
        <select className="input w-40" value={copy[0]} onChange={(e) => { const n = new URLSearchParams(sp); n.set('copy', e.target.value); setSp(n, { replace: true }) }}>
          {COPIES.map(([k, l]) => <option key={k} value={k}>{l} copy</option>)}
        </select>
        <button type="button" className="btn-primary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Print</button>
      </PrintToolbar>

      <div className="max-w-[794px] mx-auto bg-white print:max-w-none" style={{ containerType: 'inline-size' }}>
        <div className="inv" style={{ border: `${u(L.frame)} solid ${INK}`, minHeight: '281mm', display: 'flex', flexDirection: 'column', position: 'relative' }}>

          {/* Title band: logo, firm name */}
          <Row h={L.rows.band} grey style={{ overflow: 'visible' }}>
            {v.firm.logo && <img src={v.firm.logo} alt="" style={{ position: 'absolute', zIndex: 2, left: u(L.logo.x), top: u(L.logo.y), height: u(L.logo.h), maxWidth: u(150), objectFit: 'contain' }} />}
            <Tx x={0} w={L.W} align="center" y={L.title.y} size={F.firm} b serif style={{ textTransform: 'uppercase' }}>{v.firm.name}</Tx>
          </Row>
          <Row h={L.rows.address}><Tx x={0} w={L.W} align="center" y={L.address.y} size={F.address}>{v.firm.addressLine}</Tx></Row>

          {/* Debit Memo · TAX INVOICE · Original */}
          <Row h={L.rows.top}>
            <Tx x={L.padL} y={L.topRow.y} size={F.topSide} b>{v.topLeft}</Tx>
            <Tx x={0} w={L.W} align="center" y={L.topRow.y} size={F.topTitle} b>{v.docTitle}</Tx>
            <Tx right={L.padR} y={L.topRow.y} size={F.topSide} b>{copy[1]}</Tx>
          </Row>

          {/* Bill to · invoice no / date */}
          <Row h={L.rows.bill}>
            <VLine x={L.billSplit} />
            <Tx x={L.padL} y={L.billBlock.ms} size={F.ms} b>M/s. :</Tx>
            <Tx x={L.billBlock.nameX} y={L.billBlock.ms} size={F.name} b>{v.billTo.name.toUpperCase()}</Tx>
            {v.billTo.addressLines.map((a, k) => <Tx key={k} x={L.billBlock.nameX} y={L.billBlock.addr + k * L.billBlock.addrPitch} size={F.addr} style={{ textTransform: 'uppercase' }}>{a}</Tx>)}
            {v.billTo.placeOfSupply && <><Tx x={L.padL} y={L.billBlock.place} size={F.place} b>Place of Supply :</Tx><Tx x={L.billBlock.placeValueX} y={L.billBlock.place} size={F.place}>{v.billTo.placeOfSupply}</Tx></>}
            {v.billTo.gstin && <><Tx x={L.padL} y={L.billBlock.gstin} size={F.place} b>GSTIN No.</Tx><Tx x={L.billBlock.gstinColon} y={L.billBlock.gstin} size={F.place}>:</Tx><Tx x={L.billBlock.placeValueX} y={L.billBlock.gstin} size={F.place}>{v.billTo.gstin}</Tx></>}
            <div style={{ position: 'absolute', top: 0, left: u(L.billSplit), right: 0, height: u(L.invBox.height), background: L.grey, borderBottom: `${u(L.line)} solid ${INK}` }}>
              <Tx x={L.invBox.label.x} y={L.invBox.label.y1} size={F.box} b>{v.numberLabel}</Tx>
              <Tx x={L.invBox.colon} y={L.invBox.label.y1} size={F.box}>:</Tx><Tx x={L.invBox.value} y={L.invBox.label.y1} size={F.box}>{v.number}</Tx>
              <Tx x={L.invBox.label.x} y={L.invBox.label.y2} size={F.box} b>Date</Tx>
              <Tx x={L.invBox.colon} y={L.invBox.label.y2} size={F.box}>:</Tx><Tx x={L.invBox.value} y={L.invBox.label.y2} size={F.box}>{v.date}</Tx>
            </div>
            {v.reference && <Tx x={L.billSplit + L.invBox.label.x} y={L.invBox.height + 24} size={F.addr} b>{v.reference}</Tx>}
          </Row>

          {/* Items header */}
          <Row h={L.rows.head} grey>
            {bounds.map((x) => <VLine key={x} x={x} />)}
            {['SrNo', 'Product Name', 'HSN/SAC', 'Qty', 'Rate', 'GST %', 'Amount'].map((h, k) => {
              const left = k === 0 ? 0 : colX[k - 1]!
              return k === 0
                ? <Tx key={h} x={L.padL} y={L.rows.head / 2} size={F.head} b>{h}</Tx>
                : <Tx key={h} x={left} w={L.cols[k]!} align="center" y={L.rows.head / 2} size={F.head} b>{h}</Tx>
            })}
          </Row>

          {/* Items — the table stretches to fill the page, like the paper bill */}
          <div style={{ position: 'relative', flex: 1, minHeight: u(L.bodyMin), borderBottom: `${u(L.line)} solid ${INK}` }}>
            {bounds.map((x) => <VLine key={x} x={x} />)}
            <div style={{ paddingTop: u(L.body.firstY - L.body.pitch / 2) }}>
              {v.lines.map((l) => {
                const cells = [String(l.sr), l.description.toUpperCase(), l.hsn, l.qty, l.rate, l.gst, l.amount]
                return (
                  <div key={l.sr} style={{ display: 'grid', gridTemplateColumns: L.cols.map(u).join(' '), height: u(L.body.pitch), alignItems: 'center', fontSize: u(F.body), lineHeight: 1.1 }}>
                    {cells.map((c, k) => (
                      <div key={k} style={{ paddingLeft: k <= 1 ? u(padOf[k]!) : 0, paddingRight: k >= 3 ? u(padOf[k]!) : 0, textAlign: k <= 1 ? 'left' : k === 2 ? 'center' : 'right', overflow: 'hidden', whiteSpace: k === 1 ? 'normal' : 'nowrap' }}>{c}</div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Bank, words, note  |  totals */}
          <div style={{ display: 'flex', flexShrink: 0 }}>
            <div style={{ width: u(L.footSplit), flexShrink: 0, borderRight: `${u(L.line)} solid ${INK}` }}>
              <Row h={L.rows.gstin} grey><Tx x={L.padL} y={L.rows.gstin / 2} size={F.gstin} b>GSTIN No.: {v.firm.gstin}</Tx></Row>
              <Row h={L.rows.bank}>
                {v.firm.bank && ([['Bank Name', v.firm.bank.name], ['Bank A/c No.', v.firm.bank.account], ['RTGS/IFSC Code', v.firm.bank.ifsc]] as const).map(([lab, val], k) => (
                  <span key={lab}>
                    <Tx x={L.padL} y={L.bank.y + k * L.bank.pitch} size={F.bankL} b>{lab}</Tx>
                    <Tx x={L.bank.colon} y={L.bank.y + k * L.bank.pitch} size={F.bankV}>:</Tx>
                    <Tx x={L.bank.value} y={L.bank.y + k * L.bank.pitch} size={F.bankV}>{val}</Tx>
                  </span>
                ))}
              </Row>
              <Row h={L.rows.words}>
                {([['Total GST', v.words.gst, L.words.gstY], [v.totalLabel, v.words.total, L.words.totalY]] as const).map(([lab, txt, y]) => (
                  <span key={lab}>
                    <Tx x={L.padL} y={y} size={F.wordsLabel} b>{lab}</Tx>
                    <Tx x={L.words.colon} y={y} size={F.wordsLabel}>:</Tx>
                    <span style={{ position: 'absolute', left: u(L.words.x), top: u(y - L.words.pitch / 2), width: u(L.words.width), fontSize: u(freight ? F.wordsFreight : F.wordsGoods), fontStyle: freight ? 'italic' : undefined, lineHeight: u(L.words.pitch) }}>{txt}</span>
                  </span>
                ))}
              </Row>
              <Row h={L.rows.note}>
                <span style={{ position: 'absolute', left: u(L.padL), top: u(L.note.y), transform: 'translateY(-50%)', fontSize: u(F.note), lineHeight: 1, whiteSpace: 'pre-line' }}>Note : {v.note}</span>
              </Row>
            </div>

            <div style={{ flex: 1 }}>
              <Row h={L.rows.gstin} grey>
                <Tx x={L.totals.padL} y={L.totals.subY} size={F.subL} b>Sub Total</Tx>
                <Tx right={L.totals.padR} y={L.totals.subY} size={F.subV} b>{v.totals.subTotal}</Tx>
              </Row>
              <Row h={L.rows.bank + L.rows.words}>
                <Tx x={L.totals.padL} y={L.totals.taxableY} size={F.taxable} b>Taxable Amount</Tx>
                <Tx right={L.totals.padR} y={L.totals.taxableY} size={F.taxable} b>{v.totals.taxable}</Tx>
                {v.totals.taxRows.map((r, k) => (
                  <span key={r.label}>
                    <Tx x={L.totals.padL} y={L.totals.taxY + k * L.totals.taxPitch} size={F.tax}>{r.label}</Tx>
                    {r.rate && <Tx right={L.totals.rateRight} y={L.totals.taxY + k * L.totals.taxPitch} size={F.tax}>{r.rate}</Tx>}
                    <Tx right={L.totals.padR} y={L.totals.taxY + k * L.totals.taxPitch} size={F.tax}>{r.amount}</Tx>
                  </span>
                ))}
                <Tx x={L.totals.padL} y={L.totals.taxY + v.totals.taxRows.length * L.totals.taxPitch} size={F.tax}>Round Off</Tx>
                <Tx right={L.totals.padR} y={L.totals.taxY + v.totals.taxRows.length * L.totals.taxPitch} size={F.tax}>{v.totals.roundOff}</Tx>
              </Row>
              <Row h={L.rows.note} grey>
                <Tx x={L.totals.padL} y={L.totals.grandY} size={F.grandL} b>Grand Total</Tx>
                <Tx right={L.totals.padR} y={L.totals.grandY} size={F.grandV} b>{v.totals.grand}</Tx>
              </Row>
            </div>
          </div>

          {/* Terms / GTA declaration · signature */}
          <Row h={L.rows.decl}>
            <Tx x={L.padL} y={L.decl.headY} size={F.declHead} b>{v.footer.heading} :</Tx>
            <div style={{ position: 'absolute', left: u(L.padL), top: u(L.decl.firstY - L.decl.pitch / 2), width: u(L.decl.width), fontSize: u(F.decl), lineHeight: u(L.decl.pitch), fontStyle: v.footer.numbered ? undefined : 'italic' }}>
              {v.footer.numbered ? v.footer.lines.map((t, k) => <div key={k}>{k + 1}. {t}</div>) : v.footer.lines.map((t, k) => <div key={k}>{t.split(/_([^_]+)_/).map((seg, j) => (j % 2 ? <u key={j}>{seg}</u> : seg))}</div>)}
            </div>
            {v.signFor ? <Tx right={L.decl.forRight} y={L.decl.forY} size={F.sign}>For, {v.signFor.toUpperCase()}</Tx> : null}
            <Tx right={L.decl.signRight} y={L.decl.signY} size={F.sign}>(Authorised Signatory)</Tx>
          </Row>
          <Row h={L.rows.tail} last />
        </div>
      </div>
    </div>
  )
}
