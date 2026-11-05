# Employee Loan Applications and the Employee Loan Voucher: frontend guide (chunk 8)

## 1. How it works
**Payroll side (HR and the reviewer)**
- HR makes a loan application for a working employee (Payroll > Applications > **Employee Loan Applications**): the amount, the number of monthly instalments (**1 to 12**) and the **month the deduction starts**. It goes **Draft -> In review -> Approved**, or **Rejected**.
- The loan can **never be more than the employee's current (basic) salary**. The check runs when saving, sending and approving (with the salary of that day).
- The reviewer (a client admin or a person chosen under **Approval Roles**) can change the **approved amount** (not above the applied amount), the instalments and the first month, then approve or reject. HR cannot approve.
- The instalments (EMI) are worked out by the server from the approved amount, the months and the first month. Each is the amount / months rounded to the whole rupee and the last one takes the difference, so they add up exactly: 50,000 over 3 months = 16,667 + 16,667 + 16,666. The **payroll** will take one instalment from the salary of each month from the first month on (the payroll run is not built yet; until then nothing is deducted).
- **Approving does not pay anything.** The money is paid out by an **Employee Loan Voucher** in the accounting module.

**Accounts side (the accountant)**
- **New voucher type "Employee Loan Voucher"** (Accounts > Vouchers). It pays an approved loan from a **bank or cash** account. It can pay the loan **in more than one voucher** (for example 10,000 now and 15,000 later); together they can never be more than the approved amount.
- **Posting (when the voucher is confirmed):** Debit **Employee Loans** / Credit the bank or cash account. Un-confirming ("move to draft") posts the reverse entry, as for the other vouchers.
- **New default account "Employee Loans"** (an asset: what employees owe the company). It appears in **Accounts > Default Accounts** (new group **Payroll**) and in the **Chart of Accounts** as a system account. It is made automatically when the first loan voucher is saved, or earlier with the "Create" button of the Default Accounts tab. An existing account called "Employee Loans" / "Staff Loans" is adopted instead of making a new one.
- **Loan balance** = what the confirmed vouchers paid less what the payroll deducted. A loan that is approved but not yet paid has balance 0: the employee owes nothing until the money is paid.

## 2. Access
- **Payroll side**, base `/api/v1/payroll/loans`: read = any payroll service; create / edit / delete / send / withdraw / re-open / attachments = `PAYROLL_APPLICATIONS` FULL (HR); review / approve / reject = a client admin or a chosen approver (`403` for others).
- **Accounts side**, base `/api/v1/employee-loan-vouchers`: the **Payment Vouchers** service `ACC_PAYMENTS` (VIEW reads, FULL adds / edits / deletes / confirms). HR cannot pay and the accountant cannot make applications.
- Another company's record = `404`.

