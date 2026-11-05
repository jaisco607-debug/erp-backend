# Employee Income Tax (edit, Excel upload, report) + Salary Tax Voucher — Frontend Guide

Base URL `/api/v1`. Months are `YYYY-MM`. Amounts in `/payroll/*` are decimal strings (`"12500.00"`); the voucher endpoints return numbers.

## How the tax works
- The tax is **withheld from the employee's salary** (the company does not pay a share). The payroll deducts it on every payslip.
- Each employee has a **tax history**: from a month on, either a **fixed monthly amount** (what the government fixed for his salary) or a **percent of his basic**. A payslip of a month uses the latest row not later than that month. An employee with no row keeps the **percent of his card** (`yearlyIncomeTaxPercent`).
- When the government raises the tax for the new year: add a row from that month (by hand, or by uploading the sheet). Older months are untouched.
- A payslip keeps its figure until it is calculated again (**Calculate** or **Get attendance** on the payslip). A figure typed by HR on the payslip stays (`taxSource: "MANUAL"`) until Calculate with `auto: true`.

## Permissions
- Read: any payroll service (VIEW). Change (edit, upload, delete): `PAYROLL_EMPLOYEES` FULL. Voucher: `ACC_PAYMENTS`.

## 1. Employee list with tax column
`GET /payroll/income-tax?month=2026-10&search=&groupId=&departmentId=&source=&page=&limit=`
- `search`: name, employee ID or CNIC. `source`: `AMOUNT | PERCENT | CARD | NONE`.
- Response: `{month, monthLabel, total, summary:{employees, withTax, withoutTax}, data:[{employee:{id,code,label,name,cnic,department,designation,group}, salaryType, basicSalary, monthlyAmount, percent, monthlyTax, estimated, source, effectiveFrom, cardAmount}]}`.
- `monthlyTax` = what the payroll will take in that month. `estimated:true` = a percent on a DAILY wage (the real figure depends on the days worked).
- `source`: `AMOUNT` fixed amount, `PERCENT` percent from the history, `CARD` percent of the employee card, `NONE` no tax.

## 2. Edit one employee (inline edit)
`PUT /payroll/income-tax/employees/:employeeId` body `{effectiveFrom?: "2026-11", monthlyAmount?: 12500, percent?: 2.5}`
- Send **either** `monthlyAmount` **or** `percent` (both → `AMOUNT_OR_PERCENT` 422). `monthlyAmount: 0` = no tax from that month. `effectiveFrom` defaults to the current month; the same month again changes the row.
- Works on confirmed employees (no need to un-confirm the card). Errors: `EMPLOYEE_CLOSED`, `EMPLOYEE_NOT_CONFIRMED`.
- Returns the history (below).
- `GET /payroll/income-tax/employees/:id` → `{employee, basicSalary, cardAmount, data:[{id, month, monthLabel, monthlyAmount, percent, monthlyTax, source:'MANUAL'|'EXCEL', by, createdAt}]}` newest first.
- `DELETE /payroll/income-tax/:rowId` (204) removes one row; the earlier row (or the card percent) applies again.

## 3. Excel upload (on the employee list)
Read the sheet in the browser (columns: **Employee ID** and/or **CNIC**, and **Tax** (monthly amount) or **Percent**) and send:
`POST /payroll/income-tax/import` body `{effectiveFrom: "2027-01", dryRun?: true, rows:[{employeeId, cnic, monthlyAmount | tax, percent}]}`
- Always show a preview first with `dryRun: true`, then send again without it to save.
- An employee is found by ID, else by CNIC (dashes optional). A row has an amount **or** a percent. Amounts may contain commas.
- Response: `{dryRun, effectiveFrom, effectiveFromLabel, total, updated, unchanged, notUsed, counts, results:[{row, employeeId, cnic, monthlyAmount, percent, employee?, status}]}`.
- Row `status`: `UPDATED, UNCHANGED, NO_ID, NOT_FOUND, DUPLICATE_IN_FILE, EMPLOYEE_CLOSED, EMPLOYEE_NOT_CONFIRMED, INVALID_VALUE, NO_TAX_VALUE, AMOUNT_AND_PERCENT`. Show not-used rows with the reason.

## 4. Payslip
`GET /payroll/slips/:id` and the slips list now include `taxSource`: `AMOUNT | PERCENT | MANUAL | NONE`, next to `deductions.incomeTax`.

## 5. Tax report (Reports)
`GET /payroll/income-tax/report?month=2026-10&groupId=&search=&page=&limit=`
- `cards:{employees, deducted, approved, paidToGovernment, onDraftVoucher, toPay}`.
- `data:[{slipId, employee:{code,label,name,cnic,department}, basicSalary, gross, tax, slipStatus, voucher:{id,label,status}|null, paymentStatus:'NOT_APPROVED'|'UNPAID'|'ON_VOUCHER'|'PAID'}]`.

## 6. Salary Tax Voucher (Accounts → Payments)
Label `STV-00001`. Pays the tax withheld on **approved** payslips of a month to the government.
- `GET /salary-tax-vouchers/slips?month=2026-10` → picker `{employees, amount, onVouchers, data:[{slipId, employee, tax}]}` (approved payslips with tax not yet on a voucher).
- `POST /salary-tax-vouchers {month, payFromAccountId, paymentMode, slipIds?, voucherDate?, chequeDate?, chequeNo?, refNo?, notes?}` — without `slipIds` all waiting payslips of the month are taken. Several vouchers can pay one month.
- `GET /salary-tax-vouchers?month&status&search&page` · `GET /salary-tax-vouchers/:id` (with `lines`) · `PATCH /salary-tax-vouchers/:id` (header only) · `DELETE` (draft only)
- `POST /salary-tax-vouchers/:id/confirm` · `POST /salary-tax-vouchers/:id/unconfirm {reason}` · `GET /salary-tax-vouchers/:id/accounts-entry`
- Errors: `NOTHING_TO_PAY, SLIP_NOT_AVAILABLE, SLIP_IN_A_VOUCHER, NOT_BANK_OR_CASH, VOUCHER_CONFIRMED, ALREADY_CONFIRMED, NOT_CONFIRMED, SLIP_CHANGED`.
- Accounting: approving a payslip posts **Cr Income Tax Payable - Salaries** (the withheld tax); confirming the voucher posts **Dr Income Tax Payable - Salaries / Cr Bank or Cash**. Un-confirm reverses it.
- A payslip that is on a salary tax voucher cannot be sent back to Draft (`SLIP_TAX_ON_VOUCHER` 422): delete the voucher first.

## Not built
Slab-based tax computed from the annual salary, tax certificates / FBR files.
