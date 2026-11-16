# Weaving — Yarn Stock — Frontend Guide

New screen **Weaving > Yarn Stock**: how much yarn we have. It is built from the yarn inward entries; the yarn **outward** (next step) will take from it, and the **balance** is what is left. No new menu service: it uses `WEAVING_MASTERS` (`VIEW` is enough).

## API
`GET /api/v1/weaving/yarn-stock`

Optional filters: `search` (part of the yarn count or brand name), `yarnCountId`, `brandId`, `itemId` (item card), `type` (`PURCHASE` = yarn from vendors, `OVERHEAD` = the customers' own yarn; leave out for both), `dateTo` (`YYYY-MM-DD`: the stock as it was at the end of that day), `showZero` (`true` shows rows whose balance is 0; default they are hidden).

No paging: all rows come in one answer.

```json
{ "data": [ {
    "itemId": "...", "itemCode": 1, "name": "22|s Cotton - Crescent - 24 - 100",
    "yarnCount": { "id": "...", "name": "22|s Cotton" },
    "brand": { "id": "...", "name": "Crescent" },
    "packing": 24,
    "lbsPerBag": 100,
    "inwardBags": 15,  "inwardLbs": 1500,
    "outwardBags": 0,  "outwardLbs": 0,
    "balanceBags": 15, "balanceLbs": 1500 } ],
  "totals": { "inwardBags": 21, "inwardLbs": 1802, "outwardBags": 0, "outwardLbs": 0, "balanceBags": 21, "balanceLbs": 1802 },
  "total": 3 }
```

## What one row is
One row = **one item card and one lbs-per-bag**: all the bags of a row weigh the same. The same item card received with 100 lbs bags and with 50.5 lbs bags makes **two rows**.
- **Yarn Count**, **Brand**, **Packing**: from the item card (`yarnCount.name`, `brand.name`, `packing`).
- **Lbs** (per bag): `lbsPerBag`.
- **Bags**: `balanceBags` (the main figure). `inwardBags` / `outwardBags` are the parts of it.
- **Balance**: `balanceBags` and `balanceLbs` (= bags × lbs per bag, added up). Balance = inward − outward.
- `outwardBags` / `outwardLbs` are **0 for now**; they will be filled when the yarn outward screen is built. Build the columns now so the screen does not change then.

## Screen suggestion
Columns: **Yarn Count | Brand | Packing | Lbs (per bag) | Bags | Total Lbs (balance)**, and, if you want the detail, In Bags / In Lbs / Out Bags / Out Lbs. Cards on top from `totals` (Balance bags, Balance lbs). Filters: search box, Yarn Count, Brand, Purchase / Overhead / All switch, "as on" date, a "show zero" switch. Rows are sorted by yarn count, brand, packing, lbs per bag.

## Notes
- A deleted yarn inward leaves the stock at once; an edited one changes it.
- Purchase and overhead yarn are both in the stock; use `type` to see them apart (overhead yarn belongs to the customers).
- Another company's stock is never shown. 403 when the user has no `WEAVING_MASTERS`.
- Later (yarn outward step) the server will refuse an edit or delete of an inward that would make the stock negative; nothing for the frontend to do now.
