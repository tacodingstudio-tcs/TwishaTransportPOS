# Offline desktop delivery — plan (not built yet)

Status: **plan only.** Nothing here is implemented. Build waits for the owner's answers on expenses (and the open questions in §11).
Audience: the developer shipping this. Written against the code as of 2026-10-23; updated the same day with the delivery decisions below.

### Decisions made (2026-10-23)

1. **One PC only.** No office-network (LAN) mode in v1. Everything binds to `127.0.0.1`; no firewall rule, no "server PC" concept.
2. **Online features work only when the PC has internet** (WhatsApp, e-way bill, e-invoice, email). The client is told this up front; the app queues what it can and says plainly what needs internet.
3. **No import of existing data.** The client starts fresh from a cut-over date. No import tools to build (removes a whole phase).
4. **An external drive is mandatory for the second backup copy.** The client is told to have one before install; the app will not call the install "protected" until one is set up.
5. **No simultaneous users.** One person is signed in at a time on that PC — sessions need no special handling, and the database sees one writer.
6. **Updates are done remotely by the developer** (AnyDesk-style session). So: no auto-updater in v1, no "update available" feed to build; instead a scripted, logged, reversible upgrade runbook (§7a) that the developer runs and watches.

---

## 1. Short answer

**Yes, it is possible**, and it is mostly packaging plus removing a few cloud assumptions — not a rewrite.

The app is a Node API (Fastify + Prisma) + PostgreSQL + a static web app. All three can run on one Windows PC with no internet. What changes is how they are *installed, started, backed up and updated*, and three code dependencies that assume a cloud host (Redis, a few external fonts, a native module).

Recommended shape: **one signed Windows installer (`TwishaTransport-Setup.exe`) that installs PostgreSQL + the API as Windows services and puts a desktop icon that opens the app in its own window.** Rough effort for one developer: **about 6.5–7 weeks to a pilot-ready build, 8–11 weeks fully finished** — see §10.

Do **not** switch the database to SQLite: the code is deeply PostgreSQL (schema-per-tenant, `jsonb`, array columns with GIN indexes, `pg_trgm`, `FILTER`, window functions, raw SQL everywhere). Porting would be a rewrite and a regression risk. Bundle PostgreSQL.

---

## 2. What offline means for features

| Feature | Offline? | Plan |
|---|---|---|
| LR, trips, bills, credit/debit notes, receipts, TDS | Works | — |
| Bank statement import (CSV/Excel), matching, CA reports + Excel | Works | — |
| Printing / PDF of bills, LRs | Works | PDFs are built with `pdfkit` on the server; print pages run in the browser |
| Goods billing, two firms, logos | Works | — |
| WhatsApp bill / reminders (`whatsapp.worker`) | **Needs internet** | Jobs wait in a local queue and send when the PC is online; show "n messages waiting" |
| E-way bill, IRN (e-invoice) | **Needs internet** (government portals) | Disabled with a clear message when offline; allow manual entry of the e-way number |
| AI assistant / scan-bill (Anthropic, Gemini, OpenAI) | Needs internet | Already removed from the menu; keep code behind a flag |
| Email (nodemailer) | Needs internet | Same queue treatment, or off |
| Google Fonts (`index.html`) | **Breaks look** | Self-host Inter in the web build (small change) |
| `wa.me` click-to-chat link on party statement | Needs internet at click | Fine (it just opens WhatsApp Web) |
| Updates, cloud backup | Needs internet or USB | See §8, §6 |

Rule for the UI: every online-only action shows "Needs internet" instead of failing silently.

Details for the online-only features (decided: they simply work when the PC is online):
- **WhatsApp / email** need the client's own provider credentials (today `WHATSAPP_TOKEN` etc. are server env vars) → a **Settings → Messaging** screen to enter them, stored on the PC; blank = feature off.
- Queued messages must not misbehave after a long offline spell: the existing per-bill `dedupeKey` already stops repeats; add an **expiry** (e.g. drop reminders older than 7 days, keep "bill created" for 3 days) so the client does not send a burst of stale reminders when the internet returns.
- Show "n messages waiting" and the last successful online time on the Messages screen.
- Connectivity check: a light "am I online?" probe (HTTPS to the provider) before sending, not a constant poll.

---

## 3. Target architecture on the client PC

