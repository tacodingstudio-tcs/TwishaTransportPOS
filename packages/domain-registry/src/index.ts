// packages/domain-registry/src/index.ts
// =============================================================================
// DOMAIN REGISTRY — single source of truth for domain types.
//
// This repo (transportPlatform) is the goods-transport / logistics vertical of
// HisabKitab. It ships exactly one domain, `transport`, but keeps the same
// registry shape as billingPlatform so the shared core (invoice service,
// product service, tenants/branches routes) works unchanged and patches can be
// ported between the two repos.
//
// Adding a sub-domain later (e.g. `passenger_bus`, `courier`):
//   1. Define productAttrs / invoiceData / itemMeta Zod schemas below
//   2. Add an entry to DOMAIN_REGISTRY
//   3. Zero changes to core tables, routes, or the GST engine
// =============================================================================

import { z } from 'zod'

// ── Shared enums ──────────────────────────────────────────────────────────────

/** Vehicle classes used for fleet, rate cards and product attrs. */
export const VEHICLE_TYPES = [
  'mini_truck',   // Tata Ace / Chhota Hathi (≤1 T)
  'pickup',       // Bolero pickup (1–2 T)
  'lcv',          // light commercial (2–7 T)
  'icv',          // intermediate (7–16 T)
  'hcv',          // heavy 6/10/12 wheeler (16–35 T)
  'trailer',      // multi-axle trailer
  'container',    // 20/32/40 ft container carrier
  'tanker',
  'tipper',
  'reefer',       // refrigerated
  'other',
] as const

/** Who pays the freight — the core of Indian goods-transport billing. */
export const FREIGHT_TYPES = ['paid', 'to_pay', 'tbb'] as const
// paid   = consignor pays at booking
// to_pay = consignee pays on delivery
// tbb    = "to be billed" — consignor is invoiced later (credit account)

/** How GST is handled on the freight bill. */
export const GST_MODES = [
  'rcm',          // GTA @5%, payable by recipient under reverse charge — transporter's bill carries ₹0 GST
  'forward_5',    // GTA charging 5% forward (no ITC on inputs)
  'forward_12',   // GTA charging 12% forward (with ITC on inputs; legacy rate)
  'forward_18',   // GTA charging 18% forward (with ITC on inputs)
  'exempt',       // exempt movement (e.g. agricultural produce, as applicable)
] as const

export const PAYMENT_TERMS = ['immediate', '7_days', '15_days', '30_days', '45_days', '60_days'] as const

// ── Transport / goods carrier (GTA / fleet owner / broker) ────────────────────
// Product = a billable service ("FTL freight", "Detention", "Loading") or a
// stocked item (tyre, lubricant, spare) tracked through the shared inventory.
const TransportProductAttrs = z.object({
  item_kind:             z.enum(['freight_service', 'ancillary_charge', 'spare_part', 'tyre', 'lubricant', 'fuel']).default('freight_service'),
  service_type:          z.enum(['ftl', 'ltl', 'part_load', 'container', 'odc', 'tanker', 'cold_chain', 'parcel', 'other']).optional(),
  rate_basis:            z.enum(['fixed', 'per_ton', 'per_kg', 'per_km', 'per_pkg', 'per_day']).default('fixed'),
  vehicle_type_required: z.enum(VEHICLE_TYPES).optional(),
  // spares / tyres
  brand:                 z.string().max(100).optional(),
  part_no:               z.string().max(100).optional(),
  tyre_size:             z.string().max(30).optional(),     // e.g. 295/80 R22.5
  compatible_vehicles:   z.array(z.string()).default([]),
}).strict()

// Freight bill (an invoice raised against one or more Lorry Receipts).
const TransportInvoiceData = z.object({
  bill_kind:        z.enum(['lr_bill', 'trip_bill', 'hire_bill', 'monthly_consolidated']).default('lr_bill'),
  lr_ids:           z.array(z.string().uuid()).default([]),
  lr_nos:           z.array(z.string()).default([]),
  period_from:      z.string().optional(),
  period_to:        z.string().optional(),
  vehicle_nos:      z.array(z.string()).default([]),
  gst_mode:         z.enum(GST_MODES).default('rcm'),
  // Sec 194C — payer may deduct TDS on freight (1% individual/HUF, 2% others);
  // nil if the transporter furnishes PAN + the ≤10-goods-carriages declaration.
  tds_applicable:   z.boolean().default(false),
  tds_rate_pct:     z.number().min(0).max(10).default(1),
  tds_amount:       z.number().nonnegative().default(0),   // ₹ deducted by the customer (rounded to the rupee)
  payment_terms:    z.enum(PAYMENT_TERMS).default('30_days'),
  credit_days:      z.number().int().min(0).max(180).default(30),
}).strict()

