# Weaving Production Control — Production Register — Frontend Guide

New module: service **`WEAVING_PRODUCTION`** (menu group Weaving; VIEW reads, FULL changes), base `/api/v1/production`. One register **per Weaving department** (Sulzer, Airjet … = `Masters > Department`); every call takes `departmentId`. The looms come from the Loom master (`weaving-loom-master.md`), the K-ID from the loom beam entries (`sizing-looms.md`), the employees from **Payroll**.

## How the units become metres (the formula)
The loom counter gives **units; 1 unit = 1,000 picks**. Cloth made:

`metres = units × 1000 ÷ (Loom Pick × 39.3701)` — Loom Pick = picks per inch of the K-ID. Example from the K-ID 304 screen: 1,114 units at pick 56 = **505.3 m**; balance = net length − produced (4,100 − 505 = 3,595 m = 87.7 % remaining). The server does this (`meters`, `producedM`, `balanceM`); the user only types units. A unit row is tied to the K-ID that was running on that loom on that date, so the system knows which beam the units belong to.

## Screens and flow
1. **Period list** (left) → 15-day periods. 2. **Period page** (days table) → "Open" a day. 3. **Day register** with tabs **Units** / **Weavers**. Daily order: mark the **Weavers** (attendance of the looms + their looms) → enter the **Units** (typing, or CSV upload).
- "Weaver attendance" here is **only for the looms** — it is not the payroll attendance.
- Shifts are fixed: **A, B, C** (`form-data.shifts`).
- Only Payroll employees that are **confirmed**, working that day (joining ≤ date ≤ leaving) and whose Payroll department is **Weaving** can be added.

## Helpers
`GET /production/form-data` → `{ date, shifts: [{code:"A",text:"Shift A"},…], departments: [{id, code, name, looms}], units: {…} }`.

## Periods
`GET /production/periods?departmentId=&limit=36` → `{ data: [ { from, to, label: "16-30 Nov-26", days: 15, daysWithUnits, totalUnits, isCurrent } ] }` (newest first, back to the first day with data). The left list: `label`, `days d`, `totalUnits`.

`GET /production/period?departmentId=&from=2026-11-16` (`from` = the 1st or 16th, else 422 `BAD_PERIOD`):
```json
{ "from": "2026-11-16", "to": "2026-11-30", "label": "16-30 Nov-26", "department": {…}, "dayCount": 15,
  "totalUnits": 28544, "shiftTotals": { "A": 8246, "B": 9886, "C": 10412 },
  "daysWithUnits": 3, "daysWithoutUnits": 12, "averagePerDay": 9515, "bestDay": { "date": "2026-11-16", "weekday": "Mon", "units": 10037 },
  "noWeaver": { "count": 8, "items": [ { "date": "2026-11-18", "shift": "B", "loomNo": "31", "units": 77 } ] },
  "days": [ { "date": "2026-11-16", "weekday": "Mon", "isSunday": false, "registerLooms": 52, "totalUnits": 10037, "hasUnits": true,
              "shifts": { "A": { "units": 2912, "looms": 52, "loomRows": 52, "short": false }, "B": {…}, "C": {…} } } ] }
```
Pills: Total units · `A x · B y · C z` · average per day over `daysWithUnits` days · best day · "`daysWithoutUnits` days with no units yet". Red banner "`noWeaver.count` loom-days with units but no weaver — See them" (list = `noWeaver.items`). In the days table `shifts.X.looms` = looms that had a weaver; show it **red when `short`** (fewer looms with a weaver than the register holds for the day = `registerLooms`). Shade Sundays (`isSunday`). **Open** → the day register.

