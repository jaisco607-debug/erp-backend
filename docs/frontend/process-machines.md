# Process Management: Machines (Settings > Machines), machines on jobs, thaans of the departments — Frontend Guide

Three things in one guide:
1. **Settings > Machines** (client admin): which process departments (Dyeing, Stitching ...) have machines; add, rename, switch off and delete machines. Machine names are unique: `PREFIX-NN` (`DYE-01`, `STI-03`).
2. **Work on machines** (department people): an accepted job is put on a machine with the operator's name; meters came (in) and meters made (out); machines free / running; reports per machine and per operator.
3. **Thaans of the departments**: every department writes the thaans it made from the cloth (joined 10 → 1, split 1 → 5, with their meters). The next department receives exactly those thaans **and their meters**.

Only **process departments** (`kind: "PROCESS"`: Dyeing, Stitching, own processes ...) have machines. Folding and Packing do not.

---
## 1. Settings > Machines (client admin only; others get 403)
Base `/api/v1/machine-settings`.

### The tab: `GET /machine-settings`
```json
{ "data": [ { "id": "…", "code": "DYEING", "name": "Dyeing", "machinesEnabled": false, "prefix": null, "suggestedPrefix": "DYE",
              "machineCount": 0, "activeCount": 0, "runningCount": 0, "freeCount": 0, "canChangePrefix": true, "canDisable": true } ] }
```
- One row per **process department** the company has (renamed processes show the new name). At first every department is OFF: only the departments and their **Machines** switch.
- Switch: `PATCH /machine-settings/:code` `{ "machinesEnabled": true }` → the same list again. Turning ON the first time gives the department its **prefix** (`prefix`, e.g. `DYE`; `suggestedPrefix` shows it before). Turning OFF is refused while a machine is running (422 `MACHINES_RUNNING`); nothing is deleted, turning it ON again brings the machines back.
- **Prefix:** made from the first letters of the department name (Dyeing `DYE`, Stitching `STI`; a longer one or a number when another department already has it). The client admin can **change it at any time**: `PATCH /machine-settings/:code` `{ "prefix": "DYG" }` (2–6 letters/numbers, starts with a letter; capitals) — **all machines of the department are renamed** (`DYE-03` → `DYG-03`) and their history follows. Errors: 422 `BAD_PREFIX`, 422 `PREFIX_TAKEN` (another department has it). Prefixes are unique in the company, so **no two machines of the company can have the same name**, even in different departments.
- Click a department → its machines.

### Machines of a department
- `GET /machine-settings/:code/machines` → `{ department, machinesEnabled, prefix, counts: { total, active, free, running, disabled }, data: [ machine ] }`.
```json
{ "id": "…", "number": 1, "name": "DYE-01", "notes": null, "isActive": true, "state": "FREE", "stateText": "Free",
  "current": null, "totals": { "runs": 3, "inMeters": 4100, "outMeters": 4020, "operators": 2 }, "todayInMeters": 0, "canDisable": true, "canDelete": true, "canRename": true }
```
  `state`: `FREE`, `RUNNING` (`current` has the run) or `DISABLED`.
- **Add machines:** `POST /machine-settings/:code/machines` `{ "count": 5, "notes": "Jet dyeing" }` → 201 the list. The server makes the names `DYE-01`, `DYE-02` ... (the next numbers of the department; numbers are never reused). Only when the department's machines are ON (else 422 `MACHINES_OFF`). `count` 1–100 (default 1). Show a number box "How many machines" and "Add".
- **Edit a machine:** `PATCH /machine-settings/machines/:id` with any of
  - `{ "name": "DYE-B7" }` — rename: the name must be the department's prefix + `-` + 1 to 10 letters or numbers (`DYE-B7`, `DYE-12`); it is changed to capitals. 422 `BAD_NAME` (wrong form, `message` shows an example), 422 `NAME_TAKEN` (another machine of the company has it).
  - `{ "notes": "…" }` — a note (max 200).
  - `{ "isActive": false }` — switch the machine off (or `true` = on again): a switched-off machine gets no work; 422 `MACHINE_RUNNING` while it runs a job.
  → answer = the machines list of its department. Use an **Edit** button (dialog with name + note + active switch) on every machine row.
