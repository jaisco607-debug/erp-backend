# Payroll: Employee master (Employees Profile): frontend guide (chunk 2)
> **CHANGED 2026-11-11:** income tax is now a fixed monthly amount (`monthlyIncomeTax`), `yearlyIncomeTaxPercent` and `monthlyEobiPercent` are gone, and `eobiNo` / `scssiNo` are new. See `docs/frontend/employee-card-changes.md`. Where this page still says percent, read it that way.


Written for: the frontend developer (Payroll > Master Card > Employees Profile). It builds on the masters of `docs/frontend/payroll-masters.md` (groups, departments, designations, shifts, banks).

## 1. Access
- Base URL `/api/v1/payroll/employees`. Company people only.
- **Read** (list, summary, one card, download a document): anyone with ANY payroll service (VIEW is enough).
- **Change** (create, edit, confirm, un-confirm, close, re-open, delete, upload / delete a document): service `PAYROLL_EMPLOYEES` with `FULL`. Others get `403`. Not logged in = `401`. A card of another company is `404`.
- Show the buttons of changing only with FULL access.

## 2. The card (what the server answers)
```json
{
  "id": "...", "code": 7, "label": "00007", "name": "MUHAMMAD BILAL", "fatherName": "MUHAMMAD SALEEM", "motherName": "SABRA SALEEM",
  "cnic": "42301-1448872-9", "ntn": null, "dateOfBirth": null, "gender": null, "maritalStatus": null, "religion": "Islam", "language": null,
  "phone": "923158652242", "email": null, "address": null,
  "group": { "id": "...", "name": "Admin" },
  "department": { "id": "...", "name": "Audit" }, "designation": { "id": "...", "name": "Auditor" },
  "shift": { "id": "...", "code": "08A-07P", "label": "08A-07P (08:00-19:00, 11 hrs)", "dutyHours": 11 },
  "joiningDate": "2022-04-26", "leavingDate": null, "serviceText": "4y 6m",
  "isClosed": false, "state": "ACTIVE", "status": "CONFIRMED", "statusText": "Confirmed", "confirmedAt": "...",
  "salaryType": "MONTHLY", "basicSalary": "89000.00", "foodAllowance": "0.00", "maintenanceAllowance": "10000.00", "mobileAllowance": "1000.00", "yearlyIncomeTaxPercent": 5, "monthlyEobiPercent": 1.25, "monthlyDeductions": { "incomeTax": "4450.00", "eobi": "1112.50", "total": "5562.50" }, "iban": null,
  "paymentMethod": "BANK", "bank": { "id": "...", "name": "Meezan Bank" }, "accountNo": "0103308659", "accountTitle": "Muhammad Bilal",
  "files": { "photo": { "fileName": "bilal.jpg", "mimeType": "image/jpeg", "size": 48213, "uploadedAt": "..." }, "cnicFront": null, "cnicBack": null },
  "canEdit": false, "canConfirm": false, "canUnconfirm": true, "canDelete": false, "canClose": true, "canReopen": false,
  "createdAt": "...", "updatedAt": "..."
}
```
- `label` = the ID as printed ("00007"); `code` = the number. `serviceText` = time since joining ("4y 6m").
- **Money is a string with 2 decimals** ("89000.00"); `yearlyIncomeTaxPercent`, `monthlyEobiPercent` and `iban` are `null` when there is none. Names are kept in CAPITALS by the server.
- `department`, `designation`, `shift`, `bank` are `null` when not set.
- `files.photo / cnicFront / cnicBack`: `null` = MISSING, an object = ATTACHED (the screen's "PHOTO ATTACHED / CNIC FRONT MISSING").
- Use the `can...` flags for the buttons (Edit, Confirm, Delete, Close, Re-open); do not work them out yourself.

## 3. List and the tabs
`GET /employees` answers `{ data: [card...], page, limit, total }` sorted by ID. Query (all optional):

| Param | Meaning |
|---|---|
| `closed` | `false` (default) = the working employees, `true` = the closed ones (the "Closed" tab), `all` = both |
| `groupId`, `departmentId`, `designationId`, `shiftId` | filters |
| `status` | `DRAFT` or `CONFIRMED` |
| `code` | the Employee ID (number), exact |
| `name` | part of the name |
| `cnicOrCell` | part of the CNIC (with or without dashes) or of the phone |
| `search` | one box: name, father's name, CNIC, phone, department, or the ID (a number such as `00007` or `7`) |
| `page`, `limit` | `limit` default 100, **max 1000** (use a big limit for Export) |

`GET /employees/summary` (the numbers on the tabs):
```json
{ "total": 272, "closed": 566, "draft": 3, "confirmed": 269,
  "groups": [ { "id": "...", "name": "Factory", "isDefault": true, "isActive": true, "employees": 115, "closed": 200 } ] }
```
`total` = working employees ("All 272"); each group's `employees` = the number on its tab; `closed` = the "Closed" tab. Call it when the page opens and after a change.

## 4. Create and edit
`POST /employees` (201) and `PATCH /employees/:id` (send only what changed; at least one field).

Required to create: `name` (2 to 150 characters), `groupId`, `joiningDate`. Everything else is optional while the card is a draft:

| Field | Notes |
|---|---|
| `code` (create only) | the Employee ID; not sent = the next free number; a number already used = `422 CODE_TAKEN` (to keep the IDs of an old system) |
| `name`, `fatherName`, `motherName` | made capital by the server |
| `cnic` | 13 digits with or without dashes (`4230114488729` or `42301-1448872-9`), saved as `42301-1448872-9`. Unique in the company (`422 CNIC_TAKEN`). `""` or `null` = none |
| `ntn`, `religion`, `language`, `address` | text |
| `dateOfBirth`, `joiningDate` | `YYYY-MM-DD` |
| `gender` | `MALE` / `FEMALE` / `OTHER` or `null` |
| `maritalStatus` | `SINGLE` / `MARRIED` / `DIVORCED` / `WIDOWED` or `null` |
| `phone` | digits, spaces, `+ - ( )`, 7 to 30 characters |
| `email` | a valid email |
| `groupId` | one of the company's groups, switched on |
| `departmentId` | a department **of that group** (`422 DEPARTMENT_NOT_IN_GROUP`), switched on |
| `designationId`, `shiftId` | the company's own, switched on |
| `salaryType` | `MONTHLY` (default) / `FIXED` / `DAILY` |
| `basicSalary`, `foodAllowance`, `maintenanceAllowance`, `mobileAllowance` | an amount: a number or text with at most 2 decimals, 0 or more (`89000`, `"50750.50"`); default 0 |
| `monthlyIncomeTax` | income tax as a **fixed amount taken every month** (string like `"5000"` or `"5000.00"`, 2 decimals at most, not negative; `"0"` = none). **Replaces** `yearlyIncomeTaxPercent` |
| `eobiNo`, `scssiNo` | the EOBI number and the SESSI / SCSSI number: optional text, up to 30 characters, no format; `null` or empty = none. **Replace** `monthlyEobiPercent` (EOBI now comes from the EOBI module) |
| `iban` | optional, kept apart from `accountNo`: **PK + 22 characters** (24 in all: PK, 2 digits, 4 bank letters, 16 letters or digits). Spaces are dropped and capitals are kept; `""` or `null` clears it. A wrong shape is `400 VALIDATION_FAILED` |
| `paymentMethod`, `bankId`, `accountNo`, `accountTitle` | see below |

**Payment: "no bank account = cash automatically".**
- Do not send `paymentMethod` and the server decides: bank + account number given = `BANK`, otherwise `CASH`. It follows when you add or remove the bank details.
- `paymentMethod: "CASH"` on purpose keeps cash even when bank details exist.
- `paymentMethod: "BANK"` without `bankId` and `accountNo` = `422 BANK_DETAILS_REQUIRED`.
- A card that pays by bank also needs `accountTitle` before it can be confirmed.

Links errors: `404 NOT_FOUND` (not the company's own), `422 GROUP_INACTIVE / DEPARTMENT_INACTIVE / DESIGNATION_INACTIVE / SHIFT_INACTIVE / BANK_INACTIVE` (a newly chosen one is switched off). Changing the group needs a department of the new group in the same request (send `departmentId: null` to clear it).
Wrong shapes (bad CNIC, 3 decimals, negative amount, unknown or extra field such as `status` or `isClosed`) = `400 VALIDATION_FAILED`.

The head-count (`fte`) of a department is shown (`employees`, `vacancy` in the departments list) but **not enforced** here: an employee can be created even when the department is full. The joining application (later) will block it.

## 5. The status of a card (Draft / Confirmed) and Closed
| Call | What |
|---|---|
| `POST /employees/:id/confirm` | Draft -> Confirmed (the card is locked) |
| `POST /employees/:id/unconfirm` | Confirmed -> Draft (the screen's **Edit** button) |
| `POST /employees/:id/close` body `{ "leavingDate": "2026-10-15" }` | the employee has left ("Closed (left the company)") |
| `POST /employees/:id/reopen` | takes a closed employee back (the leaving date is cleared) |
| `DELETE /employees/:id` | 204; only a **Draft** card |

Rules:
- A confirmed card is locked: `PATCH` = `422 EMPLOYEE_CONFIRMED` ("press Edit first"). Show the blue "Confirmed - this record is locked. Press Edit to move it back to Draft." bar and call `unconfirm` when the user presses Edit.
- **Confirm** needs: CNIC, department, designation, shift, a basic salary above 0 (and the account title if paid by bank). Missing ones = `422 EMPLOYEE_INCOMPLETE` with `details.missing`, e.g. `["cnic","shiftId"]` (field names of the card): mark those fields.
- A closed card is read only: `PATCH`, `confirm`, `unconfirm` = `422 EMPLOYEE_CLOSED` until re-opened. Documents can still be changed.
- Close: `422 LEAVING_BEFORE_JOINING` when the date is before the joining date; `422 ALREADY_CLOSED`. Re-open: `422 NOT_CLOSED`.
- A closed employee is never added to a new payroll (later).
- Delete of a confirmed card = `422 EMPLOYEE_CONFIRMED` (un-confirm first, or close the employee). When payslips exist (later), employees will not be deletable at all: always trust `canDelete`.

## 6. Documents (photo, CNIC front, CNIC back)
**How files are kept:** inside the database (not on a disk, not on a cloud service): one row per document, up to **2 MB**, so the files move, back up and deploy together with the data. JPG, PNG, or PDF only (the **photo must be JPG or PNG**; CNIC front / back may also be a PDF). The server reads the real type from the file's first bytes, so a renamed file is refused. One file per kind; a new upload replaces the old one.

Kinds (the `:kind` in the URL): `photo`, `cnic-front`, `cnic-back`.

**Upload: `PUT /employees/:id/files/:kind`**
- The file itself is the **body** of the request, NOT multipart / FormData and not JSON.
- `Content-Type`: the file's type (`image/jpeg`, `image/png`, `application/pdf`; `application/octet-stream` also works).
- Header `X-File-Name`: the file name (encode it with `encodeURIComponent`; optional).
- Plus the usual `Authorization: Bearer ...`.
```js
await fetch(`/api/v1/payroll/employees/${id}/files/photo`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
  body: file,   // the File / Blob from <input type="file">
});
```
- Answer: the whole card (`files.photo` filled in). Errors: `413 TOO_LARGE` (more than 2 MB: check the size in the browser first), `422 FILE_TYPE` (not JPG / PNG / PDF, or a PDF for the photo), `422 NO_FILE` (empty body).
- Any status of the card may get documents (the CNIC often arrives after the card is confirmed).

**Download / show: `GET /employees/:id/files/:kind`**
- Answers the file bytes with its own `Content-Type`; `404` when there is no such document.
- It needs the login token in the `Authorization` header, so an `<img src=...>` or a link cannot open it directly. Fetch it with the token and show it from a blob URL:
```js
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
img.src = URL.createObjectURL(await res.blob());   // free it later with URL.revokeObjectURL
```
- Fetch the photo of each row only when it is on screen (do not download 272 photos at once). The list only says whether a document exists (`files.photo` is `null` or not), it never contains the bytes.

**Delete a document: `DELETE /employees/:id/files/:kind`** (answers the card; `404` if there is none).

## 7. Related changes in the masters (`/payroll/...`)
- Department: new `employees` (working employees) and `vacancy` (`fte` minus `employees`, never below 0).
- Group, department, designation, shift, bank: `employees` count; `canDelete` is false while any employee (closed ones too) uses it, and delete answers `422 IN_USE` with `details.employees`.
- A department that has employees cannot be moved to another group (`422 DEPARTMENT_HAS_EMPLOYEES`).

## 8. Build checklist
1. Employee Master list: tabs from `GET /employees/summary` (All = `total`, one per group, Closed = `closed`); the filters (Employee ID = `code`, Name = `name`, CNIC / Cell = `cnicOrCell`, Department = `departmentId`); Export with a big `limit`; Create button only with FULL access.
2. Create / edit form tabs: Personal, Bank, Work, Salary, CNIC (documents). Fill dropdowns from `GET /payroll/masters` (departments filtered by the chosen group).
3. Card header: ID (`label`), name, `statusText` badge, ACTIVE / CLOSED (`state`); the left card: photo, joined, service (`serviceText`), salary, CNIC, phone, and the ATTACHED / MISSING marks from `files`.
4. Buttons from the `can...` flags: Edit (= `unconfirm`), Confirm, Close (asks for the leaving date), Re-open, Delete.
5. Show `details.missing` of `EMPLOYEE_INCOMPLETE` on the fields. Show the server's `message` for every 422.
6. Documents: upload with the raw body as in section 6; check the 2 MB limit in the browser; show images through a blob URL.
7. Tabs "Payslips", "Payments", "Loans", "Donations" come with their own modules later.


**Tax, EOBI and IBAN (2026-10-31).** Read only on every answer: `monthlyDeductions: { incomeTax, eobi, total }`, the amounts the payroll takes each month (percent of the current basic salary, rounded to the cent); show them next to the percents.