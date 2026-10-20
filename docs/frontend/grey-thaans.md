# Grey Inward update – 5 changes (frontend guide)
1) thaan-wise entry  2) yards / meters  3) give back to party  4) quality: dropdown OR typed  5) Lot#: automatic OR typed

Base `/api/v1`, header `Authorization: Bearer <token>`. Errors `{ error: { code, message } }`.
Run `npm run db:migrate` on the backend first.

## 1. New lot form (GREY INWARD)
New inputs:
- **Unit** toggle: `METER` | `YARD` (default METER). The unit the party sent the cloth in.
- **Thaan table**: one row per thaan. Columns: Thaan# (1, 2, 3 … automatic), Length (in the chosen unit), and a read-only column showing the other unit (yards → meters: × 0.9144; meters → yards: ÷ 0.9144, 2 decimals). Buttons: "+ Add thaan", remove row. Footer: Total thaans, Total meters, Total yards (live preview; server returns the real totals).
- Tip for fast entry: Enter key in a Length cell adds the next row.
- `pieces` and `inwardMeters` are NOT typed any more when thaans are entered; the server works them out.

POST `/grey-lots`
```json
{ "lotNo": 2437, "inwardDate": "2026-10-15", "customerId": "…", "qualityId": "…", "dcNo": "…", "partyRef": "", "vehicleNo": "", "remarks": "",
  "unit": "YARD", "thaans": [100, 100, 50, 50] }
```
(Old way still works for lots without a thaan list: `"unit": "METER", "inwardMeters": 1000, "pieces": 10` or `"unit": "YARD", "inwardYards": 1093.6, "pieces": 10`.)
Error `QTY_REQUIRED` if neither thaans nor a total is sent.

## 1b. Quality: pick OR type
The Quality field is a combo box (searchable dropdown that also accepts new text).
- Picked from the list (`GET /qualities?isActive=true`) → send `"qualityId": "…"`.
- Typed a name not in the list → send `"qualityName": "CVC 60/40"` (no qualityId). The server uses the existing quality with that name (any letter case) or adds it to the Quality list automatically, so next time it is in the dropdown.
- Send exactly ONE of `qualityId` / `qualityName` (both or none → 400 VALIDATION_FAILED). Same on edit (PATCH).
- Response always has `quality: { id, name }`.

## 1c. Lot#: automatic OR typed
- Show the next automatic number as a placeholder: `GET /grey-lots/numbering` → `{ nextLotNo, nextTypeNo }`.
- Leave the Lot# input empty → server gives the automatic number. Type a number → send `"lotNo": 2437`.
- Typed Lot# must be unused, else error `LOT_NO_TAKEN`. After a typed number the automatic numbering continues after it (typed 2437 → next auto 2438).
- Lot# can also be changed by PATCH `{ "lotNo": 2440 }` while the lot is not approved.

## 2. Lot response (list, detail, after save)
New fields on every lot:
```json
{ "unit": "YARD", "inwardMeters": 274.32, "inwardYards": 300, "pieces": 4,
  "outwardMeters": 0, "balanceMeters": 274.32, "balanceYards": 300,
  "soCardMeters": 0, "returnedMeters": 0, "returnedYards": 0, "returnedPieces": 0 }
```
Detail (`GET /grey-lots/:id`) and the responses of create / edit / give-back also have:
```json
"thaans": [ { "id": "…", "thaanNo": 1, "meters": 91.44, "yards": 100, "status": "IN_STOCK" } ],
"returns": [ { "id": "…", "returnNo": 1, "returnDate": "2026-10-15", "pieces": 2, "meters": 91.44, "yards": 100, "vehicleNo": "LES-1", "remarks": null } ]
```
Show BOTH meters and yards everywhere: e.g. `274.32 m / 300 yd`. Thaan status `RETURNED` = given back (grey it out).
List columns to add: Unit, Inward (m / yd), Balance (m / yd), Returned (thaans / m).

## 3. Edit lot
PATCH `/grey-lots/:id` – send `thaans` (the WHOLE list again) and/or `unit` to change quantities. Only while not approved.
Errors: `LOT_APPROVED`, `BELOW_OUTWARD` (less than already taken on SO cards), `LOT_HAS_RETURNS` (thaans were given back; list can't change), `QTY_REQUIRED` (unit changed without a quantity).

## 4. Give back to party (cloth returned unprocessed)
Use when the party sent e.g. 100 thaan and wants 50 back without processing. Button "Give back" on the lot detail.
Screen: list of the lot's thaans with checkboxes (only `IN_STOCK` ones enabled), date, vehicle no, remarks.
POST `/grey-lots/:id/give-back`
```json
{ "thaanNos": [51, 52, 53], "returnDate": "2026-10-15", "vehicleNo": "LES-1", "remarks": "party asked" }
```
For an old lot without a thaan list send `{ "meters": 400, "pieces": 4, ... }` instead of thaanNos.
Response = updated lot (returnedPieces, returnedMeters, balance down, thaans marked RETURNED, `returns` list).
That cloth can no longer go on an SO card. Its packing list / delivery print comes with the packing list step.
Errors: `THAAN_RETURNED`, `UNKNOWN_THAAN`, `PICK_THAANS` (lot has thaans: send thaanNos), `NOT_ENOUGH_METERS`.
Undo (client admin only): DELETE `/grey-lots/:id/give-back/:returnId` → updated lot.
