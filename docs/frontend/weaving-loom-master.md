# Weaving — Masters > Loom (new master) — Frontend Guide

A new master in **Weaving > Masters > Loom**. A loom has a **loom no** and the **Department** it belongs to (e.g. *Sulzer*, *Airjet*). First add the departments (Masters > Department, already there), then add the looms. Service `WEAVING_MASTERS` (VIEW reads, FULL changes), base `/api/v1/weaving`.

The beams are put on the looms in the **Sizing Management** module (see `sizing-looms.md`); this master only defines the looms.

## Endpoints — `/api/v1/weaving/looms`
- `GET /weaving/looms?page=&limit=&search=&departmentId=&isActive=&running=` → `{ data: [ loom… ], page, limit, total }`, sorted by department, then loom no. `search` = loom no or department name. `running=true` = looms with beams on them, `false` = idle looms.
- `POST /weaving/looms` `{ "loomNo": "001", "departmentId": "<department id>", "isActive": true }` → 201.
  - `loomNo`: 1–20 characters, **unique per company** (letter case does not matter; extra spaces are squeezed) → 422 `DUPLICATE_ENTRY` (`details.field = "loomNo"`). `departmentId` is **required** (a department of Masters > Department): 422 `UNKNOWN_DEPARTMENT`, 422 `DEPARTMENT_INACTIVE`.
- `GET /weaving/looms/:id`
- `PATCH /weaving/looms/:id` `{ loomNo?, departmentId?, isActive? }`. A loom with beams running on it cannot be switched off (422 `LOOM_RUNNING`).
- `DELETE /weaving/looms/:id` → `{ deleted: true, id }`. A loom that has (had) beam entries cannot be deleted: 422 `IN_USE` (`details.entries`); switch it off instead. A deleted loom's number can be used again.

Loom JSON:
```json
{ "id": "...", "code": 1, "loomNo": "001", "isActive": true, "departmentId": "...", "department": { "id": "...", "code": 1, "name": "Sulzer" },
  "beamsOnLoom": 2, "running": true, "activeKIds": [338], "canTakeBeams": false, "createdAt": "..." }
```
`running` = beams are on it now; `beamsOnLoom` 0–2; `canTakeBeams` = switched on and fewer than 2 beams.

## Department master
`/weaving/departments` is unchanged. A department that has **looms** (or beams) cannot be deleted any more: 422 `IN_USE` (switch it off instead).

## UI
Add **Loom** under Masters (menu: ... Department, **Loom**, Quality, Beam) with the same table + form as the other masters: columns Code, Loom no, Department, Active; form fields Loom no + Department dropdown (`GET /weaving/departments?isActive=true`) + Active switch. A department filter on the list is handy.

## Database
Migration `20261231000001-weaving-looms.js` (tables `looms`, `loom_entries`, `loom_entry_beams`). Run `npm run db:migrate`.
