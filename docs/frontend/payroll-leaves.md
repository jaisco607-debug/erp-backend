# Leave Applications and the Annual Leaves report: frontend guide (chunk 9)

## 1. How it works
**Leave balance (annual leave).** It comes from the **policy of the employee's group** (Master Card > Payroll Policy): `leaveEarnedPerMonth` (default 2), `maxLeavePerYear` (default 24) and `monthsBeforeLeave` (default 6).
- The employee **earns nothing until he has served `monthsBeforeLeave` months** (joining date + those months).
- From then on the leave of one month is **credited on the 1st of every month**. In one calendar year he can never be credited more than `maxLeavePerYear`.
- **Unused leave carries on** to the next year (the balance is not reset in January).
- The policy of each month decides, so a policy change from a month on applies from that month.
- Nothing is credited after the month the employee left.
- Example (defaults): joined 2025-01-10, eligible from 2025-07-10, first credit 2025-08-01. By 2026-10-05 he has 10 (2025) + 20 (Jan to Oct 2026) = 30 days.

**Leave application** (Payroll > Applications > **Leave Applications**). Annual leave is the only type: it is paid and comes out of the balance.
- HR makes the application: employee, **from date**, **to date**, reason. The server counts **working days only**: the **weekly off day** of the policy and the **holidays** of the employee's group inside the dates are **not** taken from the balance (shown as `restDays` with the reason).
- Draft -> In review -> Approved (or Rejected), like the other applications. The reviewer is a client admin or a person under Approval Roles. HR cannot approve.
- The balance is checked when HR **sends** the application and again when the reviewer **approves** (`LEAVE_BALANCE_LOW`). Leave already approved, or waiting in review, is **reserved**, so two applications cannot both use the same days.
- An employee cannot have two leave applications (draft, in review or approved) that overlap in dates.
- The reviewer can correct the dates and the reason of an application in review (the days are counted again).
- **Approved leave shows as `AL` in the attendance** on the days nobody punched on (also for dates still to come, when that day arrives). Someone who comes to work on a day of leave keeps the code of the day he worked.
- The reviewer can **cancel** an approved leave (reason required): the days go back to the balance and the AL days of the attendance are worked out again.
- A leave can be dated in the past (HR records it afterwards); the application date cannot be in the future.

**Annual Leaves report** (Reports > **Annual Leaves**): for a year, every employee's leave **carried from the years before, earned this year, taken, waiting in review and what is left**; and one employee's statement month by month.

## 2. Access
Base URL `/api/v1/payroll`. Read (leaves, preview, balance, reports): any payroll service. Create / edit / delete / send / withdraw / re-open: `PAYROLL_APPLICATIONS` FULL (HR). Review / approve / reject / cancel: a client admin or a chosen approver (`403` for others). Another company's record = `404`.

## 3. A leave application as the server answers it
```json
{ "id": "...", "code": 12, "appId": "00012", "label": "LV-0012", "status": "IN_REVIEW", "statusText": "In review",
  "employee": { "id": "...", "code": 101, "label": "00101", "name": "VETERAN ALI", "fatherName": null, "cnic": null, "group": { "id": "...", "name": "Factory" },
    "department": { "id": "...", "name": "Dishwash" }, "designation": "Worker", "joiningDate": "2025-01-10", "hasPhoto": false, "isClosed": false },
  "leaveType": "ANNUAL", "leaveTypeText": "Annual leave", "applicationDate": "2026-10-02", "fromDate": "2026-10-05", "toDate": "2026-10-11", "days": 6,
  "dates": ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"],
  "restDays": [ { "date": "2026-10-11", "reason": "Weekly off" } ],
  "reason": "Family function",
  "balance": { "earned": 30, "taken": 0, "pending": 0, "available": 30, "eligibleFrom": "2025-07-10", "asOf": "2026-10-05", "enough": true, "requested": 6 },
  "previousLeaves": [ { "id": "...", "appId": "00003", "fromDate": "2026-03-02", "toDate": "2026-03-04", "days": 3, "reason": "...", "status": "APPROVED", "statusText": "Approved" } ],
  "submittedAt": "...", "submittedBy": "haris", "approval": null,
  "canEdit": false, "canDelete": false, "canSubmit": false, "canWithdraw": true, "canReopen": false, "canReviewEdit": true, "canApprove": true, "canReject": true, "canCancel": false }
```
- `days` is the number of working days; `dates` are those days (for an approved or cancelled leave, the days kept when it was approved). `restDays` are the days inside the dates that are not counted.
- `balance` is the employee's annual leave **on the first day of the leave**: `earned` (credited so far), `taken` (approved), `pending` (other applications in review), `available` = earned - taken - pending, `eligibleFrom` (the date he starts earning). `enough` is `false` when `available` is less than `requested` (show a red warning; the server refuses to send / approve it).
- `approval`: `null` for draft and in review; approved `{ by, at }`; rejected `{ by, at, reason }`; cancelled `{ by, at, reason, approvedBy }`.
- Buttons from the flags. HR: `canEdit`, `canDelete`, `canSubmit`, `canWithdraw` (in review), `canReopen` (rejected). Reviewer: `canReviewEdit`, `canApprove`, `canReject` (in review), `canCancel` (approved).

