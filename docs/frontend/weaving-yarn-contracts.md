# Weaving — Yarn Contracts (Purchase + Overhead) and the contract on the Yarn Inward — Frontend Guide

Two new contract screens, and the **Yarn Inward** now counts against a contract line. Same service as the other weaving screens (`WEAVING_MASTERS`: VIEW reads, FULL changes). Base: `/api/v1/weaving`.

| Contract | `kind` | Party | On a Yarn Inward |
|---|---|---|---|
| **Contract Yarn Purchase** | `PURCHASE` | a **vendor** (`vendorId`) | contract is **optional** |
| **Weaving Overhead Sell Contract** | `OVERHEAD` | a **customer** (`customerId`) | contract is **required**: the customer's yarn cannot come in without one |

Both use the same API, only `kind` differs. Build two list screens (menu: Contracts > Yarn Purchase Contracts, Contracts > Overhead Sale Contracts) = `GET /yarn-contracts?kind=PURCHASE` and `?kind=OVERHEAD`.

## 1. Contract list — `GET /yarn-contracts`
Query: `kind` (`PURCHASE|OVERHEAD`), `status` (`OPEN|CLOSED`; nothing = All), `search` (party, notes, contract no, yarn count), `vendorId`, `customerId`, `dateFrom`, `dateTo`, `page`, `limit`.
```json
{ "data": [ { "id": "...", "kind": "OVERHEAD", "kindText": "Weaving Overhead Sell Contract", "code": 553, "codeLabel": "0553",
    "contractDate": "2026-08-28", "deliveryDate": null, "termsDays": 0, "notes": "BY MISTAKE", "taxPercent": 0, "status": "OPEN", "statusText": "Open",
    "party": { "kind": "CUSTOMER", "id": "...", "code": 66, "name": "HAJRA TEXTILES" }, "goods": "45/s PC",
    "orderedLbs": 280, "deliveredLbs": 0, "balanceLbs": 280, "percentDone": 0, "bagsIn": 0, "subtotal": 0, "taxAmount": 0, "net": 0 } ],
  "page": 1, "limit": 50, "total": 4, "counts": { "open": 4, "closed": 0 },
  "totals": { "orderedLbs": 280, "deliveredLbs": 0, "balanceLbs": 280, "amount": 0 } }
```
- `counts` = the "4 contracts · 4 open · 0 closed" header (the numbers of the Open / Closed tabs: they follow the other filters but not `status`, so both tabs keep their number). `totals` = the footer pill ("lbs ordered · delivered · balance") of the **whole filtered list**, not only the page.
- Columns: Contract (`codeLabel`), Date, Party, Goods, Ordered, Delivered, Balance, Progress (`percentDone`), Amount (`subtotal`, or `net`), Status. The contract number runs separately for each kind (a purchase 0001 and an overhead 0001 can both exist).

## 2. Contract form
`GET /yarn-contracts/form-data` → `{ date, defaultTaxPercent: 18, defaultBagWeight: 100, kinds: [{value, text}], yarnCounts: [{ id, code, name }] }` — the **Yarn Quality** dropdown is the **Yarn Count master** (`yarnCounts`). Party dropdowns: `GET /vendors?isActive=true` / `GET /customers?isActive=true`.

**Create** `POST /yarn-contracts`
```json
{ "kind": "PURCHASE", "vendorId": "...", "contractDate": "2026-08-07", "deliveryDate": "2026-08-12", "termsDays": 60, "notes": "16/1 PC (150 BGS)", "taxPercent": 18,
  "lines": [ { "yarnCountId": "...", "bags": 115, "bagWeight": 100, "ratePerLb": 245 }, { "yarnCountId": "...", "bags": 150, "bagWeight": 100, "ratePerLb": 235 } ] }
```
- `kind` + the matching party (`vendorId` for PURCHASE, `customerId` for OVERHEAD; the other one → 422). All the header fields except `kind`/party are optional (`contractDate` = today, `taxPercent` = 18 if not sent: send `0` for none).
- **Line quantity**: either `bags` + `bagWeight` (lbs = bags × bag weight, calculated by the server) **or** `lbs` typed directly (the overhead screen only has "Qnty (lbs)"). Only one of bags/bagWeight → 422 `BAGS_INCOMPLETE`.
- **Rate**: required on a **purchase** line (422 `RATE_REQUIRED`), optional on an overhead line (`null` → no amount). `amount = lbs × rate`.
- At least one line. 201 → the whole contract (see §3).

**Edit the header** `PATCH /yarn-contracts/:id` `{ contractDate?, deliveryDate?, termsDays?, notes?, taxPercent?, vendorId?/customerId? }`. The party can be changed only while **no yarn has come in** on the contract (422 `USED_IN_INWARD`), and only inside its kind.

**Lines**
- `POST /yarn-contracts/:id/lines` `{ yarnCountId, bags?, bagWeight?, lbs?, ratePerLb? }` — add a line (422 `CONTRACT_CLOSED` on a closed contract) → returns the whole contract.
- `PATCH /yarn-contracts/:id/lines/:lineId` `{ yarnCountId?, bags?, bagWeight?, lbs?, ratePerLb? }` — once yarn came in on the line: its yarn count is fixed (422 `USED_IN_INWARD`) and the quantity cannot go below what came in (422 `BELOW_DELIVERED`, `details.deliveredLbs`). Send `lbs` alone to switch a line to plain lbs.
- `DELETE /yarn-contracts/:id/lines/:lineId` — 422 `IN_USE` if yarn came in on it (close it instead), 422 `LAST_LINE` for the only line.
- `POST /yarn-contracts/:id/lines/:lineId/close` and `/activate` — the per-line **Closed ⇄ Activate** / **Active ⇄ Close** toggle of the screens.

