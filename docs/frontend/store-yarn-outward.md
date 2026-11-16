# Store Management — Yarn Outward to a department, the department's yarn, and the yarn cost on Jobs / SO cards — Frontend Guide

Continues `store-yarn-inward.md`. The **Yarn Store** gives yarn to a **department** (**Yarn Outward**). The department sees the yarn it has, and **uses** it on a **Job** (optionally one SO card of the job). The **value of the yarn used is the yarn cost** of that Job / SO card, shown **next to the chemical cost**, with the **grand total of both**. The yarn stock in the store falls with every outward and says which department got how much.

```
Yarn Inward (store)  →  Yarn Outward (store gives bags to Dyeing)  →  Dyeing's yarn stock  →  Dyeing uses bags on Job 12 / SO 7  →  yarn cost on the Job / SO card
```

## 1. Store side — Yarn Outward (`/api/v1/store-yarn-outwards`, service `YARN_STORE`)
VIEW reads, FULL gives yarn / takes an outward back.

### Form data — `GET /form-data`
```json
{ "nextOutwardNo": 1, "nextOutwardText": "00001", "today": "2026-11-27",
  "departments": [ { "id": "...", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS" } ],
  "stock": [ { "inwardId": "...", "inwardNo": 1, "inwardText": "00001", "inwardDate": "2026-10-12", "title": "22/s Cotton - Crescent", "yarnName": "22/s Cotton", "brand": "Crescent",
               "vendorName": "Yarn Mills", "dcNo": "Y-1", "bags": 10, "balanceBags": 10, "lbsPerBag": 50, "balanceLbs": 500, "ratePerLb": 300 } ] }
```
`departments` = the company's Process and Folding departments (names as the client admin renamed them). `stock` = the approved, switched-on yarn inwards that still have bags: the picker.