## 3. The application as the server answers it (detail screen)
```json
{ "id": "...", "code": 384, "appId": "00384", "label": "Application # 384", "status": "APPROVED", "statusText": "Approved",
  "employee": { "id": "...", "code": 514, "label": "00514", "name": "MUHAMMAD FAIZAN", "fatherName": "SHAHID ULLAH", "cnic": "42301-2879331-5",
    "group": { "id": "...", "name": "Admin" }, "department": { "id": "...", "name": "Administration" }, "designation": "Clerk", "joiningDate": "2025-08-12", "service": "1y 2m",
    "salary": "42000.00", "currentLoan": "50000.00", "currentAdvance": "0.00", "hasPhoto": true, "isClosed": false },
  "applicationDate": "2026-10-29", "applied": "50000.00", "approved": "50000.00", "months": 3, "deductFrom": "2026-11", "deductFromCode": "112026", "emi": "16667.00", "remarks": null,
  "paid": "50000.00", "deducted": "0.00", "balance": "50000.00", "toPay": "0.00", "draftPayments": "0.00", "salaryAtApproval": "42000.00",
  "schedule": { "total": "50000.00", "rows": [ { "month": "2026-11", "label": "NOV-2026", "emi": "16667.00" }, { "month": "2026-12", "label": "DEC-2026", "emi": "16667.00" }, { "month": "2027-01", "label": "JAN-2027", "emi": "16666.00" } ] },
  "previousLoans": [ { "id": "...", "appId": "00304", "date": "2026-05-23", "applied": "20000.00", "balance": "0.00", "status": "REJECTED", "statusText": "Rejected" } ],
  "payments": [ { "voucherId": "...", "voucherNo": 418, "voucherLabel": "ELV-00418", "date": "2026-10-29", "paidFrom": { "id": "...", "code": "1102", "name": "Meezan Bank CA-8351" }, "refNo": "11934", "remarks": null, "amount": "50000.00", "status": "CONFIRMED", "statusText": "Confirmed" } ],
  "deductions": [ { "id": "...", "month": "2026-11", "amount": "16667.00", "source": "PAYROLL", "payrollId": null } ],
  "attachments": [ { "key": "ATT_1a2b3c4d5e", "fileName": "guarantee.jpg", "mimeType": "image/jpeg", "size": 20311, "uploadedAt": "..." } ],
  "submittedAt": "...", "submittedBy": "haris", "approval": { "by": "haris", "at": "..." },
  "canEdit": false, "canDelete": false, "canSubmit": false, "canWithdraw": false, "canReopen": false, "canReviewEdit": false, "canApprove": false, "canReject": false, "canPay": false }
```
- **Money** is a string with 2 decimals. `approved` is `null` until the reviewer sets it or approves. `deductFrom` is `"YYYY-MM"` (the month picker); `deductFromCode` is the same as `MMYYYY` ("112026") for the read-only field of the design.
- **Employee box:** photo (`GET /payroll/employees/:id/files/photo` with the bearer token, only when `hasPhoto`), CNIC, father's name, **Salary (current)**, joining date with `service`, **Current loan** (what the employee owes on his loans now: paid less deducted, over all his approved loans), **Current advance** (always `"0.00"` until the advance application exists). Header line: "Application # 384 . {department} department" from `label` and `employee.department`.
- **EMI schedule box:** `schedule.rows` (label, emi) and `schedule.total`. For a draft or in review it follows the applied amount (the approved one once the reviewer sets it).
- **Loan paid / Deducted in payroll / Balance** cards: `paid`, `deducted`, `balance`. Tabs "Payments against the loan (n)" from `payments` (with an **Open voucher** link to the voucher screen) and "Deducted in payroll (n)" from `deductions`.
- **Previous loans** (last 10 of the employee, not this one): `previousLoans`. **Attachments (n)**: `attachments`.
- Buttons from the flags. HR: `canEdit`, `canDelete`, `canSubmit`, `canWithdraw` (in review), `canReopen` (rejected). Reviewer: `canReviewEdit`, `canApprove`, `canReject` (only while in review). Accountant link: **Pay this loan** when `canPay` is true (opens a new loan voucher with this loan filled in).

