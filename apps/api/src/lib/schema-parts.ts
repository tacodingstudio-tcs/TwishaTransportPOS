// Which tables a tenant schema gets. A schema is built from PARTS, not one big template:
//
//   core       invoices, parties, payments, expenses, bank accounts, users, notifications… (every vertical needs these)
//   retail     products, stock, purchasing, suppliers, batches, contracts… (inventory businesses only)
//   transport  the transport_* tables (fleet, LRs, trips, bank statements…)
//
// A table is "retail" if it is listed in RETAIL_TABLES; everything else in provision-schema.ts is core.
// transport-ddl.ts is the transport part. Portable: a sibling platform lists its own parts here.

export type SchemaPart = 'core' | 'retail' | 'transport'
export const ALL_PARTS: SchemaPart[] = ['core', 'retail', 'transport']

export const RETAIL_TABLES = new Set([
  'products', 'product_variants', 'product_images', 'product_price_history', 'product_suppliers',
  'batches', 'brands',
  'stock_ledger', 'stock_summary', 'stock_adjustments', 'stock_adjustment_items', 'stock_transfers', 'stock_transfer_items',
  'purchase_orders', 'purchase_order_items', 'goods_receipts', 'goods_receipt_items', 'suppliers',
  'contracts', 'gallery_items', 'discount_rules', 'ai_suggestions',
  'staff_attendance', 'staff_shifts', 'razorpay_orders', 'cash_register_entries', 'bank_reconciliation_entries',
])

/** Parts a new tenant of this domain gets. Lean (no retail tables) only once LEAN_SCHEMA=true — see CLAUDE.md "separate the verticals". */
export function partsFor(domainType: string): SchemaPart[] {
  if (domainType === 'transport' && process.env.LEAN_SCHEMA === 'true') return ['core', 'transport']
  return ALL_PARTS
}

