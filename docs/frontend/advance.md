# Advance (employee advance) — Frontend Guide

## What it is, in one minute
An employee asks for an **advance** (for example 5,000). There is **no approval**:
1. **HR** writes it down: *Payroll > Applications > Advance* (employee, amount, date, remarks). The form also shows the employee's **loan history** (finished or not, what is left) so HR sees what he already owes.
2. The **accountant** pays it: *Accounting > Payments > a voucher with purpose "Advance"* (the **Employee Advance Voucher**): picks the advance, the bank / cash account, saves and confirms. The accounting entry is Debit **Employee Advances**, Credit Bank / Cash.
3. The **payroll** takes the **whole amount** from the employee's salary: the payroll of the advance's month (or the first payroll made after it). It appears on the payslip as **Advance** in the deductions, and when the payslip is approved the advance is closed ("Recovered").

An advance is deducted only after its voucher is **confirmed** (the money must really have been paid). Until then it shows **Waiting for voucher**.

## Status of an advance (worked out by the server, never typed)
| `status` | `statusText` | meaning |
|---|---|---|
| `WAITING_VOUCHER` | Waiting for voucher | written down, no confirmed voucher yet (a draft voucher does not count) |
| `PAID` | Paid, to be taken from the salary | voucher confirmed, the payroll has not taken it yet |
| `RECOVERED` | Recovered from the salary | the payroll took it (the payslip is approved); `recoveredMonth` says which month |

## Permissions
- Read: any payroll service (VIEW).
- Write (create / change / delete): `PAYROLL_APPLICATIONS` FULL (the same HR user as the other applications). No approver needed.
- Voucher: `ACC_PAYMENTS` (same as the loan voucher and the salary voucher).

---
## A. Payroll > Applications > Advance (HR)
Base URL `/api/v1/payroll`.

### A1. The list (tabs and cards)
`GET /advances?status=&search=&employeeId=&departmentId=&groupId=&from=&to=&page=&limit=`
- `status`: `WAITING_VOUCHER | PAID | RECOVERED` (the tabs). `search`: employee name, CNIC, employee ID, advance number, department, remarks. `from` / `to`: the advance date (`YYYY-MM-DD`).
- Response `{ data:[advance], page, limit, total, totals:{ amount } }`.
- `GET /advances/summary` → `{ total, waitingVoucher, paid, recovered, amount, toRecover }` for the tab badges and cards (`toRecover` = paid out and not yet taken from salaries).

Advance object (list and page):
```
{ id, code, appId:"00001", label:"ADV-00001",
  employee:{ id, code, label, name, cnic, group, department, designation, salary, isClosed },
  advanceDate, amount:"5000.00", remarks,
  status, statusText, paid:true|false, recovered:"0.00", toRecover:"5000.00", recoveredMonth:"2026-10"|null,
  voucher:{ id, voucherNo, voucherLabel:"EAV-00001", status:"DRAFT"|"CONFIRMED" } | null,
  createdBy, createdAt, updatedAt,
  canEdit, canDelete,      // true only while there is no voucher and nothing recovered
  canPay }                 // true while there is no voucher: show "Make voucher" (opens the accounting voucher)
```

### A2. The form (new advance)
1. The user picks the **employee** (dropdown from `GET /payroll/employees`).
2. Call `GET /advances/employee/:employeeId`. It fills the right side of the form:
```
{ employee:{ id, code, label, name, cnic, group, department, designation, salary, salaryType, paymentMethod, isClosed, isConfirmed },
  loans:[{ id, appId, label, applicationDate, approved, months, deductFrom, emi, paid, deducted, balance, toPay,
           isFinished, statusText:"Running"|"Finished"|"Not paid out yet" }],      // the LOAN HISTORY: only approved loans
  loanSummary:{ count, running, balance },                                         // balance = what he still owes on loans
  advances:[{ id, appId, label, advanceDate, amount, status, statusText, recoveredMonth }],   // his earlier advances (newest first)
  advanceSummary:{ pending, count } }                                              // advances not yet taken from his salary
```
Show: a **Loan history** table (loan, amount, instalments, paid, deducted, **balance**, a badge "Finished" or "Running"), a "Still owes on loans: X" line, and a note "Advances not yet taken from the salary: X".
3. The user types **Amount** and (optionally) **Date** (default today) and **Remarks**, and presses Save.

### A3. Create / change / delete
- `POST /advances` body `{ employeeId, amount, advanceDate?, remarks? }` → **201** advance. `amount` is a number or a string with at most 2 decimals, more than 0 (`"5000"`, `5000.5`).
- `PATCH /advances/:id` body any of `{ amount, advanceDate, remarks }` → advance.
- `DELETE /advances/:id` → 204.
- Errors (422): `EMPLOYEE_CLOSED`, `EMPLOYEE_NOT_CONFIRMED`, `BEFORE_JOINING` (the date is before the joining date), `ADVANCE_HAS_VOUCHER` (a voucher exists: change / delete the voucher first), `ADVANCE_RECOVERED`. 400 for a wrong amount (0, negative, more than 2 decimals).

