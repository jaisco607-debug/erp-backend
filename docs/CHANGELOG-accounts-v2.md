# Accounts v2: what changed (2026-10-26)

Written for: the frontend developer and the next AI / developer. It lists the new and changed fields, endpoints and error codes of the Chart of Accounts after the frontend's request of 2026-10-25. Version 1 of the account API still works unless a line below says "changed".

## Migrations (apply with `npm run db:migrate`)

| Migration | What it does |
|---|---|
| `20261026000001-coa-system-contra` | `accounts."isLocked"` is renamed `isSystem`; new `systemKey` (unique per company) and `isContra`; the old default accounts get their `systemKey`; the name of an account is unique inside one parent (database index, case does not matter) |
| `20261026000002-fiscal-year-start` | `companies."fiscalYearStartMonth"` (1-12, default 7 = July) |

Earlier accounting migrations (already in the repo): `20261024000002-chart-of-accounts`, `20261024000003-account-tax-controls`, `20261025000001-accounts-locked-sales`, `20261025000002-journal-engine`, `20261025000003-sales-invoices`.

## New endpoints

| Endpoint | What |
|---|---|
| `GET /accounts/next-code?parentId=&accountType=&isGroup=&subType=` | The next free code. Top: Asset 1000, Liability 2000, Equity 3000, Income 4000, Cost of Sales 5000 (`subType=COST_OF_SALES`), Operating Expenses 6000, +100 until free. Folder in a top account: parent + 100. Account in a top account: parent + 1. Deeper: highest brother + 1. Switched-off accounts count. |
| `GET /accounts/presets` | The 22 cards of the add wizard |
| `GET /accounts/templates` | Shop / Trading, Service, Restaurant / Food, Manufacturing, Other, each with a preview |
| `POST /accounts/apply-template { templateKey }` | Builds the tree in one transaction; repeatable (skips codes that exist); reports `created`, `skipped`, `adopted` |
| `GET /accounts/issues` | The problems list with `suggestedFix` |
| `GET /accounting/opening-balances?date=` | The opening entry, totals, `locked`, `plOpeningAllowed` |
| `PUT /accounting/opening-balances` | Replaces the opening entry (old one reversed, new one posted) |
| `GET /accounting/settings`, `PUT /accounting/settings` | `fiscalYearStartMonth` |

## New and changed fields (account object)

| Field | Status |
|---|---|
| `isSystem`, `systemKey` | new (`isLocked` stays as an alias of `isSystem`) |
| `isContra` | new; `normalBalance` is the opposite of the type for a contra account. An old client that sends the opposite `normalBalance` gets `isContra: true` |
| `currentBalance`, `balanceSide`, `balanceSigned` | new on tree, list and get. Exact decimal **strings** (never floats). `currentBalance` is never negative; `balanceSide` is `DEBIT`, `CREDIT` or `null`; a folder shows the total of what is inside |
| `canDelete`, `deleteReason`, `canDeactivate`, `deactivateReason` | new on tree, list and get |
| `warnings` | new in the answer of POST and PATCH (`NAME_TYPE_HINT`) |
| `level`, `parentCode`, `parentName`, `childCount` | on list, get and tree (as before) |
| `openingBalance`, `openingSide` | still readable, but no longer entered on the account |
| `code` on POST | optional; the numbering rule above |
| `name` on POST | optional when `presetKey` is sent |
| `presetKey` on POST | new; fills what the client left out; `PARENT_FOLDER_MISSING` when the folder does not exist |
| `GET /accounts/options` | new: `topCodes`, `expenseRanges` (5000 = Cost of Goods Sold, 6000 = Operating Expenses, both type `EXPENSE`), `folders`, `systemKeys`, `contraRule`; control type `SALES` and the tax control types |

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `SYSTEM_LOCKED` | 422, new (replaces `ACCOUNT_LOCKED`) | A system account cannot be deleted, switched off, re-typed, made a folder, or have its control type / contra flag changed. It can be renamed. |
| `HAS_BALANCE` | 422, new | Switching off an account that has a balance. `details: { amount, side }` |
| `PARENT_FOLDER_MISSING` | 422, new | A preset's folder does not exist. `details: { suggestedFolder, missingFolders }` |
| `OPENING_LOCKED` | 422, new | Another entry exists in the books; the opening balances cannot change |
| `CONTROL_USES_SUBLEDGER` | 422, new | Accounts Receivable / Payable with customers / vendors: each opening line must name the customer / vendor |
| `PL_OPENING_NOT_ALLOWED` | 422, new | An income / expense opening amount when the books start on the first day of the fiscal year |
| `UNBALANCED` | 422 | (journal and opening balances) debit is not equal to credit. `details: { debit, credit, difference, side }` |
| `USE_OPENING_BALANCES` | 422, new | An opening balance was sent on an account (POST / PATCH). Use `PUT /accounting/opening-balances` |
| `CHART_HAS_ENTRIES` | 422, new | A template cannot be applied once entries exist |
| `NAME_REQUIRED`, `UNKNOWN_PRESET` | 422, new | No name (and no preset); unknown preset |
| `DEFAULT_ACCOUNT_INACTIVE` | 422 | A default account needed by an invoice is switched off |
| unchanged | | `CODE_TAKEN`, `NAME_TAKEN`, `TYPE_REQUIRED`, `TYPE_MISMATCH`, `TYPE_LOCKED`, `PARENT_NOT_GROUP`, `PARENT_INACTIVE`, `CYCLE`, `TOO_DEEP`, `GROUP_CANNOT_BE_CONTROL`, `CONTROL_TYPE_MISMATCH`, `CONTROL_TAKEN`, `BAD_SUB_TYPE`, `HAS_CHILDREN`, `HAS_ACTIVE_CHILDREN`, `HAS_ENTRIES` |

