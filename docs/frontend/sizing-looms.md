# Sizing Management — Looms: Loom Beam Entry (K-ID), Looms Status — Frontend Guide

Part of the **Sizing** module (`/api/v1/sizing`, service `SIZING`: VIEW reads, FULL changes) — menu *Beams & Looms*. The looms themselves (loom no + department) are a **Weaving master**: `weaving-loom-master.md` (`/api/v1/weaving/looms`). This guide is the next step: **putting beams on a loom** and the loom status list. (The production register, produced / balance, per-day / ends-on and **half-cut** come with the next steps.)

## The idea
- A **Loom Beam Entry** = **1 or 2 beams** from the beam stock put on **one loom**, with the loom settings. Every entry gets a new **K-ID** (a running number of the company, never used again). Every time beams are put on a loom — one beam or two — it is a **new entry with a new K-ID**.
- A loom takes **at most 2 beams** at a time (over all its running entries) → 422 `LOOM_FULL`.
- The beams are **free (Full) beams of the beam stock** — they come from the sizing batches (the "Beam stock" picker of the screen).
- Settings of an entry: **Factor** (1 = Single panna, 2 = Double panna, 3 = Triple panna — how many pannas of cloth), **Loom RPM**, **Loom Pick**, **Reed space (in)**, **Start date**, and the **End date** when the loom is cut off.
- Lifecycle: **Active · Not confirmed** → (Confirm) → **Active · Confirmed** → (Loom Cut-Off) → **Cut off**. A not-confirmed entry can be edited or deleted; a confirmed one can be edited and cut off.
- Beams: put on a loom = Full → **At loom** (dated like the start date); cut-off = **Empty** (dated like the end date). The Beam Stock (`/weaving/beam-stock`) follows.

## Endpoints — `/api/v1/sizing/loom-beams`
**Helpers**
- `GET /loom-beams/form-data` → `{ date, factors: [ { value: 1, text: "Single panna" }, ... ], defaultFactor: 1, maxBeams: 2, departments: [ { id, code, name } ], looms: [ { id, loomNo, department: { id, name }, beamsOnLoom, roomForBeams, canTakeBeams } ] }` (only switched-on looms; the sizing user needs no weaving access). Offer only looms with `canTakeBeams`.
- `GET /loom-beams/available-beams?search=` → the **Beam stock** picker: `{ data: [ beam… ], total, maxBeams: 2 }` ("11 free beams · a loom can take up to 2 beams"). `search` = beam no / name, set no, yarn count. Beam:
```json
{ "id": "...", "beamNo": 18, "name": "S018", "status": "FULL", "statusText": "Full", "ends": 6054, "yarnCount": "60/s CTN", "date": "2026-11-16", "setNo": "12331",
  "lengthM": 5215, "quality": "60X60/90X82=136\"CTN", "batch": { "id": "...", "batchNo": 269, "batchLabel": "00269" }, "inPassNo": 5559, "type": "os", "weightKg": null }
```
  Columns of the picker: Beam no (`name`), Ends, Count (`yarnCount`), Date, Set no, Length (`lengthM`), Type (`type`: `"os"` = sized outside, it came back on a sizing batch; `null` = not from a batch). The user selects up to 2.

**Create** `POST /loom-beams`
```json
{ "loomId": "<loom>", "beamIds": ["<beam>", "<beam>"], "factor": 2, "loomRpm": 410, "loomPick": 60, "reedSpace": 61.0, "startDate": "2026-10-19" }
```
`loomId` and `beamIds` (1 or 2 beams; 3 → 400) required. `factor` 1 / 2 / 3 (default 1); `loomRpm`, `loomPick`, `reedSpace`, `startDate` (default today) optional now but needed to confirm. 201 → the entry (below), **not confirmed**, with its **K-ID**.
422: `LOOM_FULL` (`details.beamsOnLoom`), `LOOM_INACTIVE`, `UNKNOWN_LOOM`, `UNKNOWN_BEAM`, `BEAM_NOT_FREE` (not a Full beam: it is empty / at a loom / at sizing), `BEFORE_FULL` (start date before the beam came in full), `DUPLICATE_BEAM`.

