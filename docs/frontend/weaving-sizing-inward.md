# Weaving — Sizing Inward (sized beams come back) — Frontend Guide

**Weaving > Sizing Inward.** The yarn and beams we sent to the sizing party (`weaving-yarn-sizing.md`) come back sized. For every beam received the user writes **how many meters of yarn are on it**; the beam goes **At sizing → Full** in the Beam Stock. The sizing party charges **per lb, only for the lbs used in the sizing**; the leftover yarn is given back as **cut cone** (weighed in kg) and is **not charged**.

Example: 4 beams and 5000 lbs went. Pair 1 (2 beams) came back with 5000 m each, pair 2 with 4200 m each. 4800 lbs were used at Rs 10 per lb → the charge is 48,000. The 200 lbs left were given back as cut cone (weighed, e.g. 100 kg), no charge for them.

All calls are under `/api/v1/weaving`, service `WEAVING_MASTERS` (`VIEW` reads, `FULL` adds / changes / deletes).

## 1. The new-receipt form
1. **Sizing challan**: the challans that still wait for beams: `GET /sizing-inwards/challans?vendorId=&search=` →
   ```json
   { "data": [ { "id": "<challan id: send as outwardId>", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05", "description": "...",
                 "party": { "id": "...", "name": "Sizing Co" },
                 "sentBags": 50, "sentLbs": 5000, "usedLbs": 2400, "remainingLbs": 2600,
                 "pendingBeams": [ { "id": "<beam id>", "beamNo": 3, "beamLabel": "00003", "name": "B3", "sentOn": "2026-11-05" } ], "pendingCount": 2 } ], "total": 1 }
   ```
   A challan whose beams are all back is not in the list. `search`: challan no, party, description, beam name / no. Choosing a challan fills the **party** and shows the **beams waiting**, the **lbs sent** and the **lbs still to use** (`remainingLbs`).
2. **Date** (`inwardDate`, default today; not before the challan date).
3. **Beams**: tick the beams that came back (from `pendingBeams`; a challan can be received in parts) and type the **Meters** of yarn on each beam (> 0). At least one beam.
4. **Lbs used** (`lbsUsed`): the lbs of yarn that went into the sizing (the charged lbs). Required. Cannot be more than `remainingLbs` (422 `MORE_THAN_SENT`).
5. **Cut cone (kg)** (`cutConeKg`, optional, default 0): the leftover yarn the party gave back, weighed in kg. The server also shows it in lbs (`cutConeLbs` = kg × 2.2046).
6. **Rate per lb** (`ratePerLb`): the sizing charge per lb. Required.
7. Optional: **DC no** (`dcNo`, the party's own challan number, max 50), **Description**.
8. Show live: **Total meters**, **Sizing charge = lbs used × rate**. Useful hint: *left over = lbs remaining − lbs used* (compare with the cut cone weight).

## 2. API
| Call | Needs | |
|---|---|---|
| `GET /sizing-inwards/challans` | VIEW | the challans waiting for beams (above) |
| `GET /sizing-inwards?page=&limit=&search=&vendorId=&outwardId=&dateFrom=&dateTo=` | VIEW | the list, newest first |
| `GET /sizing-inwards/:id` | VIEW | one receipt (also adds `sentLbs`, `remainingLbs` of its challan) |
| `POST /sizing-inwards` | FULL | make a receipt, 201 |
| `PATCH /sizing-inwards/:id` | FULL | change it |
| `DELETE /sizing-inwards/:id` | FULL | delete: the beams go back to sizing |

### Create
```json
{ "outwardId": "<sizing challan>", "inwardDate": "2026-11-12", "dcNo": "SZ-77", "description": "first pair",
  "lbsUsed": 2400, "cutConeKg": 50, "ratePerLb": 10,
  "beams": [ { "beamId": "...", "meters": 5000 }, { "beamId": "...", "meters": 5000 } ] }
```
`beams`: 1 to 200, each beam once.

### The receipt
```json
{ "id": "...", "inwardNo": 1, "inwardLabel": "00001", "inwardDate": "2026-11-12", "dcNo": "SZ-77", "description": "first pair",
  "party": { "id": "...", "code": 1, "name": "Sizing Co" },
  "challan": { "id": "...", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05" },
  "beams": [ { "id": "...", "beamNo": 1, "beamLabel": "00001", "name": "B1", "meters": 5000 } ], "totalBeams": 2, "totalMeters": 10000,
  "lbsUsed": 2400, "cutConeKg": 50, "cutConeLbs": 110.23, "ratePerLb": 10, "amount": 24000 }
```
`inwardNo` is the running number of the receipts of the company. `amount` = `lbsUsed` × `ratePerLb` (the cut cone is not in it).

### The list
`{ data: [receipts], page, limit, total, totals: { entries, beams, meters, lbsUsed, cutConeKg, amount } }`. Columns: No, Date, Party, Challan, Beams (count), Meters, Lbs used, Cut cone (kg), Rate, Amount. `search`: receipt no, challan no, party, DC no, description.

### Change / delete
- `PATCH` takes any of `inwardDate, dcNo, description, lbsUsed, cutConeKg, ratePerLb, beams` (`beams` **replaces** the beams: they are put back at sizing and received again with the new meters / date).
- `DELETE` puts the beams back **At sizing** (with their old "sent on" date, no meters) and gives the lbs back to the challan.
- Both are refused while a beam of the receipt has **moved on** (it is not Full any more, e.g. put on a loom): 422 `BEAM_MOVED_ON` (`details: { beamNo, status }`).

## 3. What changes in the other screens
- **Beam Stock** (`weaving-beam-stock.md`): the received beams go **At sizing → Full**, dated like the receipt. Every **Full** beam now has **`meters`** (show a Meters column in the Full details). Beam answers (`GET /beams`, `GET /beams/:id`) also carry `meters` (null unless full).
- **Yarn Outward > Sizing** challan (`weaving-yarn-sizing.md`): once sized beams were received on it, the challan cannot be changed (only its description) or deleted: 422 `HAS_SIZING_INWARD` (`details.receipts`). Delete the receipts first.
- A beam that is at sizing and not received yet is still held by its challan (`BEAM_ON_CHALLAN` on the Beam form); a **Full** beam is free to be moved on the Beam form again.
- A vendor that has receipts cannot be deleted (422 `IN_USE`).

## 4. Errors
- 422 `BEAM_NOT_ON_CHALLAN` (`details: { line, beamId }`): the beam is not waiting at sizing on this challan (already received, or never sent). 422 `BEAM_NOT_AT_SIZING`.
- 422 `MORE_THAN_SENT` (`details: { sentLbs, usedLbs, remainingLbs }`): the lbs used of all receipts together are more than the challan sent.
- 422 `BEFORE_OUTWARD`: dated before the challan / before the beam went to sizing. 422 `UNKNOWN_CHALLAN`.
- 400: no beams, a beam twice, meters <= 0 or missing, `lbsUsed` / `ratePerLb` missing or negative, `cutConeKg` negative, bad date. 403 no access / `VIEW` only. 404 unknown receipt / another company's.

## Not in this step
The **sizing charge** is only recorded here (`amount`); making the vendor's bill / payment for it in the accounts comes later. The cut cone is recorded (kg and lbs) but not added to the yarn stock yet.

## Database
Migration `20261212000001-weaving-sizing-inward.js` (`yarn_sizing_inwards`, `yarn_sizing_inward_beams`, `yarn_beams.meters`). Run `npm run db:migrate`.
