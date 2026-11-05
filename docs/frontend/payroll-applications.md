# Employee Joining Application: frontend guide (chunk 4)
> **CHANGED 2026-11-11:** income tax is now a fixed monthly amount (`monthlyIncomeTax`), `yearlyIncomeTaxPercent` and `monthlyEobiPercent` are gone, and `eobiNo` / `scssiNo` are new. See `docs/frontend/employee-card-changes.md`. Where this page still says percent, read it that way.


Written for: the frontend developer (Payroll > **Applications** tab > Employee Joining Application, and the new Income Tax / EOBI fields of the Employee Master).

## 1. What it is, and how it works
The joining application is **the same form as the Employee Master card**, used for a person who wants to join:
1. HR **prints the blank form** (the frontend builds a print view from the employee form fields; see section 6).
2. The candidate fills it by hand on paper and hands it back with a photo and a CNIC hard copy.
3. HR types the paper form into the application screen and **uploads the scans**: photo, CNIC front, CNIC back, and (optional) the scanned signed form.
4. HR presses **Send for review**. The status becomes **In review**.

Nothing goes into the Employee Master yet. The approval, and turning an approved application into an employee card, is the **next chunk** (do not build that screen yet). A company can still add an employee straight from the Employee Master: both ways exist.

The application has exactly the fields of the employee card (section 3 of `payroll-employees.md`) except: no employee ID, no confirm / close, plus `remarks` (HR's note, up to 500 characters). Use the same form component for both with a different save call.

## 2. Access
Base URL `/api/v1/payroll/applications`. Read: any payroll service (VIEW is enough). Create / change / send / delete / upload: service `PAYROLL_APPLICATIONS` with `FULL` (`403` otherwise). Not logged in = `401`. An application of another company = `404`.

## 3. Tax, EOBI and IBAN fields (also on the Employee Master card)
| Field | Meaning |
|---|---|
| `monthlyIncomeTax` | income tax as a **fixed amount taken every month** (`"5000"` / `"5000.00"`; `"0"` = none). **Replaces** `yearlyIncomeTaxPercent` |
| `eobiNo`, `scssiNo` | optional text up to 30 characters. **Replace** `monthlyEobiPercent` |
| `iban` | optional, kept apart from `accountNo`: **PK + 22 characters** (24 in all: PK, 2 digits, 4 bank letters, 16 letters or digits). Spaces are dropped and capitals are kept; `""` or `null` clears it. A wrong shape is `400 VALIDATION_FAILED` |

Show both in the **bank / payment section** of the form. On the printed form they sit in the **"For office use only"** box.

## 4. Statuses and an application as the server answers it
`status`: `DRAFT` (can be edited and deleted) or `IN_REVIEW` (locked). Use the flags `canEdit`, `canDelete`, `canSubmit`, `canWithdraw` for the buttons.
```json
{ "id": "...", "code": 1, "label": "JA-00001", "status": "DRAFT", "statusText": "Draft", "submittedAt": null,
  "name": "ALI RAZA", "fatherName": null, "cnic": "42301-1448872-9", "ntn": null,
  "group": { "id": "...", "name": "Factory" }, "department": { "id": "...", "name": "Dishwash" }, "designation": { "id": "...", "name": "Worker" },
  "shift": { "id": "...", "code": "08A-07P", "label": "08A-07P (08:00-19:00, 11 hrs)", "dutyHours": 11 }, "joiningDate": "2026-11-01",
  "salaryType": "MONTHLY", "basicSalary": "30000.00", "foodAllowance": "0.00", "maintenanceAllowance": "0.00", "mobileAllowance": "0.00",
  "yearlyIncomeTaxPercent": 5, "monthlyEobiPercent": 1.25, "monthlyDeductions": { "incomeTax": "1500.00", "eobi": "375.00", "total": "1875.00" }, "iban": null,
  "paymentMethod": "CASH", "bank": null, "accountNo": null, "accountTitle": null, "remarks": null,
  "files": { "photo": null, "cnicFront": null, "cnicBack": null, "form": null },
  "canEdit": true, "canDelete": true, "canSubmit": true, "canWithdraw": false, "createdAt": "...", "updatedAt": "..." }
```
`files.photo` etc. are `null` or `{ fileName, mimeType, size, uploadedAt }`. Money is a string with 2 decimals. The payment method is automatic as on the employee card: bank + account number = `BANK`, otherwise `CASH`.

## 5. Calls
| Call | What |
|---|---|
| `GET /applications?status=&groupId=&departmentId=&designationId=&search=&page=&limit=` | the list `{ data, page, limit, total }`, newest first. `search` looks in name, father name, CNIC, phone |
| `GET /applications/summary` | `{ total, draft, inReview }` for the tabs |
| `POST /applications` | save a new application as a **draft**. Required: `name`, `groupId`, `joiningDate`. Everything else can be added later. 201 |
| `GET /applications/:id` | one application |
| `PATCH /applications/:id` | change fields (draft only); at least one field |
| `DELETE /applications/:id` | draft only; 204 (its documents go too) |
| `POST /applications/:id/submit` | Send for review (below) |
| `POST /applications/:id/withdraw` | take it back from In review to Draft, so it can be edited |
| `PUT /applications/:id/files/:kind` | upload a document |
| `GET /applications/:id/files/:kind` | download / show a document (needs the bearer token, so fetch it and use a blob URL, not a plain `<img src>`) |
| `DELETE /applications/:id/files/:kind` | remove a document (draft only) |

**Documents.** `kind` is `photo`, `cnic-front`, `cnic-back` or `form` (the scanned signed paper form). Send the **raw file as the request body** with `Content-Type: image/jpeg`, `image/png` or `application/pdf` (not multipart), up to **2 MB**, and the file name in the `X-File-Name` header. The photo must be JPG or PNG; the others may also be PDF. The type is checked from the file itself, so a renamed file is refused (`422 FILE_TYPE`; `422 FILE_TOO_LARGE`). A new upload replaces the old one. Documents can be uploaded and removed only while the application is a draft.

**Submit** needs these, else `422 APPLICATION_INCOMPLETE` with `details.missing`, a list of: `cnic`, `departmentId`, `designationId`, `shiftId`, `basicSalary`, `accountTitle` (only when paying by bank), and the documents as `file:photo`, `file:cnic-front`, `file:cnic-back`. Show the list as "still missing" on the screen. The scanned form is not required.

## 6. Printing the blank form
Build it in the frontend from the same fields as the employee form (dropdowns come from `GET /payroll/masters`). Layout suggested:
- **Filled by the candidate:** name, father's and mother's name, CNIC, date of birth, gender, marital status, religion, language, phone, email, address, **NTN (optional)**, **bank name / account number / account title (optional)**, space for the photo and a note "attach a CNIC copy (front and back)".
- **"For office use only" box** (HR fills it): group, department, designation, shift, joining date, salary type, basic salary, food, maintenance and mobile allowance, **yearly income tax, monthly EOBI**.
Print the whole form on one page with the company name.

## 7. Errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | a bad value, unknown field, nothing to change |
| `404 NOT_FOUND` | unknown application or file, or of another company |
| `422 APPLICATION_IN_REVIEW` | edit / delete / upload / remove a file while In review: withdraw first |
| `422 ALREADY_IN_REVIEW` / `NOT_IN_REVIEW` | send an application already in review / withdraw one that is not |
| `422 APPLICATION_INCOMPLETE` | submit with details missing (`details.missing`) |
| `422 CNIC_TAKEN` | an employee with this CNIC already exists (or has left: the message says to re-open the old card) |
| `422 CNIC_IN_REVIEW` | another application with this CNIC is already in review |
| `422 NO_VACANCY` | the department's approved strength (fte) is full; `details` has `department`, `fte`, `taken`. A department with fte 0 has no limit. Applications already In review count as taken seats |
| `422 BANK_DETAILS_REQUIRED`, `DEPARTMENT_NOT_IN_GROUP`, `*_INACTIVE`, `FILE_TYPE`, `FILE_TOO_LARGE`, `NO_FILE` | same meaning as on the employee card |

## 8. Build checklist
1. Payroll > Applications: tabs All / Draft / In review (from `summary`), a table, a **New joining application** button, a **Print blank form** button.
2. The form = the employee form + `remarks`; the document uploads (4 slots with preview); Save keeps a draft.
3. A **Send for review** button (when `canSubmit`) showing `details.missing` if refused; a **Withdraw** button (when `canWithdraw`).
4. Employee Master and application form: replace the tax and EOBI amount fields by the two percent fields (`yearlyIncomeTaxPercent`, `monthlyEobiPercent`), add the optional `iban` next to the account number, and show `monthlyDeductions`.
5. Test: create with only name, group and date; submit lists the missing items; fill the rest and upload three documents; submit gives In review and the form turns read only; withdraw, edit, delete; a CNIC of an existing employee is refused.


**Note (2026-10-31).** Read only on every answer: `monthlyDeductions: { incomeTax, eobi, total }`, the amounts the payroll takes each month (percent of the current basic salary, rounded to the cent); show them next to the percents. The approval copies the percents and the IBAN to the employee card.