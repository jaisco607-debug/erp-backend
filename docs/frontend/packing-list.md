# PACKING: department + packing list per SO card (thaan-wise, A / B / Cut Piece, rates)

## 1. What changed in the backend and database (migration 20261018000005)
- **Packing is now a department.**
  - The service `PACKING` changed from kind MODULE to kind **PACKING**, and its name is now "Packing".
  - It appears in `GET /departments` with `kind: "PACKING"`. New companies get it automatically.
- **Cloth comes to Packing only from Folding.**
  - Any other sender gets the error `PACKING_ONLY_FROM_FOLDING`.
  - Packing never sends cloth on (`PACKING_CANNOT_SEND`).
- **Packing only receives and accepts.**
  - Packing only has the **Receive** and **Accept** buttons (`canReject` is false).
  - Any other status gives the error `PACKING_ACCEPT_ONLY`.
  - Packing has no status dropdown, no Reject button and no send screen.
- **New tables:**
  - `packing_lists`: listNo (per company), soCardId, listDate, status DRAFT or FINAL, the head fields (description, madeFor, ctnQty, netWeight, grossWeight, remarks), rateA, rateB, rateCP, and who/when for created, updated and finalized.
  - `packing_list_lines`: lineNo, greyLotId, thaanId, thaanNo, grade (A / B / CP), meters.
- Everything is in the audit log.

## 2. Packing screens
1. **Incoming** (same as other departments): `GET /departments/PACKING/incoming`, with Receive and Accept.
2. **SO cards**: list of SO cards that reached Packing.
3. **Packing list form**: one SO card, all its lots and thaans.
4. **Packing lists**: saved lists, view, PDF.

## 3. SO cards list
`GET /departments/PACKING/packing/so-cards?tab=open|all&search=<SO#>&page=1&limit=20`
- `open` (the default) = still has cloth to pack.
```json
{ "data": [ {
  "soCard": { "id": "uuid", "cardNo": 5 }, "customer": { "name": "AZ" }, "quality": "PC TWILL", "colour": "BLACK",
  "cloth": { "soCardMeters": 300, "fromFoldingMeters": 300, "receivedMeters": 300, "packedMeters": 219, "leftToPack": 81 },
  "folding": { "a": 180, "b": 120, "cp": 0, "total": 300 },
  "listCount": 1 } ], "total": 1 }
```
- **Columns:**
  - SO#, Party, Quality, Colour
  - SO card meters (`soCardMeters`, what the card had)
  - From Folding (`fromFoldingMeters`)
  - Received (`receivedMeters`, accepted)
  - Packed, Left
  - Folding A / B / CP
- **Button:** "Make packing list" (enabled when `receivedMeters` > 0).

