# Reports — Grey: deleted / cancelled lots (Frontend Guide)

Two new reports in **Production > Reports > Grey / Inward** (same permission as the other grey reports: `REPORT_GREY`, or the Grey Store / SO Card service). Both are listed in `GET /v1/reports` (`grey-deleted-lots`, `grey-lot-gaps`), so the menu shows them without a frontend change.

## What is recorded
A grey lot that is deleted is **not erased**: it stays in the database (soft delete) and its number is never reused. Now it also keeps who removed it, what kind of removal it was and an optional reason.
- `DELETE /v1/grey-lots/:id` accepts an optional body `{ "reason": "Entered twice" }` (max 300 chars). Send it if the screen has a reason box; without it nothing changes.
- Cloth of the Fabric Store: when its fabric issue is cancelled, deleted or edited and issued again, its lot is removed and recorded as **Cancelled** (reason = "Fabric issue cancelled" / "deleted" / "edited and issued again").
- Old deletions (like LOT# 866) **are shown too**, because the lot was already kept. For them "By" is filled from the audit log, "Reason" is empty.
- A lot that has cloth on an SO card, an approved lot, or a lot with cloth given back cannot be deleted at all, so no lot is ever "Returned"-and-gone. Given-back cloth stays in `Grey: given back`.

## Deleted / cancelled lots
`GET /v1/reports/grey/deleted-lots?dateFrom=&dateTo=&customerId=&qualityId=&search=&page=&limit=`
- `dateFrom` / `dateTo` filter on the **deletion date**. `search` = lot#, type#, DC#, party ref or party name.
- Newest deletion first.

```json
{ "columns": [ { "key": "lotNo", "label": "Lot#", "type": "int" }, { "key": "typeNo", "label": "Type#", "type": "text" }, … ],
  "rows": [ { "lotNo": 866, "typeNo": "0043", "inwardDate": "2026-11-20", "party": "Delizia (1)", "quality": "Silk Fabric (30x40)", "unit": "METER",
              "thaans": 1, "meters": 1212, "dcNo": "", "kind": "Deleted", "reason": "", "deletedAt": "2026-11-20T10:15:00.000Z", "deletedBy": "shahood" } ],
  "total": 1, "page": 1, "limit": 50, "totals": { "thaans": 1, "meters": 1212 },
  "sections": [ … same data, the shape of the other reports … ] }
```
- Columns, in order: Lot# · Type# · Inward date · Party · Quality · Unit · Thaans · Meters · DC# · What happened · Reason · Date · By. Types used: `int`, `date`, `meters`, `datetime`, plain text.
- `kind` is text: `Deleted`, `Cancelled` (Fabric Store lot) or `Returned`.
- Extra fields on every row for a detail view (not columns): `id`, `customer {id,name,code}`, `qualityRef {id,name}`, `totalYards`, `partyRef`, `vehicleNo`, `isReprocess`, `source` (`MANUAL` | `STORE`), `deletedById`.
- `export=true` / `all=true` work like the other reports (no paging).

## Missing lot numbers (gaps)
`GET /v1/reports/grey/lot-gaps?dateFrom=&dateTo=` (dates filter on inward date). Same shape, columns: Lot# · Record · Inward date · Party · Quality · Meters · What happened · Reason · Date · By.
- Lists every lot number between the smallest and the largest that is **not a live lot**: `Record = "Deleted lot"` (with the details of the deleted lot) or `"No record"` (the number was never saved, e.g. a number typed by hand and skipped).
- Newest number first.

## Database
Migration `20270103000001-grey-lot-delete-record.js` (adds `deletedById`, `deleteKind`, `deleteReason` to `grey_lots` and fills them for old deletions). Run `npm run db:migrate`.