## Day register — Units tab
`GET /production/day?departmentId=&date=2026-11-16`:
```json
{ "date": "2026-11-16", "weekday": "Mon", "department": {…}, "loomCount": 64, "weaverCount": 27,
  "totals": { "A": 2912, "B": 3371, "C": 3754, "total": 10037 },
  "rows": [ { "loomId": "…", "loomNo": "01", "kId": 338, "entryId": "…", "pick": 56, "totalUnits": 282, "totalMeters": 126.8,
              "shifts": { "A": { "weaver": { "id": "…", "code": 129, "name": "MEEM ZAR KHAN", "weaverId": "…" }, "units": 79, "meters": 35.8 }, "B": {…}, "C": {…} } } ],
  "check": { "problems": 1, "warnings": 0, "items": [ { "level": "PROBLEM", "code": "UNITS_NO_WEAVER", "loomNo": "31", "shift": "B", "message": "Loom 31 shift B: 77 units produced but no weaver assigned" } ] } }
```
- **Rows = every switched-on loom of the department** (plus any switched-off loom that has units that day), sorted by loom no. That is the "Add missing looms" of the old screen: it is not needed any more.
- Columns: Loom · for each shift **Weaver (code)**, **Units** (editable), K# (`kId`, the running K-ID of the loom that day; `null` = no running beam) · Total. `units: null` = nothing entered yet (a `0` is a real 0).
- **Save / refresh**: `PUT /production/day` `{ "departmentId", "date", "rows": [ { "loomId", "shift": "A", "units": 79 } ] }` — send the changed cells; `units: null` removes the cell. Not for a future date (422 `FUTURE_DATE`); a loom of another department → 422 `UNKNOWN_LOOM`. Returns the whole day (same JSON as GET).
- **Delete ticked**: `POST /production/day/clear` `{ departmentId, date, loomIds: […], shift? }` → returns the day.
- **Check** button: `check.problems` / `check.warnings` and `items` (also `GET /production/day/check?departmentId=&date=`). Codes: `UNITS_NO_WEAVER` (problem), `WEAVER_LOOMS_TWO_SHIFTS` and `WEAVER_TWO_SHIFTS` (problem: the same weaver has looms / is listed in two shifts the same day), `UNITS_NO_KID` (warning: units on a loom without a running K-ID), `WEAVER_NO_LOOMS` (warning). Highlight the cells of the problem rows in red like the old screen.
- **CSV**: `GET /production/day/csv?departmentId=&date=` (download), upload below.

## Day register — Weavers tab
`GET /production/weavers?departmentId=&date=` →
```json
{ "date": "…", "department": {…}, "totals": { "weavers": 27, "looms": 64 },
  "shifts": { "A": { "shift": "A", "text": "Shift A", "weaverCount": 9, "loomCount": 64,
      "weavers": [ { "id": "<weaverId>", "shift": "A", "employee": { "id": "…", "code": 133, "name": "ABDUL HAMEED" }, "looms": [ { "id": "…", "loomNo": "10" } ], "loomsText": "10, 11, 12, 13, 14, 20", "loomCount": 6 } ] }, "B": {…}, "C": {…} },
  "inTwoShifts": [ { "employeeId": "…", "shifts": ["A","B"] } ] }
```
Three cards (Shift A / B / C) with "N weavers", table Weaver (code) · Looms (`loomsText`) · No. (`loomCount`).
- **+ Add** (per shift) → picker `GET /production/weavers/employees?departmentId=&date=&search=` → `{ data: [ { id, code, name, department, shifts: ["A"] } ] }` (the "List of employees": Employee name, Employee ID = `code`, Department = `department`; `shifts` = shifts the employee already has that day — warn). Then `POST /production/weavers` `{ departmentId, date, shift, employeeIds: […] }` → 201 `{ added, …weavers }`. 422 `NOT_A_WEAVER` (not a confirmed weaving employee working that day), `FUTURE_DATE`.
- **Give looms**: `PUT /production/weavers/:weaverId/looms` `{ "loomIds": ["…"], "move": false }` — replaces the looms of this weaver for the shift. A loom has only one weaver per shift: if another weaver has it → 422 `LOOM_TAKEN` (`details.looms`); ask the user, then resend with `"move": true` to take it from him. A loom of another department → 422 `UNKNOWN_LOOM`. Offer the looms of the department (`/weaving/looms?departmentId=`).
- **Remove ticked**: `POST /production/weavers/remove` `{ ids: [weaverId…] }` → `{ removed }` (the units stay and show as "no weaver").
- **Copy from another day** (the roster is the same most days): `POST /production/weavers/copy` `{ departmentId, fromDate, toDate }` → `{ copied: {A:9,B:9,C:9}, skippedShifts: ["A"], notWorking: ["name"], …weavers of toDate }` — copies only the shifts that have no weavers on `toDate`; 422 `NOTHING_TO_COPY`, `SAME_DATE`.

