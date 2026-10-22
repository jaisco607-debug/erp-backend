# AGENT.md: project context for the next AI / developer

Read this first. It describes the whole project and the rules that are easy to break. The exact list of what changed in the latest work session is in `docs/CHANGELOG-claude-session.md` (read that second).

**Owner language:** the owner writes Roman Urdu. Reply in Roman Urdu. Documents for the frontend developer are written in English. Technical names (codes, endpoints, table names) stay in English.
**Owner rules of working:** do not change behaviour the owner did not ask for; when a problem is found that was not asked for, report it and wait for the owner's decision. Do not commit or push unless asked. Migrations that touch the real database are run only when the owner agrees.

## 1. What the project is

Backend of a **textile mill ERP** (multi-company / multi-tenant). Node 20+, Express 5, PostgreSQL (real database on Supabase) via Sequelize + raw SQL, Joi validation, JWT login (access 15 min, refresh 7 days with rotation and reuse detection), bcrypt 12 rounds, helmet, CORS, rate limiters. Remote: https://github.com/waqasowais12/erp-backend, branch `main`.

The cloth flow:

```
Grey Store (grey lot = a party's cloth, made of thaans/rolls)
   -> SO Card (travel card: takes meters/thaans from lots)
   -> Departments as JOBS (Singeing, Dyeing, Finishing ... each accepts, processes, completes, forwards)
   -> Folding (grades the cloth A / B / CP, sends to Packing)
   -> Packing (packing lists per SO card, thaan by thaan, rate per grade)
   -> Gate Pass (cloth leaves the factory)
Side flows: Fabric Return Grey (Grey Store -> Folding, numbered FR-n, not an SO card),
            Chemical Store (departments request chemicals for a job; store issues them; this is the COSTING),
            General Store (purchases only), Reports, Audit log, Edit locks.
```

**Costing is the most important thing in the system.** Chemical cost of a job = what the store issued at the batch rates (FIFO purchase batches, store can also pick batches), minus returns, shared between SO cards of a job by meters, carried forward along the cloth's road (`previousCosts`). Any change touching `chemicalRequestService`, `batchService`, `chemicalReturnService`, `storeInwardService`, `storeAdjustmentService`, `jobService.chemicalsOf/previousCosts`, `reportService.chemicalShares` must be tested with `tests/audit/costing*.test.js` and `node scripts/audit-db.js`.

## 2. Code layout

```
src/
  app.js, server.js          app set-up; server.js also runs the lock cleanup timer
  config/                    env (strict checks), database
  routes/                    one file per module; index.js mounts everything under /api and puts editLockGuard first
  controllers/               thin
  services/                  ALL business logic (one service per module)
  validators/                Joi schemas (use ymdDate() from utils/dates for dates)
  middlewares/               authenticate, requireUserType, requireService, requireAnyService, validate, errorHandler, editLockGuard
  models/                    Sequelize models
  utils/                     AppError, money.js (the ONE rounding), dates.js (Pakistan day, real-date check), soLabel.js (SO / FR-n labels), colourDepartments.js, tokens, password
migrations/                  sequelize-cli, run with npm run db:migrate
tests/                       old module tests; tests/audit/ = audit suite; tests/locks.test.js
scripts/                     audit-db.js (read-only accounting check of the real DB), audit/invariants.js (37 SQL rules), db-check.js
docs/                        API.md, AUDIT-REPORT.md, audit-pdf/, frontend/ (guides for the frontend dev, English), samjhao/ (explanations for the owner, Roman Urdu)
```

