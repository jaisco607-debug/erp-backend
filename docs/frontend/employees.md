# EMPLOYEES: the client admin makes employees and gives them services; the super admin only looks

Read this fully before starting. Parts: (A) who can do what, (B) what changed in the backend and database, (C) CLIENT ADMIN screens, (D) SUPER ADMIN screens, (E) what to change in the guide "Super Admin Users & Roles", (F) lock-out rule, (G) checklist and tests.

## A. Who can do what (the decision)

| | Super admin | Client admin | Employee (USER) |
|---|---|---|---|
| Make a client admin | **yes** (when registering a company, or later from the company) | no | no |
| Switch a client admin off / on, delete, reset password, edit | **yes** | no | no |
| Make an employee (name, email, password, services) | **no** | **yes**, in own company | no |
| Edit, switch off, reset password of an employee | **no** | **yes** | no |
| Give / change the services of an employee | **no** | **yes**, only the services the company has | no |
| **See** the client admins, their employees and the services each employee has | **yes, read only** | own employees | no |
| Log in | with the super admins' code | with the **company code** + own email + password | with the **same company code** + own email + password |

- An employee always belongs to the company of the client admin who made them. They log in at the same login screen with **the company's code** (the client admin's code), **their own email** and the password the client admin set. They see only the services the client admin gave them (see `service-access.md`, part C).
- **Locked out together:** if the super admin switches off or deletes the client admin (the last active one of the company), **all his employees lose access at once** and cannot log in. See part F.

---

## B. What changed in the backend and database (migration 20261020000004)
- `users.phone` (optional, up to 30 characters) for client admins and employees.
- `users.deletedAt`: a client admin can now be **deleted** (soft delete: the row stays for the audit log, the person can never log in again, and the email can be used again).
- New endpoints:
  - client admin: `GET /v1/users/service-options`
  - super admin, client admins: `POST /v1/companies/:id/admins`, `DELETE /v1/companies/:id/admins/:userId`
  - super admin, read only: `GET /v1/admin/users`, `GET /v1/admin/users/:id`
- Changed: employees (`/v1/users`) accept and return `phone`; the client admin can change an employee's email and phone; the employee answer carries `services[]` with `menuGroup` and `serviceCount`; a report service is always saved as VIEW; `PATCH /v1/companies/:id/admins/:userId` and the new admin calls answer with an `effect` object (part F).
- **An employee can log in and use the system only while the company is on AND has at least one active client admin.** This is checked at login, on every API call and on refresh (part F).
- Emails are unique **inside one company** (not in the whole system), because login is company code + email. Duplicate: `409 EMAIL_TAKEN`.
- Password rule (same as before, check it in the form too): at least 10 characters, with a capital letter, a small letter and a digit. A weak password answers `400 VALIDATION_FAILED` with the field `body.password`.

---

## C. CLIENT ADMIN screens: Employees

