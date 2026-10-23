# Reports tab (/client-admin/reports): APIs

All GET, all under `/api/v1/reports`. Answer shape of every report: `{ title, generatedAt, filters, sections:[{ key, title, columns:[{key,label,type}], rows:[], totals:{} }], page, limit, total, export }`. A report with one table has one section; Overview has three.

## 1. Menu and dropdowns: `GET /v1/reports`
```
{ reports:[{ key, title, url, filters:[names] }], customers:[{id,name,code}], qualities:[{id,name}],
  departments:[{id,name,code}], soCardStatuses:[{value,text}], jobStatuses:[{value,text}] }
```
Only the reports the person may open are listed (403 when none). `filters` says which query parameters that report uses; show only those.

## 2. Reports
| Report | URL |
|---|---|
| Overview (no page/limit) | `/v1/reports/overview` |
| Grey: party wise | `/v1/reports/grey/parties` |
| Grey: lot wise | `/v1/reports/grey/lots` |
| Grey: given back | `/v1/reports/grey/returns` |
| SO cards | `/v1/reports/so-cards` (each row has `soCardId`) |
| SO cards: lots and thaans | `/v1/reports/so-cards/lots` |
| SO card full story | `/v1/reports/so-cards/:soCardId` |
| Departments summary | `/v1/reports/departments` |
| Departments: job wise | `/v1/reports/departments/jobs` |
| Departments: operators | `/v1/reports/departments/operators` |
| Chemical costing | `/v1/reports/chemical-cost` (`by`: chemical, department, job, so_card, party, detail) |
| Folding | `/v1/reports/folding` |
| Active fabric (now) | `/v1/reports/active-fabric` (`by`: party_department, party, department, so_card, detail; `tab=process` = only cloth in departments) |
| Packing lists | `/v1/reports/packing-lists` |
| Packing lists: thaan wise | `/v1/reports/packing-lists/lines` |
| Gate passes | `/v1/reports/gate-passes` |

Old URLs (`/departments/summary`, `/operators`, `/chemicals/usage`, `/cloth-now` ...) still work.

## 3. Query parameters
`page, limit, dateFrom, dateTo (YYYY-MM-DD), customerId, qualityId, departmentId, fromDepartmentId, status, stock (in_store | empty), search, operatorName, by, tab, gatePass (yes | no | all), grade (A | B | CP | ALL)`. An empty value ("") is the same as not sent. Download: add `all=true` (every row, at most 20,000), then make PDF / Excel from `sections`.

## 4. Access
A person opens a report with its own report service (`REPORT_*`) or with the service of the data. A person with only `REPORT_GREY` sees Grey reports and nothing else; the menu (`GET /v1/reports`) lists exactly what they can open.

