// Transport extension tables — provisioned into every tenant schema by
// provisionTenantSchema() (see provision-schema.ts).
//
// Conventions (same as the hotel_* tables in hotelPlatform):
//   • camelCase quoted column names, UUID PKs, branchId on every row
//   • every statement starts with CREATE TABLE IF NOT EXISTS / ALTER TABLE /
//     CREATE [UNIQUE] INDEX IF NOT EXISTS so runDDL can schema-qualify it
//   • idempotent — safe to re-run on already-provisioned tenants
//   • accessed with raw SQL ($queryRawUnsafe) from routes/transport.ts —
//     these tables are intentionally NOT in schema.prisma

export const TRANSPORT_DDL: string[] = [
  // ── Fleet ───────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "transport_vehicles" (
  "id"                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"             UUID          NOT NULL,
  "regNo"                TEXT          NOT NULL,
  "vehicleType"          TEXT          NOT NULL DEFAULT 'hcv',
  "makeModel"            TEXT,
  "yearOfMfg"            INTEGER,
  "capacityTons"         NUMERIC(8,2),
  "bodyType"             TEXT,
  "ownership"            TEXT          NOT NULL DEFAULT 'own'
                                         CHECK ("ownership" IN ('own','attached','market')),
  "ownerName"            TEXT,
  "ownerPhone"           TEXT,
  "ownerPan"             TEXT,
  "chassisNo"            TEXT,
  "engineNo"             TEXT,
  "fastagId"             TEXT,
  "fitnessExpiry"        DATE,
  "permitExpiry"         DATE,
  "nationalPermitExpiry" DATE,
  "insuranceExpiry"      DATE,
  "pucExpiry"            DATE,
  "roadTaxExpiry"        DATE,
  "currentOdometer"      INTEGER       NOT NULL DEFAULT 0,
  "status"               TEXT          NOT NULL DEFAULT 'available'
                                         CHECK ("status" IN ('available','on_trip','maintenance','inactive')),
  "defaultDriverId"      UUID,
  "notes"                TEXT,
  "isActive"             BOOLEAN       NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE ("branchId", "regNo")
)`,

  `CREATE TABLE IF NOT EXISTS "transport_drivers" (
  "id"            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"      UUID          NOT NULL,
  "name"          TEXT          NOT NULL,
  "phone"         TEXT,
  "altPhone"      TEXT,
  "licenseNo"     TEXT,
  "licenseClass"  TEXT,
  "licenseExpiry" DATE,
  "bloodGroup"    TEXT,
  "address"       TEXT,
  "joinedOn"      DATE,
  "salaryType"    TEXT          NOT NULL DEFAULT 'monthly'
                                  CHECK ("salaryType" IN ('monthly','per_trip','per_km')),
  "salaryAmount"  NUMERIC(12,2) NOT NULL DEFAULT 0,
  "status"        TEXT          NOT NULL DEFAULT 'available'
                                  CHECK ("status" IN ('available','on_trip','off_duty','inactive')),
  "notes"         TEXT,
  "isActive"      BOOLEAN       NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,

  // ── Rate card ───────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "transport_routes" (
  "id"                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"             UUID          NOT NULL,
  "fromCity"             TEXT          NOT NULL,
  "toCity"               TEXT          NOT NULL,
  "distanceKm"           INTEGER,
  "transitDays"          NUMERIC(4,1),
  "vehicleType"          TEXT,
  "partyId"              UUID,
  "rateBasis"            TEXT          NOT NULL DEFAULT 'fixed'
                                         CHECK ("rateBasis" IN ('fixed','per_ton','per_kg','per_km','per_pkg')),
  "rate"                 NUMERIC(12,2) NOT NULL DEFAULT 0,
  "tollEstimate"         NUMERIC(12,2) NOT NULL DEFAULT 0,
  "dieselLitresEstimate" NUMERIC(8,1),
  "notes"                TEXT,
  "isActive"             BOOLEAN       NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,

  // ── Trips (one vehicle run, carries one or more LRs) ────────────────────────
  `CREATE TABLE IF NOT EXISTS "transport_trips" (
  "id"             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID          NOT NULL,
  "tripNo"         TEXT          NOT NULL,
  "vehicleId"      UUID          NOT NULL,
  "driverId"       UUID,
  "helperName"     TEXT,
  "fromCity"       TEXT          NOT NULL,
  "toCity"         TEXT          NOT NULL,
  "startDate"      DATE          NOT NULL DEFAULT CURRENT_DATE,
  "endDate"        DATE,
  "status"         TEXT          NOT NULL DEFAULT 'planned'
                                   CHECK ("status" IN ('planned','running','completed','cancelled')),
  "startOdometer"  INTEGER,
  "endOdometer"    INTEGER,
  "driverAdvance"  NUMERIC(12,2) NOT NULL DEFAULT 0,
  "hireCharges"    NUMERIC(12,2) NOT NULL DEFAULT 0,
  "hireAdvancePaid" NUMERIC(12,2) NOT NULL DEFAULT 0,
  "notes"          TEXT,
  "createdBy"      UUID,
  "createdAt"      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE ("branchId", "tripNo")
)`,

  // ── Lorry Receipts / consignment notes ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "transport_lorry_receipts" (
  "id"                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"          UUID          NOT NULL,
  "lrNo"              TEXT          NOT NULL,
  "lrDate"            DATE          NOT NULL DEFAULT CURRENT_DATE,
  "consignorId"       UUID,
  "consignorName"     TEXT          NOT NULL,
  "consignorGstin"    TEXT,
  "consignorPhone"    TEXT,
  "consignorAddress"  TEXT,
  "consigneeId"       UUID,
  "consigneeName"     TEXT          NOT NULL,
  "consigneeGstin"    TEXT,
  "consigneePhone"    TEXT,
  "consigneeAddress"  TEXT,
  "fromCity"          TEXT          NOT NULL,
  "toCity"            TEXT          NOT NULL,
  "goodsDescription"  TEXT          NOT NULL,
  "packages"          INTEGER       NOT NULL DEFAULT 0,
  "packageType"       TEXT,
  "actualWeightKg"    NUMERIC(12,2) NOT NULL DEFAULT 0,
  "chargedWeightKg"   NUMERIC(12,2) NOT NULL DEFAULT 0,
  "declaredValue"     NUMERIC(14,2) NOT NULL DEFAULT 0,
  "invoiceRefs"       TEXT,
  "ewayBillNo"        TEXT,
  "ewayValidUpto"     TIMESTAMPTZ,
  "freightType"       TEXT          NOT NULL DEFAULT 'tbb'
                                      CHECK ("freightType" IN ('paid','to_pay','tbb')),
  "rateBasis"         TEXT          NOT NULL DEFAULT 'fixed'
                                      CHECK ("rateBasis" IN ('fixed','per_ton','per_kg','per_pkg')),
  "rate"              NUMERIC(12,2) NOT NULL DEFAULT 0,
  "freightAmount"     NUMERIC(12,2) NOT NULL DEFAULT 0,
  "loadingCharges"    NUMERIC(12,2) NOT NULL DEFAULT 0,
  "unloadingCharges"  NUMERIC(12,2) NOT NULL DEFAULT 0,
  "detentionCharges"  NUMERIC(12,2) NOT NULL DEFAULT 0,
  "otherCharges"      NUMERIC(12,2) NOT NULL DEFAULT 0,
  "advancePaid"       NUMERIC(12,2) NOT NULL DEFAULT 0,
  "totalAmount"       NUMERIC(12,2) NOT NULL DEFAULT 0,
  "gstMode"           TEXT          NOT NULL DEFAULT 'rcm',
  "status"            TEXT          NOT NULL DEFAULT 'booked'
                                      CHECK ("status" IN ('booked','in_transit','delivered','pod_received','billed','cancelled')),
  "tripId"            UUID,
  "vehicleId"         UUID,
  "vehicleNo"         TEXT,
  "driverName"        TEXT,
  "dispatchedAt"      TIMESTAMPTZ,
  "deliveredAt"       TIMESTAMPTZ,
  "receivedBy"        TEXT,
  "podReceivedAt"     TIMESTAMPTZ,
  "podNotes"          TEXT,
  "damageNotes"       TEXT,
  "toPayCollected"    NUMERIC(12,2) NOT NULL DEFAULT 0,
  "toPayCollectedAt"  TIMESTAMPTZ,
  "invoiceId"         UUID,
  "billLockedAt"      TIMESTAMPTZ,
  "unloadWeightKg"    NUMERIC(12,2),
  "weightBasis"       TEXT          NOT NULL DEFAULT 'manual'
                                      CHECK ("weightBasis" IN ('manual','load','unload','lower')),
  "gatePassNo"        TEXT,
  "shipmentNo"        TEXT,
  "remarks"           TEXT,
  "createdBy"         UUID,
  "createdAt"         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE ("branchId", "lrNo")
)`,

  // Existing tenants created before billLockedAt existed pick it up here (idempotent).
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "billLockedAt" TIMESTAMPTZ`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "unloadWeightKg" NUMERIC(12,2)`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "weightBasis" TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "gatePassNo" TEXT`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "shipmentNo" TEXT`,

  // E-way bill (GSP integration): inputs the portal needs beyond the basic LR, and the live status.
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "hsnCode" TEXT`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "fromPincode" TEXT`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "toPincode" TEXT`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "distanceKm" INTEGER`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "supplyDocNo" TEXT`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "supplyDocDate" DATE`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "ewayStatus" TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "ewayGeneratedAt" TIMESTAMPTZ`,
  `ALTER TABLE "transport_lorry_receipts" ADD COLUMN IF NOT EXISTS "ewayCancelledAt" TIMESTAMPTZ`,

  // Every call made to the e-way provider (request/response) — an audit trail for portal disputes.
  `CREATE TABLE IF NOT EXISTS "transport_eway_events" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"   UUID        NOT NULL,
  "lrId"       UUID        NOT NULL,
  "action"     TEXT        NOT NULL,
  "ok"         BOOLEAN     NOT NULL,
  "provider"   TEXT        NOT NULL,
  "ewayBillNo" TEXT,
  "message"    TEXT,
  "request"    JSONB,
  "response"   JSONB,
  "createdBy"  UUID,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

  // Outbound WhatsApp messages: one row per message, so staff can see what was sent / failed and retry.
  `CREATE TABLE IF NOT EXISTS "transport_notifications" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID        NOT NULL,
  "kind"           TEXT        NOT NULL,
  "refType"        TEXT,
  "refId"          UUID,
  "recipientName"  TEXT,
  "toPhone"        TEXT        NOT NULL,
  "message"        TEXT        NOT NULL,
  "attachment"     TEXT,
  "dedupeKey"      TEXT,
  "status"         TEXT        NOT NULL DEFAULT 'queued'
                                 CHECK ("status" IN ('queued','sent','failed','skipped')),
  "error"          TEXT,
  "attempts"       INTEGER     NOT NULL DEFAULT 0,
  "createdBy"      UUID,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sentAt"         TIMESTAMPTZ
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tnotif_dedupe" ON "transport_notifications" ("branchId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "idx_tnotif_ref" ON "transport_notifications" ("refType", "refId")`,
  `CREATE INDEX IF NOT EXISTS "idx_teway_lr" ON "transport_eway_events" ("lrId")`,

  // ── Trip / vehicle expenses ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "transport_expenses" (
  "id"           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"     UUID          NOT NULL,
  "tripId"       UUID,
  "vehicleId"    UUID,
  "driverId"     UUID,
  "category"     TEXT          NOT NULL,
  "amount"       NUMERIC(12,2) NOT NULL,
  "expenseDate"  DATE          NOT NULL DEFAULT CURRENT_DATE,
  "litres"       NUMERIC(8,2),
  "ratePerLitre" NUMERIC(8,2),
  "odometer"     INTEGER,
  "location"     TEXT,
  "paymentMode"  TEXT          NOT NULL DEFAULT 'cash',
  "billNo"       TEXT,
  "notes"        TEXT,
  "paidBy"       TEXT          CHECK ("paidBy" IN ('driver','company','vendor_credit')),
  "vendorName"   TEXT,
  "settledOn"    DATE,
  "settledMode"  TEXT,
  "createdBy"    UUID,
  "createdAt"    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
)`,
  // who paid / pump-account tracking (paidBy NULL on old rows → derived from paymentMode)
  `ALTER TABLE "transport_expenses" ADD COLUMN IF NOT EXISTS "paidBy" TEXT CHECK ("paidBy" IN ('driver','company','vendor_credit'))`,
  `ALTER TABLE "transport_expenses" ADD COLUMN IF NOT EXISTS "vendorName" TEXT`,
  `ALTER TABLE "transport_expenses" ADD COLUMN IF NOT EXISTS "settledOn" DATE`,
  `ALTER TABLE "transport_expenses" ADD COLUMN IF NOT EXISTS "settledMode" TEXT`,

  // ── Bank statements (imported lines, matched to receipts / pump bills / expenses) ──────────────
  // The bank account itself is the shared core's "bank_accounts" table (per firm).
  `CREATE TABLE IF NOT EXISTS "transport_bank_imports" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID        NOT NULL,
  "bankAccountId"  UUID        NOT NULL,
  "fileName"       TEXT,
  "fromDate"       DATE,
  "toDate"         DATE,
  "rowCount"       INTEGER     NOT NULL DEFAULT 0,
  "addedCount"     INTEGER     NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER     NOT NULL DEFAULT 0,
  "createdBy"      UUID,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,

  `CREATE TABLE IF NOT EXISTS "transport_bank_lines" (
  "id"             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "branchId"       UUID          NOT NULL,
  "bankAccountId"  UUID          NOT NULL,
  "importId"       UUID,
  "txnDate"        DATE          NOT NULL,
  "description"    TEXT          NOT NULL DEFAULT '',
  "refNo"          TEXT,
  "debit"          NUMERIC(14,2) NOT NULL DEFAULT 0,
  "credit"         NUMERIC(14,2) NOT NULL DEFAULT 0,
  "balance"        NUMERIC(14,2),
  "seq"            INTEGER       NOT NULL DEFAULT 0,
  "dedupeKey"      TEXT          NOT NULL,
  "status"         TEXT          NOT NULL DEFAULT 'unmatched'
                                   CHECK ("status" IN ('unmatched','matched','ignored')),
  "matchKind"      TEXT          CHECK ("matchKind" IN ('receipt','pump','expense','other')),
  "label"          TEXT,
  "paymentIds"     UUID[]        NOT NULL DEFAULT '{}',
  "tripExpenseIds" UUID[]        NOT NULL DEFAULT '{}',
  "coreExpenseId"  UUID,
  "createdEntries" BOOLEAN       NOT NULL DEFAULT false,
  "notes"          TEXT,
  "matchedAt"      TIMESTAMPTZ,
  "matchedBy"      UUID,
  "createdAt"      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK ("debit" = 0 OR "credit" = 0)
)`,

  // ── Atomic document counters (LR / trip numbers, per financial year) ─────────
  `CREATE TABLE IF NOT EXISTS "transport_counters" (
  "branchId" UUID   NOT NULL,
  "kind"     TEXT   NOT NULL,
  "fy"       TEXT   NOT NULL,
  "lastVal"  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY ("branchId", "kind", "fy")
)`,

  // ── Indexes ─────────────────────────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS "idx_tlr_branch_status" ON "transport_lorry_receipts" ("branchId", "status")`,
  `CREATE INDEX IF NOT EXISTS "idx_tlr_branch_date"   ON "transport_lorry_receipts" ("branchId", "lrDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_tlr_consignor"     ON "transport_lorry_receipts" ("consignorId")`,
  `CREATE INDEX IF NOT EXISTS "idx_tlr_trip"          ON "transport_lorry_receipts" ("tripId")`,
  `CREATE INDEX IF NOT EXISTS "idx_ttrip_branch_status" ON "transport_trips" ("branchId", "status")`,
  `CREATE INDEX IF NOT EXISTS "idx_ttrip_vehicle"     ON "transport_trips" ("vehicleId")`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_trip"         ON "transport_expenses" ("tripId")`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_vehicle_date" ON "transport_expenses" ("vehicleId", "expenseDate")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tbl_dedupe"   ON "transport_bank_lines" ("branchId", "bankAccountId", "dedupeKey")`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_account_date"    ON "transport_bank_lines" ("bankAccountId", "txnDate", "seq")`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_status"          ON "transport_bank_lines" ("branchId", "status")`,
  `CREATE INDEX IF NOT EXISTS "idx_tbi_account"         ON "transport_bank_imports" ("bankAccountId", "createdAt")`,

  // ── Speed at volume (measured with scripts/bench-seed.ts + bench-time.ts) ─────────────────────────────────────────────
  // "which bank line points at this receipt / pump bill?" — array containment, asked once per row in registers and matching.
  // Without these every receipt scanned every bank line (the receipts register took 22 s at 60,000 lines).
  `CREATE INDEX IF NOT EXISTS "idx_tbl_payment_ids"   ON "transport_bank_lines" USING GIN ("paymentIds")`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_expense_ids"   ON "transport_bank_lines" USING GIN ("tripExpenseIds")`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_list"          ON "transport_bank_lines" ("bankAccountId", "status", "txnDate" DESC, "seq" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_tlr_invoice"       ON "transport_lorry_receipts" ("invoiceId") WHERE "invoiceId" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "idx_tlr_vehicle_date"  ON "transport_lorry_receipts" ("vehicleId", "lrDate")`,
  // the order the long lists are shown in, so "the 20 after this one" is an index jump (position-based paging, lib/keyset.ts)
  `CREATE INDEX IF NOT EXISTS "idx_tlr_keyset"        ON "transport_lorry_receipts" ("branchId", "lrDate" DESC, "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_keyset"       ON "transport_expenses" ("branchId", "expenseDate" DESC, "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_keyset"        ON "transport_bank_lines" ("bankAccountId", "txnDate" DESC, "seq" DESC, "id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_keyset"        ON "invoices" ("branchId", "date" DESC, "createdAt" DESC, "id" DESC)`,
  `CREATE INDEX IF NOT EXISTS "idx_ttrip_branch_start" ON "transport_trips" ("branchId", "startDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_ttrip_vehicle_start" ON "transport_trips" ("vehicleId", "startDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_ttrip_driver"      ON "transport_trips" ("driverId")`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_branch_date"  ON "transport_expenses" ("branchId", "expenseDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_branch_cat"   ON "transport_expenses" ("branchId", "category", "expenseDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_texp_unsettled"    ON "transport_expenses" ("branchId") WHERE "settledOn" IS NULL`,
  // the shared billing tables the transport screens and reports lean on
  `CREATE INDEX IF NOT EXISTS "idx_inv_branch_type_status_date" ON "invoices" ("branchId", "txnType", "status", "date")`,
  `CREATE INDEX IF NOT EXISTS "idx_inv_linked"        ON "invoices" ("linkedInvoiceId") WHERE "linkedInvoiceId" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "idx_pay_branch_type_date" ON "payments" ("branchId", "type", "paymentDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_exp_branch_date"   ON "expenses" ("branchId", "date")`,
  `CREATE INDEX IF NOT EXISTS "idx_exp_branch_cat_date" ON "expenses" ("branchId", "category", "date")`,
  `CREATE INDEX IF NOT EXISTS "idx_party_branch_type_name" ON "parties" ("branchId", "type", "name")`,
]