## CSV upload (and the dummy files)
Two uploads, same pattern. Send the **text of the file** (read it in the browser) as `{ departmentId, csv: "<file text>" }` — or the parsed rows as `{ departmentId, rows: [ {column: value} ] }` (one of the two, up to 5,000 rows / ~900 KB). Header names are case-insensitive, `loom_no` = `Loom No` = `loomno`. Dates: `2026-11-16` or `16/11/2026`; shift: `A`/`B`/`C` (or 1/2/3). **Every valid row is saved; the bad rows are reported** with their line (the header is line 1), so show the list and let the user fix and re-upload only those:
```json
{ "saved": 2, "skipped": 3, "rows": 5, "dates": ["2026-11-17"], "errors": [ { "line": 4, "message": "\"Z\" is not a shift (A, B or C)" } ] }
```
A wrong header → 422 `BAD_FILE` (`details.expected`).
- **Units file** `POST /production/units/import`, sample `GET /production/units/sample.csv`:
  `date,shift,loom_no,units,k_id` — `k_id` optional: if given it must be the K-ID running on that loom on that date, else that row is rejected. Empty `units` deletes the cell. The weaver comes from the day's Weavers (upload / enter those first).
- **Weaver attendance file** `POST /production/weavers/import`, sample `GET /production/weavers/sample.csv`:
  `date,shift,employee_id,looms` — `employee_id` = the Payroll employee ID (`code`); `looms` = the loom nos separated by space, `;` or `|` (`1 2 3` / `"1;2;3"`), optional (attendance only; looms can be given later). Rows of the same weaver / shift / day are joined; if looms are listed they **replace** the weaver's looms for that shift. A loom already with another weaver, a non-weaving or not working employee, a loom of another department → that row is reported.
- Show the two sample downloads as "Download sample file" next to **Upload**, and the day's `…/day/csv` as **CSV**.

## The loom screens (Sizing > Looms) — production figures
The K-ID entry (`GET /sizing/loom-beams/:id`, also every row of the list) now has: `units` (total), **`producedM`** (cloth made, m), **`balanceM`** (net length − produced, never below 0), `donePct` / `remainingPct` (the "Beam remaining 87.7 %" bar), `daysRun`, `perDayM` (m per working day), `lastProductionDate`, `endsOn` (the day the beam is expected to finish at that pace; `null` until units exist). Header pills: Beam length · Net length · **Produced `producedM` m · `units` units** · **Balance `balanceM` m**; strip: "Production `units` units, net `producedM` · last `lastProductionDate`".
- **Production register panel** of the entry: `GET /sizing/loom-beams/:id/production` → `{ entryId, kId, loomNo, pick, totalUnits, producedM, data: [ { loomNo, date, units, shift, kId, meters, weaver: { code, name } | null } ] }` (columns Loom · Date · Units · Shift · K-ID; the total of the units under the table).
- **Half cut**: prefill the "Length left" of the dialog with `balanceM` (the user can change it). The old field of a half-cut entry that was called `producedM` is now **`estimatedProducedM`** (net length − the length left the user typed); `producedM` is always the register figure.
- A loom that is in the production register cannot be deleted from the Loom master (422 `IN_USE`: switch it off).

## Rules and notes
- Only dates up to today. A day register is per department; a loom is always inside its own department.
- Several weavers of one loom in different shifts are normal (A, B, C); one weaver in two shifts the same day is flagged in the Check, not blocked.
- Not in this step (next): "Weaver wise & attendance billing", "Depart wise & efficiency report", "Production bill / wages".

## Database
Migration `20270102000001-weaving-production.js` (service `WEAVING_PRODUCTION`, tables `production_weavers`, `production_weaver_looms`, `production_units`). Run `npm run db:migrate`. Companies that have Weaving Masters get the service automatically; give it to users with VIEW / FULL.