- **Delete:** `DELETE /machine-settings/machines/:id` → the machines list. A machine **with history can be deleted too**: it leaves every list, but its earlier runs stay in the reports under its name. 422 `MACHINE_RUNNING` while it runs a job (`canDelete` false). Ask "Delete DYE-03? Its earlier work stays in the reports." A deleted machine's name stays reserved.

---
## 2. In the department: the machines board
`GET /api/v1/departments/:code/machines?dateFrom=&dateTo=` (VIEW access to the department). `dateFrom` / `dateTo` limit the `totals` of every machine (all time when not sent).
```json
{ "department": { "id": "…", "code": "DYEING", "name": "Dyeing" }, "enabled": true, "prefix": "DYE",
  "counts": { "total": 12, "active": 11, "free": 4, "running": 7, "disabled": 1 }, "operatorsWorking": 6,
  "working": [ { "machine": "DYE-01", "operatorName": "Aslam", "jobNo": 45, "soLabels": ["120"], "inMeters": 1200 } ],
  "machines": [ { "id": "…", "name": "DYE-01", "state": "RUNNING", "stateText": "Running",
                  "current": { "id": "runId", "job": { "id": "…", "jobNo": 45, "status": "PROCESSING" }, "soLabels": ["120"], "operatorName": "Aslam", "inMeters": 1200, "status": "RUNNING", "startedAt": "…", "minutesRunning": 95 },
                  "totals": { "runs": 12, "inMeters": 15400, "outMeters": 15120, "operators": 3 }, "todayInMeters": 1200 } ] }
```
- Hide the tab / board when `enabled` is false (the client admin did not switch machines on for this department).
- Pills: Total / Free / Running / Off (`counts`), "Operators working" (`operatorsWorking`). A card or row per machine with a coloured state (Free green, Running blue, Off grey), and for a running one: job no, SO card(s) (`current.soLabels`), operator, meters, "running for `minutesRunning` min". `totals` = what the machine processed (runs, meters in, meters made, how many different operators).
- `working` = the list "who is working on what" (one line per running machine).

---
## 3. Putting a job on a machine
Rules: the job must be **accepted** (Pending / Processing). The cloth may go on **one machine** (all of it) or be **split on several machines** (meters on each); a machine runs **one job at a time**; the same machine can run another job after it is finished. Putting a job on a machine makes the job **Processing** and, when the job has no operator yet, the operator of the first run becomes the job's operator (and the process date = today).

### The runs of a job: `GET /departments/:code/jobs/:jobId/machines`
```json
{ "enabled": true, "job": { "id": "…", "jobNo": 45, "status": "PROCESSING", "totalMeters": 2200, "soLabels": ["120", "121"] },
  "assignedMeters": 1200, "remainingMeters": 1000, "madeMeters": 0, "runningRuns": 1, "canAssign": true, "sentOn": false,
  "runs": [ { "id": "…", "machine": { "id": "…", "name": "DYE-01" }, "job": { "id": "…", "jobNo": 45, "status": "PROCESSING" }, "operatorName": "Aslam",
              "inMeters": 1200, "outMeters": null, "lossMeters": null, "status": "RUNNING", "statusText": "Running", "runDate": "2026-11-23", "startedAt": "…", "finishedAt": null, "notes": null } ] }
```
Show it in the job's row (a "Machines" button / panel): the runs, "On machines 1,200 of 2,200 m · 1,000 m left", and the button **Put on machine** while `canAssign`.

