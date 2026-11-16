# Weaving — Brand master and Item Card — Frontend Guide

Two more screens under **Weaving > Masters**: **Brand** and **Item Card**. They use the same service as Yarn Count (`WEAVING_MASTERS`: `VIEW` = read, `FULL` = add / edit / delete; see `weaving-yarn-count.md`). All calls are under `/api/v1/weaving`.

## 1. Brand — `/weaving/brands`
Exactly like Yarn Count (same calls, same answer): a unique name per company.
| Call | Needs |
|---|---|
| `GET /brands?page=&limit=&search=&isActive=` | VIEW — `{ data, page, limit, total }`, ordered by `code` (limit up to 500: use it for dropdowns) |
| `GET /brands/:id` | VIEW |
| `POST /brands` `{ name, isActive? }` | FULL, 201 |
| `PATCH /brands/:id` `{ name?, isActive? }` | FULL |
| `DELETE /brands/:id` | FULL |

Row: `{ id, code, name, isActive, createdAt }` (`code` = running number 1, 2, 3 ... shown as ID).
- Duplicate name in any letter case / extra spaces: 422 `DUPLICATE_ENTRY`, `message: "Duplicate entry: brand \"Crescent\" already exists"`.
- A brand that an item card uses cannot be deleted: 422 `IN_USE` (`details: { itemCards: n }`). Tell the user to switch it off instead (`isActive: false`).

**Yarn Count has the same new rule**: deleting a count used by an item card gives 422 `IN_USE`.

## 2. Item Card — `/weaving/item-cards`
An item card = **yarn count + brand + packing + bags**.
- **Yarn count**: dropdown from `GET /yarn-counts?isActive=true&limit=500` (send `yarnCountId`).
- **Brand**: dropdown from `GET /brands?isActive=true&limit=500` (send `brandId`).
- **Packing** and **Bags**: dropdowns with fixed values, from `GET /item-cards/options`:
  ```json
  { "packings": [8, 12, 24, 40], "defaultPacking": 24, "bags": [50, 100], "defaultBags": 100 }
  ```
  Preselect `defaultPacking` (24) and `defaultBags` (100). Left out in the request = the defaults.

| Call | Needs |
|---|---|
| `GET /item-cards/options` | VIEW |
| `GET /item-cards?page=&limit=&search=&isActive=&yarnCountId=&brandId=` | VIEW — `search` finds part of the count or brand name |
| `GET /item-cards/:id` | VIEW |
| `POST /item-cards` `{ yarnCountId, brandId, packing?, bags?, isActive? }` | FULL, 201 |
| `PATCH /item-cards/:id` any of `yarnCountId, brandId, packing, bags, isActive` | FULL |
| `DELETE /item-cards/:id` | FULL → `{ deleted: true, id }` |

A row:
```json
{ "id": "...", "code": 1, "name": "22|s Cotton - Crescent - 24 - 100",
  "yarnCount": { "id": "...", "code": 3, "name": "22|s Cotton" },
  "brand": { "id": "...", "code": 1, "name": "Crescent" },
  "packing": 24, "bags": 100, "isActive": true, "createdAt": "..." }
```
`id` is the unique id used by later forms (yarn inward etc.); `code` is the running number of the company (show as ID); `name` is ready text for dropdowns of later screens.

### Errors
- 422 `DUPLICATE_ENTRY` (`details.field: "combination"`): a card with the same yarn count + brand + packing + bags already exists. Same count and brand with another packing or bags is a different card.
- 422 `UNKNOWN_YARN_COUNT` / `UNKNOWN_BRAND`: the id is not of this company.
- 422 `YARN_COUNT_INACTIVE` / `BRAND_INACTIVE`: a switched-off count / brand cannot be picked for a new card (an old card that already has it can still be edited in its other fields).
- 400 `VALIDATION_FAILED`: missing `yarnCountId` / `brandId`, `packing` not in 8, 12, 24, 40, `bags` not in 50, 100.
- 403 no access / VIEW only; 404 unknown id or another company's.

### Screen suggestion
Table: ID, Yarn Count, Brand, Packing, Bags, Active switch, Edit, Delete; filters Yarn Count and Brand, search box. Add / edit form: Yarn Count, Brand, Packing (24 preselected), Bags (100 preselected). The numbers carry no unit in the API: label them as the sir/owner names them on the existing screens.

## Database
Migration `20261202000001-weaving-brands-item-cards.js` (`yarn_brands`, `yarn_items`). Run `npm run db:migrate`.
