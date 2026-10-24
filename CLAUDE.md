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
pnpm test:api                       # 159 integration tests — needs the API running
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
* `apps/api/scripts/seed-demo.ts` — seeds through the real HTTP API (doubles as a smoke test); `seed-more-trips.ts`
  (`BATCH=1|2`, `API_URL=…`) adds more varied trips to an existing demo tenant.
  `seed-report-data.ts` fills both Rajhansh firms with Apr→Oct history (older trips, bills, receipts, TDS, pump payments, office costs, bank statements) so every CA report has data;
  run with `cd apps/api && npx tsx scripts/seed-report-data.ts` (idempotent; `API_URL=…` to target another server).
* **Firms** (one login, several business names): `routes/transport-firms.ts` (list / add firm, bill numbering, logo,
  copy customer, goods bills), `hooks/useFirms.ts`, `components/layout/FirmSwitcher.tsx`, `pages/BranchesPage.tsx`
  ("Firms & Staff"), `pages/transport/GoodsBillPage.tsx` + `GoodsHomePage.tsx`.
* **Printed tax invoice**: `packages/shared/src/tax-invoice.ts` (`buildTaxInvoice`) is the single source of what a bill shows;
  `pages/transport/TaxInvoicePrintPage.tsx` (browser) and `renderTaxInvoicePdf` in `lib/transport-pdf.ts` (server PDF /
  WhatsApp) both render it. Change the wording or numbers there, never in one renderer only.
  The **geometry** is `BILL_LAYOUT` in the same file — row heights, column lines, text positions and font sizes in the pixels of the
  scanned paper bills (Rajhansh Roadways no. 15, Enterprise F-3). Both renderers scale it to the page (web: container-query units, PDF:
  points per scan pixel), so the printed bill keeps the paper bill's proportions: outer frame, a thin line just above its bottom edge, an
  empty box above "Taxable Amount", centred column headings. Only the item table stretches. Change a measurement there, once. Bills carry
  **no "Powered by" line** (the LR, the sidebar and the sign-in page keep theirs). To re-check against the scans, render the print page and
  the PDF with the sample's data and overlay them on the scan (that is how the numbers were tuned).

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
9. Expense payer = `paidByExpr()` (`paidBy`, or derived from `paymentMode` on old rows). Only `driver` counts against the advance;
   `vendor_credit` with `settledOn IS NULL` is a payable (grouped by free-text `vendorName`). Profit counts all of them.
10. **Firms = branches.** A tenant can have up to 5 firms (e.g. Rajhansh Roadways `kind: transport` + Rajhansh Enterprise
   `kind: goods`). Everything is already scoped by `branchId`, so each firm has its own LRs, trips, customers, bills and
   numbers. Firms are added only via `POST /api/transport/firms` (owner); the core `POST /api/branches` stays 403. Switching
   uses `POST /api/auth/switch-branch` **with the refresh token** — the refresh token carries the branch, so without it a
   silent refresh drops the user back into the first firm. `firm_kind` / logo (`logo_data_url`) / numbering live in the
   branch `domainConfig`; goods firms hide trucks, trips, LRs and stores in the menu.
11. **Customers belong to one firm.** `createInvoice` refuses another firm's party (`parties.branchId`), because the balance would
   move; copy a customer across with `POST /api/transport/parties/copy` (new row, balance 0). Don't share party rows between firms.
12. **Bill numbers**: default is `PREFIX-FY-00001`. A firm may opt into a plain running series (`invoice_style: 'plain'` + `invoice_prefix`,
   e.g. `F-4`, `16`) with its own counter (`invoice_sequences.fy = 'plain'`) via `POST /firms/:id/numbering`; `next` must be above
   the highest number already used. Applies to `sale_invoice` only.
13. GST rounding: the engine rounds the **total** GST then gives the odd paisa to SGST (matches the Roadways paper bill). The
   Enterprise paper bill rounds CGST and SGST separately and differs by ₹0.01 — tests assert the engine's rule.