const TABLE_OF = [
  /^(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE) "([^"]+)"/,
  /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+"\s+ON\s+"([^"]+)"/,
]

/** The table a provisioning statement is about (or undefined for something we do not recognise). */
export function tableOf(sql: string): string | undefined {
  for (const re of TABLE_OF) { const m = re.exec(sql); if (m) return m[1] }
  return undefined
}

/** Drop the statements that belong to a part this tenant does not get. */
export function forParts(statements: string[], parts: SchemaPart[]): string[] {
  if (parts.includes('retail')) return statements
  return statements.filter((s) => !RETAIL_TABLES.has(tableOf(s) ?? ''))
}

/**
 * The shared tables every tenant needs, as TypeScript, so a lean tenant can be created without the SQL template
 * (docker/init.sql create_tenant_schema() always creates products/stock too). Must stay identical to that template for
 * these tables — a test compares them. invoice_items.productId is a plain column here (no foreign key to products).
 */
export const BASE_CORE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "branches" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, gstin TEXT, address JSONB, "stateCode" TEXT,
  "domainType" TEXT NOT NULL, "domainConfig" JSONB NOT NULL DEFAULT '{}'::jsonb, "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS "users" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT,
  role TEXT NOT NULL DEFAULT 'cashier', "branchIds" UUID[] NOT NULL DEFAULT '{}'::uuid[], pin TEXT, lang TEXT NOT NULL DEFAULT 'hi',
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS "parties" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "branchId" UUID, type TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT,
  gstin TEXT, pan TEXT, address JSONB, "creditLimit" DECIMAL(12,2) NOT NULL DEFAULT 0, balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  "loyaltyPts" INTEGER NOT NULL DEFAULT 0, meta JSONB NOT NULL DEFAULT '{}'::jsonb, "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY ("branchId") REFERENCES "branches"(id))`,
  `CREATE INDEX IF NOT EXISTS "parties_type_idx" ON "parties"(type)`,
  `CREATE INDEX IF NOT EXISTS "parties_phone_idx" ON "parties"(phone)`,
  `CREATE TABLE IF NOT EXISTS "invoices" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "branchId" UUID NOT NULL, "partyId" UUID, "createdBy" UUID NOT NULL,
  "txnType" TEXT NOT NULL, number TEXT NOT NULL, date DATE NOT NULL, "dueDate" DATE, status TEXT NOT NULL DEFAULT 'draft',
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0, "discountAmt" DECIMAL(12,2) NOT NULL DEFAULT 0, "taxableAmt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "cgstTotal" DECIMAL(12,2) NOT NULL DEFAULT 0, "sgstTotal" DECIMAL(12,2) NOT NULL DEFAULT 0, "igstTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "cessTotal" DECIMAL(12,2) NOT NULL DEFAULT 0, "roundOff" DECIMAL(5,2) NOT NULL DEFAULT 0, "grandTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "paidAmt" DECIMAL(12,2) NOT NULL DEFAULT 0, notes TEXT, "domainData" JSONB NOT NULL DEFAULT '{}'::jsonb, "aiMeta" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY ("branchId") REFERENCES "branches"(id), FOREIGN KEY ("partyId") REFERENCES "parties"(id),
  FOREIGN KEY ("createdBy") REFERENCES "users"(id), UNIQUE ("branchId", "txnType", number))`,
  `CREATE INDEX IF NOT EXISTS "invoices_branchId_date_idx" ON "invoices"("branchId", date DESC)`,
  `CREATE INDEX IF NOT EXISTS "invoices_partyId_idx" ON "invoices"("partyId")`,
  `CREATE TABLE IF NOT EXISTS "invoice_items" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "invoiceId" UUID NOT NULL, "productId" UUID, "batchId" UUID, description TEXT NOT NULL,
  "hsnSacCode" TEXT, qty DECIMAL(10,3) NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs', rate DECIMAL(12,4) NOT NULL,
  "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0, "discountAmt" DECIMAL(12,2) NOT NULL DEFAULT 0, "taxableAmt" DECIMAL(12,2) NOT NULL,
  "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0, "cgstAmt" DECIMAL(12,2) NOT NULL DEFAULT 0, "sgstAmt" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "igstAmt" DECIMAL(12,2) NOT NULL DEFAULT 0, total DECIMAL(12,2) NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "itemMeta" JSONB NOT NULL DEFAULT '{}'::jsonb, FOREIGN KEY ("invoiceId") REFERENCES "invoices"(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS "invoice_items_invoiceId_idx" ON "invoice_items"("invoiceId")`,
  `CREATE TABLE IF NOT EXISTS "payments" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "branchId" UUID NOT NULL, "partyId" UUID, amount DECIMAL(12,2) NOT NULL, method TEXT NOT NULL,
  "refNo" TEXT, "paymentDate" DATE NOT NULL DEFAULT CURRENT_DATE, notes TEXT, "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), FOREIGN KEY ("partyId") REFERENCES "parties"(id))`,
  `CREATE INDEX IF NOT EXISTS "payments_branchId_paymentDate_idx" ON "payments"("branchId", "paymentDate" DESC)`,
  `CREATE INDEX IF NOT EXISTS "payments_partyId_idx" ON "payments"("partyId")`,
  `CREATE TABLE IF NOT EXISTS "payment_allocations" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "paymentId" UUID NOT NULL, "invoiceId" UUID NOT NULL, amount DECIMAL(12,2) NOT NULL,
  FOREIGN KEY ("paymentId") REFERENCES "payments"(id), FOREIGN KEY ("invoiceId") REFERENCES "invoices"(id))`,
  `CREATE INDEX IF NOT EXISTS "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId")`,
  `CREATE INDEX IF NOT EXISTS "payment_allocations_invoiceId_idx" ON "payment_allocations"("invoiceId")`,
  `CREATE TABLE IF NOT EXISTS "invoice_sequences" (
  branch_id UUID NOT NULL, txn_type TEXT NOT NULL, fy TEXT NOT NULL DEFAULT to_char(now(),'YY'), current_val BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, txn_type, fy))`,
  `CREATE TABLE IF NOT EXISTS "notifications" (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, "branchId" UUID NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb, "isRead" BOOLEAN NOT NULL DEFAULT false, "readAt" TIMESTAMPTZ, approved BOOLEAN,
  "approvedAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS "notifications_branch_read_idx" ON "notifications"("branchId","isRead")`,
  `CREATE INDEX IF NOT EXISTS "notifications_branch_date_idx" ON "notifications"("branchId","createdAt" DESC)`,
  `CREATE TABLE IF NOT EXISTS "idempotency_keys" (key TEXT PRIMARY KEY, response JSONB NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS "bank_accounts" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), "branchId" UUID NOT NULL, name TEXT NOT NULL, "bankName" TEXT, "accountNumber" TEXT,
  "ifscCode" TEXT, "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0, "currentBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
]
