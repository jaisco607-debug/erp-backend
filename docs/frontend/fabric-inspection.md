# FABRIC INSPECTION (N-B1): the 4-point system, thaan by thaan

Quality control of cloth. An inspector checks one **thaan**, writes the **defects** he finds, and the server works out the **points**, the **points per 100 meters** and the **grade** (A / B / C / Reject). Folding and Packing only **show** that grade as a suggestion. Inspection **changes nothing** in the cloth flow.

## 0. Who does it: a new service `INSPECTION`
- A new service **Fabric Inspection** (`INSPECTION`, menu group PRODUCTION). It is switched on for every existing company by the migration; for a new company the super admin gives it like any service. The client admin gives it to the **inspector** (a separate person) in the Users screen: add it to the list of services there.
- **VIEW**: see inspections, settings, defect list and the summary report. **FULL**: also create, write defects, finish, delete drafts.
- **Client admin only**: settings, the defect list, and **reopen** of a finished inspection.
- Others (for example a Folding person without INSPECTION) get **403** on the inspection routes. They still see the grade badge inside the Folding and Packing screens.

## 1. What can be inspected
- **A grey thaan** (`source: "GREY"`): a thaan of a grey lot (checking the cloth that came in).
- **A department thaan** (`source: "DEPARTMENT"`): a thaan a department made (after Dyeing, Printing, Finishing ...). The record keeps the department, job no, SO no, operator and machines (if known).
- A lot without thaans has nothing to inspect.
- The same thaan can be inspected **again** (after re-process). **The latest finished one counts.**
- **One draft per thaan** at a time (`DRAFT_EXISTS`).

## 2. The 4-point rules (the standard; the client admin may change them)
- Points by the size of the defect: up to 3 inch = 1, over 3 to 6 inch = 2, over 6 to 9 inch = 3, over 9 inch = 4.
- Some defects have **fixed points** whatever the size (a **hole** is 4 in the standard list).
- **One meter of cloth never gets more than 4 points** (the 4-point rule; `maxPointsPerMeter`, can be changed or turned off). A defect at 12.2 m and one at 12.8 m are on the same meter.
- **Points per 100** = points x 100 / meters. If the company chooses **square yards**: points x 100 / square yards, where square yards = meters x 1.0936133 x width(inch) / 36. Then the **width in inches** is required to finish.
- **Grade**: A up to 20, B up to 30, C up to 40, above 40 = **REJECT** (defaults).
- Example: a 215 m thaan with 1 + 2 + 3 = 6 points: 6 x 100 / 215 = **2.79** → **A**.
- **All points and grades are worked out by the server.** The screen may show a live preview with the same sums, but the server's numbers are the truth.

**The screen's preview must use the same maths** (put it in a model file with these tests):
1. points of a defect = the type's `fixedPoints` if set, else the points of its `sizeClass`;
2. group the defects by meter `floor(atMeter)` (a defect at the very end counts in the last meter: `min(floor(atMeter), ceil(meters) - 1)`), and cap each group at `maxPointsPerMeter`;
3. total = sum of the groups; per 100 as above, rounded to 2 decimals; grade = the first limit with `value <= maxPoints`, else `REJECT`.
Test values: (1+2+3 points on 215 m) → 2.79; on one meter 3 + 4 points → 4; borders 20 = A, 20.01 = B, 30.01 = C, 40.01 = REJECT; 6 points, 215 m, 58 inch, square yards → 1.58.

## 3. Settings (`/api/v1/inspection/...`)
### `GET /inspection/settings` (VIEW)
```json
{ "pointTable": [ { "key": "S1", "label": "Up to 3 inch", "points": 1 }, { "key": "S2", "label": "Over 3 to 6 inch", "points": 2 },
                  { "key": "S3", "label": "Over 6 to 9 inch", "points": 3 }, { "key": "S4", "label": "Over 9 inch", "points": 4 } ],
  "gradeLimits": [ { "grade": "A", "maxPoints": 20 }, { "grade": "B", "maxPoints": 30 }, { "grade": "C", "maxPoints": 40 } ],
  "basis": "METER", "maxPointsPerMeter": 4, "standard": { "…the same four keys…" : "" }, "grades": ["A","B","C","REJECT"], "note": "…" }
```
### `PUT /inspection/settings` (client admin): send only what changes
`{ "gradeLimits": [ {"grade":"A","maxPoints":20}, {"grade":"B","maxPoints":28}, {"grade":"C","maxPoints":36} ], "basis": "SQ_YARD", "maxPointsPerMeter": 4, "pointTable": [ … ] }`
- `gradeLimits`: exactly A, B, C, growing (else **422 `GRADE_LIMITS`**). `pointTable` keys are capital letters / digits, each once (**422 `POINT_TABLE`**). `basis`: `METER` or `SQ_YARD`. `maxPointsPerMeter`: a number, or `null` for no cap.
- A change does **not** change finished inspections (they keep the rules they were finished with). Drafts show the new rules.