### Put on a machine: `POST /departments/:code/jobs/:jobId/machines` (FULL access)
Body `{ "machineId": "…", "operatorName": "Aslam", "meters": 1200, "notes": "" }` → 201 the same answer as above.
- `meters` is optional: when not sent, **all the cloth that is not on a machine yet** goes (`remainingMeters`). Pre-fill it with `remainingMeters`.
- The machine dropdown: `GET /departments/:code/machines` → offer only `state: "FREE"` machines.
- Operator name box: suggestions from `GET /departments/:code/machine-operators` → `{ data: ["Aslam", "Bilal"] }` (names used before). Required, 2–80 characters.
- Errors (show the plain `message` in a toast): 422 `MACHINES_OFF` (the department does not use machines), `JOB_NOT_ACCEPTED` (accept the job first), `JOB_CLOSED`, `ALREADY_SENT_ON`, `UNKNOWN_MACHINE`, `MACHINE_OFF`, `MACHINE_BUSY` (`details`: jobNo, operatorName of the job on it), `NOTHING_LEFT` (all the cloth is on machines), `OVER_ASSIGNED` (`details.remainingMeters`).

### Finish: `POST /departments/:code/machine-runs/:runId/finish` (FULL)
Body `{ "outMeters": 1150, "operatorName": "Aslam", "notes": "" }` (`outMeters` required = the cloth made; `operatorName` / `notes` optional). The machine is free again. Answer = the runs of the job. The run shows `lossMeters` = in − out. Dialog: "Cloth came 1,200 m · Cloth made [ ] m".
- 422 `RUN_DONE` (already finished), `ALREADY_SENT_ON`.
- **A job cannot be set to Complete while one of its runs is still running** (`PUT .../status` → 422 `MACHINE_STILL_RUNNING`): finish the runs first.

### Correct / delete a run (until the cloth is sent on)
- `PATCH /departments/:code/machine-runs/:runId` `{ operatorName?, inMeters?, outMeters?, notes? }` (`outMeters` only on a finished run) → the runs of the job. 422 `OVER_ASSIGNED`, `RUN_RUNNING`, `ALREADY_SENT_ON`.
- `DELETE /departments/:code/machine-runs/:runId` → the runs of the job (a run entered by mistake).

### On the job lists
`GET /departments/:code/incoming` (Job Wise and SO Wise rows) and `GET /jobs/:id` rows have **`machines`**: `[ { id, machine: { id, name }, operatorName, inMeters, outMeters, status } ]` (empty when none). Show "DYE-01 · Aslam" in a Machine column (several machines: a chip each). The job's `operatorName` is the first operator.

---
## 4. Reports: machines, operators
`GET /departments/:code/machine-report?dateFrom=&dateTo=&machineId=&operator=` (VIEW). `dateFrom` / `dateTo` are the run dates; `machineId` and `operator` (the name, any letters case) narrow the report.
```json
{ "department": {…}, "dateFrom": null, "dateTo": null,
  "totals": { "runs": 14, "jobs": 9, "inMeters": 18200, "outMeters": 17850, "lossMeters": 350, "running": 2 },
  "byMachine":  [ { "key": "machineId", "name": "DYE-01", "runs": 5, "jobs": 5, "running": 0, "inMeters": 6200, "outMeters": 6100, "lossMeters": 100, "operators": ["Aslam", "Bilal"] } ],
  "byOperator": [ { "key": "aslam", "name": "Aslam", "runs": 6, "jobs": 5, "running": 1, "inMeters": 7400, "outMeters": 7300, "lossMeters": 100, "machines": ["DYE-01", "DYE-03"] } ],
  "runs": [ { "id": "…", "machine": {…}, "job": { "jobNo": 45 }, "soLabels": ["120"], "operatorName": "Aslam", "inMeters": 1200, "outMeters": 1150, "lossMeters": 50, "status": "DONE", "runDate": "2026-11-23", "startedAt": "…", "finishedAt": "…" } ], "runCount": 14 }
```
Two tables: **By machine** (how much cloth each machine processed and which operators ran it) and **By operator** (how much each operator processed, on how many machines), plus the list of runs (newest first, at most 500; `runCount` is the full number). Operators are the same person when the name matches without regard to letters case and spaces. `inMeters` = cloth that came to the machine, `outMeters` = cloth made (finished runs only), `lossMeters` = in − out of the finished runs. Deleted machines stay in the report under their name.