## 4. Calls (`/api/v1/payroll`)
| Call | Who | What |
|---|---|---|
| `GET /leaves?search=&status=&departmentId=&groupId=&employeeId=&from=&to=&page=&limit=` | read | `{ data, page, limit, total }`, newest first. `search`: employee name, CNIC, department, reason, or a number (application ID or employee ID). `from` / `to` are the application date. List rows have the same fields as the detail without `balance`, `dates`, `restDays` and `previousLeaves` |
| `GET /leaves/summary` | read | `{ total, draft, inReview, approved, rejected, cancelled }` for the tabs |
| `GET /leaves/preview?employeeId=&fromDate=&toDate=&exceptId=` | read | **for the form, before saving**: `{ days, dates, restDays, balance: { earned, taken, pending, available, eligibleFrom }, enough }`. Call it when the employee or the dates change and show "6 working days, 1 rest day (Sunday), 30 available" |
| `GET /leaves/balance?employeeId=&date=` | read | the leave balance of an employee on a day (today by default): `{ employee, asOf, earned, taken, pending, available, byYear: [{ year, credited, earned }], policy: { leaveEarnedPerMonth, maxLeavePerYear, monthsBeforeLeave }, eligibleFrom }`. For the employee card / the picker |
| `POST /leaves` | HR | 201: `{ employeeId, fromDate, toDate, reason, applicationDate? }` (`reason` 3 to 500 characters; `applicationDate` is today when not sent) |
| `GET /leaves/:id` | read | the detail above |
| `PATCH /leaves/:id` | HR | a draft only: `applicationDate`, `fromDate`, `toDate`, `reason` (at least one) |
| `DELETE /leaves/:id` | HR | a draft only; 204 |
| `POST /leaves/:id/submit`, `/withdraw`, `/reopen` | HR | send for review (checks the balance) / take it back / rejected back to draft |
| `PATCH /leaves/:id/review` | reviewer | while in review: `fromDate`, `toDate`, `reason` |
| `POST /leaves/:id/approve` | reviewer | approve (days counted again, balance checked again) |
| `POST /leaves/:id/reject` | reviewer | `{ "reason": "..." }` (3 to 500 characters, required) |
| `POST /leaves/:id/cancel` | reviewer | `{ "reason": "..." }` (required): cancel an approved leave |

## 5. The Annual Leaves report (`/api/v1/payroll/reports`)
- `GET /reports/annual-leaves?year=2026&groupId=&departmentId=&employeeId=&search=&closed=false|all&page=&limit=` returns `{ year, asOf, page, limit, total, totals, data }`. `year` defaults to this year; the running year is worked out up to today, an earlier year in full. Employees who joined after the year or left before it are not listed (`closed=all` also lists the ones who left).
```json
{ "employee": { "id": "...", "code": 101, "label": "00101", "name": "VETERAN ALI", "group": { "id": "...", "name": "Factory" }, "department": { "id": "...", "name": "Dishwash" }, "designation": "Worker", "joiningDate": "2025-01-10", "leavingDate": null, "isClosed": false },
  "eligibleFrom": "2025-07-10", "opening": 5, "earned": 22, "creditedBeforeCap": 22, "taken": 3, "pending": 2, "balance": 24, "available": 22, "earnedAllYears": 32 }
```
  `opening` = carried from the years before (earned less taken); `earned` = credited in the year after the yearly maximum; `creditedBeforeCap` shows what the policy would have given without the maximum; `taken` = approved days in the year; `pending` = days waiting in review; `balance` = opening + earned - taken; `available` = balance - pending. `totals` = `{ opening, earned, taken, pending, balance }` added up over the employees of the page you got (use a large `limit` for the whole company).
