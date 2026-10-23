# REPORTS: all system reports, with PDF and Excel download

No database change. 15 read-only reports under `/api/v1/reports/...`. All of them answer in the **same shape**, so build ONE report screen, ONE PDF maker and ONE Excel maker, and use them for every report.

## 1. The answer shape (same for every report)
```json
{ "title": "Grey store: party wise cloth", "generatedAt": "2026-10-20T08:00:00Z",
  "filters": { "dateFrom": "2026-10-01" },
  "sections": [ { "key": "parties", "title": "Party wise",
      "columns": [ { "key": "party", "label": "Party", "type": "text" }, { "key": "inwardMeters", "label": "Came (m)", "type": "number" } ],
      "rows":    [ { "party": "AZ", "inwardMeters": 900 } ],
      "totals":  { "inwardMeters": 900 } } ],
  "page": 1, "limit": 50, "total": 1, "export": false }
```
- **`columns`** tells you what to show: header text (`label`) and how to format (`type`):
  `text`, `number` (meters, counts; 2 decimals, right aligned), `money` (Rs, thousands separators), `date`, `datetime`, `list` (long text such as "15, 16, 17"; wrap it), `tag` (a red badge when not empty, for example "Fabric return grey").
- **`rows`** are plain objects; the value of each column is in `row[column.key]`.
- **`totals`** has the sums of the number columns (over ALL rows, not only the page). Show it as a bold last row.
- **`sections`:** most reports have one. The SO card detail report has several (lots, departments, chemicals, ...). Show one table per section, in order, each with its `title`.
- **Paging:** `page` and `limit` (default 50). `total` = number of rows.
- **Download:** call the same URL with **`export=true`**. That returns every row (no paging). Build the PDF or Excel from that answer.

## 2. Common filters (query string; each report uses the ones that make sense)
`dateFrom`, `dateTo` (2026-10-20), `customerId` (party), `departmentId`, `itemId` (chemical), `soNo`, `jobNo`, `status`, `operator` (name part), `search`, `isGreyReturn` (true / false), `groupBy`, `page`, `limit`, `export`.
- **Filter bar:** date range, Party dropdown (from `/customers`), Department dropdown, Chemical dropdown, SO# box. Show only the filters the report supports.
- Pressing **Refresh** calls the report again.

## 3. Download buttons (on every report screen)
- **Excel (.xlsx):** use SheetJS (`xlsx`).
  1. Call the report with `export=true`.
  2. For each section: row 1 = column `label`s, then one row per `rows` item, then a bold totals row.
  3. Number columns as numbers (so the sheet can add them up), money columns with 2 decimals, dates as dates.
  4. One sheet per section (sheet name = section `title`, max 31 characters).
  5. File name: `<title>-<dateFrom>-<dateTo>.xlsx`.
- **PDF:** use jsPDF with `jspdf-autotable`.
  1. Same data (`export=true`).
  2. Page: A4 landscape (the tables are wide). Title and company name at the top, `filters` as a small line under it, "Generated <generatedAt>" and page numbers at the bottom.
  3. One table per section with its `title`. Header row repeated on each page. Totals as the last bold row.
  4. `list` columns wrap. If there are more than 12 columns, use a smaller font (7 pt).
  5. Show the `tag` text in red.
- Both buttons need no extra backend call.
- Also add a **Print** button (the browser print of the same table).

## 4. The reports
Access is by service: the person needs the service of the data (Grey Store, SO Card, Chemical Store, Folding, Packing). Department reports show only the departments the person has. A person without access gets 403; hide the menu item.