---
## 5. Thaans of the departments
**Idea:** the lot has 10 thaans. Stitching joins them into 1 thaan; the next department turns that 1 thaan into 5 thaans and writes their meters; the next one receives these 5 thaans ... Folding receives the last ones.
- **Input** = the thaans the department received: the thaans the sending department wrote (**output** of that department), or, for cloth that came straight from the SO card, the thaans of the SO card line.
- **Output** = the thaans the department made: typed by the department, after it accepted the job, until the cloth is sent on.
- **The meters follow the thaans.** When a department wrote its thaans and sends the cloth on, **the next department's job gets the total meters of those thaans** (the send window `send-form` rows already show them as `meters`). Example: Dyeing received 220 m, made 1 thaan of 215 m → Finishing's job is 215 m, 1 thaan. A department that wrote no thaans passes its cloth on with its meters unchanged.
- The difference (received − made) is the department's **process loss** (`lossMeters`; negative = gain). In the department ledger report (`/reports/ledgers/department`) it is a line of its own: **"Process loss (thaans)"** / "Process gain (thaans)" next to "Received" and "Sent on", so the balance of the department stays right (nothing is left over in the department).
- Only process departments write thaans.

### The screen: `GET /departments/:code/jobs/:jobId/thaans`
```json
{ "job": { "id": "…", "jobNo": 45, "status": "PROCESSING", "totalMeters": 220 }, "canEdit": true,
  "items": [ { "jobItemId": "…", "soCard": { "id": "…", "cardNo": 120, "cardLabel": "120" }, "customer": { "name": "AZ", "code": 130 }, "lotNo": 15, "meters": 220,
               "input":  { "source": "SO_CARD", "from": null, "thaans": [ { "thaanNo": 1, "meters": 100 }, { "thaanNo": 2, "meters": 120 } ], "count": 2, "meters": 220 },
               "output": { "thaans": [ { "thaanNo": 1, "meters": 215 } ], "count": 1, "meters": 215, "recorded": true },
               "lossMeters": 5, "sentOn": false, "canEdit": true } ] }
```
One block per cloth line (SO card line) of the job, so each party's cloth stays separate. `input.source` is `SO_CARD` or `DEPARTMENT` (then `input.from` = `{ jobItemId, jobNo, department }`: "from Dyeing, Job# 45"). Show **Came** (left: count and meters, the list of thaans) and **Made** (right: an editable list of meters, "+ Add thaan", the count and total meters below, and the difference `lossMeters`; a hint "The next department will get <total> m").

### Save: `PUT /departments/:code/jobs/:jobId/thaans` (FULL)
Body `{ "items": [ { "jobItemId": "…", "thaans": [43, 43, 43, 43, 43] } ] }` — the thaans of each line **replace** the earlier list; the thaan numbers are 1..n in the order sent; `[]` clears the line. Each entry is a number (meters) or `{ "meters": 43 }`. Answer = the same as GET. Up to 500 thaans a line; each above 0. Allowed from Accept (Pending / Processing / Complete) until the line is sent on. Errors: 422 `JOB_NOT_ACCEPTED`, `JOB_CLOSED`, `ALREADY_SENT_ON` (`details.jobItemId`), `UNKNOWN_ITEM`, `BAD_METERS`, `TOO_MANY_THAANS`, 400 for a wrong body.

