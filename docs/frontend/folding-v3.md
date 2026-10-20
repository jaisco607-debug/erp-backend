# FOLDING v3: split each thaan into A / B / Cut Piece, lot by lot; what is left stays in Folding

This **replaces** folding-thaans.md. The endpoints `.../thaans` and the A / B / CP meter boxes are gone.

## 1. What changed in the backend and database (migration 20261019000002)
- **New table `folding_lines`:** one row per thaan, or one per whole lot when the lot has no thaans.
  - Columns: `aMeters`, `bMeters`, `cpMeters`.
  - Also `sentA`, `sentB`, `sentCP`: the part already sent to Packing.
- **New columns on `folding_entries`:**
  - `isClosed`: the row is closed, meaning "keep nothing more in Folding".
  - `closeNote`, `closedById`, `closedAt`.
- Folding now sends cloth to Packing with its own button. The meters sent are what was graded; the rest stays in Folding.
- Everything is in the audit log.

## 2. List: `GET /departments/FOLDING/folding?tab=all|open|draft&search=&page=`
- `open` = cloth still in Folding. `openCount` is returned for a badge.
- **Columns:**
  - Job#, SO#, Party, Quality, Colour
  - Received (`totals.received`)
  - A, B, CP (`totals.a`, `totals.b`, `totals.cp`)
  - Diff (`totals.diff`): red when minus (cloth shrank), green when plus
  - Sent to Packing (`totals.sent`)
  - Left in Folding (`leftInFolding`)
  - Status
- **Buttons on each row:** **Grade**, **Send to Packing** (when `canSendPacking`), and a "..." menu with Close / Open again and Re-work (the normal send screen).

## 3. Grade screen: `GET /departments/FOLDING/folding/:jobId/:soCardId`
```json
{ "jobNo": 14, "soCard": { "cardNo": 5 }, "quality": "PC TWILL", "colour": "BLACK", "pageNo": "7",
  "lots": [ { "lotId": "uuid", "lotNo": 15, "hasThaans": true, "thaanCount": 2, "received": 3000, "a": 1500, "b": 300, "cp": 150, "folded": 1950,
      "sent": 0, "inFolding": 1950, "notGraded": 1050,
      "lines": [ { "thaanId": "uuid", "thaanNo": 1, "label": "Thaan 1", "received": 2000, "a": 1500, "b": 300, "cp": 150,
                   "folded": 1950, "diff": -50, "notGraded": 50, "isGraded": true,
                   "sent": { "a": 0, "b": 0, "cp": 0, "total": 0 }, "inFolding": { "a": 1500, "b": 300, "cp": 150, "total": 1950 }, "cost": 6000 } ] },
    { "lotId": "uuid", "lotNo": 16, "hasThaans": false, "received": 500,
      "lines": [ { "thaanId": null, "label": "Whole lot", "received": 500, "a": 510, "b": 0, "cp": 0, "diff": 10 } ] } ],
  "totals": { "received": 3500, "a": 2010, "b": 300, "cp": 150, "folded": 2460, "diff": -1040, "sent": 0, "inFolding": 2460, "notGraded": 1050 },
  "leftInFolding": 3510, "isClosed": false,
  "cost": { "totalCost": 10500, "costPerMeter": 3 }, "categoryCost": { "a": 6030, "b": 900, "cp": 450 },
  "canGrade": true, "canSendPacking": true, "canClose": true }
```

**Screen layout:**
- **Top:** SO#, party, quality, colour, Page# box.
- **One card per lot:** "Lot 15 · 2 thaans · 3000 m".
- **Inside each lot, one line per thaan:**
  - Thaan | Received | **A** box | **B** box | **CP** box | Folded | Diff | Sent | Left
  - Tip: when the user types A, prefill B with (received - A) and leave CP at 0. They then only fix the numbers.
  - Show Diff in red when minus and green when plus. A plus means the cloth grew in processing.
  - Grey out a line that is fully sent.
- **Bottom bar (sticky):** totals for A, B, CP, Folded, Diff and Left in Folding, with the cost per category. Two buttons: **Save** and **Send to Packing**.

