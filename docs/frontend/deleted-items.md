# DELETED ITEMS: delete, revert, delete for good (N-A1)

Owner 2026-11-25. A lot deleted from **Grey Inward** (fabric inward) does not vanish: it goes to a **Deleted items** page where the client admin can **Revert** it or **Delete for good**.

## 1. How it works
1. **Delete** a lot in Grey Inward: a **reason is required** (5 to 300 characters). The lot leaves the Grey Inward list. It goes to **Deleted items**.
2. While the lot waits in Deleted items its **lot number stays taken**: a new Grey Inward entry with the same lot number is refused (**422 `LOT_NO_TAKEN`**, "Lot 101 already exists").
3. **Revert**: the lot comes back to Grey Inward with the same number, thaans, customer, quality and everything it had.
4. **Delete for good** (permanent delete): the lot, its thaans and its returns are removed from the database tables. **One copy of the record is kept** in a separate archive table (shown in the page tab "Permanently deleted", read only). The **lot number is free again**: a new entry with the same lot number can be made.
5. Only the **client admin** sees and uses the page (other users: 403). Lots made by a fabric issue ("cloth from the Fabric Store") are not in this page: they follow their fabric issue.
6. The old rules for deleting stay: an approved lot, or a lot that cloth has gone out of, cannot be deleted (`LOT_APPROVED`, `LOT_IN_USE`).

## 2. Delete a lot now needs a reason (changed route)
`DELETE /api/v1/grey-lots/:id` with a body:
```json
{ "reason": "Entered by mistake" }
```
- `reason`: required, 5 to 300 characters. Without it: **400 `VALIDATION_FAILED`** (`details[].field = "body.reason"`).
- Frontend: the delete dialog has a required **reason box** and a **"type the lot number to confirm"** box; the Delete button stays disabled until both are valid. Send only the `reason`.
- The answer is still **204**.

## 3. The list: `GET /api/v1/deleted-items` (client admin only)
Query: `kind=lot` (the only kind for now), `view=deleted` (default) or `view=permanent`, `search=`, `page=`, `limit=` (max 200).
```json
{
  "view": "deleted",
  "counts": { "deleted": 3, "permanent": 12 },
  "data": [
    { "id": "…", "kind": "lot", "lotNo": 101, "typeNo": "101", "inwardDate": "2026-11-25", "dcNo": "", "partyRef": "",
      "customer": { "id": "…", "name": "AZ", "code": 130 }, "quality": { "id": "…", "name": "PC TWILL" }, "unit": "METER",
      "thaans": 2, "meters": 150, "reason": "Entered by mistake", "deletedAt": "2026-11-25T10:20:00.000Z", "deletedBy": "Ali",
      "canRevert": true, "canPermanentDelete": true }
  ],
  "page": 1, "limit": 50, "total": 3
}
```
`view=permanent` rows (read only, `canRevert` and `canPermanentDelete` are false):
```json
{ "id": "…", "kind": "lot", "lotNo": 101, "title": "Lot 101 - AZ - PC TWILL - 150 m", "typeNo": "101", "inwardDate": "2026-11-25", "meters": 150, "thaans": 2,
  "reason": "Entered twice", "deletedAt": "…", "deletedBy": "Ali", "permanentlyDeletedAt": "…", "permanentlyDeletedBy": "Admin", "canRevert": false, "canPermanentDelete": false }
```
`search` finds the lot number, type number, DC no, party ref, customer, quality and the reason.

## 4. Revert: `POST /api/v1/deleted-items/lot/:id/restore` (no body)
- 200 `{ "id": "…", "lotNo": 101, "restored": true }`. The lot is in Grey Inward again (`GET /grey-lots/:id` works).
- Errors: **422 `NOT_DELETED`** (the lot is not in Deleted items, for example already reverted: reload the list), **422 `NOT_IN_DELETED_ITEMS`** (a fabric-issue lot), **422 `LOT_NO_TAKEN`** (very rare: the number was taken in another way), **404** (not found or another company).

## 5. Delete for good: `POST /api/v1/deleted-items/lot/:id/permanent-delete`
```json
{ "lotNo": 101 }
```
- `lotNo` is the lot number **typed again by the person** (the confirmation). It must be the number of that lot, else **422 `CONFIRM_MISMATCH`** (`details.field = "lotNo"`).
- 200 `{ "id": "…", "lotNo": 101, "permanentlyDeleted": true }`. It **cannot be undone**: the lot is not in Grey Inward, not in Deleted items; only the archive copy remains (tab "Permanently deleted").
- **422 `LOT_HAS_RECORDS`**: other records still point to the lot (a card, a list ...): it cannot be deleted for good; Revert it or ask the backend.
- Errors as in Revert (`NOT_DELETED`, `NOT_IN_DELETED_ITEMS`, 404).

## 6. The screen (suggested)
- Menu item **Deleted items** (client admin only), next to Grey Inward or in the Store menu.
- Two tabs: **Deleted** (count from `counts.deleted`) and **Permanently deleted** (`counts.permanent`, read only).
- Table (Deleted): lot no, date, customer, quality, thaans, meters, reason, deleted by, deleted at, and two buttons: **Revert** and **Delete for good**.
- **Revert**: a confirmation ("Lot 101 will come back to Grey Inward"), then `restore`; on success remove the row and show a link to the lot.
- **Delete for good**: a red dialog: "This cannot be undone. Lot 101 will be removed; a copy stays in the archive. Type the lot number to confirm." The button is enabled only when the typed number equals the lot number; send it as `lotNo`.
- Disable the buttons while the request runs. If the answer is `NOT_DELETED`, reload the list (another person already did it).
- In Grey Inward: when the lot number the user types is refused with `LOT_NO_TAKEN`, add a hint: "This number may be in Deleted items: revert it, or delete it for good to use the number again."

## 7. Quick checks
1. Delete lot 101 with a reason: gone from Grey Inward, in Deleted items with the reason.
2. A new entry with lot number 101: refused (`LOT_NO_TAKEN`).
3. Revert: lot 101 is back with its thaans; Deleted items is empty.
4. Delete again, then Delete for good with a wrong number: refused; with 101: gone; the "Permanently deleted" tab shows it.
5. A new entry with lot number 101 now works.
6. A normal user does not see the page and gets 403; another company never sees these lots.
