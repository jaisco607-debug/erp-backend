# EOBI Contribution List (Reports → "Employees Contribution") + EOBI Voucher — Frontend Guide

Base URL `/api/v1`. All amounts are decimal strings (`"2035.00"`) except the voucher endpoints, which return numbers. Months are `YYYY-MM`.

## Permissions
- Read (rates, lists, candidates, summary, providers): any payroll service (VIEW).
- Change (providers, locations, rates, lists, rows, import): `PAYROLL_REPORTS` FULL. Hide the buttons otherwise.
- EOBI voucher (`/eobi-vouchers`): `ACC_PAYMENTS` (VIEW to read, FULL to change).

## 1. Masters ("Master" button)
- `GET /payroll/eobi/providers` → `{data:[{id,name,code,isActive,locations:[{id,name,code,isActive}]}]}`
- `POST /payroll/eobi/providers {name, code?}` · `PATCH /payroll/eobi/providers/:id {name?, code?, isActive?}` · `DELETE /payroll/eobi/providers/:id`
- `POST /payroll/eobi/locations {providerId, name, code?}` · `PATCH/DELETE /payroll/eobi/locations/:id`
- Errors: `NAME_TAKEN` (422), `IN_USE` (422, cannot delete while a list uses it).

## 2. EOBI rates (table + form)
- `GET /payroll/eobi/rates?month=2026-10` → `{line, data:[{id, month, monthLabel, wage, employerPercent, employeePercent, employer, employee, perEmployee, inEffect, isStart}]}`
  - `line` is ready text: `EOBI rate for Oct 2026: wage 40,700 · employer 5% = 2,035 · employee 1% = 407`.
  - `inEffect` marks the rate that applies to the requested month; the first rate shows as "start".
- `PUT /payroll/eobi/rates {month, wage, employerPercent, employeePercent, recalculate?}` — saving the same month again changes it. A rate applies from its month until the next rate. `recalculate: true` re-works that month's lists (response has `recalculated`).
- `DELETE /payroll/eobi/rates/:id`.

## 3. The list for a provider + month
`GET /payroll/eobi/lists?providerId&month&search?&locationId?(uuid|"none")&page&limit`
Returns:
- `list` (null if none yet) and `copyFrom: {month, monthLabel, employees}` when a previous list exists → show **Create from previous month** / **Create empty**.
- `rate` (with `line`), `cards: {employees, withoutLocation, employer, employeeShare, deducted, differ, totalPayable}`.
- `byLocation: [{locationId, name, employees, total, voucher:{id,label,status}|null, locked, canVoucher, hint}]` — one voucher block per location; `locationId:null` is "(not set)" and has `hint: "assign a location first"`.
- `rows: [{id, employee:{id,code,label,name,department}, location, wage, employer, employeeShare, total, deducted, deductedStatus, differs, slipId, locked, source}]`, `total`, `notOnAnyList`.
- `differs` = what the payslip deducts differs from the list's employee share; highlight it.

Create: `POST /payroll/eobi/lists {providerId, month, mode:'COPY'|'EMPTY', copyFromMonth?}` → 201 with the view plus `copied, copiedFrom, skippedLeavers[], skippedOtherList[]`. Leavers and employees on another provider's list are not copied. Errors: `LIST_EXISTS`, `NO_PREVIOUS_LIST`, `NO_EOBI_RATE`.
Delete: `DELETE /payroll/eobi/lists/:id` (`LIST_HAS_VOUCHER` if a voucher is confirmed; draft vouchers go with it).

## 4. Add employees box
- Search: `GET /payroll/eobi/lists/:id/candidates?search=` (name, employee ID or CNIC; with or without dashes) → `{data:[{id,code,label,name,cnic,department}], total}`. Only employees not on any list this month appear.
- Add: `POST /payroll/eobi/lists/:id/rows {employeeIds:[...], locationId?}` → `{added, skipped:[{code, reason}]}`, reasons `ALREADY_ON_LIST`, `ON_OTHER_LIST` (with `provider`), `EMPLOYEE_CLOSED`. The existing employees are kept; just add the extra ones (30 → 35).
- Remove ticked: `POST /payroll/eobi/lists/:id/rows/remove {rowIds}` → `{removed}`.
- Save locations / set for ticked: `PUT /payroll/eobi/lists/:id/rows/locations {items:[{rowId, locationId|null}]}`.
- Re-work amounts: `POST /payroll/eobi/lists/:id/recalculate` → `{updated, locked}`.
- Errors: `ROW_LOCKED`, `LOCATION_LOCKED` (location has a confirmed voucher), `LOCATION_INACTIVE`, `NO_EOBI_RATE`.

## 5. Excel import
Parse the sheet in the browser and send rows:
`POST /payroll/eobi/lists/:id/import {rows:[{employeeId?, cnic?, location?}], locationId?, dryRun?}`
- `location` is a location name from the sheet; `locationId` is the default for rows without one.
- Send `dryRun:true` first to preview; response `{dryRun, total, added, notAdded, results:[{row, status, employee?, provider?}]}`.
- Statuses: `ADDED, NO_ID, NOT_FOUND, DUPLICATE_IN_FILE, EMPLOYEE_CLOSED, ALREADY_ON_LIST, ON_OTHER_LIST, UNKNOWN_LOCATION, LOCATION_LOCKED`. Show not-added rows with their reason, then call again without `dryRun` to save.

## 6. Summary button
`GET /payroll/eobi/summary?providerId&year=2026` → 12 months `{month, hasList, employees, employer, employeeShare, totalPayable, deducted, vouchers}`.

## 7. EOBI Contribution Voucher (Accounts → Payments)
Prefix `EOV-00001`. One voucher per provider + location + month.
- `GET /eobi-vouchers/locations?month=&providerId?` → picker `[{provider, location, employees, employer, employeeShare, total, voucher}]`.
- `GET /eobi-vouchers?month&status&search&page` · `GET /eobi-vouchers/:id` (with employee `lines`).
- `POST /eobi-vouchers {providerId, locationId, month, payFromAccountId, paymentMode, voucherDate?, chequeDate?, chequeNo?, refNo?, notes?}`
- `PATCH /eobi-vouchers/:id` · `DELETE /eobi-vouchers/:id` (draft only)
- `POST /eobi-vouchers/:id/confirm` · `POST /eobi-vouchers/:id/unconfirm {reason}` · `GET /eobi-vouchers/:id/accounts-entry`
- Errors: `NO_LIST`, `NO_EMPLOYEES`, `VOUCHER_EXISTS`, `NOT_BANK_OR_CASH`, `VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED`.
- Posting on confirm: **Dr EOBI Payable** (employees' shares) + **Dr EOBI Employer Contribution** (company's share) / **Cr Bank or Cash**. Confirming locks that location's rows; moving back to draft reverses the entry and unlocks.
- The new default account **EOBI_EMPLOYER_EXPENSE** ("EOBI Employer Contribution") appears in Chart of Accounts → Defaults, group PAYROLL.

## 8. Payroll link
When an employee is on that month's list, the payslip EOBI deduction = the list's employee share (`eobiSource: "LIST"`). Otherwise it uses the card percent (`"PERCENT"`); a figure typed by HR stays `"MANUAL"`. Slips refresh on Calculate / Get attendance.

## Not built
SESSI, slab-based income tax, EOBI/SESSI report files.