### Give yarn — `POST /`
```json
{ "outwardDate": "2026-10-13", "departmentId": "<department id>", "dcNo": "OUT-1", "sentThrough": "Akram", "remarks": "",
  "lines": [ { "inwardId": "<yarn inward id>", "bags": 6 }, { "inwardId": "<another>", "bags": 2 } ] }
```
- `departmentId` and `lines` are required; every `inwardId` once; `bags` a whole number ≥ 1. `outwardDate` defaults to today (not before the inward's date: 422 `OUTWARD_BEFORE_INWARD`).
- Per line the server keeps the **bags, the weight of a bag and the rate per lb of the inward**, so the **value** = bags × lbs per bag × rate per lb is fixed now. A yarn with no rate has value 0.
- Answer `201` (same shape as one outward below). Errors (422): `UNKNOWN_DEPARTMENT`, `INWARD_NOT_APPROVED`, `INWARD_INACTIVE`, `NOT_ENOUGH_BAGS` (`details.balanceBags`), `OUTWARD_BEFORE_INWARD`; 404 for an unknown inward.
- The inward's `outwardBags` goes up, so `GET /store-yarn-inwards/stock` falls.

### One outward / list
```json
{ "id": "...", "outwardNo": 1, "outwardText": "00001", "outwardDate": "2026-10-13", "department": { "id": "...", "code": "DYEING", "name": "Dyeing" },
  "dcNo": "OUT-1", "sentThrough": "Akram", "remarks": null, "totalBags": 8, "totalLbs": 500, "totalValue": 90000,
  "usedBags": 0, "balanceBags": 8, "canCancel": true, "createdBy": { "name": "..." }, "createdAt": "...",
  "lines": [ { "id": "...", "lineNo": 1, "inwardId": "...", "inwardNo": 1, "inwardText": "00001", "title": "22/s Cotton - Crescent", "vendorName": "Yarn Mills",
               "bags": 6, "lbsPerBag": 50, "lbs": 300, "ratePerLb": 300, "value": 90000, "usedBags": 0, "balanceBags": 6, "balanceLbs": 300, "balanceValue": 90000 } ] }
```
- `GET /?page=&limit=&search=&departmentId=&inwardId=&dateFrom=&dateTo=` → `{ data, totals: { outwards, bags, lbs, value }, page, limit, total }` newest first. `GET /:id` → one outward.
- `usedBags` / `balanceBags` = what the department has used / still has of it.
- **Take an outward back**: `POST /:id/cancel` — only while the department has used none of its yarn (`canCancel`); else 422 `OUTWARD_IN_USE` (`details.lines`: which yarn is used). Answer `{ id, outwardNo, deleted: true }`; the bags are back in the store stock.

### Where the yarn went (the stock record) — `GET /summary?groupBy=department|yarn&dateFrom=&dateTo=&departmentId=`
```json
{ "groupBy": "department", "data": [ { "key": "...", "label": "Dyeing", "outwards": 1, "issuedBags": 8, "issuedLbs": 500, "issuedValue": 90000, "usedBags": 4, "usedValue": 45000, "balanceBags": 4, "balanceValue": 45000 } ],
  "totals": { "issuedBags": 8, "issuedLbs": 500, "issuedValue": 90000, "usedBags": 4, "usedValue": 45000, "balanceBags": 4, "balanceValue": 45000 } }
```
`groupBy=department`: how much every department got, used and still has. `groupBy=yarn`: the same per yarn (name + brand).
Also in the **Yarn Stock** (`GET /store-yarn-inwards/stock`, see `store-yarn-inward.md`): every row has `outwardBags` / `balanceBags`, and the answer has **`byDepartment`**: `[ { department: { id, name }, outwards, issuedBags, issuedLbs, issuedValue, usedBags, balanceBags, balanceValue } ]` — show it as "Yarn issued to departments". `GET /store-yarn-inwards/:id` (one entry) has **`outwards`**: `[ { outwardId, outwardNo, outwardText, outwardDate, department: { code, name }, bags, usedBags, balanceBags, value } ]` — where that entry's yarn went.

## 2. Department side — its yarn (`/api/v1/departments/:code/...`, e.g. `DYEING`)
The person needs the department (VIEW to look, FULL to use / take back). The client admin has everything. 403 for another department; no chemical setting is needed.

### How much yarn the department has — `GET /:code/yarn?showZero=false&search=`
```json
{ "department": { "id": "...", "code": "DYEING", "name": "Dyeing" },
  "totals": { "receivedBags": 8, "usedBags": 4, "balanceBags": 4, "balanceLbs": 250, "balanceValue": 45000 },
  "byYarn": [ { "title": "22/s Cotton - Crescent", "yarnName": "22/s Cotton", "brand": "Crescent", "receivedBags": 6, "usedBags": 3, "balanceBags": 3, "balanceLbs": 150, "balanceValue": 45000 } ],
  "data": [ { "outwardLineId": "...", "outwardId": "...", "outwardNo": 1, "outwardText": "00001", "outwardDate": "2026-10-13", "dcNo": "OUT-1", "inwardId": "...", "inwardNo": 1,
              "title": "22/s Cotton - Crescent", "yarnName": "22/s Cotton", "brand": "Crescent", "receivedBags": 6, "usedBags": 3, "balanceBags": 3, "lbsPerBag": 50, "balanceLbs": 150,
              "ratePerLb": 300, "receivedValue": 90000, "balanceValue": 45000 } ] }
```
`data` has one row per outward line (what the store gave and the department used). Used-up lines are hidden unless `showZero=true`. **`outwardLineId` is what a use refers to.**

### Use yarn on a job — `GET /:code/yarn/form-data`, `POST /:code/yarn-usages`
`form-data` → `{ department, today, nextUsageNo, jobs: [ { id, jobNo, status, jobDate, soCards: [ { id, cardNo, cardLabel } ] } ], stock: [ ...the same rows as data above ] }` — the department's jobs that can take yarn (accepted: Processing / Complete) and its yarn with bags left.
```json
{ "usageDate": "2026-10-14", "jobId": "<job>", "soCardId": "<SO card of the job, optional>", "remarks": "",
  "lines": [ { "outwardLineId": "<from the stock>", "bags": 2 }, { "outwardLineId": "<another>", "bags": 1 } ] }
```
- `jobId` and `lines` required. **No `soCardId`** = the whole job: the cost is **shared between the job's SO cards by their meters**. **With `soCardId`** = that SO card only (the card must be in the job: 422 `SO_NOT_IN_JOB`).
- Errors (422): `UNKNOWN_JOB` (not this department's job), `JOB_NOT_ACCEPTED` (accept the job first), `UNKNOWN_YARN`, `NOT_ENOUGH_BAGS` (`details.balanceBags`), `USE_BEFORE_OUTWARD`.
- Answer `201`: `{ id, usageNo, usageText, usageDate, department, job: { id, jobNo }, soCard: { id, cardNo, cardLabel } | null, totalBags, totalLbs, totalValue, remarks, lines: [ { outwardLineId, outwardNo, outwardText, title, bags, lbs, ratePerLb, value } ], createdBy, createdAt }`. `totalValue` = **the yarn cost** of this use.
- `GET /:code/yarn-usages?page=&limit=&jobId=&soCardId=&dateFrom=&dateTo=&search=` → `{ data: [use...], totals: { usages, bags, lbs, value }, page, limit, total }`; `GET /:code/yarn-usages/:id` one use.
- **Take a use back**: `DELETE /:code/yarn-usages/:id` → `{ id, usageNo, deleted: true }` — the yarn is in the department's stock again and leaves the cost.
- The job screens of the department are unchanged otherwise: only this one yarn add-on.

## 3. The cost — yarn next to chemical, and the grand total
All amounts are numbers. **Existing fields keep their meaning (chemical)**; yarn and total are new fields.

**One Job** — `GET /departments/:code/jobs/:jobId/chemical-cost` (needs the chemical setting as before) now also has:
`chemicalValue`, **`yarnValue`**, **`grandTotal`** (= chemical + yarn), and `yarn: { totalValue, totalBags, items: [ { title, bags, lbs, value } ], usages: [ { id, usageNo, usageText, usageDate, department, soCardId, bags, lbs, value } ] }` (`totalValue` stays the chemical value).
Without the chemical setting (or to show only yarn): **`GET /departments/:code/jobs/:jobId/yarn-cost`** → `{ job, totalValue, totalBags, items, usages }`.

**One SO card** — `GET /stores/chemical/cost/so-cards/:id` (Store Reports), `GET /departments/:code/so-cards/:soCardId/chemical-cost`: same new fields `chemicalValue`, `yarnValue`, `grandTotal`, `yarn { totalValue, items, usages }`; each `byJob[]` entry also has `yarnValue` and `grandValue`. The yarn of a card = its own uses + its share (by meters) of the uses for a whole job.
Yarn only: `GET /departments/:code/so-cards/:soCardId/yarn-cost` → `{ soCardId, totalValue, totalBags, items, usages }`.

**Cost reports** (`GET /stores/chemical/cost/jobs|so-cards`, `GET /departments/:code/chemical-cost/jobs|so-cards`, filters as before; the yarn is counted by the date of the use): every row now has **`value`** (= chemical, as before), **`chemicalValue`**, **`yarnValue`**, **`grandValue`** (both together), `yarnUsages` (count); the answer has `totalValue` (chemical, as before), `totalChemicalValue`, **`totalYarnValue`**, **`grandTotal`**. A Job / SO card that got **only yarn** is listed too (chemical 0). Show **Chemical | Yarn | Total** columns.

**Job lists** (`GET /jobs?...` and `GET /departments/:code/jobs...`, both `view=job` and `view=so`): every row has **`yarnAmount`**, `yarnPerMeter` and **`totalCostAmount`** = earlier chemical + this department's chemical + yarn. A department without chemical access does not get `totalCostAmount` (it would show chemical cost); it still gets `yarnAmount`.

## 4. Rules in short
- The yarn cost uses the store's rate per lb (fixed when the yarn is given): a yarn without a rate costs 0. A use costs its share of the outward line's value; the last bags of a line take what is left of it, so the uses always add up to the value of the line.
- An approved yarn inward that has gone out cannot be un-approved (422 `INWARD_IN_USE`, from the inward screen).
- Not in this step: returning unused yarn from the department to the store; accounts (purchase invoice) for the yarn.

## Database
Migration `20261221000001-store-yarn-outward.js` (`store_yarn_outwards`, `store_yarn_outward_lines`, `store_yarn_usages`, `store_yarn_usage_lines`). Run `npm run db:migrate`.
