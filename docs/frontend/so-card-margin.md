# SO CARD COST AND MARGIN (N-C1)

For each SO card: what it **cost**, what it **earned** and the **margin**. Each cost part is shown on its own. A part that is not known yet is **"not entered"** (`null`), never 0. Read only: nothing is posted to the accounts.

**Only people with the accounting service** (Reports, `ACC_REPORTS`, or Sales Invoice, `ACC_SALES`) can open it. A production person (SO Card service only) gets **403** on every route below: do not show the page, the "Cost" tab or the menu item to him.

## 1. How the numbers are made
**Cost** = grey cloth + chemicals + yarn + department charges + packing:

| Part | Where it comes from | Status when nothing is recorded |
|---|---|---|
| `grey` Grey cloth | Cloth bought from the Fabric Store: the meters x the rate it was bought at. The **customer's own cloth costs nothing**. | `NOT_APPLICABLE` for the customer's cloth; `NOT_ENTERED` when the fabric bought has no rate |
| `chemicals` Chemicals | The chemicals sent to the card's jobs (at the store average rate) | `NOT_ENTERED` when the card went to a process department but no chemical was sent; else `NOT_APPLICABLE` |
| `yarn` Yarn | The yarn the departments used for the card's jobs | `NOT_APPLICABLE` when none was used |
| `departmentCharges` Department charges | Every Process / Folding department the cloth went through: its **meters x the rate of that department on the day of the job** (Settings > Process rates) | `NOT_ENTERED` if no department has a rate; **`PARTLY`** if only some have (the others are in `missing`) |
| `packing` Packing | The Packing department: its meters x its rate | same as department charges |

**Revenue** (before tax) = the **approved** sales invoice lines of the card's packing lists. A **final** packing list that has no approved invoice yet counts at its **packed value** (A, B, CP meters x the rates of the list). A draft invoice is not revenue. `revenueSource`: `INVOICE`, `PACKED`, `MIXED`, or `NONE` (nothing packed yet: revenue and margin are `null`).

**Margin** = revenue - total cost, in money and in percent of revenue.

## 2. The report: `GET /api/v1/reports/so-card-margin`
Listed in the Reports menu (key `so-card-margin`, only for accounting people). Query: `dateFrom`, `dateTo` (the SO card date), `customerId`, `qualityId`, `soNo`, `page`, `limit`, `export=true`.

Row:
```json
{ "soCardId": "…", "soNo": 11, "cardDate": "2026-11-20", "party": "AZ TEXTILES", "quality": "PC TWILL", "article": "…", "meters": 360, "tag": "",
  "revenue": 11200, "revenueSource": "MIXED",
  "greyCost": 0, "chemicalCost": null, "yarnCost": 0, "departmentCost": 1080, "packingCost": 180,
  "totalCost": 1260, "costPerMeter": 3.5, "margin": 9940, "marginPercent": 88.75,
  "costStatus": "Cost not complete", "costComplete": false, "missingParts": ["chemicals"],
  "parts": {
    "grey": { "amount": 0, "status": "NOT_APPLICABLE", "note": "The customer's own cloth costs nothing" },
    "chemicals": { "amount": null, "status": "NOT_ENTERED", "note": "No chemical was sent for this card" },
    "yarn": { "amount": 0, "status": "NOT_APPLICABLE" },
    "departmentCharges": { "amount": 1080, "status": "ENTERED" },
    "packing": { "amount": 180, "status": "ENTERED" } } }
```
- **Show `null` as "not entered"** (not 0) in `greyCost`, `chemicalCost`, `yarnCost`, `departmentCost`, `packingCost`. `parts.<x>.status` tells why: `ENTERED`, `NOT_ENTERED` (should have a cost, none recorded), `PARTLY` (some departments have no rate: names in `parts.<x>.missing`), `NOT_APPLICABLE` (no cost expected: show "-" or 0).
- **`totalCost` adds only the known parts.** When `costComplete` is `false` (`missingParts` lists them) the margin is **higher than the truth**: show a warning "cost not complete: chemicals not entered" next to the margin. `costStatus` is the text for a tag.
- `margin` and `marginPercent` are `null` when `revenueSource` is `NONE`. A negative `margin`: **red**.
- `totals`: `meters`, `revenue`, `greyCost`, `chemicalCost`, `yarnCost`, `departmentCost`, `packingCost`, `totalCost`, `margin`, `marginPercent`, `incompleteCards` (cards with a part not entered), `negativeCards`.
- `partsText` in the answer: the names of the parts for the screen. At most 5,000 cards: more answers **422 `REPORT_TOO_BIG`**.

