# Salary Increment (during the year) — Frontend Guide

Base URL `/api/v1/payroll`. Screens: the list (tabs Draft / Review / Final Review / Posted), the "List of employees (select)" box, "Upload CSV", and the increment page.

## Permissions
- Read (list, page, employee list): any payroll service (VIEW).
- HR: make, edit, delete, submit, withdraw, upload: `PAYROLL_APPLICATIONS` FULL.
- Approvers (client admin or a chosen approver, as for the joining application): final review, approve (post), send back, reject. The page JSON has the flags `canEdit, canDelete, canSubmit, canWithdraw, canFinalReview, canApprove, canSendBack, canReject` — use them to show buttons.

## Status (same numbers everywhere)
`DRAFT` 0 → `REVIEW` 1 → `FINAL_REVIEW` 2 → `APPROVED` 3 (shown as **Posted**). A rejection / send-back returns it to `DRAFT` with `rejectReason`.
Rules: one open increment (draft / review / final review) per employee; only a draft can be edited or deleted; Posting updates the employee master — **salary and food, mobile, maintenance**.

## 1. The list
`GET /increments?status=REVIEW&search=&groupId=&month=&page=&limit=`
- `status`: `DRAFT | REVIEW | FINAL_REVIEW | APPROVED` (the tabs). `search`: employee name, department, designation, CNIC, employee ID or application ID.
- Response: `{ data:[record], total, page, limit, counts:{draft, review, finalReview, posted}, cards:{records, totalIncrease, totalIncreaseAll} }`.
  - `counts` = the numbers on the tabs. `cards.records` = "RECORDS (REVIEW)". `cards.totalIncrease` = total increase of the **Salary** head (what the screen shows); `totalIncreaseAll` = of all four heads.
- Record (list columns): `id, appId ("00564"), employee:{id, code, emplId ("0550"), label, name, group:{id,name} (CLASS), department, designation}, monthCode ("022025" or null), currentSalary, newSalary, increase, statusText`. The **Open** button opens `GET /increments/:id`.
- Bulk buttons (ticked rows): see section 6.
- **CSV** button: `GET /increments/csv?status=...` → file download (`ID, EmployeeID, Name, Department, Class, Month, Current_Salary, New_Salary, Increase, Status`).

## 2. "Employee List" box (select)
`GET /increments/employees?groupId=&search=&page=&limit=` — tabs All / Factory / Outlet / Admin = `groupId` (get the groups from `GET /payroll/groups`). Search: name, CNIC, designation, department, employee ID.
Row: `{id, code, label, name, cnic, designation, department, group, salary, joiningDate, payrollAccount (Yes/No), hasOpenIncrement}`. Disable the checkbox when `hasOpenIncrement`.
**Add**: `POST /increments {employeeIds:[...], applicationDate?}` → 201 `{created, skipped:[{code, name, reason}], data:[record page]}`. A draft is made for each (new = current). `reason`: `OPEN_INCREMENT`, `EMPLOYEE_CLOSED`, `NOT_CONFIRMED`.