### Defect list: `GET /inspection/defect-types?all=true` (VIEW; without `all` only the active ones)
`{ "data": [ { "id": "…", "code": "HOLE", "name": "Hole / tear", "fixedPoints": 4, "isActive": true } ] }`
- `POST /inspection/defect-types/standard` (client admin): adds the **20 usual textile defects** the company does not have yet (Hole, Oil stain, Dirt stain, Slub, Knot, Thick / Thin place, Missing end / pick, Broken end, Reed mark, Weft bar, Float, Selvedge, Shade variation, Dyeing patch, Colour stain, Print defect, Crease mark, Bowing / skewing). Answer: `{ "added": 20, "data": [...] }`. Running it again adds 0.
- `POST /inspection/defect-types` `{ "code": "X1", "name": "Loom oil line", "fixedPoints": null }` (201); `PATCH /inspection/defect-types/:id` (`name`, `code`, `fixedPoints`, `isActive`); `DELETE` (only a defect never used, else **422 `IN_USE`**: switch it off). `NAME_TAKEN` for a used name or code.

## 4. Pick the thaan: `GET /api/v1/inspections/thaans?lotNo=101` (`&source=GREY|DEPARTMENT` optional)
```json
{ "lotNo": 101, "data": [
  { "source": "GREY", "thaanId": "…", "thaanNo": 1, "lotNo": 101, "meters": 215, "width": 58, "customerName": "AZ", "qualityName": "PC TWILL", "departmentName": null, "jobNo": null,
    "latest": null, "draft": null },
  { "source": "DEPARTMENT", "thaanId": "…", "thaanNo": 1, "meters": 110, "departmentName": "Dyeing", "jobNo": 12, "soNo": 4, "operatorName": "Aslam", "machines": "DYE-01",
    "latest": { "inspectionId": "…", "label": "INS-00003", "grade": "B", "pointsPer100": 25.45, "suggestedFoldingGrade": "b" }, "draft": null } ] }
```
- `latest`: the grade of the latest **finished** inspection of that thaan (or null). `draft`: an open draft (go to it instead of creating a new one).

## 5. Inspections: `/api/v1/inspections`
### List `GET /inspections` (VIEW)
Query: `page`, `limit` (max 200), `search` (customer, quality, operator, lot or inspection number), `status` (`DRAFT`/`FINISHED`), `grade` (`A`,`B`,`C`,`REJECT`), `lotNo`, `thaanNo`, `customerId`, `qualityId`, `departmentId`, `source`, `dateFrom`, `dateTo`.
`{ data: [ { id, label, inspectionNo, inspectionDate, source, status, statusText, lotNo, thaanNo, meters, widthInches, customer, quality, department, jobNo, soNo, operatorName, machines, inspector: { id, name }, defectCount, totalPoints, pointsPer100, grade, finishedAt, thaanExists } ], page, limit, total }`

### Start `POST /inspections` (FULL) → 201
`{ "source": "GREY", "thaanId": "…", "inspectionDate": "2026-11-26", "widthInches": 58, "remarks": "" }` — date optional (today; **not a future date**), width optional (taken from the thaan).
Errors: **422 `DRAFT_EXISTS`** (open the draft instead), 404 (thaan not found).

