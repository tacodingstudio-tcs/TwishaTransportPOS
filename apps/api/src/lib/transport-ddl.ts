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
  "createdBy"    UUID,
  "createdAt"    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
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
]
