# Weaving — Masters > Quality (new master) and the Quality on the Sizing Batch — Frontend Guide

A new master in **Weaving > Masters > Quality**, exactly like the **Brand** / **Yarn Count** / **Department** masters (service `WEAVING_MASTERS`: VIEW reads, FULL changes). The qualities are added once here (e.g. `60X60/90X82=136"CTN`) and then **picked on the Sizing Batch**.

## 1. Master — `/api/v1/weaving/qualities`
- `GET /weaving/qualities?page=&limit=&search=&isActive=` → `{ data: [ { id, code, name, isActive, createdAt } ], page, limit, total }`
- `POST /weaving/qualities` `{ "name": "60X60/90X82=136\"CTN", "isActive": true }` → 201. The **name is unique** per company (capital / small letters and extra spaces do not count: `60x60 ...` = `60X60 ...`) → 422 `DUPLICATE_ENTRY` (`details.field = "name"`). Name: 1–80 characters, any text. `code` = running number (1, 2, 3 ...).
- `GET /weaving/qualities/:id`
- **Edit** `PATCH /weaving/qualities/:id` `{ name?, isActive? }` — a quality can always be **renamed** (the batches that use it show the new name at once) or switched on / off.
- `DELETE /weaving/qualities/:id` → `{ deleted: true, id }`. A quality **used by a sizing batch cannot be deleted**: 422 `IN_USE` (`details.sizingBatches` = how many); switch it off instead (`isActive: false`). A deleted quality's name can be used again.
Add a **Quality** page under Masters (menu: Yarn Count, Brand, Item Card, Customers, Vendors, Department, **Quality**, Beam) with the same table + form (add / edit / delete / active switch) as Brand.

## 2. On the Sizing Batch (`/api/v1/sizing`)
The free-text **Quality** box of the batch form is **replaced by a dropdown** from this master.
- `GET /sizing/batches/form-data` now also returns **`qualities`**: `[ { id, code, name } ]` (only switched-on ones; the Sizing user does not need access to the weaving masters). Show a "+" shortcut to add a quality if the user has Weaving Masters access.
- `POST /sizing/batches` and `PATCH /sizing/batches/:id` take **`qualityId`** (optional; `null` clears it; draft batches only). The old `quality` text field is **no longer accepted** (400). 422 `UNKNOWN_QUALITY` (not found / another company's), 422 `QUALITY_INACTIVE` (switched off; it may stay on a batch that already has it).
- The batch (one / list) has **`qualityId`**, **`qualityMaster`** `{ id, code, name } | null` and **`quality`** (the name as text, for the column: from the master; for a batch made **before** this change it is the old typed text and `qualityId` is `null`).
- `GET /sizing/batches?search=` also finds the quality name.

## Database
Migration `20261229000001-weaving-quality-master.js` (table `weaving_qualities`, column `sizing_batches.qualityId`). Run `npm run db:migrate`.
