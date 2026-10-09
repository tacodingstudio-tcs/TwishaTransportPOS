# HisabKitab Transport Platform

Billing + operations software for an Indian **goods-transport business** (trucking company, GTA, fleet
owner, transport agent). It is the transport vertical of the HisabKitab billing platform — same stack,
same architecture, same UI shell — as its own repository.

What it covers: **lorry receipts (LR / consignment notes) → trips → delivery & POD → GST freight bills →
collections**, plus fleet, drivers, compliance alerts, rate cards, trip P&L and the usual books
(invoices, payments, aging, GST reports, stores, staff) inherited from the billing core.

> Scope: goods transport. Passenger buses / cabs / couriers are not modelled. One tenant = one business
> = one branch (additional branches are deliberately blocked).

## What's in it

| Area | Screens (sidebar) | Notes |
|---|---|---|
| **Operations** | Dashboard · Lorry Receipts · Quick Entry · Trips · Freight Billing | LR booking with live freight calc, rate-card auto-fill, load vs unload quantity (charge on load / unload / lower), gate-pass & shipment no, your own LR numbers, e-way bill fields & validity helper, print-ready 3-copy consignment note. **Quick Entry** books a month of trips for one customer from a grid you can paste Excel into |
| **Fleet** | Vehicles · Drivers · Compliance · Rate Card | Fitness / permit / national permit / insurance / PUC / road-tax expiry alerts, driver licence expiry, per-vehicle cost & mileage, customer-specific lane rates |
| **Money** | Trip Expenses · Overheads · Trip Reports · GST & Books · Analytics · Aging · Advances · Approvals | Per-trip and per-vehicle P&L, driver advance settlement, GST freight bills via the shared invoice engine |
| **Core (inherited)** | Invoices · Customers · Stores (tyres, spares) · Quotations · Contracts · Staff · AI · Broadcast | Unchanged billing-platform modules |

**Freight billing & GST.** A freight bill is a normal `sale_invoice` raised from one or more delivered LRs
(SAC `996791`, goods transport agency). Per bill you choose: **RCM** (GTA 5%, payable by the recipient —
the bill carries ₹0 GST and a reverse-charge note), or forward charge at 5% / 12% / 18%. CGST+SGST vs IGST
is picked automatically from the customer's state. **TDS** (1% / 2%) is computed on the freight excl. GST, rounded to the rupee, with the net receivable shown. When the customer pays the net amount, **Record TDS** on the invoice books the deducted part so the bill closes exactly. The invoice's **Freight statement** button prints the transporter-style bill (one row per trip: date, truck, LR, gate pass, destination, shipment no, load/unload MT, rate, amount; then GST, TDS, net receivable, amount in words, bank details, GTA declaration). PAN, bank details, declaration, terms and GST defaults live in *Business & Users → Edit business*.
Rates, SAC and thresholds are configuration, **not tax advice — confirm with your CA** (GST rate
notifications change).

## Run it locally

Requirements: Node ≥ 20, pnpm 9, Docker.

```bash
pnpm install

# 1. Postgres (5434) + Redis (6381) — isolated from the billing/hotel stacks
docker compose -f docker/docker-compose.yml up -d postgres redis

# 2. Config + database
cp .env.example apps/api/.env          # defaults already match docker-compose
pnpm db:migrate:prod                   # Prisma baseline (public schema: tenants)

# 3. Run (two terminals)
pnpm --filter @billing/api dev         # API  → http://localhost:3100
pnpm --filter @billing/web dev         # Web  → http://localhost:5174

# 4. Demo data (API must be running)
pnpm seed
```

Log in at http://localhost:5174 — **owner `9100000001` / `1111`** (Shree Ganesh Roadlines, 8 vehicles,
6 drivers, ~20 LRs, 14 trips, 3 freight bills). Staff: *Staff member? Sign in with the business phone* →
manager `9100000011` / `2222`, read-only viewer `9100000012` / `3333`, business phone `9100000001`.
Or click **Create account** to onboard a fresh transporter.

| Thing | Where |
|---|---|
| API / Web | `localhost:3100` / `localhost:5174` (Vite proxies `/api` → 3100) |
| Postgres | `localhost:5434`, db `billing_db`, user `billing_app` / `localdev123` |
| pgAdmin / Redis UI (optional) | `docker compose … up -d` → `localhost:5051`, `localhost:8082` |

Ports differ from billingPlatform (3000/5432) and hotelPlatform (5433) so all can run side by side.

## Tests

```bash
pnpm test:api   # 70 integration tests against the running API (self-provisioning throwaway tenants)
pnpm e2e        # drives the real UI in Chrome: book LR → trip → POD → GST bill → staff login
```

The API suite includes an acceptance test that rebuilds a real 14-trip GTA bill (₹4,48,239.48 freight → 18% GST → ₹5,28,923, TDS ₹4,482, net ₹5,24,441) and checks every figure. It also covers freight maths, LR numbering under concurrency, trip state machine (vehicle/driver
claim races), P&L, GST split (CGST/SGST vs IGST vs RCM), idempotent retries, double-billing races,
role permissions and tenant isolation. `pnpm e2e` needs the stack + seed running and Chrome installed
(`CHROME_PATH` to override); screenshots land in `e2e/out/`.

## Existing databases

New transport tables/columns are added by `provisionTenantSchema()` when a tenant is created. After
pulling changes that touch `apps/api/src/lib/transport-ddl.ts`, bring existing tenants up to date:

```bash
pnpm provision:all
```

## Layout

```
apps/api            Fastify API (TypeScript). routes/transport*.ts is the transport module
apps/web            React + Vite + Tailwind. pages/transport/* is the transport UI
packages/db         Prisma schema (public tenants + shared billing models) and baseline migration
packages/domain-registry   the single `transport` domain: Zod schemas, features, expense categories
packages/gst-engine · pdf · shared   unchanged billing-core packages
docs/ARCHITECTURE.md       data model, state machines, API surface, decisions
e2e/                Chrome end-to-end flow
```

Package scope is still `@billing/*` on purpose, so fixes can be ported between this repo and
billingPlatform without renames.

## Known limits

- **E-way bills** are recorded (number, validity, expiry alerts, validity calculator) but not generated
  or extended through the GST portal.
- **To-Pay collections** are tracked on the LR; they are not posted to the cash book / ledger.
- **TDS (Sec 194C)**: computed on the bill and recorded with *Record TDS* on the invoice (a payment of method "TDS", so outstanding, status and customer balance update; void it to undo). There is no TDS ledger, Form 26AS matching or certificate tracking.
- LR printing uses the browser print dialog (3 copies per page set); no server-side PDF for LRs.
- No driver mobile app, GPS tracking or fuel-card integration; the inherited `mobile` app was dropped.
- Inherited generic modules (aging, advances, approvals, contracts, quotations pipeline, stores, staff,
  AI) load and run against transport data but are not re-tested in depth here; the original
  billing-platform tests for them were removed because they depended on other verticals' seed data.