- `GET /reports/annual-leaves/:employeeId?year=2026` is the employee's statement: the same figures, `months: [ { month: "2026-01", credited, taken, pending } ]` (12 rows) and `leaves` (his applications of the year with `label`, dates, `days`, `status`).
- Suggested screen: a year picker, filters (group, department, search), the table with the columns above and totals, and a row click that opens the statement.

## 6. Errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | a missing or wrong field, a reason under 3 characters, a year outside 2000 to 2100, a field the call does not accept |
| `403` | not enough access (HR cannot approve, reject or cancel) |
| `404 NOT_FOUND` | unknown application or employee, or of another company |
| `422 TO_BEFORE_FROM` | the last day is before the first |
| `422 LEAVE_BEFORE_JOINING` | the leave starts before the joining date |
| `422 LEAVE_TOO_LONG` | more than one year in one application |
| `422 NO_WORKING_DAYS` | every day of the dates is a weekly off day or a holiday (`details.restDays`) |
| `422 LEAVE_OVERLAP` | another draft / in review / approved leave of the employee overlaps (`details`: `code`, `fromDate`, `toDate`) |
| `422 LEAVE_BALANCE_LOW` | sending / approving / correcting with more days than available (`details`: `available`, `requested`, `earned`, `taken`, `pending`, `eligibleFrom`) |
| `422 EMPLOYEE_CLOSED` | the employee has left |
| `422 DATE_IN_FUTURE` | the application date is in the future |
| `422 LEAVE_IN_REVIEW`, `LEAVE_CLOSED` | edit / delete a leave in review, or an approved / rejected / cancelled one (re-open a rejected one first) |
| `422 ALREADY_IN_REVIEW`, `NOT_IN_REVIEW`, `NOT_REJECTED`, `NOT_APPROVED` | the action does not fit the status |
| `422 IN_USE` | deleting an employee card that has a leave application |

## 7. Attendance change
`AL` was already a day code that HR could set by hand. Now an approved leave sets it by itself on the days nobody punched on. The month grid and the attendance summary (`AL` count, `payableDays`) pick it up with no change. Cancelling a leave changes those days back (to `A` where there is attendance data). HR can still set `AL` by hand on a day, but that does not touch the leave balance: use a leave application for leave.

## 8. Build checklist
1. **Payroll > Applications > Leave Applications**: tabs (All / Draft / Review / Approved / Rejected / Cancelled with counts from `summary`), search, date filters, **New application**; table: App-ID, application date, employee (name, ID), department, from, to, days, reason, status.
2. **New / edit form:** employee picker, from date, to date, reason; below them the **live preview** (`GET /leaves/preview`): "N working days", the rest days with their reasons, **balance: earned / taken / pending / available** and a red warning when `enough` is false. Buttons: Save, Delete, Send for review, Withdraw, Close; for the reviewer Approve, Reject (reason), a Save for the date corrections (`PATCH /review`) and **Cancel leave** (reason) when `canCancel`.
3. **Employee card (optional):** show `GET /leaves/balance?employeeId=` as "Annual leave available".
4. **Reports > Annual Leaves:** section 5.
5. Test:
   - A new employee (inside `monthsBeforeLeave`) cannot send a leave: `LEAVE_BALANCE_LOW` with `eligibleFrom`.
   - Monday to Sunday counts 6 working days and shows Sunday as a rest day; add a holiday and it drops by one.
   - Two applications that need more than the balance together: the second cannot be sent.
   - Approve one: the attendance shows AL on the days without a punch; cancel it: they go back.
   - The Annual Leaves report for last year shows opening, earned, taken and balance, and this year carries the balance on.