**Contract**
- `POST /yarn-contracts/:id/close` and `/activate` — the whole contract (Open ⇄ Closed; this moves it between the Open and Closed tabs). A line cannot be activated while its contract is closed.
- `DELETE /yarn-contracts/:id` → `{ deleted: true, id }`; 422 `IN_USE` (`details.inwards`) if any yarn inward is on it — close the contract instead. A deleted contract's number is not reused.

## 3. One contract — `GET /yarn-contracts/:id`
```json
{ "id": "...", "kind": "PURCHASE", "code": 531, "codeLabel": "0531", "status": "OPEN", "taxPercent": 18, "party": { "kind": "VENDOR", "name": "UMAR TEXTILE" }, ...header,
  "lines": [ { "id": "...", "lineNo": 1, "lineLabel": "000001", "yarnCount": { "id": "...", "name": "18/S PC 65/35" }, "bags": 115, "bagWeight": 100, "lbs": 11500, "ratePerLb": 245, "amount": 2817500,
      "isClosed": false, "status": "ACTIVE", "statusText": "Active", "deliveredLbs": 11500, "balanceLbs": 0, "overLbs": 0, "percentDone": 100, "bagsIn": 115, "deliveries": 2, "lastDelivery": "2026-09-18",
      "deliveryStatus": "COMPLETE", "deliveryStatusText": "Complete" } ],
  "totals": { "bags": 265, "lbs": 26500, "subtotal": 6342500, "taxAmount": 1141650, "net": 7484150, "deliveredLbs": 19500, "balanceLbs": 7000, "percentDone": 73.6 },
  "deliverySummary": [ { "yarnCount": { "name": "18/S PC 65/35" }, "orderedLbs": 11500, "deliveredLbs": 11500, "balanceLbs": 0, "percentDone": 100, "bagsIn": 115, "deliveries": 2, "lastDelivery": "2026-09-18", "status": "COMPLETE", "statusText": "Complete" } ],
  "inwards": [ { "id": "...", "code": 12, "inwardDate": "2026-09-18", "dcNo": "55", "lineId": "...", "lineNo": 1, "yarnCount": { "name": "..." }, "bags": 60, "totalLbs": 6000, "ratePerLb": 245, "amount": 1470000, "purpose": "BOTH" } ], "inwardCount": 4 }
```
- **Orders tab** = `lines` (Line, Yarn quality, Bags, Bag wt, Lbs, Rate/lb, Amount, status button). Add the "Delivered / Balance" columns from `deliveredLbs` / `balanceLbs` (the old screen's IN / BALN).
- **Inwards tab** (count in its label = `inwardCount`) = `inwards`. **Delivery summary** table = `deliverySummary` (`% done`, `status`: `NOT_STARTED` "Not started" / `PART` "Part delivered" / `COMPLETE` "Complete").
- Bottom: bags, lbs (`totals`), Subtotal, Sales tax (`taxPercent` dropdown → `taxAmount`), Net.
- **Balance** = ordered − came in. It never shows below 0; if more yarn came in than ordered, `overLbs` says by how much (allowed — the yarn is received anyway). Deleting or changing an inward entry updates the balance at once.

## 4. Yarn Inward — the contract (`POST/PATCH /yarn-inwards`)
New field **`contractLineId`** (a line id of a contract).
- **Customer (overhead) entry**: **required**. Without it → 422 `CONTRACT_REQUIRED` (`details.field = contractLineId`). On the form: after the customer is chosen, show a **Contract** dropdown (required); the entry cannot be saved without one.
- **Vendor (purchase) entry**: optional. If chosen and the **rate is left empty**, the rate of the contract line is used.
- **Fill the dropdown** with `GET /yarn-contracts/open-lines?customerId=<id>` (or `?vendorId=<id>`), plus `&itemId=<item card id>` (or `&yarnCountId=`) to show only the lines of that item card's yarn count. Answer `{ data: [ line… ] }`: each line has `id`, `yarnCount`, `lbs`, `deliveredLbs`, **`balanceLbs`** and `contract: { id, kind, code, codeLabel, contractDate }`. Show e.g. `0553 · 45/s PC · balance 280 lbs` and pass the chosen `line.id` as `contractLineId`. Only **open contracts' active lines** are offered. Re-filter when the customer or the item card changes.
- Checks (422, `details.field = contractLineId`): `UNKNOWN_CONTRACT`; `CONTRACT_PARTY` (not a contract of this vendor/customer, or of the other kind); `CONTRACT_YARN_COUNT` (the item card's yarn count is not the line's yarn quality); `CONTRACT_CLOSED` / `CONTRACT_LINE_CLOSED` (a **new** link to a closed contract/line; an entry that is already on a contract can still be edited after it closes).
- **Edit**: `contractLineId` can be changed (also on an invoiced entry — it does not touch the books). An overhead entry cannot be set to `null` (422 `CONTRACT_REQUIRED`). Entries made **before** this change have no contract (`contract: null`); they can still be edited without one.
- Every yarn inward answer (add / edit / one / list) has `contractLineId` and **`contract`**: `{ id, kind, kindText, code, codeLabel, status, lineId, lineNo } | null` — show a "Contract" column (`codeLabel`).
- List filters on `GET /yarn-inwards`: `contractId`, `contractLineId`, `noContract=true` (entries without a contract).

## Database
Migration `20261226000001-weaving-yarn-contracts.js` (tables `yarn_contracts`, `yarn_contract_lines`; column `yarn_inwards.contractLineId`). Run `npm run db:migrate`.