## 3. One card: `GET /api/v1/reports/so-card-margin/:soCardId` (the drill-down panel and the "Cost" tab of the SO card)
The same row plus `detail`:
```json
"detail": {
  "greyLots": [ { "lotNo": 101, "source": "CUSTOMER", "meters": 360, "perMeter": null, "amount": null } ],
  "jobs": [ { "jobId": "…", "jobNo": 1, "department": "Dyeing", "kind": "PROCESS", "jobDate": "2026-11-20", "meters": 360, "ratePerMeter": 2, "charge": 720 },
            { "jobNo": 2, "department": "Folding", "meters": 360, "ratePerMeter": null, "charge": null } ],
  "chemicals": [ { "chemical": "Caustic Soda", "unit": "KG", "qty": 12, "amount": 1440 } ],
  "yarn": [ { "yarn": "30/1 - Brand", "lbs": 100, "amount": 25000 } ],
  "packingLists": [ { "listNo": 1, "source": "INVOICE", "invoiceNo": 5, "invoicedAmount": 8000, "packedValue": 8000, "amount": 8000 },
                    { "listNo": 2, "source": "PACKED", "packedValue": 3200, "amount": 3200 } ] }
```
- `jobs` has a link to the job (`jobId`, `jobNo`). A job with `ratePerMeter: null` has no rate for that department on that day: show "no rate" and a link to Settings > Process rates.
- 404 for a card of another company.
- **SO card page**: add a **"Cost" tab** that calls this route, **only for users who have the accounting service**; hide it for the others.

## 4. Process rates (settings): `/api/v1/process-rates` (accounting service `ACC_REPORTS`: VIEW reads, FULL changes)
`GET`:
```json
{ "departments": [ { "id": "…", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS", "currentRate": 2,
    "rates": [ { "id": "…", "ratePerMeter": 2, "effectiveFrom": "2026-01-01" } ] } ],
  "note": "A rate is per meter and counts from its date. The SO card margin uses the rate of the day of each job." }
```
- `PUT` `{ "departmentId": "…", "ratePerMeter": 2, "effectiveFrom": "2026-01-01" }`: adds the rate from that day; the **same department and day again changes** that rate. `ratePerMeter`: 0 or more (4 decimals). The answer is the new list.
- `DELETE /process-rates/:id`: removes one rate. The answer is the new list.
- A rate counts from its date until the next one. **The margin uses the rate of the day of each job**, so an old job keeps its old rate when a new rate is added. Changing or deleting a rate changes the margin of the jobs it covers.
- The departments are the company's Process, Folding and Packing departments. 404 for a department the company does not have.

**Screen** (Settings > Process rates): a table of departments: current rate, the history (rate, from date, delete), and "Add rate" (rate + from date). Say on the screen that a department with no rate makes its part "not entered" in the margin.

## 5. The screens (suggested)
**Report page** (Reports > SO card cost and margin): filters (period, customer, quality, SO no); one row per card: revenue (with the `revenueSource` tag), the five cost parts ("not entered" in grey), total cost, cost / m, margin and margin % (red when negative), and a tag "Cost not complete". A totals row from `totals`. Click a row: the **drill-down panel** with the parts (`detail`) and links to the jobs. Export button (`export=true`).

## 6. Quick checks
1. A card that went through Dyeing, Folding and Packing, with no rates: the department and packing parts are "not entered", the card says "Cost not complete".
2. Set Dyeing 2 / m, Packing 0.5 / m, no Folding rate: department charges `PARTLY` (720, missing Folding). Add Folding 1 / m: `ENTERED` (1,080).
3. Revenue: packed value until an invoice is **approved**; then the invoice amount (before tax) for that list.
4. A card with no packing list: revenue `null`, margin `null`.
5. A rate added with a date after the jobs does not change the margin of those jobs.
6. A production user gets 403 on the report, the card detail and the rates; another company sees none of these cards.
