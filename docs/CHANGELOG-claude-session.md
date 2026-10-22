# What Claude changed (everything after commit f346e94)

Written for: the next AI / developer who already knows the project up to commit `f346e94` ("Add departments, folding, stores, chemical requests, packing and gate pass"). This file lists ONLY the work done after it, in the order it happened. For the whole project see `AGENT.md`.

## A. Summary of the tasks, in order

1. **Reports module.** Every system report (grey inward per party, SO cards, departments, operators, chemical costing per SO card / lot / thaan, folding, active fabric, packing lists, gate passes, overview). JSON for screens; the frontend makes PDF/Excel. New: `reportService.js`, `reportRoutes.js`.
2. **Granular service access.** The super admin now gives every service; nothing is assigned automatically. Each report is its own service, Store reports its own service, chemical/general inwards separate. Client admin gives employees only what the company has. Fix of the 500 errors that appeared after this migration (migration applied to the real DB; development-only `error.debug.reason`).
3. **Fabric Return Grey** separated from the SO Card section: own numbers FR-1, FR-2 ..., Grey-Store-only endpoints, hidden from SO Card lists, shown as `cardLabel`.
4. **Client-admin employees.** Client admin creates/edits employees and gives services; super admin cannot create employees, only creates/disables/deletes client admins and sees employees read-only; locking out rule when the last active client admin is off or deleted; create/delete an extra client admin.
5. **Colours for Dyeing employees:** a Dyeing employee can set a job colour (the colour rule is "only Dyeing", not "any colour-tracking service"); colour list/add open to Dyeing employees.
6. **Full project audit (no behaviour change at that point):** 81 audit tests, 37 SQL accounting rules, scripts, `docs/AUDIT-REPORT.md` (findings AUD-01..23).
7. **Audit fixes** (all except AUD-04, by the owner's decision): see section D.
8. **Two PDF reports** of the audit (simple English, normal Roman Urdu) in `docs/audit-pdf/`.
9. **Edit locks** requested by the frontend developer: see section E.
10. **This handoff:** `AGENT.md`, this file.

## B. Database changes (migrations; all after `f346e94`)

| Migration | What it does | Applied to the real Supabase DB? |
|---|---|---|
| `20261020000001-reports-module` | adds service `REPORTS` (MODULE) to services and to every company | Replaced by 02 (the single REPORTS service no longer exists after 02). Applied. |
| `20261020000002-granular-services` | adds `services.menuGroup`; `kind` gets `REPORT`; new services `STORE_REPORTS` and nine `REPORT_*` services; every company/user that had `REPORTS` gets the nine report services (same VIEW/FULL); everyone with `CHEMICAL_STORE` gets `STORE_REPORTS`; the single `REPORTS` service is removed; built-in flag (`isBuiltIn`) on services | Applied |
| `20261020000003-fabric-return-numbers` | drops the unique `(companyId, cardNo)` and `idNo` constraints of `so_cards`; adds unique `(companyId, isGreyReturn, cardNo)` and `(companyId, isGreyReturn, idNo)` so SO and FR numbers are separate series; counters `fabric_return_card_no`, `fabric_return_id_no` | Applied |
| `20261020000004-user-phone-deleted` | `users.phone`, `users.deletedAt` (soft-deleted client admin); unique email indexes now ignore deleted users (the email can be reused) | Applied |
| `20261021000001-audit-indexes-and-checks` | an index on every foreign key that had none (81); `CHECK (col >= 0) NOT VALID` on 25 money/quantity columns (old rows are not scanned) | **Not applied** (tested up and down on the test DB) |
| `20261021000002-edit-locks` | new table `edit_locks` (id, companyId, resourceType, resourceId, userId, tabId, acquiredAt, expiresAt; unique `(companyId, resourceType, resourceId)`; indexes on userId and expiresAt) | **Not applied** (tested up and down on the test DB) |

No table was dropped. Removed in the database: the service row `REPORTS` and the two old `so_cards` unique constraints (replaced by the series-aware indexes).

## C. What was removed or replaced (behaviour)

- Automatic assignment of services to a new company (removed; the super admin chooses every service).
- The single `REPORTS` service (replaced by nine `REPORT_*` services + `STORE_REPORTS`).
- Fabric returns no longer take an SO# / ID# and no longer appear in the SO Card section.
- The super admin can no longer create employees (the screen is read-only through `/v1/admin/users`).
- Old `Math.round(n * 100) / 100` rounding copies in 8 services (replaced by `utils/money.js`).
- Old `new Date().toISOString().slice(0, 10)` defaults in 11 places (replaced by `today()` from `utils/dates.js`).
- Date patterns `/^\d{4}-\d{2}-\d{2}$/` in routes and validators (replaced by `ymdDate()`; `greyRoutes.js` had a broken pattern without backslashes).
- `POST /so-cards/:id/accept` for cards sent through the job flow (now 422 `ACCEPT_ON_JOB`, was a 500); `GET /so-cards/incoming` now lists only cards that really have an unaccepted move.

## D. Code changes of the audit fixes (AUD ids from `docs/AUDIT-REPORT.md`)

| Id | Where | Change |
|---|---|---|
| AUD-01 | `jobService.previousCosts` | a split item passes on only its own share of the earlier cost (`part = startMeters / ancestorMeters`, capped at 1) |
| AUD-02 | new `utils/money.js` + all services | one `round(n, d)`: half up, float noise removed (12 significant digits), exponent form falls back to `Math.round` |
| AUD-03 | `jobService.setStatus` | REJECT refused (422 `CANNOT_REJECT`) when the job has chemical requests |
| AUD-05 | `packingService.checkLines` | each (lot, thaan, grade) <= what Folding sent (`folding_lines`), all lists together; 422 `MORE_THAN_FOLDING_SENT` |
| AUD-06 | `packingService.setFinal/remove` | reopen/delete refused when a gate pass exists (422 `HAS_GATE_PASS`) |
| AUD-07 | `utils/dates.js` `ymdDate`, `errorHandler` | real calendar date check everywhere; DB date errors 22007/22008 -> 400 |
| AUD-08 | `greyLotService.update` | thaan lot cannot get a plain total (422 `LOT_HAS_THAANS`) |
| AUD-09 | `jobService.soCardHistory` | employee needs the card's department (or SO_CARD / GREY_STORE service) else 403 |
| AUD-11/12 | `soCardService` | `positionsOf/jsonMany`: `currentDepartment`, `deliveryText` computed from jobs; accept without a move -> 422; report "Last sent to" uses the last visited department |
| AUD-13 | `packingService.summary`, `reportService` | totals = sum of per-line rounded amounts (SQL `SUM(ROUND(...))`) |
| AUD-14 | `utils/dates.js` | `today()` = Asia/Karachi day; `dayStart/dayEnd` with +05:00; report SQL `AT TIME ZONE 'Asia/Karachi'` |
| AUD-15 | `chemicalRequestService.send` | sent qty > requested qty -> 422 `MORE_THAN_REQUESTED` (checked after the stock check) |
| AUD-16 | `errorHandler` | Postgres 22003 -> 400 `NUMBER_TOO_BIG` |
| AUD-17 | `soCardService`, `jobService.create`, `packingService.saveGatePass` | SO card date >= lot arrival (`CARD_BEFORE_LOT`), job date >= card date (`JOB_BEFORE_CARD`), gate pass date >= list date (`PASS_BEFORE_LIST`) |
| AUD-18/19 | migration `20261021000001` | indexes and CHECKs |
| AUD-23 | `jobService` recursive CTEs, `loginCodeService` | `UNION` instead of `UNION ALL`; at most 50 tries for a free company code |
| AUD-04 | not changed | Folding grading limit waits for the owner |

Not changed on purpose: AUD-20 (unpaged Folding list / send-form), AUD-21 (dev `.env` settings), AUD-22 (old data).

New files in `src/`: `utils/money.js`, `utils/dates.js`, `utils/soLabel.js`, `utils/colourDepartments.js`, `middlewares/requireAnyService.js`, `routes/adminUserRoutes.js`, `routes/reportRoutes.js`, `services/adminUserService.js`, `services/companyAccessService.js`, `services/reportService.js`, `services/userEmail.js`, and the lock files below.

## E. Edit locks (newest)

- `src/services/lockService.js` (acquire = one atomic `INSERT .. ON CONFLICT .. DO UPDATE WHERE expired OR same user+tab`; heartbeat; release; current; `assertFree`; `releaseAllForUsers`; `cleanup`).
- `src/routes/lockRoutes.js` mounted at `/v1/locks`; `src/middlewares/editLockGuard.js` mounted first in `routes/index.js` (table `RULES` of write routes -> resources).
- `AppError.locked` (423 `LOCKED`); `authService.endAllSessions` and `logout`, and `companyService.remove`, release locks; `server.js` runs `lockService.cleanup` every 10 minutes.
- `tests/locks.test.js` (10 tests). `tests/audit/security.test.js` sweep exempts `DELETE /locks/:id` (a missing lock is 204 by design).
- Not built: `version` / `expectedVersion` / 409 `STALE_VERSION`.

## F. Tests and tools added

`tests/audit/` (world helper, seed of every route, costing, fuzz, cloth, concurrency, reports consistency, security, robustness, flows, extremes, time, superadmin, unicode, audit log, performance), `tests/locks.test.js`, `tests/colours.test.js`, `tests/employees.test.js`, `tests/serviceAccess.test.js`, `tests/reports.test.js`, additions in `tests/greyReturn.test.js`. `scripts/audit/invariants.js` (37 SQL rules) and `scripts/audit-db.js`. Several old tests had hard-coded dates (`passDate: '2026-10-20'`); they now use `2030-01-01` because of the new "gate pass not before its list" rule.

## G. Docs added (all after `f346e94`)

`AGENT.md`, this file, `docs/AUDIT-REPORT.md`, `docs/audit-pdf/*` (two reports, html + pdf), `docs/frontend/{reports,service-access,employees,colours,audit-fixes,edit-locks}.md`, changes in `docs/frontend/fabric-return-grey.md`, `docs/samjhao/{08-reports,09-service-access,10-employees}.md`, updates to `docs/API.md` and `README.md`.

## H. Warning for whoever continues

The two newest migrations are not on the real database yet; the code works without migration `...21000001`, but `...21000002` (edit_locks) is required for `/v1/locks` and for the lock guard: **without the table, every guarded write will fail**. Apply `npm run db:migrate` to the real database before deploying this code.
