# Weaving — Yarn Outward > Sale (challan + gate pass) — Frontend Guide

**Weaving > Yarn Outward > Sale.** Purchased yarn is sold **as it is** (no process). In the weaving module a sale is only a **delivery challan** (takes the yarn out of the stock; same running challan number as the weft / return challans) and a **gate pass**. There are **no invoice fields** here (no tax, no due date, no invoice notes): the **sales invoice is made in the Accounts** (see `weaving-accounts-invoices.md`). The sale list only has a **"Generate invoice"** button as a shortcut.

All calls are under `/api/v1/weaving`, service `WEAVING_MASTERS` (`FULL` makes / changes / deletes, `VIEW` reads). Generate invoice also needs `ACC_SALES` with `FULL`.

## 1. The new-sale form
1. **Customer** (the buyer): dropdown from `GET /weaving/customers`. Send `customerId`. (Optional: `GET /yarn-sales/credit/:customerId` for the credit limit / days / balance.)
2. **Date** (`outwardDate`, default today; not before the date the yarn came in).
3. **Description** (`description`, optional, max 300).
4. **Lines**: the stock entries to sell from, the **bags** and the **selling rate per lb**:
   `GET /weaving/yarn-sales/stock-entries?search=&itemId=&vendorId=` — same answer as the weft picker (`weaving-yarn-weft.md` section 1) but **only our purchased yarn** (`type: PURCHASE`). The customers' own (overhead) yarn is not in the list and cannot be sold (422 `OVERHEAD_NOT_SOLD`).
   Per row the user types **Bags** (1 to `balanceBags`) and **Rate per lb** (selling price, > 0). Show live: **Lbs** = bags × `lbsPerBag`, **Amount** = lbs × rate; and the total.
   One stock entry once per sale (400 if repeated).

The body accepts only `customerId`, `outwardDate`, `description`, `lines` (anything else, like `taxRate`, is 400).

## 2. API
| Call | Needs | |
|---|---|---|
| `GET /yarn-sales/options` | VIEW | tax rates for "Generate invoice" (`taxRates`, `defaultTaxRate`) |
| `GET /yarn-sales/credit/:customerId` | VIEW | credit status of the customer |
| `GET /yarn-sales/stock-entries` | VIEW | the picker (purchased yarn only) |
| `GET /yarn-sales?page=&limit=&search=&dateFrom=&dateTo=&customerId=&invoiced=` | VIEW | the list |
| `GET /yarn-sales/:id` | VIEW | one sale (**print** the challan) |
| `POST /yarn-sales` | FULL | make a sale, 201 |
| `PATCH /yarn-sales/:id` | FULL | change date / description / lines |
| `DELETE /yarn-sales/:id` | FULL | delete; the yarn goes back to the stock |
| `POST /yarn-sales/:id/generate-invoice` `{ taxRate?, invoiceDate?, dueDate? }` | **ACC_SALES FULL** | make the draft sales invoice of this sale, 201 |
| `GET /yarn-sales/:id/gate-pass` | VIEW | the gate pass |

### Create
```json
{ "customerId": "...", "outwardDate": "2026-11-05", "description": "direct yarn sale",
  "lines": [ { "inwardId": "<stock entry>", "bags": 4, "ratePerLb": 350 }, { "inwardId": "<another>", "bags": 2, "ratePerLb": 360.5 } ] }
```

### The sale (create / get / update)
The challan (same shape as the weft challan, `weaving-yarn-weft.md`) plus **`totalAmount`**, per line **`ratePerLb`** and **`amount`**, and the invoice state:
```json
{ "id": "<sale id>", "type": "SALE", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05", "description": "...",
  "party": { "kind": "CUSTOMER", "id": "...", "name": "Ali Traders" },
  "totalBags": 6, "totalLbs": 500, "totalAmount": 176050,
  "lines": [ { "inwardId": "...", "inwardCode": 1, "party": { "name": "Yarn Mills" }, "yarnCount": {...}, "brand": {...}, "packing": 24, "lbsPerBag": 100, "bags": 4, "lbs": 400, "ratePerLb": 350, "amount": 140000 } ],
  "invoiced": false, "invoice": null, "canEdit": true, "canDelete": true }
```
When the sale is on a sales invoice: `invoiced: true`, `invoice: { id, invoiceNo, invoiceLabel, voucherNo, voucherLabel, status: "UNAPPROVED" | "APPROVED", statusText, net }`, `canEdit: false`, `canDelete: false`. Show the invoice number as a link to the Accounts invoice.

- **Challan no** (`challanText`) is the delivery challan number (made by the server).
- Print the **delivery challan**: challan no, date, customer, per line party / brand / count / packing / lbs per bag / bags / lbs / rate / amount, totals, description.

### The gate pass — `GET /yarn-sales/:id/gate-pass`
`{ challanId, type: "SALE", date, party: { kind, id, name }, partyName, challanNo, challanText, copies: 3 }` — **only the date, the party name, the delivery challan number and a signature line** (draw it yourself); print **3 copies**. Same as the return gate pass.

### The list
`{ data: [ { id, challanNo, challanText, outwardDate, description, customer: {id, name}, totalBags, totalLbs, totalAmount, invoiced, invoice: {...}|null, canEdit, canDelete } ], page, limit, total, summary: { sales, bags, lbs, amount } }`. Filters: `search` (customer, description, challan no), dates, `customerId`, `invoiced=true|false`. Per row buttons: **Gate pass**, **Print challan**, and **Generate invoice** (only when `invoiced` is false and the user has `ACC_SALES`).

### Generate invoice
`POST /yarn-sales/:id/generate-invoice` makes a **draft** sales invoice of this one sale (the same as picking it in Accounts > Sales Invoice): `taxRate` default 18, `invoiceDate` default the challan date, due date from the customer's credit days. Answer 201 `{ sale: <the sale>, invoice: <the invoice, see weaving-accounts-invoices.md> }`. Then send the user to the invoice in the Accounts (approving is done there). 422 `ALREADY_INVOICED` if the sale is on an invoice already.

## 3. Rules and errors
- A sale **on an invoice** cannot be changed or deleted: 422 `SALE_INVOICED` (`details: { invoiceId, invoiceNo, status }`). The invoice must be deleted first (in the Accounts); then the sale is free again.
- 422 `OVERHEAD_NOT_SOLD`, `NOT_ENOUGH_STOCK` (`details: { line, inwardCode, balanceBags, askedBags }`), `BEFORE_INWARD`, `UNKNOWN_STOCK_ENTRY`, `UNKNOWN_CUSTOMER` (not in the weaving customer list). 400 for a missing / zero rate, no lines, bags not a whole number, bad date. 403 no access (generate invoice without `ACC_SALES FULL`). 404 unknown sale / another company's.
- Sales do not appear in the Weft or Return lists, and the other way round.

## 4. Other weaving screens
**Yarn Stock**: sold bags are in `outwardBags` / `outwardLbs`; the balance goes down. **Yarn Inward** entries show `outwardBags` / `balanceBags`; an entry with yarn on a sale cannot be deleted / cut below the bags sold / have its item card or lbs per bag changed (422 `IN_USE`, `BELOW_OUTWARD`, `USED_IN_OUTWARD`).

## Database
Migrations `20261207000001-weaving-yarn-sale.js` and `20261208000001-weaving-yarn-invoices.js`. Run `npm run db:migrate`.