**One entry** `GET /loom-beams/:id`:
```json
{ "id": "...", "kId": 338, "loom": { "id": "...", "loomNo": "001", "department": { "id": "...", "code": 1, "name": "Sulzer" } },
  "factor": 1, "factorText": "Single panna", "loomRpm": 410, "loomPick": 60, "reedSpace": 61, "startDate": "2026-10-19", "endDate": null,
  "status": "ACTIVE", "statusText": "Active", "isConfirmed": true,
  "beams": [ { "id": "...", "beamNo": 75, "name": "S075", "lengthM": 4050, "setNo": "12077", "ends": 6930, "yarnCount": "60/s CTN", "quality": "60X40/96X64=74\"", "date": "...", "batch": { "batchNo": 149 }, "type": "os", "status": "AT_LOOM", "statusText": "At loom" } ],
  "warps": 2, "beamNos": "S075|S076", "setNos": "12077|12077", "beamLengthM": 8100, "netLengthM": 4050,
  "yarnCount": "60/s CTN", "ends": 6930, "quality": "60X40/96X64=74\"", "mixed": false,
  "readiness": { "rpm": true, "pick": true, "reedSpace": true },
  "canEdit": true, "canConfirm": false, "canDelete": false, "canCutOff": true, "canReopen": false }
```
- Header pills of the entry form: **Beam length** `beamLengthM` m · `warps` beams; **Net length** `netLengthM` m; (Produced / Balance come later). **Net length = beam length ÷ number of beams** (the two beams of a loom run side by side: 8,100 m of beams = 4,050 m of warp).
- The info strip: Quality, Yarn count, Beam # (`beamNos`), Set # (`setNos`), Ends — from the batches of the beams (`mixed: true` = the two beams differ in count / ends / quality: show a warning).
- "Beams on this loom" table = `beams` (Set#, Date, Count, Quality, Ends, Beam#, Length) with the total warp length `beamLengthM`.
- Buttons by flags: **Save** (`PATCH`), **Confirm** (`canConfirm`), **Delete** (`canDelete`), **Loom Cut-Off** (`canCutOff`), **Edit** when `canEdit`. Show the status chips **Active** / **Cut off** (`statusText`) and **Confirmed** / **Not confirmed** (`isConfirmed`). While `readiness` is not all true, the missing fields are the ones to fill before Confirm.

**Change** `PATCH /loom-beams/:id` `{ factor?, loomRpm?, loomPick?, reedSpace?, startDate? }` — active entries only (422 `ENTRY_CUT_OFF`). The beams of an entry cannot be changed: delete the (not confirmed) entry and make a new one (new K-ID).
**Confirm** `POST /loom-beams/:id/confirm` — needs RPM, pick and reed space: 422 `NOT_READY` (`details.missing`, `details.readiness`).
**Delete** `DELETE /loom-beams/:id` → `{ deleted: true, id }` — **only a not-confirmed entry** (422 `ENTRY_CONFIRMED` otherwise); the beams go back to the stock as *Full* (with their old date and meters).
**Loom Cut-Off** `POST /loom-beams/:id/cut-off` `{ "endDate": "2026-11-30" }` (default today) — confirmed entries only (422 `NOT_CONFIRMED`); the end date cannot be before the start date (422 `END_BEFORE_START`). The beams become *Empty* (dated like the end date), the entry is **Cut off**, the loom is free for new beams.
**Reopen (undo a cut-off)** `POST /loom-beams/:id/reopen` — beams back to the loom (only while they are still empty: 422 `BEAM_MOVED_ON`; the loom must have room: 422 `LOOM_FULL`).

## Looms status list — `GET /loom-beams`
Query: `status` (`ACTIVE` = running, `CUT_OFF`; nothing = all), `departmentId` (the Sulzer / Airjet tabs), `loomId`, `confirmed`, `search` (loom no, K-ID, beam name, set no), `dateFrom`, `dateTo` (start date), `page`, `limit`.
```json
{ "data": [ entry… ], "page": 1, "limit": 50, "total": 44,
  "counts": { "active": 44, "cutOff": 120, "notConfirmed": 2 },
  "totals": { "loomsRunning": 44, "idleLooms": 20, "beamLengthM": 245911 },
  "idleLooms": [ { "id": "...", "loomNo": "009", "department": { "id": "...", "name": "Sulzer" } } ] }
```
Use `status=ACTIVE&departmentId=<Sulzer>` for the "Sulzer Loom Beam Tracking" tab and the Airjet department for the other tab. Pills: **loomsRunning** ("44 looms running"), **beamLengthM** (total beam length of the running entries), **idleLooms** (the "20 idle looms" dropdown = `idleLooms`: switched-on looms with no running entry, of the department filter). The columns the entry already has: K#, Loom, Beam / Set (`beamNos`, `setNos`), Ends / Count, Length (`netLengthM`, "of" `beamLengthM`), Start (+ `warps` "2 warps"), RPM / Pick, Quality. Produced / left / done / per day / ends on need the production register (next step).
"Beams on floor" = the free beams (`available-beams`), "Beams at sizing" = `GET /weaving/beam-stock/AT_SIZING`, "Beam Completed / Exhausted" = entries with `status=CUT_OFF`.

## Other effects
- Beam Stock (`/weaving/beam-stock`): *Full* → *At loom* when put on a loom, *Empty* after the cut-off.
- A beam that is on a loom cannot be taken back from a sizing receipt (the receipt shows `BEAM_MOVED_ON`).

## Database
Migration `20261231000001-weaving-looms.js` (tables `looms`, `loom_entries`, `loom_entry_beams`). Run `npm run db:migrate`.

## Update — same-length beams, entry without beams, add beams later
- **Same length rule:** the two beams of one entry must have the **same length**. Different lengths → 422 `BEAM_LENGTH_MISMATCH` (`details.lengths`). In the "Beam stock" picker, once one beam is selected, disable (grey out) the beams with a different `lengthM`.
- **Entry without beams:** `POST /loom-beams` now accepts `beamIds` empty or missing. The loom is set up (factor, RPM, pick, reed space, start date) and gets its K-ID; the beams come later. Such an entry has `warps: 0`, is **not** counted in "looms running" and the loom stays in `idleLooms`. It cannot be confirmed (422 `NO_BEAMS`).
- **Add beams to an entry (the "Add beams" button):** `POST /loom-beams/:id/beams` `{ "beamIds": ["…"] }` (1–2). Works on an active entry (confirmed or not) while it has room: an entry takes max 2 beams (422 `ENTRY_FULL`), a loom max 2 beams over all entries (422 `LOOM_FULL`), the new beam must be Full (`BEAM_NOT_FREE`), not before its full date (`BEFORE_FULL`) and of the same length as the beams already on the entry (`BEAM_LENGTH_MISMATCH`). The beams get the entry's start date. Show the button when `canAddBeams` is true.
- **Take a beam off:** `DELETE /loom-beams/:id/beams/:beamId` — only while the entry is **not confirmed** (`canRemoveBeams`); the beam goes back to the stock as Full. A confirmed entry: cut the loom off.
- **One beam on the loom → two choices:** (1) open that entry and **Add beams** (same K-ID, 2nd beam), or (2) make a **new entry** on the same loom (`POST /loom-beams` with that loom; a new K-ID). A loom may have two entries with one beam each. The loom list (`form-data.looms`) shows `roomForBeams`.
- Entry JSON now also has `canAddBeams` and `canRemoveBeams`; `canConfirm` needs at least one beam.
- Also from the Looms master screen the frontend can offer "Add beams" on a loom: open its running entry (`activeKIds` of `/weaving/looms`) or create a new entry with `loomId` pre-selected.

## Update 2 — same count and same quality too
The beams of one entry must have the **same length, the same yarn count and the same quality** (count / quality come from the sizing batch the beam was sized on; beams without a batch compare as empty). On `POST /loom-beams` (2 beams) and `POST /loom-beams/:id/beams` (against the beams already on the entry) a difference gives 422: `BEAM_LENGTH_MISMATCH`, `BEAM_COUNT_MISMATCH` or `BEAM_QUALITY_MISMATCH` (`details.beams` lists beam no + value). In the picker, after the first beam is selected, grey out the beams whose `lengthM`, `yarnCount` or `quality` differ. The entry's `mixed` flag is therefore always false for new entries.

## Update 3 — Beam Half Cut ("Beam cut-off" button)
When the beams are taken off a loom **before they are finished**, the user enters an **estimated length left**; the beams go back to the beam stock as **Full** with a **"Half cut"** badge and the length left, and the loom becomes free.
- **Button** "Beam cut-off" (half cut) on a confirmed running entry (`canHalfCut`), next to "Loom Cut-Off". Dialog: date (default today) + **Length left (m)** per beam (an entry has 1–2 beams; prefill with `beam.lengthM`).
- `POST /api/v1/sizing/loom-beams/:id/half-cut`
```json
{ "endDate": "2026-11-20", "beams": [ { "beamId": "…", "leftM": 1200 }, { "beamId": "…", "leftM": 1000.5 } ] }
```
  or `{ "leftM": 1000 }` for the same length on all beams of the entry. Each `leftM` must be > 0 and **not more than the length the beam went on the loom with**.
  422: `NOT_CONFIRMED`, `LEFT_REQUIRED` (`details.beamNo`), `LEFT_TOO_LONG` (`details.lengthM`), `END_BEFORE_START`, `BEAM_MOVED_ON`, `NO_BEAMS`.
- **Result** (the entry): `status: "HALF_CUT"`, `statusText: "Half cut"`, `endDate`, each beam has `leftM` and `status: "FULL"`. `canReopen` is true (undo), `canHalfCut` / `canCutOff` false. Loom: `running: false`, free for new beams (`/weaving/looms/:id` → `canTakeBeams: true`; it appears in `idleLooms`).
- **Beam stock:** the beam is **Full** again, `meters` = length left, and has **`halfCut: true`, `halfCutM`** (also in `GET /weaving/beam-stock/FULL` and in `GET /sizing/loom-beams/available-beams`: `halfCut`, `halfCutM`, `lengthM` = length left). Show a badge **"Half cut · 1,200 m left"**.
- **Put on a loom again:** the same flow as any Full beam (`POST /loom-beams`, new K-ID); the length is the length left, so same-length / count / quality rules apply on it. The badge goes while it is on the loom; if that (not confirmed) entry is deleted, the beam comes back with its badge.
- **Undo:** `POST /loom-beams/:id/reopen` also undoes a half cut (beams back on the loom with their original length; only while they are still Full in the stock: 422 `BEAM_MOVED_ON`).
- **Status list:** `status=HALF_CUT` filters half-cut entries; `counts` has `halfCut`; the "Completed / Exhausted" tab stays `status=CUT_OFF`. Status chip text = `statusText`.
- **Database:** migration `20270101000001-loom-half-cut.js` (`yarn_beams.halfCutM`, `loom_entry_beams.leftM / prevHalfCutM`, status `HALF_CUT`). Run `npm run db:migrate`.

## Update 4 — Half cut record: cloth made, shown in the Completed tab
- A half-cut entry keeps its record: the beams' length when they went on, the length left and the **cloth made** from them.
- Entry fields (HALF_CUT entries; `null` for others — a full Loom Cut-Off gets its production figures with the production register later):
  - `netLengthM` (warp length that went on), `leftM` (total meters left on the beams), `leftNetM` (= `leftM` ÷ `warps`), **`producedM` = `netLengthM` − `leftNetM`** (cloth made so far). Each beam also has `leftM`.
- **Where to show it: the "Completed / Exhausted" tab** (it is the history of finished loom runs). Use `GET /sizing/loom-beams?status=COMPLETED` = cut-off + half-cut entries together; the status chip (`statusText`: "Cut off" / "Half cut") tells them apart, and for a half cut row show "Cloth made `producedM` m · `leftNetM` m left". `counts.completed` is the tab badge. `status=CUT_OFF` / `status=HALF_CUT` still filter one kind only.
- The beam itself shows in Beam Stock (Full) with the "Half cut" badge and the length left; when it goes on a loom again a new entry (new K-ID) starts, and this old half-cut entry stays as the record of the first part.

## Update 5 — production figures on the K-ID (see `weaving-production.md`)
The entry now has `units`, **`producedM`**, `balanceM`, `donePct`, `remainingPct`, `daysRun`, `perDayM`, `lastProductionDate`, `endsOn` (from the production register) and `GET /loom-beams/:id/production` lists its register rows. **Change:** the half-cut estimate that Update 4 called `producedM` is now **`estimatedProducedM`** (and the Completed tab test uses it); `producedM` is always the register figure. Prefill the half-cut "Length left" with `balanceM`.
