# STORE: Chemical returns + Stock adjustment (frontend guide)

Two small features. Build part 1 first, then part 2.

## 0. What changed in the backend and database (migration 20261017000003)
- NEW `chemical_returns` (returnNo, requestId, departmentId, status, notes, rejectReason, totalValue, createdBy, receivedBy/At, closedBy/At) and `chemical_return_lines` (requestLineId, itemId, qty, rate, value).
- `chemical_request_lines` got `returnedQty`, `returnedValue`; `chemical_requests` got `returnedValue`.
- NEW `store_adjustments` (adjNo per store, adjDate, reason, notes, totalValue, createdBy) and `store_adjustment_lines` (itemId, stockBefore, qty + or -, rate, value).
- `store_moves` got `returnId`, `adjustmentId`. New move kinds: `RETURN`, `ADJUST`.
- Item stock history (`GET /stores/:store/items/:id/moves`) now also gives `kindText` ("Purchase", "Issued to department", "Returned by department", "Stock adjustment"), `qtySplit`, `department`.
- Everything is in the audit log. Quantities: always show `...Split.text` (e.g. "500 G"), input KG + G boxes (`qtyMain` + `qtySub`).

---------------------------------------------------------------
# PART 1: Chemical returns (department sends unused chemical back)

## Rules
- Only from a request that is **Received** (Delivered).
- Per line, at most `returnableQty` (sent - already returned - already on its way back).
- Status: department sees **Sent back -> Returned** (or Rejected / Cancelled); store sees **To receive -> Received**.
- When the store presses Receive: stock goes UP at the same rate it went out, and the Job / SO card **chemical cost goes DOWN** by that value (all cost APIs and reports already use it).
- Requests now also have `returnedValue` and `netValue` (= totalValue - returnedValue). Lines have `returnedQty`, `returnedSplit`, `returnableQty`. Show `netValue` as the cost.

## 1a. Department: "Send back" button
On a Received request detail, show **Send back** when any line has `returnableQty > 0`.
Popup: each chemical with "Can send back: X" (`returnableQty` split) and KG + G boxes; notes.
```json
POST /departments/:code/chemical-returns
{ "requestId": "uuid", "notes": "",
  "lines": [ { "requestLineId": "uuid (line id of the request)", "qtyMain": 0, "qtySub": 500 } ] }
```
Errors: `NOT_RECEIVED`, `TOO_MUCH` (message says the max), `UNKNOWN_LINE`, `DUPLICATE_ITEM`, `QTY_REQUIRED`.

## 1b. Department: Returns list
`GET /departments/:code/chemical-returns?tab=pending|received|closed|all&requestId=&page=1&limit=20`
```json
{ "data": [ { "id": "uuid", "returnNo": 1, "status": "PENDING", "departmentStatusText": "Sent back", "storeStatusText": "To receive",
    "request": { "reqNo": 1 }, "job": { "jobNo": 12 }, "totalValue": 50,
    "lines": [ { "item": { "label": "... / RED" }, "qtySplit": { "text": "500 G" }, "rate": 100, "value": 50 } ],
    "createdBy": { "name": "Ali" }, "createdAt": "...", "receivedBy": null, "receivedAt": null, "closedBy": null, "closedAt": null, "rejectReason": null } ],
  "total": 1, "counts": { "pending": 1, "received": 0, "closed": 0 } }
```
Detail: `GET /departments/:code/chemical-returns/:id`. Cancel while pending: `POST /departments/:code/chemical-returns/:id/cancel`.

## 1c. Chemical Store: Returns tab
- `GET /stores/chemical/returns?tab=pending&departmentId=` (same shape; show `storeStatusText`, department name).
- **Receive**: `POST /stores/chemical/returns/:id/receive`
- **Reject**: popup reason -> `POST /stores/chemical/returns/:id/reject` `{ "reason": "Chemical kharab hai" }`
- Timeline: sent back by/at, received by/at, rejected/cancelled by/at.

---------------------------------------------------------------
# PART 2: Stock adjustment (both stores: `/stores/chemical/...` and `/stores/general/...`)

## Rules
- Store FULL access. Applies at once. Cannot be edited or deleted: a wrong one is fixed with another adjustment.
- Reasons (dropdown): `COUNT` Stock count, `DAMAGED` Damaged, `EXPIRED` Expired, `LOST` Lost / missing, `OTHER` Other.
- Each line has a mode (toggle with 3 options):
  - **COUNT** "We counted": enter what is really there; the system makes the difference.
  - **OUT** "Remove": stock down (damaged, expired ...), valued at average rate.
  - **IN** "Add": stock up; optional rate (empty = average rate).

## 2a. New adjustment screen
Fields: Date (default today), Reason dropdown, Notes, rows: Item dropdown (show current stock `stock.text`), Mode toggle, KG + G boxes, Rate (only for IN), + Add row.
```json
POST /stores/chemical/adjustments
{ "adjDate": "2026-10-17", "reason": "COUNT", "notes": "",
  "lines": [ { "itemId": "uuid", "mode": "COUNT", "qtyMain": 9, "qtySub": 750 } ] }
```
Response (201):
```json
{ "adjNo": 1, "reason": "COUNT", "reasonText": "Stock count", "totalValue": -25,
  "lines": [ { "item": { "label": "... / RED" }, "direction": "OUT",
    "stockBeforeSplit": { "text": "10 KG" }, "qtySplit": { "text": "250 G" }, "stockAfterSplit": { "text": "9 KG 750 G" }, "rate": 100, "value": -25 } ],
  "createdBy": { "name": "Store" }, "createdAt": "..." }
```
Errors: `NO_CHANGE` (count same as stock), `NOT_ENOUGH_STOCK`, `UNKNOWN_ITEM`, `DUPLICATE_ITEM`, `QTY_REQUIRED`.

## 2b. Adjustments list
`GET /stores/chemical/adjustments?reason=&itemId=&dateFrom=&dateTo=&page=1&limit=20`
Columns: Adj#, Date, Reason (`reasonText`), Items, Value (red when minus), By. Click -> `GET /stores/chemical/adjustments/:id` showing Before / Change (+ or -) / After per item.