## Changed behaviour (read this)

1. **`ACCOUNT_LOCKED` is now `SYSTEM_LOCKED`.** The rule is the same, for system accounts.
2. **An opening balance is not a field of the account.** `POST` / `PATCH` with a non-zero `openingBalance` answers `USE_OPENING_BALANCES`. The old values stay readable. `scripts/migrate-opening-balances.js` (dry run by default) moves old values into one opening entry per company.
3. **The default accounts** (made when the first sales invoice is approved) are now system accounts and are named Assets / Current Assets / **Accounts Receivable**, Liabilities / Current Liabilities / **Output Sales Tax**, Income / **Sales**. A company's own account with the same name (or the old name "Sales Tax - Output") is adopted. Numbers follow the numbering rule.
4. **Numbering when the code is left out** follows the rule above (before: the biggest number + 1).
5. **Deactivating** an account with a balance is refused (`HAS_BALANCE`). Delete is still refused for children / entries.
6. **Name sanity hints** are warnings, never errors.

## Decisions taken without the frontend's text (please check)

- **Problems list rules.** The spec named "rules a-f" of the frontend; they were not in the text. The server has six: `OPENING_WRONG_SIDE`, `BALANCE_WRONG_SIDE`, `INACTIVE_WITH_BALANCE`, `NAME_TYPE_MISMATCH`, `SYSTEM_ACCOUNT_MISSING`, `EMPTY_FOLDER`. Contra accounts are left out of both side rules. If the frontend's list differs, change `src/services/accountIssueService.js` (one `add(...)` call per rule).
- **Receivable / payable opening balances.** The spec said to reject manual amounts when a subledger exists. Because no per-customer opening screen exists, the server accepts the amounts **per customer / vendor** (each line carries `partyId`) and rejects a line without one (`CONTROL_USES_SUBLEDGER`). With no customers (or vendors) one total is allowed.
- **Income / expense opening amounts.** Allowed only when the opening date is **not the first day of the fiscal year**. The fiscal year start month is `companies.fiscalYearStartMonth` (default July).
- **Opening balance lock.** Locked as soon as any entry that is not an opening entry exists (there are no financial periods yet).

## Added on 2026-10-27: Trial Balance, ledger, default accounts on Save

- **Migration `20261027000001-accounting-reports-service`**: the report service `ACC_REPORTS` (kind REPORT, VIEW only, tab ACCOUNTS).
- **`GET /accounting/trial-balance`** (opening / period / closing, Dr / Cr, exact strings, `totals`, `sections`, `balanced`, `difference`, `checks`, `ok`; filters `dateFrom`, `dateTo`, `fiscalYear`, `includeZero`, `accountType`) and **`GET /accounting/ledger?accountId=`** (lines with a running balance). Guide: `docs/frontend/trial-balance.md`.
- **Checks** in the trial balance: debit = credit; receivable / payable control accounts agree with the customers / vendors named on the lines; every approved sales invoice has exactly one live entry of its total and a draft has none.
- **The default accounts of a sales invoice are now made when the invoice is SAVED** (before: when it was approved). A draft still posts nothing to them. New error codes: `BAD_RANGE` (trial balance period).

## Added on 2026-10-28: Purchase Invoice

