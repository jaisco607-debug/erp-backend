# Weaving — Yarn Outward > Return (challan + gate pass) — Frontend Guide

**Weaving > Yarn Outward > Return.** A vendor or a customer does not want their yarn processed (all of it, or only some bags) and asks for it back. We make a **return challan** (delivery challan) and a **gate pass**. It works like the Weft challan (`weaving-yarn-weft.md`): it takes bags out of the stock entries, the stock and the balances go down, and the challan number is the same running delivery challan number. The difference: a return goes to **one party** and takes back only **that party's own yarn**.

**Part of the yarn:** the user returns only the bags the party does not want processed. The bags that are **not** put on the return stay in the stock for processing (for example 20 bags came, the customer will process 8: return 12).

All calls are under `/api/v1/weaving`, service `WEAVING_MASTERS` (`VIEW` = read, `FULL` = add / edit / delete).

## 1. The new-return form
1. **Party**: Vendor **or** Customer (a switch + a dropdown from `GET /weaving/vendors` / `GET /weaving/customers`). Send `vendorId` **or** `customerId`.
2. **Date** (`outwardDate`, default today, not before the date the yarn came in).
3. **Description** (optional, max 300).
4. **Lines**: the stock entries **of that party** with yarn left, and the **bags to return** for each (1 to the balance):

`GET /weaving/yarn-returns/stock-entries?vendorId=<id>` (or `customerId=<id>`) — same answer as the weft picker (`weaving-yarn-weft.md`, section 1): inward ID, date, party, item (count, brand, packing), `lbsPerBag`, `balanceBags`, `balanceLbs`. Other filters: `search`, `itemId`, `type`. Show **Lbs** = bags × `lbsPerBag` live. One stock entry only once per challan (400 if repeated). Reload the picker when the party changes and clear the lines.

## 2. API
| Call | Needs | |
|---|---|---|
| `GET /yarn-returns/stock-entries?vendorId=&customerId=` | VIEW | the picker |
| `GET /yarn-returns?page=&limit=&search=&dateFrom=&dateTo=&vendorId=&customerId=` | VIEW | the list, newest first |
| `GET /yarn-returns/:id` | VIEW | one return challan with its lines (**print**) |
| `GET /yarn-returns/:id/gate-pass` | VIEW | the **gate pass** (print, below) |
| `POST /yarn-returns` | FULL | make it, 201 |
| `PATCH /yarn-returns/:id` | FULL | change date / description / lines (the party never changes) |
| `DELETE /yarn-returns/:id` | FULL | delete: the yarn goes back into the stock |

### Create
```json
{ "customerId": "<or vendorId>", "outwardDate": "2026-11-08", "description": "customer will not process",
  "lines": [ { "inwardId": "<stock entry>", "bags": 12 }, { "inwardId": "<another entry>", "bags": 6 } ] }
```
`vendorId` and `customerId` together, or none: 400. `lines`: 1 to 200.

### The challan (create answer and `GET :id`)
Same shape as the weft challan, plus the party:
```json
{ "id": "...", "type": "RETURN", "party": { "kind": "CUSTOMER", "id": "...", "code": 1, "name": "Ali Traders" },
  "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-08", "description": "...", "department": null,
  "totalBags": 18, "totalLbs": 1200,
  "lines": [ { "inwardId": "...", "inwardCode": 2, "party": { "name": "Ali Traders" }, "yarnCount": { "name": "22|s Cotton" }, "brand": { "name": "Crescent" }, "packing": 24, "lbsPerBag": 50, "bags": 12, "lbs": 600 } ] }
```
Print the **delivery challan** with: challan no (`challanText`), date, party name, and per line brand, yarn count, packing, lbs per bag, bags, lbs, and the totals, plus the description. `challanNo` is made by the server (the same running number as all the other challans of the company).

### The gate pass — `GET /yarn-returns/:id/gate-pass`
```json
{ "challanId": "...", "type": "RETURN", "date": "2026-11-08",
  "party": { "kind": "CUSTOMER", "id": "...", "name": "Ali Traders" }, "partyName": "Ali Traders",
  "challanNo": 1, "challanText": "00001", "copies": 3 }
```
The gate pass has **only**: **date**, **party name**, **delivery challan number**, and a **signature** line (draw the signature box yourself). Print it in **`copies` = 3 copies** (one page with 3 copies, or 3 pages). Show a "Gate pass" button on the challan / list row.

### The list
`{ data: [ { id, type, challanNo, challanText, outwardDate, description, lineCount, totalBags, totalLbs, partyName, parties, brands } ], page, limit, total, totals: { entries, bags, lbs } }`. Columns: DC #, Date, Party (`partyName`), Description, Bags, Lbs. `totals` is for the whole filtered list. `search` finds the DC number, party, description, count or brand. There is no Draft / Confirmed state.

## 3. Rules and errors
- 422 `WRONG_PARTY` (`details: { line, inwardId, inwardCode }`): the entry belongs to another vendor / customer. The picker already filters by party; show the message if it still happens.
- 422 `NOT_ENOUGH_STOCK` (`details: { line, inwardCode, balanceBags, askedBags }`): more bags than are left (maybe used by a weft challan meanwhile).
- 422 `BEFORE_INWARD`: dated before the yarn came in. 422 `UNKNOWN_STOCK_ENTRY`; 422 `UNKNOWN_VENDOR` / `UNKNOWN_CUSTOMER`.
- 400: no party / both, no lines, bags not a whole number >= 1, the same entry twice, bad date. 403 no access / `VIEW` only. 404 unknown or another company's.
- A vendor that has a return cannot be deleted (422 `IN_USE`; switch it off instead).
- The stock entries used here follow the same locks as for the weft: an inward entry with yarn on a challan cannot be deleted, cut below the bags sent out, or have its item card / lbs per bag changed (422 `IN_USE`, `BELOW_OUTWARD`, `USED_IN_OUTWARD`).

## 4. Other weaving screens
- **Yarn Stock**: the returned bags are in `outwardBags` / `outwardLbs` and the balance goes down.
- **Yarn Inward** entries: `outwardBags` / `balanceBags` include what was returned.
- Returns do **not** appear in the **Weft** list (`/yarn-weft`) and the other way round.

## Not in this step
The accounting voucher for a returned purchase (vendor) comes with the accounts step; direct sale and sizing are next.

## Database
Migration `20261206000001-weaving-yarn-return.js` (`yarn_outwards.customerId / vendorId`, type `RETURN`). Run `npm run db:migrate`.
