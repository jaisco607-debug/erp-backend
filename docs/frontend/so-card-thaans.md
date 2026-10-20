# SO CARD update: thaan-wise lots, full lot detail, send many cards as one job, operator name
Build these changes in the SO Card screens and the department screens. Everything else stays as before.

Base URL `/api/v1`. Header `Authorization: Bearer <token>`. Errors come as `{ "error": { "code", "message" } }`; show `message` in a toast.
The backend must run `npm run db:migrate` first.

## Rules (what the business wants)
1. An SO card takes cloth from grey lots of ONE party only. Lots of two parties can never be on one card (error `MIXED_CUSTOMERS`).
2. A lot that has a thaan list gives whole **thaans**: the user ticks thaans, and does not type meters. A lot without a thaan list (old lots) still takes typed meters.
3. While picking, show for each lot:
   - how much went out before
   - how much is left now
   - how much is going on this card
   - how much will be left after
4. The card shows full detail: SO#, ID#, card date, party, quality, and per lot: Lot#, Type#, GLM, GSM, unit, thaans with lengths, meters (and yards for yard lots).
5. Several SO cards can be ticked and sent to a department together. They go as ONE job with one Job#, and the department sees all their SO numbers.
6. The **operator name** is typed by the receiving department, not by the SO card desk.

## 1. Data for the SO card form
GET `/so-cards/form-data` returns:
```json
{ "nextCardNo": 4741, "nextIdNo": 4741,
  "departments": [ { "id": "…", "code": "DYEING", "name": "Dyeing" } ],
  "customers": [ { "id": "…", "code": 130, "name": "AZ TEXTILES", "balanceMeters": 1600, "lots": [ LOT, … ] } ] }
```
The same LOT objects come from GET `/so-cards/available-lots?customerId=…`. Each LOT looks like this:
```json
{ "id": "…", "lotNo": 2437, "typeNo": "0612", "dcNo": "552", "inwardDate": "2026-10-15",
  "quality": { "id": "…", "name": "PC TWILL" }, "glm": 145.5, "gsm": 120,
  "unit": "METER", "showYards": false,
  "inwardMeters": 350, "pieces": 4,
  "soCardMeters": 180, "returnedMeters": 0, "outwardMeters": 180,
  "balanceMeters": 170, "balanceYards": null, "balancePieces": 2,
  "isThaanWise": true,
  "thaans": [ { "thaanNo": 2, "meters": 120, "yards": null }, { "thaanNo": 4, "meters": 50, "yards": null } ],
  "isReprocess": false }
```
- `thaans` holds ONLY the thaans still in the grey store (free to pick).
- `outwardMeters` is what went out before (on SO cards + given back). `balanceMeters` is what is left now.
- `showYards` is true only for YARD lots; show yards only then.