### What the next department sees
On every job row (Incoming, Job Wise and SO Wise, and `GET /jobs/:id`):
- `thaans` / `thaanCount` = the thaans the department **received** (the earlier department's output when it wrote one, else the SO card thaans) — so the existing "Thaans" column and the thaan pop-up show the right thing without any change. `totalMeters` / `meters` = the meters of those thaans.
- Per cloth line (`items[]`, Job Wise): `inputThaans`, `inputThaanCount`, `inputMeters`, `inputFrom` (`{ jobNo, department }` or null), `outputThaans`, `outputThaanCount`, `outputMeters`, `thaansRecorded` (true when this department wrote its output). Job: `outputThaanCount`.
- SO Wise rows: `inputThaanCount`, `outputThaans`, `outputThaanCount`, `outputMeters`, `thaansRecorded`.
- A department that did not write thaans passes on what it received: the next one sees the nearest earlier department's thaans.

### Folding grades the thaans the departments made
When the cloth of a Folding job passes through departments that wrote thaans, **Folding grades those thaans** (no change in the screens or calls): each lot of the Folding row (`GET /departments/FOLDING/folding`, `.../folding/:jobId/:soCardId`) lists the thaans the last department made instead of the grey lot thaans.
- `lots[].lines[]` = one line per thaan, same fields as before: `thaanId`, `thaanNo`, `label` ("Thaan 3"), `received` (its meters), `a`, `b`, `cp`, ... **New field `source`**: `"DEPARTMENT"` (a thaan a department made), `"GREY"` (a grey lot thaan, as before) or `"LOT"` (a lot without thaans: one "Whole lot" line). For a department thaan **`thaanId` is the id of that thaan** — send it back unchanged in `PUT .../grades` `{ lines: [ { greyLotId, thaanId, a, b, cp } ] }`. Nothing else changes: save, Send to Packing, close, confirm work as before.
- `lots[].hasThaans` / `thaanCount` count these thaans; `lots[].received` = their total meters = the meters of the Folding job.
- `receivedThaans` (row level, new): `[ { jobItemId, lotNo, from: { jobNo, department }, thaans: [ { thaanNo, meters } ], count, meters } ]` for the top box "Received from Finishing: 5 thaans, 215 m". Empty when no department wrote thaans (the grey lot thaans are then graded, as before).
- The Folding thaan list can be built only from what the department wrote; if the earlier department wrote its thaans again after Folding already graded them, 422 `THAANS_GRADED` (on `PUT /departments/:code/jobs/:jobId/thaans`).

### Packing lists per thaan (also the departments' thaans)
`GET /departments/PACKING/packing/so-cards/:soCardId/form` — each lot has a new **`source`**: `"DEPARTMENT"` when Folding graded thaans the departments made (the lot is then packed per those thaans, `lots[].thaans[]` = those thaans: `thaanId`, `thaanNo`, `meters`, `folding` {a,b,cp}, `suggestedLines`, `packed`, `alreadyPacked`), else `"GREY"` (as before).
- Only the thaans Folding graded are offered, with the A / B / CP meters Folding sent as `suggestedLines`; nothing else changed in the form.
- `POST / PUT /departments/PACKING/packing-lists` `{ lines: [ { greyLotId, thaanId, grade, meters } ] }`: for a department lot send the **`thaanId` of the form** (the department thaan). Same checks as before: 422 `THAAN_REQUIRED` (the lot has thaans: choose one), `UNKNOWN_THAAN` (not a thaan of this lot — e.g. a grey lot thaan on a lot that is packed per department thaans), `DUPLICATE_THAAN`, `THAAN_ALREADY_PACKED`, `MORE_THAN_FOLDING_SENT`.
- The packing list answer (`lots[].thaans[]`: `lineNo`, `thaanId`, `thaanNo`, `grade`, `meters`, `rate`, `amount`), the summaries, the PDF data, the gate pass, the sales invoice and the reports are unchanged: they add up the meters per lot and grade.
- A packing list line of a department thaan has a `thaanNo` = the number the department gave it (1..n of its cloth line).

---
## Errors summary
| Code | Where | Meaning |
|---|---|---|
| 403 | `/machine-settings/*` | the person is not the client admin |
| 422 `MACHINES_OFF` | add machines, put on a machine | the department's machines are switched off |
| 422 `MACHINES_RUNNING` | switch a department OFF | machines are running |
| 422 `BAD_PREFIX`, `PREFIX_TAKEN` | prefix | see section 1 |
| 422 `BAD_NAME`, `NAME_TAKEN` | rename a machine | see section 1 |
| 422 `MACHINE_RUNNING` | switch off / delete a machine | it runs a job |
| 422 `JOB_NOT_ACCEPTED`, `JOB_CLOSED`, `ALREADY_SENT_ON` | machines, thaans | wrong state of the job |
| 422 `UNKNOWN_MACHINE`, `MACHINE_OFF`, `MACHINE_BUSY`, `NOTHING_LEFT`, `OVER_ASSIGNED` | put on a machine | see section 3 |
| 422 `RUN_DONE`, `RUN_RUNNING` | finish / edit a run | |
| 422 `MACHINE_STILL_RUNNING` | job status Complete | finish the machine runs first |
| 422 `UNKNOWN_ITEM`, `BAD_METERS`, `TOO_MANY_THAANS`, `THAANS_GRADED` | thaans | Folding already graded them |
| 422 `THAAN_REQUIRED`, `UNKNOWN_THAAN`, `MORE_THAN_FOLDING_SENT` | packing list | see Packing lists per thaan |

## Database
Migration `20270108000001-department-machines.js`: `company_services.machines` / `machinePrefix`, tables `machines`, `machine_runs`, `job_item_thaans`. Migration `20270109000001-folding-department-thaans.js`: `folding_lines.deptThaanId`, `packing_list_lines.deptThaanId` (and the unique index of `folding_lines`). Run `npm run db:migrate`.

### The thaan journey (SO card -> departments -> Folding -> categories)
Where it comes from: how many thaans the SO card had, how many each department received and made of them, what Folding received and how Folding turned them into thaans of A / B / CP.

**1. Folding row** (`GET /departments/FOLDING/folding`, `.../folding/:jobId/:soCardId`, and the answer of `PUT .../grades`):
- `journey[]` (one per cloth line / lot):
  `{ jobItemId, lotNo, original: { thaans, meters }, received: { thaans, meters }, steps: [ { jobItemId, jobNo, department, status, isCurrent, in: { thaans, meters }, out: { thaans, meters } | null, converted: "10 -> 1" | null } ] }`
  - `original` = the SO card (grey lot) thaans of the lot (`thaans` is null when the lot has no thaans).
  - `steps` = every department the cloth passed, first to last; the last step is Folding itself (`isCurrent: true`).
  - `in` = thaans / meters the department received; `out` = the thaans it made (null when it wrote none: nothing changed); `converted` = text for the screen, e.g. "10 -> 1" (Stitching) then "1 -> 5" (Finishing).
  - `received` = what Folding received = the output of the last department that wrote thaans (e.g. 5 thaans, 215 m).
- `lots[].byGrade` = what Folding made of the lot per category: `{ a: { thaans, meters }, b: {...}, cp: {...} }`, `lots[].gradedThaans` = thaans graded. Updates after every grading save. A thaan graded in two categories (A 40 + CP 3) counts in each.
- Suggested screen: top box "SO card: 30 thaans, 1000 m" -> chips per department "Dyeing 30 -> 12", "Finishing 12 -> 5" -> "Folding received 5 thaans, 215 m" -> "Folding: A 5 thaans 212 m, CP 1 thaan 3 m".

**2. Packing form** (`GET /departments/PACKING/packing/so-cards/:soCardId/form`): every `lots[]` has `journey` = the same object plus `foldingGrades: { a, b, cp, total: { thaans, meters } }` (null when Folding graded nothing). The lines and the list itself did not change (Packing stays per thaan and category as above).

**3. Reports** (`GET /reports/so-cards/:id`): a new section `key: "thaanTrail"` ("Thaans: how they changed"), rows `{ lotNo, stage, jobNo, thaansIn, metersIn, thaansOut, metersOut, change }`: first row stage "SO card", then one row per department (`change` = "10 -> 1"), last row stage "Folding graded" (`thaansIn/metersIn` = what Folding received, `thaansOut/metersOut` = graded, `change` = "A 5 thaans 212 m, B 0 thaans 0 m, CP 1 thaans 3 m"). It is a normal report section (table + export), the other sections did not change.
No migration, no new route. Gate pass, sales invoice and other reports are unchanged (they add up meters per lot and grade).