```
C:\Program Files\Twisha Transport\        (read-only app files)
    app\            API (compiled JS) + web build (static) + node.exe (bundled, Node 22)
    postgres\       PostgreSQL 16 binaries (bundled)
    tools\          backup / restore / upgrade scripts
C:\ProgramData\Twisha Transport\          (all the client's data — never touched by upgrades)
    pgdata\         the database cluster
    backups\        nightly dumps
    logs\           api.log, postgres.log (rotated)
    config.json     ports, mode (single-PC / LAN), license, generated secrets

Windows services (start at boot, run even when nobody is logged in):
    TwishaTransportDB   → postgres.exe  (127.0.0.1:5434)
    TwishaTransportAPI  → node app\server.js  (serves the API AND the web build on 127.0.0.1:3100)

Desktop shortcut → opens http://127.0.0.1:3100 in a dedicated app window
    (Electron shell, or Edge/Chrome `--app=` mode — see §4)
```

One process serves both the API and the static web files, so there is no separate web server and no CORS.

**One PC (decided).** The API and the database listen on `127.0.0.1` only — nothing on the office network can reach them. Today `server.ts` always listens on `0.0.0.0`; that must change to `127.0.0.1` in offline mode (and stay a setting, in case a LAN mode is ever wanted: it would add `0.0.0.0` + a firewall rule + a "server PC" notion, and is deliberately **not** in scope).

---

## 4. Packaging options

| Option | What the client sees | Pros | Cons |
|---|---|---|---|
| **A. Installer + Windows services + browser/app-window (recommended)** | One setup.exe; an icon | Survives reboot/logoff; supports LAN later; simplest upgrades; smallest | Shows as a browser window unless wrapped |
| **B. Electron app that starts everything inside itself** | One app | Real app window, tray icon, auto-update hooks | +150 MB; DB dies when the app closes unless run as a service anyway; antivirus flags more often |
| C. Tauri/WebView2 shell | One small app | Tiny, modern | Rust toolchain; the Node API + Postgres still need services → no real gain over A |

Recommendation: **A, with a thin shell for the window** (start with Edge `--app` mode; move to Electron only if the owner wants a tray icon / native print dialogs). The services are the real product; the window is cosmetic.

Installer tool: **Inno Setup** (free, scripted, silent-install flags for support) building one `Setup.exe` (~300–450 MB with PostgreSQL + Node).
Code signing: buy an **OV/EV code-signing certificate** — otherwise Windows SmartScreen shows "unknown publisher" and antivirus may quarantine it.

---

## 5. Code changes needed (grounded in the repo)

Add one switch: `DEPLOY_MODE=offline` (cloud behaviour stays the default so the Vercel/Render/Neon deployment keeps working).

1. **Redis → remove the requirement.** Used for: login lockout counters (`routes/auth.ts`), response cache (`lib/cache.ts`), BullMQ queues (`lib/queues.ts`: pdf, whatsapp, ai) and their workers, plus `server.ts` wiring.
   - Login lockout + cache → in-memory (one process, so memory is correct), or a small `kv_store` table.
   - Queues → a **Postgres-backed job table** (`pg-boss`, or a ~100-line table + poller). WhatsApp/email jobs must survive restarts and wait for internet.
   - Keep the Redis path behind `DEPLOY_MODE=cloud`. Do not ship Redis for Windows (no official build; Memurai is commercial).