// Per-line meta on the freight bill: one line per LR.
const TransportItemMeta = z.object({
  lr_id:       z.string().uuid().optional(),
  lr_no:       z.string().max(30).optional(),
  lr_date:     z.string().max(10).optional(),
  gate_pass_no:z.string().max(40).optional(),
  shipment_no: z.string().max(40).optional(),
  load_kg:     z.number().nonnegative().optional(),
  unload_kg:   z.number().nonnegative().optional(),
  charged_kg:  z.number().nonnegative().optional(),
  rate:        z.number().nonnegative().optional(),
  rate_basis:  z.string().max(12).optional(),
  trip_id:     z.string().uuid().optional(),
  from_city:   z.string().max(100).optional(),
  to_city:     z.string().max(100).optional(),
  vehicle_no:  z.string().max(20).optional(),
  weight_kg:   z.number().nonnegative().optional(),
  packages:    z.number().int().nonnegative().optional(),
  eway_bill_no:z.string().max(20).optional(),
}).strict()

// =============================================================================
// DOMAIN REGISTRY — the single config object all layers read from
// =============================================================================
export const DOMAIN_REGISTRY = {
  transport: {
    label:              'Transport / Logistics / Trucking (goods carrier, GTA, fleet owner)',
    productAttrsSchema: TransportProductAttrs,
    invoiceDataSchema:  TransportInvoiceData,
    itemMetaSchema:     TransportItemMeta,
    defaultDomainConfig: {
      lr_prefix:               'LR',
      trip_prefix:             'TRP',
      lr_series_by_fy:         true,        // LR numbers restart each financial year (LR-2526-0001)
      default_freight_type:    'tbb',
      default_gst_mode:        'rcm',
      default_sac_code:        '996791',    // Goods transport agency services
      eway_threshold:          50000,       // ₹ — e-way bill mandatory above this consignment value
      compliance_alert_days:   30,          // warn this many days before fitness/permit/insurance/PUC expiry
      pod_required_before_billing: false,
      weight_unit:             'kg',
    },
    extensionTables: [
      'transport_vehicles',
      'transport_drivers',
      'transport_routes',
      'transport_lorry_receipts',
      'transport_trips',
      'transport_expenses',
      'transport_counters',
    ] as string[],
    features: {
      hasBatches:        false,
      hasAppointments:   false,
      hasKOT:            false,
      hasWeightBilling:  true,
      hasUdhaar:         true,       // TBB parties run on credit
      hasEwayBill:       true,
      hasCommission:     true,       // broker / market-vehicle commission
      hasShiftReport:    false,
      hasJobCard:        false,
      hasSubscription:   false,
      hasNozzleReading:  false,
      hasBrands:         true,
      hasLoyalty:        false,
      hasHomeDelivery:   false,
      // transport-specific
      hasLorryReceipt:   true,
      hasFleet:          true,
      hasTrips:          true,
      hasCompliance:     true,
      hasPOD:            true,
    },
  },
} as const

// =============================================================================
// EXPENSE CATEGORIES
// =============================================================================
export interface ExpenseCategory {
  code:         string
  label:        string
  icon:         string
  affectsStock: boolean   // true = buying inventory (purchases), affects COGS
}

const UNIVERSAL: ExpenseCategory[] = [
  { code: 'rent',         label: 'Office / Yard Rent', icon: '🏢', affectsStock: false },
  { code: 'electricity',  label: 'Electricity',        icon: '⚡', affectsStock: false },
  { code: 'internet',     label: 'Internet / Phone',   icon: '📶', affectsStock: false },
  { code: 'staff',        label: 'Staff Salary',       icon: '👤', affectsStock: false },
  { code: 'maintenance',  label: 'Maintenance',        icon: '🔧', affectsStock: false },
  { code: 'misc',         label: 'Miscellaneous',      icon: '📎', affectsStock: false },
]

