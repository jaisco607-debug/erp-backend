# SO CARD: complete frontend guide (all changes of 2026-10-15, incl. PART OF A THAAN)
This ONE guide replaces `so-card-thaans.md`, `so-card-backend-changes.md` and `so-card-order-info.md`.
Part A says what changed on the server. Part B says how to build each screen.

Base URL `/api/v1`. Header `Authorization: Bearer TOKEN`. Errors come as `{ "error": { "code", "message" } }`; show `message` in a toast.
The backend must run `npm run db:migrate` first.

---------------------------------------------------------------
# PART A: WHAT CHANGED IN THE BACKEND

## A1. Database changes
| Table | Change | Meaning |
|---|---|---|
| `grey_lots` | new `glm`, `gsm` (numbers, optional) | cloth weight |
| `grey_lot_thaans` | `status` can be `IN_STOCK`, `RETURNED` or **`SO_CARD`** | SO_CARD = this thaan went on an SO card |
| `grey_lot_thaans` | new `soCardLotId` | old field, no longer used (see `so_card_lot_thaans`) |
| `so_card_lots` | new `outBefore`, `balanceBefore` | the lot's "gone before" and "left before" when the card was made |
| `so_cards` | new `deliveryDate`, `article`, `instructions` (optional) | order details |
| `grey_lot_thaans` | new `takenMeters` | meters of the thaan already on SO cards (part of a thaan can be taken) |
| **`so_card_lot_thaans`** (NEW table) | `soCardLotId`, `thaanId`, `meters` | which thaan, and how many meters of it, each SO card lot took |
| `jobs` | new `instructions` (optional) | what the receiving department must do |
| `jobs` | new `operatorName`, `operatorSetById`, `operatorSetAt` | operator typed by the receiving department |

Migrations: 20261015000002, 20261015000003, 20261015000004, 20261015000005. No table was removed and no old field was renamed.

