# STORE part 2: Department Chemical Access (frontend guide)

Small step. Only ONE new screen in the Chemical Store, and ONE small list for department screens.
Build this AFTER the Inwards and Stock screens (store-inwards.md).

---------------------------------------------------------------
# PART A: WHAT IS IN THE BACKEND AND DATABASE

## A1. The rule
- The Chemical Store decides **which chemicals each department can see**.
- A department sees **NO chemical** until the Chemical Store gives it some.
- Example: Dyeing gets all "VAT DYES" + "RED". Printing gets nothing yet, so Printing sees an empty list.
- Later (next step), a department can request ONLY the chemicals it can see.

## A2. Database
| Table | What it keeps |
|---|---|
| `department_chemicals` (NEW, migration 20261016000003) | one row per department + chemical that the department may see: `companyId`, `departmentId` (the department service), `itemId` (the chemical), `createdById`, `createdAt`. No row = not visible. |
Nothing else changed. Every change is written to the audit log.

## A3. Who can do what
- **Give / take away chemicals**: users with FULL access to "Chemical Store" (and the client admin).
- **See the access screen**: VIEW access to "Chemical Store".
- **Department chemical list**: the client admin, or a user who has that department's service.

Base URL `/api/v1`. Header: `Authorization: Bearer TOKEN`.
Errors: `{ "error": { "code": "...", "message": "..." } }`. Show `message` in a toast.

---------------------------------------------------------------
# PART B: SCREENS

## B1. Chemical Store -> "Department Access" screen

### Step 1: departments list (left side or a dropdown)
`GET /stores/chemical/department-access`
```json
{ "data": [
  { "id": "uuid", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS", "chemicalCount": 8 },
  { "id": "uuid", "code": "PRINTING", "name": "Printing", "kind": "PROCESS", "chemicalCount": 0 } ] }
```
Show each department with its count, e.g. "Dyeing (8)", "Printing (0)". Click a department -> Step 2.

### Step 2: that department's chemicals (right side)
`GET /stores/chemical/department-access/:departmentId` (department `id`, or its `code` like `DYEING`)
```json
{ "department": { "id": "uuid", "code": "DYEING", "name": "Dyeing" },
  "allowedCount": 8, "totalCount": 220,
  "groups": [
    { "category": { "id": "uuid", "name": "VAT DYES" }, "allowedCount": 7,
      "items": [ { "id": "uuid", "name": "VAT NAVY BLUE SPL", "label": "VAT DYES / VAT NAVY BLUE SPL", "unit": "KG", "allowed": true } ] },
    { "category": { "id": "uuid", "name": "COTTON COLOUR (REACTIVE DYES)" }, "allowedCount": 1,
      "items": [ { "id": "uuid", "name": "RED", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG", "allowed": true } ] } ] }
```
Layout:
- Top: "Dyeing: 8 of 220 chemicals" (`allowedCount` of `totalCount`). A search box (filter on screen by `name`).
- One collapsible block per category: header = category name + "7 / 7" (`allowedCount` / number of items) + a **"Select all" checkbox** for that category.
- Inside: one checkbox per chemical (ticked when `allowed` is true), with the name and unit.
- `category` can be null for chemicals without a category: show that block as "No category".
- Buttons: **Save** and **Cancel**. (Optional: "Select all chemicals" / "Clear all".)

### Step 3: Save
Send the WHOLE ticked list (simplest):
`PUT /stores/chemical/department-access/:departmentId`
```json
{ "itemIds": ["uuid", "uuid", "uuid"] }
```
- `itemIds` = every ticked chemical. Unticked = removed. `[]` = the department sees nothing.
- Response: `{ "department": {...}, "allowedCount": 8, "added": 1, "removed": 0 }` -> toast "Saved: 8 chemicals for Dyeing". Reload Step 1 (counts).

Other way (optional, for instant ticks without a Save button): send only the change:
```json
{ "add": ["uuid"] }        // tick one chemical or a whole category
{ "remove": ["uuid"] }     // untick
```

Errors: `UNKNOWN_ITEM` (a chemical is not in the chemical store: reload), 404 (department not found), 403 (no FULL access to Chemical Store).

## B2. Department screens -> "My Chemicals" list
On every department screen (Dyeing, Printing, ...) the chemicals list comes from:
`GET /departments/:code/chemicals?search=&categoryId=`  (e.g. `/departments/DYEING/chemicals`)
```json
{ "department": { "id": "uuid", "code": "DYEING", "name": "Dyeing" },
  "data": [
    { "id": "uuid", "name": "RED", "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG",
      "category": { "id": "uuid", "name": "COTTON COLOUR (REACTIVE DYES)" },
      "hasSubUnit": true, "subUnit": "G",
      "stockQty": 3.5, "stock": { "main": 3, "mainUnit": "KG", "sub": 500, "subUnit": "G", "text": "3 KG 500 G" } } ] }
```
- Only the chemicals given to this department come back. Empty list -> show "No chemicals given to this department yet. Ask the Chemical Store."
- Show: Chemical (`label`), Unit, Store stock (`stock.text`).
- This list will be the dropdown of the chemical REQUEST form in the next step. For now just show it (a small "My Chemicals" tab).
- 403: the user does not have this department.

## B3. Example
1. Chemical store opens Department Access -> Dyeing -> ticks "Select all" on VAT DYES and ticks RED -> Save -> "Dyeing (8)".
2. Dyeing user opens My Chemicals -> sees those 8 only. Printing user sees an empty list.
3. Store unticks RED for Dyeing -> Save -> Dyeing no longer sees RED.