- **Migration `20261028000001-purchase-invoices`**: tables `purchase_invoices` and `purchase_invoice_lines`, the service `ACC_PURCHASES`, the control type `PURCHASES` (the expense account purchase invoices post to; the template's "Cost of Goods Sold" / default purchases account gets it).
- **`/api/v1/purchase-invoices`**: the mirror of the sales invoice, built from a vendor's APPROVED store inwards (`GET /purchase-invoices/inwards?vendorId=`); Save = Un-approved, Approve posts Debit Purchases / Debit Input Sales Tax / Credit Accounts Payable (vendor named), Un-approve reverses. The vendor's own bill number is unique per vendor (`BILL_NO_TAKEN`). Guide: `docs/frontend/purchase-invoice.md`.
- **Default accounts of a purchase invoice** (made when the first one is saved): Purchases (folder Cost of Sales), Input Sales Tax, Accounts Payable.
- **Store guard:** a store purchase on a purchase invoice cannot be Corrected or Un-approved (`ENTRY_ON_PURCHASE_INVOICE`).
- **Trial balance:** a fourth check `PURCHASE_INVOICES_MATCH_LEDGER`.
- New error codes: `INWARD_NOT_APPROVED`, `INWARD_OTHER_VENDOR`, `INWARD_TAKEN`, `NO_AMOUNT`, `INWARDS_REQUIRED`, `BILL_NO_TAKEN`, `DUE_BEFORE_DATE`, `HAS_PAYMENTS`, `ENTRY_ON_PURCHASE_INVOICE`.

## Tests

`tests/accounts.test.js` (numbering, presets, templates, system and contra accounts, balances, `HAS_BALANCE`, warnings, concurrency of codes), `tests/openingBalances.test.js` (opening balances, settings, issues), `tests/journal.test.js` (the engine, default accounts), `tests/salesInvoices.test.js` (also the trial balance of the invoices), `tests/trialBalance.test.js`, `tests/purchaseInvoices.test.js`. Run with `npm test` (needs the `erp_test` database).

## Vouchers (2026-10-26)

- Migration `20261029000001-vouchers`: tables for payment, receipt and journal vouchers (and their lines); services `ACC_PAYMENTS`, `ACC_RECEIPTS`, `ACC_JOURNAL`; control types `CUSTOMER_ADVANCES`, `SUPPLIER_ADVANCES`.
- Endpoints: `/payment-vouchers`, `/receipt-vouchers`, `/journal-vouchers` (options, list, get, create, patch, delete, confirm, unconfirm, accounts-entry; plus `/bills` and `/invoices` pickers). Draft, then Confirm posts one journal entry and updates the invoices' paid/received; "move to draft" reverses it.
- Income tax: payment = bills x rate / 100 (voucher level); receipt = per line, tax = cheque x rate / (100 - rate).
- New system accounts: Income Tax - Customers, Income Tax - Vendors, Customer Advances, Supplier Advances (14 system keys now).
- Invoices: `paymentStatus` and `payments` added; un-approve refused after money moved.
- Trial Balance: 8 checks (new: PAYMENT/RECEIPT/JOURNAL_VOUCHERS_MATCH_LEDGER, INVOICE_PAYMENTS_MATCH_VOUCHERS).
- Tests: `tests/vouchers.test.js`. Guide: `docs/frontend/vouchers.md`.

## Party Ledger, Payables / Receivables, Bank Summary (2026-10-26)

- Migration `20261030000001-bank-clearing`: table `bank_clearings` (the bank's clearing date per bank journal line, outside the journal), service `ACC_BANK`.
- Endpoints under `/accounting`: `GET /party-ledger`, `/payables`, `/receivables` (service ACC_REPORTS); `GET /bank-accounts`, `/bank-summary`, `PUT /bank-clearing`, `DELETE /bank-clearing/:lineId` (service ACC_BANK).
- Tests: `tests/partyLedger.test.js`. Guide: `docs/frontend/ledgers.md`.

## Reports (2026-10-27)

- New under `/accounting` (service ACC_REPORTS, read only): `GET /profit-loss`, `/balance-sheet`, `/balances`, `/balances/open-items`, `/cutoff`. The Trial Balance is unchanged.
- Profit & loss: revenue (income accounts), cost of sales (expense accounts under the 5000 folder), expenses; Balance sheet: assets, liabilities, equity plus computed profit of earlier years / this year (no year-end closing), difference must be 0.
- Services: `financialStatementService.js`, `partyReportService.js`. Tests: `tests/reports.test.js`. Guide: `docs/frontend/accounting-reports.md`.

## Contra voucher (2026-10-28)

- Migration `20261031000001-contra-vouchers`: tables `contra_vouchers`, `contra_voucher_lines`; service `ACC_CONTRA`.
- `/api/v1/contra-vouchers` (options, invoices, bills, list, create, get, patch, delete, confirm, unconfirm, accounts-entry). A customer's invoices and a vendor's bills are settled for the same amount: Debit Accounts Payable (vendor) / Credit Accounts Receivable (customer); no cash or bank.
- Integrated: invoice `received` / `paid` and `payments` (new field `voucherType`), Party Ledger (`CONTRA_VOUCHER`), cut-off report, Trial Balance (9 checks: new `CONTRA_VOUCHERS_MATCH_LEDGER`; `INVOICE_PAYMENTS_MATCH_VOUCHERS` counts contras).
- Service `contraVoucherService.js`. Tests: `tests/contra.test.js`. Guide: `docs/frontend/contra-voucher.md`.

## Default accounts tab (2026-10-28)

- New under `/accounts/defaults` (service ACC_COA): `GET /` (10 roles with the account that fills each; the id is the Chart of Accounts id), `GET /:key/candidates`, `PUT /:key {accountId}` (choose an existing account), `POST /:key/create`, `POST /create-all`.
- Invoices and vouchers already looked for the role's account first and made one only when missing; now the owner can choose / make the accounts before the first invoice. Customer / vendor roles (Accounts Receivable / Payable, Customer / Supplier Advances) cannot be swapped once they have entries.
- Service `defaultAccountService.js`. Tests: `tests/defaultAccounts.test.js` plus one test each in `salesInvoices` and `purchaseInvoices`. Guide: `docs/frontend/default-accounts.md`.

## Default roles only from the Default Accounts tab (2026-10-28)

- `POST /accounts` / `PATCH /accounts/:id` refuse a default `controlType` (`422 USE_DEFAULT_ACCOUNTS`); `GET /accounts/presets` no longer lists the four default-account presets (18 cards). Roles are given only by `PUT /accounts/defaults/:key` (or created by the system when an invoice / voucher needs one). Templates unchanged.
- Tests (accounts.test) updated; run not repeated for the other suites (none of them create default roles through the Chart endpoints).

## Sales tax moved from the store inward to the purchase invoice (2026-10-28)

- Migration `20261101000001-purchase-invoice-tax-rate`: `purchase_invoices.taxRate` (0 to 100, default 0).
- Store inward (chemical and general): `billType`, `salesTax`, `gstPercent` sent by a client are ignored; every new inward has `salesTax 0`, `gstPercent null`, `billType OTHER`; form-data answers `billTypes ["OTHER"]`, `gstRates []`, `taxOnInward false`. Older inwards keep the GST they have.
- Purchase invoice: `taxRate` on create / update / answers; tax = round(amount x rate / 100) per purchase for purchases without tax of their own; older GST inwards keep their tax (no double tax). `options` gives `taxRates` and `defaultTaxRate`.
- Tests: `purchaseInvoices` (new test, fixture makes i1 an older GST inward) and `stores` updated. Guide: `docs/frontend/purchase-tax-on-invoice.md`.

## "Others" on the invoices (2026-10-28)

- Migration `20261101000002-invoice-others`: `othersAmount`, `othersNote` on `sales_invoices` and `purchase_invoices`; the net checks became `net = gross + tax + others` (sales) and `net = gross + tax - others` (purchase).
- Sales invoice: others is ADDED to the bill (extra credit line on the Sales account with the note). Purchase invoice: others is TAKEN OFF the bill (credit line on the Purchases account); more than the bill = `422 OTHERS_MORE_THAN_BILL`. No tax on others. Answers have `othersAmount`, `othersNote`, `othersEffect` (`ADD` / `DEDUCT`).
- Trial Balance purchase check compares the entry's credits with `net + others`.
- Tests: new tests in `salesInvoices` and `purchaseInvoices`. Guide: `docs/frontend/invoice-others.md`.

## Credit limit, credit days and the due schedule (2026-10-29)

- Migration `20261102000001-credit-terms`: `customers` and `vendors` get `creditLimit` (numeric, empty = no limit) and `creditDays` (0 to 3650, default 0); `sales_invoices` gets `dueDate` (purchase invoices already had it).
- Customer and vendor forms accept and return `creditLimit` / `creditDays` (same validators and services as the other fields).
- Both invoices: due date = typed date, else invoice date + the party's credit days (worked out again when the date or the party changes and no date is sent); `DUE_BEFORE_DATE`; `isOverdue`; `creditWarning` (the credit limit never blocks, it only warns) on every answer. New `creditService` (limit warning from the party's ledger balance).
- `GET /sales-invoices/credit/:customerId`, `GET /purchase-invoices/credit/:vendorId`: limit, days, balance, available.
- New report `GET /accounting/due-schedule` (ACC_REPORTS): receivable / payable / net by due-date buckets (overdue ranges, today, next 15 / 30 / 60 days, own bucket days); `dueDate` added to the open-item lines of the other party reports.
- Tests: `creditTerms` (new) and new tests in `salesInvoices` / `purchaseInvoices`. Guide: `docs/frontend/credit-terms.md`.

## Open an employee's account (2026-10-29)

- `POST /users/:id/open` (client admin only): a 4 hour token of the employee (own services), no refresh token, audit `USER_OPENED`; the admin's id is inside the token, so the audit text reads `<employee> (via client admin <admin>)`. Refused: `CANNOT_OPEN_SELF`, `USER_INACTIVE`, other company or unknown id = 404. Password change / logout-all in the opened session: `ACCOUNT_OPENED_BY_ADMIN`.
- `authenticate` accepts an opening admin that is a super admin, or a client admin of the same company as the employee. Tests: `tests/openUser.test.js`. Guide: `docs/frontend/open-employee-account.md`.

## Party ledger: pairing, reversal date, document details (2026-10-30)

- `GET /accounting/party-ledger` lines: `reversedByEntryId/No`, `reversesEntryId/No`, and `gross`, `tax`, `taxRate`, `othersAmount`, `othersNote`, `notes`, `voucherNarration`, `entryNarration`.
- `journalService.reverse` now dates the reversal like the entry it reverses (the caller may still name a date); the six document services (sales / purchase invoice, payment / receipt / journal / contra voucher) no longer pass today's date. Opening balances still choose their own date.
- Test: new test in `tests/partyLedger.test.js`.

## Process overview and rate limit (2026-10-30)

- `GET /v1/departments/overview` (`jobService.overview`): jobs per status for every department the person may see, one set-based query (same "all sent" rule as the incoming list). Test: `tests/departmentOverview.test.js` (compared with the incoming / rejected lists).
- Rate limit: per signed-in person (`RATE_LIMIT_USER_PER_MINUTE`, default 1200) instead of one 300/min bucket per IP shared by a whole office; anonymous requests keep a per-IP bucket (`RATE_LIMIT_IP_PER_MINUTE`, 300). The token's signature is checked, so a forged token falls back to the IP bucket.

## Store overview (2026-10-30)

- `GET /v1/stores/overview` (`storeOverviewService.overview`): months of inwards / outwards, stock position, top 5 vendors and drafts per store the person may see, in one call.

## Accounting overview (2026-10-30)

- `GET /v1/accounting/overview` (`accountingOverviewService.overview`): one call, permission-filtered per block (null for a block the person may not see).

## Payroll services (2026-10-30)

- Migration `20261103000001-payroll-services`: `PAYROLL` added to the `services_menuGroup_check`; four MODULE services seeded (`PAYROLL_SALARY`, `PAYROLL_REPORTS`, `PAYROLL_APPLICATIONS`, `PAYROLL_EMPLOYEES`), built in (cannot be deleted). `MENU_GROUPS` (model) and `GROUPS` (service validator) accept `PAYROLL`. Test: new test in `tests/serviceAccess.test.js`.

## Employee job roles and VIEW / FULL on every service (2026-10-30)

- Migration `20261104000001-user-job-role`: `users.jobRole` (existing employees become EMPLOYEE). `src/utils/jobRoles.js` holds the list (no database check).
- `GET /users/roles`, `jobRole` on create / update / list filter / user JSON. Tests: new test in `tests/employees.test.js`.
- `companyUserService`: `accessLevels` is `["VIEW","FULL"]` for every service and a report service is stored as given (before: forced to VIEW).

## Payroll masters, chunk 1 (2026-10-30)

- Migration `20261105000001-payroll-masters`: `payroll_groups` (systemKey for the 4 defaults), `payroll_departments` (fte), `payroll_designations`, `payroll_shifts`, `payroll_holidays` + `payroll_holiday_groups`, `payroll_banks`.
- `payrollMasterService` (one generic CRUD described per master), `payrollMasterValidator`, `payrollRoutes` (`/v1/payroll`). Tests: `tests/payrollMasters.test.js`. Guide: `docs/frontend/payroll-masters.md`.

## Payroll employee master, chunk 2 (2026-10-30)

- Migration `20261106000001-payroll-employees`: `payroll_employees` (personal, work, salary, payment, status DRAFT / CONFIRMED, closed) and `payroll_files` (documents as bytea). `payrollEmployeeService`, `payrollEmployeeValidator`, routes in `payrollRoutes`.
- The masters now count employees: `employees` on group / department / designation / shift / bank, department `vacancy`, delete refused while used (`IN_USE`), a department with employees cannot change group. Tests: `tests/payrollEmployees.test.js`. Guide: `docs/frontend/payroll-employees.md`.

## Payroll policy, chunk 3 (2026-10-30)

- Migration `20261107000001-payroll-policies`: `payroll_policies` (versions per group from a month; check half-day limit > late limit; unique per group and month). `payrollPolicyService` (`effectivePolicy` is what the payroll will call to copy the rules), validator, routes. Tests: `tests/payrollPolicies.test.js`. Guide: `docs/frontend/payroll-policy.md`.

## Payroll joining application, chunk 4 (2026-10-31)

- Migration `20261108000001-payroll-joining-applications`: `payroll_employees.monthlyIncomeTax` renamed `yearlyIncomeTax`, new `monthlyEobi`; table `payroll_joining_applications` (DRAFT / IN_REVIEW). `payrollApplicationService`, `payrollApplicationValidator`, routes `/payroll/applications`; documents in `payroll_files` with ownerType `JOINING` (photo, CNIC front and back, scanned form). Submit checks: required details and documents, CNIC not already an employee or in review, department vacancy (fte 0 = no limit). Nothing reaches the employee master yet (approval is the next chunk). Tests: `tests/payrollApplications.test.js` (5).

## Payroll application approval, chunk 5 (2026-10-31)

- Migration `20261109000001-payroll-application-approval`: `payroll_approvers`; the application gets statuses APPROVED / REJECTED, `employeeId`, approved / rejected by and at, `rejectReason`. `payrollApproverService` (client admin always a reviewer, plus chosen people with a payroll service); `payrollApplicationService`: `reviewUpdate` (work and salary fields only), `approve` (INSERT ... SELECT of the employee as CONFIRMED, files copied, vacancy counted on working employees), `reject` (reason), `reopen`. Tests: `tests/payrollApproval.test.js` (4).

## Payroll IBAN and percents (2026-10-31)

- Migration `20261110000001-payroll-iban-and-percents`: `iban` (check `^PK[0-9]{2}[A-Z]{4}[A-Z0-9]{16}$`), `yearlyIncomeTaxPercent`, `monthlyEobiPercent` (numeric(5,2), 0 to 100) on `payroll_employees` and `payroll_joining_applications`; the old amount columns were converted to percents of the basic salary and dropped. `src/utils/payrollDeductions.js` (`percentCents`, `monthlyDeductions`: exact cents, half up) is what the payroll run will call to deduct them. The IBAN check is the shape only (no mod-97 checksum).

## Payroll attendance, chunk 6 (2026-11-01)

- Migration `20261111000001-payroll-attendance`: `payroll_devices`, `payroll_punch_batches`, `payroll_punches` (unique per company, employee ID and moment: re-importing is safe; matched to employees on the ID when read, so a punch can come before its employee), `payroll_attendance_days` (code P / L / HD / A / R / AL, first in, last out, late, overtime, duty minutes, incomplete, restDay, isManual).
- `src/utils/attendanceEngine.js` (pure: which shift day a punch belongs to, the code, late and overtime, `overtimeDays`, `payableDays`), `src/utils/punchParser.js` (dates, times and rows as a sheet writes them), `payrollAttendanceService`, `payrollAttendanceValidator`, routes `/payroll/attendance`. Every source goes through `importRows`: the machine API adapter will call it with source API. Tests: `tests/attendanceEngine.test.js` (10), `tests/payrollAttendance.test.js` (8).
- Rules: a night shift belongs to the day it started (each shift owns the 24 hours around its middle); overtime = hours worked over the duty hours (all the hours on a rest day), in days = overtime / duty hours; a date nobody punched on is left empty, not absent; hand-set days survive recalculation.

## Attendance recalculation and hand-set days (2026-11-02)

- Migration `20261112000001-attendance-original-code`: `payroll_attendance_days.originalCode` (what the machine had worked out before HR set the day).
- `src/services/attendanceRefresh.js`: holidays, policy versions, shift times / duty hours and employees (create, approve, shift / group / joining date, close, reopen) work the affected days out again as soon as they are saved (hand-set days are kept; it never fails the change). After an import the whole month of the file up to today is worked out, so rest days (weekly off, holidays) get their R without a file.
- `POST /attendance/process` is the Recalculate button: it gives hand-set days back to the machine unless `keepManual: true`; answers `manualReset`. `GET /attendance/overview` has `manualDays`.
- Tests: `tests/payrollAttendance.test.js` (9). The 30 second jest limit is too short for the longest payroll tests on this machine today (payrollMasters "access", payrollPolicies "rules" pass with `--testTimeout=120000`).

## Payroll resignation applications, chunk 7 (2026-11-02)

- Migration `20261113000001-payroll-resignations`: `payroll_resignations` (DRAFT / IN_REVIEW / APPROVED / REJECTED; one open per employee by a partial unique index). `payrollResignationService`, `payrollResignationValidator`, routes `/payroll/resignations`. Approve = post: `payroll_employees` is closed with `leavingDate` = the last working day, the attendance days after it go (`attendanceRefresh.employeeChanged`). Approval only from the last working day on (`LAST_DAY_IN_FUTURE`). The reviewer is the same as for joining applications (`payrollApproverService`). An employee with a resignation cannot be deleted. `GET /resignations/absentees` lists working employees with no punch for N days up to the latest day with machine data. Tests: `tests/payrollResignations.test.js` (7).

## Employee loans and the Employee Loan Voucher, chunk 8 (2026-11-03)

- Migration `20261114000001-employee-loans`: control type `EMPLOYEE_LOANS` on accounts (asset, one per company); tables `payroll_loans` (one open application per employee), `payroll_loan_deductions` (to be written by the payroll run), `employee_loan_vouchers`.
- Accounting: new default account role `EMPLOYEE_LOANS` ("Employee Loans", group PAYROLL; adopts an account named Employee / Staff Loans; not in the templates, made by the first voucher or the Default Accounts tab). `employeeLoanVoucherService` + `/v1/employee-loan-vouchers` (service `ACC_PAYMENTS`): DRAFT -> CONFIRMED posts Debit Employee Loans / Credit Bank or Cash (source `EMPLOYEE_LOAN_VOUCHER`, no party), un-confirm reverses it (refused after the payroll recovered more than what would stay paid out). Not yet in the trial balance checks.
- Payroll: `payrollLoanService`, `utils/loanSchedule` (instalments rounded to the rupee, the last takes the difference), `/v1/payroll/loans`, attachments in `payroll_files` (ownerType LOAN, up to 5). The loan is limited to the employee's basic salary (at save, send and approve). An employee with a loan or resignation cannot be deleted.
- Tests: `tests/loanSchedule.test.js` (3), `tests/payrollLoans.test.js` (8); `tests/accounts.test.js` and `tests/defaultAccounts.test.js` updated for the new role (the voucher test now dates its voucher inside the month its trial balance reads).

## Payroll leave applications and Annual Leaves, chunk 9 (2026-11-04)

- Migration `20261115000001-payroll-leaves`: `payroll_leaves` (DRAFT / IN_REVIEW / APPROVED / REJECTED / CANCELLED) and `payroll_leave_days` (the working days a leave covers). `payrollLeaveService`, `payrollLeaveValidator`, `utils/leaveBalance` (leave earned from the policy: credited on the 1st of each month after the months before leave, yearly maximum, carried on), routes `/payroll/leaves` and `/payroll/reports/annual-leaves`.
- Working days only: the weekly off day of the policy and the holidays of the group are not taken from the balance. The balance (earned - approved - in review) is checked at send and at approve; overlapping leaves are refused; an approved leave can be cancelled by the reviewer.
- Attendance: `computeDays` has `isLeave`; approved leave days with no punch are AL (`processRange` reads `payroll_leave_days`); approving / cancelling a leave refreshes the days (`attendanceRefresh.leaveChanged`).
- Fix: an employee-scoped recalculation judged "a day with data" from the scoped employees only and dropped their absent days; it now looks at every punch of the company (`processRange`).
- Tests: `tests/leaveBalance.test.js` (5), `tests/payrollLeaves.test.js` (7). An employee with a leave application cannot be deleted.

## The payroll, chunk 10 (2026-11-05)

- Migration `20261116000001-payroll-runs`: `payroll_runs` (a class and a month; the policy copy), `payroll_slips` (snapshot, inputs, engine result, status DRAFT / REVIEW / FINAL_REVIEW / APPROVED / SUSPENDED), `payroll_slip_days` (the attendance copy HR may edit), `payroll_slip_loans`, `salary_payment_vouchers` (+ lines); control types SALARY_EXPENSE, SALARIES_PAYABLE, EOBI_PAYABLE, SALARY_TAX_PAYABLE, EMPLOYEE_DEDUCTIONS (default account roles, group PAYROLL).
- `src/utils/payrollEngine.js` (pure, exact: cents and half days; the document example gives 31,872; the sheets of the old system match to the rupee), `payrollRunService`, `salaryPaymentVoucherService`, `payrollRunValidator`, routes `/payroll/runs`, `/payroll/slips`, `/salary-payment-vouchers`.
- Rules: one payroll per class and month; only confirmed employees; the policy is copied (editable per payroll, optionally saved as the class default); the payslip holds a copy of the attendance (edits stay on the payslip, "Get attendance" copies the original again); AL days are paid up to the leave balance; every `latesPerHalfDay` lates cost half a day; MONTHLY / DAILY / FIXED salaries; overtime from the attendance (HR may type hours); EOBI and income tax are the employee's percents of the basic (HR may type amounts); loan instalments come from the loan schedule and what is owed.
- Approval posts one entry per payslip (dated the month's last day) and writes the loan instalment; sending back reverses both (refused once paid or on a voucher). Tests: `tests/payrollEngine.test.js` (7), `tests/payrollRuns.test.js` (7, ending with a balanced trial balance); `accounts` and `defaultAccounts` tests updated for the five roles.

## EOBI contribution list and voucher
- Migration `20261117000001-eobi.js`: providers, locations, rates, lists, list rows, vouchers; control type `EOBI_EMPLOYER_EXPENSE`.
- Payslip EOBI comes from the list when the employee is listed (`eobiSource`).
- Journal kind `EOBI_VOUCHER`. Fixed a month regex (`\d`) in `voucherValidator.js`.

## Income tax history and salary tax voucher
- Migration `20261118000001-income-tax.js`: `payroll_income_tax` (fixed amount or percent from a month), `salary_tax_vouchers` (+ lines).
- Payroll tax: history amount, else history percent, else card percent. Journal kind `SALARY_TAX_VOUCHER`.
- A payslip on a salary tax voucher cannot be sent back to Draft.

## Salary increment
- Migration `20261120000001-salary-increments.js` (`payroll_increments`); one open increment per employee.
- Payroll: a payroll of a month earlier than a posted increment's effective month keeps the old figures (`salaryAsOf`).

## Bank upload file and cash sheet
- Migration `20261121000001-bank-files.js`: `payroll_bank_files` (every file made, content kept) and `payroll_slips."bankFileId"` (the "bank file made" tick, cleared when the payslip is sent back to Draft).
- Bank file in the Meezan Bank layout (one header row, no total line), from approved bank payslips; amount = unpaid balance (or the whole net with `scope=all`). A payslip without an account number is listed as skipped. A file can be made again; each one is kept and can be downloaded again exactly.
- Cash sheet: approved cash payslips with the notes of each envelope (5000 ... 10, rest) and the notes to bring from the bank; JSON, Excel, PDF.

## Employee card: fixed monthly tax, EOBI number, SESSI number
- Migration `20261122000001-employee-fixed-tax-and-ids.js` (employees and joining applications): adds `monthlyIncomeTax`, `eobiNo`, `scssiNo`; the old tax percent becomes an amount (percent of the basic, rounded to the rupee); `yearlyIncomeTaxPercent` and `monthlyEobiPercent` are dropped.
- Payroll tax: history amount, else history percent, else the card's `monthlyIncomeTax` (`incomeTax.settingsFor`). EOBI only from the EOBI list (no list = 0).
- Joining application: no bank is required (`appMethod`: BANK only when an old draft has bank and account number, else CASH); `missingFor` has no bank item.

## Punch upload: strict date/time, no empty batch
- `utils/punchParser.js`: date exactly YYYY-MM-DD (2000 to 2100), time HH:MM or HH:MM:SS (24 h). The old day-first dates and AM/PM times are refused as invalid rows.
- `importRows`: nothing new = no batch, no processing, HTTP 200 (`batchId: null`).

## Attendance Report and Punch Report
- `payrollAttendanceReportService.js` on top of `payrollAttendanceService.loadMonth` (now exported with `totalsOf`, `employeeJson`, `dayJson`): month sheets of all employees, one-employee month pages, Excel. No migration.

## Grey width
- Migration `20261123000001-grey-width.js`: `grey_lots.width`, `grey_lot_thaans.width` (optional). Downstream tables point at the thaan, so the width is read from there (SO card, jobs, folding, packing).

## Return cloth to the SO Card section
- Migration `20261124000001-job-return-to-so-card.js` (jobs: returnedToSoCard, returnReason, returnedAt, returnedById, returnedFromJobId). `jobService.returnToSoCard`: whole job = REJECTED + returned flag (every list already leaves rejected jobs out, so the meters are free at the SO desk); some SO cards = the rows move to a new returned job. A card with all its cloth back is NEW again.

## Advance
- Migration `20261125000001-employee-advances.js`: `payroll_advances`, `employee_advance_vouchers`, `payroll_advance_deductions`, `payroll_slip_advances`, `payroll_slips.advanceAmount`, account role `EMPLOYEE_ADVANCES`.
- Payroll: an advance dated up to the month with a CONFIRMED voucher and not recovered is taken in full (`advanceDues`); the engine has `deductions.advance`; approving the payslip writes `payroll_advance_deductions` and credits Employee Advances; sending it back deletes them.

## Chemical requests per department
- Migration `20261126000001-department-chemical-requests.js`: `company_services.chemicalRequests` (default true). `departmentSettingsService` (list, setMany, `chemicalEnabled`); `needDept` of `chemicalRequestService` and `departmentChemicalService.mine` refuse a department without it; `departmentRoutes` strips the chemical keys from every response of such a department (not for the client admin).

## Process Management toggle and limit
- Migration `20261127000001-process-management-toggle.js`: `companies.processManagement` (existing = true), `companies.processLimit` (0), `services.companyId` (no FK on purpose), service code unique per owner.
- `accessService.companyServices` drops menu group PROCESS services while the company has it OFF. `processService` + `/v1/processes` for the client admin. `companyService.setServices` keeps the company own processes; switching ON gives Folding and Packing.

## Process limit counts active own + assigned (2026-11-17)
- Migration `20261128000001-company-process-active.js`: `company_services.isActive` (the company own switch; existing rows true) and the limit of existing companies = their number of processes. `PATCH /processes/:id` on an assigned process allows only `isActive` (422 `PROCESS_NOT_EDITABLE` otherwise); switching ON needs `used < limit` (422 `PROCESS_LIMIT_REACHED` with `{limit, used}`); `GET /processes` has `used` (active own + assigned), `overLimit`, `assigned[].isActive/userCount/usage`; `/auth/me` lists only active processes; option A when the limit is lowered (nothing is switched off). Guide: `docs/frontend/process-management-settings.md`.

## SO card sub-categories
- Migration `20261129000001-so-card-groups.js`: `so_card_groups` (code A.., label, colourId, remarks) and `so_card_lots.groupId`; the unique (card, lot) became (card, lot, group). A group = its own `so_card_lots` rows, so jobs, folding and packing work unchanged; `pickThaans` shares the thaan rows between lines (askedMeters); `jobService.assertNoSplitThaanInJob` / `splitIntoBatches` / `sendCard`; Packing adds up the parts of one thaan.
