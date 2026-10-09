// Domain-specific entity configuration for party/customer management.
// Transport vertical: parties are the carrier's customers (consignors / consignees / billing parties).

export interface EntityMetaField {
  key:         string
  label:       string
  type:        'text' | 'number' | 'select' | 'date'
  placeholder?: string
  options?:    string[]
  optional?:   boolean
}

export interface EntityConfig {
  singular:     string
  plural:       string
  singularLower: string
  // What to call the product/service catalogue for this domain
  catalogSingular: string
  catalogPlural:   string
  // Which meta fields to capture on the add/edit entity form
  metaFields:   EntityMetaField[]
  // Which columns to show in the list beyond name/phone/balance
  listColumns:  Array<{ key: string; label: string; fromMeta?: boolean }>
}

const DOMAIN_ENTITY: Record<string, EntityConfig> = {
  transport: {
    singular: 'Customer', plural: 'Customers', singularLower: 'customer',
    catalogSingular: 'Service / Item', catalogPlural: 'Services & Spares',
    metaFields: [
      { key: 'contact_person',  label: 'Contact Person',     type: 'text',   placeholder: 'Dispatch / accounts contact', optional: true },
      { key: 'billing_cycle',   label: 'Billing Cycle',      type: 'select', options: ['Per LR', 'Weekly', 'Fortnightly', 'Monthly'], optional: true },
      { key: 'default_freight', label: 'Usual Freight Type', type: 'select', options: ['Paid', 'To-Pay', 'To Be Billed'], optional: true },
    ],
    listColumns: [
      { key: 'billing_cycle', label: 'Billing', fromMeta: true },
    ],
  },
}

const DEFAULT_CONFIG: EntityConfig = {
  singular: 'Customer', plural: 'Customers', singularLower: 'customer',
  catalogSingular: 'Service', catalogPlural: 'Services',
  metaFields: [],
  listColumns: [],
}

export function getEntityConfig(domainType: string): EntityConfig {
  return DOMAIN_ENTITY[domainType] ?? DEFAULT_CONFIG
}