### Grey store
| Report | URL | Filters | What it shows |
|---|---|---|---|
| Party wise | `GET /reports/grey/parties` | dateFrom, dateTo (lot inward date), customerId | Per party: lots, came (m), thaans, SO cards, on SO cards (m), fabric return (m), given back (m), **in grey store (m)**, SO card not sent (m), **in process (m)**, reached Packing (m), on packing lists (m), gone with a gate pass (m) |
| Lot wise | `GET /reports/grey/lots` | customerId, dateFrom, dateTo, search (lot#, DC#, type#), status=in_store | Per lot: came, on SO cards, fabric return, given back, in store, not sent, in process, reached Packing |

### SO cards
| Report | URL | Filters | What it shows |
|---|---|---|---|
| SO cards | `GET /reports/so-cards` | dateFrom, dateTo, customerId, status (NEW, SENT, IN_DEPARTMENT), departmentId (went to), isGreyReturn, soNo | Per SO card: lots, lot numbers, thaans, meters, status, now at, which departments it went to, in process (m), reached Packing (m), chemical cost, cost per meter |
| Movement | `GET /reports/so-cards/movement` | dateFrom, dateTo, customerId, departmentId, soNo | **Which SO card went to which department:** one row per job and SO card with lots, thaans and meters, from, status and where it was sent next |
| One SO card | `GET /reports/so-cards/:id` | none | `header` (SO#, party, quality, status, chemical cost) plus 5 sections: **lots and thaans** (with thaan numbers), **departments it passed** (job, operator, meters, cost), **chemicals used** per department, **where the cloth is now**, **packing lists and gate passes**. Always returns every row. Open it from the SO card list, and give it a PDF button. |

### Departments and operators
| Report | URL | Filters | What it shows |
|---|---|---|---|
| Departments summary | `GET /reports/departments/summary` | dateFrom, dateTo, departmentId | Per department: jobs, SO cards, lots, thaans, meters came, waiting, in process, complete, sent on, still here, rejected, chemical cost, cost per meter |
| Department jobs | `GET /reports/departments/jobs` or `GET /reports/departments/:code/jobs` | dateFrom, dateTo, customerId, soNo, jobNo, status, operator | Every job and SO card of the department: lots, thaans, meters, status, operator, process date, where it went next, chemical cost, cost per meter |
| Operator wise | `GET /reports/operators` | departmentId, dateFrom, dateTo, operator | Per department and operator: jobs, SO cards, lots, thaans, meters, chemical cost, first and last date |

### Chemicals
| Report | URL | Filters | What it shows |
|---|---|---|---|
| Usage and cost | `GET /reports/chemicals/usage` | dateFrom, dateTo, departmentId, itemId, customerId, soNo, jobNo, **groupBy** | Detail (default): per department, request, Job#, SO#, party, lots, thaans, meters, chemical, qty, rate, amount. `groupBy=chemical`, `department`, `job` or `so_card` gives totals per that. A request for a whole job is shared between its SO cards by meters. |
| Stock by rate | `GET /reports/chemicals/stock` | itemId, store (chemical / general) | Every batch in stock: item, batch date, vendor, rate, qty, value |
| Purchases | `GET /reports/chemicals/purchases` | dateFrom, dateTo, itemId, store | Every approved purchase line: date, IP#, DC#, vendor, chemical, qty, rate, amount |

### Folding, cloth in process
| Report | URL | Filters | What it shows |
|---|---|---|---|
| Folding | `GET /reports/folding` | dateFrom, dateTo, customerId, status=open | Per job and SO card: **came from which department**, received, A, B, CP, gain / loss, **sent to Packing**, **left in Folding**, re-work, status, cost |
| Cloth now | `GET /reports/cloth-now` | customerId, departmentId, onlyProcess=true, **groupBy** | **Where every party's cloth is right now:** grey store, SO card not sent, every department with its status, and Packing. `groupBy=party_department` (default), `party`, `department`, `so_card` or `detail`. Use `onlyProcess=true` for "cloth moving between departments". |

### Packing
| Report | URL | Filters | What it shows |
|---|---|---|---|
| Packing lists | `GET /reports/packing-lists` | dateFrom, dateTo, customerId, soNo, status (DRAFT / FINAL), `view=lines` | Per list: SO#, party, lots, thaans, A / B / CP meters, total, amount, gate pass no, vehicle. `view=lines` gives one row per thaan and category. |
| Gate passes | `GET /reports/gate-passes` | dateFrom, dateTo, customerId, search | Gate pass no, date, list, SO#, party, lots with thaan numbers, thaans, operator, driver, vehicle, going to |

## 5. Notes
- **Thaans are counted for whole lots only.** When cloth is split (for example a partial send from Folding), the exact thaans are not known, so those rows show 0 thaans and the meters are still right. The column title says "(whole lots only)" on Cloth now.
- **Fabric return** cloth carries the tag `Fabric return grey`. Show the `tag` column.
- **Closed Folding rows:** cloth lost to shrinkage (the row was closed) is not counted as "in process".
- **Gain / loss in Folding** is shown only once the thaan is fully graded or the row is closed (as in the Folding screen).
- Make a **Reports** menu with the groups above (Grey store, SO cards, Departments, Chemicals, Folding and cloth, Packing). Each entry opens the same report screen with its URL and filter list. Clicking an SO# in any report can open the "One SO card" report.
