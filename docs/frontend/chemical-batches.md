# CHEMICAL STORE: stock by rate (batches), last 5 purchases, pick batches when issuing, full usage record

## 1. What changed in the backend and database (migration 20261019000003)
- **New table `store_batches`:** every approved purchase line is now its own **batch**.
  - Columns: item, vendor, IP#, date, `rate`, `qtyIn`, `qtyLeft`, `valueLeft`.
  - `source`: `INWARD` (purchase), `OPENING` (stock already in the store before this change, at its old average rate), `RETURN`, `ADJUST`.
  - Example: sulphur 20 kg @ 40 (old) + 100 kg @ 45 (new) = 2 batches. Total 120 kg, value 5300, average 44.17.
- **New table `chemical_issue_batches`:** which batch every sent request line came from, with qty, rate, value and returned qty.
- **Item totals** (`stockQty`, `stockValue`, `avgRate`) still work; they are the sum of the batches.
- **Sending a request:** the store can pick batches. If it picks none, the oldest batch goes first. The line value is the real total of the batches (20 x 40 + 35 x 45 = 2375). The line `rate` is now the average of what was given.
- **Returns** go back into the same batches they came from, at those rates, newest batch first.
- **Stock adjustment OUT** takes from the batches (oldest first, or a given `batchId`). Adjustment IN makes a new batch.
- **Un-approve a purchase:** only when none of its batch was used (`STOCK_USED`).
- **Special / new chemical:** type its name on the inward line (`itemName`) as before. It becomes a new item and its first batch. `last-inwards` returns `isNew: true` for it.
- Everything stays in the audit log. Works for the General Store too (same URLs with `general`).

## 2. Inward screen: last 5 purchases of the chosen chemical
`GET /stores/chemical/items/:itemId/last-inwards?limit=5`
```json
{ "item": {...}, "isNew": false,
  "data": [ { "ipNo": 12, "date": "2026-10-15", "vendor": { "name": "NEW CHEM" }, "qty": 100, "qtySplit": { "text": "100 KG" }, "rate": 45, "amount": 4500, "dcNo": "..." },
            { "ipNo": 9,  "date": "2026-10-12", "vendor": { "name": "ALI CHEM" }, "qty": 20,  "rate": 40, "amount": 800 } ],
  "stock": { "totalQty": 120, "totalValue": 5300, "avgRate": 44.1667, "batches": [...] } }
```
**UI:**
- When a chemical is picked on an inward line, call this and show a small table under the line: Date | Vendor | Qty | Rate | Amount (newest first).
- Show the current stock: "In stock: 120 KG, average Rs 44.17".
- Mark the rate box: green if the new rate is lower than the last one, red if higher.
- When the chemical is typed (new name) or `isNew` is true, show the badge "New chemical, no earlier purchase".

## 3. Stock screen: rate by rate
`GET /stores/chemical/items/:itemId/batches` (also inside `GET /stores/chemical/items/:id/stock` as `batches`)
```json
{ "item": {...}, "totalQty": 120, "totalSplit": { "text": "120 KG" }, "totalValue": 5300, "avgRate": 44.1667, "batchCount": 2,
  "batches": [ { "batchId": "uuid", "sourceText": "Purchase", "inDate": "2026-10-12", "vendor": { "name": "ALI CHEM" }, "ipNo": 9,
                 "rate": 40, "qtyIn": 20, "qtyLeft": 20, "qtyLeftSplit": { "text": "20 KG" }, "valueLeft": 800, "label": "20 KG @ Rs 40 (ALI CHEM)" },
               { "batchId": "uuid", "inDate": "2026-10-15", "vendor": { "name": "NEW CHEM" }, "rate": 45, "qtyIn": 100, "qtyLeft": 100, "valueLeft": 4500 } ] }
```
**UI:** in the stock list, each chemical row shows Total qty, Average rate, Value and a "2 rates" chip. Expanding the row shows the batches table: Date | Vendor | IP# | Rate | Came | Left | Value | **Usage** button.

