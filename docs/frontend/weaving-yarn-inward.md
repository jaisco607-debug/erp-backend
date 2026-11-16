# Weaving — Customers, Vendors and Yarn Inward — Frontend Guide

All calls are under `/api/v1/weaving` and use the service **`WEAVING_MASTERS`** (`VIEW` = read, `FULL` = add / edit / delete). See `weaving-yarn-count.md` and `weaving-brand-item-card.md` for the other weaving screens.

## 1. Customers and Vendors (the weaving module's OWN lists)
Weaving has its **own** customers and vendors. The lists start **empty**: the customers of the Grey Store and the vendors of the stores are **not** shown here, and the ones added here are **not** shown there. Same forms, same tables, only a separate list (`module = WEAVING` on the server).

| Weaving URL | Same form / fields as |
|---|---|
| `GET/POST /weaving/customers`, `GET/PATCH/DELETE /weaving/customers/:id`, `GET /weaving/customers/options` | `/api/v1/customers` |
| `GET/POST /weaving/vendors`, `GET/PATCH/DELETE /weaving/vendors/:id`, `GET /weaving/vendors/options` | `/api/v1/vendors` |

Use the **existing Customer form and Vendor form** (fields, validation, list with search / `isActive` filter, errors, delete answering 204) exactly as in the Grey Store / Store screens. Nothing changes in the forms; only the URL and the service (`WEAVING_MASTERS`) are different.
- The **ID (code)** of weaving customers / vendors starts at 1 on its own. A name may exist in both lists (duplicates are checked inside the weaving list only; 422 `NAME_TAKEN`).
- A weaving customer / vendor id does not work in the old screens and the other way round (404, or 422 `UNKNOWN_VENDOR` / `UNKNOWN_CUSTOMER` in a yarn inward).
- A vendor used by a yarn inward entry cannot be deleted: 422 `IN_USE` (switch it off with `isActive: false`).