/**
 * Text-search indexes (pg_trgm), so `ILIKE '%…%'` on a big list does not read every row. Built separately because they need the
 * extension: provisioning creates it if it can, and skips these (the search still works, just slower) if it cannot.
 * The search expressions in transport-lr.ts / transport-bank.ts / party.service.ts must match these exactly to use them.
 */
export const LR_SEARCH_EXPR = `(COALESCE("lrNo", '') || ' ' || COALESCE("consignorName", '') || ' ' || COALESCE("consigneeName", '') || ' ' || COALESCE("vehicleNo", '') || ' ' || COALESCE("ewayBillNo", '') || ' ' || COALESCE("goodsDescription", ''))`
export const BANK_SEARCH_EXPR = `(COALESCE("description", '') || ' ' || COALESCE("refNo", ''))`
export const trigramIndexes = (ns: string): string[] => [
  `CREATE INDEX IF NOT EXISTS "idx_tlr_search_trgm"  ON "transport_lorry_receipts" USING GIN (${LR_SEARCH_EXPR} ${ns}.gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "idx_tbl_search_trgm"  ON "transport_bank_lines" USING GIN (${BANK_SEARCH_EXPR} ${ns}.gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "idx_party_name_trgm"  ON "parties" USING GIN ("name" ${ns}.gin_trgm_ops)`,
]
