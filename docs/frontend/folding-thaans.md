# FOLDING v2: grading per thaan (A / B / Cut Piece), cost per category, lot thaans and meters

**Why your screen shows A / B / CP already filled:**
- Those numbers were typed earlier with the old meter boxes. They are still saved in the database.
- From now on the A, B and CP numbers are only the result of the thaan grading below.
- The screen must not show typing boxes for A, B and CP any more.

The flow is the same as in other departments (department-flow-v2.md):
In-Way, then Receive (Queue), then Accept (Pending), then Processing, then Complete.
Reject and the answer to a rejection work the same way too.
Grading is allowed only after Accept (`canGrade`).

## 1. Database (migrations 20261018000003 + 20261018000004)
- New table `folding_thaans` with one row per thaan or piece.
  - Columns: `jobId`, `soCardId`, `grade` (A, B or CP) and `meters`.
  - Each row also has either `thaanId` (the lot's own thaan) or `pieceNo` (a piece that Folding made for a meters-only lot).
- The `aMeters`, `bMeters` and `cpMeters` of `folding_entries` are the sums of these rows.
- Every save is in the audit log.

## 2. Screen flow
**Step 1: list.** `GET /departments/FOLDING/folding` returns one row per SO card per Job.
Columns:
- Job#, SO#, Party, Quality, Colour
- Lot (`lots`: lot no, thaans, meters)
- Thaans ("2 / 3 graded")
- A, B, CP, Total
- Total Cost
- Status, Conf.
Each row has a **Grade** button, shown when `canGrade` is true.

**Step 2: open one SO card.** `GET /departments/FOLDING/folding/:jobId/:soCardId` returns the same row object.
Show:
- **Top box:** SO#, party, quality, colour.
- **Lot box:** for each lot, "Lot 15: 3 thaans, 300 m", and the total (`lotSummary`).
- **Thaan table:** one line per thaan:
  - Thaan no
  - Meters
  - Category toggle: A / B / Cut Piece
  - Folded meters box (optional)
  - Cost
- **Category summary** (`categories`): one card each for A, B, Cut Piece, Not graded and **Total**. Each card shows its thaans, meters and cost.

## 3. Row object (list and Step 2)
```json
{ "jobId": "uuid", "jobNo": 14, "soCard": { "id": "uuid", "cardNo": 5 }, "quality": "Cream Cake", "colour": "BLACK",
  "canGrade": true, "hasThaans": true, "thaanCount": 3, "gradedThaans": 3,
  "lots": [ { "id": "uuid", "lotNo": 15, "thaans": 3, "meters": 300 } ], "lotSummary": { "thaans": 3, "meters": 300 },
  "stock": { "a": 100, "b": 118, "cp": 80, "total": 298 },
  "cost": { "previousChemicalAmount": 900, "foldingChemicalAmount": 0, "totalCost": 900, "costPerMeter": 3 },
  "thaans": [ { "thaanId": "uuid", "thaanNo": 1, "meters": 100, "grade": "A", "gradeText": "A", "foldedMeters": 100, "cost": 300 } ],
  "categories": {
    "A":  { "gradeText": "A", "thaans": 1, "meters": 100, "cost": 300 },
    "B":  { "gradeText": "B", "thaans": 1, "meters": 118, "cost": 360 },
    "CP": { "gradeText": "Cut Piece", "thaans": 1, "meters": 80, "cost": 240 },
    "notGraded": { "thaans": 0, "meters": 0 },
    "total": { "thaans": 3, "meters": 298, "cost": 900 } } }
```
- A thaan's `cost` is its meters x `costPerMeter`.
- `costPerMeter` includes the chemical cost of all earlier departments plus Folding's own.

## 4. Save: lot WITH thaans (`hasThaans` = true)
```json
PUT /departments/FOLDING/folding/:jobId/:soCardId/thaans
{ "pageNo": "7", "thaans": [ { "thaanId": "uuid", "grade": "A" }, { "thaanId": "uuid", "grade": "B", "meters": 118 } ] }
```
- Only the thaans you send are changed.
- `grade: null` clears a thaan's category.
- If you leave `meters` out, the thaan's own meters are used.

## 5. Save: lot in meters only (`hasThaans` = false, the "Meters only" rows)
Folding makes the thaans (pieces) itself. Show a table with **+ Add thaan** and these columns:
- Meters
- Category toggle

Send the whole list each time. The pieces are numbered 1, 2, 3 in the order you send them.
```json
PUT /departments/FOLDING/folding/:jobId/:soCardId/thaans
{ "pageNo": "7", "pieces": [ { "grade": "A", "meters": 150 }, { "grade": "B", "meters": 100 }, { "grade": "CP", "meters": 45 } ] }
```
- In `thaans` these pieces come back with `isFoldingPiece: true` and `thaanNo` = the piece no.
- Show "Lot meters: 300, pieces made: 295" using `lotSummary.meters` and `categories.total.meters`.

## 6. Conf. toggle
- Works as before.
- Every thaan or piece must have a category first. Otherwise you get the error `THAANS_NOT_GRADED`.

## 7. Errors
| code | meaning |
|---|---|
| `NOT_ACCEPTED` | the cloth is not accepted yet |
| `ROW_CONFIRMED` | turn Conf. off before changing |
| `USE_THAANS` | this lot has thaans; send `thaans`, not `pieces` and not meter boxes |
| `USE_PIECES` | this is a meters-only lot; send `pieces` |
| `UNKNOWN_THAAN` | the thaan is not in this SO card |
| `DUPLICATE_THAAN` | the same thaan is sent twice |
| `THAANS_NOT_GRADED` | some thaans have no category yet |

## 8. Reject and send on
These work the same as in other departments.
- **Reject** sends the cloth back to the department it came from.
- **Send** can go to any department, for example back to Dyeing with instructions. That cloth is marked RE-WORK.
- Sending to Packing comes in the packing step.
