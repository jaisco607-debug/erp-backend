# Weaving — Beam weight (kg), the Department master, and beams per department in the Beam Stock — Frontend Guide

Continues `weaving-beam.md` and `weaving-beam-stock.md`. Two things are added to the **Beam** form: its **weight in kg** and its **department**. The department is **not typed on the beam form**: it is picked from a new master, **Masters > Department**, where the departments are added once. The Beam Stock then says **how many beams each department has** (in every place: Empty / Full / At loom / At sizing). Same service as the other weaving masters (`WEAVING_MASTERS`: VIEW reads, FULL changes).

## 1. New master — Masters > Department (`/api/v1/weaving/departments`)
Exactly like the **Brand** / **Yarn Count** masters: a unique **name** per company (capital / small letters and extra spaces do not count: "weaving a" = "Weaving  A"), a running **code** (1, 2, 3 ...), an **active** switch, delete.
- `GET /weaving/departments?page=&limit=&search=&isActive=` → `{ data: [ { id, code, name, isActive, createdAt } ], page, limit, total }`
- `POST /weaving/departments` `{ "name": "Weaving A", "isActive": true }` → 201 (422 `DUPLICATE_ENTRY` if the name exists, `details.field = "name"`)
- `GET /weaving/departments/:id`, `PATCH /weaving/departments/:id` `{ name?, isActive? }`, `DELETE /weaving/departments/:id` → `{ deleted: true, id }`
- A department that **has beams cannot be deleted**: 422 `IN_USE` (`details.beams` = how many beams); switch it off instead (`isActive: false`). A deleted department's name can be used again.
Add a "Department" page under Masters (menu: Yarn Count, Brand, Item Card, Customers, Vendors, **Department**, Beam) with the same table + form as Brand.

## 2. Beam form — two new fields
`POST /api/v1/weaving/beams` and `PATCH /api/v1/weaving/beams/:id` take two optional fields next to `beamNo, name, beamDate ...`:
```json
{ "name": "Wrap Beam 0001", "weightKg": 52.5, "departmentId": "<department id>" }
```
- **`weightKg`**: weight in kg, a positive number with up to 2 decimals (`0` or a negative number → 400). `null` clears it.
- **`departmentId`**: a department of the **Department master** (dropdown from `GET /weaving/departments?isActive=true`; add a "New department" shortcut if you like). `null` clears it. 422 `UNKNOWN_DEPARTMENT` (not found / another company's), 422 `DEPARTMENT_INACTIVE` (switched off — it can still stay on a beam that already has it).
- Both are **optional** (older beams have none).
- The beam JSON (add / edit / list / one beam, and everywhere a beam is listed, e.g. the empty beams for sizing) now has: `weightKg` (number | null), `departmentId`, and **`department: { id, code, name } | null`**. Show **Department** and **Weight (kg)** columns in the Beam list.
- Beam list filters: `GET /weaving/beams?departmentId=<id>` (that department's beams) and `?noDepartment=true` (beams with no department), next to the existing `search / status / isActive / dateFrom / dateTo`.

## 3. Beam Stock — beams per department (`GET /api/v1/weaving/beam-stock`)
The answer keeps what it had and adds the weight and the department breakdown:
```json
{ "total": 4, "totalWeightKg": 112.5, "asOf": "2026-12-01",
  "statuses": [ { "status": "EMPTY", "text": "Empty", "count": 2, "weightKg": 60 }, { "status": "FULL", "text": "Full", "count": 1, "weightKg": 52.5 },
                { "status": "AT_LOOM", "text": "At loom", "count": 1, "weightKg": 0 }, { "status": "AT_SIZING", "text": "At sizing", "count": 0, "weightKg": 0 } ],
  "departments": [
    { "department": { "id": "...", "code": 1, "name": "Weaving A" }, "isActive": true, "total": 3, "weightKg": 102.5,
      "statuses": [ { "status": "EMPTY", "text": "Empty", "count": 1, "weightKg": 50 }, { "status": "FULL", "text": "Full", "count": 1, "weightKg": 52.5 }, { "status": "AT_LOOM", "text": "At loom", "count": 1, "weightKg": 0 }, { "status": "AT_SIZING", "text": "At sizing", "count": 0, "weightKg": 0 } ] },
    { "department": null, "isActive": true, "total": 1, "weightKg": 10, "statuses": [ ... ] } ] }
```
- `statuses[].weightKg` / `totalWeightKg` add up the weights of the beams that have one (a beam without weight adds 0).
- **`departments`** = one row per department: how many beams it has in each place and its total. Every **switched-on** department is listed (also with 0 beams); a switched-off one only while it has beams. A row with **`department: null`** = beams that have **no department** (only present when there are such beams). Show it as a table (rows = departments, columns = Empty / Full / At loom / At sizing / Total / Weight) or as department cards.
- Only switched-on beams count (as before).
- **Details** (click a number): `GET /weaving/beam-stock/:status?search=&departmentId=<id>&noDepartment=true` — the beams of one place; with `departmentId` only that department's beams (click a cell of the department table: pass the department and the place). The answer now has `weightKg` (total of the listed beams) and every beam row has `weightKg` and `department: { id, code, name } | null`.

## Database
Migration `20261224000001-weaving-beam-department-weight.js` (table `weaving_departments`, `yarn_beams.weightKg` and `yarn_beams.departmentId`). Run `npm run db:migrate`.
