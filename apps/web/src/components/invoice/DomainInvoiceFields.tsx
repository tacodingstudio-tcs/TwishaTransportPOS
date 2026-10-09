// src/components/invoice/DomainInvoiceFields.tsx
//
// Domain-specific extra fields shown on the Create Invoice page.
// Data flows up as a flat patch via onChange so the parent can merge into domainData.
// Keys must match the invoiceDataSchema in packages/domain-registry.
//
// Transport freight bills are normally raised from Freight billing (LR → bill); this card
// covers ad-hoc invoices (detention, demurrage, parts) so GST handling is still explicit.
import { GST_MODE_LABEL } from '@/components/transport/format'

interface Props {
  domainType: string
  data: Record<string, unknown>
  onChange: (patch: Record<string, unknown>) => void
}

export function DomainInvoiceFields({ domainType, data, onChange }: Props) {
  if (domainType !== 'transport') return null

  const gstMode = String(data['gst_mode'] ?? 'rcm')
  const credit  = data['credit_days'] == null ? '30' : String(data['credit_days'])

  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">Transport billing</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">GST treatment (for reference)</label>
          <select className="input" value={gstMode} onChange={(e) => onChange({ gst_mode: e.target.value })}>
            {Object.entries(GST_MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <p className="text-xs text-gray-400 mt-1">Set the GST % on each line to match. For LR-based freight use Freight billing instead.</p>
        </div>
        <div>
          <label className="label">Credit days</label>
          <input type="number" min="0" max="180" className="input" value={credit}
            onChange={(e) => onChange({ credit_days: Number(e.target.value || 0) })} />
        </div>
        <label className="flex items-end gap-2 text-sm text-gray-700 pb-2">
          <input type="checkbox" checked={Boolean(data['tds_applicable'])}
            onChange={(e) => onChange({ tds_applicable: e.target.checked })} />
          Customer deducts TDS
        </label>
      </div>
    </div>
  )
}
