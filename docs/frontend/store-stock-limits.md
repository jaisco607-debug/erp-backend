# STORE > SETTINGS: low-stock limit of each chemical, and the red warning on the stock screen

Owner 2026-11-25. In the store the client sets, for each chemical (item) that is **in stock**, a **limit**. When the stock of that chemical is **at or below the limit**, its row on the **stock screen** turns **red** with a message "stock is low, inward it" and the **date of the last inward**.

Example: Acetic Acid 200 KG, limit 50 KG. At 200 KG nothing shows. When the stock falls to 50 KG or less, the row is red with the message.

Works for both stores (`:store` = `chemical` or `general`). The limit is the item's `reorderLevel` (the minimum that the item form, the low-stock report and the overview already use), so **one number everywhere**: setting it here also shows in the item form, and the overview "low" counts follow it.

> **Update (N-D1): the low-stock list is now joined with Purchase Orders** (on order, suggested order quantity, "Create PO", usual order quantity). See section 5 of `purchase-orders.md`.

## 1. The Settings tab (new): `GET /api/v1/stores/:store/stock-limits`
Needs VIEW on the store service. Query (all optional):
| Param | Meaning |
|---|---|
| `scope` | `inStock` (default): only the chemicals with stock above 0. `withLimit`: the chemicals that have a limit, even if the stock is finished (to clear or change it) |
| `search` | part of the name |
| `categoryId` | one category |
| `low` | `true`: only the chemicals at or below their limit |
| `page`, `limit` | limit at most 200 (default 50) |

Answer:
```json
{
  "data": [
    { "itemId": "…", "name": "Acetic Acid", "label": "ACIDS / Acetic Acid", "category": { "id": "…", "name": "ACIDS" }, "brand": null,
      "unit": "KG", "stockQty": 200, "stock": { "main": 200, "mainUnit": "KG", "sub": 0, "subUnit": "G", "text": "200 KG" },
      "limit": 50, "isLow": false, "warning": null,
      "lastInward": { "inwardId": "…", "idText": "00012", "date": "2026-11-12", "qty": 60, "qtyText": "60 KG", "vendor": "NEXUS", "daysAgo": 13 } }
  ],
  "page": 1, "limit": 50, "total": 2,
  "counts": { "inStock": 2, "withLimit": 1, "low": 0 }
}
```
- `limit` is `null` when no limit is set. The limit is in the item's own unit (`unit`), decimals allowed (up to 3).
- `lastInward` is the last **approved** purchase of the chemical (`null` if it was never inwarded).
- `counts.low` = how many chemicals are at or below their limit (use it for a badge on the tab).

## 2. Save the limits: `PUT /api/v1/stores/:store/stock-limits`
Needs FULL on the store service (a VIEW user gets 403). Send one or many items at once:
```json
{ "items": [ { "itemId": "…", "limit": 50 }, { "itemId": "…", "limit": null } ] }
```
- `limit`: a number above 0 (up to the store quantity limit of the company, see `numbers.storeQty` of `GET /limits`), or **`null` to remove the limit**. `0` is refused (400).
- Answer: `{ "saved": 2 }`. Errors: 400 validation (limit 0 / too big / missing), **422 `DUPLICATE_ITEM`** (the same item twice), 404 (an item of another company or another store).
- Only changed items are written and audited (`STORE_ITEM_LIMIT_SET`).
- **Same limit for many chemicals** is just one request with many items (the screen can offer "apply to all shown").

