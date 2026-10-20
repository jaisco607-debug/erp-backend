# SO Card + Jobs: what changed in the BACKEND and DATABASE (read this first)
This explains the server-side changes so the frontend knows exactly what exists. The screen guide is `so-card-thaans.md`.

## A. Database changes (migration 20261015000003)
| Table | Change | Meaning |
|---|---|---|
| `grey_lot_thaans` | `status` can now be `IN_STOCK`, `RETURNED` or **`SO_CARD`** | SO_CARD = this thaan went on an SO card |
| `grey_lot_thaans` | new column `soCardLotId` | which SO card line holds this thaan |
| `so_card_lots` | new columns `outBefore`, `balanceBefore` | the lot's "gone before" and "left before" at the moment the card was made |
| `jobs` | new columns `operatorName`, `operatorSetById`, `operatorSetAt` | operator typed by the receiving department |
| `grey_lots` (migration 20261015000002) | new columns `glm`, `gsm` | cloth weight, optional |

No table was removed and no old field was renamed. Old screens keep working.

## B. Backend rules
1. **SO card = one party.** All lots on ONE card belong to one party (`MIXED_CUSTOMERS` otherwise).
2. **Thaan-wise lots.** A lot with a thaan list gives whole thaans (`thaanNos`); its thaans become `SO_CARD` in grey. A lot without a thaan list gives `meters`.
3. **Sending cards to a department: ANY combination goes as ONE job (one Job#):**
   - one single card
   - several cards of the same party
   - several cards of DIFFERENT parties
   The job keeps every card's cloth separate inside it (job items per SO card and lot), so each party's cloth is never mixed in the accounts.
4. **Job list two ways:**
   - Job-wise: one row per job, with `soNos` = all its SO numbers.
   - SO-card-wise: one row per SO card inside each job (same Job# repeated on each row).
5. **Operator name** is set only by the receiving department.

## C. API endpoints (new or changed)
| Method + URL | What it does |
|---|---|
| GET `/so-cards/form-data` | Parties with their free lots. Each lot now has `glm`, `gsm`, `unit`, `isThaanWise`, `thaans` (free ones), `outwardMeters`, `balanceMeters`, `balancePieces` |
| GET `/so-cards/available-lots?customerId=` | Same lot objects |
| POST `/so-cards` | Lots as `{greyLotId, thaanNos:[..]}` or `{greyLotId, meters, pieces}` |
| PATCH `/so-cards/:id` | Same lot shape; old thaans are freed first |
| DELETE `/so-cards/:id` | Cancel; thaans go back to grey |
| GET `/so-cards/:id` | Card with full lot detail: glm, gsm, thaans, outBefore, balanceBefore, balanceAfter, yards, createdBy |
| **POST `/so-cards/send-many`** | NEW. `{ soCardIds:[1 or more], departmentId, colourId?, jobDate?, sentThrough?, remarks? }` creates ONE job for all those cards |
| POST `/so-cards/:id/send` | Old single send, still works (same as send-many with one id) |
| GET `/departments/CODE/incoming?view=job` | Job-wise list (default) |
| GET `/departments/CODE/incoming?view=so` | **SO-card-wise list**: one row per card per job |
| GET `/departments/CODE/sent?view=job` or `?view=so` | Same, for jobs this department sent |
| `...&soNo=4741` on the lists above | NEW filter: only jobs that contain SO# 4741 |
| PUT `/departments/CODE/jobs/JOB_ID/operator` | NEW. `{ operatorName }`, receiving department only |

## D. How to use "send" on the SO card list (one screen for all cases)
- Each row with `status === "NEW"` gets a checkbox. Rows of any party can be ticked together.
- Button "Send selected (N)" opens a modal: Department, Colour (optional), Sent through, Date, Remarks.
- ALWAYS call POST `/so-cards/send-many` with the ticked ids, even when only ONE card is ticked. Then there is a single code path.
- Response: `{ job: { jobNo, soNos, totalMeters, customers, toDepartmentName, ... }, soCards: [...] }`. Show "Job# 51 sent to Dyeing: SO# 4741, 4742".
- Errors: `CARD_SENT` (a ticked card was already sent), `NOTHING_LEFT`, `UNKNOWN_DEPARTMENT`.

## E. Department screen: two tabs
**Tab "Job Wise"** (`view=job`). Each row is a job:
- Job#, Date, From department, SO# (join `soNos`: "4741, 4742"), Parties (join `customers`), Qualities, Colour, Total meters, Status dropdown, Operator, Sent through.
- Expand a row to see `items`: SO#, Party, Lot#, Quality, Meters.

**Tab "SO Wise"** (`view=so`). Each row is one SO card inside a job:
- Job#, SO#, Party, Quality, Lot#s (`lotNos`), Colour, Meters (that card's share), Status, Operator.
- The same Job# shows on several rows when the job carried several cards. The status and operator belong to the JOB, so changing them on any row changes the whole job; reload the list after a change.

Filters on both tabs: SO# box (`soNo`), search (Job# or SO#), status, date from/to.

## F. Example
SO# 4741 (AZ Textiles, 630 m) and SO# 4742 (Gul Ahmed, 500 m) are ticked and sent to Dyeing:
- one job: Job# 51, totalMeters 1130, `soNos` [4741, 4742], `customers` ["AZ Textiles (130)", "Gul Ahmed (131)"]
- Job Wise tab: 1 row (Job# 51)
- SO Wise tab: 2 rows (Job# 51 / SO# 4741 / 630 m) and (Job# 51 / SO# 4742 / 500 m)
- `?soNo=4742` returns Job# 51
