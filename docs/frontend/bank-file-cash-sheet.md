# Bank Upload File and Cash Sheet — Frontend Guide

Base URL `/api/v1/payroll`. Both work on **one payroll** (a class and a month) and only on its **approved** payslips.

## The idea in one minute
After a payroll is approved, the salary has to reach the employees in two ways:
- **Bank**: the accountant uploads a file to the bank's portal and the bank pays everyone at once. We make that file (**Bank file**).
- **Cash**: the cashier counts the money and puts it in envelopes. We make a printable list with the notes each envelope needs (**Cash sheet**).

Which way an employee is paid is already on the payslip (`paymentMethod`: `BANK` or `CASH`, from the employee card). Nothing new to enter.

Where to put them: on the payroll page (the payslips list of a run) add two buttons: **Bank file** and **Cash sheet**.

## Permissions
- Preview, history, download, cash sheet: any payroll service (VIEW is enough).
- **Make** the bank file (`POST`): `PAYROLL_SALARY` FULL. Hide or disable the button for others (403).

## What goes in (read this first)
- Only payslips with status `APPROVED`. Draft / review / suspended ones are left out; the response says how many are waiting (`notApproved`) so you can show "3 payslips are not approved yet, they are not in this file".
- **scope** (both screens):
  - `unpaid` (default): the amount is what is still unpaid = net − paid. Use this normally. After a part payment the file asks only for the rest.
  - `all`: the whole net salary, even if already paid (to rebuild the original file).
  - A payslip with nothing left to pay is left out of the `unpaid` list; the response counts them in `settled`.
- Bank file = payslips paid by **bank** (`paymentMethod` BANK). Cash sheet = payslips paid in **cash**.

---

## 1. Bank file

### 1a. Preview (nothing is saved)
`GET /runs/:runId/bank-file?scope=unpaid&onlyNew=false`
- `format` is `MEEZAN` (the only bank for now; the response has `formats` for a dropdown when more are added).
- `onlyNew=true`: leave out the payslips already in an earlier file (useful when more payslips were approved after the first file went to the bank).
```
{
  run: { id, code, label, group:{id,name}, month, monthLabel },
  format: { key:"MEEZAN", name:"Meezan Bank", columns:[...] },
  scope, onlyNew, fileName:"Meezan-Bank-salary-Factory-2026-10.csv",
  count: 2, total: "45700.00",
  data: [{ sr, slipId, payslipId, employee:{code,label,name}, accountNo, accountTitle, bankName, amount, details:"Salary October 2026", reference:"SAL-202610-00010",
           alreadyInFile: null | {id, code, label:"BF-00001"} }],
  skipped: [{ slipId, payslipId, employee, reason:"NO_ACCOUNT", message }],
  notApproved: 0, settled: 0, alreadyInFile: 0,
  files: [ ...history, see 1d ], formats: [{key:"MEEZAN", name:"Meezan Bank"}]
}
```
Show it as a table (this is what the bank will get) with the total at the bottom. Show `skipped` in a red box: those employees are **not** in the file and must be fixed (account number on the employee card) and the file made again. Show a row badge when `alreadyInFile` is set ("already in BF-00001").

### 1b. Make the file
`POST /runs/:runId/bank-file` body `{ "format":"MEEZAN", "scope":"unpaid", "onlyNew":false }` (all optional) → **201**
```
{ id, code:1, label:"BF-00001", format, formatName, scope, fileName:"Meezan-Bank-salary-Factory-2026-10-BF00001.csv", employees:2, total:"45700.00",
  createdAt, createdBy:"Name", skipped:[...], rows:[ same rows as the preview ] }
```
- This **saves** the file and puts the **"bank file made" tick** on every payslip in it.
- 422 `NO_ROWS` when nothing can go in (nothing approved / all paid / no account numbers). Show the message.
- Then download it (1c). Suggested button flow: *Make bank file* → success message "BF-00001 made (2 employees, 45,700.00)" → download starts.

