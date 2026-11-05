# Joining Application Approval: frontend guide (chunk 5)

## 1. Flow
- HR saves the joining application and presses **Send for review**. Status: **In review**.
- A **reviewer** opens it. The reviewer may correct the work and salary details, then **Approve** or **Reject**.
- **Approve**: an Employee Master card is created from the application, already **Confirmed**, with the photo and CNIC copies. The application becomes **Approved** and keeps a link to the employee.
- **Reject**: a reason is required. The application becomes **Rejected**. HR can **Re-open** it (back to Draft), correct it and send it again.
- Statuses: `DRAFT`, `IN_REVIEW`, `APPROVED`, `REJECTED`. Only a draft can be edited, deleted or get documents. In review, approved and rejected are read only for HR.

## 2. Who is a reviewer
- A **client admin** is always a reviewer.
- Besides the client admin, the company can choose **approvers** (any company user who has some payroll service).
- Everyone else (HR) can open an application but gets `403` on approve, reject and review-edit.
- Do not hide buttons by guessing the role. Use the flags on every application: `canReviewEdit`, `canApprove`, `canReject` (true only for a reviewer when the application is In review). HR flags: `canEdit`, `canDelete`, `canSubmit`, `canWithdraw` (In review), `canReopen` (Rejected).

## 3. Approvers setting (Master Card > Approval Roles)
- `GET /api/v1/payroll/approvers` returns `{ data: [ { id, name, email, userType } ], clientAdminAlways: true }`. Any payroll service can read it.
- `PUT /api/v1/payroll/approvers` with `{ "userIds": ["..."] }` replaces the whole list (an empty list is fine). Needs `PAYROLL_EMPLOYEES` FULL.
- Errors: `404 NOT_FOUND` (user of another company), `422 USER_INACTIVE`, `422 NO_PAYROLL_ACCESS` (that person has no payroll service: give one first).
- Screen: a multi-select of company users with a note "Client admin can always approve".

## 4. Calls (base `/api/v1/payroll`)
| Call | Who | What |
|---|---|---|
| `PATCH /applications/:id/review` | reviewer | correct the application while In review. Only these fields are accepted: `joiningDate`, `groupId`, `departmentId`, `designationId`, `shiftId`, `salaryType`, `basicSalary`, `foodAllowance`, `maintenanceAllowance`, `mobileAllowance`, `yearlyIncomeTaxPercent`, `monthlyEobiPercent`, `remarks` (anything else is `400`). At least one field. Department, designation, shift and a basic salary above 0 cannot be emptied (`422 APPLICATION_INCOMPLETE`) |
| `POST /applications/:id/approve` | reviewer | creates the employee and approves. Returns the application with `approval: { by, at, employeeId }` |
| `POST /applications/:id/reject` | reviewer | body `{ "reason": "..." }` (3 to 500 characters, required). Returns the application with `approval: { by, at, reason }` |
| `POST /applications/:id/reopen` | HR (`PAYROLL_APPLICATIONS` FULL) | Rejected back to Draft |
| `GET /applications/summary` | any payroll service | now `{ total, draft, inReview, approved, rejected }` |
| `GET /applications?status=IN_REVIEW` | any payroll service | the reviewer's inbox. `status` also accepts `APPROVED` and `REJECTED` |

Reviewer calls need only reading access to payroll plus being a reviewer. Edits made by the reviewer are recorded in the audit log with before and after.

## 5. What the approval creates
- A new Employee Master card with the next employee ID, **status Confirmed**, with all fields of the application: personal data, group, department, designation, shift, joining date, salary type, salary and allowances, `yearlyIncomeTaxPercent`, `monthlyEobiPercent`, payment method, bank details and IBAN.
- The photo, CNIC front and CNIC back are copied to the employee. The scanned form stays only on the application.
- Use `approval.employeeId` to open the new card (`GET /employees/:id`). A "Open employee" link on an approved application is enough.
- An application field shows `approval` as `null` while Draft or In review.

## 6. Errors
| status / code | When |
|---|---|
| `403 FORBIDDEN` | approve, reject or review-edit by someone who is not a reviewer |
| `422 NOT_IN_REVIEW` | approve, reject or review-edit an application that is not In review |
| `422 NOT_REJECTED` | re-open an application that is not Rejected |
| `422 APPLICATION_CLOSED` | edit, delete, upload or send an Approved or Rejected application (a rejected one: re-open first) |
| `422 APPLICATION_INCOMPLETE` | something required is missing; `details.missing` lists it |
| `422 CNIC_TAKEN` | at approval, an employee with this CNIC exists now |
| `422 NO_VACANCY` | at approval the department's seats (fte) are full of working employees; `details`: `department`, `fte`, `taken`. fte 0 = no limit |
| `422 *_INACTIVE` | a group, department, designation, shift or bank was switched off after HR chose it: the reviewer changes it with review-edit |
| `400 VALIDATION_FAILED` | bad value, unknown field, empty reject reason |

## 7. Build checklist
1. Applications tab: add tabs **In review**, **Approved**, **Rejected** with counts from `summary`. The reviewer's default tab is In review.
2. Application screen for a reviewer when `canReviewEdit`: the work and salary fields are editable (Save calls `PATCH /review`); the personal fields and documents are read only. Buttons **Approve** (when `canApprove`) and **Reject** (when `canReject`, asks for a reason).
3. Approved: show who approved, when, and a link to the employee card. Rejected: show the reason, who rejected it, and a **Re-open** button for HR (`canReopen`).
4. Master Card > **Approval Roles**: the approvers multi-select (section 3).
5. Test: HR sends an application; HR sees no Approve button; the client admin changes the salary and approves; the employee appears confirmed with the new salary and the photo; the application is read only. Reject another with a reason, re-open it as HR, fix it and send again. Choose a normal user as approver and approve with that login.
