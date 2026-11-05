# Resignation Applications: frontend guide (chunk 7)

## 1. How it works
- HR makes a resignation application for any **working** employee (Payroll > Applications > **Resignation**). It goes **Draft -> In review -> Approved (posted)**, or **Rejected**.
- **Approved = posted:** the employee card is **closed** with the **last working day** as the leaving date. He is no longer a working employee (he leaves the Employee Master's working list, and no new payroll takes him). The application becomes read only.
- His data stays: his attendance up to the last working day is kept (days after it are removed), and the payroll of the month he left will count only the days up to the last working day.
- Who reviews: a **client admin** or a person chosen under **Approval Roles** (the same people as for the joining application). HR (service `PAYROLL_APPLICATIONS` FULL) writes and sends the application but cannot approve.
- **Giving a resignation to someone who stopped coming:** the screen **Employees not coming** (section 5) lists the working employees with no punch for N days and the last day each one came. HR picks one and makes the application with that day as the last working day.
- One employee has at most **one open** (draft or in review) application. A closed employee cannot get one (re-open his card first if he comes back).

## 2. Access
Base URL `/api/v1/payroll/resignations`. Read: any payroll service. Create, edit, delete, send, withdraw, re-open: `PAYROLL_APPLICATIONS` with `FULL` (`403` otherwise). Review, approve, reject: a client admin or a chosen approver (`403` for others). Another company's record = `404`.

## 3. An application as the server answers it
```json
{ "id": "...", "code": 78, "appId": "00078", "label": "RES-0078", "status": "APPROVED", "statusText": "Approved", "posted": true,
  "employee": { "id": "...", "code": 760, "label": "00760", "name": "MUMTAZ ALI", "fatherName": "ALI BAIG", "cnic": "53302-8282051-5",
    "group": { "id": "...", "name": "Factory" }, "department": { "id": "...", "name": "Dishwash" }, "designation": "Worker",
    "joiningDate": "2026-07-06", "basicSalary": "25000.00", "service": "0y 3m", "hasPhoto": true, "isClosed": true, "leavingDate": "2026-10-12" },
  "applicationDate": "2026-10-29", "lastWorkingDay": "2026-10-12", "gapDays": 17, "gapText": "Left 17 days before the application date", "hasLeft": true,
  "reason": "EMPLOYEE RESIGNED WITHOUT NOTICE", "refNo": "5256", "submittedAt": "...", "submittedBy": "haris",
  "approval": { "by": "haris", "at": "..." },
  "canEdit": false, "canDelete": false, "canSubmit": false, "canWithdraw": false, "canReopen": false, "canReviewEdit": false, "canApprove": false, "canReject": false }
```
- Header: `label` (RES-0078) and a status badge: `statusText`, and **POSTED** when `posted` is true. The list column "App-ID" is `appId`.
- The employee box (photo, name, ID, group, department, father's name, CNIC, salary, joined, service) comes from `employee`. The photo is `GET /payroll/employees/:id/files/photo` (needs the bearer token; show it only when `hasPhoto`). `service` is the time from joining to the last working day.
- Under the last working day show `gapText`: "Left 17 days before the application date" (`gapDays` > 0), "Leaves 5 days after the application date" (< 0), or "Last working day is the application date" (0).
- The **Left** badge next to the leaving date: show it when `hasLeft` is true.
- `approval`: `null` for draft and in review; `{ by, at }` when approved; `{ by, at, reason }` when rejected.
- Use the flags for the buttons: HR: `canEdit`, `canDelete`, `canSubmit`, `canWithdraw` (in review), `canReopen` (rejected). Reviewer: `canReviewEdit`, `canApprove`, `canReject` (only while in review). For an approved application show the note "This resignation is posted: the employee record is closed and the application can no longer be edited" and only a Close button.

## 4. Calls
| Call | Who | What |
|---|---|---|
| `GET /resignations?search=&status=&departmentId=&groupId=&employeeId=&from=&to=&page=&limit=` | read | `{ data, page, limit, total }`, newest first. `search` looks in employee name, CNIC, department, ref #, reason, and a number matches the application ID or the employee ID. `from` / `to` filter on the application date. Download = build the file from this list in the frontend |
| `GET /resignations/summary` | read | `{ total, draft, inReview, approved, rejected }` for the tabs (Applications / Draft / Review) |
| `POST /resignations` | HR | 201. Body below |
| `GET /resignations/:id` | read | one application |
| `PATCH /resignations/:id` | HR | change a draft: `employeeId`, `applicationDate`, `lastWorkingDay`, `reason`, `refNo` (at least one) |
| `DELETE /resignations/:id` | HR | a draft only; 204 |
| `POST /resignations/:id/submit` | HR | Send for review |
| `POST /resignations/:id/withdraw` | HR | take it back from In review to Draft |
| `PATCH /resignations/:id/review` | reviewer | while In review: correct `lastWorkingDay`, `reason`, `refNo` (nothing else is accepted) |
| `POST /resignations/:id/approve` | reviewer | post it: closes the employee card |
| `POST /resignations/:id/reject` | reviewer | body `{ "reason": "..." }` (3 to 500 characters, required) |
| `POST /resignations/:id/reopen` | HR | Rejected back to Draft |
| `GET /resignations/absentees?days=10&groupId=&departmentId=&page=&limit=` | read | the employees who stopped coming (section 5) |

**Create body:** `{ "employeeId": "...", "applicationDate": "2026-10-29", "lastWorkingDay": "2026-10-12", "reason": "...", "refNo": "5256" }`. Required: `employeeId`, `applicationDate`, `lastWorkingDay`, `reason` (3 to 500 characters). `refNo` is optional (up to 40). The application date cannot be in the future. The last working day may be before or after the application date and may be in the future (notice period), but not before the joining date. The employee picker should offer the working employees (`GET /payroll/employees`, closed = false).

## 5. Employees not coming (from the attendance)
`GET /resignations/absentees?days=10` returns the working employees with **no punch for `days` days**, counted up to the latest day the machine has data for (`asOf`), not up to today, so a day the machine was off does not make everybody a candidate. Employees who already have an open application are left out.
```json
{ "asOf": "2026-10-20", "days": 10, "page": 1, "limit": 100, "total": 2,
  "data": [ { "employee": { "id": "...", "code": 737, "label": "00737", "name": "MUSHTAQ ALI", "group": "Factory", "department": { "id": "...", "name": "Dishwash" }, "designation": "Worker", "joiningDate": "2026-07-06" },
              "lastPunchDate": "2026-10-01", "neverPunched": false, "daysSincePunch": 19, "suggestedLastWorkingDay": "2026-10-01" } ] }
```
- The longest away comes first. `suggestedLastWorkingDay` is the last day he punched (`null` when `neverPunched`: HR chooses the date).
- Screen: a "Days without a punch" box (default 10) and a table with a **Make resignation** button per row that opens the new application with the employee and `suggestedLastWorkingDay` filled in. `asOf` is null when there are no punches at all.
- Use it from the Resignation list ("Employees not coming" button) and, if you like, from the attendance screens.

## 6. Rules and errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | a missing or wrong field, a reason under 3 characters, a field the call does not accept |
| `403` | not enough access (HR cannot approve, reject or review-edit) |
| `404 NOT_FOUND` | unknown application or employee, or of another company |
| `422 EMPLOYEE_CLOSED` | the employee has already left |
| `422 RESIGNATION_EXISTS` | the employee already has a draft / in review application (`details.code` is its number); also when re-opening a rejected one while another is open |
| `422 LAST_DAY_BEFORE_JOINING` | the last working day is before the joining date |
| `422 DATE_IN_FUTURE` | the application date is in the future |
| `422 RESIGNATION_IN_REVIEW` | edit / delete a draft-only action while In review: withdraw first |
| `422 RESIGNATION_CLOSED` | edit / delete / send an Approved or Rejected application (re-open a rejected one first) |
| `422 ALREADY_IN_REVIEW`, `NOT_IN_REVIEW`, `NOT_REJECTED` | the action does not fit the status |
| `422 LAST_DAY_IN_FUTURE` | approving while the last working day has not come: it can be approved from that day (`details.lastWorkingDay`). Sending and reviewing are allowed before |
| `422 IN_USE` | deleting an employee card that has a resignation application |

If an employee comes back after being posted, re-open his card in the Employee Master (`POST /employees/:id/reopen`); he can then get a new resignation later.

## 7. Build checklist
1. Payroll > Applications > **Resignation**: header with **Download** (from the list) and **New application**, tabs **Applications** / **Draft** / **Review** with counts from `summary`, a search box ("name, ID, ref#, department, remarks"), a department filter, and the table (App-ID, Date = `applicationDate`, Employee with ID and designation, Ref #, Department, Remarks = `reason`, Leaving = `lastWorkingDay` with the **Left** badge, Status). **View** opens the application.
2. Application screen (as in the design): employee picker, the employee card box, application date, last working day with the `gapText` line, reason; buttons Save, Delete, **Send for review**, Withdraw, Close; for a reviewer **Approve** and **Reject** (asks for a reason) and a Save for the review corrections (`PATCH /review`); for a rejected one the reason and **Re-open**. A posted application is read only with the lock note.
3. **Employees not coming** (section 5) with **Make resignation**.
4. After an approval the employee is closed: refresh the Employee Master lists.
5. Test: HR makes and sends an application; HR sees no Approve; the client admin approves and the employee appears under Closed with the leaving date; a second application for him is refused; reject another with a reason, re-open it, send it again; a last working day in the future is sent but cannot be approved yet; the not-coming list shows an employee with no punches and its suggested date.