All calls need the client admin's token. They work only on the client admin's own company (another company's employee = 404). An employee token on these calls = 403.

### C1. Employees list
`GET /v1/users?page=1&limit=25&search=ali&isActive=true`
```json
{ "data": [ {
    "id": "uuid", "name": "Aslam", "email": "aslam@test.com", "phone": "0300-1234567",
    "userType": "USER", "companyId": "uuid", "isActive": true,
    "lastLoginAt": "2026-10-20T09:10:00.000Z", "createdAt": "2026-10-12T08:00:00.000Z",
    "serviceCount": 2,
    "services": [ { "id": "uuid", "code": "CHEMICAL_STORE", "name": "Chemical Store", "kind": "MODULE", "menuGroup": "STORE", "access": "FULL" },
                  { "id": "uuid", "code": "REPORT_GREY", "name": "Grey / Inward Reports", "kind": "REPORT", "menuGroup": "REPORTS", "access": "VIEW" } ]
  } ],
  "page": 1, "limit": 25, "total": 1 }
```
- Table columns: Name, Email, Phone, Services (count, with a tooltip or chips by tab), Status (active / switched off), Last login (`null` = never), Actions.
- `search` looks in name, email and phone (partial, any case). `isActive` filters on / off.
- Only employees are listed (never client admins).

### C2. Add employee
`POST /v1/users`
```json
{ "name": "Aslam", "email": "aslam@test.com", "phone": "0300-1234567", "password": "Employee-Pass-123",
  "services": [ { "serviceId": "uuid", "access": "FULL" }, { "serviceId": "uuid", "access": "VIEW" } ] }
```
- Required: `name` (2 to 120), `email`, `password`. Optional: `phone`, `services` (can be empty; the services can be given later). **There is no `userType`**: a client admin can only make employees, sending `userType` answers 400.
- Answer **201**: the employee object of C1 (never a password or hash).
- Form: name, email, phone, password (with a show / hide eye and a "generate" button is nice), then the **services chooser** (C4). Show the company code on the success dialog: "Give your employee: Company code **BEQJ-EK2S**, email, password" with a copy button (the code comes from `/auth/me` → `company.code`).
- Errors: `409 EMAIL_TAKEN` (field email), `400 VALIDATION_FAILED` (weak password, bad email), `422 SERVICE_NOT_IN_COMPANY` (a service the company does not have).

### C3. Edit, switch off, reset password
- `PATCH /v1/users/:id` with any of `{ "name", "email", "phone", "isActive" }` → the employee object.
  - `isActive: false` switches the employee off: login stops at once, the open session and the refresh token stop. `true` switches on again.
  - Changing the email also ends the employee's open sessions (the old email stops working at once). `409 EMAIL_TAKEN` if used.
- `POST /v1/users/:id/reset-password` with `{ "newPassword": "..." }` → **204**. All sessions of the employee end; they log in with the new password.
- `GET /v1/users/:id` → one employee (same object as C1).
- There is no delete for employees: switch them off.

### C4. Give services (the services chooser)
**Step 1: load what can be given.** `GET /v1/users/service-options`
```json
{ "data": [ { "id": "uuid", "code": "GREY_STORE", "name": "Grey Store", "kind": "MODULE", "menuGroup": "PRODUCTION", "accessLevels": ["VIEW", "FULL"] },
            { "id": "uuid", "code": "REPORT_GREY", "name": "Grey / Inward Reports", "kind": "REPORT", "menuGroup": "REPORTS", "accessLevels": ["VIEW"] } ] }
```
It lists **only the services the company has** (the ones the super admin gave). The client admin can never give more than that.

**Step 2: build the same four-panel checklist as the super admin's "Assign services"** (see `service-access.md` B3), but with these panels and only the services returned above:
1. **Production Management** (`menuGroup = PRODUCTION`)
2. **Process Management** (`PROCESS`): one checkbox per department
3. **Store** (`STORE`): Chemical Store, General Items Store, Store Reports, each on its own
4. **Reports** (`REPORTS`): one checkbox per report group

Rules for the chooser:
- Next to every ticked service show the access: **View only** or **Full** (a dropdown or two radio buttons). Default **View only**. `accessLevels` tells which are allowed: for report services (`kind: "REPORT"`) show only "View only" (a report is always read only; the backend stores VIEW even if FULL is sent).
- A panel with nothing in it (the company has no service of that tab) is not shown at all.
- Every panel has **Select all / Clear** and a counter ("2 of 3 given"). On top there is a **Select all services** button (everything the company has, FULL for modules and departments, VIEW for reports) and **Clear all**.
- **Partial access is just ticking some boxes.** Example: only the Chemical Store = tick `CHEMICAL_STORE` (all chemical screens open: inwards, outwards, stock); only the store reports = tick `STORE_REPORTS`; both stores but no reports = tick `CHEMICAL_STORE` + `GENERAL_STORE`. The Store tab of that employee shows only the ticked entries; a tab with nothing ticked disappears from his menu (the rules of `service-access.md` part C).

**Step 3: save.** `PUT /v1/users/:id/services`
```json
{ "services": [ { "serviceId": "uuid", "access": "FULL" }, { "serviceId": "uuid", "access": "VIEW" } ] }
```
- It **replaces the whole list** (send every ticked service, not only the new ones). An empty list takes everything away.
- Answer: the employee object of C1 with the new `services[]`.
- It takes effect at once: the employee's open session keeps working, but the next API call already follows the new list. Their menu changes at their next `/auth/me` or login (tell the client admin: "the employee sees the change when they open the app again").
- `422 SERVICE_NOT_IN_COMPANY` if a service id is not one of the company's (for example the super admin took it away meanwhile). Reload the options and show the message.
- The same `services` array can be sent in `POST /v1/users` to give the services while making the employee.

### C5. What the employee sees (nothing to build, only to check)
The employee logs in at the normal login with: **company code** (the client admin's), **their email**, **their password**. The answer has `services[]` with `menuGroup` and `access`. The menu, tabs, route guards and VIEW / FULL buttons follow `service-access.md` part C. An employee with no service sees the empty state "No services have been given to your account yet".

---

## D. SUPER ADMIN screens: "Users & Roles" (read only for employees)

The super admin **cannot make, edit, switch off, reset or give services to an employee** (those calls do not exist and answer 404 / 403). The super admin **sees** who works under each client admin and **which services each employee has**.

### D1. List: `GET /v1/admin/users`
Only `SUPER_ADMIN` (anybody else: 403).
Query (all optional): `page` (1), `limit` (20, max 100), `search` (name, email, phone), `companyId`, `userType` = `SUPER_ADMIN | CLIENT_ADMIN | USER`, `isActive` = `true | false`. Newest first.

Real sample from the database:
```json
{
  "data": [
    { "id": "579b0833-2560-49c7-a83a-355a91b1e3f9", "name": "shah", "email": "shah@gmail.com", "phone": null,
      "userType": "CLIENT_ADMIN", "isActive": true,
      "company": { "id": "8bcda558-dacc-445a-8c42-01d90ad7f37e", "name": "Textile", "code": "BEQJ-EK2S", "isActive": true },
      "serviceCount": null, "employeeCount": 0,
      "lastLoginAt": "2026-10-20T12:06:21.477Z", "createdAt": "2026-10-14T04:48:44.413Z" },
    { "id": "uuid", "name": "Aslam", "email": "aslam@test.com", "phone": "0300-1234567", "userType": "USER", "isActive": true,
      "company": { "id": "uuid", "name": "Mills", "code": "F5MH-PJMA", "isActive": true },
      "serviceCount": 2, "employeeCount": null, "lastLoginAt": null, "createdAt": "2026-10-12T08:00:00.000Z" }
  ],
  "page": 1, "limit": 20, "total": 11,
  "summary": { "total": 11, "superAdmins": 2, "clientAdmins": 8, "users": 1, "active": 7, "inactive": 4 }
}
```
- `company` is `null` for a SUPER_ADMIN. `company.isActive` is the company's own switch (a switched-off company locks everybody).
- `serviceCount`: for an **employee** the number of services given; `null` for the others.
- `employeeCount`: for a **client admin** the number of employees of his company (how many people depend on him); `null` for the others.
- `summary` counts everybody and ignores the filters (stat cards). Deleted people are not counted.
- `lastLoginAt`: set at every successful login; `null` = never.
- Suggested page: stat cards from `summary`, a filter bar (search, company dropdown from `GET /v1/companies`, type, status), the table. Clicking a company name sets the `companyId` filter ("show only the people of this client admin").

### D2. One person: `GET /v1/admin/users/:id`
- Same fields as a list row, plus `services[]`: `[ { id, code, name, kind, menuGroup, access } ]`.
  - **Employee:** the services given to him (read only). Show them grouped by `menuGroup` (Production, Process, Store, Reports) with a View / Full chip each.
  - **Client admin:** all the services of the company (he has all, FULL), **plus `employees[]`**: every employee of his company, each with `serviceCount` and his own `services[]`. This is the screen where the super admin sees "who works under this client admin and with what access".
  - **Super admin:** `services: []`.
- 404 `NOT_FOUND` for a missing or deleted person, 400 for a bad id.
- Open it in a side drawer or a page. **No edit, switch or reset buttons for an employee.** Show a small grey note: "Employees are managed by their client admin."

### D3. What the super admin CAN do with a client admin (existing and new calls)
These use the company URLs. After each, show the `effect` text (part F).

| Action | Call | Answer |
|---|---|---|
| Make the first client admin | `POST /v1/companies` (company registration, as before) | company with `clientAdmins[]` |
| **Make another client admin** (new) | `POST /v1/companies/:companyId/admins` `{ name, email, phone?, password }` | **201** admin + `effect` |
| Edit / **switch off / switch on** | `PATCH /v1/companies/:companyId/admins/:userId` with any of `{ name, email, phone, isActive }` | admin + `effect` |
| Reset his password | `POST /v1/companies/:companyId/admins/:userId/reset-password` `{ newPassword }` | 204 |
| **Delete** (new) | `DELETE /v1/companies/:companyId/admins/:userId` | **200** `{ deleted: true, id, effect }` |
| Switch off / delete the whole company | `PATCH /v1/companies/:id` `{ isActive: false }` / `DELETE /v1/companies/:id` (as before) | everybody of the company is locked out |

- `companyId` is `row.company.id` of the list row. `409 EMAIL_TAKEN` when the email is used in that company; the email of a deleted admin can be used again.
- Super admins themselves are still managed with the existing `/v1/super-admins` calls.

---

## E. The guide "Super Admin Users & Roles": what to build and what NOT to build

The guide you were given (`GET/POST/PATCH /v1/admin/users ...`) asked for a super admin who creates and manages every kind of user. **That is not the decision.** Use this table:

| In that guide | Decision | Use instead |
|---|---|---|
| 1. `GET /v1/admin/users` | **built** (read only), part D1 | |
| 2. `GET /v1/admin/users/:id` | **built** (read only), part D2 | |
| 3. `POST /v1/admin/users` (create user) | **NOT built** | client admin: `POST /v1/companies/:id/admins`; employee: the client admin's `POST /v1/users`; super admin: `POST /v1/super-admins` |
| 4. `PATCH /v1/admin/users/:id` (edit, switch off) | **NOT built** | client admin: `PATCH /v1/companies/:id/admins/:userId`; employee: client admin only |
| 5. `POST /v1/admin/users/:id/reset-password` | **NOT built** | client admin: `POST /v1/companies/:id/admins/:userId/reset-password`; employee: client admin only |
| 6. `PUT /v1/admin/users/:id/services` | **NOT built**: the super admin does not give services to employees | the client admin's `PUT /v1/users/:id/services` (C4) |
| 7. `POST /v1/admin/users/:id/logout-all` | **NOT built** | switching a client admin off already ends his sessions |

Differences from that guide (keep these in mind when you read its text):
- Email is unique **per company**, not in the whole system (login is company code + email). Duplicate = `409 EMAIL_TAKEN`.
- A weak password answers `400 VALIDATION_FAILED` (field `body.password`), not `422 WEAK_PASSWORD`. Keep your own `validatePassword` in the form.
- `userType` of a user cannot be changed; there is no "switch USER to CLIENT_ADMIN".
- The page `/super-admin/users` becomes a **viewer**: list, filters, stat cards, detail drawer. Row buttons depend on the row type: SUPER_ADMIN rows use `/v1/super-admins`, CLIENT_ADMIN rows use the company calls of D3, USER rows have **no buttons**.

---

## F. The lock-out rule (what happens when a client admin is switched off or deleted)

**Rule:** an employee can work only while the company is switched on **and** has at least one **active, not deleted** client admin.

| Event | Result for the employees |
|---|---|
| The only client admin is switched off | **locked out at once**: their open session answers 401 on the next call, refresh fails, login fails |
| The client admin is switched on again | they can log in again (nothing is lost) |
| One of two client admins is switched off | **nothing changes** (the other one is still active) |
| The last client admin is deleted | locked out for good (until a new client admin is made: `POST /v1/companies/:id/admins`) |
| The company is switched off or deleted | everybody (admins and employees) locked out, as before |

- The employees are **not deleted or changed**: they stay in the database with their services; only the access stops. The super admin still sees them in the list.
- The login error stays the same for security: `401` "Company code, email or password is incorrect". The employee is never told why. Show a small help text on the login page: "Cannot log in? Ask your administrator."
- **`effect` object** in the answers of the client admin calls of D3:
```json
{ "...admin fields...": "...", "effect": { "activeAdmins": 0, "employees": 3, "employeesBlocked": true } }
```
  - `activeAdmins`: client admins still active in that company. `employees`: how many employees the company has. `employeesBlocked`: `true` when the employees cannot work now.
  - Use it for the message after the action: if `employeesBlocked` is `true`: "Client admin switched off. His **3 employees** can no longer log in." If `false`: "Done. The company still has N active client admin(s)."
- **Before** switching off or deleting the last active client admin, show a confirmation using `employeeCount` of the row: "This client admin has **3 employees**. They will lose access too. Continue?" For delete add: "This cannot be undone."

**Any API answering 401 means "go to the login page"** (token ended: switched off, deleted, password reset, company switched off). Clear the stored tokens and show the login page. Do not retry.

---

## G. Checklist and tests

**Client admin side**
1. Menu item **Employees** (only for `userType = CLIENT_ADMIN`).
2. Employees list (C1) with search, status filter, paging.
3. Add employee form (C2) with the company code shown after saving.
4. Edit dialog (name, email, phone), switch off / on, reset password (C3).
5. Services chooser (C4): four panels from `GET /v1/users/service-options`, View / Full per service (report services View only), select all / clear, save with `PUT /v1/users/:id/services`. Use the same component in "Add employee" and "Edit services".
6. Handle `409 EMAIL_TAKEN`, `422 SERVICE_NOT_IN_COMPANY`, `400 VALIDATION_FAILED` (show the field message).

**Super admin side**
7. Users & Roles page as a **viewer** (D1, D2): stat cards from `summary`, filters (search, company, type, status), table, detail drawer with services, and for a client admin the list of his employees with their services.
8. Client admin actions (D3): add another client admin, edit, switch on / off, reset password, delete, each with the `effect` message and the confirmation of part F.
9. Remove everything of the old guide that creates or changes employees (part E).

**Login screen**
10. Add the help text "Cannot log in? Ask your administrator." and treat any 401 as "log out".

**Test with these logins**
- (a) Client admin makes employee A with only `CHEMICAL_STORE` (Full): A sees only the Store tab with the chemical entries; `GENERAL_STORE` calls answer 403.
- (b) Employee B with only `STORE_REPORTS` and `REPORT_GREY`: sees the Store tab with Reports only and the Reports tab with the 3 grey reports.
- (c) Employee C with all services: sees everything the company has.
- (d) Employee D with none: sees the empty state.
- (e) Super admin switches the client admin off: A, B, C, D cannot log in; their open tabs go to the login page on the next click. Switch on: they can log in again.
- (f) Super admin opens Users & Roles, picks the client admin: sees A, B, C, D with their services, and no edit buttons on them.
- (g) The same email for two employees of one company: `409 EMAIL_TAKEN`.

## Errors
| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | weak password, bad email, unknown field (for example `userType`), bad id |
| 401 | `UNAUTHORIZED` | token ended, or the client admin / company was switched off or deleted: go to login |
| 403 | `FORBIDDEN` | wrong role (employee calling `/v1/users`, client admin calling `/v1/admin/users`) |
| 404 | `NOT_FOUND` | the person is not in this company, or deleted |
| 409 | `EMAIL_TAKEN` | the email is already used in this company |
| 422 | `SERVICE_NOT_IN_COMPANY` | a service the company does not have |