## 5. Ledgers (new)
| Report | URL | Filters |
|---|---|---|
| Cloth ledger | `/v1/reports/ledger` | dateFrom, dateTo, customerId, soNo, search (lot#, SO#, DC#, party, department) |
| Day to day stock | `/v1/reports/daily-stock` | dateFrom, dateTo, customerId |

**Ledger:** one row per event, oldest first: `Grey in`, `Grey given back`, `SO card`, `Fabric return`, `Department` (job, with operator and chemical cost), `Packing list` (amount), `Gate pass`. Columns: date, type, party, soNo, lotNo, department, ref, greyIn, greyOut, balance (running grey-store balance), deptMeters, packedMeters, dispatchedMeters, amount, detail. With `dateFrom` the first row is `Opening balance`. For one lot or one SO card use `search` / `soNo`; for one party use `customerId`.
**Day to day:** one row per day (newest first): opening, greyIn, greyOut, closing of the grey store, plus meters sent to departments, packed and dispatched that day.
Download both with `all=true`.

## 6. More reports (new, all in the menu of `GET /v1/reports`, same shape, `all=true` for download)
| Report | URL | Filters |
|---|---|---|
| Quality wise (grey, SO card, packed A/B/CP, value, chemical cost) | `/v1/reports/quality-wise` | dateFrom, dateTo, customerId, qualityId |
| Party wise cost (cost per metre, packed value) | `/v1/reports/party-cost` | dateFrom, dateTo, customerId, qualityId |
| Grade summary A / B / CP | `/v1/reports/grade-summary` | customerId, qualityId, `by=quality` (default: party) |
| Cloth ageing (0-7, 8-15, 16-30, 30+ days) | `/v1/reports/ageing` | customerId |
| Pending jobs (days waiting) | `/v1/reports/pending-jobs` | departmentId, customerId, status |
| Delivery due (late / days left) | `/v1/reports/delivery-due` | customerId, qualityId, `stock=open` |
| Re-work and rejected jobs (with reason) | `/v1/reports/rework-jobs` | departmentId, customerId |
| Department day by day | `/v1/reports/departments-daily` | departmentId, customerId, dates |

## 7. SO card status is now the REAL position (Overview and SO card reports)
The stored SO card status is no longer used in reports. Every (non fabric-return) SO card gets exactly one place, from its jobs and where its cloth is now:
`NOT_SENT` (no job yet), `PARTLY_SENT` (some cloth still waits on the card), `IN_DEPARTMENT` (cloth inside a department / Folding), `AT_PACKING` (cloth at Packing, not all dispatched), `FINISHED` (everything dispatched with gate pass).
- `GET /v1/reports` -> `soCardStatuses` is now these 5 `{value,text}` (use `value` as the `status` filter of `/so-cards` and `/so-cards/lots`; old `NEW` still works as `NOT_SENT`).
- Overview Summary has `SO cards` and one line per place (`SO cards: not sent`, `partly sent`, `in departments`, `at packing`, `finished (dispatched)`); the table "SO cards by status" has the same 5 rows. The 5 rows always add up to `SO cards`. Fabric returns are counted separately.
- `/so-cards` rows now have `status` (the value) and `statusText`.

## 8. Ledgers (audit). All GET, same shape, `all=true` for the full download.
Every ledger is dated rows, oldest first, with a running `balance`. With `dateFrom` each group starts with a row `type = "Opening balance"`. `dateTo` cuts the end.
| Ledger | URL | Filters | Balance means |
|---|---|---|---|
| Cloth ledger (all events) | `/v1/reports/ledger` | dates, customerId, soNo, search | grey store balance |
| Day to day stock | `/v1/reports/daily-stock` | dates, customerId | grey opening / closing per day |
| Lot | `/v1/reports/ledgers/lot` | dates, customerId, qualityId, search (lot#, DC#, Type#) | grey left in that lot. Rows of departments / packing are information (`millMeters`) |
| Party (cloth and money) | `/v1/reports/ledgers/party` | dates, customerId | grey store balance; `value` and `valueTotal` = packed value |
| SO card | `/v1/reports/ledgers/so-card` | dates, customerId, soNo | meters still in the mill (taken - dispatched); `amount` = chemical cost on department rows, packed value on packing rows |
| Department | `/v1/reports/ledgers/department` | dates, departmentId, customerId, soNo | meters inside the department (received - sent on) |
| Operator | `/v1/reports/ledgers/operator` | dates, departmentId, operatorName, customerId | total meters so far |
| Chemical cost | `/v1/reports/ledgers/cost` | dates, customerId, soNo, departmentId, itemId, jobNo | total cost so far per SO card |
| Audit check | `/v1/reports/audit-check` | customerId, `status=check` (only differences) | -- |

SO# columns in ledgers are text: `3` for an SO card, `FR-3` for a fabric return. Chemical STORE ledgers (item, vendor, stock on date ...) stay on the Store reports screen.

**Audit check:** rows `what / ref / party / a / b / expected / difference / status`. `status` is `OK` or `CHECK`. Checks: a grey lot (outward = SO cards + given back), an SO card (card total = sum of lots; sent to departments not more than the card; dispatched not more than packed, packed not more than the card). The answer has `summary: { checked, ok, check }`. Show `check > 0` in red; this is the screen for the auditor.
