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