## Update: only looms with a running beam
A loom with no running (confirmed) K-ID on the day has no beam, so nothing can be produced on it:
- `GET /production/day` rows = only looms that have a running K-ID that day (plus any loom that already has units that day).
- `GET /production/weavers` now also returns `looms: [ { id, loomNo, kId } ]` = the looms that can be given to a weaver that day. **Use this list for the "Looms of …" picker** (not `/weaving/looms`).
- `PUT /production/weavers/:id/looms` with a loom that has no running beam that day → 422 `LOOM_EMPTY` (`details.looms`). A loom the weaver already had stays allowed.
- **CSV uploads too:** in the units file a row for a loom with no running beam on that date is rejected (`Loom 03 has no beam running on 2026-11-17`; a blank `units` that only deletes a cell is still allowed). In the weaver attendance file a row that lists a loom with no running beam is rejected (the whole row, so fix it and re-upload). Rejected rows come back in `errors` with their line; the other rows are saved.
- **Copy from another day:** `POST /production/weavers/copy` copies the weavers always, but a loom is copied only if it has a running beam on the target day. The skipped looms come back as `emptyLooms: ["004"]` (show "Looms without a beam were not copied: 004").

## Weaver wise & attendance billing (tab 2 of the department register)
Same department and the same left list of 15-day periods (`GET /production/periods`). The tab shows one period. All calls: `departmentId` + `from` (the 1st or the 16th, else 422 `BAD_PERIOD`). VIEW reads; the policy needs FULL.

### The sheet — `GET /production/billing/weavers?departmentId=&from=2026-11-16`
```json
{ "label": "16-30 Nov-26", "from": "2026-11-16", "to": "2026-11-30", "weavers": 27,
  "types": [ { "key": "PU", "label": "PU" }, { "key": "P7100", "label": "P7100" } ],
  "rows": [ { "employeeId": null, "label": "NO WEAVER", "noWeaver": true, "shifts": 0, "loomShifts6": 227, "loomShifts5": 15, "unitsByType": { "PU": 887, "P7100": 0 }, "totalUnits": 887, "stoppedLooms": 0, "stoppageUnits": 0, "stoppageAmount": 0 },
            { "employeeId": "…", "code": 113, "name": "ALLAH BAKHSH CHANO", "label": "ALLAH BAKHSH CHANO (113)", "noWeaver": false, "shifts": 7, "loomShifts6": 43, "loomShifts5": 0, "unitsByType": { "PU": 1429, "P7100": 2158 }, "totalUnits": 3587, "stoppedLooms": 6, "stoppageUnits": 320, "stoppageAmount": 240 } ],
  "totals": { "loomShifts6": 840, "loomShifts5": 150, "totalUnits": 46847, "unitsByType": { "PU": 20362, "P7100": 26485 }, "stoppedLooms": 124, "stoppageUnits": 4857, "stoppageAmount": 3865 },
  "reconciliation": [ { "label": "Total units", "entries": 46847, "billing": 46847, "diff": 0, "ok": true }, …, { "label": "Units with no weaver", "entries": null, "billing": 887, "diff": null, "ok": false } ],
  "ties": false, "tieMessage": "does not tie with the entries — see right",
  "noWeaverList": { "count": 14, "units": 887, "items": [ { "date": "2026-11-18", "loomId": "…", "loomNo": "31", "A": 73, "B": 77, "C": 103, "missing": "B" } ] },
  "policy": { "bigLoomMin": 6, "stopBelowUnits": 1, "rates": { "PU": 0.85, "P7100": 0.75 } } }
```
- **Left table:** Weaver (`label`, red for `noWeaver`) · SHIFTS `shifts` · LOOM-SHIFTS 6-LOOM `loomShifts6` / 5-LOOM `loomShifts5` · one UNITS column per `types[]` (`unitsByType[key]`) · TOTAL `totalUnits`. The NO WEAVER row is first, then the weavers by name. Footer row = `totals`. The unit columns are built from `types` (they follow the loom types of the department; units on a loom with no type get an "Other" column).
- **Pills:** "Total `totals.totalUnits` units", then one pill per type: "PU 20,362 · P7100 26,485"; title "`label`  `weavers` weavers"; red chip `tieMessage` when `ties` is false.
- **6-loom / 5-loom:** every loom-shift of a weaver goes to the column of its group = the "looms per weaver" of the loom in the Loom policy (a loom in a range uses that range, all other looms use "All other looms"). `groups` = `[ { looms: 6, label: "6-LOOM" }, { looms: 5, label: "5-LOOM" } ]` gives the columns (build them from it, they follow the policy); per row `loomShifts: { "6": 43, "5": 0 }` (`loomShifts6` / `loomShifts5` are the same numbers for groups 6 and 5). Loom shifts with units but no weaver are put in their group too. `extraLooms` (per row and in `totals`) = looms a weaver runs above the looms per weaver of their group.
- **Click a weaver row →** the attendance panel (below). The NO WEAVER row has no attendance (use `noWeaverList`).
- **Reconciliation card ("Entries and billing"):** each line of `reconciliation`: label · ENTRIES `entries` · BILLING `billing` · DIFF `diff` · badge **OK** (`ok` true) / **CHECK** (`ok` false); `entries`/`diff` are null for "Units to named weavers" and "Units with no weaver" (the last one is CHECK while there are units with no weaver).
- **Red banner:** "`noWeaverList.count` loom-days with units but no weaver — these units are not on any weaver's bill. Open the day to enter the weaver." Table: DATE · LOOM · A · B · C (all units of the loom day; show the shift in `missing` in red) · MISSING (`missing`) · **Open day** (open the day register of `date`, Weavers tab).
- **Buttons:** **Loom policy** (below), **Excel** `GET /production/billing/weavers.xlsx`, **PDF** `GET /production/billing/weavers.pdf` (same query; they download "SULZER UNITS - WEAVER WISE" with the columns Weaver · Shifts · 6-loom shifts · 5-loom shifts · one column per type · Total units · Stopped looms · Stoppage units · Stoppage amnt, and a TOTAL row). Fetch with the token and save as a blob.

