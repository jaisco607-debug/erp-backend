# Weaving — Beam Stock — Frontend Guide

New screen **Weaving > Beam Stock**: where all the beams are. Every (active) beam is in **one of four places**:

| `status` | Text | Meaning |
|---|---|---|
| `EMPTY` | Empty | empty beam, no yarn on it |
| `FULL` | Full | full beam (the sized yarn is wound on it) |
| `AT_LOOM` | At loom | put on a loom |
| `AT_SIZING` | At sizing | sent out for sizing (outsourced) |

Example: 30 beams = 20 at loom + 4 empty + 4 full + 2 at sizing. Sending beams to sizing / receiving them back / putting them on a loom (the next steps) will move the beams between these places and the stock follows by itself. Same service as the beam master: `WEAVING_MASTERS` (`VIEW` is enough).

## 1. The screen — `GET /api/v1/weaving/beam-stock`
```json
{ "total": 30, "asOf": "2026-11-19",
  "statuses": [ { "status": "EMPTY", "text": "Empty", "count": 4 }, { "status": "FULL", "text": "Full", "count": 4 },
                { "status": "AT_LOOM", "text": "At loom", "count": 20 }, { "status": "AT_SIZING", "text": "At sizing", "count": 2 } ] }
```
Always the four places in this order (a place with no beams has `count: 0`). Show **4 cards** (and the total): Empty 4, Full 4, At loom 20, At sizing 2. **Click a card** to open its details.

## 2. Details of a place — `GET /api/v1/weaving/beam-stock/:status`
`:status` is `EMPTY`, `FULL`, `AT_LOOM` or `AT_SIZING` (any letter case; anything else is 400). Optional `?search=` (part of the name, or the exact beam no).
```json
{ "status": "AT_SIZING", "text": "At sizing", "count": 2,
  "data": [ { "id": "...", "beamNo": 102, "beamLabel": "00102", "name": "Sizing B", "beamDate": "2026-09-01",
              "status": "AT_SIZING", "statusText": "At sizing", "statusDate": "2026-11-01", "daysInStatus": 18 } ] }
```
Show a table: **Beam no** (`beamLabel`), **Name**, **Beam date**, and **Since** (`statusDate`) with `daysInStatus`.
- For **At sizing** `statusDate` is **the day the beam went out** (title the column "Sent on"); for **At loom** "On loom since"; for **Empty** / **Full** "Since".
- Oldest first (the beams that stayed longest are on top). `id` opens the beam (`GET /beams/:id`).

## 3. Setting the places (the beam form)
The unit already has beams, so the **beam form** (`weaving-beam.md`) now also takes the place:
- `status` (the four values above; default **`EMPTY`** for a new beam) and `statusDate` (`YYYY-MM-DD`; default the beam date on a new beam, **today** when an edit moves the beam to another place).
- `POST /beams` `{ beamNo?, name, beamDate?, status?, statusDate?, isActive? }` and `PATCH /beams/:id` (any of them) — add a **Place** dropdown and a **Since** date to the beam form. Every beam answer has `status`, `statusText`, `statusDate`.
- `GET /beams?status=FULL` filters the beam list by place; add a Place column.
- Editing a beam keeps its place date unless a new place or a new date is sent. A beam that has not moved since it was made follows its beam date when that date is changed.
- 422 `STATUS_BEFORE_BEAM` (`details: { field: "statusDate", beamDate }`): the "since" date is before the beam's own date.
- Once the sizing screens exist the places will be changed by them; this form is for entering the beams the unit already has.

## Rules
- Only **active** beams are in the stock: a switched-off beam (`isActive: false`) or a deleted one is not counted or listed.
- Each company has its own stock. 403 without `WEAVING_MASTERS`.

## Database
Migration `20261210000001-weaving-beam-stock.js` (`yarn_beams.status`, `yarn_beams.statusDate`; old beams become EMPTY, dated like the beam). Run `npm run db:migrate`.
