# SETTINGS > LIMITS: every company sets its own limits and date rules (A2.1, A1.1)

Owner 2026-11-25. This replaces the fixed numbers of `limits-and-dates.md`: the numbers, the 5-year rule and `GET /api/v1/limits` stay, but they now belong to the company. A new **Limits** tab in Settings (client admin only) changes them.

## 1. `GET /api/v1/limits` (any signed-in user): read it once after login
```json
{
  "dates": {
    "today": "2026-11-25", "min": "2 021-11-25", "max": "2031-11-25", "years": 5, "joiningDateMin": "1986-11-25", "openingDate": null,
    "stock":   { "min": "2021-11-25", "max": "2026-11-25", "fields": ["inwardDate", "returnDate", "outwardDate", "jobDate", "processDate", "usageDate", "issueDate", "adjDate", "batchDate", "receiptDate", "beamDate", "passDate"] },
    "voucher": { "min": "2021-11-25", "max": "2026-12-26", "fields": ["voucherDate", "invoiceDate", "contractDate", "deliveryDate", "cardDate", "entryDate", "clearedDate"] },
    "other":   { "min": "2021-11-25", "max": "2031-11-25", "fields": ["date", "dueDate", "chequeDate", "etaDate", "startDate", "endDate", "statusDate", "applicationDate", "lastWorkingDay", "holidayDate", "leavingDate", "advanceDate", "ratesFrom", "fromDate", "toDate", "effectiveDate"] }
  },
  "numbers": { "meters": 100000, "beamMeters": 100000, "storeQty": 100000, "yarnBags": 100000, "bagWeight": 100000, "unitsPerShift": 100000,
               "lotNo": 999999, "lotNoAhead": 1000, "voucherAmount": 1000000000, "basicSalary": 5000000,
               "quantity": 100000, "bags": 100000, "weight": 100000 },
  "decimals": { "meters": 2 },
  "note": "Rates (price per kg, lb or meter) have no limit."
}
```
- **`numbers`** are the numbers of THIS company (standard values, or what its admin set). Use them as the `max` of the inputs and show "the usual maximum is {n}" next to the field. `quantity`, `bags`, `weight` are the old names, kept (= `storeQty`, `yarnBags`, `bagWeight`).
- Which number for which input:

| Input | `numbers.` |
|---|---|
| Thaan length, job meters, fabric inward meters, machine run meters in / out | `meters` |
| Beam length (sizing), half-cut left meters, beam meters on a sizing batch | `beamMeters` |
| Store / chemical quantity of a line (also the quantity per pack) | `storeQty` |
| Yarn bags of a line | `yarnBags` |
| Weight of a bag (lbs per bag), weight of a beam | `bagWeight` |
| Units of one loom in one shift | `unitsPerShift` |
| Typed lot number | `lotNo` |
| One line of a voucher or a journal entry | `voucherAmount` |
| Basic salary of an employee | `basicSalary` |

- **Rates have no limit** (price per kg / lb / meter): no `max` on those inputs.

## 2. Dates: three kinds
Every document date must be inside the window of its kind (use `dates.<kind>.min` / `max` as `min` / `max` of the date input; `fields` lists which input belongs to which kind):
- **`stock`** (stock and production documents: inwards, returns, outwards, jobs, processes, issues, adjustments, sizing batches and receipts, beams, passes): **not after today** (the company may allow a few days ahead).
- **`voucher`** (vouchers, invoices, contracts, delivery dates, SO card date, journal entry date): **up to 31 days ahead** (the company may change the days).
- **`other`** (due dates, cheque dates, start / end dates, leaves, holidays, applications, effective dates, report-like dates): up to **5 years ahead**.
- All kinds: **not before `dates.min`**, which is 5 years back or the company's **opening date** if that is later (nothing can be dated before the opening date).
- The employee **joining date**: from `dates.joiningDateMin` (40 years back) to `dates.other.max`. Date of birth has no limit. Report filters (`dateFrom`, `dateTo`) are free.
- The server answers **422 `DATE_OUT_OF_RANGE`** with `details: { field, value, min, max }` (the `min` / `max` are the window of that field). Show the message next to the field.