### Attendance of one weaver — `GET /production/billing/weavers/:employeeId?departmentId=&from=`
`employeeId` = `rows[].employeeId`. Answer: `{ employee: {id, code, name, label}, days: 5, shifts: 7, units: 3587, extraLooms: 1, rows: [ { date, weekday: "Mon", looms: 6, A: null, B: null, C: 479, units: 479, extra: 0 } ], total: { looms, A, B, C, units, extra } }`.
Panel: "ATTENDANCE  `employee.label`", pills "`days` days · Shifts `shifts` · Units `units` · Extra looms `extraLooms`" (amber when > 0), table DATE (+ weekday) · LOOMS · A · B · C · UNITS · EXTRA, footer = `total`. `A/B/C` are the units of the weaver's looms in that shift (null = he did not work that shift); EXTRA = looms above `bigLoomMin` in a shift.

### Loom policy and rates — the "Loom policy" button (dialog "Loom policy and rates · Sulzer")
- `GET /production/policy?departmentId=` →
```json
{ "department": {…}, "ranges": [ { "from": 31, "to": 40, "loomsPerWeaver": 5 } ], "otherLooms": 6, "groups": [6, 5], "stopBelowUnits": 1,
  "rates": { "effectiveFrom": "2026-08-16", "ratePerDay": 1000, "loomTypes": [ { "loomType": "PU", "ratePerUnit": 0.85 }, { "loomType": "P7100", "ratePerUnit": 0.75 } ] },
  "rateHistory": [ { "effectiveFrom": "2026-08-16", "ratePerDay": 1000, "rates": { "PU": 0.85, "P7100": 0.75 } } ] }
```
- Dialog: rows **LOOM FROM / LOOM TO / LOOMS PER WEAVER** (`ranges`; 3 empty rows + "+ Add loom range"; a blank row is not sent = removed), **All other looms** (`otherLooms`), **Bill rates**: Rate per day (shift) `rates.ratePerDay`, "Rate per unit · PU / P7100" one per `rates.loomTypes[]` (the loom types of the department), **Rates apply from** (date).
- `PUT /production/policy` (FULL) `{ departmentId, ranges: [ {from, to, loomsPerWeaver} ], otherLooms, ratePerDay, rates: { "PU": 0.85, "P7100": 0.75 }, ratesFrom: "2026-08-16" }` → the same answer as GET. Send the whole `ranges` list (it replaces the old one). Send `ratePerDay` / `rates` with `ratesFrom` to save the rates (without `ratesFrom` = today). Errors: 422 `RANGE_OVERLAP` ("Ranges must not overlap"), 422 `BAD_RANGE` (from above to). Ranges are by the number in the loom no (loom "031" = 31); a loom no with letters is always "all other looms".
- **Past periods are re-grouped** when the ranges change (the sheet is calculated on every call). **Rates keep their history:** a new "Rates apply from" date adds a version; a loom shift uses the rates in force on its own date, so earlier periods keep the rates they had. The stoppage amount of the sheet uses the rate per unit of the loom type; the rate per day and the extra-loom pay (rate per day ÷ looms in the group) are for the production bill (next step).
- **Stoppage (same rule in the weaver sheet and the production bill):** in a weaver shift, a loom of the weaver with no production (no units cell, or units below `stopBelowUnits`, default 1) is a *stopped loom*. It is paid **half the average units of the weaver's other (running) looms in that shift**, at the rate per unit of its own loom type on that day. If the weaver has no running loom in the shift nothing is paid.