## A2. Business rules on the server
1. **One party per SO card.** All lots on one card belong to one party; otherwise the error is `MIXED_CUSTOMERS`.
2. **Thaan-wise.** A lot with a thaan list gives thaans, either WHOLE or a PART of a thaan (e.g. 1000 m out of a 2000 m thaan). A lot without a thaan list gives `meters`.
3. **Part of a thaan:** the rest stays free in grey (the thaan stays `IN_STOCK` with less free meters) and can go on another card later. When all of a thaan is taken it becomes `SO_CARD`.
4. **A thaan that is (partly) on an SO card is locked in grey:** it cannot be given back and its length cannot be edited. Cancelling or editing the card frees its meters.
5. **Sending = ONE job (one Job#) for any combination:**
   - one card
   - several cards of the same party
   - several cards of different parties
   Inside the job every card's cloth stays separate.
6. **Two views of jobs:** Job-wise (one row per job) and SO-wise (one row per card inside a job).
7. **Operator name** is typed only by the receiving department.

## A3. Endpoints
| Method + URL | What it does |
|---|---|
| GET `/so-cards/form-data` | Next SO#/ID#, departments, parties with their free lots |
| GET `/so-cards/available-lots?customerId=` | The free lots of a party (same LOT objects) |
| GET `/so-cards` | List (filters: search, customerId, status, isConfirmed, dateFrom, dateTo, page, limit) |
| POST `/so-cards` | Create a card (can also send straight away) |
| GET `/so-cards/:id` | Card detail |
| **GET `/so-cards/:id/edit-data`** | NEW: everything the edit screen needs (see B2a) |
| PATCH `/so-cards/:id` | Edit (only while NEW and not confirmed) |
| DELETE `/so-cards/:id` | Cancel (only while NEW); frees meters and thaans |
| PUT `/so-cards/:id/confirm` | `{ isConfirmed }` locks or unlocks the card |
| **POST `/so-cards/send-many`** | NEW: send 1 or more NEW cards as ONE job |
| POST `/so-cards/:id/send` | Old single send, still works |
| GET `/departments/CODE/incoming?view=job` or `?view=so` | Department working list, job-wise or SO-wise |
| GET `/departments/CODE/sent?view=job` or `?view=so` | Jobs the department sent |
| `&soNo=4741` on those lists | NEW: only jobs containing SO# 4741 |
| PUT `/departments/CODE/jobs/JOB_ID/operator` | NEW: `{ operatorName }`, receiving department only |
| PATCH `/jobs/:id` | Sender fixes colour / sentThrough / remarks / instructions while PENDING |

---------------------------------------------------------------
# PART B: SCREENS

## B1. Data for the SO card form
GET `/so-cards/form-data`:
```json
{ "nextCardNo": 4741, "nextIdNo": 4741,
  "departments": [ { "id": "…", "code": "DYEING", "name": "Dyeing" } ],
  "customers": [ { "id": "…", "code": 130, "name": "AZ TEXTILES", "balanceMeters": 1600, "lots": [ "LOT objects" ] } ] }
```
Each LOT object:
```json
{ "id": "…", "lotNo": 2437, "typeNo": "0612", "dcNo": "552", "inwardDate": "2026-10-15",
  "quality": { "id": "…", "name": "PC TWILL" }, "glm": 145.5, "gsm": 120,
  "unit": "METER", "showYards": false,
  "inwardMeters": 350, "pieces": 4,
  "outwardMeters": 180, "soCardMeters": 180, "returnedMeters": 0,
  "balanceMeters": 170, "balanceYards": null, "balancePieces": 2,
  "isThaanWise": true,
  "thaans": [
    { "thaanNo": 2, "meters": 120, "thaanMeters": 120, "takenMeters": 0, "yards": null },
    { "thaanNo": 5, "meters": 1000, "thaanMeters": 2000, "takenMeters": 1000, "yards": null } ],
  "isReprocess": false }
```
- `thaans` holds ONLY thaans that still have free meters.
- In each thaan, `meters` is the FREE meters (what can still be taken), `thaanMeters` is the full length, and `takenMeters` is what is already on other cards. Show e.g. "Thaan 5: 1000 m free (of 2000)".
- `outwardMeters` is what went out before (SO cards + given back). `balanceMeters` is what is left now.
- Show yards only when `showYards` is true.

## B2. SO card form (create / edit)
Layout, top to bottom:
1. **Header:** SO# and ID# (read-only placeholders), Card date (default today), **Delivery date** (date picker, optional).
2. **Party** dropdown (`customers`). Changing the party clears the picked lots.
3. **Lots of that party**, one box per lot:
   - Box header: Lot#, Type#, Quality, GLM, GSM, Unit.
   - Four figures: **Gone before** = `outwardMeters`, **Left now** = `balanceMeters`, **Going now** = the sum of the ticked thaans (or the typed meters), **Left after** = Left now − Going now. For YARD lots also show yards.
   - `isThaanWise` true: a thaan table with "Select all". Each row has:
     - a Checkbox
     - Thaan#
     - Free meters (`meters`), plus Full length (`thaanMeters`) when different
     - a **Take meters** input that appears when the row is ticked; it is pre-filled with the free meters and its max is the free meters
     - Yards (for YARD lots)
     The user can lower "Take meters" to take only part of the thaan (e.g. 1000 of 2000).
   - `isThaanWise` false: a Meters input (max `balanceMeters`) and a Pieces input.
4. **Quality** (optional; empty = the lots' own quality), **Article / Style**, **Description**, **Instructions** (text area), **Remarks**.
5. Footer: total thaans, total meters.
6. Optional "Send now": Department dropdown + **Work instructions** text area + Sent through.
7. Save.

POST `/so-cards`
```json
{ "cardDate": "2026-10-15", "deliveryDate": "2026-10-30",
  "article": "BEDSHEET 90x100", "instructions": "Soft finish", "description": "", "remarks": "", "qualityId": null,
  "lots": [
    { "greyLotId": "…", "thaans": [ { "thaanNo": 1, "meters": 1000 }, { "thaanNo": 3 } ] },
    { "greyLotId": "…", "meters": 400, "pieces": 4 }
  ],
  "departmentId": "…optional…", "workInstructions": "…optional…", "sentThrough": "" }
```
- Per lot send ONE of these:
  - `thaans: [{ thaanNo, meters }]`: the recommended form. `meters` is how much of that thaan to take; leave `meters` out to take all that is free of it.
  - `thaanNos: [1, 3]`: the short form; takes all that is free of each thaan.
  - `meters`: only for a lot WITHOUT a thaan list.
- Build `thaans` from the ticked rows: `{ thaanNo, meters: takeMeters }`.
- **Edit**: see B2a.
- Errors:
  - `PICK_THAANS`: tick thaans for this lot
  - `NO_THAANS`: type meters for this lot
  - `THAAN_NOT_IN_STOCK`: the thaan was taken or given back; reload
  - `THAAN_SHORT`: more meters than are free in that thaan (`details.freeMeters`)
  - `UNKNOWN_THAAN`: that thaan number is not in this lot
  - `MIXED_CUSTOMERS`: lots of two parties
  - `NOT_ENOUGH_METERS`: more meters than the balance
  - `LOT_NOT_APPROVED`, `LOT_INACTIVE`: the lot cannot be used yet
  - `CARD_SENT`: the card was already sent
  - `CARD_CONFIRMED`: take the confirmation off first

## B2a. Edit SO card (NEW)
Open the edit screen from the list (Edit button) or the detail.

**Step 1: load.** GET `/so-cards/:id/edit-data`
```json
{ "card": { "...same as the card detail (B4)..." },
  "canEdit": true, "lockedReason": null, "canChangeLots": true,
  "lots": [ { "...same LOT object as B1...",
    "onThisCard": 1000, "selected": true, "isActive": true, "isApproved": true,
    "thaans": [
      { "thaanNo": 1, "meters": 2000, "thaanMeters": 2000, "takenMeters": 0, "onThisCard": 1000, "selected": true },
      { "thaanNo": 2, "meters": 500, "thaanMeters": 500, "takenMeters": 0, "onThisCard": 0, "selected": false } ] } ] }
```
- `lots` = all free lots of the card's party PLUS the lots already on this card.
- In this list, this card's own meters are counted as FREE again. So:
  - `meters` of a thaan = what this card may hold of it (free + what this card already has).
  - `balanceMeters` / `outwardMeters` of a lot are without this card.
  - `onThisCard` = meters this card has now; `selected` = it is on the card.
- `canEdit` false: show the form read-only with a message:
  - `lockedReason: "CARD_CONFIRMED"`: "Card is confirmed. Turn Conf. off to edit."
  - `lockedReason: "CARD_SENT"`: "Card is already sent to a department; it cannot be edited."

**Step 2: show the form** exactly like B2 (create), but filled in:
- Header fields from `card` (cardDate, deliveryDate, article, instructions, description, remarks, quality).
- Party: show it read-only (the party comes from the lots; lots of another party give `MIXED_CUSTOMERS`).
- Lot boxes: tick lots with `selected` true. In thaan tables tick thaans with `selected`, and pre-fill "Take meters" with `onThisCard`. The max of "Take meters" is the thaan's `meters`.
- Plain lots (no thaan list): pre-fill the Meters input with `onThisCard`; max is `balanceMeters`.
- Figures per lot: Gone before = `outwardMeters`, Left now = `balanceMeters`, Going now = typed sum, Left after = Left now - Going now.
- The user can: change meters of a thaan (e.g. 1000 to 1500), tick new thaans, untick thaans, add or remove lots, and change the header fields.

**Step 3: save.** PATCH `/so-cards/:id`, send only what changed:
```json
{ "deliveryDate": "2026-11-02", "instructions": "Extra soft",
  "lots": [ { "greyLotId": "...", "thaans": [ { "thaanNo": 1, "meters": 1500 }, { "thaanNo": 2, "meters": 200 } ] } ] }
```
- If `lots` is sent it must be the WHOLE new list of the card (not only the changes). The server frees the card's old meters and takes the new ones in one step; if anything fails nothing changes.
- Only header fields changed: do not send `lots`.
- The response is the updated card (same as B4). Thaans not in the new list become free in grey again.
- Errors: same as B2, plus `CARD_SENT`, `CARD_CONFIRMED`.

## B3. SO card list
Columns:
- a Checkbox (only when `status === "NEW"`)
- SO#, ID#, Date, **Delivery** (red when past), Party, Article, Quality, Meters, Thaans (`totalPieces`; a part thaan counts as 1)
- Status / `deliveryText`, Conf. toggle, Actions (View, Edit, Cancel)

Above the table, add a **"Send selected (N)"** button (see B5).

## B4. SO card detail / print
GET `/so-cards/:id`:
```json
{ "cardNo": 4741, "idNo": 4741, "cardDate": "2026-10-15", "deliveryDate": "2026-10-30",
  "article": "BEDSHEET 90x100", "instructions": "Soft finish", "description": null, "remarks": null,
  "createdAt": "…", "createdBy": { "name": "Ali" },
  "customer": { "code": 130, "name": "AZ TEXTILES" }, "quality": { "name": "PC TWILL" },
  "totalMeters": 580, "totalYards": null, "totalPieces": 6,
  "status": "NEW", "deliveryText": "Not sent to any department yet", "isConfirmed": false,
  "lots": [ {
    "lotNo": 2437, "typeNo": "0612", "dcNo": "552", "inwardDate": "2026-10-15",
    "quality": { "name": "PC TWILL" }, "glm": 145.5, "gsm": 120, "unit": "METER", "showYards": false,
    "outBefore": 0, "balanceBefore": 350, "meters": 180, "balanceAfter": 170, "yards": null, "pieces": 2,
    "isThaanWise": true, "thaanNos": [1, 3],
    "thaans": [ { "thaanNo": 1, "meters": 100, "thaanMeters": 2000, "isPart": true, "yards": null },
                { "thaanNo": 3, "meters": 80, "thaanMeters": 80, "isPart": false, "yards": null } ] } ],
  "moves": [ "…sending history…" ] }
```
- **Header:** SO#, ID#, card date, delivery date, made on (`createdAt`), made by, party, article, quality, total meters (+ `totalYards` when not null), total thaans, instructions.
- **Per lot:** Lot#, Type#, DC#, Quality, GLM, GSM, Thaans as a small table (Thaan#, meters on this card, and "of 2000 m (part)" when `isPart`), Meters (+ Yards), and the figures Gone before / Left before / This card / Left after (`outBefore`, `balanceBefore`, `meters`, `balanceAfter`).
- **History:** the `moves` list (where the card was sent, by whom, when).

## B5. Send (one card or many, any parties) = ONE job
Use ONE modal for every case. It opens from "Send selected (N)" on the list, and also from a "Send" button on a single card.
- Department dropdown (`form-data.departments`)
- Colour (optional, `GET /colours`)
- **Work instructions** (text area)
- Sent through, Date (default today), Remarks

ALWAYS call:
POST `/so-cards/send-many`
```json
{ "soCardIds": ["…", "…"], "departmentId": "…", "colourId": null, "workInstructions": "Dye black, shade 12", "sentThrough": "Akram", "jobDate": "2026-10-15", "remarks": "" }
```
The response:
```json
{ "job": { "id": "…", "jobNo": 51, "totalMeters": 1130, "soNos": [4741, 4742], "customers": ["AZ TEXTILES (130)", "GUL AHMED (131)"], "toDepartmentName": "Dyeing", "instructions": "Dye black, shade 12" },
  "soCards": [ "…the cards, now status SENT…" ] }
```
- Show the message "Job# 51 sent to Dyeing: SO# 4741, 4742".
- Errors: `CARD_SENT` (a ticked card was already sent), `NOTHING_LEFT`, `UNKNOWN_DEPARTMENT`.

## B6. Department side (only what the SO card changes touch)
- Jobs have `soNos`. Show them as "4741, 4742" in an SO# column.
- **Two tabs:**
  - "Job Wise" (`view=job`): one row per job.
  - "SO Wise" (`view=so`): one row per SO card inside each job. The same Job# repeats; status and operator belong to the job.
- **SO# filter box:** pass `soNo=4741`.
- Jobs have `instructions`. Show them on the incoming list and on the job detail.
- **Operator** (incoming side only): a text input + Save that calls PUT `/departments/CODE/jobs/JOB_ID/operator` with `{ "operatorName": "Rashid" }` (send `""` to clear). Show `operatorName` on the lists.
- More department changes come in the next step; build only these now if you like.

## B7. Example
SO# 4741 (AZ Textiles, 630 m) and SO# 4742 (Gul Ahmed, 500 m) are ticked and sent to Dyeing.
- The result is ONE job: Job# 51, 1130 m, `soNos` [4741, 4742].
- The Job Wise tab shows 1 row.
- The SO Wise tab shows 2 rows: (51 / 4741 / 630 m) and (51 / 4742 / 500 m).
- Filtering with `soNo=4742` returns Job# 51.
