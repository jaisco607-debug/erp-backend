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

## 8. Accounting module (added 2026-10-24 to 2026-10-26)

Read `docs/CHANGELOG-accounts-v2.md` first, then the frontend guides `docs/frontend/chart-of-accounts.md` and `docs/frontend/sales-invoice.md`.

- **Chart of Accounts** (`accountService`, `accountCatalog`, `accountTemplateService`, `accountIssueService`): a tree per company; folders (`isGroup`) and accounts; 5 types; `isContra`; system accounts (`isSystem` + `systemKey`, cannot be deleted / switched off / re-typed); presets and templates; code numbering rule (1000 / 2000 / 3000 / 4000 / 5000 COGS / 6000 Opex, both expense ranges are type EXPENSE). Balances are exact strings from the journal, in cents (BigInt).
- **The journal is the only truth** (`journalService`, tables `journal_entries` / `journal_lines`): `post` needs the caller's transaction, debit = credit in cents, posting accounts only. A posted line is never changed (database triggers); a mistake is a **reversal** entry. A deferred trigger checks debit = credit at commit.
- **Opening balances** are ONE journal entry (`sourceType OPENING`, `openingBalanceService`), replaced by reversal + new post; locked once any other entry exists. Accounts no longer carry an opening balance field (the old column is only readable; `scripts/migrate-opening-balances.js` moves old values, dry run by default).
- **Sales Invoice** (`salesInvoiceService`): one customer, made of GATE PASSES (their packing list gives A / B / CP meters, rates and the amount; billed qty = meters of the grades that have a rate). Save = UNAPPROVED (no entry); Approve posts Debit Receivable / Credit Sales / Credit Output Sales Tax; Un-approve reverses. The three default accounts are found by system key / control type, or made (`accountService.ensureDefault`).
- **Purchase Invoice** (`purchaseInvoiceService`): the mirror of the sales invoice. One vendor; made of that vendor's APPROVED store inwards (chemical / general: amount + sales tax come from the inward). Save = UNAPPROVED; Approve posts Debit Purchases (DEFAULT_PURCHASES, control type PURCHASES) / Debit Input Sales Tax / Credit Accounts Payable with `partyType VENDOR`. A store inward on a purchase invoice cannot be corrected / un-approved (`storeInwardService.assertNotOnPurchaseInvoice`). Not built yet: payments, debit notes for goods returned to the vendor, expense bills (no store).
- **Trial Balance and ledger** (`trialBalanceService`, service `ACC_REPORTS`): worked out only from journal lines; opening = before the period + the OPENING entry; four checks (debit = credit, control accounts vs customers / vendors, sales invoices vs ledger, purchase invoices vs ledger). Use them after every change to posting code.
- **Default accounts** of a sales invoice are made when the invoice is SAVED (and found again at approve).
- **Rules to keep:** money is `numeric(18,2)` and exact strings in the API; never post to a folder or a switched-off account (except a reversal); every posting is inside one database transaction; do not edit `journal_*` rows.
- **Testing:** `tests/accounts.test.js`, `tests/openingBalances.test.js`, `tests/journal.test.js`, `tests/salesInvoices.test.js`. They need the `erp_test` database. On a machine without it, a runner that wraps each test in a rolled-back transaction on the dev database was used (it cannot run the parallel-connection test).
- **Open decisions:** the frontend's "issue rules a-f" were not available (six rules were chosen); the default fiscal year start month is July; purchase invoice, vouchers, trial balance and the ledger view are the next steps.