### Loom master — new field `loomType`
`POST/PATCH /weaving/looms` accept `loomType` (text, max 20, e.g. "PU", "P7100"; empty/null clears it) and every loom answer has `loomType`. Add it as an optional field "Loom type" in Masters > Loom. The unit columns of the sheet are split by it, so set it on every loom of the department.

### Database
Migrations `20270105000001-weaving-billing.js` (`looms.loomType`, `production_policies`) and `20270106000001-production-policy-ranges.js` (ranges, `production_rates`), then `npm run db:migrate`.

## Depart wise & efficiency report (tab 3 of the department register)
Same department, same left list of 15-day periods. All calls: `departmentId` + `from` (the 1st or the 16th, else 422 `BAD_PERIOD`). VIEW reads; the basis PUT needs FULL.

### The report — `GET /production/efficiency?departmentId=&from=2026-11-16`
```json
{ "label": "16-30 Nov-26", "from": "2026-11-16", "to": "2026-11-30", "title": "SULZER UNITS & EFFICIENCY DEPART WISE 16-NOV-26 TO 30-NOV-26",
  "note": "Efficiency = units / (running looms x RPM x 1.44) x 100. Total = average of the groups; Grand total = average of the days.", "blocksSet": true,
  "basis": { "minRunUnits": 1, "defaultRpm": 239, "blocks": [ { "from": 1, "to": 8 }, … ] },
  "groups": [ { "key": "1-8", "label": "1 to 8", "from": 1, "to": 8, "looms": 8 }, … ],
  "days": [ { "date": "2026-11-16", "weekday": "Mon", "hasUnits": true, "unitsTotal": 10037,
              "units": { "1-8": 1803, "9-18": 956, … },
              "efficiency": { "1-8": { "value": 48.18, "runningLooms": 7, "rpm": 400, "capacityUnits": 3742, "units": 1803 }, "9-18": null, … },
              "efficiencyTotal": 57.08 } ],
  "grand": { "unitsTotal": 46847, "units": { "1-8": 7916, … }, "efficiency": { "1-8": 42.3, … }, "efficiencyTotal": 54.74 } }
```
- **Two tables** (both from this one answer), every day of the period (15 or 16 rows) + a **Grand Total** row (yellow like the screen):
  1. **"UNITS DEPART WISE 16-Nov-26 TO 30-Nov-26"** (`title` has the PDF form): DATE · one column per `groups[]` (header `label`, e.g. "1 to 8"; value `days[].units[key]`) · **Grand Total** `unitsTotal`. Footer = `grand.units` / `grand.unitsTotal`. Days without units show 0s.
  2. **"Efficiency DEPART WISE …"**: same columns, values `days[].efficiency[key].value` (2 decimals) and **Grand Total** = `efficiencyTotal`. A day with `hasUnits` false shows one merged cell "no units". A block with no running loom that day is `null` (empty cell). Footer = `grand.efficiency[key]` / `grand.efficiencyTotal`.
