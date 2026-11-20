# Weaving — Sizing Return (yarn / beams called back from the sizing party without sizing) — Frontend Guide

This is a **Weaving** screen, next to the sizing outward (Weaving > Yarn Outward > Sizing, `/weaving/yarn-sizing`): **we send yarn + beams to the sizing party from Weaving, and we call them back from Weaving** — the same service `WEAVING_MASTERS` (VIEW reads, FULL changes), base `/api/v1/weaving`. It is **not** part of the Sizing Management module (that only has the sizing batch). Yarn and empty beams go to a sizing party on a sizing challan. If we do **not** want them sized any more we call them **back**: some of the beams or all, some bags of the yarn or all, **only yarn**, or **only beams** (e.g. 6 beams + 20 bags sent: 2 beams and 10 bags come back). Every return is an **In Pass** (the challan + gate pass went out; the return comes in on an In Pass).

## The rules
- One return = one **In Pass** → `inPassNo` / `inPassLabel` ("00007"). It is the **same running number** as the In Passes of the sized beam receipts of the Sizing batch (`/sizing/receipts`): one sequence per company, never used again (also not after a delete).
- **Beams** come back from *At sizing* to **Empty** (dated like the return). Only beams still waiting at that party can come back (not the ones already received on a batch).
- **Yarn** comes back in **bags** of a weaving yarn inward entry; the lbs are bags × the lbs per bag of the entry. The yarn goes **back into the yarn stock** (Weaving > Yarn Stock / the entry's `outwardBags` and `balanceBags` count it in again), so it can be sent out again.
- Yarn that can come back = **sent to the party − tagged to its sizing batches − already returned**.
- A return needs at least one beam or one yarn row.

## Endpoints
**Pickers**
- `GET /weaving/sizing-returns/pending-beams?vendorId=<party>` → the beams still at that party (sent on a sizing challan, not received on a batch, not returned): `{ data: [ { id, beamNo, beamLabel, name, sentOn, challanNo, challanText } ], total }`.
- `GET /weaving/sizing-returns/yarn-available?vendorId=<party>&returnId=<id when editing>&search=` → `{ data: [ { inwardId, inwardCode, inwardDate, dcNo, name, yarnCount, lbsPerBag, sentLbs, taggedLbs, returnedLbs, availableLbs, availableBags } ], total }` — only entries with `availableBags > 0`. Show "DC / lot", name, **sent**, **available bags**; the user types the bags (1 … `availableBags`). While editing a return pass its id as `returnId` so its own bags count as free.
- The sizing party dropdown: `GET /weaving/vendors?isActive=true`.

**Create** `POST /weaving/sizing-returns`
```json
{ "vendorId": "<sizing party>", "returnDate": "2026-11-12", "refNo": "GP-5", "notes": "not sized",
  "beamIds": ["<beam id>", "<beam id>"],
  "yarns": [ { "inwardId": "<yarn inward id>", "bags": 10 } ] }
```
`vendorId` required; `returnDate` = today if empty; `refNo` (the party's gate pass / DC no), `notes`, `beamIds`, `yarns` optional but **at least one beam or one yarn row** (422 `NOTHING_RETURNED`). 201 → the return:
```json
{ "id": "...", "inPassNo": 7, "inPassLabel": "00007", "returnDate": "2026-11-12", "refNo": "GP-5", "notes": "not sized",
  "party": { "id": "...", "code": 12, "name": "Sizing Co" }, "kind": "BOTH",
  "beams": [ { "id": "...", "beamNo": 1, "beamLabel": "00001", "name": "S1", "status": "EMPTY", "statusText": "Empty" } ],
  "yarns": [ { "id": "...", "inwardId": "...", "inwardCode": 1, "dcNo": "DC-1", "inwardDate": "...", "yarnCount": { "id": "...", "name": "60/s CTN" }, "name": "...", "bags": 10, "lbsPerBag": 100, "lbs": 1000 } ],
  "totalBeams": 2, "totalBags": 10, "totalLbs": 1000 }
```
`kind`: `BOTH` | `BEAMS` | `YARN`.
Errors (422): `MORE_THAN_AVAILABLE` (`details.availableBags`, line number in `details.line`), `YARN_NOT_SENT` (this yarn did not go to this party), `BEAM_NOT_AT_PARTY` (not waiting at this party / already received or returned), `BEFORE_OUTWARD` (dated before the beam went to sizing), `DUPLICATE_BEAM`, `DUPLICATE_YARN`.

**List** `GET /weaving/sizing-returns?search=&vendorId=&dateFrom=&dateTo=&page=&limit=` → `{ data: [ return… ], page, limit, total, totals: { returns, beams, bags, lbs } }`. `search` finds the In Pass number, party, ref no, notes, beam name / no, yarn DC no / entry no. Columns: IP#, date, party, ref no, beams, bags, lbs, notes.
**One** `GET /weaving/sizing-returns/:id`.
**Change** `PATCH /weaving/sizing-returns/:id` `{ returnDate?, refNo?, notes?, beamIds?, yarns? }` — `beamIds` / `yarns` **replace** the lists (beams go back to sizing and are returned again). The In Pass number stays.
**Delete** `DELETE /weaving/sizing-returns/:id` → `{ deleted: true, id }` — the beams go back *At sizing*, the yarn leaves the stock again. 422 `BEAM_MOVED_ON` if a returned beam is not *Empty* any more (it was used / sent again); 422 `YARN_ALREADY_USED` if the returned yarn was already sent out again (the return can no longer be taken back).

## Other effects
- **Beam Stock**: returned beams move *At sizing* → *Empty*.
- **Yarn Stock / yarn inward**: returned bags reduce `outwardBags` (`GET /weaving/yarn-stock`, `GET /weaving/yarn-inwards` → `outwardBags`, `balanceBags`).
- **Sizing batch**: the yarn picker (Sizing module, `GET /sizing/yarn-available`) no longer offers what came back (`availableLbs` is lower).
- A weaving **yarn inward entry** that has a sizing return cannot be deleted (422 `IN_USE`, `details.sizingReturns`): delete the return first.
- A **sizing challan** (Weaving > Yarn Outward, type sizing) whose yarn/beams were returned (or are in a batch) cannot be changed or deleted (422 `HAS_SIZING_BATCH`): delete the return / batch entry first.
- Reporting: every In Pass of the module = the sized beam receipts (`/receipts`, `inPassNo`) + the returns (`/returns`, `inPassNo`).

## Database
Migration `20261230000001-sizing-return.js` (tables `sizing_returns`, `sizing_return_beams`, `sizing_return_yarns`). Run `npm run db:migrate`.

## Record badges ("Returned" on the challan, "Sent again" on the return)
No new endpoints or tables: extra fields on existing answers, computed on read (they follow edits and deletes at once; deleted returns / challans never count). Old fields are unchanged.

### 1. Sizing challan — `GET /weaving/yarn-sizing` (every row) and `GET /weaving/yarn-sizing/:id`
| field | meaning |
|---|---|
| `returnedBags` | bags of this challan's yarn that came back through sizing returns (0 if none) |
| `returnedBeams` | beams of this challan that came back (0 if none) |
| `returnCount` | number of distinct returns that touched this challan (its beams or its yarn) |
| `hasReturn` | `returnCount > 0` |
Detail only: every `lines[]` row has `returnedBags`; every `beams[]` row has `returned` (true / false).
Show: "Returned · 4 bags · 1 beam" (only "Returned" if both counts are 0).

**Rules used**
- **Beams**: a returned beam counts against the **latest sizing challan of that beam (same sizing party) dated on or before the return date**. (A beam sent, returned, sent again and returned again counts once on each challan.)
- **Yarn — FIFO**: the bags returned of one yarn inward entry from one party are given to the challans that sent that entry to that party **oldest first** (returns taken in the order of their date and In Pass no), **never more than the bags that challan sent**. A return that is bigger than the oldest challan's bags spills into the next one and touches both (both get `returnCount` +1).

### 2. Sizing return — `GET /weaving/sizing-returns` (every row) and `GET /weaving/sizing-returns/:id`
| field | meaning |
|---|---|
| `sentAgainBags` | bags of this return's yarn that went out again on a **new sizing challan** (any party) |
| `sentAgainBeams` | beams of this return that went out again on a new sizing challan |
| `sentAgain` | true if either number is above 0 |
| `sentAgainChallans` | `[ { id, challanNo, challanText, outwardDate } ]` the challans it went out on (sorted by date) |
Detail rows too: every `yarns[]` row has `sentAgainBags`; every `beams[]` row has `sentAgain`.
Show: "Sent again · 1 beam"; `sentAgain: false` → green "In stock".

**Rules used**: only **sizing** challans count (not weft, sale, return); only challans dated **after the return date** (on the same day only if the challan was made after the return was saved, so the challan the yarn originally went out on never counts). Yarn: the bags of the same entry on those challans, **capped at the bags of the return line** (10 returned, 4 sent again → 4).

### Side effect
Deleting a sizing challan is only blocked by a return that **came after it** (the one that returned its yarn / beams). A later challan that sent already-returned yarn / beams again can be deleted — the return then goes back to `sentAgain: false`.