## 4. Payroll calls (`/api/v1/payroll/loans`)
| Call | Who | What |
|---|---|---|
| `GET /loans?search=&status=&departmentId=&groupId=&employeeId=&from=&to=&balanceOnly=&page=&limit=` | read | `{ data, page, limit, total, totals: { applied, approved, balance } }`, newest first. `search`: employee name, CNIC, department, remarks, or a number (application ID or employee ID). `from` / `to` are the application date (the two date boxes of the list). `balanceOnly=true` is the **Balance** tab / the "Balance only" checkbox. List rows have the columns of the design: `appId`, `applicationDate`, `employee` (name, code, cnic), `employee.department`, `employee.group` (the **Bucket**), `deductFromCode`, `months`, `applied`, `approved` |
| `GET /loans/summary` | read | `{ total, draft, inReview, rejected, approved, balance }` for the tabs Applications / Draft / Review / Rejected / Balance |
| `POST /loans` | HR | 201. Body below |
| `GET /loans/:id` | read | the detail above |
| `PATCH /loans/:id` | HR | change a draft: `applicationDate`, `appliedAmount`, `months`, `deductFrom`, `remarks` (the employee cannot be changed: delete and make a new one) |
| `DELETE /loans/:id` | HR | a draft only; 204 |
| `POST /loans/:id/submit`, `/withdraw` | HR | send for review / take it back to draft |
| `PATCH /loans/:id/review` | reviewer | while in review: `approvedAmount`, `months`, `deductFrom`, `remarks` (at least one) |
| `POST /loans/:id/approve` | reviewer | approve (the applied amount is approved when the reviewer set none) |
| `POST /loans/:id/reject` | reviewer | `{ "reason": "..." }` (3 to 500 characters, required) |
| `POST /loans/:id/reopen` | HR | rejected back to draft |
| `POST /loans/:id/attachments` | HR | add a document (draft only): the **raw file as the body** with `Content-Type` image/jpeg, image/png or application/pdf, up to 2 MB, name in the `X-File-Name` header; at most **5** per application. Returns the application |
| `GET /loans/:id/attachments/:key` | read | download (bearer token; use a blob URL) |
| `DELETE /loans/:id/attachments/:key` | HR | remove one (draft only); returns the application |

**Create body:** `{ "employeeId": "...", "appliedAmount": 50000, "months": 3, "deductFrom": "2026-11", "applicationDate": "2026-10-29", "remarks": "..." }`. Required: `employeeId`, `appliedAmount`, `months` (1 to 12), `deductFrom`. `applicationDate` is today when not sent and cannot be in the future. Amounts are numbers or strings with at most 2 decimals. Show a **months** dropdown 1 to 12 and a **month** picker for "Deduct from". Show the EMI schedule live in the form as the user types (amount / months, last one takes the difference) or call the detail after saving.