### 8.x Vouchers
Payment / Receipt / Journal vouchers: `src/services/{paymentVoucher,receiptVoucher,journalVoucher}Service.js`, shared helpers in `voucherSupport.js`, routes via `src/routes/voucherRoutes.js`. DRAFT -> CONFIRMED (one journal entry, invoices' paid/received updated) -> unconfirm (reversal). Advances use the Customer/Supplier Advances system accounts. Guide: `docs/frontend/vouchers.md`; tests: `tests/vouchers.test.js`.

### 8.y Ledgers
`partyLedgerService.js` (party ledger, payables / receivables from journal lines that name the party) and `bankSummaryService.js` (bank lines, clearing dates in `bank_clearings`, reconciliation). Guide `docs/frontend/ledgers.md`; tests `tests/partyLedger.test.js`.

### 8.z Reports
`financialStatementService.js` (profit & loss, balance sheet from the account tree) and `partyReportService.js` (customer / vendor balances, cut-off report: ledger view vs unpaid-invoice view). Guide `docs/frontend/accounting-reports.md`; tests `tests/reports.test.js`.

### 8.w Contra voucher
`contraVoucherService.js`: a customer's invoices and a vendor's bills settled for one amount (Dr Accounts Payable / Cr Accounts Receivable, no bank). Locks sales then purchases. Other code that sums what was received / paid on an invoice (Trial Balance settlement check, cut-off report, the invoices' `payments`) must include `contra_voucher_lines`. Guide `docs/frontend/contra-voucher.md`; tests `tests/contra.test.js`.

### 8.v Default accounts
`defaultAccountService.js` is the "Default accounts" tab (list / candidates / set / create). Posting code never changes: `accountService.ensureDefault(req, controlType, transaction)` returns the account that fills the role (by systemKey or controlType) and makes one only when none exists. Guide `docs/frontend/default-accounts.md`.

### 8.w Credit terms and the due schedule
`customers` / `vendors` have `creditLimit` (null = none) and `creditDays`; `sales_invoices.dueDate` was added (purchase invoices had it). `creditService.js` works out the default due date (invoice date + credit days; null when the party has no days, shown then as the invoice date) and the credit-limit WARNING (`creditWarning` on every invoice answer, from the party's ledger balance; an un-approved invoice counts on top, an approved one is already in it). The limit never blocks. Invoice JSON `dueDate` is the effective date (`COALESCE(dueDate, invoiceDate + creditDays)`); the raw column is `storedDue` in the services. `dueScheduleService.js` builds `GET /accounting/due-schedule` on `partyReportService.openItems` (which now returns `dueDate`). Guide `docs/frontend/credit-terms.md`; tests `tests/creditTerms.test.js` and the credit tests in `salesInvoices` / `purchaseInvoices`.

### 8.x Payroll masters (chunk 1)
`payrollMasterService.js` holds one generic CRUD; each master is a description in `KINDS` (table, select, columns, check, usage, json). The four default groups are made lazily by `ensureGroups` (unique index on `systemKey`, never deleted). **When the employee / payroll tables are added, add their counts to the `usage` of the group, department, designation, shift and bank** (delete is refused while used, `canDelete` follows `usage`), and add the vacancy (fte minus employees) to the department json. Read = any `PAYROLL_*` service, write = `PAYROLL_EMPLOYEES` FULL.

### 8.y Payroll employee master (chunk 2)
`payrollEmployeeService.js`: the card (DRAFT / CONFIRMED, closed), refs checked against the company's masters, payment method automatic (bank + account = BANK, else CASH). Documents are rows of `payroll_files` (`ownerType` + `ownerId` + `kind`, bytea, 2 MB, type from the magic bytes); routes read the raw body (`express.raw`), the bytes are selected only by `readFile`. The joining application (later) will reuse `payroll_files` with another `ownerType`. The fte head-count is shown as `vacancy` but not enforced on the employee master (enforce it in the joining application). When payslips / loans exist, add their counts to the delete rules of the employee and to the `usage` of the masters.

### 8.z Payroll policy (chunk 3)
`payrollPolicyService.effectivePolicy(companyId, groupId, 'YYYY-MM')` returns the rules in force (latest version starting on or before the month, else `DEFAULTS`). The payroll run must COPY that answer onto the payroll when it is created and never read policies again for that payroll (old months stay as they were). The rules still open: the "rest days rule" of the document (not defined), the late penalty is fixed at half a day per `latesPerHalfDay` lates.

### 8.z Payroll joining application (chunk 4)

`payrollApplicationService` is the employee card's form as a draft: it reuses `clean`, `checkRefs`, `payMethod` and the file helpers of `payrollEmployeeService` and the field rules of its validator, so the two forms cannot drift apart. DRAFT -> IN_REVIEW (`submit`, `withdraw`); the approval and the creation of the employee from it are NOT built yet. Income tax is yearly (`yearlyIncomeTax`), EOBI monthly (`monthlyEobi`). Vacancy on submit counts working employees plus other applications in review against the department fte (0 = no limit).

### 8.z Payroll application approval (chunk 5)

Reviewer = a client admin or a row in `payroll_approvers` (checked inside the service, the routes only need payroll read access). `approve` copies the application into `payroll_employees` with SQL `INSERT ... SELECT` over `COLUMNS` (no JS date round trip) and copies PHOTO / CNIC files; the application keeps its files and links `employeeId`. Only DRAFT is editable (`assertDraft`). The reviewer's edit is limited to `REVIEW_FIELDS`.

### 8.z Payroll IBAN and percents

Tax and EOBI are percents of the BASIC salary (`yearlyIncomeTaxPercent`, `monthlyEobiPercent`); the payroll run deducts `percentCents(basic, percent)` from each month (`src/utils/payrollDeductions.js`, exact cents). `iban` is separate from `accountNo`, PK + 22 characters, validated by shape only.

### 8.z Payroll attendance (chunk 6)

Punches (`payroll_punches`) are never tied to an employee row: `empCode` is matched to `payroll_employees.code` when read. Every source (Excel rows from the frontend, later the machine API) goes through `payrollAttendanceService.importRows`. The day results are rebuilt by `processRange` (engine in `utils/attendanceEngine.js`, pure and unit tested); it deletes and rebuilds only non-manual rows. Changing a policy, shift, holiday or an employee's shift does not recalculate by itself (`POST /attendance/process`). The month lock by the payroll run is NOT built yet. Open decisions made: rest-day work is all overtime; a single swipe or two within 60 minutes is `incomplete`; no overtime minimum.

### 8.z Attendance recalculation (2026-11-02)

`attendanceRefresh` (called after the commit by the masters, policy, employee and application services) keeps `payroll_attendance_days` in step; it keeps hand-set days and swallows its own errors (logged). Only `POST /attendance/process` (default `keepManual: false`) discards hand-set days. Import works the whole month of the file up to today (`importRange`), which is what creates the rest-day rows.

### 8.z Payroll resignations (chunk 7)

Same review model as the joining application (client admin or `payroll_approvers`), statuses DRAFT / IN_REVIEW / APPROVED / REJECTED. Only the approval touches the employee: it sets `isClosed` and `leavingDate`, and only when the last working day is not in the future (there is no scheduler to close an employee on a later day). The payroll of the leaving month must count days up to `leavingDate` only (the attendance already does). `absentees` measures from the latest punch day of the company, not from today.

### 8.z Employee loans (chunk 8)

The loan application (`payrollLoanService`) and the loan voucher (`employeeLoanVoucherService`, accounting) share the advisory lock `payroll-loan:<companyId>`. balance = confirmed vouchers - `payroll_loan_deductions`; the payroll run must INSERT a deduction per instalment (`month`, `amount`, `source = 'PAYROLL'`) and read the schedule with `utils/loanSchedule.schedule(approvedCents, months, deductFrom)`. The loan is limited to `payroll_employees.basicSalary`. The default role `EMPLOYEE_LOANS` is NOT in the chart templates on purpose (`ensureDefault` makes it). Still to do: a trial-balance check "Employee Loans ledger = the sum of the loan balances", cancelling an approved loan that was never paid, the salary advance application (`currentAdvance` is 0).

### 8.z Leaves and Annual Leaves (chunk 9)

Balance = `utils/leaveBalance.earnedLeave` (policy per month: `leaveEarnedPerMonth`, `maxLeavePerYear` per calendar year, `monthsBeforeLeave`; credited on the 1st; carried on) minus APPROVED and IN_REVIEW leave days (`payroll_leave_days`). The payroll must count AL days (already in the attendance totals and `payableDays`). Annual leave is the only type; unpaid or sick leave would be new types with their own rules (the attendance codes P, L, HD, A, R, AL do not have one yet). Leave encashment on leaving and half-day leave are not built. The Annual Leaves report is read from the same tables (`annualLeaves`, `employeeStatement`).

### 8.z The payroll (chunk 10)

`utils/payrollEngine.calculate` is the only place salary arithmetic lives (cents BigInt, half days); `payrollRunService` gathers its inputs (attendance copy, loan dues, leave balance, policy copy, employee salary snapshot) and saves the result in `payroll_slips`. A slip's days (`payroll_slip_days`) are a COPY of `payroll_attendance_days`: only `getAttendance` re-reads the module. `finish()` is idempotent; manual EOBI / tax are remembered in `calc.overrides`. Approving posts `SOURCE = 'PAYROLL_SLIP'` (entry date = the month's last day) and inserts `payroll_loan_deductions` (`payrollId` = the slip id); `send-back` reverses both. Paid = confirmed salary payment voucher lines. Not built yet: advance, undertaking (U/T) deductions, contribution / CTV, SMS, "Upload Adv / OT", slab-based income tax (`finish()` has the one place to change), payroll lock of the attendance month, EOBI / SESSI and tax reports, payslip PDF.

### 8.z EOBI contribution list
Services `eobiService.js`, `eobiVoucherService.js`; validators `eobiValidator.js`; routes `/payroll/eobi/*` and `/v1/eobi-vouchers`. Rates apply from their month; lists per provider+month, one employee on one list per month; voucher per location locks its rows. Payroll uses `eobiService.eobiShares`. Tests: `tests/eobi.test.js`.

### 8.z Income tax
`incomeTaxService.js` (history per employee, import, report), `salaryTaxVoucherService.js` (STV, lock `salarytax`), `incomeTaxValidator.js`; routes `/payroll/income-tax/*` and `/v1/salary-tax-vouchers`. Payroll reads `incomeTax.settingsFor` (also in `refreshEobi`, which refreshes EOBI and tax). Tests: `tests/incomeTax.test.js`.

### 8.z Sheets and payslip PDF
`payrollReportService.js` (salary sheet, attendance sheet, xlsx via exceljs, payslip PDF via pdfkit). Food and maintenance pro-rata lives in `finish()` of `payrollRunService.js` (`foodFull` / `maintFull` kept in the slip's calc; overrides `food` / `maintenance`). Tests: `tests/payrollSheets.test.js`.

### 8.z Salary increment
`payrollIncrementService.js`, `payrollIncrementValidator.js`, routes `/payroll/increments/*`. Statuses DRAFT 0 / REVIEW 1 / FINAL_REVIEW 2 / APPROVED 3 (Posted); a rejection goes back to DRAFT with `rejectReason`. Current figures are live from the master until posted. Tests: `tests/payrollIncrements.test.js`.

### 8.z Bank file and cash sheet
`payrollPayoutService.js` (`FORMATS` = one entry per bank; to add a bank add its header and row), routes `/payroll/runs/:id/bank-file|bank-files|cash-sheet`, `/payroll/bank-files/:id/download`. `SLIP_FROM` in `payrollRunService.js` now left-joins `payroll_bank_files` (slip JSON `bankFile`). Tests: `tests/payrollPayout.test.js`.

### 8.z Employee card tax and ids
Income tax on the card is `monthlyIncomeTax` (a fixed monthly amount); the old percents are gone. `monthlyDeductions(card, eobiCents)` in `src/utils/payrollDeductions.js` (EOBI = employee share of the current month's EOBI list; 0 on an application). The joining application never needs bank data (`appMethod` in `payrollApplicationService.js`). `eobiNo` / `scssiNo` are free text up to 30 characters.

### 8.z Attendance and punch reports
`payrollAttendanceReportService.js`: `/payroll/attendance/report[/employees/:id]` and `/payroll/attendance/punch-report[/employees/:id]`. They reuse `loadMonth` of `payrollAttendanceService.js`; punches are grouped by their Pakistan calendar date.

### 8.z Grey width
Width is typed at grey inward (`width` on the lot, thaan items may be `{length, width}`) and read from `grey_lot_thaans.width` (else the lot) by soCardService, jobService, foldingService and packingService. Test: `tests/greyWidth.test.js`.

### 8.z Return to SO card
`jobService.returnToSoCard` (routes in `departmentRoutes.js`): only cloth with `fromDepartmentId` null and status In-Way / Queue / Pending, no chemical requests. Returned jobs stay REJECTED with `returnedToSoCard = true`; they are hidden from the active incoming list (`allSent` literal). Test: `tests/returnToSoCard.test.js`.

### 8.z Advance
`payrollAdvanceService.js` (HR side, status worked out: WAITING_VOUCHER / PAID / RECOVERED), `employeeAdvanceVoucherService.js` (accounting, one voucher per advance for its whole amount), `advanceDues` + `slipAdvanceRows` in `payrollRunService.js`, engine `d.advance`. Tests: `tests/payrollAdvances.test.js`.

### 8.z Department chemical access
Switch per department on `company_services.chemicalRequests` (client admin, `/v1/department-settings`); effective only with the Chemical Store given. Enforced in `needDept` (chemicalRequestService) and by the response filter at the top of `departmentRoutes.js`. `accessService.companyServices` carries the flag; `serviceJSON` shows `chemicalRequests` on PROCESS / FOLDING services. Test: `tests/departmentChemicalAccess.test.js`.

### 8.z Process management
Super admin switch + limit per company (`companies.processManagement/processLimit`); client admin adds own processes (`processService.js`, `/v1/processes`, `services.companyId`). Code lookups of platform codes (SO_CARD, GREY_STORE ...) stay global; a client process code is unique inside its company and never equals a non-process platform code. Test: `tests/processManagement.test.js`.

### 8.z SO card groups
A sub-category is a row of `so_card_groups`; its cloth is the `so_card_lots` rows with that `groupId` (one per lot). Parts of one thaan of one card are never in one job (`SPLIT_THAAN_IN_ONE_JOB`); `sendCard` / `sendIn` batch them. The colour tag is the default `job_items.colourId` of a part sent from the SO desk. Test: `tests/soCardGroups.test.js`.
