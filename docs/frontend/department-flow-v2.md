# DEPARTMENTS v2: In-Way / Queue / Accept, sent-on cloth leaves the list, rejected comes back, cost carried, thaans, colour

Changes to the existing department screens (Job Wise and SO Wise). Same URLs as before.

## 1. What changed in the backend and database (migration 20261018000001)
- `jobs.status` has 2 new first steps. Full road:
  **IN_WAY** (sent) -> **QUEUE** (department pressed Receive) -> **PENDING** (pressed Accept) -> **PROCESSING** -> **COMPLETE**.
  **REJECTED** is possible from In-Way / Queue / Pending (not from the SO card desk, as before).
  Old jobs that were PENDING (never accepted) became QUEUE.
- New on `jobs`: `receivedById/At`, `acceptedById/At`.
- New on `job_items`: `colourId`, `colourSetById`, `colourSetAt` (colour per SO card; old job colours were copied in).
- Everything is in the audit log.

## 2. Status texts and buttons (receiving department)
| status | `statusText` | sender sees (`sentText`) | buttons |
|---|---|---|---|
| IN_WAY | In-Way | In-Way to Dyeing | **Receive** (`canReceive`), Reject |
| QUEUE | Queue | In queue at Dyeing | **Accept** (`canAccept`), Reject |
| PENDING | Pending | Delivered to Dyeing | dropdown Processing / Complete, Reject |
| PROCESSING / COMPLETE | ... | Delivered to Dyeing | dropdown |
| REJECTED | Rejected | Rejected by Dyeing | (undo as before) |
- Receive: `POST /departments/:code/jobs/:jobId/receive`
- Accept: `POST /departments/:code/jobs/:jobId/accept`
- Status dropdown stays: `PUT /departments/:code/jobs/:jobId/status` `{ "status": "PROCESSING" }` (choosing a later status also fills Receive / Accept).
- Reject: `POST /departments/:code/jobs/:jobId/reject` `{ "reason": "Colour sahi nahi hua" }` -> make the reason box required on screen.
- Show who/when: `receivedBy`, `receivedAt`, `acceptedBy`, `acceptedAt`, `statusBy`, `statusAt`.
- Status filter tabs on Incoming: In-Way, Queue, Pending, Processing, Complete (`status=IN_WAY` etc).
- The SO Card desk "Sent" list shows the same `sentText` / `statusText`.

## 3. Sent-on cloth leaves the list
`GET /departments/:code/incoming?show=active` (default): only cloth still in this department.
- When the department sends the cloth on, the row disappears from its Incoming list (kept in the database).
- `show=sent`: rows already sent on (history tab "Sent On"); `show=all`: both.
- New row fields: `sentOn` (true/false), `sentTo` ([{ jobNo, department, status }]).
- If only part of a job was sent on, the row stays; each item has its own `sentTo`.

## 4. Rejected cloth comes back
If the next department rejects, the row is back in the sender's Incoming list with:
```json
"rejectedBack": { "jobNo": 15, "department": "Printing", "reason": "Colour sahi nahi hua", "at": "...", "by": "Ali" }
```
Show a red tag "Rejected by Printing: Colour sahi nahi hua". The department can work on it again (chemical request, status) or send it again to ANY department from the send screen (it is in `send-form` rows again).

### 4b. The rejecting department's list
The department that rejected sees the REJECTED row in its Incoming list only until the sender sends that cloth again
(to the same department or any other). Then the rejected row leaves its list (still in the database, visible with `show=sent`).
If it was sent again to the same department, that department simply gets it as a new In-Way row.

### 4b-2. Sender answers the rejection (migration 20261018000002)
On the red "Rejected by ..." tag show 2 buttons when `rejectedBack.canAnswer` is true:
- **Reason OK**: `POST /departments/:code/jobs/:rejectedJobId/reject-answer` `{ "decision": "ACCEPT" }`
  (`:code` = sender department, `:rejectedJobId` = `rejectedBack.jobId`). Cloth stays with the sender, as before.
- **Reason not valid**: popup with required reason box ->
  `{ "decision": "DISPUTE", "reason": "Kapra sookha bheja tha" }`.
  The job goes back to the rejecting department as **Queue** (it presses Accept and works on it) and the row leaves the sender's list.
  That department can NOT reject it again (`REJECT_DISPUTED`).
- Rejecting department's row then has a message box (show in orange on top of the row / job detail):
```json
"rejectionRejected": { "department": "Finishing", "yourReason": "Kapra geela hai", "reason": "Kapra sookha bheja tha", "by": { "name": "Ali" }, "at": "..." }
```
Text: "Finishing ne apki rejection reject kar di. Apka reason: Kapra geela hai. Unka reason: Kapra sookha bheja tha."
- Job fields: `rejectAnswer` (null / ACCEPTED / DISPUTED), `canAnswerReject`; `rejectedBack.answer`.
- Errors: `REASON_REQUIRED`, `ALREADY_ANSWERED`, `ALREADY_RESENT`, `NOT_REJECTED`, `JOB_WRONG_DEPARTMENT`.

### 4c. First Job#
Each department gives the cloth a new Job#. To also show the Job# it got when it first left the SO card:
row `firstJobNos` (e.g. [20]; more than one when a job mixes cloth of different first jobs), each item `firstJobNo`.
Show a column "First Job#" next to "Job#".

## 5. Chemical cost travels with the cloth
Every row (Job Wise and SO Wise) now has:
| field | meaning |
|---|---|
| `previousChemicalAmount` | chemical cost of this cloth in earlier departments |
| `chemicalAmount` | chemical cost in THIS department (as before) |
| `totalChemicalAmount` | previous + this |
| `costPerMeter` | this department's cost / meters |
| `totalCostPerMeter` | total / meters |
Columns: "Earlier Cost", "This Dept Cost", "Total Cost", "Cost/Mtr" (use `totalCostPerMeter`).

## 6. Thaans and quality
- Each item: `thaans: [{ "thaanNo": 1, "meters": 100 }, ...]`, row `thaanCount`. SO Wise rows also have `thaans` and `thaanCount`.
- Quality: `qualities` (job) / `quality` (SO row), as before.
- Show a "Thaans" column with the count; click opens a small list "Thaan 1: 100 m, Thaan 2: 120 m". Empty list = lot without thaans (meters only).

## 7. Colour (only in Dyeing)
- `canSetColour` is true on Dyeing rows after Accept. Show a colour dropdown (colours from `GET /colours`, add new with `POST /colours { "name": "BLACK" }`).
- Job Wise row: whole job: `PUT /departments/DYEING/jobs/:jobId/colour` `{ "colourId": "uuid" }`
- SO Wise row: one SO card: same URL with `{ "colourId": "uuid", "soCardId": "uuid" }`. `{ "colourId": null }` clears it.
- The colour goes with the cloth to every later department, also to cloth already sent on. All departments show `colour.name` (job: `colour` is set when all its SO cards have the same colour, `colours` lists all). Empty = not dyed yet.
- Errors: `NO_COLOUR_HERE` (not Dyeing), `NOT_ACCEPTED`, `SO_NOT_IN_JOB`, `UNKNOWN_COLOUR`.
- SO Wise rows also have `colourSetBy`, `colourSetAt`.