## 5. Employee Loan Voucher calls (`/api/v1/employee-loan-vouchers`)
Like the other vouchers: `GET /options`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/confirm`, `POST /:id/unconfirm` (body `{ reason? }`), `GET /:id/accounts-entry`.
- `GET /options` returns `{ modes, statuses, payFromAccounts }` (the bank and cash accounts of the Chart).
- `GET /loans?search=&limit=` returns the **loan picker**: `{ data: [ { loanId, appId, employee: { id, code, name, cnic }, approved, paid, toPay, months, deductFrom } ], total }`: approved loans that still have something to pay out (`toPay` counts draft vouchers too).
- `GET /?status=&dateFrom=&dateTo=&loanId=&employeeId=&search=&page=&limit=` returns `{ data, page, limit, total, summary: { vouchers, amount, confirmed } }`.
- **Create:** `{ "loanId": "...", "payFromAccountId": "...", "paymentMode": "ONLINE", "amount": 50000, "voucherDate": "2026-10-29", "refNo": "11934", "chequeNo": "...", "chequeDate": "...", "notes": "..." }`. Required: `loanId`, `payFromAccountId`, `paymentMode` (`CASH`, `CHEQUE`, `ONLINE`, `PAY_ORDER`), `amount`. `voucherDate` is today when not sent.
- **A voucher:** `{ id, voucherNo, voucherLabel: "ELV-00418", voucherDate, loan: { id, appId, status, approved, applicationDate }, employee: { id, code, name, cnic }, payFrom: { id, code, name, controlType }, paymentMode, paymentModeText, chequeDate, chequeNo, refNo, notes, amount, status, statusText, confirmedAt, confirmedBy, canEdit, canDelete, canConfirm, canUnconfirm, createdAt, updatedAt }`. Amounts on vouchers are numbers (like the other vouchers).
- `GET /:id/accounts-entry` shows the journal entry: `{ posted, current: { lines: [ { account, debit, credit } ] }, entries }`. The entry names no customer or vendor (the employee is not a party): the voucher and the loan are the link.
- The journal entries list / ledger now know the source `EMPLOYEE_LOAN_VOUCHER` (filter `kind=EMPLOYEE_LOAN_VOUCHER`).

## 6. Errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | months not 1 to 12, a bad month or amount, an unknown field |
| `403` | not enough access (HR cannot approve or pay, the accountant cannot make applications) |
| `404 NOT_FOUND` | unknown application, employee, voucher, loan or file, or of another company |
| `422 LOAN_MORE_THAN_SALARY` | the applied or approved amount is more than the salary; `details: { salary, amount }` |
| `422 APPROVED_MORE_THAN_APPLIED` | the reviewer approved more than was applied |
| `422 LOAN_TOO_SMALL_FOR_PERIOD` | each instalment would be under Rs 1 |
| `422 DEDUCT_FROM_BEFORE_APPLICATION` | the first month is before the month of the application |
| `422 DATE_IN_FUTURE` | the application date is in the future |
| `422 EMPLOYEE_CLOSED` | the employee has left |
| `422 LOAN_APPLICATION_OPEN` | the employee already has a draft / in review application (`details.code`); also when re-opening a rejected one while another is open |
| `422 LOAN_IN_REVIEW`, `LOAN_CLOSED` | edit / delete / attach while in review, or an approved / rejected application (re-open a rejected one first) |
| `422 ALREADY_IN_REVIEW`, `NOT_IN_REVIEW`, `NOT_REJECTED` | the action does not fit the status |
| `422 FILE_TYPE`, `FILE_TOO_LARGE`, `NO_FILE`, `TOO_MANY_FILES` | attachments |
| `422 LOAN_NOT_APPROVED` | a voucher for a loan that is not approved |
| `422 AMOUNT_MORE_THAN_LOAN` | the voucher is more than what is left to pay out; `details: { approved, alreadyPaid, remaining }` |
| `422 VOUCHER_BEFORE_APPLICATION` | the voucher is dated before the application |
| `422 NOT_BANK_OR_CASH`, `ACCOUNT_INACTIVE`, `BAD_AMOUNT` | the pay-from account or the amount is not valid |
| `422 VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED` | the action does not fit the voucher status |
| `422 LOAN_ALREADY_DEDUCTED` | un-confirming a voucher after the payroll recovered more than what would stay paid out |
| `422 IN_USE` | deleting an employee card that has a loan application |

## 7. Build checklist
1. **Payroll > Applications > Employee Loan Applications** list: search box, two date boxes (default the last 12 months), "Balance only" checkbox, refresh, PDF and Excel export (built in the frontend from the list), **New**. Tabs **Applications / Draft / Review / Rejected / Balance** with the counts of `summary`. Columns: ID, Date, Employee (name and code, CNIC under it), Department, Bucket, Deduct from, Period (`months` + " mo"), Applied, Approved. **Open** opens the application.
2. **Application screen** as in the design: employee picker, application date, the employee box, Loan applied, Loan approved, Deduct from, EMI period, Remarks; EMI schedule box; Previous loans box; Payments and deductions cards and tabs; Attachments button with its count. Buttons: Save, Delete, Send for review, Withdraw, Close; for the reviewer Approve, Reject (asks for a reason) and a Save for the review changes (`PATCH /review`). Loan approved is editable only by the reviewer while in review.
3. **Accounts > Vouchers > Employee Loan Voucher**: list and form like the Payment Voucher (loan picker from `GET /loans`, pay-from account, mode, date, ref #, remarks, amount), Confirm / Move to draft, Accounts entry. Show the voucher number as `voucherLabel`.
4. **Default Accounts tab:** the new role **Employee Loans** (group **Payroll**) appears by itself in `GET /accounts/defaults` with the other roles; the "missing" count includes it until the account exists.
5. Test:
   - A loan above the salary is refused; 50,000 over 3 months from 2026-11 shows 16,667 / 16,667 / 16,666.
   - HR sends it; the reviewer approves a smaller amount and the schedule changes.
   - The accountant makes a voucher for part of it and confirms: the loan shows paid, balance and the voucher; the Employee Loans account appears in the Chart and in Default Accounts.
   - A second voucher above what is left is refused; the Balance tab counts the loan.