14. **Bank statements** (`routes/transport-bank.ts`, `pages/transport/BankPage.tsx`, parser `packages/shared/src/bank-statement.ts`).
   The statement file is parsed in the **browser** (SheetJS) and posted as normalized rows; the server dedupes by a sha1 key
   + occurrence counter (`uq_tbl_dedupe`, `ON CONFLICT DO NOTHING`), so overlapping months are safe. A line is claimed atomically
   (`UPDATE … SET status='matched' WHERE status<>'matched' RETURNING`) and `applyMatch` reverts the claim on error. `createdEntries`
   marks lines whose payment/expense the match *created* — Undo reverses only those (`voidPaymentTx`, expense delete). Receipts go
   through `createPaymentTx`/`recordPayment` + `recordTdsForBill` (exported from payments.ts / transport-billing.ts). Auto-match only
   acts on certain matches (reference or exact amount + name), never guesses. New tables (`transport_bank_*`) need `pnpm provision:all` on live.
15. **CA reports** (`routes/transport-ca.ts`, `/ca/*`, UI `CaReportsPage.tsx`, Excel via `lib/excel.ts`): each returns
   `{title, from, to, firm, columns, rows, totals, notes}`; the browser builds the .xlsx and the one-click CA pack. The "All firms"
   report is owner-only and reads every branch.
16. **Credit / debit notes** (`POST /transport/bills/:id/notes`, UI `NoteModal` on the bill page). A GST bill is never edited: a cut
   (shortage, rate reduction, discount) is a `credit_note`, a charge (detention, extra loading) a `debit_note`, both linked to the bill
   (`linkedInvoiceId`) and carrying its GST. Credit notes need owner/manager, cannot exceed the bill's taxable value, and are first
   set against the bill's outstanding (`paidAmt`; remembered in `domainData.applied_to_bill` so cancelling the note gives it back).
   A debit note on a SALE is a receivable like a bill — `recordPayment` treats it as money in only when its linked invoice is a sale.
   A bill with live notes cannot be cancelled. Registers net them (sales register shows credit as minus; GSTR-3B subtracts credit,
   adds debit). The shared `buildTaxInvoice` view carries `docTitle`/`reference`, so print + PDF show CREDIT NOTE / DEBIT NOTE.
   TDS is not recalculated for a note. Bill-list tabs depend on the firm: transport sees Sales/Purchases/Credit/Debit, goods sees all.
17. **Office Costs vs trip costs.** Office Costs (`/api/expenses`, core) take overhead only — `OFFICE_COST_CODES` in the domain registry
   (transport: rent, electricity, internet, staff, EMI, insurance, permit/tax, maintenance, challan, misc; goods firm: a shorter list).
   `GET /expenses/categories` is filtered and POST/PATCH answer 422 for anything else. Diesel, toll, bhatta, loading, parking, tyres,
   spares, repair, hire and broker commission are TRIP costs: enter them in Diesel & Trip Costs so they reach the truck's profit.
   Trip costs (`/transport/expenses`) still accept the full list.
