# Transport Platform — Architecture

This repo is the transport vertical of HisabKitab. The platform architecture (schema-per-tenant
PostgreSQL, JWT → `req.db`, domain registry, shared invoice/GST/payment core) is unchanged — see the
billingPlatform `ARCHITECTURE.md` for the long-form explanation. This document covers what is
**specific to transport** and the decisions behind it.

## 1. Shape of the system

```
React (apps/web)  ──/api──▶  Fastify (apps/api)  ──▶  PostgreSQL
                                   │                    ├─ public.tenants, refresh_tokens, idempotency_keys
                                   │                    └─ t_<slug>.*   one schema per business
                                   └─ routes/transport*.ts  (raw SQL on transport_* tables)
                                      routes/invoices.ts … (shared billing core, Prisma)
```

* **One tenant = one business = one branch.** The branch row still exists (the shared core is keyed by
  `branchId`), but `POST /api/branches` returns 403 and the UI is "Business & Users".
* **One domain**, `transport`, in `packages/domain-registry`. It supplies the Zod schemas the shared
  invoice/product services validate against (`invoiceData`, `productAttrs`, `itemMeta`), feature flags,
  default branch config and transport expense categories.
* Tenant tables are created by `create_tenant_schema()` (`docker/init.sql`, generic billing tables) and
  then `provisionTenantSchema()` (`apps/api/src/lib/provision-schema.ts`), which also runs
  `lib/transport-ddl.ts`. Both are idempotent; `pnpm provision:all` re-applies to existing tenants.

## 2. Data model (transport tables, per tenant schema)

Raw-SQL tables (not in `schema.prisma`) with camelCase quoted columns, every row carrying `branchId`.

| Table | Purpose | Key facts |
|---|---|---|
| `transport_vehicles` | Fleet | unique `(branchId, regNo)`; `ownership` own/attached/market; 6 compliance expiry dates; `status` available/on_trip/maintenance/inactive |
| `transport_drivers` | Drivers | licence + expiry; pay type; `status` available/on_trip/off_duty/inactive |
| `transport_routes` | Rate card | lane + basis + rate; optional `partyId` (customer-specific) and `vehicleType` |
| `transport_lorry_receipts` | LR / consignment note | party snapshots (name/GSTIN/address copied at booking), goods, `actualWeightKg` (= load qty), `unloadWeightKg`, `weightBasis` (manual/load/unload/lower), `gatePassNo`, `shipmentNo`, e-way, freight type, charges, `status`, `tripId`, `invoiceId`, `billLockedAt` |
| `transport_trips` | One vehicle run carrying 1..n LRs | `tripNo`, driver/vehicle, odometer, driver advance, hire charges (market vehicles) |
| `transport_expenses` | Fuel, tolls, repairs… | linked to a trip and/or a vehicle; `paymentMode` drives driver settlement |
| `transport_counters` | Atomic numbering | `(branchId, kind, fy)` → last value |

A **freight bill is not a new table**: it is a `sale_invoice` created through
`services/invoice.service.ts` (one line per LR, SAC `996791`), and the LRs point at it via
`invoiceId`. Numbering, GST split, party balance, payments, aging, GSTR-1 and PDFs therefore come for free.

### Numbering
`LR-<FY>-0001`, `TRP-<FY>-0001` — an operator may type their own LR number instead (unique per business, case-insensitive; it never touches the auto series); FY label is the Indian financial year (`2627` for Apr-2026…Mar-2027),
derived from the document date in IST. Allocation is a single `INSERT … ON CONFLICT DO UPDATE …
RETURNING` on `transport_counters` — race-free without locks. Prefixes come from branch config.

## 3. State machines

**LR** `booked → in_transit → delivered → pod_received → billed`, plus `cancelled`.
* `booked → in_transit` when its trip starts (or when attached to an already-running trip).
* `delivered` via *Mark delivered* or trip completion with "mark all delivered".
* `billed` when a freight bill is created; cancelling the bill (`POST /api/invoices/:id/cancel`)
  **releases** the LR back to `delivered`/`pod_received`.
* Billed LRs cannot be edited or cancelled; cancelled LRs cannot be billed.

**Trip** `planned → running → completed`, or `cancelled` (not once any LR is delivered/billed).
* **Start** atomically claims the vehicle (`UPDATE … SET status='on_trip' WHERE status='available'
  RETURNING`) and the driver; if the driver is busy the vehicle claim is rolled back. Two simultaneous
  starts on one truck: exactly one wins.
* **Complete** requires every LR delivered (or an explicit *mark all delivered*), and an end odometer
  ≥ start; releases vehicle and driver and advances the vehicle odometer.
* Expired fitness/permit/insurance and missing e-way bills produce **warnings**, not blocks.

**Vehicle/driver `on_trip`** is only ever set/cleared by trips — the PATCH endpoints refuse it.

## 4. Money

* All freight arithmetic is **server-side** (`computeFreight` in `routes/transport-lr.ts`). The UI
  previews but never decides: a client-sent `freightAmount` is ignored unless the basis is `fixed`.
  Bases: per ton, per kg, per package, fixed. `total = freight + loading + unloading + detention + other`.