---
## B. Accounting: the Advance voucher
Base URL `/api/v1/employee-advance-vouchers` (same shape and buttons as the Employee Loan Voucher).

On the voucher screen the accountant chooses the **purpose** of the voucher: *Loan* (`/employee-loan-vouchers`) or **Advance** (`/employee-advance-vouchers`). Show the Advance form when "Advance" is selected.

| Call | Purpose |
|---|---|
| `GET /options` | `{ purpose:"ADVANCE", modes, statuses, payFromAccounts }` (bank and cash accounts for "Pay from") |
| `GET /advances?search=&limit=` | the **advance picker**: advances nobody has made a voucher for: `{ data:[{ advanceId, appId, label, employee:{id,code,name,cnic}, amount, toPay, advanceDate, remarks }], total }` |
| `GET /?status=&dateFrom=&dateTo=&advanceId=&employeeId=&search=&page=&limit=` | the voucher list `{ data, page, limit, total, summary:{ vouchers, amount, confirmed } }` |
| `POST /` | create (DRAFT) |
| `GET /:id`, `PATCH /:id`, `DELETE /:id` | read / change / delete a DRAFT voucher |
| `POST /:id/confirm` | post the accounting entry (CONFIRMED) |
| `POST /:id/unconfirm` `{ reason? }` | move to draft (the entry is reversed) |
| `GET /:id/accounts-entry` | the journal entry of the voucher |

Create body: `{ advanceId, payFromAccountId, paymentMode ("CASH"|"CHEQUE"|"ONLINE"|"PAY_ORDER"), voucherDate?, chequeDate?, chequeNo?, refNo?, notes?, amount? }`.
- The **amount is the advance's amount** (the whole advance, one voucher). Show it read-only after the advance is picked. `amount` may be left out; if sent it must be equal.
- Voucher object: `{ id, voucherNo, voucherLabel:"EAV-00001", voucherDate, purpose:"ADVANCE", advance:{ id, appId, label, amount, advanceDate }, employee:{ id, code, name, cnic }, payFrom:{...}, paymentMode, paymentModeText, chequeDate, chequeNo, refNo, notes, amount, status:"DRAFT"|"CONFIRMED", statusText, confirmedAt, confirmedBy, canEdit, canDelete, canConfirm, canUnconfirm }`.
- Errors (422): `ADVANCE_ALREADY_PAID` (the advance already has a voucher), `AMOUNT_NOT_ADVANCE`, `VOUCHER_BEFORE_ADVANCE` (voucher date before the advance date), `ADVANCE_ALREADY_RECOVERED` (unconfirm after the payroll took it), `VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED`.
- The voucher is also a "kind" in the party / ledger filters: `EMPLOYEE_ADVANCE_VOUCHER`.
- A new default account **Employee Advances** (Accounting > Default accounts, group Payroll, key `EMPLOYEE_ADVANCES`) is created by the first voucher.

---
## C. On the payslip, salary sheet and reports
- **Payslip JSON** (`GET /payroll/slips/:id`, the list, the run's slips): `deductions.advance` ("5000.00") next to `deductions.loan`; `deductions.total` includes it. The slip detail has `advances:[{ advanceId, appId, label, advanceDate, advanceAmount, due, amount }]` (which advances are taken). Show an **Advance** line in the deductions box (and "ADV-00001" with its date under it).
- **HR can take less** on the payslip (while Draft / Review): `PATCH /payroll/slips/:id` with `{ "advances": [{ "advanceId": "...", "amount": 3000 }] }`; more than `due` gives 422 `ADVANCE_ADJUST_TOO_HIGH`. The part left stays an open advance for the next payroll.
- **Salary Sheet** (JSON and Excel): a new column **Advance** (`advance`) and `totals.advance`. **Payslip PDF**: an **Advance** line in the deductions.
- **When is an advance picked up?** When a payroll (or the payslip's "Get attendance") is made, every advance dated up to that month with a **confirmed** voucher and not yet recovered is taken in full. An advance whose voucher is confirmed after the payroll was made is picked up when HR presses "Get attendance" on the payslip, or in the next payroll.
- **Approving the payslip** closes the advances on it (status Recovered, month) and posts Credit **Employee Advances** in the payslip's accounting entry. **Sending an approved payslip back to Draft** gives the advance back (status Paid again).

## Not built
An advance report page (the list with the tabs is the report), a limit on how much advance one employee can take, taking an advance in instalments (it is always taken in full from the next payroll).

## Database
Migration `20261125000001-employee-advances.js` (tables `payroll_advances`, `employee_advance_vouchers`, `payroll_advance_deductions`, `payroll_slip_advances`, column `payroll_slips.advanceAmount`, account role `EMPLOYEE_ADVANCES`). Run `npm run db:migrate`.
