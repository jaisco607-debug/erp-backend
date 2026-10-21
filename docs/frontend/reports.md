# REPORTS: every report of the system, with PDF and Excel download

## 1. Access (updated 2026-10-20: see also `service-access.md`)
- There is **no single "Reports" service any more**. Every report group is its own service, given to a company by the super admin (nothing is given automatically) and passed on to users by the client admin. **VIEW is enough**: reports are read-only.

| Service code | Reports it opens |
|---|---|
| `REPORT_OVERVIEW` | Overview |
| `REPORT_GREY` | Grey / Inward: party wise, lot wise, given back (3) |
| `REPORT_SO_CARDS` | SO cards, lots and thaans, one SO card (3) |
| `REPORT_DEPARTMENTS` | Departments summary, jobs received, operators (3) |
| `REPORT_CHEMICAL_COST` | Chemical costing |
| `REPORT_FOLDING` | Folding |
| `REPORT_ACTIVE_FABRIC` | Active fabric |
| `REPORT_PACKING` | Packing lists, thaan wise (2) |
| `REPORT_GATE_PASSES` | Gate passes |

- A call to a report the person does not have answers **403**.
- **`GET /v1/reports` returns only the reports this person may open** (each with its `service`). Build the Reports page menu from it: do not hardcode the list. A person with no report service gets 403 on this call; hide the Reports tab for them (they have no `REPORT_*` in `/auth/me`).
- Show the **Reports** tab / card when `GET /v1/auth/me` → `services` has at least one code starting with `REPORT_`.
- All reports are under **`/v1/reports`** and use `GET` only. Nothing is saved.
- The backend sends **JSON only**. The frontend makes the PDF and the Excel file (section 5).

## 2. One shape for every list report
Every report (except "one SO card", section 4.6) answers like this:
```json
{
  "report": "grey-parties",
  "title": "Party wise cloth (grey inward to dispatch)",
  "filters": { "dateFrom": "2026-10-01", "customerId": "uuid" },
  "columns": [
    { "key": "customer", "label": "Party", "type": "text" },
    { "key": "lots", "label": "Lots", "type": "int", "total": true },
    { "key": "inwardMeters", "label": "Inward (m)", "type": "meters", "total": true }
  ],
  "rows": [ { "customer": "AZ", "lots": 2, "inwardMeters": 800 } ],
  "totals": { "lots": 2, "inwardMeters": 800 },
  "page": 1, "limit": 50, "total": 1
}
```
- **Build one generic `<ReportTable>` component** and use it for every report:
  - table headers = `columns[].label`, in the same order
  - each cell = `row[column.key]`
  - a **Total** row at the bottom: `totals[column.key]` under every column that has `total: true` (empty under the others)
