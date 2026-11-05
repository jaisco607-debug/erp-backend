# Payroll masters: frontend guide (chunk 1)

Written for: the frontend developer (Payroll, Master Card screens). Six masters: **groups, departments (with the approved head-count), designations, shifts, holidays, banks**. Nothing about employees or salaries yet.

## 1. Access
- Base URL: `/api/v1/payroll`. Company people only (client admin and users).
- **Read** (all GET): anyone who has ANY payroll service (`PAYROLL_SALARY`, `PAYROLL_REPORTS`, `PAYROLL_APPLICATIONS`, `PAYROLL_EMPLOYEES`), VIEW is enough, so the salary and applications screens can fill their dropdowns.
- **Change** (POST, PATCH, DELETE): the service `PAYROLL_EMPLOYEES` with `FULL`. Others get `403 FORBIDDEN`. No payroll service at all = `403`. Not logged in = `401`.
- Everything belongs to the company of the login. A record of another company is `404 NOT_FOUND`.

## 2. The same shape for every master
For `{master}` in `groups`, `departments`, `designations`, `shifts`, `holidays`, `banks`:

| Call | What |
|---|---|
| `GET /payroll/{master}` | list: `{ data: [...], page, limit, total }` |
| `POST /payroll/{master}` | create (201), answers the new record |
| `GET /payroll/{master}/:id` | one record |
| `PATCH /payroll/{master}/:id` | change only what you send (at least one field), answers the record |
| `DELETE /payroll/{master}/:id` | 204 with no body |

List query (all optional): `page` (1), `limit` (100, max 500), `search` (text), `isActive` (`true` / `false`). Each master adds its own filters (below). Lists are already sorted for the screen.

Every record has `id`, `isActive`, `canDelete` (true when the Delete button may be shown: nothing uses it), `createdAt`, `updatedAt`. Switch a record off with `PATCH { isActive: false }` (it stays in old data, but leave it out of new dropdowns); delete only unused ones.

Errors you will meet everywhere:
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | wrong shape (details say which field) |
| `404 NOT_FOUND` | unknown id, or another company's |
| `422 NAME_TAKEN` | the name (or shift code) already exists; the message says which |
| `422 IN_USE` | delete refused: `details` has the counts, e.g. `{ "departments": 2, "holidays": 0 }` |

## 3. Groups: `/payroll/groups`
Every company gets **4 default groups** the first time it opens payroll: Factory, Outlet, Head Office, Admin (nothing to create). A company can add its own.
```json
{ "id": "...", "name": "Factory", "isDefault": true, "systemKey": "FACTORY", "isActive": true, "sortOrder": 10, "departments": 3, "holidays": 1, "canDelete": false }
```
- Create: `{ "name": "Warehouse" }` (1 to 80 characters, unique ignoring letter case). It is put at the end of the list.
- Change: `name`, `isActive`, `sortOrder` (a default group can be renamed and switched off, it stays default).
- Delete: **never** for the 4 defaults (`422 DEFAULT_GROUP`, hide the button: `canDelete` is false). An own group is deleted only when it has no departments and no holiday (`422 IN_USE`). Later, employees and payrolls will count too: always trust `canDelete`.
- Filter: `search`, `isActive`.

## 4. Departments: `/payroll/departments` (the "Department FTE limit" screen)
```json
{ "id": "...", "name": "Dishwash", "fte": 10, "isActive": true, "group": { "id": "...", "name": "Factory" }, "canDelete": true }
```
- Create: `{ "groupId": "...", "name": "Dishwash", "fte": 10 }`. `fte` = the approved head-count (whole number 0 or more, default 0; send a number, not text).
- The name is unique **inside its group** (the same name may exist in two groups).
- A switched-off group takes no new department (`422 GROUP_INACTIVE`); a group of another company is `404`.
- Change: `groupId`, `name`, `fte`, `isActive`.
- Filters: `groupId`, `search` (matches the department name and the group name), `isActive`. Sorted by group order, then name.
- The vacancy (`fte` minus current employees and pending joining applications) comes with the employee master later.

## 5. Designations: `/payroll/designations`
`{ "id", "name": "Worker", "isActive", "canDelete" }`. Create `{ "name": "Floor Manager" }`; unique name (any letter case).

## 6. Banks: `/payroll/banks`
```json
{ "id": "...", "name": "Meezan Bank", "shortName": "MEZN", "bankCode": "0110", "isActive": true, "canDelete": true }
```
- Create `{ "name", "shortName?", "bankCode?" }` (short name and code up to 20 characters; an empty text is saved as `null`). The bank code is used for the bank upload file later. Search also looks at the short name and the code.

