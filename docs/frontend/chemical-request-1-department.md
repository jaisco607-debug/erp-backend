# CHEMICAL REQUEST part A: Department side (frontend guide)

Build this on every department screen (Dyeing, Printing, ...). Small step: 1 list + 1 form + 1 detail.
Needs: store-department-access.md done (the store gives chemicals to the department).

## A1. What is in the backend and database
- NEW tables (migration 20261017000001):
  - `chemical_requests`: reqNo (1, 2, 3 ... per company), department, jobId (required), soCardId (optional), notes, status, rejectReason, sentThrough, totalValue, and who/when for every step: requestedBy/At, acceptedBy/At, sentBy/At, receivedBy/At, closedBy/At.
  - `chemical_request_lines`: one row per chemical: itemId, qty (asked), sentQty, rate, value.
  - `store_moves.requestId`: the stock-out row points to the request.
- Rules:
  - A request is always for a **Job#** of this department. The job must be **Processing or Complete** (accepted).
  - SO card is optional: pick one SO# of that job, or leave empty = "whole job".
  - Many requests for the same Job / SO card are allowed.
  - Only chemicals the Chemical Store gave this department can be asked.
  - A chemical only once per request.
- Status (department names): **Pending** -> **Accepted** -> **In-Way** -> **Received**. Also Cancelled / Rejected.
- Stock goes OUT when the store presses Send (In-Way), not at Received.
- Everything is in the audit log.

Access: VIEW on the department = see. FULL = create, edit, cancel, receive (client admin always FULL).
Errors: `{ "error": { "code", "message" } }` -> show `message` in a toast.

## A2. Quantity: kg and grams separately
Never show "3.5 KG". Always use the `...Split.text` field from the API, e.g. "3 KG 500 G".
Input: two boxes: **KG** (`qtyMain`) and **G** (`qtySub`, 0 to 999). For LTR: LTR and ML. For other units (PCS ...) only one box (`qty`). `hasSubUnit` tells you.

## A3. Screen 1: Chemical Requests list
`GET /departments/:code/chemical-requests?tab=pending&page=1&limit=20`
- tabs: `pending`, `accepted`, `in_way`, `received`, `closed` (cancelled + rejected), `all`
- filters (optional): `reqNo`, `jobNo`, `soNo`, `dateFrom`, `dateTo` (2026-10-17)
```json
{ "data": [ {
    "id": "uuid", "reqNo": 1, "status": "PENDING", "departmentStatusText": "Pending",
    "job": { "id": "uuid", "jobNo": 12 }, "soNos": [5, 6], "customers": ["AZ TEXTILES"],
    "soCard": null, "lineCount": 2, "totalValue": 0,
    "requestedBy": { "id": "uuid", "name": "Ali" }, "requestedAt": "2026-10-17T09:10:00Z",
    "acceptedBy": null, "acceptedAt": null, "sentBy": null, "sentAt": null, "receivedBy": null, "receivedAt": null,
    "lines": [ ... ] } ],
  "total": 1, "page": 1, "limit": 20,
  "counts": { "pending": 1, "accepted": 0, "in_way": 0, "received": 0, "closed": 0 } }
```
- Tab labels with counts: "Pending (1)", "Accepted (0)" ...
- Columns: Req#, Date, Job#, SO# (`soCard.cardNo` or "Whole job"), Chemicals (`lineCount`), Status (`departmentStatusText`), last step by (name + time).
- Row buttons: Pending -> Edit, Cancel. In-Way -> **Received**. Others -> View.

## A4. Screen 2: New request form
`GET /departments/:code/chemical-requests/form-data`
```json
{ "department": { "id": "uuid", "code": "DYEING", "name": "Dyeing" },
  "jobs": [ { "id": "uuid", "jobNo": 12, "status": "PROCESSING", "totalMeters": 10000,
      "soCards": [ { "id": "uuid", "cardNo": 5, "customer": "AZ TEXTILES", "meters": 6000 } ] } ],
  "chemicals": [ { "id": "uuid", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG", "hasSubUnit": true, "subUnit": "G",
      "stock": { "text": "7 KG 500 G" } } ] }
```
Form:
1. **Job#** dropdown (`jobs`, show "Job 12 - SO 5, 6").
2. **SO#** dropdown: first option "Whole job", then that job's `soCards`.
3. Chemical rows: chemical dropdown (`chemicals`, searchable by label), KG box, G box, store stock shown small (`stock.text`), delete-row button. "+ Add chemical" button.
4. Notes (optional). Save button.

`POST /departments/:code/chemical-requests`
```json
{ "jobId": "uuid", "soCardId": null, "notes": "",
  "lines": [ { "itemId": "uuid", "qtyMain": 2, "qtySub": 500 } ] }
```
-> 201 with the request. Toast "Request #1 sent to Chemical Store".

Errors: `JOB_NOT_ACCEPTED`, `UNKNOWN_JOB`, `SO_NOT_IN_JOB`, `CHEMICAL_NOT_GIVEN`, `DUPLICATE_ITEM`, `QTY_REQUIRED`, `SUB_TOO_BIG` (G 1000 or more), `NO_SUB_UNIT`.

## A5. Edit / Cancel (only while Pending)
- `GET /departments/:code/chemical-requests/:id` -> fill the same form.
- `PATCH /departments/:code/chemical-requests/:id` with any of `jobId`, `soCardId`, `notes`, `lines` (lines = the whole new list).
- `POST /departments/:code/chemical-requests/:id/cancel` (ask "Cancel request #1?" first).
- After the store accepts: `NOT_PENDING` -> hide the Edit/Cancel buttons.

## A6. Detail + Received
Detail screen shows: header (Req#, Job#, SO#, notes, status), lines table (Chemical, Asked `qtySplit.text`, Sent `sentSplit.text`), and a **timeline**:
- Requested: `requestedBy.name`, `requestedAt`
- Accepted: `acceptedBy`, `acceptedAt`
- Sent (In-Way): `sentBy`, `sentAt`, `sentThrough`
- Received: `receivedBy`, `receivedAt`
- Cancelled / Rejected: `closedBy`, `closedAt`, `rejectReason`
Show only the steps that have a time.

When In-Way: big button **Received** -> `POST /departments/:code/chemical-requests/:id/receive` -> status Received.
Do not show money (rate/value) on department screens unless the admin wants it.
