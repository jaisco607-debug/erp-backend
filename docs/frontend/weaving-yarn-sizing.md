# Weaving — Yarn Outward > Sizing (yarn + beams on one challan, gate pass) — Frontend Guide

**Weaving > Yarn Outward > Sizing.** The unit has no sizing department, so sizing is **outsourced**. Yarn bags **and** empty beams are sent to the **sizing party** on **one entry**: one **delivery challan** and one **gate pass**. Yarn stock and beam stock both follow.

**The sizing party is a Vendor** (we pay it for the work): choose it from the weaving vendor list (`GET /weaving/vendors`). (The bill for the sizing work comes in a later step.)

All calls are under `/api/v1/weaving`, service `WEAVING_MASTERS` (`VIEW` reads, `FULL` makes / changes / deletes).

## 1. Two kinds of yarn on the challan
1. **Yarn from our factory stock** (the normal yarn inward entries): it leaves our factory → its bags are on the challan **and on the gate pass**.
2. **Yarn delivered straight to the sizing party**: we bought yarn from a supplier and the supplier sent it **directly to the sizing party** (it never came to our factory). We still make the **Yarn Inward** entry (it is in our stock and is paid for like any purchase), but we mark it with the sizing party. On the sizing challan its bags are shown, but they are **not on the gate pass** (nothing left our factory).

### Yarn Inward form — new field (`weaving-yarn-inward.md`)
Add a switch **"Sent directly to the sizing party"**; when on, show a **Sizing party** dropdown (vendors). Send it as **`directVendorId`** on `POST /yarn-inwards` / `PATCH /yarn-inwards/:id` (`null` or left out = the yarn came to our factory). Every inward answer now has `sentDirect` (true / false), `directVendorId` and `directVendor: { id, code, name } | null`. Show a badge "Direct to <party>" in the list.
- Such yarn can go out **only on a sizing challan of that party**. It is **not in the pickers of Weft, Return and Sale** (422 `DIRECT_YARN_SIZING_ONLY` if sent anyway).
- Once yarn of the entry went out, the sizing party of the entry cannot be changed (422 `USED_IN_OUTWARD`).
- It is in the **Yarn Stock** like all yarn (inward − outward).