## 2. Yarn Inward — what it is
One entry = one **item card** received from:
- a **Vendor** → type **`PURCHASE`** (yarn we buy), or
- a **Customer** → type **`OVERHEAD`** (the customer's own yarn).

The user picks a customer **or** a vendor (never both); that decides the type. The type of an entry cannot be changed later.

### Form
1. **Date** (`inwardDate`, default today).
2. **Party**: one dropdown / switch "Vendor | Customer". Vendor list: `GET /weaving/vendors?isActive=true&limit=...`; customer list: `GET /weaving/customers?isActive=true&limit=...`. Send `vendorId` **or** `customerId`.
3. **Item card**: dropdown from `GET /weaving/yarn-inwards/form-data` (below). When one is chosen, **fill the form from it**: yarn count, brand, packing and bags (read only), and **Lbs per bag** with `lbsPerBag` (the user may change it).
4. **Bags** (`bags`): how many bags (whole number, at least 1).
5. **Lbs per bag** (`lbsPerBag`): weight of one bag in lbs (positive, 2 decimals). All bags of one entry have the same weight.
6. **Rate per lb** (`ratePerLb`): required for a vendor (purchase), optional for a customer (overhead yarn).
7. Optional: **DC no** (`dcNo`, max 50), **Remarks** (max 300).
8. Show **calculated** (live on screen; the server does the same sums):
   - **Total lbs** = bags × lbs per bag
   - **Amount** = total lbs × rate per lb (when a rate is given)

### `GET /weaving/yarn-inwards/form-data`
```json
{ "date": "2026-11-12",
  "items": [ { "id": "...", "code": 1, "name": "22|s Cotton - Crescent - 24 - 100",
               "yarnCount": { "id": "...", "name": "22|s Cotton" }, "brand": { "id": "...", "name": "Crescent" },
               "packing": 24, "bags": 100, "lbsPerBag": 100 } ] }
```
Only active item cards. `lbsPerBag` is what the item card says (its `bags` field, 50 or 100); preselect it in the **Lbs per bag** box.

## 3. API
| Call | Needs | |
|---|---|---|
| `GET /yarn-inwards/form-data` | VIEW | as above |
| `GET /yarn-inwards?page=&limit=&search=&type=&customerId=&vendorId=&itemId=&dateFrom=&dateTo=` | VIEW | list, newest first (`limit` up to 500, default 50) |
| `GET /yarn-inwards/:id` | VIEW | one |
| `POST /yarn-inwards` | FULL | add, 201 |
| `PATCH /yarn-inwards/:id` | FULL | change |
| `DELETE /yarn-inwards/:id` | FULL | `{ deleted: true, id }` |

### Create
```json
{ "vendorId": "...", "itemId": "...", "bags": 10, "lbsPerBag": 100, "ratePerLb": 350.5,
  "inwardDate": "2026-11-10", "dcNo": "DC-9", "remarks": "..." }
```
(or `"customerId"` instead of `vendorId`, with no rate). `vendorId` and `customerId` together, or none: 400. Dates are `YYYY-MM-DD`.

### The entry
```json
{ "id": "...", "code": 1, "inwardDate": "2026-11-10", "type": "PURCHASE",
  "party": { "kind": "VENDOR", "id": "...", "code": 1, "name": "Yarn Mills" },
  "vendorId": "...", "customerId": null, "itemId": "...",
  "item": { "id": "...", "code": 1, "name": "22|s Cotton - Crescent - 24 - 100", "yarnCount": {...}, "brand": {...}, "packing": 24, "bags": 100 },
  "bags": 10, "lbsPerBag": 100, "totalLbs": 1000, "ratePerLb": 350.5, "amount": 350500,
  "dcNo": "DC-9", "remarks": null, "createdAt": "..." }
```
`code` = the running **Inward ID** of the company (1, 2, 3 ...). `type` is `PURCHASE` or `OVERHEAD`. For overhead yarn without a rate, `ratePerLb` and `amount` are `null`.

### List answer
`{ data: [entries], page, limit, total, totals: { bags, totalLbs, amount } }` — `totals` is for the **whole filtered list**, not just the page. `search` finds the party name, the DC no, the count or brand name, or the inward ID number.

### Edit
`PATCH` takes any of `inwardDate, itemId, bags, lbsPerBag, ratePerLb, dcNo, remarks`, and the party **inside its own kind** (`vendorId` for a purchase, `customerId` for overhead). Totals and amount are worked out again. (Later, once yarn is taken out of stock, the server will refuse changes that would make stock negative; for now edit and delete are open.)

## 4. Errors
- 400 `VALIDATION_FAILED`: both or neither of `vendorId` / `customerId`; `bags` not a whole number ≥ 1; `lbsPerBag` ≤ 0; bad date.
- 422 `RATE_REQUIRED` (`details.field: "ratePerLb"`): a purchase needs a rate (also when an edit clears it).
- 422 `UNKNOWN_VENDOR` / `UNKNOWN_CUSTOMER` / `UNKNOWN_ITEM`: not of this company.
- 422 `VENDOR_INACTIVE` / `CUSTOMER_INACTIVE` / `ITEM_INACTIVE`: switched off (an old entry keeps showing its switched-off party / item).
- 422 `TYPE_LOCKED`: tried to put a customer on a purchase entry or a vendor on an overhead entry.
- 403 no access or `VIEW` only; 404 unknown id / another company's.
- Item card or vendor deleting: 422 `IN_USE` while a yarn inward uses it (`details.yarnInwards: n` for item cards). Switch it off instead.

## Not in this step
Stock, yarn outward, challans, gate passes and accounting vouchers come in the next steps.

## Database
Migrations `20261203000001-weaving-yarn-inward.js` (`yarn_inwards`) and `20261204000001-weaving-own-customers-vendors.js` (`module` column on customers / vendors). Run `npm run db:migrate`.
