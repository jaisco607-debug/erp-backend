# Step 7 – Chemical Store & General Items Store (frontend guide)

Base URL: `/api/v1`. Every call needs `Authorization: Bearer <accessToken>`.
`:store` in a URL is either `chemical` or `general`. Both stores work the same way; the only
differences: the chemical store has GST / Other bill types (tabs), the general store only OTHER.
Data of the two stores is completely separate (items, categories, brands, entries, stock).
Vendors are ONE shared list for both stores.

Errors always look like `{ "error": { "code": "RATE_MISSING", "message": "..." } }`.
403 = the user does not have this store. 400 = wrong field shape (`details` lists the fields).

## Screens to build (per store)
1. **Inwards list** (like "CHEMICAL - INWARDS"): filters + tabs + table.
2. **Purchase entry** (like "CHEMICALS PURCHASES - ENTRY"): header, item add row, item table.
3. **Stock**: items with stock, avg rate, value; option to group by category / brand.
4. **Small setup screens / popups**: vendors, items, categories, brands (the "+" buttons in the entry screen open these as popups).

---
## 1. Vendors (shared)
- `GET /vendors?search=&isActive=true` → `{ data: [{ id, code, name, phone, address, isActive, label }], total }`
  `label` is ready to show: `"NEXUS CHEMICAL (197)"`.
- `POST /vendors` `{ name, phone?, address?, code? }` → code is automatic if not sent.
- `PATCH /vendors/:id` `{ name?, phone?, address?, isActive? }`
- `DELETE /vendors/:id` → 204. Error `IN_USE` if the vendor is on any entry (then send `isActive:false`).

## 2. Categories and brands (per store)
- `GET /stores/:store/categories` , `POST` `{ name }`, `PATCH /:id` `{ name?, isActive? }`, `DELETE /:id`
- `GET /stores/:store/brands` — same shape.
- Response row: `{ id, name, isActive }`. Error `NAME_TAKEN` for duplicate name.

## 3. Items (per store)
- `GET /stores/:store/items?search=&categoryId=&brandId=&isActive=true`
- `POST /stores/:store/items` `{ name, unit, categoryId?, brandId? }`
- `PATCH /stores/:store/items/:id` `{ name?, unit?, categoryId?, brandId?, isActive? }`
- Item row:
```json
{ "id": "…", "store": "CHEMICAL", "name": "Caustic Soda", "unit": "KG",
  "category": { "id": "…", "name": "Dyes" }, "brand": null,
  "stockQty": 50, "avgRate": 109.8, "stockValue": 5490, "isActive": true }
```
- `unit` is a dropdown; the list comes from form-data `units`: KG, LTR, PCS, MTR, FEET, BOX, BAG, ROLL, SET, PAIR, DOZEN, DRUM, CAN, PKT.
- KG with grams: send decimals. 2 kg 500 g = `2.5`. 750 g = `0.75`. (Show it as "2 kg 500 g" if you like: kg = whole part, g = decimal × 1000.)
- `UNIT_LOCKED`: unit cannot change once the item was used.

## 4. Purchase entry screen
### Load once when the screen opens
`GET /stores/:store/inwards/form-data` →
```json
{ "store": "CHEMICAL", "nextIdNo": 909, "nextIdText": "00909", "today": "2026-10-14",
  "billTypes": ["GST", "OTHER"], "units": ["KG", "LTR", "..."],
  "vendors": [ {"id": "…", "label": "NEXUS CHEMICAL (197)"} ],
  "items": [ {"id": "…", "name": "Caustic Soda", "unit": "KG", "category": {…}, "brand": {…}, "stockQty": 50, "avgRate": 109.8} ],
  "categories": [ … ], "brands": [ … ] }
```
### Fields → what to send
| Screen field | JSON field | Notes |
|---|---|---|
| STATUS (Bill-GST / Other) | `billType` | `"GST"` or `"OTHER"`; chemical only (hide on general) |
| VENDOR dropdown | `vendorId` | can be empty in a draft; needed to approve |
| NOTES | `notes` | shown as "Description" in the list |
| Date | `inwardDate` | `"2026-10-14"` (required) |
| AcntID | `acntNo` | text |
| DC# | `dcNo` | text |
| GRN# | `grnNo` | text (optional) |
| Sales tax | `salesTax` | amount in rupees, for GST bills |
| IP# / Ids | read only | ID shows `idText`; IP# comes after approval |

### Item add row
Select item (dropdown from `items`) → UNIT fills automatically from the item → type QNTY and RATE →
AMOUNT = QNTY × RATE (calculate on screen) → **Add** puts it into the table below (still only on screen).
RATE may be left empty if not known yet (send `rate: null`). Table: ID, ITEM NAME (general also BRAND, CATEGORY), QNTY, UNIT, RATE, AMOUNT, Action (remove). Total row = sum of QNTY and AMOUNT.