## 3. The Settings tab: `GET` / `PUT /api/v1/limits/settings` (client admin only; others get 403)
`GET /limits/settings`:
```json
{
  "allQuantities": null, "allQuantitiesMax": 99999999,
  "items": [
    { "key": "meters", "label": "Meters of a thaan, job, fabric inward or machine run", "group": "quantity", "unit": "m", "standard": 100000, "hardMax": 99999999, "custom": null, "effective": 100000 },
    { "key": "beamMeters", "...": "..." }, { "key": "storeQty", "...": "..." }, { "key": "yarnBags", "...": "..." }, { "key": "bagWeight", "...": "..." }, { "key": "unitsPerShift", "...": "..." },
    { "key": "lotNo", "group": "other", "...": "..." }, { "key": "voucherAmount", "group": "other", "...": "..." }, { "key": "basicSalary", "group": "other", "...": "..." }
  ],
  "dates": { "openingDate": null, "maxFutureDaysStock": 0, "maxFutureDaysVouchers": 31, "standard": { "maxFutureDaysStock": 0, "maxFutureDaysVouchers": 31 } },
  "note": "Rates (price per kg, lb or meter) have no limit. A value for one item wins over the value for all the quantities."
}
```
`PUT /limits/settings` (send only what changes; `null` puts a value back to the standard):
```json
{ "allQuantities": 5000 }                                  // one limit for ALL the quantities (group "quantity")
{ "limits": { "meters": 2000, "storeQty": null } }         // a limit for one item; null = back to the standard / to the value for all
{ "openingDate": "2025-07-01", "maxFutureDaysStock": 0, "maxFutureDaysVouchers": 31 }
```
- **Rule of use:** the standard < the value for ALL the quantities < the value of that ONE item. So "all 5,000 except meters 20,000" is `{ "allQuantities": 5000, "limits": { "meters": 20000 } }`. `allQuantities` does not touch `lotNo`, `voucherAmount`, `basicSalary` (they are not quantities; set them one by one).
- The answer of the PUT is the same as the GET (the new state).
- Errors: **400 validation** when a value is above `hardMax` (what the database holds) or below 1 or a name that is not a limit; **422 `OPENING_DATE_FUTURE`** when the opening date has not come yet.
- A new limit works at once for the next save. **Nothing old is changed**: a lot bigger than a new, lower limit stays; only saving a bigger value again is refused.

### The screen (suggested)
- Tab **Settings > Limits** (client admin menu).
- Top card **"One limit for all quantities"**: one number box (empty = not used) + Save. Under it the list of the quantities.
- Table **Limits** (one row per `items`): label, unit, standard, a box "Your limit" (shows `custom`, empty = standard or the value for all), the **effective** value in grey. A "Reset" link sends `null` for that row. Show `hardMax` as the highest value the box accepts.
- The two `other` rows (lot number, voucher line, salary) are in a second small table "Other limits".
- Card **Dates**: opening date picker (nothing can be dated before it), "stock documents may be dated this many days ahead" (0 to 365, standard 0), "vouchers may be dated this many days ahead" (0 to 365, standard 31).
- Note on the screen: "Rates (price per kg / lb / meter) have no limit."
- After a save, load `GET /limits` again and refresh the `max` / `min` of the open forms.

## 4. Other things that did not change
- Meters have at most 2 decimals (`10.123` is refused).
- Lot number: a typed number can be at most 1,000 above the next automatic one (`LOT_NO_TOO_FAR`).
- A store purchase needs a vendor (`VENDOR_REQUIRED`).
- Double click: `ALREADY_CANCELLED` and similar answers mean "already done".

## 5. Quick checks
1. As client admin set "all quantities" 500: a thaan of 501 and a store line of 501 are refused with the limit in the message; 500 works; a rate of 5,000,000 works.
2. Set meters 2,000 only: a thaan of 2,000 works, 2,001 is refused; the store quantity is still 500.
3. Reset (null): back to 100,000.
4. A stock entry (grey lot, store inward) dated tomorrow is refused; a voucher dated 20 days ahead works; 40 days ahead is refused.
5. Set the opening date 10 days ago: an inward dated 11 days ago is refused.
6. A user who is not client admin does not see the tab and gets 403 from the PUT; company B keeps its own numbers.