### One `GET /inspections/:id` (VIEW)
```json
{ "id": "…", "label": "INS-00001", "status": "DRAFT", "lotNo": 101, "thaanNo": 1, "meters": 215, "widthInches": 58, "...": "...",
  "preview": true, "rawPoints": 6, "totalPoints": 6, "pointsPer100": 2.79, "grade": "A", "suggestedFoldingGrade": "a", "defectCount": 3,
  "rules": { "pointTable": [ … ], "gradeLimits": [ … ], "basis": "METER", "maxPointsPerMeter": 4 },
  "defects": [ { "lineNo": 1, "defectTypeId": "…", "code": "OIL", "name": "Oil stain", "atMeter": 12, "sizeClass": "S1", "points": 1, "note": null } ],
  "inspector": { "name": "Ali" }, "finishedAt": null, "finishedBy": null, "reopened": null,
  "canEdit": true, "canFinish": true, "canDelete": true, "canReopen": false, "thaanExists": true }
```
- `rawPoints` is the plain sum; `totalPoints` is after the 4-per-meter cap. A draft is `preview: true` (today's rules); a finished one keeps its `rules`.
- `thaanExists: false`: the department wrote its thaans again after this inspection (the old thaan is gone). Show a note "this thaan was changed after the inspection". Inspect the new thaan.

### Save the defects `PUT /inspections/:id/defects` (FULL): **the whole list replaces the old one**
`{ "defects": [ { "defectTypeId": "…", "atMeter": 12, "sizeClass": "S1", "note": "" } ] }` (max **300**; **never send points**: 400)
Errors: **422 `BEYOND_THAAN`** (`atMeter` longer than the thaan, `details: { line, field: "atMeter", meters }`), **`UNKNOWN_SIZE`**, **`DEFECT_INACTIVE`**, 404 (unknown defect).

### Other actions
- `PATCH /inspections/:id` (draft): `inspectionDate`, `widthInches` (null clears), `remarks`.
- `POST /inspections/:id/finish` (FULL): fixes points and grade. **422 `WIDTH_REQUIRED`** when the company counts per square yard and the width is empty. A thaan with **no defects** can be finished (0 points, grade A).
- `POST /inspections/:id/reopen` (**client admin**) `{ "reason": "a defect was missed" }` (5–300 chars). **422 `NOT_FINISHED`**, **`DRAFT_EXISTS`**.
- `DELETE /inspections/:id` (draft only) `{ "reason": "opened by mistake" }` → 204. It stays in the database and its number is never used again.
- A finished inspection: edit / finish / delete answer **422 `INSPECTION_FINISHED`**.

## 6. Folding, Packing and Dispatch: show the grade (nothing else changed)
A thaan that has a **finished** inspection now carries `inspection` (a thaan without one has **no** such key):
```json
"inspection": { "inspectionId": "…", "inspectionNo": 3, "label": "INS-00003", "grade": "B", "pointsPer100": 25.45, "suggestedFoldingGrade": "b" }
```
| Screen | Where |
|---|---|
| Folding rows and the folding of an SO card (`GET /departments/FOLDING/folding…`) | each line: `lots[].lines[].inspection` |
| Packing: SO card form | `lots[].thaans[].inspection` |
| Packing list (view / save / final / gate pass answer) | `lots[].thaans[].inspection` |
- **Folding**: next to the grade boxes show a badge "Inspection: B (25.45)" and highlight the suggested box (`suggestedFoldingGrade`: `a`, `b`, `cp`; C and Reject suggest CP). **Never fill the boxes by itself: the folder chooses.**
- **Packing / gate pass**: show the badge beside the thaan. A Reject thaan can be shown red. It does not block anything.

## 7. The summary report: `GET /api/v1/reports/inspection-summary`
Reports menu key `inspection-summary` (INSPECTION). Query: `dateFrom`, `dateTo` (inspection date), `customerId`, `qualityId`, `departmentId`, `export=true`.
Counts **finished** inspections only; a thaan inspected again counts **once** (the latest). Answer: the usual report shape with **four sections** and `overall: { thaans, meters, avgPointsPer100 }`:
1. `grades` — grade (A, B, C, Reject), thaans, thaans %, meters, meters %.
2. `defects` — **top defects**: defect, times, thaans, points, points % (most points first).
3. `qualities` — by quality: thaans, meters, points, **average points per 100 (weighted by meters)**, A, B, C, Reject.
4. `makers` — by **department, operator and machine** ("Grey cloth" for grey thaans). The weaver of grey cloth is not known.

## 8. The screens (suggested)
**Menu "Fabric inspection"** (only users with INSPECTION and the client admin):
1. **List**: search + filters (status, grade, lot, thaan, date, customer, quality); table: no, date, lot, thaan, meters, customer, quality, department, inspector, points per 100, grade (colour badge), status.
2. **New inspection** (fast, made for the inspection table, tablet friendly):
   - Step 1: type the **lot number** → list of thaans (grey and department ones, with their last grade) → pick one → shows meters and width.
   - Step 2: **defect entry grid**: big buttons / dropdown of the defect, a **meter** box, size buttons (S1–S4), Enter adds a row and jumps back to the meter box. Points appear at once.
   - A **live total bar** at the top: points, points per 100, grade (same maths as section 2).
   - **Save draft** (`PUT …/defects`) often (also auto-save), then **Finish** with a confirmation "cannot be changed after finish".
   - For a finished one: read only, with a **Reopen** button (client admin, asks the reason).
3. **Settings** (client admin): point table (labels and points), grade limits, basis (meter / square yard), cap per meter; the **defect list** with "Load the usual textile defects" and add / switch off.
4. **Summary report**: filters + the four tables, a grade pie, a bar chart of the top defects, export to Excel (`export=true`).
- Disable buttons while a request runs; show the four states (loading, empty, error with retry, data).

## 9. Quick checks ("Done when")
1. The same thaan gives the same points on the screen preview and the server.
2. 215 m with 1+2+3 points → 2.79, grade A; a defect at 215.5 m is refused; two defects on one meter count at most 4.
3. A finished inspection cannot be changed; only the client admin reopens it, with a reason; the audit log shows it.
4. Changing the grade limits does not change finished inspections.
5. Folding shows the badge on the inspected thaan only; the grade boxes stay empty until the folder fills them.
6. The summary shows the grade split and the top defects for the chosen period.
7. A user without INSPECTION cannot open it (403); another company sees nothing.
