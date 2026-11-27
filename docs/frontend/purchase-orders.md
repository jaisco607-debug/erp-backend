# PURCHASE ORDERS AND GOODS RECEIVED (N-D1)

Purchase orders **of the Store only**: Chemical, General, Yarn and Fabric store. Nowhere else in the project.
A PO books **nothing**: no stock, no accounts. Stock and accounts move at the **store inward**, as before.
**The PO is optional.** A purchase without a PO works **exactly as before** (same screens, same answers). It may become required later.

## 1. How it works
1. The store person makes a **draft** PO: store, vendor, date, expected date, lines (item, quantity, rate).
2. The **client admin approves** it (only he). Only an approved PO can be received.
3. The goods arrive: on the **store inward screen** the person presses **"Pick from open PO"**; the vendor, items and **rates come from the PO**. He changes the quantity to what really came and saves the inward as always.
4. The PO shows **Partly received** / **Received** by itself, from the inwards (only **approved** inwards count as received; drafts show as **waiting**).
5. More than ordered is allowed only up to the **tolerance (standard 5 %)**; more is refused with a clear message.
6. A **different rate** needs a **note** and appears in the **price difference** report.
7. The PO is closed automatically when everything is received (shown "Received"), or **closed by hand**, or **cancelled** (only while nothing was received).

## 2. Rights
| Who | What |
|---|---|
| A person with the store's service **VIEW** (`CHEMICAL_STORE`, `GENERAL_STORE`, `YARN_STORE`, `FABRIC_STORE`) | sees the POs of that store |
| **FULL** on that store | makes, edits, deletes drafts, closes, cancels |
| **Client admin only** | **approves** a PO, changes the **tolerance** |
| No store service | no access (403) |
Each PO belongs to one store: show a person only his stores (the list answer gives `stores: [{code,text}]`).

## 3. Routes: `/api/v1/purchase-orders`
`store` is `CHEMICAL`, `GENERAL`, `YARN` or `FABRIC` (any case).

### `GET /purchase-orders`
Query: `store`, `status` (`DRAFT`, `APPROVED`, `PARTLY_RECEIVED`, `RECEIVED`, `CLOSED`, `CANCELLED`), `vendorId`, `search` (PO number like `PO-3`, vendor, item / yarn / quality, notes), `dateFrom`, `dateTo`, `page`, `limit` (≤200).
```json
{ "data": [ { "id": "…", "poNo": 1, "label": "PO-00001", "store": "CHEMICAL", "storeText": "Chemical Store", "poDate": "2026-11-26", "expectedDate": "2026-12-05",
    "vendor": { "id": "…", "name": "NEXUS", "code": 1, "phone": null, "address": null }, "notes": null, "status": "PARTLY_RECEIVED", "statusText": "Partly received",
    "amount": 50000, "lineCount": 1, "receivedPercent": 60, "overdue": false, "createdBy": { "name": "Ali" }, "approvedBy": { "name": "Admin" }, "approvedAt": "…",
    "closed": null, "cancelled": null, "canEdit": false, "canDelete": false, "canApprove": false, "canClose": true, "canCancel": false, "canReceive": true } ],
  "page": 1, "limit": 50, "total": 1, "counts": { "PARTLY_RECEIVED": 1 }, "stores": [ { "code": "CHEMICAL", "text": "Chemical Store" } ] }
```
- Show the buttons **only** from `canEdit`, `canDelete`, `canApprove`, `canClose`, `canCancel`, `canReceive` (and hide **Approve** unless the user is the client admin).
- `overdue: true` (approved, not all received, expected date passed): show a red tag.

### `GET /purchase-orders/form-data?store=chemical`
`{ store, today, tolerancePercent, nextPoNo, nextLabel, vendors:[{id,code,name}] }` plus: **chemical/general**: `items:[{id,name,unit,stockQty,limit,orderQty}]`; **yarn**: `yarns:[{yarnName,brand}]` (suggestions), `unit:"LBS"`; **fabric**: `qualities:[{id,name}]`, `units:["METER","YARD"]`.

