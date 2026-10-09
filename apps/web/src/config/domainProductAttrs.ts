// Domain-specific product/service attribute forms.
// Keys must match the Zod productAttrsSchema for the domain in packages/domain-registry
// (the API validates product.domainAttrs with it), so select options are the exact enum values.

export type AttrFieldType = 'text' | 'number' | 'select' | 'date' | 'boolean' | 'textarea'

export interface AttrField {
  key: string
  label: string
  type: AttrFieldType
  options?: string[]
  placeholder?: string
  unit?: string
  section?: string   // new section heading above this field
  wide?: boolean     // span full width
}

const DOMAIN_ATTRS: Record<string, AttrField[]> = {
  transport: [
    { key: 'item_kind', label: 'Item kind', type: 'select', section: 'What is this?',
      options: ['freight_service', 'ancillary_charge', 'spare_part', 'tyre', 'lubricant', 'fuel'] },
    { key: 'service_type', label: 'Service type', type: 'select',
      options: ['ftl', 'ltl', 'part_load', 'container', 'odc', 'tanker', 'cold_chain', 'parcel', 'other'] },
    { key: 'rate_basis', label: 'Rate basis', type: 'select',
      options: ['fixed', 'per_ton', 'per_kg', 'per_km', 'per_pkg', 'per_day'] },
    { key: 'vehicle_type_required', label: 'Vehicle type needed', type: 'select',
      options: ['mini_truck', 'pickup', 'lcv', 'icv', 'hcv', 'trailer', 'container', 'tanker', 'tipper', 'reefer', 'other'] },

    { key: 'brand', label: 'Brand', type: 'text', section: 'Spares & tyres', placeholder: 'e.g. MRF, Apollo, Castrol' },
    { key: 'part_no', label: 'Part no', type: 'text', placeholder: 'OEM / supplier part number' },
    { key: 'tyre_size', label: 'Tyre size', type: 'text', placeholder: 'e.g. 295/80 R22.5' },
  ],
}

export function getDomainAttrs(domainType: string): AttrField[] {
  return DOMAIN_ATTRS[domainType] ?? []
}
