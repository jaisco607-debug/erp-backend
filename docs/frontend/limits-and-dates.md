# LIMITS ON NUMBERS, DATES (5 years), and the double-cancel fix

**Update 2026-11-25: the numbers and the date windows are now the company's own and have 3 kinds of dates (stock / voucher / other). Read `settings-limits.md` first; the sections below describe the standard values.**

Owner rules of 2026-11-24. The server now refuses a typed extra zero and a wrong year. The screens should stop it earlier, with the same numbers.

## 1. Read the numbers once: `GET /api/v1/limits` (any signed-in user)
Load it once after login (like the company settings) and keep it.
```json
{
  "dates": { "today": "2026-11-25", "min": "2021-11-25", "max": "2031-11-25", "years": 5, "joiningDateMin": "1986-11-25" },
  "numbers": { "meters": 100000, "quantity": 100000, "bags": 100000, "weight": 100000, "unitsPerShift": 100000,
               "lotNo": 999999, "lotNoAhead": 1000, "voucherAmount": 1000000000, "basicSalary": 5000000 },
  "decimals": { "meters": 2 },
  "note": "Rates (price per kg, lb or meter) have no usual maximum."
}
```

## 2. Dates: at most 5 years from today (back and ahead)
- **Every document date** (saved in a form) must be between `dates.min` and `dates.max`. Use them as `min` / `max` of every date input (the picker disables days outside).
  Examples of fields: grey lot inward / return date, SO card date and delivery date, job date, process date, store inward / return / adjustment date, fabric and yarn inward / outward / issue dates, sizing batch / receipt / start / end dates, beam date, contract date, invoice date and due date, voucher date and cheque date, journal date, packing / gate pass dates, leave / loan / advance / resignation / increment application dates, holiday date, attendance date, production register date.
- **Employee joining date**: from `dates.joiningDateMin` (40 years back) to `dates.max`. The **date of birth** has no limit from us.
- **Filters are free**: `dateFrom` / `dateTo` of lists and reports (query string) are not checked. A report "to 2099-12-31" still works.
- The server answers **422** with code **`DATE_OUT_OF_RANGE`**:
```json
{ "error": { "code": "DATE_OUT_OF_RANGE",
    "message": "inwardDate: 2062-01-01 is too far from today; use a date between 2021-11-25 and 2031-11-25",
    "details": { "field": "inwardDate", "value": "2062-01-01", "min": "2021-11-25", "max": "2031-11-25" } } }
```
  Show `message` next to the field named in `details.field` (for a field inside a list the field is like `lines.0.date`).
- A document older than 5 years cannot be saved again (even to change its notes) because its date is sent with the form. Very old data is not changed; only saving it again is refused. If this becomes a problem for an old record, tell the backend.

## 3. Numbers
| What | Maximum | Server answer when more |
|---|---|---|
| Thaan length, job meters, machine run meters (in / out), beam length, half-cut left meters, store / chemical quantity of a line, quantity per pack, yarn bags, weight of a bag, beam weight | **100,000** | 400 validation, `details[].field` names the field |
| Units of one loom in one shift (also the CSV import) | **100,000** | 400 validation |
| Typed lot number, and the "next lot number" setting | **999,999** | 400 validation |
| One line of a voucher or a journal entry | **1,000,000,000** | 400 validation |
| Basic salary of an employee | **5,000,000** | 400 validation |
| **Rates** (price per kg / lb / meter) | **no usual maximum** | only the size the database holds |

- **Decimals of meters: at most 2.** `10.123` is **refused** (400, message "meters can have at most 2 decimals"), it is no longer rounded to 10.12. Round to 2 decimals before you send, and limit the input to 2 decimals. This applies to every `meters`, `inMeters`, `outMeters`, `lengthM`, `leftM` and every number in a `thaans` list. A value like `12.299999999999999` from a calculation is fine.
- Use `numbers.*` from section 1 as the `max` of the inputs and show "the usual maximum is 100,000" next to the field.

## 4. Lot number rules (Grey Inward)
- A typed lot number is at most `numbers.lotNo` (999,999).
- A typed lot number can be at most `numbers.lotNoAhead` (1,000) above the **next automatic number** (the "Next: Lot# ..." that the form shows). More answers **422 `LOT_NO_TOO_FAR`**: `details: { nextLotNo, highest }`; show "The highest number you can type is {highest}".

## 5. Store purchase entry needs a vendor
`POST /stores/:store/inwards` without a vendor (neither `vendorId` nor `vendorName`) answers **422 `VENDOR_REQUIRED`**: "Select the vendor of this purchase". Make the vendor box required on the form (it was already required at approval).

## 6. Double cancel (a double click or two users)
- **Cancel of a return to the vendor** sent twice at the same moment now gives the stock back **once**. The second request answers **422 `ALREADY_CANCELLED`**, as it already did when sent one after the other.
- The same for **Approve / Un-approve** of a store purchase, a purchase bill and a purchase return invoice: two requests together count once; the second answers 422 (already approved / not approved / cancelled).
- Frontend: disable the Cancel / Undo / Delete / Un-approve button while the request runs (the same busy guard as "Working..."), and treat `ALREADY_CANCELLED` as "already done": reload the row instead of showing a red error.

## 7. Quick checks for the frontend
1. Grey Inward with date 2062-01-01 or 1900-01-01: the picker does not allow it; if sent, the message appears next to the date.
2. A thaan of 100001 or 10.123: refused with a clear message; 100000 and 10.5 work.
3. Lot number 5000 when the next is 1: "highest you can type is 1001".
4. A store purchase without a vendor: the form does not submit.
5. A report with `dateTo=2099-12-31` still loads.