- **Hover an efficiency** → "running looms `runningLooms`, RPM `rpm`" (also `capacityUnits` = units at 100%, `units`).
- **Formula (as printed under the tables):** efficiency = units / (running looms × RPM × 1.44) × 100. A loom is *running* on a day when it gave at least `basis.minRunUnits` units that day (all shifts together). Its RPM is the one of the beam entry (K-ID) running on it that day (Looms Status), else `basis.defaultRpm` (239). "Total" of a day = the average of the blocks' efficiencies of that day; **Grand total** of a column = the average of the days that have units (days without units are left out).
- **Looms with a letter in the loom no** (not a number) are not in any block: their units show in an extra block "Other looms" (`key: "other"`) only when they have units.
- **Excel / PDF:** `GET /production/efficiency.xlsx` / `.pdf` (same query; fetch with the token, save as blob). PDF "SULZER UNITS & EFFICIENCY DEPART WISE 16-NOV-26 TO 30-NOV-26": Date · Units per block · Units total · Eff per block · Eff total, Grand Total row, printed time + page in the footer. Excel has the same tables in the yellow / green style of the screen.

### The basis — the "Save basis" line under the tables
- `GET /production/efficiency/basis?departmentId=` → `{ department, blocks: [ {from, to} ], minRunUnits, defaultRpm }`.
- `PUT /production/efficiency/basis` (FULL) `{ departmentId, minRunUnits?, defaultRpm?, blocks?: [ { from, to } ] }` → same as GET. The input in the sentence "a loom is running when it gave at least [1] units that day" is `minRunUnits`; **Save basis** sends it. Changing it changes the report at once (past periods too).
- **Loom blocks ("departs")** are the loom ranges of the columns: 1 to 8, 9 to 18, 19 to 30, 31 to 40, 41 to 52, 53 to 64. They are set here once per department: add a small dialog "Loom blocks" (rows FROM / TO, "+ Add", blank row = removed) that sends the whole `blocks` list. Overlap → 422 `RANGE_OVERLAP`, from above to → 422 `BAD_RANGE`. While `blocksSet` is false (nothing saved) the report shows one block with all looms; show a hint "Set the loom blocks".
- `defaultRpm` (239) can be an input next to `minRunUnits`.

### Database
Migration `20270107000001-production-efficiency-basis.js` (`production_policies.blocks / minRunUnits / defaultRpm`), then `npm run db:migrate`.


## Production bill / wages (tab 4 of the department register)
Same department, same left list of 15-day periods. All calls: `departmentId` + `from` (the 1st or the 16th, else 422 `BAD_PERIOD`). VIEW reads. Rates come from the **Loom policy & rates** dialog (button on this tab too, see "Loom policy and rates"); each day uses the rates in force on that day.

