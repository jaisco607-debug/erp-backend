# Employee card and Joining Application — field changes (2026-11-11)

Same field names on both: `/api/v1/payroll/employees` and `/api/v1/payroll/applications` (+ `/joining` forms). Names are exactly what the frontend already uses.

## 1. Income tax is a fixed monthly amount
- **Removed:** `yearlyIncomeTaxPercent`.
- **New:** `monthlyIncomeTax`: a money string, at most 2 decimals, not negative, optional. Create / PATCH accept `"5000"` or `"5000.00"` (a plain number is accepted too). Send `"0"` to clear (`null` also means 0).
- `"-1"`, `"1.234"`, `"abc"` → **400** `VALIDATION_FAILED`, field `monthlyIncomeTax`.
- GET always returns a 2-decimal string: `"5000.00"`, `"0.00"` when none.
- Meaning: the whole amount is taken from the employee's salary **every month**. It is not a percent and not divided by 12.
- The payslip's income-tax deduction is this amount, and `monthlyDeductions.incomeTax` on the card shows the same.
- Order of use on a payslip (unchanged): the employee's **income tax history** (Payroll > Income Tax: amount or percent from a month) first; if he has no history row, the card's `monthlyIncomeTax`. Old cards that had a percent were converted once to an amount (percent of the basic, rounded to the rupee).
- **Joining Application:** the reviewer can edit `monthlyIncomeTax` (`PATCH /applications/:id/review`). On approve it is copied to the new employee card.

## 2. EOBI percent removed
- **Removed everywhere:** `monthlyEobiPercent` (create, PATCH, GET, the reviewer's list). Sending it now gives 400 (unknown field).
- EOBI is deducted from the **EOBI module** (Payroll > EOBI contribution list): the employee share of the month's list. An employee on no list has 0.
- `monthlyDeductions` is still in the response: `{ incomeTax, eobi, total }`. On the **employee card** `eobi` is the share on the current month's EOBI list (`"0.00"` if he is not on one). On an **application** it is `"0.00"` (there is no employee yet).

## 3. New optional fields `eobiNo` and `scssiNo`
- Optional strings, trimmed, **max 30 characters**, no format check. Empty string or `null` = none. GET returns `null` when empty.
- On the employee card and the Joining Application (create / PATCH). On approve they are copied from the application to the card.
- Never required: not for confirm, not for send-for-review, never in a `missing` list.
- Over 30 characters → 400, field `eobiNo` / `scssiNo`.

## 4. No bank on the Joining Application
- The application form does not send `paymentMethod`, `bankId`, `accountNo`, `iban`, `accountTitle` any more. They are **not required**: the "send for review" `missing` list never has a bank item, and the application never gives `BANK_DETAILS_REQUIRED`.
- An old draft that already has bank data keeps it and it is still accepted (the fields are still allowed in the body).
- Rule: no bank account = **cash**. So an application made without bank data gives `paymentMethod: "CASH"`, and so does the employee made when it is approved. HR fills the bank later in the **employee profile**.
- The Employee profile (`/payroll/employees`) is unchanged: all the bank fields work as before (a BANK card still needs the bank and the account number).

## 5. Final field lists
- Employee card and application, new: `monthlyIncomeTax`, `eobiNo`, `scssiNo`. Removed: `yearlyIncomeTaxPercent`, `monthlyEobiPercent`.
- The reviewer of an application may edit only: `joiningDate, groupId, departmentId, designationId, shiftId, salaryType, basicSalary, foodAllowance, maintenanceAllowance, mobileAllowance, monthlyIncomeTax, remarks`.

## 6. Other screens that changed because of this
- **Payroll > Income Tax** list and employee history: `cardPercent` is now `cardAmount` (a money string, the card's fixed tax). An employee with no history row and a card amount shows `source: "CARD"`, `monthlyAmount` = the card amount, `percent: null`.
- **Payslip:** an employee with no EOBI list entry has `eobiSource: "NONE"` and an EOBI of `0.00` (HR can still type an amount on the payslip). Tax: `taxSource` is `AMOUNT` for the card amount, as for a history amount.

## Database
Migration `20261122000001-employee-fixed-tax-and-ids.js` (run `npm run db:migrate` on every database). It adds `monthlyIncomeTax`, `eobiNo`, `scssiNo`, converts the old percent to an amount and drops the two percent columns.