## 4. Packing list form
`GET /departments/PACKING/packing/so-cards/:soCardId/form`
```json
{ "soCard": {...}, "customer": {...}, "quality": "PC TWILL", "colour": "BLACK", "cloth": {...}, "folding": {...},
  "lots": [ { "id": "uuid (greyLotId)", "lotNo": 15, "meters": 300, "hasThaans": true, "thaanCount": 3,
    "thaans": [ { "thaanId": "uuid", "thaanNo": 1, "meters": 100, "grade": "A", "gradeText": "A", "suggestedMeters": 100,
                  "alreadyPacked": false, "onListNo": null } ] } ],
  "foldingPieces": [ { "pieceNo": 1, "grade": "A", "meters": 150 } ],
  "grades": [ { "value": "A", "text": "A" }, { "value": "B", "text": "B" }, { "value": "CP", "text": "Cut Piece" } ] }
```
**Screen layout:**
- **Head:** SO#, Party, Quality, Colour, Date, Description, Made for, CTN qty, Net weight, Gross weight, Remarks.
- **Cloth box:** "SO card 300 m, from Folding 300 m, received 300 m, packed 0 m".
- **Rates:** 3 boxes (A, B, Cut Piece) for Rs per meter. B and CP may stay 0.
- **One section per lot** ("Lot 15: 3 thaans, 300 m"). Each lot gets a table with one line per thaan, and the operator enters them one after another:
  - Thaan no
  - Meters box (prefill `suggestedMeters`)
  - Category toggle A / B / Cut Piece (prefill `grade`, Folding's choice)
  - Amount (meters x rate of that category)
  - Hide or grey out thaans with `alreadyPacked` and show "On list #2".
  - A checkbox per line to leave a thaan out of this list.
- **Lot without thaans** (`hasThaans` false): show "+ Add thaan" lines with meters and category. Thaan no is optional; the backend numbers them 1, 2, 3. You can prefill from `foldingPieces`.
- **Summary under each lot and at the bottom:** A, B and Cut Piece, each with thaans, meters, rate and amount, then the Total with thaans, meters and amount.

**Save:**
```json
POST /departments/PACKING/packing-lists
{ "soCardId": "uuid", "listDate": "2026-10-17", "description": "MEN'S SHIRT FABRIC", "madeFor": "USA",
  "ctnQty": null, "netWeight": null, "grossWeight": null, "remarks": "",
  "rateA": 50, "rateB": 25, "rateCP": 0,
  "lines": [ { "greyLotId": "uuid", "thaanId": "uuid", "grade": "A", "meters": 99 },
             { "greyLotId": "uuid", "thaanId": "uuid", "grade": "B", "meters": 120 },
             { "greyLotId": "uuid (meters-only lot)", "grade": "A", "meters": 150 } ] }
```

**Errors:**
| code | meaning |
|---|---|
| `NOTHING_RECEIVED` | Accept the cloth first |
| `UNKNOWN_LOT` | the lot is not on this SO card |
| `UNKNOWN_THAAN` | the thaan is not in that lot |
| `THAAN_REQUIRED` | the lot has thaans, so choose one |
| `DUPLICATE_THAAN` | the same thaan was sent twice |
| `THAAN_ALREADY_PACKED` | the thaan is on another list |

## 5. Packing list (response of save, edit and get)
`GET /departments/PACKING/packing-lists/:id`
```json
{ "id": "uuid", "listNo": 1, "listDate": "2026-10-17", "status": "DRAFT", "statusText": "Draft", "canEdit": true,
  "soCard": {...}, "customer": {...}, "quality": "PC TWILL", "colour": "BLACK", "cloth": {...},
  "description": "...", "madeFor": "USA", "ctnQty": null, "netWeight": null, "grossWeight": null, "remarks": null,
  "rates": { "A": 50, "B": 25, "CP": 0 },
  "lots": [ { "lotNo": 15, "thaans": [ { "thaanNo": 1, "grade": "A", "gradeText": "A", "meters": 99, "rate": 50, "amount": 4950 } ],
              "summary": { "A": {...}, "B": {...}, "CP": {...}, "total": {...} } } ],
  "summary": { "A": { "gradeText": "A", "thaans": 2, "meters": 179, "rate": 50, "amount": 8950 },
               "B": { "gradeText": "B", "thaans": 1, "meters": 120, "rate": 25, "amount": 3000 },
               "CP": { "gradeText": "Cut Piece", "thaans": 0, "meters": 0, "rate": 0, "amount": 0 },
               "total": { "thaans": 3, "meters": 299, "amount": 11950 } },
  "createdBy": {...}, "createdAt": "...", "finalizedBy": null, "finalizedAt": null }
```
**PDF** (the frontend makes it) uses the same shape as the demo:
- The head (Buyer = customer, Quality, Colour, SO#, Description, Made for, CTN, weights).
- One table per lot: Thaan# | Meters | Category | Rate | Amount.
- A category summary table, then the totals.

## 6. Edit, Final, Reopen, Delete
- **Edit (DRAFT only):** `PUT /departments/PACKING/packing-lists/:id` with any head fields or rates, and/or `lines`. When `lines` is sent, it replaces the whole list.
  For the edit form, call `GET .../so-cards/:soCardId/form?exceptListId=<id>` so that this list's own thaans do not show as "already packed".
- **Final (locks the list):** `POST /departments/PACKING/packing-lists/:id/final`. An empty list gives `NO_LINES`.
- **Reopen:** `POST /departments/PACKING/packing-lists/:id/reopen`.
- **Delete (DRAFT only):** `DELETE /departments/PACKING/packing-lists/:id`.
- A final list cannot be changed (`LIST_FINAL`).

## 7. Packing lists
`GET /departments/PACKING/packing-lists?soCardId=&status=DRAFT|FINAL&search=<list# or SO#>&dateFrom=&dateTo=&page=1&limit=20`
- Rows have the same fields without `lots`.
- **Columns:** List#, Date, SO#, Party, Quality, Colour, Thaans, Meters, A / B / CP meters, Amount, Status.
- **Buttons:** View, Edit, Final / Reopen, PDF.
