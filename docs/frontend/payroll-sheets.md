# Salary Sheet, Attendance Sheet, Payslip PDF + allowance pro-rata — Frontend Guide

Base URL `/api/v1/payroll`. Permission: any payroll service (VIEW is enough). Every endpoint is scoped to the company in the token; another company's payroll gives 404.

## 1. Salary Sheet (all employees of one payroll, every column, totals)
`GET /runs/:runId/salary-sheet` → JSON for the screen/print.
`GET /runs/:runId/salary-sheet?format=xlsx` → Excel file (download; frozen header, totals row).

JSON:
```
{
  run: { id, code, label, group:{id,name}, month, monthLabel:"October 2026", daysInMonth },
  data: [{
    sr, slipId, payslipId, status, statusText,
    employee:{ code, label, name, department, designation },
    salaryType, basicSalary,
    days:{P,L,HD,A,R,AL,total}, payableDays, overtimeHours,
    gross, food, maintenance, mobile, othersAdd, additions,
    loan, eobi, incomeTax, othersDeduct, deductions,
    net, contribution, paid, balance, paymentMethod, bank:{name,accountNo,accountTitle},
    countedInTotals            // false for a SUSPENDED payslip: show it greyed, it is not in the totals
  }],
  totals: { employees, basicSalary, gross, food, maintenance, mobile, othersAdd, additions, loan, eobi, incomeTax, othersDeduct, deductions, net, contribution, paid, balance }
}
```
- Money = decimal strings with 2 decimals. Suspended payslips are left out of `totals`.
- `paid` and `balance` count **approved** payslips only (balance = net - paid). `balance` of a row is `0.00` until the payslip is approved.
- `totals.balance` equals the "Salary balance" of the Payroll Summary row of that payroll.

## 2. Attendance Sheet (day codes per employee for the month)
`GET /runs/:runId/attendance-sheet` (JSON) · `?format=xlsx` (Excel).
```
{
  run: {...same as above},
  dates:  [{ date:"2026-10-01", day:1, weekday:"Thu" }, ...],     // one per day of the month: the table columns
  legend: [{ code:"P", text:"Present" }, ... "-" = not employed / no data],
  data: [{ sr, slipId, status, employee:{code,label,name,department},
           codes:["P","P","P","R",null,...],                    // same order as dates; null = no record
           counts:{P,L,HD,A,R,AL}, payableDays, overtimeHours }]
}
```
The codes are the ones the payslip holds (after HR edits), so the sheet always agrees with the payslip.

## 3. Payslip PDF
- One payslip: `GET /slips/:slipId/pdf` → `application/pdf` (open in a new tab, or download).
- All payslips of a payroll in one file, one page each (suspended ones left out): `GET /runs/:runId/payslips.pdf`. 422 `NO_PAYSLIPS` if there is nothing to print.
- Contents: company name, month, payroll # and payslip ID, employee details and payment method, attendance summary (P L HD A R AL, paid days, OT hrs), earnings (basic earned, overtime, gross, food, maintenance, mobile, other additions), deductions (loan, EOBI, income tax, others), net pay, paid, balance. A payslip that is not approved is stamped with its status (DRAFT, REVIEW, ...).
- A plain `<a href>` cannot send the Authorization header, so fetch the file with the token as a blob and open the object URL.

How to download with the token (all file endpoints):
```js
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const blob = await res.blob();
window.open(URL.createObjectURL(blob));       // PDF
// Excel: create an <a download="salary-sheet.xlsx"> with the object URL and click it
```

## 4. Change that affects the payslip screen: food / maintenance are pro-rata
- Food and maintenance are now paid **pro-rata on the days worked**: `amount / days in month × (P + L + HD + R)`, rounded to the rupee, never more than the full amount. Mobile is paid in full. A **FIXED** salary type gets food and maintenance in full.
- Payslip JSON `additions` now also has `foodFull` and `maintenanceFull` (the employee-card amounts, or `null` on payslips made before this change, which keep their old amounts). Show them as "of 3,100.00" next to the pro-rata figure.
- If HR types a food or maintenance figure on the payslip it is kept (`overrides` contains `food` / `maintenance`); **Calculate** with `{auto:true}` gives it back to the days. A normal Calculate or editing a day recomputes the pro-rata.

## Not built
Bank upload file and cash sheet, EOBI/SESSI/tax certificate PDFs.