## 4. Issuing a request: pick batches
`GET /stores/chemical/requests/:id` (Queue / Process): every line now has
- `stockBatches`: the batches in stock for that chemical, oldest first (same shape as section 3).

**UI (send window):**
- Under each line show the batches with a qty box each. Example: asked 55 KG; "20 KG @ 40" box and "100 KG @ 45" box.
- Button **"Oldest first"** fills the boxes automatically (20 + 35). The user can change them, e.g. all 55 from the 45 batch.
- Show live: Total qty, amount per batch and the line total.

**Send:**
```json
POST /stores/chemical/requests/:id/send
{ "sentThrough": "Akram",
  "lines": [ { "lineId": "uuid", "batches": [ { "batchId": "uuid-old", "qty": 20 }, { "batchId": "uuid-new", "qtyMain": 35, "qtySub": 0 } ] } ] }
```
- With `batches`, the line qty = their sum. Without `batches`, the line goes oldest first (as before; `qty` / `qtyMain` / `qtySub` still work).
- Errors: `UNKNOWN_BATCH`, `BATCH_SHORT` (the batch has less; `details.qtyLeft`), `DUPLICATE_BATCH`, `NOT_ENOUGH_STOCK`.

**After sending,** every line has:
```json
"issuedBatches": [ { "batchId": "uuid", "inDate": "2026-10-12", "vendor": { "name": "ALI CHEM" }, "qty": 20, "qtySplit": {...}, "rate": 40, "value": 800, "returnedQty": 0 },
                   { "batchId": "uuid", "inDate": "2026-10-15", "vendor": { "name": "NEW CHEM" }, "qty": 35, "rate": 45, "value": 1575, "returnedQty": 0 } ],
"mixedRates": true, "sentQty": 55, "rate": 43.1818, "value": 2375
```
Show the line as "55 KG = 20 KG @ 40 (800) + 35 KG @ 45 (1575) = Rs 2375". The department screen sees the same.

## 5. Costing (Job / SO card)
`GET .../jobs/:id/chemical-cost` and `GET .../so-cards/:id/chemical-cost`: every chemical in `chemicals[]` now also has
```json
"byRate": [ { "rate": 40, "qty": 20, "qtySplit": {...}, "value": 800 }, { "rate": 45, "qty": 35, "value": 1575 } ], "mixedRates": true
```
(after returns). **UI:** show the chemical total row, and when `mixedRates` is true, the rate lines under it.

## 6. Where a chemical / batch was used
- One batch: `GET /stores/chemical/batches/:batchId/usage`
- All batches of a chemical: `GET /stores/chemical/items/:itemId/usage`
```json
{ "item": {...}, "batch": { "inDate": "2026-10-15", "vendor": { "name": "NEW CHEM" }, "ipNo": 12, "rate": 45, "qtyIn": 100, "qtyLeft": 65, "valueLeft": 2925 },
  "data": [ { "date": "2026-10-19T...", "department": { "name": "Dyeing" }, "request": { "reqNo": 4 }, "jobNo": 18, "soNos": [5], "lotNos": [15],
              "thaans": 2, "meters": 1000, "batchRate": 45, "qty": 35, "qtySplit": {...}, "returnedQty": 0, "netQty": 35, "rate": 45, "value": 1575, "netValue": 1575 } ],
  "totals": { "issues": 1, "qty": 35, "returnedQty": 0, "netQty": 35, "value": 1575 } }
```
- `thaans` / `meters` are the cloth of that Job (only the request's SO card when the request was for one SO card).
- **UI:** "Usage" button on a batch and on a chemical. Table: Date | Department | Req# | Job# | SO# | Lot# | Thaans | Meters | Qty | Rate | Amount | Returned. Totals at the bottom.

## 7. Stock adjustment
`POST /stores/chemical/adjustments` lines can have an optional `batchId` with mode `OUT` (which batch is damaged / expired). Without it, the oldest first.
