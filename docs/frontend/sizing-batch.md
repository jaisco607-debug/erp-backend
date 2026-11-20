# Sizing Management — Sizing Batch (new module) — Frontend Guide

A new **separate module** with its own service **`SIZING`** ("Sizing Management", tab group `WEAVING` in the service list; put it in the menu wherever you like). 


Base: **`/api/v1/sizing`**. `SIZING` VIEW reads, `SIZING` FULL changes. A company gets the service from the super admin / client admi
n like the others (it was given to every company that already has `WEAVING_MASTERS`). The module does **not** need access to the weaving masters: its own `form-data` returns the lists it needs.

## What it is
Yarn and **emp
ty beams** go to a **sizing party** (a weaving vendor) on a **sizing challan** (Weaving > Yarn Outward / "yarn-sizing", unchanged). When the sized beams come back they are linked to a **Sizing Batch** (= one *set*):
1. Make the **batch** (party, set #, ends, yarn count, notes) — a *draft*.
2. **Tag the yarn** that went for this set (weaving yarn inward entries, lbs of each).
3. **Receive the beams** (length of each) and the **cut cones** (type, kgs, cones, bags) — each time one "Sized beam / cut cones inward" with a **GRN#**.
4. Billing: rate per lb → amount. **Confirm** (= approve). The confirmed batch can then be put on a **purchase invoice** in the Accounts.

> The old *Weaving > Sizing Inward* (`/weaving/sizing-inwards`) is **not used by this flow any more** (the endpoints still exist, unchanged; do not show that screen). A contract is **not** part of the batch for now.

## 1. Screens ↔ endpoints
| Screen (old software) | Endpoints |
|---|---|
| Sizing batches list (All / Drafts) | `GET /batches` |
| Sizing batch form | `GET /batches/form-data`, `POST /batches`, `GET/PATCH/DELETE /batches/:id`, `POST /batches/:id/confirm`, `POST /batches/:id/reopen` |
| Yarn tagged to this batch (DC/LOT picker) | `GET /yarn-available`, `POST /batches/:id/yarns`, `PATCH/DELETE /batches/:id/yarns/:tagId` |
| Beam inward ("Sized beam / cut cones inward") | `GET /pending-beams`, `POST /batches/:id/receipts`, `GET/PATCH/DELETE /receipts/:id` |
| Sized beam inward summary | `GET /receipts` |
| Accounts: purchase invoice | `GET /api/v1/purchase-invoices/sizing-batches`, `POST /api/v1/purchase-invoices` (see §6) |

## 2. The batch form
`GET /batches/form-data` → `{ date, adjustmentLimitLbs: 10, coneTypes: ["CutCone"], defaultConeType, kgToLbs, vendors: [{id,code,name}], yarnCounts: [{id,code,name}] }` — **Sizing party** dropdown = `vendors`, **Yarn count** dropdown = `yarnCounts` (the Yarn Count master).

**Create** `POST /batches`
```json
{ "vendorId": "...", "batchDate": "2026-11-16", "setNo": "12331", "ends": 6054, "yarnCountId": "...",
  "quality": "60X60/90X82=136\"CTN", "notes": "6/s ctn(ends 6054)", "ratePerLb": null, "adjustmentLbs": 0,
  "yarns": [ { "inwardId": "...", "lbs": 2740 } ] }
```
Required: `vendorId`, `setNo`, `ends`, `yarnCountId`. `batchDate` = today if empty. `quality` (free text), `notes`, `ratePerLb`, `adjustmentLbs` and `yarns` are optional on create (all can be set later while it is a draft). **`ends` = ends *per beam*** (the number of threads wound on each beam). The batch number runs per company (`batchNo` / `batchLabel` "00269"). 201 → the whole batch (§3).

**Change** `PATCH /batches/:id` `{ batchDate?, vendorId?, setNo?, ends?, yarnCountId?, quality?, notes?, ratePerLb?, adjustmentLbs? }` — **drafts only** (422 `BATCH_CONFIRMED` once confirmed). The sizing party cannot change once yarn is tagged or a beam receipt exists (422 `USED_IN_BATCH`). `adjustmentLbs` must be −10 … +10 (else 400).

**Delete** `DELETE /batches/:id` — a draft with **no beam receipts** (422 `HAS_RECEIPTS` otherwise; delete the receipts first). Its tagged yarn is freed.

## 3. One batch — `GET /batches/:id`
```json
{ "id": "...", "batchNo": 269, "batchLabel": "00269", "batchDate": "2026-11-16", "setNo": "12331", "ends": 6054, "quality": "...", "notes": "...",
  "party": { "id": "...", "code": 148, "name": "ZOHAIB INDUSTRIES" }, "yarnCount": { "id": "...", "name": "60/s CTN" },
  "status": "DRAFT", "statusText": "Draft",
  "yarnTaggedLbs": 4110, "yarnLots": 2, "warpLengthM": 31290, "beamCount": 6, "coneKg": 152, "coneLbs": 335.1, "warpWeightLbs": 3774.9,
  "actualCount": 65.3, "nominalCount": 60, "countVariancePercent": 8.8, "countWarning": false,
  "billing": { "yarnIssuedLbs": 4110, "coneKg": 152, "coneLbs": 335.1, "warpWt": 3774.9, "adjustmentLbs": 0, "adjustmentLimitLbs": 10, "netWarpWt": 3774.9, "ratePerLb": 12.5, "amount": 47186.25 },
  "purchaseInvoice": null, "invoiced": false, "billedAmount": 0, "noYarnTagged": false,
  "canEdit": true, "canConfirm": false, "canReopen": false, "canDelete": false, "canInvoice": false,
  "readiness": { "notes": true, "yarn": true, "beams": true, "rate": false, "weight": true },
  "yarns": [ ... ], "receipts": [ ... ], "beams": [ ... ], "cutCones": [ ... ] }
```
- **Pills** (top of the form): *Yarn tagged* `yarnTaggedLbs` · `yarnLots` lots (red when `noYarnTagged`), *Warp length* `warpLengthM` m · `beamCount` beams, *Cut cones* `coneKg` kg · `coneLbs` lbs, *Warp weight* `warpWeightLbs`, *Actual count* `actualCount`.
- **Actual count** (the "ACTUAL" field, read-only, calculated by the server): the English cotton count  
  `actual = ends × (total length of the received beams in yards) ÷ (840 × warp weight in lbs)` (1 m = 1.0936 yd). It is `null` until beams and yarn exist. `nominalCount` is the number in the yarn count's name ("60/s CTN" → 60); `countVariancePercent` = how far the actual is from it, and `countWarning` is `true` above ±10 % — show the actual in amber/red then (a sign the yarn tagged / beams entered are wrong). Check: 6054 ends, 31,290 m, 3,774.9 lbs → 65.3/s.
- **Yarn tagged to this batch** table = `yarns`: `{ id, inwardId, inwardCode, dcNo, inwardDate, yarnCount, name, lbs, countMismatch }` (`countMismatch: true` = the tagged yarn's count is not the batch's yarn count → show a warning icon; it is not blocked). Total = `yarnTaggedLbs`.
- **Beams received** table = `beams` (flat list over all receipts): `{ id, beamNo, beamLabel, name, lengthM, weightKg, status, statusText, grnNo, grnLabel, receiptId, receiptDate }` (`status` is the beam's *current* place: Full = on floor, At loom ...). Total beams / length = `beamCount` / `warpLengthM`. Group chips "GRN 14958 · 4 · 20,860 m" from `receipts`.
- **Cut cones** table = `cutCones`: `{ id, type, kg, lbs, cones, bags, grnNo, receiptId }`.
- **Billing** box = `billing` (see §5).
- `canConfirm` is true only for a draft with everything in `readiness` (all `true`); use `readiness` to show what is missing (notes / yarn tagged / a beam received / rate / net warp weight above 0).
- After the batch is invoiced: `purchaseInvoice: { id, voucherNo, voucherLabel, status }`, `invoiced: true`, `billedAmount` (the "Billed" column; "Not tagged in a purchase bill yet" under billing = `invoiced: false`).

## 4. Yarn tagged
- `GET /yarn-available?vendorId=<party>&batchId=<batch>&search=` → `{ data: [ { inwardId, inwardCode, inwardDate, dcNo, name, yarnCount, sentLbs, taggedLbs, availableLbs, taggedHereLbs } ], total }` — the weaving yarn inward entries that **went to this sizing party on a sizing challan** and still have lbs not tagged to another batch of the party (`availableLbs = sentLbs − taggedLbs`). Show "DC / LOT" = `dcNo` / `inwardCode`, the count, and the available lbs. `taggedHereLbs` = what this batch already tagged from it. (Yarn the supplier delivered straight to the sizing party is included, it also went out on the sizing challan.)
- `POST /batches/:id/yarns` `{ inwardId, lbs }` → the whole batch (201). 422 `MORE_THAN_AVAILABLE` (`details.availableLbs`), `YARN_NOT_SENT` (not sent to this party), `ALREADY_TAGGED` (use PATCH), `BATCH_CONFIRMED`.
- `PATCH /batches/:id/yarns/:tagId` `{ lbs }`, `DELETE /batches/:id/yarns/:tagId` → the whole batch.
- Several batches may split one yarn entry (e.g. 2,740 lbs here, the rest in another batch).

## 5. Beam receipts (GRN) — "Sized beam / cut cones inward"
- `GET /pending-beams?vendorId=<party>&search=` → `{ data: [ { id, beamNo, beamLabel, name, sentOn, weightKg, challanNo, challanText } ], total }` — the empty beams sent to this party that are **still at sizing** (the beam picker).
- `POST /batches/:id/receipts`
```json
{ "receiptDate": "2026-11-18", "refNo": "R-1", "notes": "2xbeam (ends 6054)",
  "beams": [ { "beamId": "...", "lengthM": 5215, "weightKg": 0 } ],
  "cutCones": [ { "type": "CutCone", "kg": 152, "cones": 11, "bags": 6 } ] }
```
  Every beam needs its **length in metres** (`weightKg` optional). Every cut cone row: `type` (default `CutCone`), `kg`, `cones` (Nos), `bags`; the server adds **`lbs`** (kg × 2.20462). A receipt needs at least one beam or one cut cone row (422 `NOTHING_RECEIVED`). One batch can have many receipts (parts). `receiptNo` is the **GRN#** (running per company, `receiptLabel` "00001"). The beams go **At sizing → Full** (dated like the receipt, carrying their meters) — they then show in the Beam Stock as *Full*.
  422: `BEAM_NOT_AT_PARTY` (not waiting at this party / already received), `BEFORE_OUTWARD` (dated before the beam went to sizing), `DUPLICATE_BEAM`, `BATCH_CONFIRMED`.
  Answer: the receipt `{ id, receiptNo, receiptLabel, receiptDate, refNo, notes, beams: [{ id, beamNo, beamLabel, name, lengthM, weightKg, status }], cutCones: [{ id, type, kg, lbs, cones, bags }], totalBeams, lengthM, coneKg, coneLbs, coneCones, coneBags, batch: { id, batchNo, batchLabel, setNo, ends, status, party, yarnCount, warpLengthM, beamCount, actualCount, billing } }`. (Reload the batch after saving — its pills and billing change.)
- `GET /receipts/:id` one receipt; `PATCH /receipts/:id` same fields (send `beams` / `cutCones` to replace them; the beams go back to sizing and are received again); `DELETE /receipts/:id` → `{ deleted: true }` (beams go back **At sizing**). Only while the batch is a draft. 422 `BEAM_MOVED_ON` if a received beam is not *Full* any more (it went to a loom etc.) — it can't be undone then.
- **Summary list** `GET /receipts?search=&vendorId=&batchId=&dateFrom=&dateTo=&page=&limit=` → `{ data: [ { id, receiptNo, receiptLabel, receiptDate, refNo, notes, batch: { id, batchNo, batchLabel, setNo, status }, party, yarnCount, ends, lengthM, beams, coneKg, coneLbs } ], total, totals: { receipts, lengthM, beams, coneKg } }` — the "Sized beam inward summary" (GRN, set / batch, count, ends, sizing party, notes, length, beams, c/cones).

## 6. Billing, confirm and the invoice
- **Warp wt** = *yarn issued (tagged)* − *cut cones (lbs)*. **Adjustment** (`adjustmentLbs`, an input, at most **10 lbs either way**) → **Net warp wt** = warp wt + adjustment (this is the *billed weight*). **Amount** = net warp wt × **`ratePerLb`** (input). Only the yarn that went into the beams is billed: the cut cone yarn is taken off. All of it comes in `billing`; show it as the Billing box (Yarn issued − Cut cones = Warp wt ± Adjustment = Net warp wt × Rate = Amount). The server recalculates after every change.
- **Confirm** `POST /batches/:id/confirm` = approval. Needs: **notes**, **yarn tagged**, **at least one beam received**, a **rate per lb**, a net warp weight above 0 — else 422 `NOT_READY` with `details.missing` (e.g. `["rate","beams"]`) and `details.readiness`. After it the batch is **locked** (`canEdit: false`; 422 `BATCH_CONFIRMED` on changes to the batch, yarn or receipts).
- **Reopen** `POST /batches/:id/reopen` → back to draft; refused while the batch is on a purchase invoice (422 `ON_PURCHASE_INVOICE`, delete the invoice first).
- **Invoice (Accounts > Purchase invoices)**: a new invoice kind **`SIZING_BATCH`** ("Sizing Batch"), made like the other purchase invoices:
  - picker: `GET /api/v1/purchase-invoices/sizing-batches?vendorId=<sizing party>&search=&invoiceId=` → `{ data: [ { batchId, batchNo, batchLabel, batchDate, setNo, ends, yarnCount, title, netWarpWt, ratePerLb, amount, canBill, blockedReason } ], total }` — only **confirmed** batches of that party not yet on an invoice (`invoiceId` = the invoice being edited, to keep its own batches).
  - create / edit: `POST /api/v1/purchase-invoices` and `PATCH /api/v1/purchase-invoices/:id` with **`sizingBatchIds: [ ... ]`** (instead of `inwardIds` / `yarnInwardIds` / `sizingInwardIds` / ...; exactly one kind), plus the usual `vendorId`, `taxRate`, `invoiceDate`, `billNo` ... Debit *Sizing Charges*, same as the old sizing invoice. Invoice `kind: "SIZING_BATCH"`, its `lines` have `{ batchNo, batchLabel, setNo, ends, yarnCount, title, netWarpWt, ratePerLb, amount, salesTax, net }`. `GET /purchase-invoices?kind=SIZING_BATCH` filters the list.
  - A batch can only be invoiced once it is confirmed (422 `BATCH_NOT_CONFIRMED`); `canInvoice` on the batch tells you when to enable the "make invoice" action.

## 7. List — `GET /batches`
Query: `status` (`DRAFT|CONFIRMED`; nothing = All), `vendorId`, `search` (batch no, set no, party, count, quality, notes), `dateFrom`, `dateTo`, `withoutYarn=true` (the "35 without yarn tagged" red rows), `page`, `limit`.
```json
{ "data": [ { ...same fields as one batch except the tables: batchNo, batchLabel, batchDate, setNo, party, ends, yarnCount, quality, status, yarnTaggedLbs, yarnLots, warpWeightLbs, coneLbs, warpLengthM, beamCount, actualCount, billing, invoiced, billedAmount, noYarnTagged, canEdit ... } ],
  "page": 1, "limit": 50, "total": 50,
  "counts": { "all": 57, "drafts": 7, "confirmed": 50, "withoutYarn": 35 },
  "totals": { "sets": 50, "yarnTaggedLbs": 63535, "warpWeightLbs": 0, "coneLbs": 0, "lengthM": 969526, "beams": 0, "amount": 0 } }
```
`counts` = the tab numbers (All / Drafts (n)) and the red "without yarn tagged" pill; they follow the other filters but not `status`. `totals` = the pills / footer of the current list. Columns: Batch, Set, Date, Sizing (party), Ends, Count, Quality, Yarn tagged (+ "n lot", red if `noYarnTagged`), Warp wt, C/Cones (lbs), Sizing length (`warpLengthM`), Beams in (`beamCount`), Billed (`billedAmount`), action (Beam in / Continue).

## 8. Other effects
- A **sizing challan** (Weaving > Yarn Outward, type sizing) whose yarn is tagged in a batch, or whose beams were received on a batch, **cannot be changed or deleted** (422 `HAS_SIZING_BATCH`): remove the yarn / receipt from the batch first.
- Beam Stock / Beam list: a received beam is *Full* with its meters, like before.

## Database
Migration `20261227000001-sizing-batches.js` (service `SIZING`, tables `sizing_batches`, `sizing_batch_yarns`, `sizing_receipts`, `sizing_receipt_beams`, `sizing_receipt_cones`, `purchase_invoice_sizing_batches`, and the new invoice kind). Run `npm run db:migrate`, then give the **Sizing Management** service to the users who need it (Users > Services).

## Update — In Pass per receipt, optional weight, overhead contract on the batch (migration 20261228000001)

### A. In Pass number (IP#) on every receipt
Every beam / cut cone receipt (`POST /batches/:id/receipts`) **is one In Pass**: if 10 beams come back in 3 deliveries, there are 3 receipts = 3 In Passes; a delivery with **only cut cones** (no beams) is also a receipt with its own In Pass. Nothing new to send — the server numbers it.
- New fields **`inPassNo`** (number) and **`inPassLabel`** ("00003") on: the receipt (create / get / patch answer and `batch.receipts[]`), every row of the batch's flat **`beams[]`** and **`cutCones[]`** (with `receiptDate`), and every row of `GET /receipts` (the summary: show an **IP#** column). They are the same number as `receiptNo` / `grnNo` (kept for compatibility): use `inPass*` for the screens.
- The number is a running number of the company and is **never used again**, even if the receipt is deleted.
- Show it in the entry: on the receipt form header ("IP# 00003"), in the Beams received table (IP# column; group the rows by it) and in the Cut cones table. `GET /receipts?search=` finds by In Pass number. This makes the later report "what came in on In Passes vs what went out on Gate Passes" possible.

### B. Beam weight is optional
`weightKg` on a beam row of a receipt was already optional: **remove the Weight column from the beam receipt form** (or leave it as an optional field). It is not needed for any calculation.

### C. Overhead contract on the batch
A batch can be tagged to an **overhead contract** (Weaving > Contracts, `kind: OVERHEAD`) = the customer whose yarn is sized, **"on account"**. It is optional (the form's "Contract" field).
- Picker: `GET /sizing/overhead-contracts?customerId=&search=` → `{ data: [ { id, code, codeLabel, contractDate, status, goods, customer: { id, code, name }, title: "AL RAHIM TEXTILES (424), Cont#509" } ], total }` — only **open** overhead contracts (`search`: customer name or contract no).
- `POST /batches` and `PATCH /batches/:id` take **`contractId`** (`null` clears it; draft batches only). 422 `UNKNOWN_CONTRACT` (not an overhead contract of this company), 422 `CONTRACT_CLOSED` (a closed contract cannot be newly chosen; one already on the batch may stay).
- The batch (one / list) now has `contractId`, **`contract`** `{ id, code, codeLabel, status, customer: { id, code, name } } | null` and **`onAccount`** `{ id, code, name } | null` (the customer: the "ON ACCOUNT" column).
- List filters on `GET /batches`: `contractId`, `customerId`; `search` also finds the customer name and the contract no.
- `GET /yarn-available` takes an optional **`contractId`**: only the yarn (weaving yarn inward entries) that came in on that overhead contract. Use it when the batch has a contract, to offer the customer's own yarn first.
- A contract that has sizing batches tagged to it cannot be deleted in Weaving (422 `IN_USE`, `details.sizingBatches`): close it instead.

## Database (update)
Migration `20261228000001-sizing-batch-contract.js` (`sizing_batches.contractId`). Run `npm run db:migrate`.
