# Store: correcting inwards, ledgers and reports (Chemical Store, also General Store where it fits)

Everything here needs the Store Reports service (reports) or the store service with FULL access (correcting an inward).

## 1. Editing an inward that is already approved

`POST /stores/chemical/inwards/:id/correct`  (store FULL access)
Body: the whole entry again, plus the reason (required, 3 to 300 characters):
```
{ "reason": "typing mistake",
  "inwardDate": "2026-10-15", "vendorId": "...", "dcNo": "...", "grnNo": "...", "notes": "...", "billType": "GST", "gstPercent": 18,
  "lines": [ { "lineId": "<id of an existing line>", "itemId": "...", "qty": 90, "rate": 45 },
             { "itemId": "...", "qty": 10, "rate": 50 } ] }      // no lineId = a new line
```
- Lines that are not sent are removed. Lines that already exist must carry their `lineId` (it comes in `GET /inwards/:id` -> `lines[].id`).
- Header (vendor, date, DC#, GRN#, notes, GST) can always change.
- A line nothing was issued from can change in everything (chemical, qty, rate) or be removed.
- A line from which a department already took stock: chemical and rate are locked (`LINE_USED`), quantity can change but not below what was issued (`QTY_BELOW_ISSUED`, the message says how much was issued). It cannot be removed.
- Stock, average rate and batches follow the change automatically. Every change is a "Purchase corrected" movement in the ledgers and is saved in the audit log with the reason, who and when.
- Un-approved (draft) entries are still edited with `PATCH /inwards/:id` as before.
- Screen: on an approved entry show an "Edit" button that opens the same form with the lines filled; ask for the reason on Save. Show the error messages as they come.
- Wrong stock without a purchase (count mismatch, damage): use the existing stock adjustment screen (`/stores/chemical/adjustments`).

## 2. The reports

All: `GET /stores/chemical/reports/<name>` (General store: `/stores/general/reports/<name>` for the ones marked G). Same answer shape as the other reports (see `reports.md`):
`{ title, generatedAt, filters, sections:[{ key, title, columns:[{key,label,type}], rows, totals }], page, limit, total, export }`.
`page`, `limit` for the screen, `?export=true` returns every row for the PDF / Excel download (jsPDF + autotable, SheetJS, exactly as the other reports). Column `type`: text, number, money, date, datetime. Put Download PDF / Excel on every report, send the same filters plus `export=true`.
Dates are `YYYY-MM-DD`.

| name | what it answers | filters |
|---|---|---|
| `day-book` (G) | Every stock movement: purchase, issue to department, return, adjustment, correction. Each row shows in/out, rate, value and the stock AFTER it (qty and value), vendor, IP#, DC#, department, Req#, Job#, SO#, requested by, operator, who did it | dateFrom, dateTo, itemId, categoryId, vendorId, departmentId, jobNo, kind |
| `item-ledger` (G) | One chemical: ledger rows with running stock, plus section `summary` (opening, purchased, issued, returned, adjusted, closing) | itemId (required), dateFrom, dateTo |
| `stock-on-date` (G) | Stock of every item ON a day (qty, average rate, value). "What was the stock last month on this date / yesterday" | date (required), categoryId, itemId, showZero |
| `stock-summary` (G) | Per item for a period: opening, purchased, issued, returned, adjusted, closing (qty and value) | dateFrom, dateTo (both required), categoryId, itemId |
| `purchases` (G) | 3 sections: by vendor (how many chemicals, amount), by chemical (how many vendors, lowest/highest/average rate, `differentRates` Yes/No), vendor x chemical | dateFrom, dateTo, vendorId, itemId, categoryId |
| `vendor-ledger` (G) | One vendor: every purchase line, running total | vendorId (required), dateFrom, dateTo, itemId |
| `inwards` (G) | Register of inward entries incl. drafts, with bill amounts | dateFrom, dateTo, vendorId |
| `issues` | What departments took, line by line: dept, Job#, SO#, requested by, operator, requested / issued / short / returned / used, rate, cost, stock before and after. `groupBy=chemical|department|job|so_card` gives used qty and cost grouped (a job with several SO cards is split by meters) | dateFrom, dateTo, itemId, categoryId, departmentId, jobNo, operator (name part), groupBy |
| `operators` | Per operator: requests, requested, issued, short, returned, used, cost; second section operator x chemical (10 kg asked, 9 kg given = short 1) | same as issues |
| `returns` | Chemicals sent back by departments | dateFrom, dateTo, departmentId, itemId |
| `vendor-returns` (G) | Stock sent back to vendors: date, VR#, vendor, purchase IP#/DC#, chemical, packs, qty, rate, value, reason, status | dateFrom, dateTo, vendorId, itemId |
| `stock-ageing` (G) | How old the stock in the store is: value in 0-30 / 31-60 / 61-90 / 91-180 / over 180 days per item, oldest batch, last issued (slow / non-moving stock) | date (default today), categoryId, itemId |
| `monthly-summary` (G) | Month by month: purchased, issued, returned by departments, returned to vendors, adjusted (section 1 totals, section 2 per chemical) | dateFrom, dateTo, itemId, categoryId |
| `adjustments` (G) | Stock adjustments (count, damage, expiry, loss) with stock before / change / after | dateFrom, dateTo, itemId |
| `low-stock` (G) | Chemicals at or below their minimum stock (set `reorderLevel` on the chemical) | categoryId |
| `batch-stock` (G) | Stock batch by batch: batch date, age, vendor, IP#, DC#, rate, bought, in store, value | categoryId, itemId, vendorId |
| `stock-audit` (G) | The AUDIT CHECK: do the books agree? Section `checks` (each check OK / CHECK with the number of problems), section `items` lists items that do not agree (stock vs movements vs batches). Run before every audit / month end; all rows must say OK | none |

The dropdown data (chemicals, categories, vendors, departments) comes from `GET /stores/chemical/inwards/form-data`, `GET /vendors`, `GET /stores/chemical/items`, and the department list of the company.

Suggested menu "Store Reports": one screen per row of the table above, filters on top, table below, buttons PDF / Excel. The stock-on-date screen is a date picker + table. Item ledger: chemical dropdown + date range; show the `summary` section above the ledger rows (it is the second section in the answer).

Notes for the screens:
- `short` = requested minus issued. If the store has 9 kg and 10 kg was requested the store gives 9 kg: on the send form default each line's qty to the smaller of requested and in-stock, and send it in `lines[].qty` (a plain send of the full 10 kg is refused with `NOT_ENOUGH_STOCK`).
- Stock before/after on `issues` is the store stock of that chemical around that issue.
- Corrected purchases carry the purchase date, so "stock on date" always shows the corrected truth; the audit log (`/audit-logs`, entity `StoreInward`, action `STORE_INWARD_CORRECTED`) shows who changed what and why.
- Access: Store Reports service. The store screens themselves need only the store service.


## 3. Return to vendor (bad / wrong / extra stock goes back)  (store service)

Example: 3 drums of acetic acid bought (200 kg each), 1 drum is bad, the party takes it back. The stock goes down, the vendor ledger shows the return, the cost stays right (the stock leaves at the rate of THAT purchase).

- Inward line with packs (optional): in an inward line send `packType` (DRUM, BAG, CAN, CARTON, BOX, BARREL, OTHER), `packCount` and `qtyPerPack` INSTEAD of `qty`; the server makes `qty = packCount x qtyPerPack` (600 kg). Lines come back with `packType, packCount, qtyPerPack`. Show "3 drum x 200 kg". Normal `qty` still works.
- `GET /stores/chemical/vendor-returns/returnable?vendorId=...[&itemId=][&dateTo=]` -> the vendor's purchase lines that still have stock in the store: `inwardLineId, ipNo, dcNo, inwardDate, item, bought, inStore, returned, issuedOrUsed, rate, packType, packCount, qtyPerPack`. This is the list the user picks from (a table with a "Return qty" box or a "Return packs" box per row).
- `POST /stores/chemical/vendor-returns` (store FULL):
  `{ returnDate, vendorId, reason: DAMAGED|WRONG_ITEM|EXPIRED|QUALITY|EXCESS|OTHER, notes, lines:[ { inwardLineId, qty } | { inwardLineId, packType, packCount, qtyPerPack } ] }`
  Answer: the return with `returnText` (VR-00001), `totalValue`, `lines`. Errors: `NOT_IN_STORE` (only X of this purchase is still in the store, the rest was issued or already returned: show the message), `RETURN_BEFORE_PURCHASE`, `OTHER_VENDOR`, `DUPLICATE_LINE`.
- `GET /stores/chemical/vendor-returns?dateFrom&dateTo&vendorId&itemId&status&page&limit` list, `GET /stores/chemical/vendor-returns/:id` one.
- `POST /stores/chemical/vendor-returns/:id/cancel` body `{ reason }`: a wrongly entered return is cancelled and the stock comes back (once).
- A purchase that has stock returned or issued cannot be un-approved; in "correct inward" its quantity cannot go below issued + returned.
- Show a "Return to vendor" button on the Inwards screen / vendor screen and a Vendor returns list screen.
- Reports that now include returns: `vendor-ledger` (rows `Purchase` and `Return VR-n`, running balance = purchases less returns), `purchases` (returned and net columns), `day-book` (kind VENDOR_RETURN, vendor return# column), `stock-summary`, `item-ledger`, `monthly-summary`, `vendor-returns`.

## 4. Minimum stock

Chemical create / edit accepts `reorderLevel` (number or null). Items return `reorderLevel` and `isLow` (stock at or below the minimum). Show a red badge on the stock list and a "Low stock" report.

## 5. What an auditor looks at (suggested Store Reports menu)

1. Stock: Stock on date, Stock summary, Stock by batch, Stock ageing, Low stock.
2. Ledgers: Day book, Item ledger (per chemical), Vendor ledger (per vendor).
3. Purchases: Inwards register, Purchases (vendor / chemical / rate changes), Vendor returns.
4. Consumption and costing: Issues (by department, Job#, SO#, operator; stock before / after), Operators, Department returns, Monthly summary.
5. Control: Adjustments, Stock audit check (all OK).
Every table has the PDF / Excel buttons (`export=true`).

## 6. Returns on the inward screens (added)

Only POSTED returns count; a cancelled return is never counted anywhere.
- `GET /stores/:store/inwards/:id` lines: `returnedQty`, `netQty` (qty - returnedQty), `returnedValue`. Entry: `returnedValue`, `returnedTax` (GST of the returned goods, by the entry's GST %), `netAmount` (amount - returnedValue), `hasReturns`, `billed` (original bill, unchanged), `balance` (bill less returned goods and their GST).
- `GET /stores/:store/inwards` list rows have the same entry fields (`returnedValue`, `hasReturns`, `balance`): show a "Returned" badge when `hasReturns`.
- `GET /stores/:store/vendor-returns/:id`: `status` (POSTED / CANCELLED), `cancelReason`, `cancelledAt`, `cancelledBy` (name), `lines[]` with `itemName`, `item`, `unit`, `qty`, `rate`, `value`, `ipNo`, `dcNo`, `inwardDate`, packs.
- After a return the item stock drops by the qty at the purchase's rate; after a cancel it comes back once (a second cancel answers `ALREADY_CANCELLED`). The vendor ledger shows the `Return VR-n` row only while the return is POSTED.