## 3. The increment page
`GET /increments/:id` returns everything:
```
{ id, appId, status, statusCode, statusText, posted,
  banner:{ tone:'success'|'warning'|'danger'|'info', title, text },          // "Approved — this increment has been posted…", "Waiting for approval — submitted to the approver (…). It can no longer be edited."
  employee:{ id, code, emplId, name, group, department, designation, joiningDate, service:"1y 4m", hasPhoto, photoUrl },   // photoUrl needs the token: fetch as blob
  applicationDate, effectiveMonth ("2026-11" | null), monthCode ("112026" | null), monthLabel,
  heads:[ {key:'salary'|'food'|'mobile'|'maintenance', label:'Salary'|'Food'|'Mobile'|'Maint', current, increase, final} ],   // the HEADS / CURRENT / INC / FINAL table
  total:{ current, increase, final }, percent: 5,                                // the red "5.00%" = total increase / total current
  remarks, rejectReason, flow:[ {step:1,title:'Creator',text:'Submit for approval',by,done}, {step:2,title:'Approver',text:'rehan.ahmed',approvers:[...],by,current,done}, {step:3,title:'Posted',text:'Profile Updated',done} ],
  salaryHistory:[ {date, last, increase, new, status:3, totalLast, totalIncrease, totalNew, effectiveMonth} ],   // "Salary / Increment History"
  loanHistory:[ {date, amount, balance} ],                                          // "Loan History"
  donationHistory:[],                                                               // "Donation (Zakat / Charity) History": not built yet, always []
  canEdit, canDelete, canSubmit, canWithdraw, canFinalReview, canApprove, canSendBack, canReject, ... }
```
- **Current** is read live from the employee master until the increment is posted (a posted one keeps the figures it had).
- Edit a draft: `PATCH /increments/:id` with any of: `salary, food, mobile, maintenance` (the FINAL figure) **or** `salaryIncrease, foodIncrease, mobileIncrease, maintenanceIncrease` (the INC column) — not both for the same head (422 `FINAL_OR_INCREASE`); `remarks`, `applicationDate` (the "Date"), `effectiveMonth` ("YYYY-MM" or null = the "Month"). A figure below the current one → 422 `BELOW_CURRENT`. The response is the whole page again (recompute the table from it; the % too).
- `DELETE /increments/:id` (draft only, 204).

## 4. Steps (buttons)
| Button | Call | Who | From → To |
|---|---|---|---|
| Submit | `POST /increments/:id/submit` | HR | DRAFT → REVIEW (422 `NO_INCREASE` if nothing is raised) |
| Withdraw | `POST /increments/:id/withdraw` | HR | REVIEW → DRAFT |
| Final review | `POST /increments/:id/final-review` | approver | REVIEW → FINAL_REVIEW |
| Approve (post) | `POST /increments/:id/approve` | approver | REVIEW or FINAL_REVIEW → APPROVED, employee master updated |
| Send back | `POST /increments/:id/send-back` | approver | → DRAFT |
| Reject | `POST /increments/:id/reject {reason}` (reason required) | approver | → DRAFT, shows `rejectReason` |
Each returns the page JSON. Errors: 422 `WRONG_STATUS`, `INCREMENT_LOCKED` (editing a non-draft), `BELOW_CURRENT` / `NO_INCREASE` (the master changed meanwhile: send it back and correct it), `EMPLOYEE_CLOSED`; 403 for a user who is not an approver.

## 5. Upload CSV
Columns: **EmployeeID, New_Salary, month_code, Remarks** (`month_code` = MMYYYY e.g. `112026`, optional; `2026-11` is also accepted). Parse the file in the browser and send:
`POST /increments/import {rows:[{employeeId, newSalary, monthCode, remarks}], dryRun?, applicationDate?}`
- Show a preview first with `dryRun:true`, then send again without it. Drafts are made (Source = CSV); the current salary is read live.
- Response: `{dryRun, total, created, skipped, counts, results:[{row, employeeId, newSalary, employee?:{code,name,currentSalary}, status, id?, appId?}]}`.
- Row `status`: `CREATED, NO_ID, NOT_FOUND, DUPLICATE_IN_FILE, EMPLOYEE_CLOSED, NOT_CONFIRMED, INVALID_SALARY, INVALID_MONTH, INVALID_REMARKS, OPEN_INCREMENT` (skipped: increment already open this cycle), `NOT_HIGHER` (skipped: New_Salary not higher than the current salary).
- **Sample CSV** button: `GET /increments/sample.csv` (file download).

## 6. Bulk (ticked rows)
`POST /increments/bulk/{submit|withdraw|final-review|approve|send-back}` body `{ids:[...]}`; `POST /increments/bulk/reject` body `{ids, reason}`.
Response `{done, failed, results:[{id, ok, code?, message?}]}` — show the failed rows with their message.

## 7. Effect on the payroll
Posting changes the employee master. If `effectiveMonth` is set, a payroll of an **earlier** month made after the posting still uses the old figures. Payslips already made are never changed.

## Downloads need the token
`/increments/csv` and `/increments/sample.csv` are files and the photo is an image: fetch with `Authorization: Bearer <token>` as a blob and use `URL.createObjectURL`.

## Not built
Donation (Zakat / Charity) history (always `[]`), the annual increment sheet.