## 2. The new-sizing form
1. **Sizing party** (`vendorId`): vendor dropdown. Required.
2. **Date** (`outwardDate`, default today).
3. **Description** (optional, max 300).
4. **Yarn lines** (optional): `GET /weaving/yarn-sizing/stock-entries?sizingVendorId=<party id>&search=&itemId=&type=` — the stock entries with bags left: **the factory yarn** and **the yarn sent direct to this party** (other parties' direct yarn is not shown). Same row shape as the weft picker (`weaving-yarn-weft.md`) plus `sentDirect` / `directVendor` (show a "Direct" tag: its bags are not on the gate pass). The user types **Bags** (1 to `balanceBags`). Reload the picker when the party changes.
5. **Beams** (optional): `GET /weaving/yarn-sizing/beams?search=` — the **empty** beams (answer like the beam-stock details: `data: [{ id, beamNo, beamLabel, name, beamDate, statusDate, ... }]`). The user ticks the beams to send.
6. At least one yarn line **or** one beam is needed (422 `NOTHING_TO_SEND`).

## 3. API
| Call | Needs | |
|---|---|---|
| `GET /yarn-sizing/stock-entries?sizingVendorId=` | VIEW | yarn picker (above); `sizingVendorId` is required |
| `GET /yarn-sizing/beams` | VIEW | the empty beams that can go |
| `GET /yarn-sizing?page=&limit=&search=&dateFrom=&dateTo=&vendorId=` | VIEW | the list |
| `GET /yarn-sizing/:id` | VIEW | one challan (**print**) |
| `GET /yarn-sizing/:id/gate-pass` | VIEW | the gate pass |
| `POST /yarn-sizing` | FULL | make it, 201 |
| `PATCH /yarn-sizing/:id` | FULL | change `outwardDate`, `description`, `lines`, `beamIds` |
| `DELETE /yarn-sizing/:id` | FULL | delete: the yarn and the beams go back |

### Create
```json
{ "vendorId": "<sizing party>", "outwardDate": "2026-11-05", "description": "sizing job",
  "lines": [ { "inwardId": "<stock entry>", "bags": 4 }, { "inwardId": "<direct entry>", "bags": 3 } ],
  "beamIds": [ "<beam>", "<beam>" ] }
```
`lines` may be `[]` and `beamIds` may be `[]` (not both). The same entry / beam twice: 400.

### The challan
Same shape as the other challans (`weaving-yarn-weft.md`: `challanNo`, `challanText`, `outwardDate`, `description`, `party`, `lines`, `totalBags`, `totalLbs`) plus:
```json
{ "type": "SIZING", "party": { "kind": "VENDOR", "id": "...", "name": "Sizing Co" },
  "totalBags": 7, "totalLbs": 550,
  "factoryBags": 4, "factoryLbs": 400, "directBags": 3,
  "totalBeams": 2, "beams": [ { "id": "...", "beamNo": 1, "beamLabel": "00001", "name": "B1" } ],
  "lines": [ { "inwardId": "...", "inwardCode": 1, "party": { "name": "Yarn Mills" }, "yarnCount": {...}, "brand": {...}, "packing": 24, "lbsPerBag": 100, "bags": 4, "lbs": 400, "viaFactory": true } ] }
```
- `viaFactory: false` = yarn delivered straight to the sizing party.
- **Print the delivery challan with everything**: challan no, date, sizing party, the yarn lines (supplier, count, brand, packing, lbs per bag, bags, lbs — mark the direct ones), the beams (no. and name), totals (bags, lbs, beams), description.

### The gate pass — `GET /yarn-sizing/:id/gate-pass`
```json
{ "challanId": "...", "type": "SIZING", "date": "2026-11-05", "party": { "kind": "VENDOR", "id": "...", "name": "Sizing Co" }, "partyName": "Sizing Co",
  "challanNo": 1, "challanText": "00001", "bags": 4, "beams": 2, "copies": 3 }
```
**Date, party, delivery challan number, how many BAGS go and how many BEAMS go**, and a signature line (draw it yourself); print **3 copies**. `bags` is **only the yarn that leaves our factory** (`factoryBags`; the direct yarn is not counted) and `beams` is the number of beams. If nothing leaves the factory (only direct yarn and no beams) there is no gate pass: 422 `NOTHING_LEAVES` — hide the Gate pass button when `factoryBags` and `totalBeams` are both 0.

### The list
`{ data: [ { id, challanNo, challanText, outwardDate, description, partyName, lineCount, totalBags, totalLbs, factoryBags, directBags, totalBeams, brands, parties } ], page, limit, total, totals: { entries, bags, lbs, beams } }`. `search` finds the challan no, party, description, count or brand.

## 4. What happens to the stocks
- **Yarn Stock** (`weaving-yarn-stock.md`): the bags (factory and direct) are `outwardBags` / `outwardLbs`; the balance goes down. Yarn inward entries show `outwardBags` / `balanceBags`.
- **Beam Stock** (`weaving-beam-stock.md`): each beam goes **Empty → At sizing**, dated like the challan. In the At sizing details every beam now has **`sizing: { challanId, challanNo, challanText, partyName }`**: show "Sent on <statusDate> to <partyName> (challan 00001)".
- **Change / delete**: `PATCH` puts the old beams back first and takes the new ones (the stock is checked as if the old yarn and beams had not gone); `DELETE` puts the yarn back and the beams back to **Empty** with their old date.
- A beam that is on a sizing challan cannot be moved on the Beam form (422 `BEAM_ON_CHALLAN`, `details.challanNo`) or deleted: change / delete the challan instead. Disable the Place field / delete for such beams (`status = AT_SIZING`).
- The vendor used as a sizing party (or as the direct party of a yarn entry) cannot be deleted (422 `IN_USE`).

## 5. Errors
- 422 `BEAM_NOT_EMPTY` (`details: { beamId, beamNo, status }`): only **empty** beams go to sizing. 422 `UNKNOWN_BEAM`, `BEAM_INACTIVE`, `BEAM_DATE` (the challan is dated before the beam became empty).
- 422 `DIRECT_OTHER_PARTY` (`details: { line, inwardCode }`): direct yarn of another sizing party. 422 `DIRECT_YARN_SIZING_ONLY` (direct yarn on a weft / return / sale).
- 422 `NOT_ENOUGH_STOCK` (`details: { line, inwardCode, balanceBags, askedBags }`), `BEFORE_INWARD`, `UNKNOWN_STOCK_ENTRY`, `UNKNOWN_VENDOR` (the sizing party must be in the weaving vendor list), `NOTHING_TO_SEND`, `NOTHING_LEAVES` (gate pass).
- 400: no sizing party, the same entry / beam twice, bags not a whole number >= 1, bad date. 403 no access / `VIEW` only. 404 unknown challan / another company's.
- Sizing challans do not appear in the Weft / Return / Sale lists and the other way round.

## Not in this step
Receiving the full beams back from the sizing party (sizing inward) and the sizing charges / vendor bill come next; they will move the beams from At sizing to Full.

## Database
Migration `20261211000001-weaving-yarn-sizing.js` (`yarn_inwards.directVendorId`, `yarn_outward_beams`, challan type `SIZING`). Run `npm run db:migrate`.
