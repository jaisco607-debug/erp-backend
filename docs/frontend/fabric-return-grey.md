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

## 5. UPDATE 2026-10-20: the Fabric Returns screen needs only the GREY_STORE service
**Problem that was fixed:** a company with the Grey Store but without the SO Card service saw "no access" on Production > Outwards > Fabric Returns. Two backend causes, both fixed:
1. The screen had to read its list and its lot picker from the **SO card** APIs (`/v1/so-cards`, `/v1/so-cards/available-lots`), which need the `SO_CARD` service. The packing list and gate pass info came from the **Packing** APIs, which need `PACKING`.
2. `POST /v1/grey-lots/fabric-return` internally checked FULL access to the **SO card desk** (`SO_CARD`), even though the sender is the Grey Store. It now checks the **Grey Store**. A fabric return no longer needs `SO_CARD` at all.

**Use these three Grey Store APIs for the whole screen** (all need `GREY_STORE`; VIEW for the GETs, FULL for the POST):

| Screen part | API |
|---|---|
| List of fabric returns (with packing list + gate pass) | `GET /v1/grey-lots/fabric-returns?page=&limit=&search=&customerId=&dateFrom=&dateTo=` |
| One fabric return | `GET /v1/grey-lots/fabric-returns/:id` |
| "Fabric Inwards se return karein": party / lot / thaan picker | `GET /v1/grey-lots/fabric-return/lots?customerId=&search=&limit=` |
| Save the return | `POST /v1/grey-lots/fabric-return` (unchanged, section 2) |

**List answer** `{ data, page, limit, total }`. Each row is the same object an SO card has (`id`, `cardNo`, `idNo`, `cardDate`, `customer`, `quality`, `totalMeters`, `totalPieces`, `status`, `currentDepartment`, `lots[]` with `lotNo` and `thaans[]`, `tagText`, `isGreyReturn: true` ...) plus:
```json
{ "stage": "IN_FOLDING",
  "stageText": "Folding (In-Way)",
  "packingLists": [ { "id": "uuid", "listNo": 1, "listDate": "2026-10-20", "status": "FINAL", "statusText": "Final", "thaans": 2, "meters": 200,
                      "gatePass": { "gatePassNo": 1, "passDate": "2026-10-20", "vehicleNo": "LEA-1", "driverName": "Akram", "destination": "Faisalabad" } } ],
  "gatePassCount": 1 }
```
- `stage` goes: `NOT_SENT` > `IN_FOLDING` > `IN_PACKING` > `PACKING_LIST` > `DISPATCHED`. `stageText` is a ready line to show ("Folding (Queue)", "Packing (Pending)", "Packing list 1 made", "Dispatched (gate pass 1)").
- `packingLists[].gatePass` is `null` until the gate pass is made. A card can have several packing lists. Show the list no. and gate pass no. in the table.
- `GET /v1/grey-lots/fabric-returns/:id` gives the same row for one card, 404 if the id is not a fabric return.
- `GET /v1/so-cards?isGreyReturn=true|false` also works now (filter for the SO card screen).

**Frontend steps:**
1. The route guard of Production > Outwards > Fabric Returns must require **`GREY_STORE`** (not `SO_CARD`, `PACKING` or `FOLDING`).
2. Replace the calls of this screen with the three APIs above. Do not call `/v1/so-cards...`, `/v1/departments/PACKING/...` or `/v1/departments/FOLDING/...` from this screen.
3. If the page still says "no access", open the browser Network tab: the request that answers **403** is the one still using the wrong service. Its URL tells which service it needs.
4. **Folding is required to make a return.** Without the Folding department the save answers 422 `NO_FOLDING` ("Your company does not have the Folding department"). To finish the flow (receive, send to Packing, packing list, gate pass) the company also needs **Folding** and **Packing** from the super admin (Assign services > Process Management). Show the 422 message as it is, or hint "Ask your administrator to give Folding and Packing".

## 6. Fabric return is separate from the SO Card section (2026-10-20)
Fabric return grey has nothing to do with the SO Card section. It never appears in an SO Card list, never goes through the SO Card screens, and its meters are not "SO card meters". **The backend now hides it by itself: the frontend does not pass any filter.**

**Example:** a party sends **one lot of 10 thaans** and says "process 7, give me 3 back".
1. **Grey Store > Outwards > Fabric Returns:** pick the lot, tick thaans 8, 9, 10 (`GET /v1/grey-lots/fabric-return/lots`, then `POST /v1/grey-lots/fabric-return`). The 3 thaans go straight to **Folding** (300 m) and leave the lot. The lot balance is now 700 m.
2. **SO Card section:** the lot picker (`GET /v1/so-cards/available-lots`) offers **only thaans 1 to 7**. Make the SO card for the 7 as always (700 m); it goes to Dyeing and the other departments normally.
3. **Departments:** Dyeing gets only the 7-thaan card. Folding gets only the 3-thaan fabric return. They never mix.

Works in a company that has the Grey Store and the SO Card together, in any order, and in a company that has only the Grey Store (section 5).