* **Trip P&L** = LR freight (excl. GST) − trip expenses − vehicle hire. Driver salaries and overheads
  are not allocated to trips. **Driver settlement** = advance − cash-paid expenses.
* **Quantity & basis.** Freight can be charged on load, unload, or the lower of the two; recording the unload quantity at delivery re-prices unload/lower LRs. Rate × load qty reproduces the usual "MT × rate" bills exactly.
* **TDS** = round(freight excl. GST × rate%), stored in the bill's `domainData.tds_amount`; net receivable = grand total − TDS.
  `POST /bills/:id/tds` books the deducted amount as a `payment` of method `tds` allocated to the bill (through the shared
  `recordPayment`, so status / party balance / aging follow); it is capped at the remaining TDS and undone by voiding the payment.
* **GST modes** (`rcm | forward_5 | forward_12 | forward_18 | exempt`, `gstRateForMode` in the registry).
  RCM bills carry ₹0 tax and a reverse-charge note. CGST+SGST vs IGST: branch `stateCode` vs party
  `address.stateCode`, decided by the shared invoice service.
* **Billing concurrency** — three layers: (1) the client `Idempotency-Key` wraps the whole operation so a
  retry returns the original bill; (2) without a key, a derived key (LR set + each LR's `updatedAt`)
  dedupes double-clicks; (3) an atomic LR claim (`billLockedAt`, 2-minute stale timeout) stops two
  *different* clients billing the same LR — the loser gets 409.

## 5. API surface (`/api/transport`)

| Group | Endpoints |
|---|---|
| Dashboard | `GET /dashboard` |
| Vehicles | `GET/POST /vehicles`, `GET/PATCH/DELETE /vehicles/:id` |
| Drivers | `GET/POST /drivers`, `GET/PATCH/DELETE /drivers/:id` (detail = advance ledger) |
| Rate card | `GET/POST /routes`, `GET /routes/lookup?from&to&partyId&vehicleType`, `PATCH/DELETE /routes/:id`, `GET /cities` |
| Compliance | `GET /compliance?days=` |
| LRs | `GET/POST /lrs`, `GET/PATCH /lrs/:id`, `POST /lrs/:id/{assign,unassign,deliver,pod,collect,cancel}`, `GET /lrs-eway-expiring`, `GET /utils/eway-validity` |
| Trips | `GET/POST /trips`, `GET/PATCH /trips/:id`, `POST /trips/:id/{start,complete,cancel,lrs}`, `DELETE /trips/:id/lrs/:lrId` |
| Expenses | `GET/POST /expenses`, `DELETE /expenses/:id` |
| Billing | `GET /bills/candidates`, `POST /bills` (response includes `tdsAmount`, `netReceivable`) |
| Bulk entry | `POST /lrs/bulk` — one customer, up to 200 rows, all-or-nothing in a single transaction; receiver defaults to the customer; `markDelivered` for history |
| Reports | `GET /reports/{trip-pnl,vehicle-pnl,party-business}` |

Roles: `viewer` read-only (403 on writes); `cashier` can book/bill/record; `owner`/`manager` can also
cancel LRs/trips, delete master data and change settings.

## 6. Conventions & gotchas

* **Raw SQL helpers** (`lib/transport-helpers.ts`): `q/q1/run`, `insertRow/updateRow` (adds the
  `::uuid/::date/::timestamptz` casts Postgres needs), `tbl()` (validated schema-qualified names).
* **Prisma returns `NUMERIC` as Decimal and `COUNT()` as BigInt** — `norm()` converts both to numbers
  so JSON is correct. Never return raw `$queryRaw` rows.
* **`DATE` columns arrive as `Date` at UTC midnight** — use `ymd()` / `fmtDate` (UTC), never
  `String(date).slice(...)`.
* **Business dates are IST**: `todayStr()`, `fyLabel()`; the server may run in UTC.
* Web: React Query + `transportApi` in `lib/api.ts`; shared UI in `components/transport/`
  (`Modal`, `StatusPill`, `PartyPicker`, `CityInput`, `format.ts`). Toasts sit bottom-right so they
  never cover page-header actions.
* Printing: `/transport/lrs/:id/print` renders outside the app shell; `window.print()` produces the
  3-copy consignment note.

## 7. Differences from billingPlatform

Removed: all other domains, hotel/restaurant/coaching/clinic/lab/gym/petrol modules and tables,
mobile app, legacy SQL/`apply-*.mjs` scripts, multi-branch management, per-domain tests.
Added: the transport module above, a fresh Prisma baseline, DB scripts that read `apps/api/.env`.

Fixed along the way (worth back-porting to billingPlatform / hotelPlatform):
* `lib/idempotency.ts` — the "claim" step let **every** concurrent duplicate pass (the winner's row is
  also `processing`); it is now one atomic `INSERT … RETURNING`.
* Web login could never sign in staff users (always sent the user's own phone as the business phone).
* Tenant registration left an orphan schema behind when provisioning failed.
* Invoice prefix came out as `SHREE--26-…` (slug hyphen kept).
* A handful of strict-mode type errors so `tsc` builds clean (`pnpm --filter @billing/api build`).