2. **`bcrypt` (native)** → swap to `bcryptjs` or ship the prebuilt Windows binary matching the bundled Node. Pure JS avoids the whole class of "node-gyp" problems.
3. **Prisma on Windows**: bundle the Windows query-engine library; run `prisma migrate deploy` from the installed tools (needs the `migrations` folder and the engine, not the Prisma CLI's dev tooling).
4. **Drop `puppeteer`** from `apps/api` dependencies — nothing in `src/` imports it (it would add ~300 MB of Chromium). It is only a dev/screenshot tool.
5. **Node**: package.json says `>=22`; bundle a pinned **Node 22 LTS `node.exe`** (don't rely on the client having Node).
6. **Fonts**: self-host Inter (`index.html` loads Google Fonts). Check Vite CSS for any other CDN.
7. **Bind address, ports, paths, secrets** from `config.json`: **bind `127.0.0.1`** (one-PC decision), `JWT_SECRET` generated per install (never a shared default), free-port detection (5434/3100 may be taken), data paths under `ProgramData`.
8. **Static web serving** from the API (`@fastify/static`) with SPA fallback; keep `/api` prefix.
9. **Logging** to rotating files; a "Support → Export diagnostics" button that zips logs + version info (no customer data).
10. **Clock safety**: dates are IST-based; warn on start if the PC clock is wildly wrong or went backwards (numbering and financial-year logic depend on it).
11. **Compression plugin / Vercel rewrite / Neon `FORCE_SEARCH_PATH`**: irrelevant locally; keep behind cloud mode.

Not changing: Prisma schema, all SQL, the transport tables, the web app's screens.

---

## 6. Database plan

**Engine:** PostgreSQL 16, bundled binaries (zip distribution, not the EDB wizard), registered as a Windows service by the installer (`pg_ctl register`), listening on `127.0.0.1:<free port, default 5434>`, own OS data directory under `ProgramData`.

**Install steps (all scripted, no prompts):**
1. Create the cluster (`initdb`) with a generated superuser password stored in `config.json` (DPAPI-protected / ACL'd to the service account).
2. Create role `billing_app` and database `billing_db`.
3. Run `docker/init.sql` equivalent (extensions `uuid-ossp`, `pgcrypto`, `pg_trgm`; the `create_tenant_schema()` function).
4. `prisma migrate deploy` (public schema: tenants, branches registry, etc.).
5. **First-run wizard** (web page served on first start): business name, owner name/phone/PIN, GSTIN/PAN, state, firms (Roadways / Enterprise — kind, logo, bank, bill-number series). It calls the same code as `POST /api/tenants/register` + `POST /api/transport/firms` + `provision`, then **disables public registration** (`ALLOW_SIGNUP=false`) permanently.
6. Run `provision-all` (applies all tenant DDL and the performance indexes incl. `pg_trgm`).

**Tuning for a small office PC (4–8 GB RAM):** `shared_buffers` 256 MB, `work_mem` 8–16 MB, `max_connections` 30, `synchronous_commit=on` (data safety over speed), autovacuum on, `fsync=on`. Prisma pool: 5–8 connections. Our measured speed is fine at this scale (everything well under 0.4 s at 10× the expected data).

**Single tenant:** keep schema-per-tenant (zero code risk). The installed system has exactly one tenant; `create_tenant_schema` runs once.

**Disk:** rough sizing — 100 MB per ~100k loads/bills incl. indexes; years of data fit on any disk. Warn in the UI at <5 GB free.

---

## 7. Migration strategy (three different things)

### 7a. Schema / version upgrades on the client machine (every future release)

**Principle:** the installer never touches `ProgramData` (the client's data); it replaces program files and runs the migration steps below. Because **you update remotely and cannot hotfix a bad migration at night**, the upgrade must be rehearsed, recorded, atomic where possible, and reversible.

#### What exists today (checked 2026-10-23)

- `public._prisma_migrations` holds **one** row: the original `20260101000000_init`. Prisma owns the *public* schema (tenants, users, refresh tokens, idempotency keys…).
- **Everything added since** — the transport tables, firm columns, bank tables, indexes, GIN/trigram indexes — lives as **idempotent DDL in code** (`transport-ddl.ts`, `provision-schema.ts`: `CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), applied to each tenant schema (51 tables each) at tenant creation and by `pnpm provision:all`.
- There is **no ledger**: nothing records which version a database is at, what was applied when, or whether a run finished. `provision:all` re-runs every statement every time (hundreds of no-ops) and a half-failed run leaves an unknown state. That is acceptable on our own servers; it is **not** acceptable on a PC we cannot walk up to.

#### The ledger to add before the first client install

New tables in `public` (created by a normal Prisma migration), written only by the upgrade runner:

| Table | Purpose | Key columns |
|---|---|---|
| `app_release` | History: one row per install/upgrade attempt | `version`, `build`, `started_at`, `finished_at`, `status` (`ok` / `failed` / `rolled_back`), `from_version`, `pre_backup_file`, `installed_by`, `log_file` |
| `schema_state` | One row: where this database is *now* | `app_version`, `ddl_fingerprint`, `data_migration_seq`, `maintenance` (bool), `updated_at` |
| `data_migrations` | One-time, ordered changes DDL cannot express (backfills, renames, data fixes) | `id` (0001…), `name`, `checksum`, `applied_at`, `duration_ms` |
| `tenant_schema_state` (optional, cloud mode) | Same fingerprint per tenant schema when there are many tenants | `schema_name`, `ddl_fingerprint`, `applied_at` |

- **`ddl_fingerprint`** = SHA-256 of the ordered tenant DDL statements the build contains. If it equals the stored one, the DDL step is **skipped** (fast, quiet); if different, the idempotent DDL is re-applied, then the fingerprint updated. This keeps our proven idempotent-DDL approach, adds a record, and makes `provision:all` silent when there is nothing to do.
- **Public-schema changes** go through **Prisma migrations** from now on (never ad-hoc SQL). Prisma's own `_prisma_migrations` stays the record for those.
- **Data migrations** are numbered files (`0001-backfill-xyz.ts`), each **idempotent** (safe if run twice), run in order, each in **its own transaction together with its ledger row** (so "applied" and "done" can never disagree). The **checksum** of an applied migration is verified on every later run: editing a shipped migration is a build failure. Today none are needed — introduce the framework *before* the first client so the first one ever written is already safe.

#### The upgrade procedure (script `upgrade.ps1`, run by you over the remote session)

1. **Pre-flight** (abort with a clear message if any fails): services running; free disk ≥ 2× database size + 2 GB; the app is idle; an **existing backup less than 24 h old**; external backup drive present (warn, don't block). Set `maintenance = true` → the API answers every request with a friendly "Updating, please wait" page (the client can't write mid-upgrade).
2. **Backup** (`pg_dump -Fc`), then **verify** it (`pg_restore --list`, and row counts of the big tables recorded). Path saved in `app_release`. If the backup fails, **stop** — no upgrade without a good backup.
3. Stop the **API** service (leave PostgreSQL running).
4. Replace program files; keep the previous folder as `app.previous\`.
5. `prisma migrate deploy` (public schema).
6. **Tenant DDL**: compare `ddl_fingerprint`; if different, run the idempotent DDL **inside one transaction** (PostgreSQL DDL is transactional, so a failure leaves the database exactly as it was). Index builds on large tables can take minutes — show elapsed time; single user + maintenance mode makes this safe.
7. **Data migrations**, in order (§ above).
8. Update `schema_state` and `app_release.status = 'ok'`; clear `maintenance`.
9. Start the API → **health check**: `/health` (versions, DB ping), a handful of read queries (list loads, bills, a report), login screen served. Print a one-page **update report** (versions before/after, backup file, duration, checks passed) to `logs\` and to the screen for you to confirm.
10. **Any failure → automatic rollback:** stop the API; because steps 5–8 are transactional, the database is normally unchanged — if anything *had* committed, restore the pre-upgrade backup (drop + restore); put `app.previous\` back; start; mark `rolled_back`; save the log for you. Tell the client "your system is unchanged".

#### Rehearse before touching the client (strongly recommended)

Because you update remotely, **test the upgrade on a copy of their real data first**: copy their latest backup to your machine (remote file transfer), restore it into a scratch database, run the exact same upgrade script against it, run the smoke checks, **then** upgrade the client. Delete the copy afterwards (it is their business data). This catches the one class of failure tests cannot: real, messy data.

#### Developer rules (so every release stays upgradable)

- **Forward-only and additive**: add columns/tables/indexes; never drop or rename in the same release that stops using the old thing — ship the destructive cleanup one release later (*expand → migrate → contract*).
- Data migrations: idempotent, bounded in time (or batched), and never rewritten after shipping.
- **Upgrade matrix in CI**: keep a golden, anonymised database dump for **every shipped version** (as a release artifact, not in git). Each new build is tested by restoring each golden dump → running `upgrade.ps1` → running the API test suite and the report parity checks. This is the real protection against a bad upgrade.
- **Version guard in the app**: on start, compare the app's expected version/`data_migration_seq` with `schema_state`. *Database newer than app* (an old install pointed at a newer restore) → **refuse to start**, show "Install the latest update". *Database older than app* (migrations pending) → the API **does not auto-migrate on boot** in offline mode (a surprise migration on an unattended PC is the risk we are avoiding); it shows "Update pending — contact support" and waits for your runbook.
- A Settings → About screen shows: app version, schema version, last backup (local and on the drive), last upgrade result, free disk — so you can read the state off the client's screen during a remote session.

#### Housekeeping the database needs to live for years unattended

Verify (and if missing, add) retention jobs for tables that only grow: `idempotency_keys` (purge > 30 days), `refresh_tokens` (purge expired/revoked), `notifications`/`transport_notifications` (purge sent > 90 days), queued-message tables (expire per §2), logs rotation. Run `VACUUM (ANALYZE)` weekly (autovacuum covers most, but schedule it with the nightly backup window).

### 7b. Existing data — decided: not imported

The client **starts fresh from a chosen cut-over date**; the old books (paper/Excel/other software) stay as the historic record. So there are **no import tools to build**. What the system still needs on day one, all entered through normal screens:

1. **Masters** typed in (or pasted via the existing "Enter Many Loads" for loads): customers, trucks, drivers, rates, pumps. Keep this to a short checklist the installer leaves on the desktop.
2. **Bill/LR number continuation:** set each firm's *next bill number* in Settings so the series continues from the paper book (already supported); LR/trip numbers likewise.
3. **What customers already owe at the cut-over date** — *open question for the owner (§11 Q11):* either (a) ignore and keep collecting old dues from the old books, or (b) enter one **opening balance per customer** (a small "Opening balance" entry dated the day before go-live, so aging and the who-owes-you report tie out). (b) is a ~2–3 day feature (an "Opening balance" action on a party) — recommend it if they want one place to see dues.
4. **Bank:** add the bank account(s) and import the statement **from the cut-over date** with the existing importer.
5. **Pump dues / TDS already deducted:** same choice as (3) — start from zero, or enter an opening figure.

Our cloud/demo database is **not** migrated to the client: demo data stays on our side. (If it is ever needed for a pilot demo: `pg_dump -n <schema>` + `pg_restore`, then `provision-all`.)

### 7c. Moving the installation to another PC / disaster recovery

`Backup` (one file: the dump + `config.json` minus secrets) → fresh install on the new PC → `Restore` wizard → done. This is the same code path as upgrades' rollback, so it is tested constantly.

---

## 8. Backups, updates, support (an offline product lives or dies here)

- **Nightly automatic backup** (Windows Task Scheduler or an in-API cron): `pg_dump -Fc`, kept 30 daily + 12 monthly in `backups\`; verified by `pg_restore --list`.
- **Second copy on an external drive — mandatory (decided).** The client is told to have an external drive *before* install day (put it on the pre-install checklist and the sales sheet). How it behaves:
  - The first-run wizard has a **Backup drive** step: pick the drive; the app writes and reads back a test file; until this passes, the Home screen shows an amber "Not protected yet — connect your backup drive".
  - Each nightly backup is copied to the drive **recognised by volume serial, not by letter**, so a drive that comes back as a different letter is still found. If the drive is unplugged, the copy is queued and done when it returns.
  - **Red banner on Home** if no copy has reached the drive in 3 days, with a one-click "Copy now". Everyone sees it, not only the owner.
  - Keep the last 30 daily + 12 monthly copies on the drive too; verify each copy (`pg_restore --list` on the copy).
  - Recommend a proper external HDD/SSD, not a USB stick (and, ideally, two drives swapped weekly — mention it, don't enforce it).
  - Quarterly **restore drill** reminder: a built-in "Verify latest backup" button that restores into a scratch database and reports row counts.
  - Single-disk failure is the realistic way to lose a client's business — this section is not optional.
- Optional cloud backup when online (encrypted upload) — only if the owner opts in.
- **Restore** = a screen in the app (owner PIN + typed confirmation), always taking a "before restore" dump first.
- **Updates**: a new `Setup.exe` delivered by download link or USB. Version shown in Settings. No auto-update in v1 (needs a signed update feed; add later if wanted).
- **Support**: log export (§5.9), remote session by AnyDesk/TeamViewer, a "safe mode" start that opens read-only.

---

## 9. Security & licensing

- DB and API listen on **127.0.0.1** by default; PostgreSQL password generated, unreachable from the network.
- First-run wizard sets the owner PIN; **public sign-up is permanently off**; staff are created by the owner (already how it works).
- `JWT_SECRET` generated at install; tokens are local only.
- Recommend **BitLocker** on the client's disk (customer GST data, bank statements); the installer can check and advise, but cannot enforce.
- **Licensing (decide):** signed license file (Ed25519), bound to a machine fingerprint, with an expiry/renewal date; verified offline; a clear grace period and a "contact us" screen — never lock the client out of *reading/exporting* their own data. Anything stronger (obfuscation) is cosmetic: the code is JavaScript.
- Ownership of data: the client's data lives on their PC; our support access is only what they allow.

---

## 10. Phases and rough effort (one developer, calendar days)

| Phase | Work | Days |
|---|---|---|
| 0. Spike | Run API + Postgres + built web from a folder on a clean Windows VM with the Redis-less build stubbed; confirm Prisma engine + bcrypt + pdfkit | 3–4 |
| 1. De-cloud the code | `DEPLOY_MODE=offline`; Redis→memory/Postgres queue; bcryptjs; self-host fonts; static web from API; bind/ports/paths from config; drop puppeteer; logging | 7–9 |
| 2. Database bundle | PostgreSQL zip, scripted `initdb`/service/role/db/extensions, migrate + provision, tuning, first-run wizard | 6–8 |
| 3. Installer + shell | Inno Setup, services (nssm or `node-windows`), shortcuts, firewall rule (LAN mode), uninstall that keeps data, signed build | 5–7 |
| 4. Safety net | Backup/restore screens + scheduler, external-drive copy + warnings, **migration ledger + `upgrade.ps1` runner + rollback + rehearsal tooling**, version guard, About screen, retention jobs, license check, diagnostics export | 10–12 |
| 5. Day-one helpers | Desktop checklist; optional **Opening balance** action on a party (§7b item 3, if the owner wants it); Settings → Messaging screen (§2) | 3–5 |
| 6. Test & pilot | Clean-VM install, upgrade v1→v2 with data, restore drill, power-cut test, antivirus/SmartScreen check, low-spec PC, one real week at the client | 7–10 |
| **Total** | | **≈ 41–55 working days (~8–11 weeks solo)** |

A pilot-ready build (Phases 0–4 + a thin Phase 6) is about **6.5–7 weeks**; the full table is the end-to-end number (there is no import tooling any more). These are rough: the biggest unknowns are antivirus/signing behaviour on real client PCs and how messy the client's existing data is.

Biggest risks: **antivirus/SmartScreen** quarantining an unsigned installer; **client forgets backups** (mitigated by §8 warnings); **upgrade on a machine with a full disk / old Windows**; **Postgres service not starting after a power cut** (mitigate with `pg_ctl` recovery logging + a "repair" button).

---

## 11. Questions

**Answered (2026-10-23):** Q1 one PC · Q2 no simultaneous users · Q4 online features work only when online · Q5 no data import · Q6 external drive mandatory for the second backup copy · Q7 updates are done remotely by the developer.

**Still open:**

3. **Windows version** and spec of the client PC (10/11 64-bit? RAM ≥ 8 GB? free disk ≥ 20 GB?). If it is a very old PC, tuning changes.
8. **Licensing/commercials**: one-time or yearly? What happens at expiry (read-only, never a lock-out of their own data)? Is the Twisha branding fixed?
7b. **Remote access**: will the client's PC allow an unattended remote tool (AnyDesk/TeamViewer) to be installed, and who approves each session? (The runbook assumes you can watch the upgrade.)
9. **Per-client differences** to make configurable (bill layouts, terms, number series)?
10. **Open product items waiting on the owner** (Enterprise expense categories; shared costs between the two firms; "paid for the other firm") — settle before the first installer so no one re-keys data.
11. **Opening balances** (§7b item 3): do they want what customers owed on go-live day entered, or will they chase old dues from the old books?
12. **Messaging credentials**: will the client use their own WhatsApp Business API account, or do we provide one? (Needed before the Settings → Messaging screen is designed.)
13. **Which PC, and who looks after it**: a dedicated machine or the owner's daily PC? (Antivirus, sleep/hibernate during the nightly backup, Windows updates restarting it at the wrong moment.)

---

## 12. What to keep doing meanwhile (no regret work)

- Keep every migration additive and idempotent (already true for tenant DDL).
- Keep new features free of Redis/cloud-only assumptions (use the existing in-process patterns).
- Keep `scripts/bench-*` — they double as a "is this PC fast enough?" check.
- Keep backup/restore thinking in every data-model change (no data outside the database).