### SAVE (as draft = UN-APPROVED)
`POST /stores/:store/inwards`
```json
{ "inwardDate": "2026-10-14", "billType": "GST", "vendorId": "…", "acntNo": "1573", "dcNo": "8939",
  "notes": "", "salesTax": 6075,
  "lines": [ { "itemId": "…", "qty": 25, "rate": 1350 }, { "itemId": "…", "qty": 2.5, "rate": null } ] }
```
Add `"approve": true` to save and approve in one click.

### Open / edit an entry
- `GET /stores/:store/inwards/:id` → header + `lines: [{ id, item:{id,name,unit,category,brand}, qty, unit, rate, amount }]`
- `PATCH /stores/:store/inwards/:id` → same body as POST, every field optional. When `lines` is sent it REPLACES all lines (send the whole table). Add `"approve": true` to approve too.
- Only UN-APPROVED entries can be edited (`ENTRY_APPROVED` otherwise).

### Buttons
- **SAVE** → POST (new) or PATCH (existing).
- **APPROVE** → `POST /stores/:store/inwards/:id/approve`. Stock goes up only now.
  Errors: `RATE_MISSING` (some rate empty), `VENDOR_MISSING`, `NO_LINES`.
- **UN-APPROVE** (show only for client admin) → `POST /stores/:store/inwards/:id/unapprove`. Error `STOCK_USED` if that stock was already issued.
- **DELETE** → `DELETE /stores/:store/inwards/:id` (204). Only drafts that were never approved (`ENTRY_APPROVED`, `ENTRY_HAS_IP`).
- **NEW** → clear the form and reload form-data. **CLOSE** → back to the list.
- Top-right label: `statusText` = `"UN-APPROVED"` (red) or `"APPROVED"` (green).

## 5. Inwards list screen
`GET /stores/:store/inwards?tab=all&dateFrom=2026-10-01&dateTo=2026-10-14&ipNo=&dcNo=&grnNo=&vendor=&description=&page=1&limit=25`
- Tabs: chemical → **All | GST Bills | Other Bills | Draft** (`tab=all|gst|other|draft`); general → **All | Draft**.
- Date checkbox off → do not send dateFrom/dateTo. Refresh button → call again.
- `vendor` = part of vendor name, `description` = part of notes or of an item name.
- Response: `{ data: [row], total, page, limit, draftCount }` (show draftCount on the Draft tab).
- Row:
```json
{ "id": "…", "idText": "00908", "ipNo": 506, "acntNo": "1573", "inwardDate": "2026-08-22", "dcNo": "8939",
  "vendor": { "label": "NEXUS CHEMICAL (197)" }, "notes": "", "totalQty": 25, "amount": 33750,
  "salesTax": 6075, "billed": 39825, "paid": 0, "balance": 39825, "isApproved": true,
  "statusText": "APPROVED", "hasMissingRates": false, "billType": "GST" }
```
| Column | Field |
|---|---|
| ID | `idText` — red badge when `isApproved` is false, blue when true |
| IP# | `ipNo` (empty for drafts) |
| ACNT# | `acntNo` |
| Date | `inwardDate` (show as 22-Aug-26) |
| DC# | `dcNo` |
| Vendor Name | `vendor.label` |
| Description | `notes` |
| Qnty / Amount / Sales Tax / Billed / Paid / Balance | `totalQty`, `amount`, `salesTax`, `billed`, `paid`, `balance` |
Click on ID → open the entry screen with `GET /inwards/:id`. `paid` is 0 until the accounts module.

## 6. Stock screen
- `GET /stores/:store/stock?search=&categoryId=&brandId=&inStockOnly=true` →
  `{ data: [item rows as in section 3], totalValue }`. Columns: Item, Category, Brand, Unit, Stock Qty, Avg Rate, Value.
- Group view: `GET /stores/:store/stock?groupBy=category` (or `brand`) →
  `{ groupBy, data: [{ id, name, itemCount, stockValue, byUnit: { "KG": 50, "LTR": 10 } }], totalValue }`.
- Item history (click an item): `GET /stores/:store/items/:id/moves?dateFrom=&dateTo=` →
  `{ item, data: [{ date, kind, qty, value, ipNo, vendor }] }`. `kind`: `INWARD`, `INWARD_UNDO` (later also issues to departments).

## Rules in short
- Average rate = stock value ÷ stock qty, updated on every approval.
- Drafts never touch stock. Only approved entries do.
- Inactive vendors / items are hidden from form-data dropdowns but old entries still show them.
