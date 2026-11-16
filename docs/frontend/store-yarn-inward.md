# Store Management — Yarn Inward (yarn bought from a vendor) and Yarn Stock — Frontend Guide

Yarn (dhaaga) is also needed for processing, so it is bought from a vendor like the fabric. **Yarn Inward** records it in the **Store**. It is **not** the weaving yarn inward: there is **no yarn count master and no item card here**. Everything is **typed on the form**; only the **vendor** is picked from the vendor list. Outward (using the yarn) and stock management come in the next step; this step is the **inward** and its **stock**.

## Menu and access
- New service **`YARN_STORE`** ("Yarn Store", menu tab **STORE**, next to Fabric / Chemical / General). Given to users like any service; without it every call below answers 403. Every existing company already has it.
- **VIEW** = lists, details, stock, form data. **FULL** = add, edit, delete drafts, approve, active toggle. **Client admin** = take an approval back, change the numbering.
- The vendor list `GET /api/v1/vendors` (and create / edit vendor) is also open to a Yarn Store user, so "New vendor" works on this screen.
- Base URL of everything below: `/api/v1/store-yarn-inwards`.

## The idea of the entry
One entry = one arrival of one yarn from one vendor. **All bags of the arrival weigh the same** (e.g. 10 bags × 50 lbs).
- `totalLbs = bags × lbsPerBag`
- `amount = totalLbs × ratePerLb` (the rate is **per lb**, as the vendor quotes it; empty until a rate is typed)

## Form data — `GET /form-data`
```json
{ "nextInwardNo": 1, "nextInwardText": "00001", "today": "2026-11-26",
  "vendors": [ { "id": "...", "code": 1, "name": "Yarn Mills", "label": "Yarn Mills (1)", ... } ],
  "yarnNames": ["22/s Cotton"], "brands": ["Crescent"], "lbsPerBagValues": [50, 45.5] }
```
`vendors` = active normal (processing) vendors. `yarnNames`, `brands`, `lbsPerBagValues` are what was typed on earlier entries (most used first): use them as **suggestions** (datalist / autocomplete) for the typed fields; the user can still type anything new.

## Add — `POST /`
```json
{ "inwardDate": "2026-11-10", "vendorId": "<vendor>", "yarnName": "22/s Cotton", "brand": "Crescent",
  "bags": 10, "lbsPerBag": 50, "ratePerLb": 300, "dcNo": "Y-1", "remarks": "" }
```
- **Required:** `inwardDate`, `vendorId`, `yarnName` (typed, up to 120 chars; extra spaces are squeezed), `bags` (whole number ≥ 1), `lbsPerBag` (> 0, decimals allowed, e.g. 45.5).
- **Optional:** `brand` (typed), `ratePerLb` (> 0, up to 4 decimals; **per lb**), `dcNo` (the vendor's delivery challan), `remarks`, `inwardNo` (typed by hand, must be free: 422 `INWARD_NO_TAKEN`; normally leave it out: the server gives the next number **00001** per company, never reused).
- Show a live preview on the form: **total lbs** (`bags × lbsPerBag`) and **amount** (`total lbs × rate`). The server works out the same numbers.
- Answer `201`:
```json
{ "id": "...", "inwardNo": 1, "inwardText": "00001", "inwardDate": "2026-11-10",
  "vendor": { "id": "...", "code": 1, "name": "Yarn Mills", "label": "Yarn Mills (1)" },
  "yarnName": "22/s Cotton", "brand": "Crescent", "title": "22/s Cotton - Crescent",
  "bags": 10, "lbsPerBag": 50, "totalLbs": 500, "ratePerLb": 300, "hasRate": true, "amount": 150000,
  "outwardBags": 0, "balanceBags": 10, "balanceLbs": 500, "balanceValue": 150000,
  "dcNo": "Y-1", "remarks": null, "isApproved": false, "statusText": "UN-APPROVED", "approvedAt": null, "isActive": true, "createdAt": "..." }
```
`title` = "yarn name - brand" (just the name when there is no brand): use it for lists and the stock. Without a rate `hasRate` is false and `amount` / `balanceValue` are null (show a "No rate" badge). A rate is not required to save or approve (the stock works without it).
- Errors: 400 for missing / wrong fields (e.g. `bags: 0`, `bags: 2.5`, empty `yarnName`); 422 `UNKNOWN_VENDOR`, `VENDOR_INACTIVE`.

## List / one entry
- `GET /?page=1&limit=20&search=&vendorId=&dateFrom=&dateTo=&isActive=&isApproved=` — newest first: `{ data, page, limit, total, totals: { entries, allBags, allLbs, allAmount } }`. `search` looks at yarn name, brand, DC no, vendor name and (a number) the inward no. `totals` count all entries of the company.
- `GET /:id` — one entry.

## Edit, delete, approve
- `PATCH /:id` — same fields as add, all optional (at least one). `ratePerLb: null` clears the rate. `brand: ""` clears the brand. Total and amount are worked out again.
- `DELETE /:id` → 204 (drafts only; the number is not reused).
- `POST /:id/approve` — the yarn becomes **stock**. An **approved entry cannot be edited or deleted** (422 `INWARD_APPROVED`): hide Edit / Delete when `isApproved`.
- `POST /:id/unapprove` — **client admin only** (403 for others); 422 `INWARD_IN_USE` once bags have gone out of the entry (the outward step, next).
- `PUT /:id/active` `{ "isActive": false }` — a switched-off entry is not in the stock and cannot be approved (422 `INWARD_INACTIVE`).
- A vendor that has yarn inwards cannot be deleted (422 `IN_USE`): switch it off instead.

## Numbering — `GET /numbering`, `PUT /numbering` (client admin)
`GET` → `{ "nextInwardNo": 1 }`. `PUT { "nextInwardNo": 100 }` carries on from the old system; a number already used is refused (422 `NUMBER_USED`).

## Yarn stock — `GET /stock`
Query: `page`, `limit`, `search`, `vendorId`, `dateFrom`, `dateTo`, `showZero` (default false: used-up entries are hidden). Only **approved, switched-on** entries are stock; balance = bags − outward bags.
```json
{ "totals": { "entries": 3, "inwardBags": 16, "balanceBags": 16, "balanceLbs": 1020, "balanceValue": 274000 },
  "byYarn": [ { "yarnName": "22/S COTTON", "brand": "crescent", "title": "22/S COTTON - crescent", "entries": 2, "inwardBags": 14, "balanceBags": 14, "balanceLbs": 900, "balanceValue": 274000 } ],
  "data": [ { "id": "...", "inwardNo": 2, "inwardDate": "2026-11-11", "vendor": {...}, "title": "...", "bags": 4, "lbsPerBag": 100, "outwardBags": 0, "balanceBags": 4, "balanceLbs": 400, "ratePerLb": 310, "balanceValue": 124000, ... } ],
  "page": 1, "limit": 100, "total": 3 }
```
- `byYarn` adds the same yarn together (**yarn name + brand, letter case ignored**, so "22/s Cotton" and "22/S COTTON" are one yarn; the title shown is the newest spelling): show it as the summary table / cards.
- `data` = one row per entry (vendor, yarn, DC, bags and lbs left, value left) — the detailed stock list.
- `balanceValue` = value of what is left = amount × balance bags ÷ bags (null without a rate; counts as 0 in the totals).

## Database
Migration `20261220000001-store-yarn-inward.js` (service `YARN_STORE`, table `store_yarn_inwards`). Run `npm run db:migrate`.
Not in this step (next): the **outward** of yarn and its stock management, and the accounts (purchase invoice) for yarn bought here.