## 3. The stock screen: `GET /api/v1/stores/:store/stock` (existing route, new fields)
Every item now has:
```json
{ "name": "Acetic Acid", "stockQty": 40, "unit": "KG", "stock": { "text": "40 KG" },
  "limit": 50, "isLow": true,
  "lastInward": { "date": "2026-11-12", "qty": 60, "qtyText": "60 KG", "vendor": "NEXUS", "daysAgo": 13, "idText": "00012", "inwardId": "…" },
  "warning": {
    "level": "RED", "code": "LOW_STOCK", "limit": 50, "limitText": "50 KG", "stockText": "40 KG",
    "message": "Acetic Acid stock is low: only 40 KG left (limit 50 KG). Please inward this chemical. Last inward: 2026-11-12 (60 KG, NEXUS).",
    "lastInward": { "date": "2026-11-12", "qty": 60, "qtyText": "60 KG", "vendor": "NEXUS", "daysAgo": 13 }
  } }
```
- `warning` is **`null`** when the stock is above the limit or there is no limit. When it is not null: show the **row in red** and `warning.message` (a red banner, or a tooltip / second line under the name).
- `warning.code`: `LOW_STOCK` (some stock left) or **`OUT_OF_STOCK`** (stock is 0 or less: "X is out of stock ... Please inward this chemical"). A chemical that has never been inwarded says "It has never been inwarded." in the message and `lastInward` is `null`.
- The list answer also has **`lowCount`**: how many rows are red (a badge for the screen header). With `groupBy` (totals per category / brand) the answer has no `lowCount` and no per-item warnings.
- Show the last inward as the message says, and you can also use `lastInward.date`, `qtyText`, `vendor` and `daysAgo` ("13 days ago") for a clean "Last inward" column. Dates are `YYYY-MM-DD`.

## 3b. The same warning shows EVERYWHERE the chemical and its stock show in the store
Not only on the stock screen. Every place where the store shows a chemical (item) with its stock now carries the same fields: `limit`, `isLow`, `lastInward`, `warning` (`null` when the stock is above the limit or there is no limit). Show the **row / card red with `warning.message`** in each of them:
| Screen | Route | Where the fields are |
|---|---|---|
| Stock screen | `GET /stores/:store/stock` | every item of `data` (and `lowCount`) |
| Items / chemicals list | `GET /stores/:store/items` | every item of `data` |
| Item card | `GET /stores/:store/items/:id` | the item itself |
| After add / edit of an item | `POST` / `PATCH /stores/:store/items` (/:id) | the item in the answer |
| Inward form (the chemical dropdown) | `GET /stores/:store/inwards/form-data` | every item of `items` |
| Chemical page (stock, batches, last purchases, usage, moves, batch usage) | `GET /stores/:store/items/:id/stock`, `/moves`, `/batches`, `/last-inwards`, `/usage`, `/batches/:id/usage` | `item` |
| Chemical request, store side (the store opens a request to send chemicals) | `GET /stores/chemical/requests/:id` (the store side request detail) | each line has **`itemStock`**: `{ stockQty, stock, limit, isLow, warning, lastInward }` for the chemical of that line |
- The low-stock report and the store overview already count / list the chemicals under their limit (they use the same limit).
- The department's own screens (where a department picks chemicals to ask for) are not changed.
- In a dropdown, mark a low chemical with a small red dot and show `warning.message` as its tooltip.

## 4. The screens (suggested)
**Store > Settings > Stock limits** (a tab in the store's settings, next to the other settings):
- Table of the chemicals **in stock** (`scope=inStock`): name, category, unit, current stock, last inward (date, quantity), a **number box "Low stock limit"** (empty = no limit), and a small red mark when `isLow`.
- Search box, category filter, a filter "Low only" (`low=true`), and a switch "Show chemicals with a limit but no stock" (`scope=withLimit`).
- A **Save** button that sends only the rows the user changed (one `PUT` with the changed items). Clearing a box sends `limit: null`.
- After saving, show "Saved" and reload; refresh the stock screen's warnings.
- Tab badge: `counts.low`.

**Stock screen** (where the chemicals and their stock show):
- A row with `warning` != null is **red**; show `warning.message` on the row (under the name, or a red icon that opens it).
- Show a "Last inward" column from `lastInward`.
- Header badge: `lowCount` ("3 chemicals are low").

## 5. Quick checks
1. Inward Acetic Acid 200 KG. In Settings > Stock limits it is listed (a chemical with no stock is not). Set the limit 50 and save: the stock screen shows it normally.
2. Reduce the stock to 40 KG (issue to a department / return to the vendor): the row is red with "Acetic Acid stock is low: only 40 KG left (limit 50 KG). Please inward this chemical. Last inward: …".
3. Stock exactly equal to the limit (50 KG): still red (at or below).
4. Clear the limit (empty box): the red goes.
5. A user with VIEW only can see the tab but Save is refused (403): hide the Save button for him.
6. The limit typed in the item form (field "minimum / reorder level") and the one in Settings are the same number.
