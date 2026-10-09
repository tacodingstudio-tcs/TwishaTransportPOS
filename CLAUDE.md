# Transport Platform — CLAUDE.md

Goods-transport billing + operations (LR → trip → POD → GST freight bill). Transport vertical of
HisabKitab; same architecture as billingPlatform. Read `README.md` (run it) and `docs/ARCHITECTURE.md`
(how it works) first.

## Commands

```bash
pnpm install
docker compose -f docker/docker-compose.yml up -d postgres redis   # PG :5434, Redis :6381
cp .env.example apps/api/.env && pnpm db:migrate:prod
pnpm --filter @billing/api dev      # API :3100        pnpm --filter @billing/web dev   # Web :5174
pnpm seed                           # demo tenant: owner 9100000001 / 1111
pnpm test:api                       # 70 integration tests — needs the API running
pnpm e2e                            # Chrome flow — needs API + web + seed
pnpm provision:all                  # re-apply tenant DDL to existing tenants after transport-ddl.ts changes
(cd apps/api && npx tsc --noEmit)   # typecheck (tests are excluded from the build; ts-jest checks them)
(cd apps/web && npx tsc --noEmit)
```

The API does **not** hot-reload under `tsx` (use `tsx watch` or restart after server edits). Don't start
it on :3000/:3001 — those belong to billingPlatform.

## Where things live

* `apps/api/src/routes/transport-{fleet,lr,trips,billing}.ts` — the module; `transport.ts` mounts them.
* `apps/api/src/lib/transport-ddl.ts` — tenant tables (add columns with `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS` *and* in the `CREATE TABLE`, then run `pnpm provision:all`). Statements must start with
  `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` (see `runDDL`).
* `apps/api/src/lib/transport-helpers.ts` — raw-SQL helpers, IST dates, numbering, role guards.
* `packages/domain-registry/src/index.ts` — the `transport` domain (Zod schemas, GST modes, expense categories).
* `apps/web/src/pages/transport/*`, `components/transport/*`, `transportApi` in `lib/api.ts`.
* `apps/api/scripts/seed-demo.ts` — seeds through the real HTTP API (doubles as a smoke test).

## Rules that bite

1. **Never return raw `$queryRaw` rows** — NUMERIC→Decimal (JSON string) and COUNT→BigInt (JSON throws).
   Go through `q()/q1()` (they `norm()`), or `Number()` explicitly.
2. **DATE columns are `Date` objects at UTC midnight.** Use `ymd()`/`fmtDate`; never `String(d).slice()`.
3. **Business dates are IST**, server may be UTC: `todayStr()`, `fyLabel()`.
4. **Freight maths is server-side only.** Change `computeFreight` (weight basis: manual/load/unload/lower), mirror it in
   `LrFormPage.chargedKg/previewFreight` and `QuickEntryPage.calc` (previews only), and cover it in `transport.test.ts`.
   Quantities are stored in **kg**; the UI shows MT. The acceptance test in `transport.test.ts` reproduces a real bill — keep it green.
5. **Trip start/complete and LR billing rely on atomic claims** (`UPDATE … WHERE status=… RETURNING`,
   `billLockedAt`). Don't replace them with read-then-write.
6. `on_trip` for vehicles/drivers is owned by trips. Don't expose it on PATCH.
7. Raw SQL: parameterise everything; identifiers only via `tbl()`/fixed strings; `insertRow/updateRow`
   add the `::uuid/::date/::timestamptz` casts (add new columns to `COL_CAST`).
8. Domain-data/Zod schemas in the registry are `.strict()` — a new bill field must be added there.
9. Single business: don't add branch pickers; `POST /api/branches` is intentionally 403.

## Testing notes

`transport.test.ts` registers its own tenants (phones `7xxxxxxxxx`, purged by `global-setup.ts`), so it
never depends on seed data. The jest harness adds a *unique* `Idempotency-Key` to every POST — pass an
explicit header in a test when you want to exercise replay behaviour. After editing server code,
**restart the API** before running tests.

## Not done / ideas

E-way bill generation through the GST portal; ledger posting of To-Pay collections; TDS ledger; driver
mobile app & GPS; server-side LR PDF; passenger/cab sub-domain (add a second entry to the domain
registry). Package scope is intentionally still `@billing/*` to keep patches portable.
