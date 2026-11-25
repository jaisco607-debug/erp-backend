# EOBI voucher: the employee share is what the payslips really withheld

Owner plan A4.2 (2026-11-24). No new route, no new field you must send. Only the amounts of the existing EOBI voucher change.

## What changed
- Before: the voucher took the employee share from the **EOBI list** of the month.
- Now: for each employee on the location, the voucher takes the amount the **payslip of that month really deducted** (the latest payslip of the month; a suspended payslip withheld nothing, so it counts 0). If the employee has **no payslip yet**, the share of the list is used.
- The employer share is unchanged (it comes from the list).
- So when HR changes the EOBI of a payslip (a typed figure, a part month, a recalculation), the voucher shows that figure: money paid to EOBI = money withheld from the salaries + the employer share.

## Where you see it
- `GET /eobi-vouchers/locations?month=` (the picker): `employeeShare` and `total` of every location follow the payslips.
- `GET /eobi-vouchers/:id`: `employeeShare`, `employer`, `amount` follow the payslips. Each row of `lines[]` has `employeeShare` (withheld) and a new field **`listShare`** (what the list asks). If they differ, show both, for example "350 (list: 407)".
- A **draft** voucher shows the figures of the day it was saved; they are worked out again when it is edited and when it is **confirmed**. After confirm the figures are fixed (posted: Debit EOBI Payable = employee share, Debit EOBI Employer Contribution = employer share, Credit bank).
- The EOBI summary and list screens already showed "deducted" against "list"; nothing changes there.

## What to do on the screens
1. Show `employeeShare` as the amount withheld, and `listShare` in a small grey text when it differs.
2. If the payroll of the month is changed after a voucher is confirmed, the confirmed voucher does not change; move it to draft and confirm again to take the new figures.
