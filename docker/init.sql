-- =============================================================================
-- docker/init.sql
-- Runs automatically when the Postgres container first starts.
-- Sets up roles, extensions, public-schema infrastructure, and the
-- create_tenant_schema() function used to provision each new tenant.
--
-- Column names here must match packages/db/prisma/schema.prisma exactly
-- (camelCase, no @map annotations) because Prisma emits unqualified column
-- names and relies on search_path to route queries to the right schema.
-- =============================================================================

-- ── EXTENSIONS ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- ── APP ROLE ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'billing_app') THEN
    CREATE ROLE billing_app LOGIN PASSWORD 'localdev123';
  END IF;
END $$;

GRANT CONNECT ON DATABASE billing_db TO billing_app;
GRANT USAGE  ON SCHEMA public TO billing_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app;
GRANT USAGE  ON ALL SEQUENCES IN SCHEMA public TO billing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO billing_app;

-- ── READ-ONLY ROLE ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'billing_readonly') THEN
    CREATE ROLE billing_readonly LOGIN PASSWORD 'localdev_readonly';
  END IF;
END $$;

GRANT CONNECT ON DATABASE billing_db TO billing_readonly;
GRANT USAGE  ON SCHEMA public TO billing_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO billing_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO billing_readonly;

-- ── PUBLIC SCHEMA TABLES ──────────────────────────────────────────────────────
-- Intentionally empty here. `tenants` comes from the Prisma baseline migration
-- (packages/db/prisma/migrations), and the API creates refresh_tokens / idempotency_keys
-- itself at boot (CREATE TABLE IF NOT EXISTS). Keeping `public` table-free at init time is
-- what lets `prisma migrate deploy` run cleanly on a brand-new database.