### `POST /purchase-orders` (201), `PATCH /:id` (draft only)
```json
{ "store": "CHEMICAL", "vendorId": "…", "poDate": "2026-11-26", "expectedDate": "2026-12-05", "notes": "",
  "lines": [ { "itemId": "…", "qty": 500, "rate": 100, "note": "" } ] }
```
Lines by store: **chemical/general** `itemId` (unit = the item's unit); **yarn** `yarnName`, `brand` (optional), qty in **lbs**, rate **per lb**; **fabric** `qualityId`, `unit` (`METER`/`YARD`), qty in that unit, rate per that unit.
`qty` and `rate` are required and above 0. 1 to 200 lines. The same item twice: **422 `DUPLICATE_LINE`**.
Other errors: `ITEM_REQUIRED`, `YARN_REQUIRED`, `QUALITY_REQUIRED`, `UNKNOWN_ITEM`, `ITEM_INACTIVE`, `UNKNOWN_VENDOR`, `VENDOR_INACTIVE`, `EXPECTED_BEFORE_PO`, **`PO_NOT_DRAFT`**. `poDate` at most 31 days ahead (`voucher` kind of `GET /limits`).

### `GET /purchase-orders/:id` (also the **print view**)
The list fields plus `tolerancePercent`, `lines` and `receipts`:
```json
"lines": [ { "id": "…", "lineNo": 1, "itemId": "…", "yarnName": null, "brand": null, "qualityId": null, "description": "Caustic Soda", "unit": "KG",
             "qty": 500, "rate": 100, "amount": 50000, "note": null, "received": 300, "waiting": 0, "balance": 200, "canReceive": 225 } ],
"receipts": [ { "type": "STORE", "inwardId": "…", "ref": "00012", "date": "2026-11-26", "poLineId": "…", "qty": 300, "rate": 100, "note": null, "approved": true } ]
```
- `received` = approved inwards; `waiting` = inwards not approved yet; `balance` = ordered − (received + waiting), never below 0; **`canReceive`** = how much more the tolerance still allows.
- `receipts[].type`: `STORE` (chemical / general inward), `YARN`, `FABRIC`: link each to its inward screen.

### Actions
- `POST /:id/approve` (client admin) — `PO_NOT_DRAFT`, `NO_LINES`.
- `POST /:id/close` `{ "reason": "" }` — approved only (`PO_NOT_APPROVED`). Use it when nothing more is expected.
- `POST /:id/cancel` `{ "reason": "ordered twice" }` (3–300) — **422 `PO_HAS_RECEIPTS`** if any inward (even unapproved) points to it: close it instead. `details.receipts` lists them.
- `DELETE /:id` `{ "reason": "" }` — drafts only (204). The number is never used again.

### Tolerance: `GET` / `PUT /purchase-orders/settings`
`{ "tolerancePercent": 5, "standard": 5 }`; PUT (client admin) `{ "tolerancePercent": 5 }` (0–100).

### "Pick from open PO": `GET /purchase-orders/open-lines?store=chemical&vendorId=…` (`&itemId=` or `&qualityId=`)
```json
{ "store": "CHEMICAL", "tolerancePercent": 5,
  "data": [ { "poLineId": "…", "orderId": "…", "poNo": 1, "label": "PO-00001", "poDate": "…", "expectedDate": "…", "vendor": { "id": "…", "name": "NEXUS" },
              "itemId": "…", "yarnName": null, "brand": null, "qualityId": null, "description": "Caustic Soda", "unit": "KG",
              "ordered": 500, "received": 300, "waiting": 0, "balance": 200, "canReceive": 225, "rate": 100 } ] }
```
Only approved orders with something left. 

## 4. Changes on the store inward screens (everything is **optional**)
Send nothing new and every screen works as before.

### Chemical / General: `POST` / `PATCH /stores/:store/inwards`, `POST …/:id/correct`
Each line may carry **`poLineId`** and **`poRateNote`**.
- Without a rate, the PO rate is used. A different rate needs `poRateNote`.
- **Editing:** a line sent **without** `poLineId` keeps the PO it was on (matched by `lineId`, or by the same item). Send **`poLineId: null`** to take it off the PO. (Send `poLineId` back as you got it, to be clear.)
- The answer: a linked line has `poLineId`, `poRateNote` and `po: { orderId, poNo, label, lineId, rate, unit, ordered }`. Lines without a PO have **none** of these keys.

### Yarn: `POST` / `PATCH /store-yarn-inwards`
Body may carry `poLineId` (one per entry) and `poRateNote`; `null` in PATCH removes the link. Quantity = bags × lbs per bag. The yarn name (and brand when the order has one) must match (case and extra spaces do not matter). Rate per lb from the PO if empty. The answer has `poLineId`, `poRateNote`, `po`.

### Fabric: `POST` / `PATCH /fabric-inwards`
Same: `poLineId`, `poRateNote`. The **quality** must match. The quantity is counted in the order's unit (meters or yards). Rate and unit from the PO when no rate is sent; a rate in the other unit is converted before comparing.

### Errors on the inward screens (422): show the message next to the line / field in `details`
| Code | Meaning |
|---|---|
| `PO_NOT_OPEN` | the PO is a draft, closed or cancelled |
| `PO_VENDOR_MISMATCH` | the inward's vendor is not the PO's vendor (`details.field = "vendorId"`) |
| `PO_ITEM_MISMATCH` | another item / yarn / quality than ordered |
| `PO_WRONG_STORE` | a PO of another store |
| `PO_LINE_NOT_FOUND` | the line does not exist (reload the open lines) |
| `PO_OVER_RECEIVED` | more than ordered + tolerance. `details: { poNo, ordered, received, canReceive, max, tolerancePercent, trying, unit }`; show "at most {canReceive} {unit} more" |
| `PO_RATE_NOTE_REQUIRED` | the rate differs: show a **note box** on that line (`details.field` = `lines.0.poRateNote` or `poRateNote`, `details.poRate`) |

**Behaviour to know:** editing or deleting an inward frees / changes the PO quantity by itself. A closed PO: an inward already on it can still be saved with the same or a smaller quantity, never more. Returning goods to the vendor does **not** reopen the PO.

## 5. The low-stock list and "Create PO"
(See `store-stock-limits.md`; Chemical and General stores.)
- Every item (stock screen, items list, item pages, inward dropdown, `stock-limits`) now also has `orderQty` (usual order quantity), `onOrder` (still coming on **approved** POs), `openOrders` (`["PO-00001"]`), `suggestedOrderQty`.
- The red `warning` also has `onOrder`, `openOrders`, `suggestedOrderQty`, **`canCreatePo`**. If something is on order show "On order: 60 KG (PO-00001)". Show the **Create PO** button only when `canCreatePo` is true.
- **How much is suggested:** nothing if stock + on order is above the limit. Else the item's `orderQty`; without one, up to **twice the limit** counting what is on order. Example: stock 40, limit 50 → 60.
- Settings > Stock limits: `PUT /stores/:store/stock-limits` items may now carry **`orderQty`** (above 0, `null` clears; not sent = unchanged): add a second box "Usual order quantity".
- **`GET /stores/:store/stock-limits/po-suggestion`** (`?itemIds=a&itemIds=b` for the ticked ones; without them all low ones):
```json
{ "store": "CHEMICAL",
  "groups": [ { "vendor": { "id": "…", "name": "NEXUS" }, "lines": [ { "itemId": "…", "name": "Acetic Acid", "unit": "KG", "qty": 60, "rate": 200, "stockQty": 40, "limit": 50, "onOrder": 0 } ] },
              { "vendor": null, "lines": [ { "name": "Caustic Soda", "qty": 500, "rate": null } ] } ],
  "covered": [ { "itemId": "…", "name": "Acid X", "onOrder": 60, "openOrders": ["PO-00001"] } ], "note": "…" }
```
- Nothing is created by this route. **Create PO** = open the PO form filled with one group (**one PO per vendor**; vendor `null` means never bought, the person picks the vendor; `rate: null` must be typed). `covered` = already on order: show them as "already ordered".

## 6. Reports (Reports menu, any store service)
Both accept `export=true`, `poStore` (`chemical`/`general`/`yarn`/`fabric`), `vendorId`, `dateFrom`, `dateTo`.
- **`GET /reports/po-status`** (`tab=open` default: only what is still expected; `tab=all`): PO, date, expected, store, vendor, item, unit, ordered, received, waiting, balance, rate, balance value, status, "Overdue".
- **`GET /reports/po-price-difference`**: date, PO, inward, approved / waiting, vendor, item, qty, ordered rate, rate paid, difference per unit, difference in money, **why** (the note). Positive = paid more.
More than 5,000 rows: **422 `REPORT_TOO_BIG`**.

## 7. The screens (suggested)
**Store > Purchase orders** (a tab in each store, showing that store's POs): list with filters (status chips from `counts`, vendor, search), status badge, received % bar, overdue tag; "New PO".
- **PO form**: vendor, date, expected date, notes; a line grid with the item picker (chemical/general), yarn + brand (yarn), quality + unit (fabric), qty, rate, line total and PO total. Save draft.
- **PO page**: header, lines with ordered / received / waiting / balance, the receipts with links, buttons **Approve** (client admin), **Edit**, **Delete** (drafts), **Close**, **Cancel** (ask the reason), **Print**.
- **Print view** (from `GET /:id`): company, PO no and date, vendor (name, phone, address), lines with qty, unit, rate, amount, total, expected date, notes, approved by.
- **Inward screens**: a **"Pick from open PO"** button (only enabled after a vendor or store is chosen; calls `open-lines` with the vendor). Picking fills vendor, item, rate (qty = balance) and keeps `poLineId`. On each linked line show "PO-00001: ordered 500, received 300, balance 200". A **Remove PO link** action sends `poLineId: null`. Entries without a PO stay as they are.
- **Tolerance** in Store settings (client admin).
- **Low stock**: the **Create PO** button on the warning / settings list; tick several low items → `po-suggestion` → one form per vendor.
- Disable buttons while saving; loading / empty / error / data states.

## 8. Quick checks ("Done when")
1. Make a PO of 500 kg, approve it as client admin (a store user gets 403).
2. Receive 300 kg with "Pick from open PO" (the rate fills): the PO is "Partly received" after the inward is approved.
3. Try 226 kg more: refused ("at most 225 KG more"). 225 kg works: "Received".
4. Type another rate: the note box is required; the price difference report shows the line.
5. Cancel a PO with a receipt: refused; close it instead. A cancelled or closed PO cannot be received.
6. A purchase without a PO behaves exactly as before.
7. Low stock: acetic acid 40 with a limit of 50: Create PO suggests 60; after approval it shows "on order" and no second Create PO; after receiving it the warning goes.
8. Two people receive the same last quantity at once: only one succeeds.
