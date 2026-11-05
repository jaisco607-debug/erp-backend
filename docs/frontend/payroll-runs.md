# Payroll (Payroll Summary, Payroll Sheet, Payslip, Salary Payment Voucher): frontend guide (chunk 10)

## 1. How it works
- A **payroll** is **one class (group) for one month**: Admin, Factory, Head Office, Outlet ... Payroll ID **107** is "Factory, Oct-26". **Create Payroll** makes the payslips of every **confirmed** employee of the class who worked in the month (joined by the month's end, and has not left before its start). Employees whose card is still a draft are not included.
- The payroll **copies the policy** of its month (late limit, half-day limit, lates per half day, weekly off day, overtime factor, leave rules). A later change of the class policy never changes this payroll. The **Policy** button changes the policy of THIS payroll only (and can also save it as the class policy).
- Each employee has a **payslip** (PD-ID). It holds a **copy of the month's attendance** taken from the attendance module. HR can change a day on the payslip; **Get attendance** copies the real attendance in again and the changes are gone. The attendance module itself is never changed from the payslip.
- Every amount comes from one calculation (the same one for every employee, exact to the paisa). A recalculation never changes a rupee: the same inputs always give the same answer.
- Status of a payslip (number in brackets): **Draft (0) -> Review (1) -> Final review (2) -> Approved (3)**; **Suspended (9)** = left out of this payroll for now. HR moves a payslip from Draft to Review. The reviewers (a client admin or a person chosen under Approval Roles) move it to Final review and approve it, or send it back to Draft. HR edits only in Draft and Review.
- **Approving** posts the accounting entry of the payslip and takes the loan instalment from the employee's loan. **Sending back to Draft** (while nothing is paid on it) reverses both.
- The salary is **paid by a Salary Payment Voucher** (Accounts). The payslip's **Paid** and **Balance** come from its confirmed vouchers, never typed.

## 2. The calculation (for the Computation tab and for explaining to users)
| Step | Rule |
|---|---|
| Days | from the attendance of the month: P present, L late, HD half day, A absent, R rest day (weekly off or holiday), AL annual leave |
| Paid AL | AL days are paid only up to the **leave balance** (`alBalance`); AL days over it are unpaid like absences |
| Late penalty | every `latesPerHalfDay` lates (policy, default 3) cost **half a day** (0 = lates are never penalised) |
| Paid days | P + L + R + paid AL + half of HD - the late penalty |
| Basic earned | **MONTHLY:** basic / days of the month x paid days. **DAILY:** the daily wage x paid days. **FIXED:** the basic, whatever the attendance. Rounded to the whole rupee |
| Overtime | overtime hours / duty hours x salary per day x overtime factor (policy), rounded to the rupee. Overtime hours come from the attendance (hours worked over the shift's duty hours; all hours worked on a rest day); HR can type the hours instead |
| Gross | basic earned + overtime |
| Additions | food + maintenance + mobile + others |
| Deductions | loan instalment + EOBI + income tax + others |
| Net payable | gross + additions - deductions |
| Contribution | the value of the days lost to lates and half days (shown on the sheet; not deducted again) |
Example (the document): basic 30,000, 31 days, P 22, L 4, R 4, HD 1: paid days 22 + 4 + 4 + 0.5 - 0.5 = 30; basic 29,032; overtime 10 h / 8 h = 1.25 days = 1,210; gross 30,242; additions 4,000; deductions 2,370; net **31,872**.
EOBI and income tax are the percents of the employee card (`monthlyEobiPercent`, `yearlyIncomeTaxPercent`) of the basic salary (of the basic earned for a DAILY wage). HR can type another amount on the payslip.

## 3. Access
Base URL `/api/v1/payroll`. Read (everything below): any payroll service. **HR** (service `PAYROLL_SALARY` FULL): create / delete a payroll, change the policy, change a payslip, edit a day, Get attendance, Calculate, Suspend, Resume, delete a Draft payslip, move Draft to Review. **Reviewers** (a client admin or a chosen approver; others get `403`): Final review, Approve, Send back. Another company's record = `404`. Salary payment vouchers: service `ACC_PAYMENTS` (accounts side).

## 4. Payroll Summary screen
`GET /runs?month=2026-10&search=` (month default this month; `search` = class name or payroll ID):
```json
{ "month": "2026-10", "monthCode": "102026", "monthLabel": "Oct-26",
  "totals": { "payrolls": 4, "employees": 283, "basic": "10321983.00", "netApproved": "0.00", "salaryBalance": "0.00", "contribution": "0.00" },
  "data": [ { "id": "...", "code": 107, "label": "Payroll #107", "group": { "id": "...", "name": "Factory" }, "month": "2026-10", "monthCode": "102026", "monthLabel": "Oct-26", "category": "CAT-B", "daysInMonth": 31,
      "policy": { "lateLimitMinutes": 15, "halfDayLimitMinutes": 120, "latesPerHalfDay": 3, "weeklyOffDay": "SUNDAY", "overtimeFactor": 1, "leaveEarnedPerMonth": 2, "maxLeavePerYear": 24, "monthsBeforeLeave": 6, "summary": "Late 15m, half-day 120m, ..." },
      "policySource": "DEFAULT", "counts": { "total": 116, "draft": 88, "review": 1, "finalReview": 26, "approved": 0, "suspended": 1 },
      "totals": { "employees": 115, "basic": "4008400.00", "gross": "...", "net": "...", "netApproved": "0.00", "paid": "0.00", "balance": "0.00", "contribution": "0.00" }, "canDelete": true } ] }
```
- Chips: PAYROLLS = `totals.payrolls`, EMPLOYEES, BASIC, NET (APPROVED) = `netApproved`, SALARY BALANCE = `salaryBalance` (approved net not yet paid), CONTRIBUTION. (CONTB. NOT ON CTV is not built.)
- Table columns: ID = `code`, CLASS = `group.name`, MONTH = `monthLabel`, TYPE = `category` (CAT-B for now), EMPLOYEES, BASIC, NET (= `totals.netApproved`), PAID, BALANCE, CONTB. **Open** opens the sheet. A month picker with previous / next, a refresh, an **Attendance** button (the attendance summary) and **Create Payroll**.
- `POST /runs` `{ "month": "2026-10", "groupId": "..." }` (HR, 201) is **Create Payroll**: a month picker and a class picker. Errors: `422 PAYROLL_EXISTS` (that class already has a payroll for that month, `details.code`), `422 MONTH_IN_FUTURE`, `422 NO_EMPLOYEES`, `422 GROUP_INACTIVE`.

## 5. Payroll Sheet screen (the batch of one payroll)
- `GET /runs/:id` returns the run (as above). Header: "PAYROLL SHEET (CAT-B) - FACTORY" from `category` and `group.name`; the policy line from `policy.summary`; "Month: 102026 / 31" from `monthCode` and `daysInMonth`; "Employees: 88" and "NET Rs." from `totals`; "Payroll ID: 107" from `code`.
- `GET /runs/:id/slips?status=&search=&department=&departmentId=&paid=unpaid&page=&limit=` returns `{ run, data, page, limit, total }`, ordered by employee ID (limit up to 1000, default 200). `search`: name or ID. `department`: part of the department name. `status`: `DRAFT`, `REVIEW`, `FINAL_REVIEW`, `APPROVED`, `SUSPENDED` (the tabs). `paid=unpaid`: approved payslips with something still to pay.
- **Tabs:** Dashboard (the counts), **Payroll (n)** = Approved, **Final Review (n)**, **Review (n)**, **Draft (n)** from `run.counts`; **Payments** (approved payslips with their paid / balance: use `status=APPROVED`); **Suspend (n)**; **Attendance** (`GET /runs/:id/attendance`: `{ run, dates, data: [ { slipId, employee, status, days: { "2026-10-01": "P", ... }, totals: { P, L, HD, A, R, AL }, edited } ] }`).
- **Columns** of a row (`data[i]`): PD-ID = `payslipId`; EMPL-ID = `employee.label`; EMPLOYEE NAME = `employee.name` with `employee.department` and `employee.designation` under it; BASIC AMNT = `basicSalary`; DUTY HRS = `dutyHours`; TOTAL HRS = `payableDays` (the old sheet's "total hrs" is the paid days); GROSS SALARY = `gross`; ADDITIONS = `additions.total`; DEDUCTIONS = `deductions.total`; NET AMNT = `net`; PAID = `paid`; BALANCE = `balance`; A/C# = `hasAccount` (YES / NO); P, A, LT, R, HD, AL = `days.P`, `days.A`, `days.L`, `days.R`, `days.HD`, `days.AL`; T.DAYS = `days.total`; R+ = `restWorked` (rest days he worked); A- = `absentDays`; HD- = `halfDayDeduction`; LATE- = `lateDeductionDays`; NET DAYS = `netDays`; CONTB. = `contribution`. U/T (undertaking) is not built. A SELECT checkbox per row.
- **Buttons:** SAVE (the payslip screen saves itself; on the sheet it can just refresh), **DELETE** = `DELETE /runs/:id` (only while no payslip is approved: `422 PAYROLL_HAS_APPROVED`), PRINT and CSV (built in the frontend from the list), **POLICY** (section 6), CLOSE.
- **Bulk moves** (the SELECT checkboxes, or all): `POST /runs/:id/slips/move` `{ "action": "review" | "final-review" | "approve" | "send-back", "slipIds": [...] }` (without `slipIds` = every payslip that can take the step; at most 1000). Answer `{ action, moved, failed: [ { slipId, empCode, name, code, message } ], run }`: a payslip that cannot move is listed in `failed`, the others move. `review` is HR's; the others need a reviewer (`403` for everyone else, refused at once).
- `POST /runs/:id/add-employees` (HR): gives a payslip to employees who joined or were confirmed after the payroll was made (or whose payslip was deleted). Returns the run with `added`.

## 6. Policy button (Policy Setup of the payroll)
`PATCH /runs/:id/policy` (HR): any of `lateLimitMinutes`, `halfDayLimitMinutes`, `latesPerHalfDay`, `weeklyOffDay`, `overtimeFactor`, `leaveEarnedPerMonth`, `maxLeavePerYear`, `monthsBeforeLeave` and `makeDefault` (boolean). The modal shows the five of the design (late after, half-day after, annual leave per month, maximum per year, leave starts after) and may also show the weekly off day, lates per half day and overtime factor.
- The payslips that are not approved are **calculated again**: a day of work that the attendance calls P, L or HD is judged again from the minutes late against the new limits; the leave balance follows the new leave rules; days HR edited are left alone.
- `makeDefault: true` ("Also make this the default for all future Factory payrolls") also saves these rules as the class policy from this payroll's month on (a new version, or changes the version of that month).
- **Class defaults** table of the modal: `GET /policies/by-group?month=2026-10`.
- `422 HALF_DAY_NOT_MORE_THAN_LATE` when the half-day limit is not more than the late limit. `run.policySource` is `DEFAULT`, `POLICY` or `EDITED`.

## 7. Payslip screen (`GET /slips/:id`)
```json
{ "id": "...", "payslipId": 7299, "runId": "...", "runCode": 107, "month": "2026-10", "status": "DRAFT", "statusCode": 0, "statusText": "Draft",
  "employee": { "id": "...", "code": 70, "label": "00070", "name": "RIZWAN ALI KHAN", "department": "Assembly - Box Making", "designation": "Worker", "joiningDate": "2019-10-11", "leavingDate": null, "isLeft": false },
  "shift": "08a-06p (08:00-18:00, 10 hrs)", "dutyHours": 10, "salaryType": "MONTHLY", "basicSalary": "40500.00",
  "days": { "P": 17, "L": 8, "HD": 0, "A": 0, "R": 4, "AL": 2, "total": 31 }, "alBalance": 3, "alPaid": 2, "lateDeductionDays": 1, "halfDayDeduction": 0, "absentDays": 0, "restWorked": 0, "payableDays": 30, "netDays": 30,
  "overtimeMinutes": 0, "overtimeHours": 0, "overtimeManualHours": null,
  "additions": { "food": "0.00", "maintenance": "0.00", "mobile": "0.00", "others": "0.00", "total": "0.00" },
  "deductions": { "loan": "0.00", "eobi": "407.00", "incomeTax": "0.00", "others": "0.00", "total": "407.00" },
  "gross": "39194.00", "contribution": "1306.00", "net": "38787.00", "paid": "0.00", "balance": "38787.00", "paymentStatus": "UNPAID",
  "hasAccount": true, "isCash": false, "paymentMethod": "BANK", "bank": { "name": "Meezan Bank", "accountNo": "0103308659", "accountTitle": "RIZWAN ALI KHAN" }, "notes": null, "suspendNote": null, "daysEdited": false, "overrides": [],
  "attendance": [ { "date": "2026-10-01", "day": "Thu", "code": "P", "originalCode": "P", "edited": false, "in": "08:09", "out": "18:14", "hours": 10.08, "overtimeMinutes": 0, "noData": false, "inEmployment": true } ],
  "attendanceHours": 242.08, "holidays": [ { "date": "2026-10-04", "day": "SUNDAY", "reason": "Weekly off" } ], "policy": { "...": "...", "summary": "..." },
  "loans": [ { "loanId": "...", "appId": "00384", "emi": "5000.00", "due": "5000.00", "amount": "5000.00", "balanceBefore": "10000.00", "balanceAfter": "5000.00", "months": 2, "deductFrom": "2026-10" } ], "loanBalance": "10000.00",
  "leave": { "balance": 3, "markedAL": 2, "adjusted": 2, "unpaidAL": 0, "applications": [ { "id": "...", "appId": "00012", "fromDate": "2026-10-06", "toDate": "2026-10-06", "days": 1 } ] },
  "payments": [ { "voucherId": "...", "voucherLabel": "SPV-00007", "date": "2026-11-02", "paidFrom": { "id": "...", "code": "1102", "name": "Bank" }, "refNo": null, "remarks": null, "amount": "38787.00", "status": "CONFIRMED" } ],
  "computation": [ { "key": "basic", "label": "Basic pay", "value": "40500.00", "note": "monthly salary" } ],
  "checks": [ { "key": "ATTENDANCE", "label": "Attendance checked", "ok": true, "message": "every day has attendance" } ],
  "canEdit": true, "canDelete": true, "canSuspend": true, "canResume": false, "canSendReview": true, "canFinalReview": false, "canApprove": false, "canSendBack": false }
```
- **Header:** name and ID, department and designation, the attendance source label ("Standard attendance"), **Left** checkbox = `employee.isLeft` (read only), **Cash** checkbox = `isCash` (PATCH `isCash`; the employee card's payment method is the default: `paymentMethod`), Status dropdown (map to the actions of section 8), "Payroll ID: 107 / 7299" from `runCode` and `payslipId`.
- **Buttons:** SAVE (the PATCH below), PRINT (frontend), DELETE (`canDelete`, Draft only), **Move to Review** (`canSendReview`), **Suspend** (`canSuspend`), CLOSE.
- **Main tab - A-ATTENDANCE:** "LEAVES Baln: 3.0" = `leave.balance`; the legend; the day grid from `attendance` (two columns of the month: DATE, DAY, ATTN as a coloured code, IN -> OUT and `hours`). A day with `inEmployment: false` is before he joined or after he left (blank); `noData: true` has no attendance data (shown as "-", not paid). `edited: true` = HR changed it (show the `originalCode`). "Total: 242.08 Hrs" = `attendanceHours`; the counts row = `days`; "Paid Leaves (auto on save from AL days) 2.0 / Baln 3.0" = `leave.adjusted` / `leave.balance`.
- **Change a day:** `PUT /slips/:id/days/2026-10-05` `{ "code": "A" }` (HR; `P`, `L`, `HD`, `A`, `R`, `AL`; Draft and Review only). The payslip is calculated again and returned. Setting a day back to its original code is not an edit any more. `422 NOT_A_DAY_OF_THE_SLIP` for a date outside his employment.
- **Get attendance:** `POST /slips/:id/get-attendance` (HR): copies the attendance module's days in again; **every change HR made to the days is gone and the overtime goes back to what the attendance says**; the loan instalments are asked again; the additions and deductions HR typed stay. Show a confirmation.
- **B-SUMMARY:** DOJ = `employee.joiningDate`; Month; the policy line; Days; Duty Hrs (editable: `dutyHours`) and the shift (`shift`); Restdays / holidays = `holidays` (right panel "Holidays this month": date, day, reason); BASIC PAY (editable: `basicSalary`, this payslip only); SALARY / HRS = computation `rate` and `hourly`; WORKING DAYS (Sec. C) = `payableDays`; OVERTIME Hrs (editable: `overtimeHours`, empty = from the attendance) and its days; TOTAL DAYS; SALARY = `gross`; ADDITIONS, DEDUCTIONS, CONTRIBUTION, NET PAYABLE, PAID AMNT, BALN AMNT; bank title and account from `bank`.
- **D-ADDITIONS & DEDUCTIONS:** additions Food, Maint., Others, Mobile; deductions **Loan** (with **Adj ->**), EOBI, I/TAX, Others (the old sheet's MISL). Advance and U/T deductions are not built. `PATCH /slips/:id` (HR, Draft and Review only) with any of: `basicSalary`, `dutyHours`, `food`, `maintenance`, `mobile`, `othersAdd`, `eobi`, `incomeTax`, `othersDeduct`, `overtimeHours` (a number, or `null` to use the attendance), `isCash`, `notes`, `loans` (`[ { loanId, amount } ]`). Amounts are numbers or text with at most 2 decimals, 0 or more. The payslip is calculated again and returned.
  - `eobi` and `incomeTax` typed by HR are kept (`overrides: ["eobi"]`) until **Calculate** gives them back to the percents: `POST /slips/:id/calculate` `{ "auto": true }`. EOBI and income tax follow the basic while they are not typed.
  - **Adj -> (loan):** `loans: [ { loanId, amount } ]` changes the instalment taken this month; it cannot be more than what is still owed (`422 LOAN_ADJUST_TOO_HIGH`, `details.balance`).
- **Computation tab:** `computation` is the list of steps `{ key, label, value, note }` from the basic pay to the balance.
- **Checklist / Checks:** `checks` = `[ { key, label, ok, message } ]`: attendance checked, holiday check, loan check, late policy applied, AL policy applied, net salary. Show a green tick or a red mark with the `message` ("Loan balance: Rs 0 / deducted: Rs 0", "AL balance: 3.0 / marked AL days: 2 / adjusted: 2.0").
- **Leaves tab:** `leave` (balance, marked AL days, paid AL days, unpaid AL days, the approved leave applications of the month). AL days over the balance are unpaid.
- **Payments tab:** `payments` (the salary payment vouchers of this payslip). **Loan / Advance tab:** `loans` with the loan balance; advance is not built.
- **Calculate** (`POST /slips/:id/calculate`) works the payslip out again from what it holds.
- Edits are refused outside Draft and Review: `422 SLIP_LOCKED` (final review and approved: send it back first) and `422 SLIP_SUSPENDED`.

## 8. Moving a payslip, suspending it
| Call | Who | What |
|---|---|---|
| `POST /slips/:id/review` | HR | Draft -> Review. `422 NET_NEGATIVE` when the net is below 0 (correct the deductions first), `422 NOT_DRAFT` |
| `POST /slips/:id/final-review` | reviewer | Review -> Final review (`422 NOT_IN_REVIEW`) |
| `POST /slips/:id/approve` | reviewer | Final review -> **Approved**: posts the accounts and takes the loan instalment (`422 NOT_IN_FINAL_REVIEW`, `NET_NEGATIVE`) |
| `POST /slips/:id/send-back` | reviewer | Review, Final review or Approved -> Draft. An approved payslip goes back only while nothing is paid and it is on no voucher (`422 SLIP_HAS_PAYMENTS`, `422 SLIP_IN_A_VOUCHER`); its entry is reversed and the loan instalment is given back |
| `POST /slips/:id/suspend` | HR | `{ "note": "why" }` (3 to 500 characters, required): the payslip is left out of the payroll (not counted in the totals) and shows under **Suspend**. `422 SLIP_APPROVED`, `ALREADY_SUSPENDED` |
| `POST /slips/:id/resume` | HR | Suspended -> Draft, calculated again with the attendance as it is now (the note stays in `suspendNote`). `422 NOT_SUSPENDED` |
| `DELETE /slips/:id` | HR | a payslip in Draft only (`422 SLIP_NOT_DRAFT`); `POST /runs/:id/add-employees` can make it again |
Use `canSendReview`, `canFinalReview`, `canApprove`, `canSendBack`, `canSuspend`, `canResume`, `canDelete`, `canEdit` for the buttons.

## 9. The accounts (what approving and paying do)
- **Approving a payslip** posts one journal entry dated the **last day of the payroll's month** (the expense belongs to the month): **Debit** Salaries & Wages = gross + additions; **Credit** Salaries Payable = net, Employee Loans = the loan instalment, EOBI Payable = EOBI, Income Tax Payable - Salaries = income tax, Other Employee Deductions = the others deduction. It balances by construction. A payslip with nothing to post makes no entry.
- It also writes the **loan instalment** against the loan (`payroll_loan_deductions`), so the loan's balance and its "Deducted in payroll" tab follow.
- **New default accounts** (Accounts > Default Accounts, group **Payroll**, also in the Chart of Accounts): `SALARY_EXPENSE` (Salaries & Wages), `SALARIES_PAYABLE`, `EOBI_PAYABLE`, `SALARY_TAX_PAYABLE`, `EMPLOYEE_DEDUCTIONS` (with `EMPLOYEE_LOANS` from the loans). Each is made by the first payroll that needs it, or earlier with the Create button of the tab. An account the company already has with a matching name ("Salaries", "Salaries Payable", "EOBI Payable" ...) is adopted instead of making a new one.
- **Salary Payment Voucher** (Accounts > Vouchers; service `ACC_PAYMENTS`), base `/api/v1/salary-payment-vouchers`: like the other vouchers (`GET /options`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/confirm`, `POST /:id/unconfirm`, `GET /:id/accounts-entry`).
  - `GET /slips?search=&runId=&month=2026-10&groupId=&method=BANK|CASH&limit=` is the **payslip picker**: approved payslips with salary still to pay: `{ data: [ { slipId, payslipId, employee: { code, label, name }, department, group, month, monthLabel, net, paid, toPay, method, bank } ], total, totalToPay }`. `toPay` counts draft vouchers too. Use `method` to pay the bank employees and the cash employees separately.
  - **Create:** `{ "payFromAccountId": "...", "paymentMode": "ONLINE", "voucherDate": "2026-11-02", "refNo": "...", "chequeNo": "...", "chequeDate": "...", "notes": "...", "lines": [ { "slipId": "...", "amount": 38787 } ] }`. `amount` is optional: the whole balance of the payslip. `paymentMode` is CASH, CHEQUE, ONLINE or PAY_ORDER. A payslip can be paid in more than one voucher but never above its net.
  - **A voucher:** `{ id, voucherNo, voucherLabel: "SPV-00001", voucherDate, payFrom, paymentMode, paymentModeText, chequeDate, chequeNo, refNo, notes, amount, employees, status, statusText, confirmedAt, confirmedBy, canEdit, canDelete, canConfirm, canUnconfirm, lines: [ { slipId, payslipId, employee, department, month, monthLabel, net, amount, slipStatus } ] }` (amounts are numbers, like the other vouchers).
  - **Confirm:** Debit Salaries Payable / Credit the bank or cash account; each payslip's `paid` grows. **Move to draft:** the entry is reversed and `paid` goes back. The payslip then shows `paymentStatus` UNPAID, PARTIAL or PAID.
  - Errors: `422 SLIP_NOT_APPROVED`, `AMOUNT_MORE_THAN_SALARY` (`details.remaining`), `NOTHING_TO_PAY`, `DUPLICATE_SLIP`, `NOT_BANK_OR_CASH`, `VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED`.

## 10. Errors (summary)
`400 VALIDATION_FAILED`; `403` (not enough access; only reviewers can approve / send back); `404 NOT_FOUND`; `422`: `PAYROLL_EXISTS`, `MONTH_IN_FUTURE`, `NO_EMPLOYEES`, `GROUP_INACTIVE`, `PAYROLL_HAS_APPROVED`, `HALF_DAY_NOT_MORE_THAN_LATE`, `SLIP_LOCKED`, `SLIP_SUSPENDED`, `SLIP_APPROVED`, `SLIP_NOT_DRAFT`, `NOT_DRAFT`, `NOT_IN_REVIEW`, `NOT_IN_FINAL_REVIEW`, `CANNOT_SEND_BACK`, `NET_NEGATIVE`, `NOT_SUSPENDED`, `ALREADY_SUSPENDED`, `NOT_A_DAY_OF_THE_SLIP`, `LOAN_ADJUST_TOO_HIGH`, `SLIP_HAS_PAYMENTS`, `SLIP_IN_A_VOUCHER`, `IN_USE` (deleting an employee card that has a payslip).

## 11. Build checklist
1. **Payroll > Salary > Payroll Summary:** the chips, the table of payrolls of the month, a month picker with previous / next, refresh, **Attendance** and **Create Payroll**.
2. **Payroll Sheet:** header and chips, the tabs with counts, the search boxes (name / ID, department), the policy line, the table with the columns of section 5, SELECT checkboxes with bulk Move, SAVE / DELETE / PRINT / POLICY / CSV / CLOSE.
3. **Policy modal** (section 6) with the class defaults table and the "make default" checkbox.
4. **Payslip screen** (section 7): header, tabs Main / Computation / Leaves / Payments / Loan-Advance, the attendance grid with day editing and **Get attendance**, B-Summary, additions and deductions, checks, Move to Review / Suspend (with a note box) / Delete.
5. **Accounts > Vouchers > Salary Payment Voucher:** list and form like the Payment Voucher, with the payslip picker; show `voucherLabel`.
6. **Default Accounts tab:** the five new roles appear by themselves in `GET /accounts/defaults` (group Payroll).
7. Test:
   - Create a payroll for a class: employees who are not confirmed are missing; a second payroll for the same class and month is refused.
   - Open a payslip: change a day to Absent (the net falls), then Get attendance (the original day and net come back).
   - Change the payroll policy's late limit: the late days become present.
   - Move one payslip Draft -> Review (HR) -> Final review -> Approved (reviewer); the loan balance falls and the journal entry appears; send it back and both are reversed.
   - Suspend a payslip with a note: the totals leave it out; resume it later.
   - Pay approved payslips with a salary payment voucher: paid and balance follow; move the voucher to draft and they go back.
