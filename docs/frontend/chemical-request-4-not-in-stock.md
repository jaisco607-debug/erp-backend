# CHEMICAL REQUEST part D: Chemical not in stock (alternate / when it will come)

Small add-on to parts A and B. Build after them.

## D1. What changed in the backend and database
- A department CAN ask for a chemical even when the store has 0 or too little (it always could; now it is shown clearly).
- NEW columns on `chemical_request_lines` (migration 20261017000002):
  - `altItemId`, `altQty`, `altStatus` (OFFERED / ACCEPTED / DECLINED), `altNote`, `altOfferedById/At`, `altDecidedById/At`: the alternate chemical the store offers.
  - `originalItemId`: the chemical first asked, kept when the department takes the alternate.
  - `etaDate`, `etaNote`, `etaById/At`: when the chemical will come.
- The store can NOT press Send while an alternate is waiting for the department's answer (`WAITING_DEPARTMENT`).
- Everything is in the audit log.

## D2. New fields in every request (list + detail, both sides)
Request: `shortCount` (lines not in stock), `waitingForDepartment` (true = the department must answer an alternate).
Each line:
```json
{ "item": { "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG" },
  "qtySplit": { "text": "2 KG" },
  "inStock": false, "shortSplit": { "text": "2 KG" },
  "originalItem": null,
  "alternate": { "status": "OFFERED", "item": { "label": "VAT DYES / BLUE RCL" }, "qtySplit": { "text": "1 KG 500 G" },
      "stockSplit": { "text": "5 KG" }, "note": "Same shade",
      "offeredBy": { "name": "Store" }, "offeredAt": "...", "decidedBy": null, "decidedAt": null },
  "eta": { "date": "2026-10-20", "note": "Vendor se aa raha hai", "by": { "name": "Store" }, "at": "..." } }
```
`inStock` / `shortSplit` matter only while Queue / Process. After Send they are true / null.
In the request form (`form-data`), each chemical now has `inStock` (false = 0 in store): still selectable, show a small red "Not in stock" tag.

## D3. Store side
1. **Shortage screen** (new small tab "Short"): `GET /stores/chemical/requests/shortages`
```json
{ "data": [ { "item": { "label": "... / RED" }, "stockSplit": { "text": "0 KG" }, "demandSplit": { "text": "2 KG" }, "shortSplit": { "text": "2 KG" },
    "requests": [ { "reqNo": 1, "department": { "name": "Dyeing" }, "qtySplit": { "text": "2 KG" }, "eta": null, "alternateStatus": null } ] } ],
  "total": 1 }
```
Columns: Chemical, In store, Demand, Short, Requests (Req# + Dept). This tells the store how much to buy.
2. On the request detail, a line with `inStock: false` shows a red "Short 2 KG" tag and two buttons:
- **Offer alternate**: popup: chemical dropdown (chemical store items, show stock), KG + G boxes, note.
  `POST /stores/chemical/requests/:id/lines/:lineId/alternate`  `{ "itemId": "uuid", "qtyMain": 1, "qtySub": 500, "note": "Same shade" }`
  Errors: `ALREADY_OFFERED`, `SAME_ITEM`, `DUPLICATE_ITEM`, `UNKNOWN_ITEM`, `QTY_REQUIRED`.
- **When will it come**: popup: date + note.
  `POST /stores/chemical/requests/:id/lines/:lineId/eta`  `{ "etaDate": "2026-10-20", "note": "Vendor se aa raha hai" }`
Both work in Queue and Process (`NOT_OPEN` after Send).
3. While `waitingForDepartment` is true: show "Waiting for department" and disable Send.
4. If the department said NO (`alternate.status` DECLINED): offer another alternate, give a date, or Send that line as 0.

## D4. Department side
- A line with `inStock: false` shows "Not in store".
- If `eta` exists: show "Store: will come on 20-10-2026. Vendor se aa raha hai".
- If `alternate.status` is OFFERED: show a clear box on the request (and a badge on the list row when `waitingForDepartment` is true):
  "RED is not in store. Store offers BLUE RCL 1 KG 500 G instead. Note: Same shade" with two buttons **Yes, send alternate** / **No**.
  `POST /departments/:code/chemical-requests/:id/lines/:lineId/alternate`  `{ "accept": true }` (or false)
  - Yes: the line becomes the alternate chemical (`item` = BLUE RCL, `originalItem` = RED, the date is cleared).
  - No: the line stays RED; the store will give a date or offer something else.
  Needs FULL on the department. Errors: `NO_ALTERNATE`, `NOT_OPEN`.
- In the detail timeline also show: "Alternate offered by X at time", "Answered by Y at time", "Date given by Z".
