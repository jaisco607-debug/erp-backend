# CHEMICAL REQUEST part B: Chemical Store side (frontend guide)

Build after part A. One list with tabs + one detail screen with buttons. Only in the Chemical Store menu.

## B1. Backend summary
Same tables as part A. Store names for the status:
| status | department sees | store sees |
|---|---|---|
| PENDING | Pending | **Queue** |
| ACCEPTED | Accepted | **Process** |
| IN_WAY | In-Way | **In-Way** |
| DELIVERED | Received | **Delivered** |
| REJECTED / CANCELLED | Rejected / Cancelled | Rejected / Cancelled |
Use `storeStatusText` from the API.

**Stock goes OUT at Send** (In-Way), at the store **average rate**. Each line gets `rate` and `value`; the request gets `totalValue`. This value is the chemical cost of the Job / SO card (part C). A row is written in the item's stock moves (kind ISSUE, with the department and request).

Access: VIEW on Chemical Store = see. FULL = accept, reject, send.

## B2. Screen 1: Requests list
`GET /stores/chemical/requests?tab=queue&page=1&limit=20`
- tabs: `queue`, `process`, `in_way`, `delivered`, `closed`, `all`
- filters: `departmentId`, `reqNo`, `jobNo`, `soNo`, `dateFrom`, `dateTo`
- Response is the same shape as part A (`data`, `total`, `counts` with keys queue/process/in_way/delivered/closed).
- Columns: Req#, Date, Department (`department.name`), Job#, SO# (or "Whole job"), Chemicals, Status (`storeStatusText`), Requested by.
- Row buttons: Queue -> Accept, Reject. Process -> Send, Reject. Others -> View.

## B3. Detail screen
`GET /stores/chemical/requests/:id`
Lines table: Chemical (`item.label`), Asked (`qtySplit.text`), Store stock now (`stockSplit.text`, red when less than asked), Sent (`sentSplit.text`), Rate, Value.
Timeline exactly like part A (requested / accepted / sent / received / closed: name + time).

## B4. Buttons
- **Accept**: `POST /stores/chemical/requests/:id/accept` -> Process.
- **Reject**: popup with reason (required) -> `POST /stores/chemical/requests/:id/reject` `{ "reason": "Stock short" }`. Allowed in Queue and Process.
- **Send** (in Process): popup with:
  - each line: KG + G boxes, filled with the asked qty (store may send less; 0 = not sent)
  - "Sent through" (person / vehicle, optional)
  ```json
  POST /stores/chemical/requests/:id/send
  { "sentThrough": "Akram",
    "lines": [ { "lineId": "uuid", "qtyMain": 2, "qtySub": 0 } ] }
  ```
  Leave `lines` out to send exactly what was asked. Response: request in In-Way with `totalValue`.

Errors: `NOT_ACCEPTED` (send before accept), `NOT_IN_QUEUE`, `ALREADY_SENT`, `NOT_ENOUGH_STOCK` (message names the chemical, stock and asked, e.g. "Not enough RED: 7 KG 500 G in stock, 20 KG asked"; `details.lines` has all short lines), `NOTHING_TO_SEND`, `UNKNOWN_LINE`.

Delivered happens when the department presses Received; the store just sees it move to the Delivered tab.
