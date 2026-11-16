# Store Management — Fabric Inward (cloth bought from a vendor) — Frontend Guide

## Why it exists
A customer gives us cloth to process (normal **Grey Inward** → SO card). Sometimes that cloth is spoilt during processing (all of it, a few thaans, or some thaans of one of the customer's lots). We still owe the customer finished cloth, so we **buy cloth from a vendor**, process that and give it to the customer. **Fabric Inward** records this bought cloth. It is the Grey Inward form with a **Vendor** in place of the **Customer**; everything else is the same. Outward (using this cloth) and stock management come in the next steps; this step is the **inward** and its **stock**.

## Menu and access
- New service **`FABRIC_STORE`** ("Fabric Store", menu tab **STORE**, next to Chemical Store / General Items Store). The super admin / client admin gives it to users like any service. Without it every call below answers 403. Every existing company already has it.
- **VIEW** = lists, details, stock, form data. **FULL** = add, edit, delete drafts, approve, active toggle. **Client admin** = take an approval back, change the numbering.
- The vendor list `GET /api/v1/vendors` (and create / edit vendor) is also open to a Fabric Store user, so the "New vendor" button works on this screen.

## Entry screen — `GET /api/v1/fabric-inwards/form-data`
```json
{ "nextInwardNo": 1, "nextInwardText": "00001", "nextTypeNo": "0001", "today": "2026-11-12", "units": ["METER","YARD"],
  "vendors": [ { "id": "...", "code": 1, "name": "Cloth Mills", "label": "Cloth Mills (1)", ... } ],
  "qualities": [ { "id": "...", "name": "PC TWILL" } ] }
```
Vendors are the **normal (processing) vendors** (not the weaving ones). Only active vendors / qualities are listed.

## Add — `POST /api/v1/fabric-inwards`
```json
{ "inwardDate": "2026-11-10", "vendorId": "<vendor>", "qualityId": "<quality>", "dcNo": "DC-9",
  "unit": "METER", "thaans": [60, 40.5, { "length": 50, "width": 58 }], "width": 60,
  "glm": null, "gsm": 120, "partyRef": "PO-77", "vehicleNo": "LEA-123", "remarks": "" }
```
- **Required:** `inwardDate`, `vendorId` and a quality: either `qualityId` **or** `qualityName` (typed by hand: the existing quality with that name is used, otherwise a new one is added to the Quality list). Exactly one of the two.
- **Quantity** (same as Grey Inward): `thaans` = length of every thaan in `unit` (a number, or `{ length, width }` for a thaan with its own width; `width` at the top is the default for thaans without one). Pieces and totals are worked out. Or, without a thaan list, `inwardMeters` (unit METER) / `inwardYards` (unit YARD) + `pieces`. Neither: 422 `QTY_REQUIRED`.
- `unit`: `METER` (default) or `YARD` (1 yard = 0.9144 m). Yard fields are returned only when `unit` is `YARD` (`showYards`).
- `inwardNo` is optional (typed by hand, must be free: 422 `INWARD_NO_TAKEN`). Normally leave it out: the server gives the next number (**00001**) and the **Type#** (**0001**) per company. Both are never reused, even after a delete.
- Answer `201`:
```json
{ "id": "...", "inwardNo": 1, "inwardText": "00001", "typeNo": "0001", "dcNo": "DC-9", "inwardDate": "2026-11-10",
  "vendor": { "id": "...", "code": 1, "name": "Cloth Mills", "label": "Cloth Mills (1)" }, "quality": { "id": "...", "name": "PC TWILL" },
  "unit": "METER", "showYards": false, "inwardMeters": 150.5, "inwardYards": null, "pieces": 3,
  "outwardMeters": 0, "balanceMeters": 150.5, "balanceYards": null, "width": 60, "widths": [58, 60], "glm": null, "gsm": 120,
  "partyRef": "PO-77", "vehicleNo": "LEA-123", "remarks": null,
  "isApproved": false, "statusText": "UN-APPROVED", "approvedAt": null, "isActive": true,
  "thaans": [ { "id": "...", "thaanNo": 1, "meters": 60, "yards": null, "width": 60, "status": "IN_STOCK", "takenMeters": 0, "freeMeters": 60 } ] }
```

## List / one entry
- `GET /api/v1/fabric-inwards?page=1&limit=20&search=&vendorId=&qualityId=&dateFrom=&dateTo=&isActive=&isApproved=` — newest first, `{ data, page, limit, total }`. `search` looks at inward no, DC no, Type#, party ref, vendor name, quality name. The list rows have no `thaans`.
- `GET /api/v1/fabric-inwards/:id` — one entry with its `thaans`.

## Edit, delete, approve
- `PATCH /api/v1/fabric-inwards/:id` — same fields as add (all optional, at least one); send the `thaans` list again to change the quantity. Also `typeNo` and `inwardNo` can be changed (must be free: 422 `TYPE_NO_TAKEN` / `INWARD_NO_TAKEN`). Changing `unit` needs the quantity again (422 `QTY_REQUIRED`). An entry made of thaans needs the thaans list, not a plain total (422 `INWARD_HAS_THAANS`).
- `DELETE /api/v1/fabric-inwards/:id` → 204. The entry leaves the list; its number is not reused.
- `POST /api/v1/fabric-inwards/:id/approve` — the cloth becomes **stock**. An **approved entry cannot be edited or deleted** (422 `INWARD_APPROVED`) — hide Edit / Delete when `isApproved` is true.
- `POST /api/v1/fabric-inwards/:id/unapprove` — **client admin only** (403 for others); 422 `INWARD_IN_USE` once cloth has gone out of the entry (the outward step, next).
- `PUT /api/v1/fabric-inwards/:id/active` `{ "isActive": false }` — the switch. A switched-off entry is not in the stock and cannot be approved (422 `INWARD_INACTIVE`).
- Errors: 422 `UNKNOWN_VENDOR`, `VENDOR_INACTIVE`, `UNKNOWN_QUALITY`, `QUALITY_INACTIVE`, `QUALITY_REQUIRED`, `BELOW_OUTWARD`, `THAAN_TAKEN` (a thaan that has gone out cannot be changed), 404 for an entry of another company.
- A vendor that has fabric inwards cannot be deleted (422 `IN_USE`: switch it off instead).

## Numbering — `GET /api/v1/fabric-inwards/numbering`, `PUT` (client admin)
`GET` → `{ "nextInwardNo": 1, "nextTypeNo": "0001" }`. `PUT { "nextInwardNo": 100, "nextTypeNo": 700 }` (either one) carries on from the old system; a number that is already used is refused (422 `NUMBER_USED`).

## Fabric stock — `GET /api/v1/fabric-inwards/stock`
Query: `page`, `limit`, `search`, `vendorId`, `qualityId`, `dateFrom`, `dateTo`, `showZero` (default false: used-up entries are hidden). Only **approved, switched-on** entries are stock; balance = inward − outward.
```json
{ "totals": { "entries": 2, "inwardMeters": 250.5, "outwardMeters": 0, "balanceMeters": 250.5, "balanceYards": 273.95 },
  "byQuality": [ { "quality": { "id": "...", "name": "PC TWILL" }, "entries": 1, "inwardMeters": 150.5, "outwardMeters": 0, "balanceMeters": 150.5, "balanceYards": 164.6 } ],
  "data": [ { "id": "...", "inwardNo": 1, "inwardText": "00001", "typeNo": "0001", "inwardDate": "2026-11-10", "vendor": {...}, "quality": {...}, "dcNo": "DC-9",
              "pieces": 3, "freePieces": 3, "freeThaanNos": [1,2,3], "inwardMeters": 150.5, "outwardMeters": 0, "balanceMeters": 150.5, "balanceYards": null, "widths": [58,60], ... } ],
  "page": 1, "limit": 100, "total": 2 }
```
Show **byQuality** as the summary cards / table and **data** as the stock list (vendor, quality, DC, Type#, pieces left, balance in meters or yards). Open an entry (`GET /fabric-inwards/:id`) to see its thaans and what is free.

## Database
Migration `20261215000001-fabric-inward.js` (service `FABRIC_STORE`, tables `fabric_inwards`, `fabric_inward_thaans`). Run `npm run db:migrate`.