### The bill — `GET /production/bill?departmentId=&from=2026-11-16`
```json
{ "label": "16-30 Nov-26", "title": "SULZER PRODUCTION BILL", "subtitle": "FROM 16-11-2026 TO 30-11-2026", "weavers": 27, "status": "CHECK",
  "groups": [ { "looms": 6, "label": "6 Loom Group" }, { "looms": 5, "label": "5 Loom Group" } ], "types": [ { "key": "PU", "label": "PU" }, { "key": "P7100", "label": "P7100" } ],
  "rates": { "ratePerDay": 1000, "byType": { "PU": 0.85, "P7100": 0.75 } },
  "rows": [ { "no": 3, "employeeId": "…", "code": 96, "name": "ABDUL KHALIQ", "label": "ABDUL KHALIQ (96)", "days": 5, "groups": { "6": { "loom": 30, "extra": 1 }, "5": { "loom": 0, "extra": 0 } },
             "ratePerDay": 1000, "wagesAmount": 5000, "extraLoomWages": 167, "totalWages": 5167,
             "unitsByType": { "PU": 0, "P7100": 1884 }, "totalUnits": 1884, "rateByType": { "PU": 0.85, "P7100": 0.75 }, "amountByType": { "PU": 0, "P7100": 1413 }, "productionAmount": 1413,
             "stoppedLooms": 8, "stoppageUnits": 315, "stoppageAmount": 236, "net": 6816 } ],
  "totals": { "days": 136, "groups": { "6": { "loom": 648, "extra": 5 }, "5": { "loom": 140, "extra": 2 } }, "wagesAmount": 136000, "extraLoomWages": 1233, "totalWages": 137233, "unitsByType": {…}, "totalUnits": 45960,
              "amountByType": {…}, "productionAmount": 36417, "stoppedLooms": 124, "stoppageUnits": 4857, "stoppageAmount": 3865, "net": 177515 },
  "checks": [ { "key": "units", "label": "Units: entries = bill + no weaver", "value": 46847, "ok": true }, … ],
  "noWeaver": { "units": 887, "message": "887 units have no weaver, so they are not in this bill. See the weaver wise page." },
  "stoppage": { "count": 124, "units": 4857, "amount": 3865 }, "note": "Days = shifts worked. …" }
```
- **Header:** "Sulzer register — production bill · wages and production amount"; title "`label`  `weavers` weavers"; buttons **Loom policy & rates**, **Excel** `GET /production/bill.xlsx`, **PDF** `GET /production/bill.pdf` (fetch with the token, save as blob; the PDF is "SULZER PRODUCTION BILL / FROM 16-11-2026 TO 30-11-2026", landscape, the table below with the letters row, TOTAL row and the footnote).
- **Red banner** when `noWeaver.message` is not null (units with no weaver are not on any bill; link to the Weaver wise tab).
- **Chips** from `checks` (label + `value`, green when `ok`); the first chip is **Check** (amber, `status` "CHECK") or **OK**: `status` is CHECK when any check fails or there are units with no weaver. Chips: Units entries = bill + no weaver · Loom-shifts attendance = bill · Wages days × rate + extra · Production units × rates · Stoppage sum of the detail list · Stoppage units sum of the detail list · Net wages + production + stoppage.
- **Table** (group header bands; the small letter + formula under each column title, as in the screen): **#** `no` · **WEAVER** `label` (code in grey) · **DAYS** (a) `days` · per `groups[]` (`rows[].groups[looms]`): **LOOM** `loom` and **EXTRA** `extra` (extra shown red when > 0) under the band "6-LOOM GROUP" / "5-LOOM GROUP" (`groups[].label`) · band **WAGES**: **RATE** `ratePerDay` (f), **AMOUNT** `wagesAmount` (g = a × f), **EXTRA** `extraLoomWages` (h), **TOTAL** `totalWages` (i = g + h) · band **UNITS**: one column per `types[]` (`unitsByType[key]`), **TOTAL** `totalUnits` · band **PRODUCTION AMOUNT**: for each type its **RATE** (`rateByType[key]`, grey) and **AMNT** (`amountByType[key]` = units × rate), then **TOTAL** `productionAmount` · band **STOPPAGE**: `stoppedLooms`, `stoppageUnits`, `stoppageAmount` (the detail below) · **NET** `net` = total wages + production amount + stoppage amount. Footer **Total** = `totals` (same keys). The columns of groups and types are built from `groups` and `types` (they follow the Loom policy and the loom types).
- **Rules (also printed under the table = `note`):** *Days* = shifts worked. *Loom* = loom-shifts up to the group size (the looms per weaver of the loom's group), *Extra* = looms beyond it in a shift, each paid rate per day ÷ looms in the group. *Production amount* = units × the rate per unit of the loom type. *Stoppage* = a loom of the weaver with no production in a shift is paid half the average units of his other looms in that shift, at its own rate. Amounts are whole rupees per weaver; the totals add up the rounded amounts. If the rate changes inside the period, each day uses its own rate; `ratePerDay` / `rateByType` show the rates in force on the last day of the period.

### Loom stoppage detail (the section under the table, "▼ Loom stoppage detail · 124 stopped loom-shifts · 3,865")
`GET /production/bill/stoppage?departmentId=&from=` → `{ count, units, amount, items: [ { label, code, name, date, shift, loomNo, type, runningLooms, avgUnits, stoppageUnits, rate, amount } ] }`. Columns: WEAVER `label` · DATE · SHIFT · LOOM `loomNo` · TYPE · RUNNING LOOMS `runningLooms` · AVG UNITS `avgUnits` · STOPPAGE UNITS (½) `stoppageUnits` · RATE · AMOUNT. Sorted by weaver, date, shift, loom. Button **Excel** `GET /production/bill/stoppage.xlsx`. (The same figures are in the stoppage columns of the bill and of the Weaver wise sheet.)

### Database
No new migration (uses the tables of the Loom policy and the register).