### What the backend now hides from the SO Card section
| API | Before | Now |
|---|---|---|
| `GET /v1/so-cards` (SO Card list) | listed fabric returns too | **only normal SO cards**. `?isGreyReturn=true` shows only fabric returns (the Grey Store screen does not need it) |
| `GET /v1/so-cards/incoming?departmentId=` | included a fabric return waiting in Folding | **normal cards only**. A fabric return reaches Folding as a *job* (`/v1/departments/FOLDING/incoming`), as before |
| `GET /v1/jobs?side=out` with no `departmentId` (the SO card desk's sent jobs) | showed the fabric return job | **only jobs sent from the SO card desk** |
| Grey lot (`GET /v1/grey-lots`, `/:id`): `soCardMeters` | counted the fabric return meters | **SO cards only**. New field **`fabricReturnMeters`** holds the fabric return meters |
| Reports: SO Cards, SO Cards lots | listed fabric returns | **normal SO cards only** (`?isGreyReturn=true` shows only fabric returns) |
| Reports: Grey parties and Grey lots | "On SO cards" included fabric returns | "On SO cards" is SO cards only; `Fabric return grey (m)` is its own column (new column in Grey lots) |
| Report: Overview | counted fabric returns as SO cards | SO card counts and "Taken on SO cards" exclude them; new tile **Fabric return grey (m)** (`summary.grey.fabricReturn`) |

Still unchanged on purpose: Folding, Packing, packing list, gate pass and the Departments reports show a fabric return with its red tag `tagText` ("Fabric return grey (not processed)"), because the cloth really is there.

### What to change in the frontend
1. **SO Card screens** (Process Management > SO Card Summary, SO card lists, dropdowns, search): **no change needed.** The list already has no fabric returns. Do not show any "Fabric return" tag or button there.
2. **Fabric Inwards screen** (grey lot list and detail): `soCardMeters` no longer includes fabric returns. **Add a column "Fabric return (m)"** from `fabricReturnMeters`. Check that your totals still add up: inward = SO cards + fabric return + given back + balance.
3. **Fabric Returns screen** (Production > Outwards): keep using the three Grey Store APIs of section 5. This is the only place fabric returns are listed.
4. **Reports screen:** for the "Grey lots" report a new column `fabricReturnMeters` arrives by itself in `columns[]` (nothing to code if you build the table from `columns`). The Overview has one more tile (it comes in `rows`).
5. Keep the tag `tagText` on Folding, Packing, packing list and gate pass screens, as described in sections 3 and 4.

## 7. Fabric return has its own number: FR-1, FR-2 ... (2026-10-20, migration 20261020000003)
**What changed:** a fabric return no longer takes an SO number. It has its own series that starts at 1 and has no gaps: **FR-1, FR-2, FR-3 ...** The SO cards keep their own continuous series (1, 2, 3 ...). Because both series start at 1, **the same bare number can exist twice** (SO card 1 and FR-1). So a screen must never show the bare number alone: show the **label**.

Example: the first fabric return is `FR-1`; the first real SO card made after it is `SO# 1` (not 2).

**New fields (use them everywhere a screen shows "SO#"):**
| Where | Field | Value |
|---|---|---|
| SO card objects (`/v1/so-cards`, `/v1/so-cards/:id`, `/v1/grey-lots/fabric-returns`, `/v1/grey-lots/fabric-returns/:id`) | `cardLabel` | `"5"` for an SO card, `"FR-5"` for a fabric return |
| Every `soCard` object inside jobs, job items, send forms, Folding rows, Packing SO cards, the packing list form, the packing list, the gate pass, chemical requests and chemical cost reports | `soCard.cardLabel` | same |
| Jobs and chemical requests: the arrays of SO numbers | `soLabels` (next to the old `soNos`) | `["FR-1"]`, `["3", "4"]` |
| Chemical batch usage rows | `soLabels` | same |
| Reports: every "SO #" column | the column key is now **`cardLabel`** (text) | rows still carry `cardNo` (the number, for sorting) |
| `GET /v1/grey-lots/fabric-return/lots` | `nextCardNo`, `nextCardLabel` | the number the next fabric return will get, e.g. `1`, `"FR-1"` |

`cardNo` and `soNos` (numbers) stay in the answers, only for sorting or links. **Show `cardLabel` / `soLabels`.**

**Frontend steps:**
1. Replace every place that prints `cardNo` / `soCard.cardNo` / `soNos` as "SO#" with `cardLabel` / `soCard.cardLabel` / `soLabels` (Folding, Packing, packing list print, gate pass print, jobs lists, chemical request screens, SO card screens). For normal SO cards the label is the same digits as before, so nothing visible changes for them.
2. On the Fabric Returns form show "Next: FR-1" from `nextCardLabel`.
3. The packing list and gate pass print: the line that said "SO# 7" must now say "SO# 7" for an SO card or "FR-7" for a fabric return. Use `soCard.cardLabel` (with the red tag for fabric returns).
4. **Search boxes:** `FR-3` (also `fr3` or `fr 3`) finds only fabric return 3. A bare number (`3`) finds Job# 3 and SO# 3, and also FR-3 where fabric returns are searched. Works in the jobs lists, Folding, Packing, SO card list, Fabric Returns list and the reports `search` filter. You do not need to change the request, only tell users they can type FR-3.
5. Links: keep using `soCardId` / `id` to open a card. Never look a card up by its number: the number is not unique across the two series.

**Old data:** fabric returns made before this keep the number they already had and now show as `FR-<that number>` (for example `FR-19`, `FR-20`, `FR-21`); the next one continues from the highest (`FR-22`). The SO numbers they used up stay used (a gap in the SO series is expected for those old ones only).