const DOMAIN_EXPENSE_CATEGORIES: Record<string, ExpenseCategory[]> = {
  transport: [
    { code: 'diesel',            label: 'Diesel / Fuel',               icon: '⛽', affectsStock: false },
    { code: 'toll',              label: 'Toll / FASTag',               icon: '🛣️', affectsStock: false },
    { code: 'driver_salary',     label: 'Driver / Helper Salary',      icon: '🧑‍✈️', affectsStock: false },
    { code: 'driver_bhatta',     label: 'Driver Bhatta / Food',        icon: '🍛', affectsStock: false },
    { code: 'tyres',             label: 'Tyres & Retreading',          icon: '🛞', affectsStock: true  },
    { code: 'spares',            label: 'Spare Parts',                 icon: '🔩', affectsStock: true  },
    { code: 'repair',            label: 'Vehicle Repair / Service',    icon: '🔧', affectsStock: false },
    { code: 'insurance',         label: 'Vehicle Insurance',           icon: '🛡️', affectsStock: false },
    { code: 'permit_tax',        label: 'Permit / Road Tax / Fitness', icon: '📋', affectsStock: false },
    { code: 'challan',           label: 'Challan / RTO / Police',      icon: '🚔', affectsStock: false },
    { code: 'loading_unloading', label: 'Loading / Unloading (Hamali)',icon: '🏋️', affectsStock: false },
    { code: 'vehicle_hire',      label: 'Market Vehicle Hire',         icon: '🚚', affectsStock: false },
    { code: 'broker_commission', label: 'Broker Commission',           icon: '🤝', affectsStock: false },
    { code: 'parking',           label: 'Parking / Yard Charges',      icon: '🅿️', affectsStock: false },
    { code: 'emi',               label: 'Vehicle EMI / Finance',       icon: '🏦', affectsStock: false },
  ],
}

export function getExpenseCategories(domainType: DomainType): ExpenseCategory[] {
  const domain = DOMAIN_EXPENSE_CATEGORIES[domainType] ?? []
  // Merge domain-specific first (shown at top), then universals not already covered
  const domainCodes = new Set(domain.map((c) => c.code))
  const extras = UNIVERSAL.filter((c) => !domainCodes.has(c.code))
  return [...domain, ...extras]
}

// =============================================================================
// TYPES + HELPERS
// =============================================================================
export type DomainType = keyof typeof DOMAIN_REGISTRY

export type DomainProductAttrs<T extends DomainType> = z.infer<typeof DOMAIN_REGISTRY[T]['productAttrsSchema']>
export type DomainInvoiceData<T extends DomainType>  = z.infer<typeof DOMAIN_REGISTRY[T]['invoiceDataSchema']>
export type DomainItemMeta<T extends DomainType>     = z.infer<typeof DOMAIN_REGISTRY[T]['itemMetaSchema']>

export type VehicleType = typeof VEHICLE_TYPES[number]
export type FreightType = typeof FREIGHT_TYPES[number]
export type GstMode     = typeof GST_MODES[number]

/** GST rate (%) charged on the freight bill for a given GST mode. */
export function gstRateForMode(mode: GstMode): number {
  switch (mode) {
    case 'forward_5':  return 5
    case 'forward_12': return 12
    case 'forward_18': return 18
    case 'rcm':
    case 'exempt':
    default:           return 0
  }
}

// Helper: get features for a domain type
export function getDomainFeatures(domainType: string) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  return domain.features
}

// Helper: validate domain_attrs for a product
export function validateProductAttrs(domainType: string, attrs: unknown) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  // Use passthrough so legacy/extra keys already stored in the JSON field don't break validation
  return (domain.productAttrsSchema as z.ZodObject<z.ZodRawShape>).passthrough().parse(attrs ?? {})
}

// Helper: validate invoice domain_data
export function validateInvoiceData(domainType: string, data: unknown) {
  const domain = DOMAIN_REGISTRY[domainType as DomainType]
  if (!domain) throw new Error(`Unknown domain type: ${domainType}`)
  return domain.invoiceDataSchema.parse(data)
}
