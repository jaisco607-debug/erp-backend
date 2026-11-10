# SO Card sub-categories (parts) with a colour tag — Frontend Guide

## What it is
When an SO card is made, the user can now **divide the cloth into parts** (sub-categories) and **tag each part with a colour**:
- A lot of 6 thaans: thaans 1-2 go to part **A** (tag RED), thaans 3-4 to part **B** (tag BLUE). Thaans 5-6 are **not taken**: they stay in the grey store.
- One thaan of 1000 m can be **
cut into parts by meters**: 400 m to part A and 600 m to part B.
- It is still **ONE SO card** (one SO#, one ID#). The parts are its sub-categories; each part is processed on its own.
- A part can be **sent to a department alone**, or the whole card can be sent (then every part goes).
- The colour tag of a part **goes with the cloth** to the department: Dyeing sees that colour already written on the part, and can **change** it.

**The old way is untouched.** A card made without parts (`lots` as before) works exactly as it did; `groups` on its JSON is `[]`. Cards made earlier have no parts.

---
## 1. Create / change a card with parts
`POST /api/v1/so-cards` and `PATCH /api/v1/so-cards/:id` take **either** `lots` (old way) **or** `groups` (new way), never both (400):
```json
{
  "cardDate": "2026-11-09",
  "groups": [
    { "label": "Red part", "colourId": "<colour id>", "remarks": "for the border",
      "lots": [ { "greyLotId": "<lot>", "thaanNos": [1, 2] } ] },
    { "colourId": "<blue id>",
      "lots": [ { "greyLotId": "<lot>", "thaans": [ { "thaanNo": 3, "meters": 600 }, { "thaanNo": 4 } ] },
                { "greyLotId": "<another lot>", "thaanNos": [1] } ] }
  ]
}
```
- `groups[]` (1 to 26): each part has `label` (optional text, max 80), `colourId` (optional: the colour tag, from the Colours list), `remarks` (optional, max 300) and `lots[]`.
- `lots[]` inside a part has **the same shape as the old `lots`**: `{ greyLotId, thaanNos: [..] }` (whole thaans), or `{ greyLotId, thaans: [{ thaanNo, meters? }] }` (part of a thaan; `meters` left out = all that is free), or `{ greyLotId, meters, pieces }` (a lot with no thaan list).
- **A lot can be in several parts, and one thaan can be in several parts if it is cut by meters.** The server counts what each part took: a thaan of 1000 m asked as 700 + 700 gives 422 `THAAN_SHORT` (`details: { thaanNo, freeMeters }`); a whole thaan asked by two parts gives 422 `THAAN_NOT_IN_STOCK`.
- Thaans that no part takes stay in the grey store (free, as always).
- All lots of a card must be of the same party (as before).
- Parts get a **letter code A, B, C ...** in the order sent. `PATCH` with `groups` **replaces** all parts (the old thaans go back to the store first, then the new ones are taken). `PATCH` with `lots` turns the card back into a plain card. Only while the card is **New and not confirmed**; once any part is sent, the meters cannot change (422 `CARD_SENT`, as before).
- Errors (422): `UNKNOWN_COLOUR`, `COLOUR_INACTIVE`, `GROUP_LABEL_TAKEN` (two parts with the same label), plus all the old lot / thaan errors (`NOT_ENOUGH_METERS`, `UNKNOWN_THAAN`, `PICK_THAANS` ...).
- `departmentId` on the create call still sends the card at once (as before): the whole card goes; parts cut from one thaan become separate jobs automatically (see 4).

### The create screen (what to build)
Keep the screen as it is (lots, thaans, take meters). Add:
1. A switch / button **"Divide into parts"**. Off = the old screen and the old request (`lots`).
2. On = tabs or cards **Part A, Part B ...** (button **+ Add part**). Each part has: a **colour tag** dropdown (Colours), optional name, optional remarks, and the **lots + thaan picker** (same as now). Show, per thaan, what is **still free** after the other parts took theirs (take the meters from the server's `thaans[].meters` free figure and subtract what the other parts on the screen took).
3. A thaan can be ticked in more than one part only with meters (part of a thaan): show a **Take meters** box as now.
4. At the bottom: total going per part and for the card; thaans not ticked in any part stay in the store.

---
## 2. The card JSON (list, one card, edit-data, after create)
New fields (old fields unchanged):
```
hasGroups: true,
groups: [{
  id, code: "A", label: "Red part"|null, title: "Red part" | "Part B",       // title: label, else "Part " + code
  tag: "30-A",                                                                 // the SO# + code: what the departments show
  colour: { id, name } | null,  remarks,
  totalMeters: 200, totalThaans: 2,
  sentMeters: 200, leftMeters: 0,
  status: "NOT_SENT" | "PARTLY_SENT" | "SENT", canSend: true|false,
  department: { id, code, name, jobNo } | null,                                // where it went (newest)
  lots: [{ lineId, greyLotId, lotNo, meters, thaans: [{ thaanNo, meters, thaanMeters, width }] }]
}],
lots: [ ... as before, one line per (lot, part), each with: groupId, groupCode, sentMeters, leftMeters ... ]
```
- Show the SO card with its **parts as sub-rows** (tag, colour chip, lots / thaans, meters, status "Not sent" / "In Dyeing"). `lots` stays one row per lot line as before (a lot in two parts has two lines).
- `deliveryText` / `currentDepartment` of the card show the newest department; for a card with parts also show each part's own `status` and `department`.
- `GET /so-cards/:id/edit-data`: `card.groups` has the parts to fill the edit form; `lots[]` (the party's lots with free meters) is as before, with this card's own meters counted as free again.

---
## 3. Sending parts
**Send screen (SO Card desk)**: `GET /api/v1/jobs/form-data` rows have two new fields:
```
group:  { id, code, label, title, tag, colour: {id, name} | null } | null     // the part of the SO card (null for a plain card)
colour: { id, name } | null                                                   // the colour tag of the part
```
Show the part (tag, title, colour chip) in the row. **A part is one row**: tick the rows of the parts to send, pick the department, send with the same call as now: `POST /api/v1/jobs` with `items: [{ soCardLotId }]` (a part with several lots is several rows: tick them together). **Ticking all the rows of the card sends the main category (every part).**

**Or by the card**: `POST /api/v1/so-cards/:id/send-groups`
```json
{ "departmentId": "...", "groupIds": ["<part id>", "<part id>"], "jobDate": "2026-11-09", "sentThrough": "Driver", "remarks": "...", "instructions": "..." }
```
- `groupIds` left out = **every part that still has cloth** (the whole card). With ids = only those parts.
- Response `{ soCardId, jobs: [ <job JSON> ... ], jobCount, sentMeters }`. Usually one job; **parts cut from the same thaan are sent as separate jobs** (so `jobCount` can be 2 or more). Say so in the success message ("Sent as 2 jobs").
- 422 `NOTHING_LEFT` (the part or the card has nothing left), 422 `UNKNOWN_GROUP`.
- The old `POST /so-cards/:id/send`, `send-many` and `POST /jobs` work as before.
- With `POST /jobs` (or send-many) two parts cut from **the same thaan** in one job give **422 `SPLIT_THAAN_IN_ONE_JOB`** (`details.thaans: [{ lotNo, thaanNo }]`): send them separately, or use `send-groups`.

---
## 4. In the departments
- **Colour tag**: a part sent with a tag arrives with its colour written on its job row: `job.items[].colour` (the colour of this cloth) and `job.items[].group` = `{ id, code, label, title, tag, colour }` (the part and its original tag colour). Show the part tag and the colour chip on the job rows, the SO-wise view and wherever the job rows are shown.
- A job can hold rows of different colours (one per part): `job.colours` lists them.
- **Dyeing changes the colour** (once it has accepted the job, as now): `PUT /api/v1/departments/DYEING/jobs/:jobId/colour` with
  - `{ "colourId": "...", "jobItemId": "<row id>" }` = **one part (one row)** (new),
  - `{ "colourId": "...", "soCardId": "..." }` = every row of one SO card of the job (as before),
  - `{ "colourId": "..." }` = the whole job (as before). `soCardId` together with `jobItemId` gives 400.
  The change goes down to the later departments, as before. `group.colour` (the tag made at the SO card) does not change; `colour` is the working colour.
- Folding, Packing, gate pass and the reports work per thaan as before. A thaan cut into parts is **one thaan in Packing** with all its meters (the folded meters of its parts added up).

## Not changed
Grey inward, the old SO card screen and request (`lots`), jobs and departments, rejecting, returning to the SO card section, chemicals, costing. Reports show the SO card as before (one row per card line).

## Database
Migration `20261129000001-so-card-groups.js` (`so_card_groups`, `so_card_lots.groupId`; one lot may have a line per part). Run `npm run db:migrate`.