Modules (route prefixes under `/api/v1`): `auth`, `super-admins`, `audit-logs`, `companies`, `services`, `users` (client admin's employees), `admin/users` (super admin, read-only), `customers`, `qualities`, `grey-lots`, `so-cards`, `colours`, `jobs`, `departments/:code/...` (jobs, folding, packing lists, gate passes, chemical requests/returns of a department), `vendors`, `stores/:store/...` (chemical / general store), `reports`, `locks`.

## 3. Rules that are easy to break

- **Multi-tenant:** every query is scoped by `companyId`. A company must never read or change another company's data (tested with thousands of calls in `tests/audit/security.test.js`).
- **Users:** `SUPER_ADMIN` (no company, manages companies and client admins), `CLIENT_ADMIN` (everything of the company, creates employees and gives services), `USER` (employee, only the services given, each VIEW or FULL). Super admin does NOT create employees; he creates/disables/deletes client admins and sees employees read-only (`/admin/users`). Disabling or deleting the last active client admin locks out all employees of the company.
- **Services (menu items) are given explicitly by the super admin.** Nothing is assigned automatically to a new company. `services.menuGroup` (PRODUCTION / PROCESS / STORE / REPORTS) and `kind` (MODULE, PROCESS, FOLDING, PACKING, REPORT ...). Each report has its own service (`REPORT_*`), Store reports are `STORE_REPORTS`. Chemical and General store inwards are separate services.
- **Fabric Return Grey** is an `so_cards` row with `isGreyReturn = true`, own numbering `FR-n` (counter series separate from SO numbers), sent from Grey Store directly to Folding, then Packing. It is hidden from the SO Card section unless asked (`?isGreyReturn=true`). Use `cardLabel` / `soLabels`, never print `cardNo` alone.
- **Colour** is set only in Dyeing (`utils/colourDepartments.js`). A Dyeing employee may set it with the Dyeing service; the colour list/add is open to Dyeing employees.
- **Dates:** the mill is in Pakistan. Use `today()` from `utils/dates.js` (never `new Date().toISOString().slice(0,10)`), day filters on timestamps use `dayStart/dayEnd`. Joi dates must be `ymdDate()` (real calendar dates).
- **Rounding:** always `round()` from `utils/money.js` (half goes up). Never `Math.round(n * 100) / 100`.
- **Packing list:** each line may not exceed what Folding sent (per thaan and grade); list totals are the sum of line amounts; a list with a gate pass cannot be reopened or deleted.
- **Jobs:** a job with chemical requests cannot be rejected. Cloth moves only forward through jobs; SO card `currentDepartment` / `deliveryText` are computed from the jobs (`soCardService.positionsOf`).
- **Store send:** the chemical store may send less but never more than requested.
- **Edit locks:** see section 5. Every new write route on a lockable record must be added to `RULES` in `src/middlewares/editLockGuard.js`.
- **Errors:** always `{ error: { code, message, details? } }`. Use `AppError` (`rule` = 422, `locked` = 423 ...). Unexpected errors are 500 without internals (in development `error.debug.reason` shows the reason). Postgres 22003 (number too big) and 22007/22008 (bad date) are mapped to 400.
- **Audit log** (`audit_logs`) records every changing call, never secrets; it is immutable.
- **Rate limiters / login lock:** dev `.env` uses 1-minute windows; production must use real values (JWT secrets 32+ characters).

## 4. How to run and test

```
npm install
npm run db:migrate            # applies migrations to DATABASE_URL (the real Supabase DB when .env points there: be careful)
npm test                      # jest --runInBand, uses its own database erp_test (never the real one)
node scripts/audit-db.js      # 37 accounting rules on the DATABASE_URL database, read-only
AUDIT_PERF=1 npx jest tests/audit/performance.test.js   # heavy speed test (about 4 minutes), skipped otherwise
AUDIT_SEEDS=12 AUDIT_STEPS=160 npx jest tests/audit/costing-fuzz.test.js   # bigger random costing test
```

The test database must exist and be **UTF8**: `CREATE DATABASE erp_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;` (default `postgres://postgres:postgres@localhost:5432/erp_test`, or `TEST_DATABASE_URL`). A WIN1252 database makes Urdu/emoji tests fail wrongly. `tests/setup.js` sets the test env; the jest global set-up drops the schema and runs all migrations.

Current result (2026-10-21): 37 suites, 192 tests, 191 pass, 1 skipped (speed test), 0 fail. One `test.failing` documents the open decision AUD-04 (Folding grading has no limit); when the owner decides, turn it into a normal test.

Windows note: the shell is Git Bash / PowerShell. Long edit scripts with backslash regexes are safer written to a file than passed inline.

## 5. Edit locks (latest feature)

`POST/PUT/DELETE/GET /v1/locks` (service `lockService`, table `edit_locks`, TTL 90 s, heartbeat every 30 s). `editLockGuard` is mounted before all routes and answers `423 LOCKED` (with `details.holder`) for a write on a record somebody else is editing; it also separates two tabs of one person when the frontend sends the `X-Tab-Id` header. Resource types: `job`, `folding_row` (`jobId:soCardId`), `grey_lot`, `packing_list` (`listId` or `so:<soCardId>`), `so_card`, `chemical_request`, `company_services`, `user`. Locks end on logout-all, when a user is switched off or deleted, and when a company is removed. NOT built: the optional `version` / `expectedVersion` / 409 `STALE_VERSION`. Frontend guide: `docs/frontend/edit-locks.md`.

## 6. Open items (decisions for the owner)

- **AUD-04:** Folding grading has no limit (200 m received can be graded as 5000 m). Needs a business rule (for example allow up to 5% gain/loss).
- Migrations `20261021000001-audit-indexes-and-checks.js` and `20261021000002-edit-locks.js` are tested but **not yet applied to the real Supabase database**.
- Production `.env`: JWT secrets 32+ characters, real login lock/rate-limit values, run behind nginx (`trust proxy`).
- Folding list, send-form and desk form load all rows of the company (fine up to about 1,000 jobs; add paging/SQL filtering beyond that).
- Old data (jobs before 14 Oct) has no received/accepted stamps or operator; harmless.

## 7. Where to read more

`docs/AUDIT-REPORT.md` (full audit, AUD-01..23), `docs/audit-pdf/` (two PDF versions), `docs/API.md` (all endpoints), `docs/frontend/*.md` (what the frontend must do for each feature, newest: `audit-fixes.md`, `edit-locks.md`, `employees.md`, `service-access.md`, `reports.md`, `fabric-return-grey.md`, `colours.md`), `docs/samjhao/*.md` (Roman Urdu explanations).