-- =============================================================================
-- create_tenant_schema(p_schema TEXT)
--
-- Call this once when a new tenant is onboarded.
-- Creates a dedicated PostgreSQL schema and provisions all application tables
-- inside it — no tenantId column needed since the schema IS the isolation boundary.
--
-- IMPORTANT: Column names here MUST match the Prisma migration SQL exactly
-- (camelCase). Prisma emits unqualified table/column names and relies on
-- search_path=t_{slug} to route queries to the right schema.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_tenant_schema(p_schema TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Create schema and grant access
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO billing_app', p_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO billing_readonly', p_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app', p_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO billing_readonly', p_schema);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE ON SEQUENCES TO billing_app', p_schema);

  -- ── branches ───────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.branches (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT        NOT NULL,
      gstin         TEXT,
      address       JSONB,
      "stateCode"   TEXT,
      "domainType"  TEXT        NOT NULL,
      "domainConfig" JSONB      NOT NULL DEFAULT ''{}''::jsonb,
      "isActive"    BOOLEAN     NOT NULL DEFAULT TRUE,
      "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )', p_schema);

  -- ── users ──────────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.users (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT        NOT NULL,
      phone       TEXT        NOT NULL UNIQUE,
      email       TEXT,
      role        TEXT        NOT NULL DEFAULT ''cashier'',
      "branchIds" UUID[]      NOT NULL DEFAULT ''{}''::uuid[],
      pin         TEXT,
      lang        TEXT        NOT NULL DEFAULT ''hi'',
      "isActive"  BOOLEAN     NOT NULL DEFAULT TRUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )', p_schema);

  -- ── parties ────────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.parties (
      id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"    UUID,
      type          TEXT           NOT NULL,
      name          TEXT           NOT NULL,
      phone         TEXT,
      email         TEXT,
      gstin         TEXT,
      pan           TEXT,
      address       JSONB,
      "creditLimit" DECIMAL(12,2)  NOT NULL DEFAULT 0,
      balance       DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "loyaltyPts"  INTEGER        NOT NULL DEFAULT 0,
      meta          JSONB          NOT NULL DEFAULT ''{}''::jsonb,
      "isActive"    BOOLEAN        NOT NULL DEFAULT TRUE,
      "createdAt"   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("branchId") REFERENCES %I.branches(id)
    )', p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS parties_type_idx   ON %I.parties(type)',       p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS parties_phone_idx  ON %I.parties(phone)',      p_schema);

  -- ── products ───────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.products (
      id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"      UUID,
      "categoryId"    UUID,
      "itemType"      TEXT           NOT NULL DEFAULT ''product'',
      name            TEXT           NOT NULL,
      "nameLocal"     TEXT,
      sku             TEXT,
      barcode         TEXT,
      "hsnSacCode"    TEXT,
      "gstRate"       DECIMAL(5,2)   NOT NULL DEFAULT 0,
      "gstExempt"     BOOLEAN        NOT NULL DEFAULT FALSE,
      unit            TEXT           NOT NULL DEFAULT ''pcs'',
      "purchasePrice" DECIMAL(12,2),
      "salePrice"     DECIMAL(12,2)  NOT NULL DEFAULT 0,
      mrp             DECIMAL(12,2),
      "trackStock"    BOOLEAN        NOT NULL DEFAULT TRUE,
      "lowStockQty"   DECIMAL(10,3)  NOT NULL DEFAULT 0,
      "domainAttrs"   JSONB          NOT NULL DEFAULT ''{}''::jsonb,
      "isActive"      BOOLEAN        NOT NULL DEFAULT TRUE,
      "createdAt"     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      "updatedAt"     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("branchId") REFERENCES %I.branches(id)
    )', p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "products_branchId_idx" ON %I.products("branchId")', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS products_barcode_idx    ON %I.products(barcode)',     p_schema);

  -- ── invoices ───────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.invoices (
      id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"    UUID           NOT NULL,
      "partyId"     UUID,
      "createdBy"   UUID           NOT NULL,
      "txnType"     TEXT           NOT NULL,
      number        TEXT           NOT NULL,
      date          DATE           NOT NULL,
      "dueDate"     DATE,
      status        TEXT           NOT NULL DEFAULT ''draft'',
      subtotal      DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "discountAmt" DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "taxableAmt"  DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "cgstTotal"   DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "sgstTotal"   DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "igstTotal"   DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "cessTotal"   DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "roundOff"    DECIMAL(5,2)   NOT NULL DEFAULT 0,
      "grandTotal"  DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "paidAmt"     DECIMAL(12,2)  NOT NULL DEFAULT 0,
      notes         TEXT,
      "domainData"  JSONB          NOT NULL DEFAULT ''{}''::jsonb,
      "aiMeta"      JSONB          NOT NULL DEFAULT ''{}''::jsonb,
      "createdAt"   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      "updatedAt"   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("branchId")  REFERENCES %I.branches(id),
      FOREIGN KEY ("partyId")   REFERENCES %I.parties(id),
      FOREIGN KEY ("createdBy") REFERENCES %I.users(id),
      UNIQUE ("branchId", "txnType", number)
    )', p_schema, p_schema, p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "invoices_branchId_date_idx" ON %I.invoices("branchId", date DESC)', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "invoices_partyId_idx"       ON %I.invoices("partyId")',             p_schema);

  -- ── invoice_items ──────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.invoice_items (
      id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "invoiceId"   UUID           NOT NULL,
      "productId"   UUID,
      "batchId"     UUID,
      description   TEXT           NOT NULL,
      "hsnSacCode"  TEXT,
      qty           DECIMAL(10,3)  NOT NULL,
      unit          TEXT           NOT NULL DEFAULT ''pcs'',
      rate          DECIMAL(12,4)  NOT NULL,
      "discountPct" DECIMAL(5,2)   NOT NULL DEFAULT 0,
      "discountAmt" DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "taxableAmt"  DECIMAL(12,2)  NOT NULL,
      "gstRate"     DECIMAL(5,2)   NOT NULL DEFAULT 0,
      "cgstAmt"     DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "sgstAmt"     DECIMAL(12,2)  NOT NULL DEFAULT 0,
      "igstAmt"     DECIMAL(12,2)  NOT NULL DEFAULT 0,
      total         DECIMAL(12,2)  NOT NULL,
      "sortOrder"   INTEGER        NOT NULL DEFAULT 0,
      "itemMeta"    JSONB          NOT NULL DEFAULT ''{}''::jsonb,
      FOREIGN KEY ("invoiceId") REFERENCES %I.invoices(id)   ON DELETE CASCADE,
      FOREIGN KEY ("productId") REFERENCES %I.products(id)
    )', p_schema, p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "invoice_items_invoiceId_idx" ON %I.invoice_items("invoiceId")', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "invoice_items_productId_idx" ON %I.invoice_items("productId")', p_schema);

  -- ── payments ───────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.payments (
      id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"    UUID           NOT NULL,
      "partyId"     UUID,
      amount        DECIMAL(12,2)  NOT NULL,
      method        TEXT           NOT NULL,
      "refNo"       TEXT,
      "paymentDate" DATE           NOT NULL DEFAULT CURRENT_DATE,
      notes         TEXT,
      "createdBy"   UUID           NOT NULL,
      "createdAt"   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("partyId") REFERENCES %I.parties(id)
    )', p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "payments_branchId_paymentDate_idx" ON %I.payments("branchId", "paymentDate" DESC)', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "payments_partyId_idx"              ON %I.payments("partyId")',                      p_schema);

  -- ── payment_allocations ────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.payment_allocations (
      id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      "paymentId" UUID          NOT NULL,
      "invoiceId" UUID          NOT NULL,
      amount      DECIMAL(12,2) NOT NULL,
      FOREIGN KEY ("paymentId") REFERENCES %I.payments(id),
      FOREIGN KEY ("invoiceId") REFERENCES %I.invoices(id)
    )', p_schema, p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "payment_allocations_paymentId_idx" ON %I.payment_allocations("paymentId")', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "payment_allocations_invoiceId_idx" ON %I.payment_allocations("invoiceId")', p_schema);

  -- ── stock_ledger ───────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.stock_ledger (
      id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"   UUID           NOT NULL,
      "productId"  UUID           NOT NULL,
      "variantId"  UUID,
      "batchId"    UUID,
      "txnType"    TEXT           NOT NULL,
      qty          DECIMAL(10,3)  NOT NULL,
      rate         DECIMAL(12,4),
      "refType"    TEXT,
      "refId"      UUID,
      "createdAt"  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("productId") REFERENCES %I.products(id)
    )', p_schema, p_schema);
  EXECUTE format('ALTER TABLE %I.stock_ledger ADD COLUMN IF NOT EXISTS "variantId" UUID', p_schema);
  EXECUTE format('ALTER TABLE %I.stock_ledger ADD COLUMN IF NOT EXISTS "notes" TEXT', p_schema);
  EXECUTE format('ALTER TABLE %I.stock_ledger ADD COLUMN IF NOT EXISTS "createdBy" UUID', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "stock_ledger_branchId_productId_idx" ON %I.stock_ledger("branchId", "productId")',          p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "stock_ledger_branchId_createdAt_idx" ON %I.stock_ledger("branchId", "createdAt" DESC)', p_schema);

  -- ── batches ────────────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.batches (
      id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "productId"     UUID           NOT NULL,
      "batchNo"       TEXT           NOT NULL,
      "mfgDate"       DATE,
      "expDate"       DATE           NOT NULL,
      "qtyReceived"   DECIMAL(10,3)  NOT NULL,
      "qtyRemaining"  DECIMAL(10,3)  NOT NULL,
      "purchaseRate"  DECIMAL(12,4),
      "createdAt"     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("productId") REFERENCES %I.products(id)
    )', p_schema, p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS "batches_productId_expDate_idx" ON %I.batches("productId", "expDate")', p_schema);

  -- ── razorpay_orders ────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.razorpay_orders (
      id                    UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"            UUID           NOT NULL,
      "invoiceId"           UUID           NOT NULL,
      "razorpayOrderId"     TEXT           NOT NULL UNIQUE,
      amount                DECIMAL(12,2)  NOT NULL,
      status                TEXT           NOT NULL DEFAULT ''created'',
      "shortUrl"            TEXT,
      "razorpayPaymentId"   TEXT,
      "paidAt"              TIMESTAMPTZ,
      "createdBy"           UUID           NOT NULL,
      "createdAt"           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      "updatedAt"           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
      FOREIGN KEY ("invoiceId") REFERENCES %I.invoices(id)
    )', p_schema, p_schema);

  -- ── invoice_sequences ──────────────────────────────────────────────────────
  -- Keyed by (branch_id, txn_type, fy) so sequences reset each financial year.
  -- invoice-number.ts uses pg_advisory_xact_lock + INSERT ... ON CONFLICT DO UPDATE.
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.invoice_sequences (
      branch_id   UUID   NOT NULL,
      txn_type    TEXT   NOT NULL,
      fy          TEXT   NOT NULL DEFAULT to_char(now(),''YY''),
      current_val BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (branch_id, txn_type, fy)
    )', p_schema);

  -- ── notifications ─────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.notifications (
      id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      "branchId"   UUID        NOT NULL,
      type         TEXT        NOT NULL,
      title        TEXT        NOT NULL,
      body         TEXT        NOT NULL,
      payload      JSONB       NOT NULL DEFAULT ''{}''::jsonb,
      "isRead"     BOOLEAN     NOT NULL DEFAULT false,
      "readAt"     TIMESTAMPTZ,
      approved     BOOLEAN,
      "approvedAt" TIMESTAMPTZ,
      "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.notifications("branchId","isRead")',
    p_schema || '_notif_branch_read', p_schema);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.notifications("branchId","createdAt" DESC)',
    p_schema || '_notif_branch_date', p_schema);

  -- ── idempotency_keys ───────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.idempotency_keys (
      key         TEXT        PRIMARY KEY,
      response    JSONB       NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )', p_schema);

  -- ── ai_suggestions ─────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.ai_suggestions (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"  UUID        NOT NULL,
      "inputHash" TEXT        NOT NULL,
      suggestion  JSONB       NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )', p_schema);
  EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS "ai_suggestions_branchId_inputHash_idx" ON %I.ai_suggestions("branchId", "inputHash")', p_schema);

  -- ── bank_accounts ───────────────────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.bank_accounts (
      id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      "branchId"       UUID          NOT NULL,
      name             TEXT          NOT NULL,
      "bankName"       TEXT,
      "accountNumber"  TEXT,
      "ifscCode"       TEXT,
      "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
      "currentBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
      "isActive"       BOOLEAN       NOT NULL DEFAULT true,
      "createdAt"      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )', p_schema);

  -- ── bank_reconciliation_entries ─────────────────────────────────────────────
  EXECUTE format('
    CREATE TABLE IF NOT EXISTS %I.bank_reconciliation_entries (
      id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      "bankAccountId" UUID          NOT NULL,
      "branchId"      UUID          NOT NULL,
      "entryDate"     DATE          NOT NULL,
      description     TEXT,
      amount          DECIMAL(14,2) NOT NULL,
      type            TEXT          NOT NULL DEFAULT ''credit'',
      "paymentId"     UUID,
      "isReconciled"  BOOLEAN       NOT NULL DEFAULT false,
      "createdAt"     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )', p_schema);

  RAISE NOTICE 'Tenant schema % created successfully', p_schema;
END;
$$;

-- Grant execute to app role
GRANT EXECUTE ON FUNCTION public.create_tenant_schema(TEXT) TO billing_app;

DO $$
BEGIN
  RAISE NOTICE 'billing_db initialized: roles, extensions, create_tenant_schema() ready.';
END $$;