## 2. SO card form (create)
**Layout, top to bottom:**
1. Header: SO# and ID# as read-only placeholders (`nextCardNo`, `nextIdNo`), Card date (default today).
2. **Party** dropdown from `customers`. Changing the party clears the picked lots.
3. **Lots of that party**: one card per lot.
   - Lot card header: Lot#, Type#, Quality, GLM, GSM, Unit.
   - Figures row (4 boxes):
     - **Gone before** = `outwardMeters`
     - **Left now** = `balanceMeters`
     - **Going now** = the sum of the ticked thaans (or the typed meters)
     - **Left after** = Left now − Going now
     For YARD lots also show yards under each box.
   - If `isThaanWise` is true: a thaan checklist (Thaan#, Meters, plus Yards for YARD lots), with "Select all". There is NO meters input.
   - If `isThaanWise` is false: a Meters input (max = `balanceMeters`) and a Pieces input.
   - A lot is "picked" when at least one thaan is ticked or meters are typed.
4. Quality (optional dropdown; empty = the lots' own quality), Description, Remarks.
5. Footer: total thaans, total meters.
6. Optional: a Department dropdown to send straight away.
7. Save button.

POST `/so-cards`
```json
{ "cardDate": "2026-10-15",
  "lots": [
    { "greyLotId": "…", "thaanNos": [1, 3] },
    { "greyLotId": "…", "meters": 400, "pieces": 4 }
  ],
  "qualityId": null, "description": "", "remarks": "",
  "departmentId": "…optional: send straight away…", "sentThrough": "" }
```
- Per lot, send `thaanNos` (thaan-wise lot) OR `meters` (lot without thaans), never both.
- Errors:
  - `PICK_THAANS`: this lot has thaans, so tick them
  - `NO_THAANS`: this lot has no thaans, so type meters
  - `THAAN_NOT_IN_STOCK`: someone else took it, or it was given back; reload the lots
  - `UNKNOWN_THAAN`: that thaan number is not in this lot
  - `MIXED_CUSTOMERS`: lots of two parties
  - `NOT_ENOUGH_METERS`: more meters than the balance
  - `LOT_NOT_APPROVED`, `LOT_INACTIVE`: the lot cannot be used yet

## 3. SO card detail / print view
GET `/so-cards/:id`. The card now has:
```json
{ "cardNo": 4741, "idNo": 4741, "cardDate": "2026-10-15", "createdAt": "…", "createdBy": { "id": "…", "name": "Ali" },
  "customer": { "code": 130, "name": "AZ TEXTILES" }, "quality": { "name": "PC TWILL" },
  "totalMeters": 580, "totalYards": null, "totalPieces": 6, "status": "NEW", "deliveryText": "…",
  "lots": [ {
    "id": "…", "greyLotId": "…", "lotNo": 2437, "typeNo": "0612", "dcNo": "552", "inwardDate": "2026-10-15",
    "quality": { "name": "PC TWILL" }, "glm": 145.5, "gsm": 120, "unit": "METER", "showYards": false,
    "lotInwardMeters": 350, "lotPieces": 4,
    "outBefore": 0, "balanceBefore": 350, "meters": 180, "balanceAfter": 170,
    "yards": null, "pieces": 2,
    "isThaanWise": true, "thaanNos": [1, 3],
    "thaans": [ { "thaanNo": 1, "meters": 100, "yards": null }, { "thaanNo": 3, "meters": 80, "yards": null } ] } ] }
```
- Show per lot: Lot#, Type#, DC#, Quality, GLM, GSM, Thaans (e.g. "1, 3" or a small table), Meters (+ Yards when `showYards`), and the figures "Gone before / Left before / This card / Left after" (`outBefore`, `balanceBefore`, `meters`, `balanceAfter`).
- Header: SO#, ID#, card date, made on (`createdAt`), made by (`createdBy.name`), party, total meters (+ `totalYards` when not null), total thaans.

## 4. Edit card
- PATCH `/so-cards/:id` with `{ "lots": [ … same shape as create … ] }`. This works only while the card is NEW and not confirmed.
- The card's old thaans go back to the grey store first, so in the edit form show the lot's free thaans PLUS this card's own thaans (`thaanNos`) as ticked.
- To build the edit list: take `available-lots` for the party, and add this card's thaans back into each lot's list.
- Cancel (DELETE `/so-cards/:id`) also frees the thaans.

## 5. Send several SO cards together (ONE job)
On the SO card list, add a checkbox on every row with `status === "NEW"`, and a button **"Send selected"**.
The button opens a small modal with:
- Department dropdown (`form-data.departments`)
- Colour dropdown (optional, `GET /colours`)
- Sent through (text, optional)
- Date (optional, default today)
- Remarks

POST `/so-cards/send-many`
```json
{ "soCardIds": ["…card 1…", "…card 2…"], "departmentId": "…", "colourId": null, "sentThrough": "Akram", "remarks": "" }
```
The response:
```json
{ "job": { "id": "…", "jobNo": 51, "totalMeters": 630, "soNos": [4741, 4742], "toDepartmentName": "Stitching", … },
  "soCards": [ …both cards, now status SENT… ] }
```
Show "Job# 51 sent to Stitching (SO# 4741, 4742)".

Errors:
- `CARD_SENT`: one of the cards is already sent
- `NOTHING_LEFT`: nothing left to send
- `UNKNOWN_DEPARTMENT`

The single send (POST `/so-cards/:id/send`) still works for one card.

## 6. Department screens (incoming / sent lists)
- Every job already has `soNos` (all the SO numbers in it). Show them in a column "SO#" as "4741, 4742".
- **Filter by SO#**: add a number box "SO#" and pass `soNo=4741` to `GET /departments/<CODE>/incoming` or `/sent`. Only jobs containing that SO card come back. (The `search` box still finds both Job# and SO#.)
- **Operator name** (only on the INCOMING side, i.e. the receiving department):
  - Add an "Operator" column with a small text input and a Save icon (or a modal on the job row).
  - PUT `/departments/<CODE>/jobs/<jobId>/operator` with `{ "operatorName": "Rashid" }`. Send `""` to clear it.
  - The job then has `operatorName`, `operatorSetBy { name }` and `operatorSetAt`. Show `operatorName` on incoming and sent lists, and on the job detail.
  - Only the receiving department (FULL access) can set it. The SO card desk does not see this input.
- The SO-wise rows (`view=so`) also carry `operatorName` and `soNos`.
