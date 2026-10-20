# STORE: Chemical Inwards and General Inwards (frontend guide, part 1)

This guide covers: **Chemical Inwards** and **General Inwards** (LIST screen + ENTRY screen: add, view, edit, delete, approve),
and the **Stock** screen with the per-chemical detail (B11, B12).
Nothing else of the store is needed yet. Later parts come as separate small guides.

---------------------------------------------------------------
# PART A: WHAT IS IN THE BACKEND AND DATABASE

## A1. One Store, two separate parts
- The Store has two parts: **Chemical** and **General**. Both work the same way, but their data never mixes.
- In every URL, `:store` is `chemical` or `general`:
  - Chemical: `/api/v1/stores/chemical/inwards`
  - General: `/api/v1/stores/general/inwards`
- Only difference: Chemical has bill types **GST** and **OTHER** (with a GST % dropdown). General has only OTHER (no GST).
- Login user needs the service "Chemical Store" (for chemical) or "General Items Store" (for general). VIEW = can only see. FULL = can add, edit, delete, approve. Without it the server answers 403.

## A2. Database tables used by these screens
| Table | What it keeps |
|---|---|
| `vendors` | Suppliers. ONE list for both stores. `code` (number, automatic), `name`, `phone`, `address`, `isActive`. |
| `store_items` | Items of each store: `name`, `unit` (KG, LTR, PCS ...), category, brand, current stock. |
| `store_inwards` | One purchase entry (bill). `idNo` (ID, shown as 00908), `ipNo` (IP#, given on approval), `inwardDate`, `billType` (GST/OTHER), `vendorId`, `acntNo`, `dcNo`, `grnNo`, `notes`, `totalQty`, `amount`, `gstPercent`, `salesTax`, `isApproved`. |
| `store_inward_lines` | The items of an entry: `itemId`, `qty`, `rate` (can be empty in a draft), `amount`. |
| `store_moves` | Stock history. A row is added when an entry is approved (stock IN). |

Changes made on 2026-10-16:
- New column `store_inwards.gstPercent`: GST % picked from the dropdown (0 / 17 / 18). The server works out the sales tax.
- Quantity of KG and LTR items can be sent in two boxes (KG + G, LTR + ML). The server returns quantities split the same way.
- Vendor can be TYPED: if the typed name is new, the server adds the vendor automatically.
- Item can be TYPED too (same way): a new name is added to the store, and shows in the dropdown next time.
- The client's full chemical list is now in the database (migration 20261016000002): 14 categories and about 220 chemicals, unit KG. Sub-groups are categories named like "VAT DYES / AMBIFIX". Every new company gets the same list.
- An item name may now repeat in two different categories (e.g. "RED" in two dye groups). It is unique inside one category.
- **One chemical = one record.** Buying the same chemical again (from the same vendor or another vendor) NEVER makes a second chemical. Every purchase is a separate inward line, but the stock of that chemical is ONE total. Typing an existing name (any case) reuses the existing chemical.
- NEW endpoint `GET /stores/:store/items/:id/stock`: one chemical's total stock, what was bought from each vendor, and every purchase on its own (B12).
- Stock list rows now also have `purchaseCount` and `vendorCount`.
- Empty strings are now accepted: `"itemId": ""` + `"itemName": "..."` means a typed item; `"vendorId": ""` means no vendor.

## A3. Rules on the server
1. **Draft = UN-APPROVED.** A new entry is saved as a draft. A draft may have lines WITHOUT a rate (rate not known yet). A draft does NOT add stock.
2. **Approve.** When every line has a rate and a vendor is chosen, the entry can be approved. Then: it gets its IP#, it is locked, and its items go into stock (inventory).
3. **Edit / Delete** only while UN-APPROVED. A deleted draft is gone. An entry that was approved once cannot be deleted (only edited after un-approve).
4. **Un-approve** only the client admin can do, and only if that stock was not used yet.
5. **Kg and grams are never shown together as 3.5 kg**: always "3 KG 500 G".
6. **Stock is per chemical, not per purchase or vendor.** Example: RED bought 3 times (twice from NEXUS, once from USMAN) = ONE item "RED" with one stock (sum of all 3). The 3 purchases and the 2 vendors are shown separately in the detail (B12).

Base URL `/api/v1`. Header on every call: `Authorization: Bearer TOKEN`.
Errors always come as `{ "error": { "code": "RATE_MISSING", "message": "..." } }`. Show `message` in a toast.

---------------------------------------------------------------
# PART B: SCREENS

## B1. Inwards LIST screen ("CHEMICAL - INWARDS" / "GENERAL - INWARDS")

### Call
`GET /stores/:store/inwards?tab=all&page=1&limit=25`
Optional filters (send only the ones filled):
| Screen control | Query param |
|---|---|
| Date checkbox ticked + From / To dates | `dateFrom=2026-10-01&dateTo=2026-10-16` (checkbox not ticked: do not send dates) |
| IP # box | `ipNo=506` (number) |
| DC # box | `dcNo=8939` (part of DC#) |
| GRN # box | `grnNo=...` |
| vendor name box | `vendor=nexus` (part of the name) |
| description box | `description=red` (part of notes or of an item name) |
| Tabs | `tab=all` / `gst` / `other` / `draft` |

- Tabs for Chemical: **All**, **GST Bills**, **Other Bills**, **Draft**.
- Tabs for General: **All**, **Draft**.
- **Refresh** button: call again with the current filters.

### Response
```json
{ "data": [
  { "id": "uuid", "idNo": 908, "idText": "00908", "ipNo": 506, "acntNo": "1573",
    "inwardDate": "2026-08-22", "dcNo": "8939", "grnNo": null, "billType": "GST",
    "vendor": { "id": "uuid", "code": 197, "name": "NEXUS CHEMICAL", "label": "NEXUS CHEMICAL (197)" },
    "notes": null, "totalQty": 25, "totalQtyText": null,
    "amount": 33750, "gstPercent": 18, "salesTax": 6075, "billed": 39825, "paid": 0, "balance": 39825,
    "isApproved": true, "statusText": "APPROVED", "hasMissingRates": false } ],
  "total": 120, "page": 1, "limit": 25, "draftCount": 3 }
```
(`totalQtyText` is filled on the entry detail; in the list show `totalQty`.)

### Table columns
| Column | Field |
|---|---|
| ID | `idText` as a badge: RED when `isApproved` is false (draft), BLUE when true |
| IP# | `ipNo` (empty for a draft) |
| ACNT# | `acntNo` |
| Date | `inwardDate`, shown as 22-Aug-26 |
| DC# | `dcNo` |
| Vendor Name | `vendor.label` (empty when no vendor) |
| Description | `notes` |
| Qnty | `totalQty` |
| Amount | `amount` |
| Sales Tax | `salesTax` |
| Billed | `billed` |
| Paid | `paid` (0 until the accounts module) |
| Balance | `balance` |
- Last row: **Total** of Qnty, Amount, Sales Tax, Billed, Paid, Balance (add up on screen).
- Show `draftCount` on the Draft tab, e.g. "Draft (3)".
- Paging: `total`, `page`, `limit`.
- **create** button: opens the ENTRY screen empty (B2).
- Click on an ID badge: opens the ENTRY screen for that entry (B4).

## B2. ENTRY screen: load data once
When the entry screen opens (new or existing), call:
`GET /stores/:store/inwards/form-data`
```json
{ "store": "CHEMICAL", "nextIdNo": 913, "nextIdText": "00913", "today": "2026-10-16",
  "billTypes": ["GST", "OTHER"], "gstRates": [0, 17, 18], "subUnits": { "KG": "G", "LTR": "ML" },
  "units": ["KG", "LTR", "PCS", "MTR", "FEET", "BOX", "BAG", "ROLL", "SET", "PAIR", "DOZEN", "DRUM", "CAN", "PKT"],
  "vendors": [ { "id": "uuid", "code": 197, "name": "NEXUS CHEMICAL", "label": "NEXUS CHEMICAL (197)" } ],
  "items": [ { "id": "uuid", "name": "RED", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG", "category": { "id": "uuid", "name": "COTTON COLOUR (REACTIVE DYES)" }, "brand": null,
               "hasSubUnit": true, "subUnit": "G", "stockQty": 3.5, "avgRate": 1350 } ],
  "categories": [ { "id": "uuid", "name": "COTTON COLOUR (REACTIVE DYES)", "isActive": true } ], "brands": [ ] }
```
- `items` come sorted by category, then name. Each has `label` ready to show ("CATEGORY / NAME").
- `billTypes` for General is only `["OTHER"]`: hide the STATUS dropdown and the GST dropdown on General.
- `vendors` and `items` contain only active ones.

## B3. ENTRY screen: ADD a new entry ("CHEMICALS PURCHASES - ENTRY")

### Header fields
| Screen field | Control | JSON field | Notes |
|---|---|---|---|
| STATUS | dropdown "Bill - GST" / "Other" | `billType`: `"GST"` or `"OTHER"` | Chemical only |
| VENDOR | type-ahead box (see below) | `vendorId` OR `vendorName` | can be empty in a draft |
| NOTES | text | `notes` | max 500 |
| IP# | read only | | shows "0" for new; real IP# comes after approval |
| Ids | read only | | new: `nextIdText` from form-data (e.g. 00913) |
| Date | date picker, default `today` | `inwardDate` | "2026-10-16", required |
| AcntID | text | `acntNo` | max 30 |
| DC# | text | `dcNo` | max 50 |
| GRN# | text (optional) | `grnNo` | max 50 |

### VENDOR box: select OR type
One box that works both ways:
1. The user starts typing. Show a dropdown of matching vendors from form-data `vendors` (match on `name`, show `label`).
2. **User picks one from the list:** keep its id and send `"vendorId": "uuid"`.
3. **User types a name that is not in the list** and leaves the box: send `"vendorName": "MUNAF LUNDA"` (and no vendorId).
   - The server looks for a vendor with that name (big/small letters do not matter). If found, it uses it. If not, it ADDS the vendor with the next code.
   - The response has the vendor (`vendor.id`, `vendor.label`). After saving, reload form-data so the new vendor is in the list.
4. Empty box: send nothing (or `"vendorId": null`). Allowed for a draft only.
(Optional: for a long list call `GET /vendors?search=mun&isActive=true` while typing; it returns `{ data: [vendor], total }`.)

### Item add row (above the table)
Controls: **PRODUCT NAME** (select item) | **QNTY** | **UNIT** | **RATE** | **AMOUNT** | **Add** button.
1. PRODUCT NAME: ONE type-ahead box (select OR type), like the vendor box.
   - Optional small **Category** dropdown before it (from form-data `categories`). When a category is chosen, the item list shows only that category's items.
   - While typing, show the matching items from form-data `items` (match on `name` or `label`), shown as `label` ("COTTON COLOUR (REACTIVE DYES) / RED"). You may group the list by category.
   - **User picks an item:** keep its id, send `"itemId": "uuid"`.
   - **IMPORTANT for typing:** the box must keep what the user typed even when nothing in the list matches (do not clear it on blur). If the user did not pick from the list, use the typed text as `itemName` and leave `itemId` empty.
   - **User types a name that is already in the list** (e.g. "red" while "RED" exists): best is to auto-pick that item (send its `itemId`). If you send it as `itemName`, the server still uses the existing item; it is NOT added twice.
   - **User types a name that is not in the list:** send `"itemName": "LEMON ACID"` (and `"categoryId"` if a category is chosen, and `"unit"` if the user picked one; default unit: KG for chemical, PCS for general).
     The server uses the item with that name if it exists (big/small letters do not matter), else ADDS it. After saving, reload form-data: the new item is in the dropdown next time.
     If that name is in two categories and no category was chosen, the server answers `PICK_CATEGORY`: ask the user to choose the category.
2. UNIT fills in automatically from the picked item (read only). For a typed new item show a UNIT dropdown (form-data `units`, default KG).
3. QNTY:
   - Item with `hasSubUnit: true` (KG or LTR): show **two boxes**: "KG" and "G" (for LTR: "LTR" and "ML"). The second box must be 0 to 999.
   - Other units (PCS, BAG ...): one box.
4. RATE: number, per KG / LTR / PCS. May be left empty when the rate is not known (the entry then stays a draft).
5. AMOUNT (read only, work it out on screen): (KG + G / 1000) x RATE. Empty rate: amount 0.
6. **Add**: puts the line in the table below. Nothing is sent to the server yet.
- The "+" next to PRODUCT NAME may also open a small "new item" popup: `POST /stores/:store/items` with `{ "name": "RED", "unit": "KG", "categoryId": "uuid" }`, then reload form-data. (Not needed if you use typing.)

### Item table
Columns: ID (row no.), ITEM NAME, (General: also BRAND NAME and CATEGORY NAME), QNTY (show as "25 KG 500 G"), UNIT, RATE, AMOUNT, Action (remove button; while editing a draft also allow changing qty/rate).
Total row: total QNTY and total AMOUNT.

### Bottom totals
| Label | Value |
|---|---|
| Qnty | total qty |
| Gross Amount | sum of line amounts |
| GST (Chemical + GST bill only) | dropdown from `gstRates` (0%, 17%, 18%) -> send `gstPercent` |
| Sales tax (shown next to GST) | Gross Amount x GST % (show it; the server works it out too) |
| Net Amnt | Gross Amount + Sales tax |
| Paid Amnt / Balance Amnt | 0 / Net Amnt (until the accounts module) |

### SAVE button
`POST /stores/:store/inwards`
```json
{ "inwardDate": "2026-10-16", "billType": "GST", "gstPercent": 18,
  "vendorId": "uuid", "acntNo": "1573", "dcNo": "8939", "grnNo": "", "notes": "",
  "lines": [
    { "itemId": "uuid-red", "qtyMain": 25, "qtySub": 0, "rate": 1350 },
    { "itemId": "uuid-soda", "qtyMain": 2, "qtySub": 500, "rate": null },
    { "itemId": "uuid-bags", "qty": 12, "rate": 40 },
    { "itemName": "LEMON ACID", "categoryId": "uuid", "unit": "KG", "qtyMain": 1, "qtySub": 250, "rate": null } ] }
```
- Per line send EITHER `itemId` (picked) OR `itemName` (typed), not both.
- Per line send EITHER `qtyMain` + `qtySub` (KG/LTR items) OR `qty` (other units). Not both.
- `rate: null` = rate not known yet.
- Typed vendor: send `"vendorName": "NEW NAME"` instead of `vendorId`.
- General store: do not send `billType` or `gstPercent`.
- At least 1 line is needed.
- **Save and approve in one click** (optional second button "Save & Approve"): add `"approve": true`.
- Response (201): the full entry (same shape as B4). Keep `id`; the screen now shows this entry as UN-APPROVED (red label) or APPROVED.

## B4. ENTRY screen: VIEW an entry
`GET /stores/:store/inwards/:id`
```json
{ "id": "uuid", "store": "CHEMICAL", "idNo": 908, "idText": "00908", "ipNo": 506,
  "inwardDate": "2026-08-22", "billType": "GST", "gstPercent": 18,
  "vendor": { "id": "uuid", "code": 197, "name": "NEXUS CHEMICAL", "label": "NEXUS CHEMICAL (197)" },
  "acntNo": "1573", "dcNo": "8939", "grnNo": null, "notes": null,
  "totalQty": 25, "totalQtyText": "25 KG", "amount": 33750, "salesTax": 6075, "billed": 39825, "paid": 0, "balance": 39825,
  "isApproved": true, "statusText": "APPROVED", "approvedAt": "2026-08-22T10:00:00Z", "hasMissingRates": false,
  "lines": [
    { "id": "uuid", "item": { "id": "uuid", "name": "RED", "unit": "KG", "category": "COTON COLOUR (REACTIVE DYES)", "brand": null },
      "qty": 25, "qtySplit": { "main": 25, "mainUnit": "KG", "sub": 0, "subUnit": "G", "text": "25 KG" },
      "unit": "KG", "rate": 1350, "amount": 33750 } ] }
```
- Fill every field from this response.
- QNTY in the table: `qtySplit.text`. In edit mode: KG box = `qtySplit.main`, G box = `qtySplit.sub`.
- Top-right label: `statusText`: **APPROVED** (green) or **UN-APPROVED** (red).
- `hasMissingRates: true` -> show a small note "Some rates are missing (draft)".
- **APPROVED entry**: everything read only. Buttons: EDIT is hidden (or disabled), NEW, CLOSE. (Client admin also sees UN-APPROVE, B7.)
- **UN-APPROVED entry**: fields editable. Buttons: SAVE, DELETE, APPROVE, NEW, CLOSE.

## B5. EDIT (UPDATE) an entry
Only when `isApproved` is false.
`PATCH /stores/:store/inwards/:id` with ONLY the changed fields:
```json
{ "dcNo": "8940", "gstPercent": 17,
  "lines": [ { "itemId": "uuid-red", "qtyMain": 25, "qtySub": 0, "rate": 1350 },
             { "itemId": "uuid-soda", "qtyMain": 2, "qtySub": 500, "rate": 1100 } ] }
```
- If `lines` is sent, it REPLACES all lines: always send the WHOLE table, not only the changed row.
- Header-only change: do not send `lines`.
- Typed vendor works here too (`vendorName`).
- Save and approve together: add `"approve": true`.
- Response: the updated entry (B4 shape).
- Error `ENTRY_APPROVED`: the entry is approved; it cannot be changed.

## B6. DELETE an entry
Only an UN-APPROVED entry that was never approved.
- Ask "Delete this entry?" (Yes / No).
- `DELETE /stores/:store/inwards/:id` -> **204** (no body). Go back to the list and refresh.
- Errors: `ENTRY_APPROVED` (approved, cannot delete), `ENTRY_HAS_IP` (was approved before; edit it instead).

## B7. APPROVE / UN-APPROVE
- **APPROVE** (draft only): `POST /stores/:store/inwards/:id/approve` (no body). Response: the entry, now with `ipNo` and `statusText: "APPROVED"`. Only now the items go into stock.
  - Errors: `RATE_MISSING` (fill every rate first), `VENDOR_MISSING` (choose a vendor), `NO_LINES`.
- **UN-APPROVE** (show this button only to the client admin): `POST /stores/:store/inwards/:id/unapprove`. The entry becomes a draft again (keeps its IP#) and its stock is taken out.
  - Error `STOCK_USED`: that stock was already issued.

## B8. Other buttons
- **NEW**: clear the form, call form-data again (new ID number).
- **CLOSE**: back to the list (refresh the list).

## B9. All errors of these screens
| Code | When | Show |
|---|---|---|
| `RATE_MISSING` | approve with an empty rate | "Enter the rate of every item before approving" |
| `VENDOR_MISSING` | approve without vendor | "Select the vendor before approving" |
| `NO_LINES` | no items | "Add at least one item" |
| `QTY_REQUIRED` | qty 0 | "Enter the quantity" |
| `SUB_TOO_BIG` | grams/ml 1000 or more | message from server |
| `NO_SUB_UNIT` | grams sent for a PCS item | message from server |
| `UNKNOWN_ITEM` | item not in this store | reload form-data |
| `ITEM_REQUIRED` | a line has neither itemId nor itemName | "Select or type the item" |
| `PICK_CATEGORY` | typed item name is in two categories | ask the user to choose the category |
| `UNKNOWN_CATEGORY` | wrong category id | reload form-data |
| `ITEM_INACTIVE` / `VENDOR_INACTIVE` | switched off | message from server |
| `UNKNOWN_VENDOR` | wrong vendor id | reload form-data |
| `ENTRY_APPROVED` | edit/delete an approved entry | message from server |
| `ENTRY_HAS_IP` | delete an entry approved before | message from server |
| `STOCK_USED` | un-approve after stock was used | message from server |
| 400 `VALIDATION_FAILED` | wrong field | show `details` |
| 403 | user has no access to this store | "You do not have access" |

## B10. Short flow (example)
1. Chemical bill came, rate not known: create -> vendor "NEXUS CHEMICAL" -> RED 25 KG 0 G, rate empty -> SAVE. List shows ID 00913 RED badge (draft).
2. Rate confirmed: open 00913 -> type rate 1350 -> GST 18% -> SAVE -> APPROVE. Badge turns BLUE, IP# 507, stock of RED +25 KG.
3. Wrong draft: open -> DELETE.

## B11. STOCK screen (one row per chemical)
`GET /stores/:store/stock?search=&categoryId=&inStockOnly=true`
```json
{ "data": [ { "id": "uuid", "name": "RED", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG",
    "category": { "id": "uuid", "name": "COTTON COLOUR (REACTIVE DYES)" },
    "stockQty": 60, "stock": { "main": 60, "mainUnit": "KG", "sub": 0, "subUnit": "G", "text": "60 KG" },
    "avgRate": 1083.33, "stockValue": 65000, "purchaseCount": 3, "vendorCount": 2 } ],
  "totalValue": 65000 }
```
| Column | Field |
|---|---|
| Category | `category.name` |
| Chemical | `name` |
| Stock | `stock.text` (e.g. "60 KG", "3 KG 500 G") |
| Avg Rate | `avgRate` (per KG / LTR / PCS) |
| Value | `stockValue` |
| Purchases | `purchaseCount` |
| Vendors | `vendorCount` |
- Filters: search box (`search`), Category dropdown (`categoryId`), "Only in stock" checkbox (`inStockOnly=true`).
- Footer: `totalValue`.
- Group by category (optional tab): `GET /stores/:store/stock?groupBy=category` -> `{ data: [{ id, name, itemCount, stockValue, byUnit: { "KG": 50 } }], totalValue }`.
- Click a row: open B12.

## B12. ONE CHEMICAL detail (total stock + per vendor + every purchase)
`GET /stores/:store/items/:id/stock`
```json
{ "item": { "id": "uuid", "name": "RED", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG" },
  "stock": { "qty": 60, "qtySplit": { "text": "60 KG" }, "value": 65000, "avgRate": 1083.33 },
  "byVendor": [
    { "vendor": { "id": "uuid", "label": "NEXUS CHEMICAL (197)" }, "purchases": 2, "qty": 50, "qtySplit": { "text": "50 KG" }, "value": 55000, "avgRate": 1100 },
    { "vendor": { "id": "uuid", "label": "USMAN TRADERS (49)" }, "purchases": 1, "qty": 10, "qtySplit": { "text": "10 KG" }, "value": 10000, "avgRate": 1000 } ],
  "purchases": [
    { "inwardId": "uuid", "idText": "00915", "ipNo": 509, "date": "2026-10-16", "dcNo": "8941",
      "vendor": { "label": "USMAN TRADERS (49)" }, "qty": 10, "qtySplit": { "text": "10 KG" }, "rate": 1000, "amount": 10000 } ] }
```
Layout (top to bottom):
1. **Header**: chemical `item.label`, big number **Total stock** = `stock.qtySplit.text`, Avg rate, Value. This is the ONE stock of this chemical (all vendors together).
2. **By vendor** table: Vendor, Purchases, Qty bought (`qtySplit.text`), Value, Avg rate. (Qty bought = everything bought from that vendor; later, issues to departments lower only the total stock.)
3. **Purchases** table (newest first): ID (`idText`, click opens that inward entry), IP#, Date, DC#, Vendor, Qty, Rate, Amount.
- Only APPROVED entries are counted here. Drafts are not stock yet.

