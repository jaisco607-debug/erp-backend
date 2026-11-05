# Width of the grey cloth — Frontend Guide

When grey cloth is received in the **Grey Store** (Grey Inward), the user can now enter the **width** of the cloth, **per thaan** or **one width for the whole lot**. The width then goes with the cloth: SO Card, the department jobs, Folding and Packing, up to the Packing List. Nobody types it again.

Width is **optional** (old lots and old screens keep working; a lot without a width shows `null`). The width is in **meters** (for example `1.60` or `1.75`): a plain number, up to 2 decimals, bigger than 0 and at most 9999. Label the box and the columns **Width (m)** on every screen.

## 1. Grey Inward (create / edit a lot)
`POST /grey-lots` and `PATCH /grey-lots/:id` take:

| Field | Meaning |
|---|---|
| `width` | the width of the **whole lot**: every thaan without its own width gets it. `null` clears it |
| `thaans` | still the list of lengths. **Each item can now be a number (as before) or an object `{ "length": 120, "width": 1.58 }`** when that thaan has its own width |

Examples
```json
{ "inwardDate": "2026-10-15", "customerId": "...", "qualityId": "...", "width": 1.63, "thaans": [100, { "length": 120, "width": 1.58 }, 80] }
```
Thaan 1 and 3 get 1.63 m, thaan 2 gets 1.58 m. The old body (`thaans: [100, 120, 80]`) works exactly as before.

On the screen: add a **Width** box to the lot form (the lot's width) and a **Width** column in the thaan table (each thaan's width; pre-fill it from the lot's width and let the user change a row). Send a thaan as `{length, width}` only when it has a width; sending a plain number means "use the lot's width".

For a lot without a thaan list (a plain total + pieces) only the lot `width` is used.

### Editing rules
- Only an unapproved lot can be edited (as before).
- `PATCH` with only `width`: the thaans that are still free (not on an SO card, not given back) and have no own width, or had the old lot width, take the new one. A thaan with a different width of its own is not changed.
- `PATCH` with `thaans` again: a thaan sent as a plain number **keeps the width it had** (unless you also send a new lot `width`, then that one is used). A thaan sent as `{length, width}` gets that width.
- A thaan that is already on an SO card or given back cannot be changed (as before), width included.
- `width: 0`, a negative number, text or more than 9999 gives 400.

### What comes back (lot JSON, list and single)
```
{ ..., width: 1.6, widths: [1.58, 1.6, 1.63],        // the lot's width, and every width in the lot (sorted, no repeats)
  thaans: [{ id, thaanNo, meters, yards, width: 1.6, status, takenMeters, freeMeters }, ...] }   // width = the thaan's own width, else the lot's, else null
```
Use `widths` for a list column: show `1.63` when there is one value, `1.58 – 1.63` or `1.58, 1.6, 1.63` when there are several, blank when empty.

## 2. SO Card
- The "pick lots / thaans" lists (`GET /so-cards/available-lots` and the card's own form) now have `width` on every lot and on every thaan row (`thaans[].width`). Show it in the thaan picker.
- The SO card JSON (`lots[]`): `width`, `widths`, and `thaans[].width` (the width of each thaan taken on this card). Show it on the card view and on the printed card.

## 3. Department jobs (Singeing, Dyeing, Finishing ... )
Each job item (`GET /departments/:code/jobs/:id`, the job lists and the "send" forms that show the item): `width`, `widths`, and `thaans[].width` next to the thaan number and meters.

## 4. Folding
`GET /departments/FOLDING/folding/:jobId/:soCardId`: every lot has `width` and `widths`, and every line (a thaan, or "Whole lot") has `width`. Show it in the grading table.

## 5. Packing
- The packing form (`GET /departments/PACKING/packing/so-cards/:id/form`): `lots[].width`, `lots[].widths`, `lots[].thaans[].width`.
- The Packing List (`GET /departments/PACKING/packing-lists/:id`, and what create / update return): every line `lots[].thaans[]` has **`width`**. Show it as a column on the packing list and on the printed list.

## 6. Reports (and their Excel / PDF exports)
The report endpoints now have a **Width (m)** column (key `width`, label `Width (m)`, type `list`: a text like `1.63` or `1.58, 1.6, 1.63` when the thaans have different widths, empty when no width was typed). The server sends the same `columns` and `rows` as always, so the Width column is simply one more column: show it on the screen and **keep it in the Excel / PDF exports you build from the report columns** (nothing else to do if your export loops over `columns`).

| Report | Endpoint | Width column |
|---|---|---|
| Grey store: lot wise | `GET /reports/grey/lots` | per lot (all widths of its thaans) |
| Grey given back | `GET /reports/grey/returns` | per return (widths of the thaans given back) |
| SO cards with lots and thaans | `GET /reports/so-cards/lots` | per card and lot (widths of the thaans on the card) |
| One SO card, in full | `GET /reports/so-cards/:id` | sections "Lots and thaans" and "Where the cloth is now" |
| Cloth now (active fabric) | `GET /reports/cloth-now`, `/reports/active-fabric` | per row (all widths of its lots) |
| Folding | `GET /reports/folding` | per job (all widths of its lots) |
| Packing lists: thaan wise | `GET /reports/packing-lists?view=lines` | per thaan line, a number |

Not given a width column: reports that only total meters (party, department, operator, chemical, cost and ledger reports).

## Notes
- The width is stored once, on the thaan (and the lot). SO cards, jobs, Folding and Packing read it from there, so it is **always the width typed at inward**; there is nothing to enter again in the later screens.
- Old lots and thaans have no width (`null`); show `-`.
- Not changed: the Sales Invoice and the Gate Pass (no width column there).

## Database
Migration `20261123000001-grey-width.js`: `grey_lots.width` and `grey_lot_thaans.width` (run `npm run db:migrate`).
