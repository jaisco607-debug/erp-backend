# Yarn Requests (department → Yarn Store), settings, ledger and cost — Frontend Guide

A department asks the **Yarn Store** for yarn for one of its **Jobs** (optionally one SO card of the job) — **exactly like a chemical request**. The store accepts, assigns the bags and sends; the department receives. Sending takes the yarn out of the store stock, records a Yarn Outward to the department and puts the **yarn cost on the Job / SO card** (next to the chemical cost). Continues `store-yarn-inward.md` and `store-yarn-outward.md` (the direct outward and the department's own "use yarn" screens still work as before).

```
Department: Pending → (store) Accepted → In-Way → Received          (or Cancelled by the department / Rejected by the store)
Store tabs: Queue   →  Process        →  In-Way → Delivered
```

## 1. Settings — which departments may request yarn (client admin)
`GET /api/v1/department-settings` (client admin only) now also answers `yarnStore` (the company has the Yarn Store) and, per department: **`yarnRequests`** (the switch), **`yarnEnabled`** (`yarnStore && yarnRequests`), `yarnRequestCount`; the chemical fields are unchanged.
```json
{ "chemicalStore": true, "yarnStore": true, "data": [ { "id": "...", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS",
    "chemicalRequests": true, "chemicalEnabled": true, "chemicalCount": 4, "yarnRequests": false, "yarnEnabled": false, "yarnRequestCount": 0 } ] }
```
- **`PATCH /department-settings/:code`** `{ "yarnRequests": true }` and **`PUT /department-settings`** `{ "departments": [ { "code": "DYEING", "yarnRequests": true, "chemicalRequests": false } ] }` — each item needs at least one of `chemicalRequests` / `yarnRequests` (400 otherwise); send only what changes. 422 `NO_YARN_STORE` if the company has no Yarn Store.
- **Yarn requests are OFF for every department until the client admin switches them on** (the chemical switch is ON by default). Add a "Yarn requests" switch column next to the chemical one.
- The login / `/me` answer: every department service has **`yarnRequests`** (true only when the Yarn Store is given AND the switch is on) next to `chemicalRequests`: show the "Yarn Requests" menu of a department only then.
- A department that is not switched on gets **403 `YARN_NOT_ALLOWED`** on every `/departments/:code/yarn-requests...` call.

## 2. Department side — `/api/v1/departments/:code/yarn-requests` (e.g. `DYEING`)
The person needs the department (VIEW to look, FULL to ask / edit / cancel / receive).

- **Form data** `GET /form-data` → `{ department, nextReqNo, jobs: [ { id, jobNo, jobDate, status, totalMeters, soCards: [ { id, cardNo, cardLabel, customer, meters } ] } ], yarn: [ { yarnName, brand, title, availableBags, inStock } ] }`. `jobs` = the department's accepted jobs (Processing / Complete). `yarn` = the yarn the store has now (pick a name from it, or **type any yarn**: the store sees what it can give).
- **Ask** `POST /` `{ "jobId": "...", "soCardId": "<optional>", "notes": "", "lines": [ { "yarnName": "22/s Cotton", "brand": "Crescent", "bags": 12 }, { "yarnName": "30/s Polyester", "bags": 3 } ] }`
  - `jobId` and `lines` required (yarn name typed, brand optional, bags whole number ≥ 1). **No `soCardId`** = the whole job (its cost is shared between its SO cards by meters); **with** it = that SO card only.
  - Errors (422): `UNKNOWN_JOB` (not this department's job), `JOB_NOT_ACCEPTED` (accept the job first), `SO_NOT_IN_JOB`, `DUPLICATE_YARN` (the same yarn+brand twice), `YARN_REQUIRED`.
- **List** `GET /?tab=all|pending|accepted|in_way|received|closed&page=&limit=&reqNo=&jobNo=&soNo=&dateFrom=&dateTo=` → `{ data, total, page, limit, counts: { pending, accepted, in_way, received, closed } }` (counts for the tab badges). `closed` = Cancelled + Rejected.
- **One** `GET /:id`. **Edit** `PATCH /:id` (same body, all optional) and **Cancel** `POST /:id/cancel` — only while **Pending** (422 `NOT_PENDING`). **Received** `POST /:id/receive` — only while **In-Way** (422 `NOT_IN_WAY`).

### The request JSON (both sides)
```json
{ "id": "...", "reqNo": 1, "reqText": "00001", "status": "IN_WAY", "departmentStatusText": "In-Way", "storeStatusText": "In-Way",
  "department": { "id": "...", "code": "DYEING", "name": "Dyeing" }, "job": { "id": "...", "jobNo": 12, "status": "PROCESSING" },
  "soCard": { "id": "...", "cardNo": 7, "cardLabel": "7" }, "soCards": [ { "id": "...", "cardNo": 6, "cardLabel": "6", "customer": "AZ" } ],
  "notes": "urgent", "rejectReason": null, "sentThrough": "Akram", "totalBags": 15, "sentBags": 15, "totalValue": 212000,
  "outward": { "id": "...", "outwardNo": 1, "outwardText": "00001" },
  "requestedBy": { "name": "..." }, "requestedAt": "...", "acceptedBy": null, "acceptedAt": null, "sentBy": { "name": "..." }, "sentAt": "...", "receivedBy": null, "receivedAt": null,
  "lines": [ { "id": "...", "lineNo": 1, "yarnName": "22/s Cotton", "brand": "Crescent", "title": "22/s Cotton - Crescent", "bags": 12, "sentBags": 12, "value": 212000,
               "assigned": [ { "inwardId": "...", "inwardNo": 1, "inwardText": "00001", "title": "22/s Cotton - Crescent", "bags": 10, "lbsPerBag": 50, "lbs": 500, "ratePerLb": 300, "value": 150000 },
                             { "inwardId": "...", "inwardNo": 2, "inwardText": "00002", "title": "...", "bags": 2, "lbsPerBag": 100, "lbs": 200, "ratePerLb": 310, "value": 62000 } ] } ] }
```
`sentBags` / `assigned` are empty until the store sends. `totalValue` = the yarn value that went out = the yarn cost of the Job / SO card.

## 3. Yarn Store side — `/api/v1/store-yarn-outwards/requests` (service `YARN_STORE`; VIEW reads, FULL works the request)
- **List** `GET /requests?tab=all|queue|process|in_way|delivered|closed&departmentId=&reqNo=&jobNo=&soNo=&dateFrom=&dateTo=&page=&limit=` → `{ data, total, counts: { queue, process, in_way, delivered, closed } }` (the tabs: Queue / Process / In-Way / Delivered / Closed).
- **One** `GET /requests/:id` — while Queue / Process every line also has **`availableBags`** and **`stock`** = the approved yarn inward entries of that yarn (oldest first): `[ { inwardId, inwardNo, inwardText, inwardDate, title, vendorName, balanceBags, lbsPerBag, ratePerLb } ]` — show them so the store can see what it can give.
- **Accept** `POST /requests/:id/accept` (Queue → Process; 422 `NOT_IN_QUEUE`). **Reject** `POST /requests/:id/reject` `{ "reason": "..." }` (Queue or Process; 422 `ALREADY_SENT`).
- **Send** `POST /requests/:id/send`
  ```json
  { "sentThrough": "Akram", "lines": [ { "lineId": "...", "bags": 3 }, { "lineId": "...", "allocations": [ { "inwardId": "...", "bags": 2 } ] } ] }
  ```
  - Body optional: **no body = send every line as asked**, bags taken from the **oldest approved inward entries** of that yarn (name, and brand when the department typed one).
  - A line in `lines` may give **`bags`** (send fewer; `0` = not sent) **or `allocations`** (the store picks the inward entries; bags = their sum), not both. **Never more than asked** (422 `MORE_THAN_REQUESTED`).
  - Errors (422): `NOT_ACCEPTED` (accept first), `ALREADY_SENT`, `NOT_ENOUGH_STOCK` (`details.lines`: yarn, asked, available), `NOTHING_TO_SEND`, `UNKNOWN_LINE`, `UNKNOWN_INWARD`.
  - What it does: the yarn goes out of the stock (**Yarn Stock falls**), a **Yarn Outward** to the department is recorded (shows in the outwards list with `request: { reqNo }`, it cannot be cancelled there: 422 `OUTWARD_FROM_REQUEST`), and the **same yarn is used on the request's Job / SO card at once** — that is the cost. The department's own yarn stock stays at 0 for it; in `GET /departments/:code/yarn-usages` that use shows `request: { reqNo }`, `canRemove: false` (422 `USE_FROM_REQUEST` on delete). Status → **In-Way**.
  - The value of a line = bags × lbs per bag × the rate per lb of the inward entry it came from (fixed now; no rate = 0).

## 4. Stock, outwards and the ledger (store)
- **Yarn Stock** `GET /store-yarn-inwards/stock` — falls with every send; `byDepartment` shows what each department got.
- **Outwards** `GET /store-yarn-outwards` / `/summary` (`store-yarn-outward.md`): a request's outward has `request: { id, reqNo, reqText }`.
- **Ledger (new)** `GET /api/v1/store-yarn-inwards/ledger?inwardId=&vendorId=&departmentId=&yarn=&dateFrom=&dateTo=&page=&limit=` — every movement in date order with a running balance of **bags, lbs and value**:
  ```json
  { "opening": { "bags": 10, "lbs": 500, "value": 150000 }, "totals": { "inBags": 5, "outBags": 15, "inLbs": 500, "outLbs": 1000, "inValue": 155000, "outValue": 305000 },
    "closing": { "bags": 0, "lbs": 0, "value": 0 }, "total": 4, "page": 1, "limit": 200,
    "data": [ { "date": "2026-10-20", "kind": "INWARD", "kindText": "Yarn inward", "refText": "00002", "inwardId": "...", "inwardText": "00002", "title": "22/s Cotton - Crescent", "party": "Yarn Mills", "note": "DC-1", "request": null,
                "inBags": 5, "outBags": 0, "inLbs": 500, "outLbs": 0, "inValue": 155000, "outValue": 0, "balanceBags": 15, "balanceLbs": 1000, "balanceValue": 305000 },
              { "date": "2026-11-27", "kind": "OUTWARD", "kindText": "Given to department", "refText": "00001", "party": "Dyeing", "request": { "reqNo": 1, "reqText": "00001" }, "outBags": 10, "outLbs": 500, "outValue": 150000, "balanceBags": 5, "...": "..." } ] }
  ```
  `kind`: `INWARD` (+, party = vendor) / `OUTWARD` (−, party = the department, `request` = the yarn request it was sent for, null for a direct outward). Rows before `dateFrom` are summed into `opening`. One row per inward entry per outward. Use it for the "Yarn ledger" report page (per yarn with `yarn=`, per vendor, per department).

## 5. Cost (jobs / SO cards) — nothing new to call
The send is recorded as a use on the Job / SO card, so every cost screen of `store-yarn-outward.md` already shows it: `yarnValue` / `grandTotal` on the job and SO card cost, `yarnValue` / `grandValue` in the cost reports, `yarnAmount` / `totalCostAmount` in the job lists (the request's `soCard` = that card only; no `soCard` = shared between the job's SO cards by meters).

## 6. Not in this step
Returning unused yarn from the department to the store, offering an alternate yarn / ETA on a request line, and the accounts (purchase invoice) for the yarn bought.

## Database
Migration `20261222000001-yarn-requests.js` (`company_services.yarnRequests`, `yarn_requests`, `yarn_request_lines`, `yarn_request_allocations`, `requestId` on outwards and uses). Run `npm run db:migrate`.

---

# UPDATE (2026-11-29): yarn quantity and cost on the Job / SO card rows, and the total of chemical + yarn

The yarn a store sends for a request is now shown **exactly where the chemical is shown**: on the department's Job / SO card rows, in Folding, in the SO card report and the department jobs report — quantity, requests, cost and the total of both. All new fields are numbers; the chemical fields keep their meaning.

## 1. Department job lists — `GET /jobs?departmentId=...&side=in` and `GET /departments/:code/jobs...` (`view=job` and `view=so`)
Every row (a whole job, or one SO card of it) has, next to `chemicalCount / chemicalAmount / costPerMeter / chemicalRequests / pendingChemicalRequests`:
| field | meaning |
|---|---|
| `yarnCount` | different yarns used on this job / SO card |
| `yarnBags`, `yarnLbs` | quantity of yarn used (bags, lbs) |
| `yarnAmount` | yarn cost of this row in this department |
| `yarnPerMeter` | `yarnAmount` ÷ meters of the row |
| `yarnUsages` | number of uses (each sent request = one use) |
| `yarnRequests` | yarn requests the store has **sent** for this row |
| `pendingYarnRequests` | yarn requests still waiting at the store (Pending / Accepted) |
| `previousYarnAmount` | yarn cost the cloth picked up in **earlier departments** (like `previousChemicalAmount`) |
| `totalYarnAmount` | `previousYarnAmount + yarnAmount` |
| **`totalCostAmount`** | **chemical + yarn together** = `previousChemicalAmount + chemicalAmount + previousYarnAmount + yarnAmount` |
| `grandCostPerMeter` | `totalCostAmount` ÷ meters |
A request for the **whole job** (no SO card) is shared between the job's SO cards by meters (quantities too); a request for **one SO card** belongs to that card only. A department **without chemical access** does not get `totalCostAmount` / `grandCostPerMeter` (they contain chemical cost); it still gets all the yarn fields and `totalYarnAmount`.

## 2. Folding — `cost` object of every Folding row
`cost: { previousChemicalAmount, foldingChemicalAmount, previousYarnAmount, foldingYarnAmount, totalCost, costPerMeter }` — **`totalCost` and `costPerMeter` now include the yarn** (chemical + yarn); the A / B / CP `categoryCost` and the thaan `cost` follow.

## 3. Reports (`/reports/...`, service REPORT_*)
- **SO cards report** `GET /reports/so-cards`, **SO card detail** `GET /reports/so-cards/:id` (job path section), **Department jobs** `GET /reports/departments/...jobs`: new columns **`yarnCost`** ("Yarn cost") and **`totalCost`** ("Total cost") next to `chemicalCost`; `costPerMeter` is now **total cost ÷ meters**. They are also in the totals row and the Excel / PDF export.
- SO card detail: new section **`yarn`** "Yarn used" (`department, yarn, bags, lbs, rate (avg per lb), amount`), and `header.yarnCost`, `header.totalCost`.
- Cost reports (`GET /stores/chemical/cost/...`, `GET /departments/:code/chemical-cost/...`) and the job / SO card cost endpoints already have `yarnValue` / `grandTotal` / `grandValue` (see `store-yarn-outward.md`).

Not changed: the other reports that only talk about chemicals (e.g. "Ledger: chemical cost", operator ledger) still show chemical cost only.