**Save** (only the lines that changed):
```json
PUT /departments/FOLDING/folding/:jobId/:soCardId/grades
{ "pageNo": "7", "lines": [ { "greyLotId": "uuid", "thaanId": "uuid", "a": 1500, "b": 300, "cp": 150 },
                            { "greyLotId": "uuid", "thaanId": null, "a": 510 } ] }
```
- `thaanId: null` = a lot without thaans.
- Errors: `NOT_ACCEPTED`, `ROW_CLOSED`, `SENT_FOR_REWORK`, `UNKNOWN_THAAN`, `DUPLICATE_THAAN`, `BELOW_SENT` (cannot go below what Packing already got).

## 4. Send to Packing (only graded cloth goes)
```json
POST /departments/FOLDING/folding/:jobId/:soCardId/send-packing
{ "keepRemaining": true, "closeNote": "", "sentThrough": "", "remarks": "" }
```
- Sends everything graded and not sent yet. Packing gets a new job, which it Receives and Accepts as before.
- Before sending, show a popup:
  "Sending A 2010, B 300, CP 150 = 2460 m. **Not graded: 1050 m.**"
  Then a toggle: **Keep the rest in Folding** (default ON) or **All sent, keep nothing** (OFF).
  - ON (`keepRemaining: true`): the rest stays and shows as "Left in Folding". Grade it later and send it again.
  - OFF (`keepRemaining: false`): the row closes, for example when the cloth shrank in processing. Add an optional note.
- Response: `{ "packingJob": { "jobNo": 31, "totalMeters": 2460 }, "row": {...} }`.
- Errors: `NOTHING_TO_SEND`, `NO_PACKING`.

## 5. Close / open again without sending
`PUT /departments/FOLDING/folding/:jobId/:soCardId/close` with `{ "isClosed": true, "closeNote": "shrinkage" }`, or `{ "isClosed": false }` to open the row again.

## 6. Other
- **Page#:** `PUT /departments/FOLDING/folding/:jobId/:soCardId` with `{ "pageNo": "7" }`.
- **Conf. toggle:** works as before. It needs something graded first (`NOTHING_GRADED`).
- **Re-work** (cloth back to Dyeing and so on): use the normal send screen. That row then shows "Sent for re-work to Dyeing" and cannot be graded.

## 7. Packing form changes (packing-list.md, section 4)
- Every thaan in `form.lots[].thaans[]` now has:
  - `folding: { a, b, cp }`: what Folding sent for it.
  - `suggestedLines: [{ grade, meters }]`: what is not on a packing list yet.
  - `packed: [{ grade, meters, listNo }]`.
- Lots without thaans have one entry with `thaanId: null`.
- **Prefill the packing table from `suggestedLines`.** One thaan can now have up to 3 lines (A part, B part, CP part).
- A thaan can be on a list once per category. Errors: `DUPLICATE_THAAN`, `THAAN_ALREADY_PACKED`.

## 8. Change 2026-10-19: grade boxes are for THIS BATCH only (bug: 5000 m selected again)
**Problem:** lot 5000 m, 4700 sent (A 4500, B 200), 300 kept in Folding. When grading the 300, the boxes still held 4500 / 200 and the "B = Received - A" prefill used 5000, so the whole 5000 looked selected again.

**Now:**
- Every line has a new field **`remaining`** = received - already sent (here 300). Use it instead of `received` for the prefill: B = `remaining` - A.
- The A / B / CP boxes show **`inFolding.a / .b / .cp`** (graded, not sent yet). After a send they are 0.
- `PUT .../grades` takes **only this batch**: `{ a: 250, b: 40 }` means 250 A + 40 B more. The backend adds what was sent before (line becomes A 4750, B 240). `BELOW_SENT` no longer happens.
- Show the line's old totals (`a`, `b`, `cp`, `sent.total`) as small grey text "Already sent 4700".
- **`diff`** is now shown only when the thaan is fully graded or the row is closed. 300 m still waiting in Folding is not a loss, so Diff stays 0 until then. When the row is closed (shrinkage), Diff shows -300.
- Send popup: "Sending 290 m. Left: 10 m" + the Keep / All sent toggle, as before.
