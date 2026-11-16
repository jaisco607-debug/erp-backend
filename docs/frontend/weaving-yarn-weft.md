# Weaving — Yarn Outward > Weft — Frontend Guide

New screen **Weaving > Yarn Outward > Weft** (the list titled "Yarn - Weft"). A **challan** (delivery challan) takes yarn **out of the stock** and sends it to the weft. The user picks **any stock entry** (a yarn inward entry) and **any number of bags** of it; one challan can have many lines. The yarn stock and the balance of every inward entry go down at once.

All calls are under `/api/v1/weaving`, service `WEAVING_MASTERS` (`VIEW` = read, `FULL` = add / edit / delete).

## 1. The new-challan form
1. **Date** (`outwardDate`, default today; not before the date the yarn came in).
2. **Department** (`department`, optional text, max 50 — Sulzer, Air jet ...). A plain text box for now (a dropdown of weft departments can come later if you want one).
3. **Description** (`description`, optional, max 300).
4. **Lines**: a table where the user adds stock entries and types the **bags** to send. The list of stock entries to pick from:

### `GET /weaving/yarn-weft/stock-entries`
Only the yarn inward entries that still have bags. Filters: `search` (party, DC no, count, brand, inward ID), `itemId`, `vendorId`, `customerId`, `type` (`PURCHASE` / `OVERHEAD`). Oldest first.
```json
{ "data": [ { "id": "<inward id: send it as inwardId>", "code": 1, "inwardDate": "2026-11-01", "type": "PURCHASE", "dcNo": "DC-9",
   "party": { "kind": "VENDOR", "id": "...", "name": "Yarn Mills" },
   "item": { "name": "22|s Cotton - Crescent - 24 - 100", "yarnCount": { "name": "22|s Cotton" }, "brand": { "name": "Crescent" }, "packing": 24, "bags": 100 },
   "lbsPerBag": 100, "bags": 10, "outwardBags": 3, "balanceBags": 7, "balanceLbs": 700 } ],
  "total": 1 }
```
Show per row: inward ID, date, party, yarn count, brand, packing, lbs per bag, **balance bags** and balance lbs. The user types **Bags** (whole number, 1 to `balanceBags`). Show **Lbs** = bags × `lbsPerBag` live; the server does the same sum. One stock entry can be used **once per challan** (400 if the same `inwardId` is sent twice).

## 2. API
| Call | Needs | |
|---|---|---|
| `GET /yarn-weft/stock-entries` | VIEW | the picker (above) |
| `GET /yarn-weft?page=&limit=&search=&dateFrom=&dateTo=&department=` | VIEW | the list, newest first (`limit` up to 500, default 50) |
| `GET /yarn-weft/:id` | VIEW | one challan with its lines (also the **print**) |
| `POST /yarn-weft` | FULL | make a challan, 201 |
| `PATCH /yarn-weft/:id` | FULL | change it |
| `DELETE /yarn-weft/:id` | FULL | delete, `{ deleted: true, id }` |

### Create
```json
{ "outwardDate": "2026-11-05", "department": "Sulzer", "description": "weft issue",
  "lines": [ { "inwardId": "<stock entry>", "bags": 3 }, { "inwardId": "<another entry>", "bags": 4 } ] }
```
`lines`: 1 to 200 lines. Everything else is optional.

### The challan
```json
{ "id": "...", "type": "WEFT", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05", "department": "Sulzer", "description": "weft issue",
  "totalBags": 7, "totalLbs": 502,
  "lines": [ { "id": "...", "inwardId": "...", "inwardCode": 1, "inwardDate": "2026-11-01", "dcNo": "DC-9",
      "party": { "kind": "VENDOR", "id": "...", "code": 1, "name": "Yarn Mills" },
      "name": "22|s Cotton - Crescent - 24 - 100", "yarnCount": { "id": "...", "name": "22|s Cotton" }, "brand": { "id": "...", "name": "Crescent" }, "packing": 24,
      "lbsPerBag": 100, "bags": 3, "lbs": 300 } ],
  "createdAt": "..." }
```
- **`challanNo`** is the **delivery challan number**: a running number of the company (1, 2, 3 ...), made by the server. `challanText` is the same padded (`00001`) for printing. A deleted challan's number is never used again.
- Each line carries what the challan must show: **party (customer / vendor name)**, **yarn count, brand, packing**, **lbs per bag**, **bags**, **lbs**. Date, department and description are on the challan.
- Print the challan from `GET /yarn-weft/:id`.

### The list (Yarn - Weft screen)
```json
{ "data": [ { "id": "...", "type": "WEFT", "challanNo": 2, "challanText": "00002", "outwardDate": "2026-11-06", "department": "Air jet", "description": null,
              "lineCount": 1, "totalBags": 7, "totalLbs": 700, "parties": "Yarn Mills", "brands": "Crescent" } ],
  "page": 1, "limit": 50, "total": 2, "totals": { "entries": 2, "bags": 14, "lbs": 1202 } }
```
Columns: **ID / DC # (`challanNo`)**, **Date**, **Depart**, **Description**, **Party** (`parties`), **Brand** (`brands`), **Bags**, **Lbs**. Cards from `totals`: entries, bags, lbs. `totals` is for the **whole filtered list**. `search` finds the challan number, department, description, party, count or brand. There is no Draft / Confirmed state: a saved challan has already taken the yarn.

### Change (`PATCH`)
Any of `outwardDate`, `department`, `description`, `lines`. `lines` **replaces** all the lines; the stock is checked as if the old lines had not been taken (so the user can lower or raise a line). The challan number does not change.

### Delete
Deleting a challan **puts its yarn back** into the stock.

## 3. What changes in the other weaving screens
- **Yarn Stock** (`GET /yarn-stock`): `outwardBags` / `outwardLbs` are now filled and `balanceBags` / `balanceLbs` go down (`dateTo` counts the challans up to that day). Rows with no balance stay hidden unless `showZero=true`.
- **Yarn Inward** entries (list, one): two new fields `outwardBags` and `balanceBags` (bags already sent out, and left). Show them (a "Balance bags" column is useful).
- An inward entry that has yarn on a challan:
  - cannot be deleted: 422 `IN_USE` (`details.outwardBags`),
  - its `bags` cannot go below the bags sent out: 422 `BELOW_OUTWARD`,
  - its item card and `lbsPerBag` cannot change and its date cannot move later: 422 `USED_IN_OUTWARD`.
  Show these messages; to change such an entry the user first deletes / changes the challan.

## 4. Errors
- 422 `NOT_ENOUGH_STOCK`: more bags than are left. `details: { line, inwardId, inwardCode, balanceBags, askedBags }` — show it on that line (the stock can change while the form is open, or another user took the yarn).
- 422 `BEFORE_INWARD`: the challan is dated before the yarn came in (`details.inwardDate`).
- 422 `UNKNOWN_STOCK_ENTRY`: the entry is not of this company / does not exist.
- 400 `VALIDATION_FAILED`: no lines, `bags` not a whole number >= 1, the same `inwardId` twice, bad date.
- 403 no access / `VIEW` only; 404 unknown challan or another company's.

## Not in this step
Direct yarn sale and sending yarn / beams to sizing (the other outward kinds), the gate pass, and the accounting vouchers come next. The challan is already built so they can use it: `type` is `WEFT` now and will be `SALE` / `SIZING` later.

## Database
Migration `20261205000001-weaving-yarn-outward.js` (`yarn_outwards`, `yarn_outward_lines`). Run `npm run db:migrate`.