## 7. Shifts: `/payroll/shifts`
```json
{ "id": "...", "code": "08A-06P", "name": null, "startTime": "08:00", "endTime": "18:00", "dutyHours": 10, "isNight": false,
  "spanHours": 10, "crossesMidnight": false, "label": "08A-06P (08:00-18:00, 10 hrs)", "isActive": true, "canDelete": true }
```
- Create: `{ "code": "08A-06P", "name?": "...", "startTime": "08:00", "endTime": "18:00", "dutyHours": 10, "isNight": false }`.
  - `code`: capital letters are applied by the server, unique per company.
  - times are 24 hour `HH:MM` text; `dutyHours` is a number above 0, up to 24 (a number, not text, max 2 decimals).
- Rules (`422`):
  - `SHIFT_TIMES`: start and end cannot be the same.
  - `SHIFT_CROSSES_MIDNIGHT`: the shift ends after midnight (e.g. 20:00 to 04:00): tick **Night shift**.
  - `DUTY_MORE_THAN_SHIFT`: the duty hours are more than the length of the shift; `details.spanHours` has the length.
- On a change the server checks the whole shift (e.g. changing only the end time can break the duty hours).
- `spanHours`, `crossesMidnight` and `label` are worked out by the server: use `label` in dropdowns. List is sorted by start time. Search looks at the code and the name.

## 8. Holidays: `/payroll/holidays`
```json
{ "id": "...", "date": "2026-08-14", "weekday": "Friday", "name": "Independence Day", "appliesToAll": true, "groups": [], "canDelete": true }
{ "id": "...", "date": "2026-10-29", "weekday": "Thursday", "name": "Factory Maintenance", "appliesToAll": false, "groups": [ { "id": "...", "name": "Factory" } ] }
```
- Create: `{ "holidayDate": "2026-08-14", "name": "...", "appliesToAll": true }` for every group (the default), or `{ ..., "appliesToAll": false, "groupIds": ["..."] }` for chosen groups.
  - `appliesToAll: false` needs at least one `groupIds`; `appliesToAll: true` must not have `groupIds` (400 on create).
- Change: `holidayDate`, `name`, `appliesToAll`, `groupIds` (sending `groupIds` replaces the list). Switching `appliesToAll` to true removes the groups. On a change the server answers `422 GROUPS_REQUIRED` (turned off with no groups) or `422 GROUPS_NOT_ALLOWED` (groups sent while it stays "all groups"). An unknown group is `404`.
- Unique per **date and name**: two different holidays on one day are fine; the same name on the same day is `422 NAME_TAKEN`.
- Filters: `year=2026`, `dateFrom`, `dateTo` (`YYYY-MM-DD`), `groupId` (the holidays that count for that group: the ones for all groups plus the ones that name it), `search` (name). Sorted by date.
- Holidays can be deleted freely for now (attendance will read them later).

## 9. All the dropdowns in one call: `GET /payroll/masters`
Use it when a form opens (one request instead of five). Only **active** records, small objects:
```json
{ "groups":       [ { "id", "name", "isDefault" } ],
  "departments":  [ { "id", "name", "groupId", "fte" } ],
  "designations": [ { "id", "name" } ],
  "shifts":       [ { "id", "code", "label", "startTime", "endTime", "dutyHours", "isNight" } ],
  "banks":        [ { "id", "name", "shortName", "bankCode" } ] }
```
Filter the departments by the chosen `groupId` on the screen.

## 10. Build checklist
1. Menu "Master Card" (service `PAYROLL_EMPLOYEES`): screens Groups, Departments (FTE limit), Designations, Shifts, Holidays, Banks. Show the Add / Edit / Delete buttons only with FULL access; with VIEW show the lists only.
2. Delete button only when `canDelete` is true; on `422 IN_USE` show the counts from `details`.
3. Group dropdowns: use `GET /payroll/masters` (active groups only). The 4 defaults are always there.
4. Show the server's `message` for 422 errors (they are written for the user).
5. Test: the first call of `GET /payroll/groups` shows Factory, Outlet, Head Office, Admin; create a department with fte 10 in Factory; a shift 20:00 to 04:00 without Night shift is refused; a holiday for Factory only shows in the filter `groupId=<Factory>` and not in `groupId=<Admin>`.

## 11. Update (employee master, chunk 2)
- Department answers also `employees` (the working employees) and `vacancy` (`fte` minus `employees`, never below 0).
- Group, department, designation, shift and bank answer `employees`; `canDelete` is false while any employee (closed ones too) uses them, and the delete answers `422 IN_USE` with `details.employees`. A department that has employees cannot move to another group (`422 DEPARTMENT_HAS_EMPLOYEES`).
- See `docs/frontend/payroll-employees.md` for the employee card.
