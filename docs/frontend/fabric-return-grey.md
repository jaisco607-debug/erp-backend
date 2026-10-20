# FABRIC RETURN GREY: unprocessed thaans go Grey Store -> Folding -> Packing -> gate pass

Example: a party sent 50 thaans, then says "give 20 back, process 30". The 30 go on an SO card as before. The other 20 are a **fabric return**.

## 1. What changed in the backend and database (migration 20261019000005)
- **New column `so_cards.isGreyReturn`.** A fabric return is a special SO card made by the Grey Store. It takes the thaans out of the lot (the lot balance goes down, the thaans become "SO card") and sends them straight to the Folding department as a job.
- **The tag travels with the SO card.** `isGreyReturn: true` and `tagText: "Fabric return grey (not processed)"` appear in every place that shows the SO card:
  - SO card (list and detail)
  - Job rows, job lists and incoming rows (`isGreyReturn` on the job; each SO card inside also has `soCard.isGreyReturn`)
  - Folding rows
  - Packing SO cards, the packing list form, the packing list and the gate pass
- **Folding:** the cloth cannot go to any department. Sending it to one gives the error **`GREY_RETURN_ONLY_PACKING`**. It also cannot be graded (`GREY_RETURN_NO_GRADING`). The only way on is **Send to Packing**.
- **Send to Packing** sends every thaan as it is, with no grading. In Packing they show as grade A, because nothing was graded. Rates are usually 0.
- **Packing** works as normal: Receive, Accept, packing list, Final, gate pass.
- Everything is audited as an SO card creation and a job send.

## 2. Grey Store screen: "Fabric return grey"
Add a button next to give-back in the Grey Store. It opens a screen like the SO card lot picker:
- Pick the party, then its lots, then tick the thaans (only thaans still in stock).
- A lot without a thaan list takes meters instead.

`POST /grey-lots/fabric-return` (needs FULL access to the Grey Store)
```json
{ "lots": [ { "greyLotId": "uuid", "thaanNos": [4, 5] },
            { "greyLotId": "uuid", "thaans": [ { "thaanNo": 7, "meters": 40 } ] },
            { "greyLotId": "uuid", "meters": 150 } ],
  "sentThrough": "Akram", "remarks": "", "cardDate": "2026-10-19" }
```
- The lines are the same as on an SO card (`thaanNos`, or `thaans` with part meters, or `meters`).
- All lots must belong to one party (`MIXED_CUSTOMERS`).
- Errors: `THAAN_NOT_IN_STOCK` (the thaan is already on an SO card or given back), `NOT_ENOUGH_METERS`, `NO_FOLDING` (the company has no Folding department), `LOT_NOT_APPROVED`.
- Response: the new SO card (`isGreyReturn: true`, `status: "SENT"`). It already sits in Folding's incoming list.
- This does not replace give-back (`/grey-lots/:id/give-back`), which is for cloth the party takes straight away without going through Folding and Packing.

## 3. Folding screens
- **Incoming:** the row shows the tag. Receive and Accept work as always.
- **Folding list and row** (`GET /departments/FOLDING/folding`, `.../folding/:jobId/:soCardId`) have `isGreyReturn` and `tagText`.
  - `canGrade` is false. Hide the A / B / CP boxes. Show "Not processed, send as it is".
  - `canSendPacking` is true after Accept. Show only **Send to Packing** (same API as before, no body needed).
- **Send screen** (`/departments/FOLDING/send-form`): rows have `soCard.isGreyReturn`. Show the tag, and for these rows enable only the Packing destination. Sending them to another department gives `GREY_RETURN_ONLY_PACKING`.
- The other Folding buttons (Re-work) do not apply to these rows.

## 4. Packing screens
- Incoming, SO cards, the form and the packing list have `isGreyReturn` and `tagText`. Show the red tag "Fabric return grey, not processed" in the header of each.
- Packing list: the lines come prefilled (every thaan, grade A). Hide or default the rate boxes to 0 for these lists.
- **Gate pass:** the GET has `isGreyReturn` and `tagText` too. Print the tag on all 3 copies.
- A fabric return SO card reaches Packing as its own SO card, so it never mixes with processed cloth on a packing list.
