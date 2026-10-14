// Post-provisioning step for new tenants.
// create_tenant_schema() only creates a minimal schema — this brings it up to date
// with all tables and columns that exist in fully-migrated tenant schemas.
//
// All statements use schema-qualified table names ("schemaName"."tableName")
// so we can reuse the existing shared db connection pool — no new clients created.

import { db } from '@billing/db'
import { TRANSPORT_DDL } from './transport-ddl.js'

const DDL_PREFIX_RE = /^(CREATE TABLE IF NOT EXISTS|ALTER TABLE) "([^"]+)"/
// CREATE [UNIQUE] INDEX IF NOT EXISTS "idx" ON "table" (...)  — index lives in the table's schema
const INDEX_PREFIX_RE = /^(CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "[^"]+"\s+ON\s+)"([^"]+)"/

async function runDDL(schemaName: string, statements: string[]): Promise<void> {
  for (const sql of statements) {
    // Make table references fully qualified: "tableName" → "schemaName"."tableName"
    const match = DDL_PREFIX_RE.exec(sql) ?? INDEX_PREFIX_RE.exec(sql)
    if (!match) {
      // Defensive: every statement in provisionTenantSchema must start with
      // CREATE TABLE IF NOT EXISTS, ALTER TABLE or CREATE INDEX IF NOT EXISTS. Throw loudly so we notice
      // rather than running unqualified DDL against the public schema.
      throw new Error(`Provision DDL statement does not match expected prefix — refusing to run unqualified:\n${sql.slice(0, 200)}`)
    }
    let qualified = DDL_PREFIX_RE.test(sql)
      ? sql.replace(DDL_PREFIX_RE, `$1 "${schemaName}"."$2"`)
      : sql.replace(INDEX_PREFIX_RE, `$1 "${schemaName}"."$2"`)
    // Also qualify REFERENCES "tableName" so FK constraints resolve inside the tenant schema
    qualified = qualified.replace(/REFERENCES "([^"]+)"/g, `REFERENCES "${schemaName}"."$1"`)
    try {
      await db.$executeRawUnsafe(qualified)
    } catch (err: any) {
      // 42701 = column already exists — safe to skip
      if (err?.code === '42701' || err?.message?.includes('already exists')) continue
      throw new Error(`Provision failed:\n${qualified}\n\nCause: ${err?.message}`)
    }
  }
}

export async function provisionTenantSchema(schemaName: string): Promise<void> {
    // ── 1. Create missing tables ─────────────────────────────────────────────
    await runDDL(schemaName, [
      `CREATE TABLE IF NOT EXISTS "brands" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "categories" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "icon" TEXT,
  "color" TEXT,
  "parentId" UUID,
  "sortOrder" INTEGER DEFAULT 0,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "bank_accounts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "name" TEXT,
  "bankName" TEXT,
  "accountNumber" TEXT,
  "ifscCode" TEXT,
  "openingBalance" DECIMAL(14,2) DEFAULT 0,
  "currentBalance" DECIMAL(14,2) DEFAULT 0,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "bank_reconciliation_entries" (
  "id"                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"          UUID        NOT NULL,
  "bankAccountId"     UUID,
  "month"             TEXT        NOT NULL,
  "statementBalance"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "bookBalance"       DECIMAL(14,2) NOT NULL DEFAULT 0,
  "difference"        DECIMAL(14,2) GENERATED ALWAYS AS ("statementBalance" - "bookBalance") STORED,
  "notes"             TEXT,
  "updatedAt"         TIMESTAMPTZ DEFAULT NOW(),
  "createdAt"         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT ("branchId", "bankAccountId", "month")
)`,
      `CREATE TABLE IF NOT EXISTS "cash_register_entries" (
  "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"    UUID        NOT NULL,
  "date"        DATE        NOT NULL,
  "systemCash"  DECIMAL(14,2) NOT NULL DEFAULT 0,
  "countedCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "difference"  DECIMAL(14,2) GENERATED ALWAYS AS ("countedCash" - "systemCash") STORED,
  "notes"       TEXT,
  "closedBy"    TEXT,
  "updatedAt"   TIMESTAMPTZ DEFAULT NOW(),
  "createdAt"   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE ("branchId", "date")
)`,
      `CREATE TABLE IF NOT EXISTS "contracts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "partyId" UUID,
  "title" TEXT,
  "contractNo" TEXT,
  "startDate" DATE,
  "endDate" DATE,
  "billingCycle" TEXT DEFAULT 'monthly',
  "billingDay" INTEGER DEFAULT 1,
  "amount" DECIMAL(12,2),
  "gstRate" DECIMAL(5,2) DEFAULT 0,
  "status" TEXT DEFAULT 'active',
  "lastBilledDate" DATE,
  "nextBillingDate" DATE,
  "autoInvoice" BOOLEAN DEFAULT true,
  "notes" TEXT,
  "terms" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "expenses" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "date" DATE,
  "category" TEXT,
  "description" TEXT,
  "amount" DECIMAL(12,2),
  "gstAmount" DECIMAL(12,2) DEFAULT 0,
  "gstRate" INTEGER DEFAULT 0,
  "paymentMode" TEXT DEFAULT 'cash',
  "partyId" UUID,
  "referenceNo" TEXT,
  "notes" TEXT,
  "attachmentUrl" TEXT,
  "isRecurring" BOOLEAN DEFAULT false,
  "recurrence" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "gallery_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "partyId" UUID,
  "invoiceId" UUID,
  "imageData" TEXT,
  "thumbData" TEXT,
  "caption" TEXT,
  "tags" TEXT[] DEFAULT '{}',
  "domainType" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "goods_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "purchaseOrderId" UUID,
  "partyId" UUID,
  "grnNo" TEXT,
  "grnDate" DATE,
  "invoiceNo" TEXT,
  "invoiceDate" DATE,
  "status" TEXT DEFAULT 'draft',
  "subtotal" DECIMAL(12,2) DEFAULT 0,
  "taxableAmt" DECIMAL(12,2) DEFAULT 0,
  "cgstTotal" DECIMAL(12,2) DEFAULT 0,
  "sgstTotal" DECIMAL(12,2) DEFAULT 0,
  "igstTotal" DECIMAL(12,2) DEFAULT 0,
  "grandTotal" DECIMAL(12,2) DEFAULT 0,
  "notes" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "goods_receipt_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "goodsReceiptId" UUID,
  "purchaseOrderItemId" UUID,
  "productId" UUID,
  "description" TEXT,
  "receivedQty" DECIMAL(10,3),
  "acceptedQty" DECIMAL(10,3) DEFAULT 0,
  "rejectedQty" DECIMAL(10,3) DEFAULT 0,
  "unit" TEXT DEFAULT 'pcs',
  "rate" DECIMAL(12,4),
  "taxableAmt" DECIMAL(12,2) DEFAULT 0,
  "gstRate" DECIMAL(5,2) DEFAULT 0,
  "cgstAmt" DECIMAL(12,2) DEFAULT 0,
  "sgstAmt" DECIMAL(12,2) DEFAULT 0,
  "igstAmt" DECIMAL(12,2) DEFAULT 0,
  "total" DECIMAL(12,2),
  "batchNo" TEXT,
  "expiryDate" DATE,
  "sortOrder" INTEGER DEFAULT 0,
  "batchId" UUID
)`,
      `CREATE TABLE IF NOT EXISTS "notifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "type" TEXT,
  "title" TEXT,
  "body" TEXT,
  "payload" JSONB,
  "isRead" BOOLEAN DEFAULT false,
  "readAt" TIMESTAMPTZ,
  "approved" BOOLEAN,
  "approvedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "product_images" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID,
  "url" TEXT,
  "data" BYTEA,
  "mime" TEXT,
  "alt" TEXT,
  "sortOrder" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "product_price_history" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID,
  "purchasePrice" DECIMAL(12,2),
  "salePrice" DECIMAL(12,2),
  "mrp" DECIMAL(12,2),
  "changedBy" UUID,
  "changedAt" TIMESTAMPTZ DEFAULT NOW(),
  "reason" TEXT
)`,
      `CREATE TABLE IF NOT EXISTS "product_suppliers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID,
  "partyId" UUID,
  "supplierSku" TEXT,
  "lastCost" DECIMAL(12,4),
  "moq" DECIMAL(10,3) DEFAULT 1,
  "leadDays" INTEGER DEFAULT 0,
  "isPrimary" BOOLEAN DEFAULT false,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "product_variants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID,
  "sku" TEXT,
  "barcode" TEXT,
  "name" TEXT,
  "attributes" JSONB,
  "domainAttrs" JSONB,
  "purchasePrice" DECIMAL(12,2),
  "salePrice" DECIMAL(12,2) DEFAULT 0,
  "mrp" DECIMAL(12,2),
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "partyId" UUID,
  "poNo" TEXT,
  "poDate" DATE,
  "expectedDate" DATE,
  "status" TEXT DEFAULT 'draft',
  "subtotal" DECIMAL(12,2) DEFAULT 0,
  "taxableAmt" DECIMAL(12,2) DEFAULT 0,
  "cgstTotal" DECIMAL(12,2) DEFAULT 0,
  "sgstTotal" DECIMAL(12,2) DEFAULT 0,
  "igstTotal" DECIMAL(12,2) DEFAULT 0,
  "grandTotal" DECIMAL(12,2) DEFAULT 0,
  "paidAmt" DECIMAL(12,2) DEFAULT 0,
  "notes" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "purchase_order_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseOrderId" UUID,
  "productId" UUID,
  "description" TEXT,
  "hsnSacCode" TEXT,
  "orderedQty" DECIMAL(10,3),
  "receivedQty" DECIMAL(10,3) DEFAULT 0,
  "unit" TEXT DEFAULT 'pcs',
  "rate" DECIMAL(12,4),
  "discountPct" DECIMAL(5,2) DEFAULT 0,
  "discountAmt" DECIMAL(12,2) DEFAULT 0,
  "taxableAmt" DECIMAL(12,2),
  "gstRate" DECIMAL(5,2) DEFAULT 0,
  "cgstAmt" DECIMAL(12,2) DEFAULT 0,
  "sgstAmt" DECIMAL(12,2) DEFAULT 0,
  "igstAmt" DECIMAL(12,2) DEFAULT 0,
  "total" DECIMAL(12,2),
  "sortOrder" INTEGER DEFAULT 0
)`,
      `CREATE TABLE IF NOT EXISTS "staff_attendance" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "userId" UUID,
  "date" DATE,
  "clockIn" TIMESTAMPTZ,
  "clockOut" TIMESTAMPTZ,
  "status" TEXT DEFAULT 'present',
  "notes" TEXT,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_staff_attendance_day" ON "staff_attendance" ("branchId", "userId", "date")`,
      `CREATE TABLE IF NOT EXISTS "staff_shifts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "userId" UUID,
  "date" DATE,
  "shiftType" TEXT DEFAULT 'morning',
  "shiftStart" TIME,
  "shiftEnd" TIME,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "stock_adjustments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "adjNo" TEXT,
  "adjDate" DATE,
  "reason" TEXT,
  "notes" TEXT,
  "status" TEXT DEFAULT 'draft',
  "createdBy" UUID,
  "approvedBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "approvedAt" TIMESTAMPTZ
)`,
      `CREATE TABLE IF NOT EXISTS "stock_adjustment_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "stockAdjustmentId" UUID,
  "productId" UUID,
  "variantId" UUID,
  "batchId" UUID,
  "systemQty" DECIMAL(10,3),
  "physicalQty" DECIMAL(10,3),
  "differenceQty" DECIMAL(10,3),
  "unit" TEXT DEFAULT 'pcs',
  "costRate" DECIMAL(12,4),
  "notes" TEXT,
  "rate" DECIMAL(12,4)
)`,
      `CREATE TABLE IF NOT EXISTS "stock_summary" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "productId" UUID,
  "variantId" UUID,
  "currentQty" DECIMAL(10,3) DEFAULT 0,
  "reservedQty" DECIMAL(10,3) DEFAULT 0,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
      `CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "fromBranchId" UUID,
  "toBranchId" UUID,
  "transferNo" TEXT,
  "transferDate" DATE,
  "status" TEXT DEFAULT 'draft',
  "notes" TEXT,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "receivedDate" DATE,
  "receivedBy" UUID
)`,
      `CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "stockTransferId" UUID,
  "productId" UUID,
  "variantId" UUID,
  "qty" DECIMAL(10,3),
  "unit" TEXT DEFAULT 'pcs',
  "costRate" DECIMAL(12,4),
  "sentQty" DECIMAL(10,3) DEFAULT 0,
  "receivedQty" DECIMAL(10,3) DEFAULT 0,
  "rate" DECIMAL(12,4) DEFAULT 0
)`,
      `CREATE TABLE IF NOT EXISTS "suppliers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "name" TEXT,
  "contactPerson" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "gstin" TEXT,
  "address" TEXT,
  "city" TEXT,
  "state" TEXT,
  "pincode" TEXT,
  "creditDays" INTEGER DEFAULT 0,
  "notes" TEXT,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "pan" TEXT,
  "stateCode" TEXT,
  "creditLimit" DECIMAL(12,2) DEFAULT 0,
  "balance" DECIMAL(12,2) DEFAULT 0,
  "leadTimeDays" INTEGER DEFAULT 0
)`,
    ])

    // ── 2. Add missing columns to existing tables ────────────────────────────
    await runDDL(schemaName, [
      // batches
      `ALTER TABLE "batches" ADD COLUMN IF NOT EXISTS "branchId" UUID`,

      // Intentionally left blank — invoice_sequences is handled separately below

      // invoices
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "linkedInvoiceId" UUID`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT DEFAULT 'not_required'`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "approvedBy" UUID`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMPTZ`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "irnNo" TEXT`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "irnAckDate" TIMESTAMPTZ`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "irnQrCode" TEXT`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "eWayBillNo" TEXT`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "eWayBillDate" TIMESTAMPTZ`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "eWayBillValidTo" TIMESTAMPTZ`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "cancelledBy" UUID`,
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ`,

      // payments
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "type" TEXT DEFAULT 'receipt'`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'active'`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMPTZ`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "voidReason" TEXT`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "chequeNo" TEXT`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "chequeDueDate" DATE`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "bankName" TEXT`,
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "clearingStatus" TEXT`,

      // products — domain-agnostic fields
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "brandId" UUID`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image" BYTEA`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "imageMime" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "weightGrams" DECIMAL(10,3)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "packSize" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "minOrderQty" DECIMAL(10,3)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "reorderQty" DECIMAL(10,3)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shelfLocation" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "altUnit" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "altUnitFactor" DECIMAL(10,4)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "taxCategory" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "hasVariants" BOOLEAN DEFAULT false`,

      // products — pharmacy
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "drugSchedule" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requiresPrescription" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "genericName" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "manufacturer" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "form" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "strengthDosage" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stripQty" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "storageCondition" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isNarcotic" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dlNumber" TEXT`,

      // products — electronics
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "modelNumber" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "compatibleModels" TEXT[] DEFAULT '{}'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isSpare" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "warrantyMonths" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "colorOptions" JSONB DEFAULT '[]'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "storageOptions" JSONB DEFAULT '[]'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "taxClass" TEXT`,

      // products — restaurant/food
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "mealType" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "cuisineType" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "allergens" TEXT[] DEFAULT '{}'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "caloriesPer100g" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "portionSizeGrams" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isAvailableBreakfast" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isAvailableLunch" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isAvailableDinner" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "preparationTimeMin" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isSeasonalItem" BOOLEAN DEFAULT false`,

      // products — petrol pump
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "fuelGrade" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "tankId" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "densityKgL" DECIMAL(6,4)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "octaneRating" INTEGER`,

      // products — gym/nutrition
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "servingSizeG" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "servingsPerPack" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "flavour" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "proteinPer100g" DECIMAL(5,2)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isConsumable" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "equipmentCondition" TEXT`,

      // products — diagnostic lab
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "testCode" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "sampleType" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "turnaroundHours" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "requiresFasting" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "referenceRange" JSONB`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "methodology" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isHomeCollectionAvailable" BOOLEAN DEFAULT false`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "panelTests" TEXT[] DEFAULT '{}'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "nablAccredited" BOOLEAN DEFAULT false`,

      // products — pest control
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "activeIngredient" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "concentrationPct" DECIMAL(6,4)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "applicationMethod" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "targetPest" TEXT[] DEFAULT '{}'`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "toxicityLevel" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dilutionRatio" TEXT`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "dosePerSqft" DECIMAL(8,4)`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "chemShelfLifeDays" INTEGER`,
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isCertifiedSafe" BOOLEAN DEFAULT false`,

      // stock_ledger
      `ALTER TABLE "stock_ledger" ADD COLUMN IF NOT EXISTS "variantId" UUID`,
      `ALTER TABLE "stock_ledger" ADD COLUMN IF NOT EXISTS "notes" TEXT`,
      `ALTER TABLE "stock_ledger" ADD COLUMN IF NOT EXISTS "createdBy" UUID`,

      // Supplier → Party migration: add partyId columns alongside old supplierId
      // (supplierId columns are kept for backward compat, partyId takes precedence)
      `ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "partyId" UUID`,
      `ALTER TABLE "goods_receipts" ADD COLUMN IF NOT EXISTS "partyId" UUID`,
      `ALTER TABLE "product_suppliers" ADD COLUMN IF NOT EXISTS "partyId" UUID`,
    ])

    // ── discount_rules table ─────────────────────────────────────────────────
    await runDDL(schemaName, [
      `CREATE TABLE IF NOT EXISTS "discount_rules" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId" UUID,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "isActive" BOOLEAN DEFAULT true,
  "priority" INTEGER DEFAULT 0,
  "conditions" JSONB DEFAULT '{}',
  "action" JSONB DEFAULT '{}',
  "validFrom" DATE,
  "validTo" DATE,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
)`,
    ])

    // ── AI suggestions ───────────────────────────────────────────────────────
    await runDDL(schemaName, [
      `CREATE TABLE IF NOT EXISTS "ai_suggestions" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"   UUID,
  "type"       TEXT        NOT NULL,
  "payload"    JSONB       NOT NULL DEFAULT '{}',
  "accepted"   BOOLEAN     NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ DEFAULT NOW()
)`,
    ])

    // The tenant template (docker/init.sql) creates ai_suggestions with an older shape
    // (inputHash / suggestion). The reminder-draft routes use type / payload / accepted, so bring
    // that table up to date: add the columns and relax the old NOT NULLs.
    await runDDL(schemaName, [
      `ALTER TABLE "ai_suggestions" ADD COLUMN IF NOT EXISTS "type" TEXT`,
      `ALTER TABLE "ai_suggestions" ADD COLUMN IF NOT EXISTS "payload" JSONB NOT NULL DEFAULT '{}'`,
      `ALTER TABLE "ai_suggestions" ADD COLUMN IF NOT EXISTS "accepted" BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE "ai_suggestions" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ DEFAULT NOW()`,
    ])
    for (const col of ['branchId', 'inputHash', 'suggestion']) {
      await db.$executeRawUnsafe(`ALTER TABLE "${schemaName}"."ai_suggestions" ALTER COLUMN "${col}" DROP NOT NULL`).catch(() => {})
    }

    // ── 2b. Transport extension tables (fleet, LRs, trips, expenses, counters) ─
    await runDDL(schemaName, TRANSPORT_DDL)

    // ── 3. Migrate invoice_sequences to snake_case schema if needed ──────────
    // create_tenant_schema() creates it with camelCase PKs; invoice-number.ts needs
    // snake_case columns and ON CONFLICT(branch_id,txn_type,fy).
    // Only DROP+recreate if the table still has the old camelCase columns —
    // never wipe an already-correct table because that resets sequence counters
    // for seeded tenants and causes unique constraint violations on next test run.
    const seqCols = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schemaName}' AND table_name = 'invoice_sequences'`
    )
    const seqColNames = seqCols.map((c) => c.column_name)
    const needsRebuild =
      seqColNames.length === 0 ||          // table missing entirely
      seqColNames.includes('branchId') ||  // old camelCase schema
      !seqColNames.includes('branch_id')   // some other wrong schema
    if (needsRebuild) {
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."invoice_sequences"`)
      await db.$executeRawUnsafe(`
        CREATE TABLE "${schemaName}"."invoice_sequences" (
          branch_id   UUID   NOT NULL,
          txn_type    TEXT   NOT NULL,
          fy          TEXT   NOT NULL DEFAULT '26',
          current_val BIGINT NOT NULL DEFAULT 0,
          CONSTRAINT invoice_sequences_pkey PRIMARY KEY (branch_id, txn_type, fy)
        )
      `)
    }

    // ── 3b. Migrate bank_reconciliation_entries to new schema if needed ────────
    // Old schema had entryDate/description/amount/type/paymentId/isReconciled.
    // New schema needs month/statementBalance/bookBalance/difference/notes.
    const bankReconCols = await db.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = '${schemaName}' AND table_name = 'bank_reconciliation_entries'`
    )
    const bankReconColNames = bankReconCols.map((c) => c.column_name)
    if (bankReconColNames.includes('entryDate') || !bankReconColNames.includes('month')) {
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${schemaName}"."bank_reconciliation_entries"`)
      await db.$executeRawUnsafe(`
        CREATE TABLE "${schemaName}"."bank_reconciliation_entries" (
          "id"                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
          "branchId"          UUID        NOT NULL,
          "bankAccountId"     UUID,
          "month"             TEXT        NOT NULL,
          "statementBalance"  DECIMAL(14,2) NOT NULL DEFAULT 0,
          "bookBalance"       DECIMAL(14,2) NOT NULL DEFAULT 0,
          "difference"        DECIMAL(14,2) GENERATED ALWAYS AS ("statementBalance" - "bookBalance") STORED,
          "notes"             TEXT,
          "updatedAt"         TIMESTAMPTZ DEFAULT NOW(),
          "createdAt"         TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE NULLS NOT DISTINCT ("branchId", "bankAccountId", "month")
        )
      `)
    }

    // ── 3c. Add cash_register_entries if missing ─────────────────────────────
    const cashRegExists = await db.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = '${schemaName}' AND table_name = 'cash_register_entries'
       ) AS exists`
    )
    if (!cashRegExists[0]?.exists) {
      await db.$executeRawUnsafe(`
        CREATE TABLE "${schemaName}"."cash_register_entries" (
          "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
          "branchId"    UUID        NOT NULL,
          "date"        DATE        NOT NULL,
          "systemCash"  DECIMAL(14,2) NOT NULL DEFAULT 0,
          "countedCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
          "difference"  DECIMAL(14,2) GENERATED ALWAYS AS ("countedCash" - "systemCash") STORED,
          "notes"       TEXT,
          "closedBy"    TEXT,
          "updatedAt"   TIMESTAMPTZ DEFAULT NOW(),
          "createdAt"   TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE ("branchId", "date")
        )
      `)
    }

    // ── 4. Backfill nullable columns that Prisma expects non-nullable ────────
    // colorOptions / storageOptions were added without NOT NULL — backfill NULLs
    // because Prisma declares them as non-nullable Json and throws on null rows.
    await db.$executeRawUnsafe(
      `UPDATE "${schemaName}"."products" SET "colorOptions" = '[]' WHERE "colorOptions" IS NULL`
    )
    await db.$executeRawUnsafe(
      `UPDATE "${schemaName}"."products" SET "storageOptions" = '[]' WHERE "storageOptions" IS NULL`
    )
}

// =============================================================================
// Domain-specific category seed data
// Each entry is { name, slug, icon } — icon is an emoji for quick visual ID.
// "Raw Materials" / consumable categories are always seeded alongside the
// domain's normal sellable-product categories so users can immediately tag
// consumable stock without having to create categories manually.
// =============================================================================

type CategorySeed = { name: string; slug: string; icon: string }

const DOMAIN_CATEGORIES: Record<string, CategorySeed[]> = {
  transport: [
    // Billable services
    { name: 'Full Truck Load (FTL)', slug: 'ftl',           icon: '🚛' },
    { name: 'Part Load / LTL',       slug: 'part-load',     icon: '📦' },
    { name: 'Container Movement',    slug: 'container',     icon: '🚢' },
    { name: 'Ancillary Charges',     slug: 'ancillary',     icon: '🧾' },
    // Stocked items
    { name: 'Tyres & Tubes',         slug: 'tyres',         icon: '🛞' },
    { name: 'Spare Parts',           slug: 'spare-parts',   icon: '🔩' },
    { name: 'Lubricants & Oil',      slug: 'lubricants',    icon: '🛢️' },
    { name: 'Tarpaulin & Ropes',     slug: 'tarpaulin',     icon: '🪢' },
  ],

  // Default for domains not listed above — generic consumable bucket
  _default: [
    { name: 'Products',        slug: 'products',        icon: '📦' },
    { name: 'Services',        slug: 'services',        icon: '⚡' },
    { name: 'Raw Materials',   slug: 'raw-materials',   icon: '🧱' },
    { name: 'Consumables',     slug: 'consumables',     icon: '🔁' },
  ],
}

/**
 * Seeds domain-specific product categories for a newly created branch.
 * Called once from the POST /branches route after branch creation.
 * Uses INSERT ... ON CONFLICT DO NOTHING so it's idempotent.
 */
export async function seedDomainCategories(
  db: any,
  branchId: string,
  domainType: string,
): Promise<void> {
  const cats = DOMAIN_CATEGORIES[domainType] ?? DOMAIN_CATEGORIES['_default'] ?? []
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i]!
    await db.$executeRawUnsafe(
      `INSERT INTO categories ("id","branchId","name","slug","icon","sortOrder","isActive","createdAt")
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, true, NOW())
       ON CONFLICT DO NOTHING`,
      branchId, c.name, c.slug, c.icon, i,
    )
  }
}