### 1c. Download a file
`GET /bank-files/:fileId/download` → CSV file (`Content-Disposition: attachment`). It is the file **exactly as it was made** (even if payments changed later), so downloading again is safe.
It is a file download with the token, so fetch it as a blob:
```js
const res = await fetch(`/api/v1/payroll/bank-files/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
const blob = await res.blob();
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName; a.click();
```
Upload that file to the Meezan portal as it is. Do not open and re-save it in Excel (Excel changes long account numbers).

### 1d. History and "make again"
`GET /runs/:runId/bank-files` → `{ data:[{ id, code, label, format, formatName, scope, fileName, employees, total, createdAt, createdBy }] }`, newest first. Show it as a list under the preview with a **Download** button on each row.
**A file can be made again at any time** (a new `BF-0000N` is created, the older ones stay). A new file moves the tick of its payslips to the new file.

### 1e. The "bank file made" tick
- Each payslip (list and page, `GET /runs/:id/slips`, `GET /slips/:id`) has `bankFile`: `null` or `{ id, code, label:"BF-00002", at }`. Show a small badge/tick "Bank file BF-00002" on the row. `null` = not in any file yet.
- The payroll itself (`GET /runs/:id`) has:
  `bankFile: { bankSlips: 2, inFile: 2, last: null | { id, code, label, fileName, employees, total, at } }`
  → show "Bank file: 2 of 2 payslips · last BF-00002 on 3 Nov" or "Not made yet" when `last` is null; a yellow note when `inFile < bankSlips`.
- If an approved payslip is **sent back to Draft** its tick disappears (the file no longer matches the payroll). Make the file again after it is approved again.

### 1f. The file layout (Meezan Bank)
CSV, one header row, one row per employee, **no total line**:

| Sr No | Beneficiary Account No / IBAN | Beneficiary Title | Beneficiary Bank | Transfer Type | Amount | Payment Details | Reference No |
|---|---|---|---|---|---|---|---|
| 1 | 0123456789012 | Zaid Khan | Meezan Bank | Within Meezan | 22850.00 | Salary October 2026 | SAL-202610-00010 |

Account numbers have spaces and dashes removed. Amount is plain (no commas). `Transfer Type` is "Within Meezan" when the employee's bank is Meezan, otherwise "Other Bank (IBFT)". The layout is one place in the backend; if the bank's real template differs, only the backend changes, the API stays the same.

---

## 2. Cash sheet

`GET /runs/:runId/cash-sheet?scope=unpaid&denominations=5000,1000,500,100,50,20,10&format=json|xlsx|pdf`
- `denominations` is optional (this list is the default). Let the user untick a note nobody has (e.g. no 5000) and send the rest, e.g. `1000,500,100,50,20,10`.
- `format=json` (default) for the screen; `xlsx` = Excel; `pdf` = print-ready (landscape A4, signature column). Open the file formats with the token as a blob, as above.
```
{
  run: {...}, scope, denominations:[5000,1000,500,100,50,20,10],
  data: [{ sr, slipId, payslipId, employee:{code,label,name,department,designation}, amount:"50650.00",
           notes:{ "5000":10, "1000":0, "500":1, "100":1, "50":1, "20":0, "10":0 }, rest:"0.00" }],
  totals: { employees, amount:"86301.00", rest:"1.00", notes:{ "5000":17, ... },
            noteValues:[{ denomination:5000, count:17, value:"85000.00" }, ...] },
  notApproved: 0, settled: 0
}
```
- **Table columns**: Sr, ID, Name, Department, Amount, one column per denomination (in `denominations` order, show `-` for 0), Rest, Signature (empty box for the employee).
- **Rest** = what is under the smallest note (coins, e.g. 1–9 rupees).
- Each row uses the fewest notes (biggest note first). This is the envelope: "10 × 5000 + 1 × 500 + 1 × 100 + 1 × 50".
- **Notes to bring from the bank** = `totals.noteValues` (+ `totals.rest` as coins). Show it as a small box: "5000 × 17 = 85,000.00 … Coins 1.00 · Total cash 86,301.00". These always add up to `totals.amount`.
- `data` is empty when there is no approved cash payslip waiting.

## Errors
| Status / code | When |
|---|---|
| 404 | the payroll / file is not of your company |
| 403 | no payroll service, or `POST` without PAYROLL_SALARY FULL |
| 400 | wrong `format`, `scope` or `denominations` (e.g. `abc`) |
| 422 `NO_ROWS` | the bank file would be empty |

## Not built
Other banks' layouts (only Meezan), a "mark as paid" from the file (payment is still recorded with the Salary Payment Voucher), bank statement reconciliation.