- **`totals` are for ALL rows that match the filters**, not only this page. Do not add up the page yourself.
- Rows have extra keys (ids such as `soCardId`, `jobId`) that are not columns. Use them for links (e.g. click an SO# to open the SO card report). Do not show them as columns.
- **Column `type` tells you how to show the value:**

| type | Show as | Example |
|---|---|---|
| `text` | as is | AZ (130) |
| `int` | whole number | 12 |
| `number` | up to 2 decimals | 65.5 |
| `meters` | 2 decimals, thousands separator | 12,500.50 |
| `money` | 2 decimals, thousands separator (Rs) | 1,250.00 |
| `qty` | up to 3 decimals | 2.500 |
| `rate` | up to 4 decimals | 0.4167 |
| `date` | DD-MM-YYYY (value is "2026-10-20") | 20-10-2026 |
| `datetime` | DD-MM-YYYY HH:mm (value is an ISO time) | 20-10-2026 14:05 |
| `boolean` | Yes / No (or a tick) | Yes |

- `null` = empty cell (show nothing or "-").

### Common query parameters (all list reports)
| Param | Meaning |
|---|---|
| `page` | page number, default 1 |
| `limit` | rows per page, default 50, max 500 |
| `all=true` | send **every** row in one answer (max 20,000). Use this for PDF / Excel downloads. If there are more, the answer has `truncated: true`; show "Narrow the dates" |
| `dateFrom`, `dateTo` | `YYYY-MM-DD`. Each report says which date it filters on |
| `customerId` | one party |

A wrong date format answers 400 `VALIDATION_FAILED` (same error format as everywhere else).

## 3. The report menu and filter dropdowns
`GET /v1/reports`
```json
{
  "reports": [
    { "key": "grey-parties", "title": "Grey: party wise cloth", "url": "/v1/reports/grey/parties", "filters": ["dateFrom", "dateTo", "customerId"] }
  ],
  "departments": [ { "id": "uuid", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS" } ],
  "customers": [ { "id": "uuid", "code": 130, "name": "AZ TEXTILES" } ],
  "qualities": [ { "id": "uuid", "name": "PC TWILL" } ],
  "jobStatuses": [ { "value": "IN_WAY", "text": "In-Way" } ],
  "soCardStatuses": [ { "value": "NEW", "text": "New (not sent)" } ]
}
```
- Build the Reports page from `reports`: a list or cards on the left, the report on the right.
- `filters` says which filter boxes to show for that report. Fill the dropdowns from `departments`, `customers`, `qualities`, `jobStatuses`, `soCardStatuses`.
- Suggested layout: filter bar on top (date from / to + dropdowns + **Show** button), then two buttons **Download PDF** and **Download Excel**, then the table with paging.

## 4. The reports

### Where cloth is: the words used in many reports
| Column | Meaning |
|---|---|
| In grey store | grey cloth not yet taken on any SO card |
| SO card not sent | on an SO card, not sent to any department yet |
| In departments | in a process department (Singeing, Dyeing ...), any status from In-Way to Complete |
| In folding | in Folding, not yet sent to Packing / re-work (a closed folding row keeps nothing) |
| In packing | reached Packing, no gate pass yet |
| Active / in process | in departments + in folding + in packing (cloth moving inside the factory) |
| Packed | on packing lists |
| Dispatched | on packing lists that have a gate pass (the cloth has left the factory) |

Note for the screen: Folding grades cloth into A / B / CP, so the meters can grow or shrink there. Packed and dispatched meters are the graded meters, so they do not always add up exactly to the SO card meters.

### 4.1 Overview (dashboard)
`GET /v1/reports/overview?dateFrom=&dateTo=`
- `rows`: one line per number: `{ group, label, value, type }`. Groups: `grey`, `soCards`, `departments`, `chemicals`, `packing`, `gatePasses`, `now`.
- `summary`: the same numbers as an object, for dashboard cards:
```json
"summary": {
  "grey": { "lots": 3, "inward": 900, "returned": 100, "onCards": 550, "stock": 250 },
  "soCards": { "cards": 3, "meters": 550, "notSent": 1 },
  "jobs": { "jobs": 4, "meters": 1100, "rejected": 0 },
  "packing": { "lists": 1, "final": 1, "meters": 300 },
  "gatePasses": { "passes": 1, "meters": 300 },
  "chemicalCost": 200,
  "now": { "soDeskMeters": 50, "inProcessMeters": 200, "inFoldingMeters": 0, "inPackingMeters": 0, "activeMeters": 200, "packedMeters": 300, "dispatchedMeters": 300 }
}
```
- Each number uses its own date: grey = inward date, SO cards = card date, jobs = job date, packing = list date, gate pass = pass date, chemicals = date the store sent them. The `now` numbers are always "right now" (no dates).

### 4.2 Grey (fabric inward)
**Party wise:** `GET /v1/reports/grey/parties?dateFrom=&dateTo=&customerId=` (dates = grey inward date)

One row per party. Columns: Party, Lots, Active lots, Thaans in, Inward (m), Given back (m), On SO cards (m), Fabric return grey (m), In grey store (m), Thaans in grey store, SO card not sent (m), In departments (m), In folding (m), In packing (m), Active / in process (m), Packed (m), Dispatched (m).
- This answers: how much cloth came, how much went to SO cards, how much is still in the grey store, and for each party how much is processed (packed / dispatched) and how much is still active.

**Lot wise:** `GET /v1/reports/grey/lots?dateFrom=&dateTo=&customerId=&qualityId=&stock=all|in-stock|finished&search=`
- One row per lot: Lot#, Type#, DC#, date, party, quality, thaans, inward meters / yards, GLM, GSM, on SO cards, SO# list, given back, in grey store, thaans in store, active, packed, dispatched, approved, active ...
- `stock=in-stock`: only lots that still have cloth in the grey store. `finished`: nothing left.
- `search`: DC#, party ref, Type#, or a Lot# (number).

**Given back to party:** `GET /v1/reports/grey/returns?dateFrom=&dateTo=&customerId=` (dates = return date)
- Return#, date, lot#, party, thaans, thaan numbers, meters, vehicle, remarks.

### 4.3 SO cards
**All SO cards:** `GET /v1/reports/so-cards?dateFrom=&dateTo=&customerId=&departmentId=&status=NEW|SENT|IN_DEPARTMENT&search=` (dates = card date)
- One row per SO card: SO#, ID#, date, party, quality, lots, lot#, thaans, meters, status, last sent to, **Departments (in order)** e.g. "Dyeing > Folding > Packing", sent to departments, not sent, in departments, in folding, in packing, packed, dispatched, chemical cost, cost / m, packing lists, gate passes ...
- `departmentId`: only SO cards that went to that department.
- `search`: SO# or ID#.
- Row key `soCardId`: open the SO card report (4.6) when an SO# is clicked.
- **Fabric returns are not SO cards:** this report and "Lots and thaans of SO cards" list only normal SO cards. `?isGreyReturn=true` lists only the fabric returns. The Grey reports show their meters in their own column "Fabric return grey (m)", and "On SO cards" does not include them.

**Lots and thaans of SO cards:** `GET /v1/reports/so-cards/lots?dateFrom=&dateTo=&customerId=&soCardId=&search=`
- One row per lot of each SO card: SO#, date, party, lot#, lot inward date, quality, thaans, **thaan numbers with meters** ("1 (100), 2 (120)"), meters.

### 4.4 Departments
**Summary:** `GET /v1/reports/departments?dateFrom=&dateTo=&departmentId=&customerId=` (dates = job date)
- One row per department: jobs, SO cards, lots, thaans, meters received, meters by status (In-Way, Queue, Pending, Processing, Complete, Rejected), rejected jobs, re-work meters, operators, chemical cost, cost / m, **cloth there now**.
- Rejected jobs are not counted in jobs / meters (only in the Rejected columns).

**What came to each department (SO card / job wise):** `GET /v1/reports/departments/jobs?dateFrom=&dateTo=&departmentId=&fromDepartmentId=&customerId=&soCardId=&status=&operatorName=&search=`
- One row per SO card inside each job: department, Job#, date, from (department or "SO Card"), SO#, party, quality, colour, lots, lot#, thaans, meters, status, operator, process date, sent / received / accepted times, sent through, reject reason, re-work, chemical cost, cost / m.
- This answers: which SO card went to which department, how many lots, thaans and meters.
- `operatorName`: part of a name is enough ("asl" finds "Aslam"). `search`: Job# or SO#.

**Operators:** `GET /v1/reports/departments/operators?dateFrom=&dateTo=&departmentId=&operatorName=`
- One row per department + operator: jobs, complete jobs, SO cards, lots, thaans, meters, chemical cost, cost / m, first and last date.
- Dates = process date (the job date when no process date was typed). Jobs without an operator are shown as "(not entered)".

### 4.5 Chemical costing
`GET /v1/reports/chemical-cost?by=so-card|lot|thaan|chemical|item&dateFrom=&dateTo=&departmentId=&customerId=&soCardId=&itemId=`
- Dates = the day the Chemical Store **sent** the chemical. Cost is after returns.
- `by` (give the user a "View" dropdown):

| by | One row per | Main columns |
|---|---|---|
| `so-card` (default) | department + job + SO card | lots, lot#, meters, chemicals, chemical names, cost, cost / m |
| `lot` | department + job + SO card + lot | same, for one lot |
| `thaan` | thaan | lot#, thaan#, meters, cost, cost / m |
| `chemical` | department + job + SO card + lot + chemical | chemical, unit, qty, cost |
| `item` | chemical (all departments) | unit, qty, cost, avg rate, jobs, SO cards, departments |

- Every row has department, Job#, job date, operator, SO#, party, quality (not for `item`).
- How the cost is shared: a request for one SO card goes to that card; a request for the whole job is shared by meters. Inside an SO card it is shared by lot meters, then by thaan meters. Same rule as the cost screens.
- Extra field `totalCost`: total for the filters.

### 4.6 One SO card: the full story
`GET /v1/reports/so-cards/:soCardId`  (404 if not found)
```json
{
  "report": "so-card-detail",
  "title": "SO card 5",
  "header": { "cardNo": 5, "idNo": 5, "cardDate": "2026-10-16", "party": "AZ (130)", "quality": "PC TWILL", "status": "Sent",
              "lots": 1, "thaans": 3, "meters": 300, "chemicalCost": 200, "costPerMeter": 0.6667,
              "cloth": { "soDeskMeters": 0, "inProcessMeters": 0, "inFoldingMeters": 0, "inPackingMeters": 0, "activeMeters": 0, "packedMeters": 300, "dispatchedMeters": 300 } },
  "headerFields": [ { "label": "SO #", "value": 5 }, { "label": "Party", "value": "AZ (130)" } ],
  "tables": [
    { "key": "lots", "title": "Lots", "columns": [...], "rows": [...], "totals": {...}, "total": 1 },
    { "key": "thaans", "title": "Thaans", ... },
    { "key": "journey", "title": "Departments (in order)", ... },
    { "key": "chemicals", "title": "Chemicals used", ... },
    { "key": "folding", "title": "Folding (A / B / CP)", ... },
    { "key": "packing", "title": "Packing lists and gate passes", ... }
  ]
}
```
- Show `headerFields` as a label / value grid at the top, then each table one after the other with its `title`. Every table has the same `columns` / `rows` / `totals` shape, so use `<ReportTable>` for each (no paging here).
- `thaans` table: every thaan with its share of the chemical cost.
- `journey` table: every job of the card in order: from, to, status, lots, thaans, meters, colour, operator, process date, received / accepted times, reject reason, chemical cost.

### 4.7 Folding
`GET /v1/reports/folding?by=row|party|from-department&dateFrom=&dateTo=&customerId=&fromDepartmentId=&tab=all|open|closed&search=` (dates = job date)
- `by=row` (default): one row per SO card in each folding job: came from (department), SO#, party, quality, colour, page#, lots, thaans, **received, A, B, CP, folded, gain / loss, not graded, sent to packing, left in folding**, sent back for re-work to, closed, close note, confirmed, chemical cost, cost / m.
- `by=party`: the same meters added up per party. `by=from-department`: per department the cloth came from.
- `tab=open`: rows that still have cloth in Folding. `tab=closed`: closed rows.

### 4.8 Active fabric (where the cloth is now)
`GET /v1/reports/active-fabric?by=party|so-card|department|detail&customerId=&departmentId=`
- No dates: this is always "right now".
- `by=party` (default): per party: SO card not sent, in departments, in folding, in packing, active total.
- `by=so-card`: the same per SO card.
- `by=department`: per department: SO cards, parties, **party names**, meters by status (In-Way, Queue, Pending, Processing, Complete not sent on), total. The first row "SO Card (not sent)" is cloth still on SO cards.
- `by=detail`: every piece of cloth in a department: department, status, Job#, job date, came from, SO#, lot#, party, operator, meters there.
- `departmentId` works only with `by=department` and `by=detail` (else 422 `BAD_FILTER`).

### 4.9 Packing lists
`GET /v1/reports/packing-lists?dateFrom=&dateTo=&customerId=&soCardId=&status=DRAFT|FINAL&gatePass=all|yes|no&search=` (dates = list date)
- One row per list: list#, date, status, SO#, party, quality, description, made for, lot#, thaans, A / B / CP / total meters, rates, **amount**, CTN qty, net / gross weight, gate pass#, pass date, made by, remarks.
- `gatePass=no`: lists that have not left the factory yet. `search`: list#, SO# or gate pass#.

**Thaan wise:** `GET /v1/reports/packing-lists/lines?...same filters...&grade=A|B|CP`
- One row per thaan line: list#, date, status, SO#, party, lot#, thaan#, category, meters, rate, amount, gate pass#.

### 4.10 Gate passes
`GET /v1/reports/gate-passes?dateFrom=&dateTo=&customerId=&search=` (dates = pass date)
- Gate pass#, date, packing list#, SO#, party, quality, lot#, thaans, meters, driver, vehicle#, destination, packing operator, remarks.
- `search`: vehicle#, driver, destination, or a gate pass# / list# / SO# number.

## 5. Download as PDF and Excel (frontend work)
The backend does not make files. Make them in the browser from the same JSON.

**Always download with `all=true`** and the same filters the user picked, so the file has every row, not only the page on screen:
```
GET /v1/reports/grey/parties?dateFrom=2026-10-01&dateTo=2026-10-31&all=true
```

### Excel (.xlsx)
Suggested library: **SheetJS (`xlsx`)** or **ExcelJS**.
1. Row 1: `title`. Row 2: the filters in words ("From 01-10-2026 To 31-10-2026, Party: AZ"). Use the dropdown names, not ids.
2. Empty row, then the header row from `columns[].label`.
3. One row per `rows[]` item, cells in `columns` order.
4. Last row: "Total" + `totals[key]` under the columns with `total: true`.
5. Write numbers as **numbers**, not text, so Excel can add them up: `meters`/`money` with format `#,##0.00`, `qty` `#,##0.000`, `rate` `0.0000`, `int` `0`. Write dates as real dates (`DD-MM-YYYY`).
6. Freeze the header row and set the column widths.
7. File name: `<report>_<dateFrom>_<dateTo>.xlsx`, e.g. `grey-parties_2026-10-01_2026-10-31.xlsx`.
8. SO card report (4.6): one sheet "Summary" with `headerFields`, then one sheet per `tables[]` item (sheet name = `title`, max 31 characters).

### PDF
Suggested library: **jsPDF + jspdf-autotable** (or pdfmake).
1. Top: company name (from `/auth/me` → `company.name`), report `title`, the filters in words, and "Printed on <date time> by <user name>".
2. The table: header from `columns[].label` (repeat it on every page), body from `rows`, a bold **Total** row from `totals`.
3. Use **landscape A4** when there are more than about 8 columns. Wide reports (SO cards, departments/jobs, packing lists) can let the user hide columns before printing; print only the visible columns.
4. Right-align the number columns and format them like the screen (section 2).
5. Footer: "Page X of Y".
6. SO card report (4.6): the `headerFields` grid at the top, then every table one under the other with its `title` as a heading.

### Tips
- Keep the user's visible / hidden columns per report in local storage; use the same set for the PDF.
- Show a loading state during the `all=true` call; it can be big.
- Reuse the same code for every report: it only needs `title`, `filters`, `columns`, `rows`, `totals`.

## 6. Errors
| HTTP | code | When |
|---|---|---|
| 403 | `FORBIDDEN` | the user does not have the service of that report (see section 1) |
| 400 | `VALIDATION_FAILED` | bad date, unknown `by`, unknown filter |
| 404 | `NOT_FOUND` | SO card report for a card that does not exist |
| 422 | `BAD_FILTER` | `departmentId` with `active-fabric?by=party` or `so-card` |
