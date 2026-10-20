# Step 6 – Folding (frontend guide)

Base URL `/api/v1`, header `Authorization: Bearer <accessToken>`. Errors: `{ "error": { "code", "message" } }`.
The folding department code is `FOLDING` (get it from `GET /departments`: the department with `kind: "FOLDING"`; never hardcode, use its `code`).

## What Folding does
1. Cloth arrives in Folding from ANY department as a job (same Incoming list as every department).
2. The folder grades each SO card of the job into **A**, **B** and **CP** (cut piece) meters and writes the register page no.
3. NO limit: the graded total may be less (wastage, shrink) or more (stitching) than what arrived. DIFF shows the difference.
4. If the cloth is not right, Folding sends it back to ANY department (even one it never went to, e.g. Bleaching) – it becomes **RE-WORK**. It stays RE-WORK through every department until it comes back to Folding, where it gets a NEW row (new Job#) and is graded again.

## Screen 1: Folding grading (the picture with A / B / CP)
`GET /departments/FOLDING/folding?tab=all|draft&search=&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&page=1&limit=25`
- `search` = Job# or SO# (digits). Tabs: **All**, **Draft** (show `draftCount` as a badge).
- Response: `{ data: [row], draftCount, total, page, limit }`. One row = one SO card inside one folding job.
```json
{ "jobId": "…", "jobNo": 14, "pageNo": "12",
  "soCard": { "id": "…", "cardNo": 3, "idNo": 7 }, "jobDate": "2026-10-14",
  "customer": { "id": "…", "code": 130, "name": "AZ TEXTILES" }, "quality": "16X10 PC TWILL", "colour": "BLACK",
  "soQnty": 9639,
  "stock": { "a": 9525, "b": 34, "cp": 70, "total": 9629 },
  "diff": 10, "diffPercent": 0.1, "inStock": 9629,
  "isConfirmed": false, "isEntered": true,
  "isRework": false, "isReprocess": false,
  "sentForRework": false, "sentBackTo": null,
  "jobStatus": "PENDING" }
```
| Column | Field |
|---|---|
| JOB# | `jobNo` |
| PAGE# | `pageNo` (editable text, "0" when empty) |
| SO# | `soCard.cardNo` |
| DATE | `jobDate` (show 14-Oct-26) |
| CUSTOMER NAME | `customer.name (customer.code)` |
| QUALITY | `quality` |
| COLOUR | `colour` |
| SO-QNTY | `soQnty` (meters that arrived) |
| STOCK A / B / CP | `stock.a`, `stock.b`, `stock.cp` (editable number inputs) |
| Total | `stock.total` |
| DIFF | `diff` (can be negative = more than arrived) |
| %AGE | `diffPercent` |
| InStock | `inStock` |
| Conf. | `isConfirmed` toggle |

Badges: `isRework` → orange **RE-WORK**; `isReprocess` → **RE-PROCESS**; `sentForRework` → grey row with text "Sent back to {sentBackTo}" (this cloth left Folding; its InStock is 0; it will come back as a new row).

### Save A / B / CP (row stays Draft)
`PUT /departments/FOLDING/folding/:jobId/:soCardId` body (send only what changed):
`{ "pageNo": "12", "a": 9525, "b": 34, "cp": 70 }` → returns the updated row.
Numbers ≥ 0, 2 decimals. No check against SO-QNTY. Save on blur or with a Save button per row.
Error `ROW_CONFIRMED` → row is confirmed; switch Conf. off first.

### Conf. toggle
`PUT /departments/FOLDING/folding/:jobId/:soCardId/confirm` body `{ "isConfirmed": true }` (or false) → returns the row.
Confirmed rows are locked (inputs disabled) and leave the Draft tab. Error `NOTHING_GRADED` = A+B+CP is 0.

## Screen 2: Incoming / status (same as every department)
- `GET /departments/FOLDING/incoming?view=job|so` – jobs that arrived; `fromDepartmentName` shows where from; `isRework` badge.
- Status dropdown: `PUT /departments/FOLDING/jobs/:jobId/status` `{ "status": "PROCESSING" | "COMPLETE" | "PENDING" }`.
- Reject (cloth not received): `POST /departments/FOLDING/jobs/:jobId/reject` `{ "reason": "" }` – only when `canReject`.
- Grading (Screen 1) can be done at any status; to SEND cloth back for re-work the job must be **COMPLETE** first.

## Screen 3: Send back for RE-WORK
1. `GET /departments/FOLDING/send-form` →
```json
{ "nextJobNo": 15,
  "departments": [ { "id": "…", "code": "BLEACHING", "name": "Bleaching", "kind": "PROCESS", "tracksColour": true } ],
  "colours": [ { "id": "…", "name": "BLACK" } ],
  "rows": [ { "jobItemId": "…", "job": { "jobNo": 14, "jobDate": "2026-10-14", "colour": "BLACK" },
              "soCard": { "id": "…", "cardNo": 3, "idNo": 7 }, "customer": { "code": 130, "name": "AZ TEXTILES" },
              "quality": "16X10 PC TWILL", "lotNo": 22, "isReprocess": false, "meters": 9639 } ] }
```
   Rows = cloth in COMPLETE folding jobs that has not been sent anywhere yet. Show a checkbox per row.
2. User ticks rows, picks the department (dropdown – ALL departments, also ones the cloth never visited), optional colour (show only if that department's `tracksColour`), optional "sent through".
3. `POST /departments/FOLDING/send`
```json
{ "toDepartmentCode": "BLEACHING", "colourId": null, "sentThrough": "Rickshaw", "remarks": "colour not right",
  "items": [ { "jobItemId": "…" } ] }
```
   → 201 with the new job: `isRework: true`, `toDepartmentName`, `jobNo`.
   The whole row's meters go (no partial meters).
4. That job appears in the receiving department's Incoming with the RE-WORK badge. When it is completed and sent on, every next job stays `isRework: true`, also when it reaches Folding again.

Folding's own Sent / Rejected tabs: `GET /departments/FOLDING/sent`, `GET /departments/FOLDING/rejected` (same as other departments).

## History of one SO card (all departments, first pass and re-work)
`GET /jobs/so-card/:soCardId` → `{ jobs: [ … ] }` in order, each with `jobNo`, `department`, `fromDepartment`, `status`, `isRework`, `totalMeters`, `chemicalAmount`, `costPerMeter`.
Use it for an "SO card journey" popup. `chemicalAmount` / `costPerMeter` are 0 until the chemical step; then every job (first pass AND re-work) will carry its own chemical cost per department, so re-work cost is visible separately.

## Error codes
| code | meaning |
|---|---|
| NOT_FOLDING | that department is not a folding department |
| ROW_CONFIRMED | switch Conf. off first |
| NOTHING_GRADED | enter A/B/CP before Conf. |
| NOTHING_LEFT | row already sent or job not COMPLETE |
| SAME_DEPARTMENT | cannot send to Folding itself |
| FORBIDDEN (403) | user lacks FULL access to Folding |