18. **Speed at volume — measure, don't guess.** `cd apps/api && npx tsx --env-file=.env scripts/bench-seed.ts` builds a throwaway tenant (phone
   `9800000001` / PIN 1234 — *not* 7… or 8…, the test suite deletes those) with ~40k loads, 15k bills, 80k trip costs and 60k bank lines in
   ~20 s; `npx tsx scripts/bench-time.ts [filter]` times every list/report (median of 3); `bench-seed.ts --drop` removes it.
   What that taught us (keep to it):
   * **Never ask a per-row question of a big table** — e.g. `(SELECT … FROM transport_bank_lines WHERE "paymentIds" @> ARRAY[p.id] LIMIT 1)` in a
     SELECT list read all 60k lines per receipt (receipts register: 22 s → 125 ms once it became one CTE + join). Aggregate once, then join.
   * Indexes live in `transport-ddl.ts` (incl. GIN on the bank lines' `paymentIds` / `tripExpenseIds`); the text-search ones (`pg_trgm`) are built
     by `runTrigramIndexes` in `provision-schema.ts` and need the extension. LR / bank-line search uses `LR_SEARCH_EXPR` / `BANK_SEARCH_EXPR` —
     a search must use the *same expression* as its index. **After changing indexes run `pnpm provision:all` (live Neon too).**
   * Big registers: the screen asks `?preview=300`; Excel and the CA pack ask without it (never reuse a preview's cache key for a download).
     A `preSerialization` hook in `transport-ca.ts` trims `rows` for every register; the expense register, bank book, sales, receipts, fuel and
     who-owes-you go further and compute the totals (and the tables beside the rows) with aggregate queries + `LIMIT` the rows in SQL, so a 3-year
     range at 10× size answers in 0.2–1.8 s instead of 4–6 s. Never ask a per-row question in a register's SELECT list: aggregate once and JOIN
     (the TDS recorded per bill, the bills a receipt went to). Never regroup a big array once per customer in JS — group in one pass. A preview must
     return the SAME `totals` as the full report — `transport-ca.test.ts` ("screen preview") checks it; keep it true when adding a total.
   * `lib/fast-sql.ts` (`qFast`, plain `pg`) is the read path for registers with tens of thousands of rows — Prisma's raw layer is ~5× slower per row.
     Same SQL (schema-qualified via `tbl()`), values shaped like Prisma's (numbers, 'YYYY-MM-DD' dates). Use it only for those big reads. `scripts/bench-extreme.ts`
     times them over three years.
   * **Long lists page by bookmark, not by page number** (`lib/keyset.ts`, `hooks/useCursorPager.ts`, `components/ui/CursorPager.tsx`): loads, trip costs,
     bills and bank lines take `?after=<cursor>` and return `nextCursor`; `OFFSET` made page 15,000 of loads take 2.6 s, a bookmark takes ~40 ms at any
     depth. The total is counted only on the first page (never on a cursor page) and the browser remembers it. The list must have a TOTAL order
     (`date DESC, createdAt DESC, id DESC`) and an index in that order (`idx_*_keyset` in `transport-ddl.ts`). A page number still works for old
     callers. New long list? Copy the pattern and add it to `transport-paging.test.ts`; `scripts/bench-paging.ts` times it.
   * Responses are compressed (`@fastify/compress`, brotli level 4): the 3-year expense register is 23 MB raw, ~1 MB on the wire.
   * Firm settings go to the browser through `configForClient()` (no duplicate logo data URL); the logo travels once, as `firm.logo`.
   * Web: every screen except sign-in is `lazy()` (first load ~190 KB, was ~1.9 MB); SheetJS is `import('xlsx')`-ed on first use (`lib/excel.ts`);
     the busiest screens are prefetched when idle (`prefetchBusyScreens` in `AppLayout`). Tables draw ≤300 rows; lists paginate.

19. **Schemas are built from parts** (`lib/schema-parts.ts`): `core` (invoices, parties, payments, expenses, banks, users…), `retail` (products,
   stock, purchasing, suppliers, contracts… — the `RETAIL_TABLES` set) and `transport`. `createTenantSchema(schema, parts)` builds one;
   `provisionTenantSchema(schema)` with no parts **detects** them (no `products` table = lean) so `provision:all` never re-creates retail tables in
   a slimmed tenant. `LEAN_SCHEMA=true` makes new transport tenants lean **and** stops `server.ts` mounting the retail routes (products, stock,
   inventory, grn, staff, contracts, discount-rules, ai, brands, analytics). New shared code must not touch a retail table unconditionally
   (e.g. `invoice.service` skips the product lookup when no line has a `productId`; GSTR HSN summary uses the line's own HSN). Check:
   `npx tsx --env-file=.env scripts/check-schema-parts.ts` (full vs lean schema, identical shared tables). Lean test run: start a second API
   with `PORT=3101 LEAN_SCHEMA=true`, then `TEST_LEAN=true TEST_API_PORT=3101 npx jest` (retail-feature tests skip themselves).

## Testing notes

`transport.test.ts` registers its own tenants (phones `7xxxxxxxxx`, purged by `global-setup.ts`), so it
never depends on seed data. The jest harness adds a *unique* `Idempotency-Key` to every POST — pass an
explicit header in a test when you want to exercise replay behaviour. After editing server code,
**restart the API** before running tests.

## Not done / ideas

**Bucket list — separate the verticals' databases.** `provision-schema.ts` is the shared HisabKitab core and is
not domain-aware: every tenant (transport included) gets all 49 tables and an 88-column `products` table
(petrol-pump, restaurant, supplement, electronics columns…), all empty for transport. Harmless but noisy
(`pnpm provision:all` prints hundreds of no-op `ADD COLUMN IF NOT EXISTS`). Plan: split per-vertical schemas so
transport only gets what it uses; check the shared inventory/invoice/expense code for reads of those columns
first, and keep patches portable with billingPlatform/tyrePlatform.

Per-firm e-invoice (IRN) and GST-return split when two firms share one GSTIN; show the other firm's dues on the owner's Home; cross-firm customer sharing (customers are copied today, balances separate).

Ledger posting of To-Pay collections; TDS ledger; driver mobile app & GPS; POD image upload; market-vehicle
hire payables; passenger/cab sub-domain (add a second entry to the domain
registry). Package scope is intentionally still `@billing/*` to keep patches portable.

## Deployment (live — see `docs/DEPLOY.md` for the full walkthrough)

| Layer | Host | URL / notes |
|---|---|---|
| Web | Vercel | https://twisha-transport-pos-sjk6.vercel.app — `/api/*` is rewritten to Render (no CORS / `VITE_API_URL` needed) |
| API | Render (Docker, free plan) | https://twishatransportpos.onrender.com — health check `/health` |
| DB | Neon Postgres (us-east-2) | test DB; use the **direct** (non-`-pooler`) connection string |
| Redis | Render Key Value | queues; workers run inside the API (`RUN_WORKERS_INLINE=true`) |

* Repo: `https://github.com/tacodingstudio-tcs/TwishaTransportPOS.git`, branch `main`. Pushing from this machine
  needs `git -c http.sslBackend=schannel push` (corporate SSL interception).
* Demo logins (business "Shree Ganesh Roadlines"): owner `9100000001`/`1111`, manager `9100000011`/`2222`,
  viewer `9100000012`/`3333`.
* Files: `docker/Dockerfile.api` (node:22-slim, `npx tsx src/server.ts`), `render.yaml` (blueprint + env vars),
  `deploy/neon-setup.sql` (tenant-schema function for Neon — already run), `vercel.json` (root; builds only
  `@billing/web`) and `apps/web/vercel.json` (for importing `apps/web` as the project root).
* Env on Render: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `WEB_URL` (optional, comma-separated CORS origins),
  `FORCE_SEARCH_PATH=true`, `RUN_WORKERS_INLINE=true`, `STORAGE_TYPE=local`, `ALLOW_SIGNUP=false` (turns `POST /api/tenants/register` into a 403 — the live site is one client's; leave it unset locally, tests register tenants).

### Deployment gotchas
1. **Neon ignores Prisma's `?schema=`.** `FORCE_SEARCH_PATH=true` enables the `withSearchPath` wrapper in
   `apps/api/src/lib/tenant-db.ts` (`SET LOCAL search_path` in a transaction). Its `LazyRaw` must keep
   `.then/.catch/.finally` — missing `.catch` caused 500s on staff/reports/ai routes.
2. **Workspace packages are raw TS, no build step.** Every one the API imports must be declared in
   `apps/api/package.json` (e.g. `@billing/pdf`) — `--frozen-lockfile` fails on a fresh install otherwise,
   while a stale local link hides it.
3. **Vercel must build only `@billing/web`.** Running root turbo fails on the API's TS (Prisma client not
   generated). Import as a single project; don't use the "Services" preset.
4. `@fastify/cors` throws on an empty-string origin — `server.ts` builds origins from `WEB_URL` and falls back to localhost.
5. **Render free sleeps** after ~15 min idle (cold start 15–60 s). Login waits up to 75 s and shows honest
   errors ("Cannot reach the server…" vs "Wrong phone number or PIN").

### Open items
* Render plan → **Starter** (~$7/mo) for the real client; region in `render.yaml` is `singapore` but Neon is us-east-2 → `ohio`.
* Reset the Neon password (it was pasted in chat) and update Render `DATABASE_URL`; set Render `WEB_URL` to the Vercel URL.
* Uploads are on local disk and wiped per deploy → S3/R2 before production.
* Server-side PDF (puppeteer) is unavailable in the slim image; print pages work.
* UI is English only — Gujarati/Hindi undecided. `.npmrc` has `strict-ssl=false` (remove outside this network).
* Idempotency fix not back-ported to billingPlatform/hotelPlatform.
