# WASTAGE AND SHRINKAGE REPORT (N-B4)

Where cloth is lost (or gained): for each department the meters it **received**, the meters it **sent on**, the **difference** and the **percent**. A difference is a **loss** when the department received more than it sent on, and a **gain** when less. The owner can set the **expected shrinkage** per department and quality; a row over it is marked **red**.

Read only: the report changes nothing.

## 1. What is counted
- A **process department** (Dyeing, Printing, Finishing ...) that wrote the **thaans it made**: received = the meters of the cloth line it received, sent on = the meters the next departments received from it. Example: Dyeing received 220 m, made one thaan of 215 m and sent it on: loss 5 m (2.27 %).
- **Folding**: received = the meters of a thaan it received, sent on = what it graded (A + B + CP). A thaan counts when it is **fully graded** (or the Folding row is closed).
- **Not counted**: cloth still waiting in a department (not sent on), a job that was **rejected**, a department that did not write its thaans, a thaan only partly graded in Folding, an open machine run. So the report never shows cloth that is still being worked on as a loss.
- **The period** (`dateFrom`, `dateTo`) is the day the cloth was **sent on** (process department) or the Folding job date.

## 2. The report: `GET /api/v1/reports/shrinkage`
Same answer shape as every report (`{ title, sections: [{ columns, rows, totals }], page, limit, total }`), listed in the Reports menu (`GET /reports`, key `shrinkage`).

Query (all optional):
| Param | Meaning |
|---|---|
| `dateFrom`, `dateTo` | the period (see above) |
| `departmentId` | one department |
| `customerId`, `qualityId` | one customer / quality |
| `lotNo` | one grey lot number |
| `jobNo` | one job number of the department |
| `groupBy` | `department` (default), `quality`, `customer`, `month` or `job` |
| `page`, `limit`, `export=true` | paging; `export=true` returns every row for PDF / Excel |

Row:
```json
{ "group": "Dyeing", "lines": 2, "receivedMeters": 320, "sentOnMeters": 310, "diffMeters": 10, "diffPercent": 3.13, "kind": "Loss",
  "expectedPercent": 2.97, "overLimit": true, "status": "Over the expected limit",
  "department": "Dyeing", "quality": "PC TWILL, COTTON", "customer": "AZ, BB", "month": "2026-11", "jobNo": null, "soNo": null,
  "keys": { "departmentId": "…", "qualityId": null, "customerId": null, "month": null, "jobId": null } }
```
- `diffMeters` = received - sent on: **positive = loss**, negative = gain. `diffPercent` = difference / received x 100 (negative for a gain). `kind`: `Loss`, `Gain` or `-`.
- **`overLimit: true`** (and `status: "Over the expected limit"`): the loss percent is above the expected percent. **Show that row red.** `status: "Within the limit"` when a limit applies and the loss is under it; empty when no limit is set. `expectedPercent` is `null` when no limit is set for the row.
- A group of many qualities has the **weighted** expected percent (each line counts at the limit of its department and quality).
- With `groupBy=job` the rows are the jobs (`department`, `soNo`, `customer`, `quality`, `jobNo` filled). Use it as the **drill-down** ("click a row to open the jobs behind it"): open the same report with the row's `keys` as filters (`departmentId`, `qualityId`, `customerId`) and `groupBy=job`, or the Departments > Jobs report with the same filters.
- Columns come in `sections[0].columns` (`group` is the first one, labelled by the grouping). `totals`: `lines`, `receivedMeters`, `sentOnMeters`, `diffMeters`, `diffPercent`, `overLimitRows`.
- Sorted by the biggest loss first (by month, oldest first, for `groupBy=month`).
- **At most 5,000 rows**: more answers **422 `REPORT_TOO_BIG`** ("choose a shorter period or a filter"). Show the message.
- Access: the Departments reports service (`REPORT_DEPARTMENTS`) or any department service; a department person sees his own departments only.

## 3. The expected shrinkage (settings): `GET` / `PUT /api/v1/shrinkage-limits`
`GET` (service REPORT_DEPARTMENTS):
```json
{ "departments": [ { "id": "…", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS" } ],
  "qualities": [ { "id": "…", "name": "PC TWILL" } ],
  "limits": [ { "id": "…", "departmentId": "…", "qualityId": "…", "limitPercent": 2.5 }, { "id": "…", "departmentId": "…", "qualityId": null, "limitPercent": 6 } ],
  "note": "A limit with no quality is the limit of the whole department; a limit for a quality wins over it." }
```
`PUT` (**client admin only**; others 403): send only what changes; `limitPercent: null` removes a limit.
```json
{ "items": [ { "departmentId": "…", "qualityId": "…", "limitPercent": 2.5 }, { "departmentId": "…", "qualityId": null, "limitPercent": 6 }, { "departmentId": "…", "qualityId": "…", "limitPercent": null } ] }
```
- `qualityId: null` = the limit of the whole department (used for a quality that has no limit of its own). `limitPercent`: 0 to 100 (2 decimals). The answer is the same as the GET.
- Errors: 400 validation (percent out of range), **422 `DUPLICATE_LIMIT`** (same department and quality twice), 404 (a department the company does not have / a quality of another company).

## 4. The screens (suggested)
**Report page** (Reports > Wastage and shrinkage):
- Filters: period, department, customer, quality, lot no, job no, and "Group by" (Department / Quality / Customer / Month / Job).
- Grouped table: group, received, sent on, difference (m), difference %, loss/gain tag, expected %, status. Rows with `overLimit` are **red**. Gain rows can be green.
- A small bar chart of the loss % per department (or per group), with the expected % as a line.
- Click a row: the jobs behind it (`groupBy=job` with the row's `keys`).
- Export button: `export=true` (PDF / Excel made in the frontend like the other reports).

**Settings > Shrinkage limits** (client admin): a grid **quality x department** (rows qualities, columns departments, plus a first row "Any quality"): a percent box in each cell (empty = no limit). Save sends the changed cells in one `PUT`.

## 5. Quick checks
1. Dyeing receives 220 m, makes a thaan of 215 m and sends it on: the report shows received 220, sent on 215, loss 5 m = 2.27 %.
2. A job whose cloth was not sent on yet does not show.
3. Set the limit of the quality 2 %: the row is red (2.27 > 2); set 3 %: it is not.
4. `groupBy=quality`, `customer`, `month`, `job` change the first column and the rows.
5. A cloth that came out longer than it went in shows as a gain (negative difference).
6. Another company sees none of these cloths; a normal user cannot change the limits (403).
