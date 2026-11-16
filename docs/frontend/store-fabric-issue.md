# Store Management — Fabric Issue to an SO card (store cloth on an SO card) — Frontend Guide

Continues `store-fabric-inward.md`. The cloth bought from a vendor (Fabric Inward) can now be **issued to a customer's SO card**, **linked** to the earlier SO card whose cloth was spoilt — or **not linked** (linking is optional). The Fabric Store stock, ledger and reports show where every meter went.

## How it works (one picture)
1. **Issue**: pick a fabric inward, tick its thaans (or give meters), choose the **customer** *or* the **SO card it replaces** (the customer then comes from that card), optional date/remarks → `POST /api/v1/fabric-inwards/issues`.
2. The answer has **`greyLotId`**: the issue made a normal, approved **lot of that customer** (marked `source: "STORE"`). Make the SO card the **normal way** (`POST /api/v1/so-cards` with `lots: [{ "greyLotId": "<that id>", "thaanNos": [...] }]`). Everything after that (send to departments, jobs, folding, packing, reports) is unchanged.
3. The SO card, the lot lists and the store screens all show that this cloth is **from the store**, which vendor / inward / issue it came from and which card it replaces.

Suggested screens:
- **SO card form → source switch "Customer cloth | Store cloth"**. Customer cloth = today's flow (`GET /so-cards/available-lots`). Store cloth = pick a store fabric (section 2), optional "Replaces SO card" dropdown (section 3), press **Issue**, then the form continues with the returned lot already ticked. Both sources can be mixed on one card (same customer).
- **Fabric Store → "Issue to SO card"** screen with the same picker, and the issue list / ledger (sections 5–6).

## 1. Access
- **Issue**, the stock picker and the link-card dropdown (`POST /issues`, `GET /stock`, `GET /link-cards`): needs **`FABRIC_STORE` or `SO_CARD`** (issue needs FULL on one of them). So the SO card desk works with its own service.
- Issue **list / one issue / cancel / ledger** (`GET /issues`, `GET /issues/:id`, `POST /issues/:id/cancel`, `GET /ledger`): `FABRIC_STORE` (VIEW to read, FULL to cancel).

## 2. Pick the store cloth — `GET /api/v1/fabric-inwards/stock?withThaans=true`
Same call as the stock screen (see `store-fabric-inward.md`). With **`withThaans=true`** every row also has `thaans` = only the **free** thaans (`thaanNo`, `meters`, `yards`, `width`). Filters: `search`, `vendorId`, `qualityId`, `dateFrom`, `dateTo`, paging. Only approved, switched-on entries with balance are listed. An entry **without a thaan list** has an empty `thaans` and is issued by **meters**.

## 3. "Replaces SO card" dropdown — `GET /api/v1/fabric-inwards/link-cards?customerId=&search=&limit=50`
```json
{ "data": [ { "id": "...", "cardNo": 12, "cardLabel": "12", "cardDate": "2026-10-16", "status": "SENT", "totalMeters": 100, "customer": { "id": "...", "code": 1, "name": "AZ" } } ] }
```
Newest first; `search` = SO number; fabric-return cards are not listed. Optional: when the user picked a customer first, send `customerId` to show only that customer's cards.

## 4. Issue — `POST /api/v1/fabric-inwards/issues`
```json
{ "fabricInwardId": "<entry>", "thaanNos": [1, 2], "linkedSoCardId": "<spoilt card, optional>", "customerId": "<customer>", "issueDate": "2026-11-05", "remarks": "spoilt in dyeing" }
```
- **Cloth**: exactly one of `thaanNos` (whole thaans of an entry that has a thaan list) or `meters` (+ optional `pieces`, for an entry without a thaan list).
- **Party**: at least one of `customerId` / `linkedSoCardId`. With a link the customer is the card's customer (sending a different `customerId` → 422 `LINK_OTHER_CUSTOMER`). Without a link `customerId` is the customer the new card is for.
- `issueDate` defaults to today; it cannot be before the entry's inward date (422 `ISSUE_BEFORE_INWARD`). **The new lot is dated the issue date, so the SO card date must not be earlier than it** (the normal 422 `CARD_BEFORE_LOT`).
- Answer `201`:
```json
{ "id": "...", "issueNo": 1, "issueText": "00001", "issueDate": "2026-11-05", "status": "ISSUED", "greyLotId": "<use this on the SO card>",
  "fabricInward": { "id": "...", "inwardNo": 1, "inwardText": "00001", "dcNo": "V-1", "vendor": { "id": "...", "code": 1, "name": "Cloth Mills" }, "quality": { "id": "...", "name": "PC TWILL" } },
  "customer": { "id": "...", "code": 1, "name": "AZ" },
  "isLinked": true, "linkedSoCard": { "id": "...", "cardNo": 12, "cardLabel": "12", "cardDate": "2026-10-16" },
  "lot": { "id": "...", "lotNo": 3, "typeNo": "0003" }, "meters": 60, "yards": null, "unit": "METER", "pieces": 2, "remarks": "spoilt in dyeing",
  "usedMeters": 0, "soCards": [], "canCancel": true, "createdAt": "...", "cancelledAt": null }
```
- Errors (422): `INWARD_NOT_APPROVED`, `INWARD_INACTIVE`, `UNKNOWN_SO_CARD`, `UNKNOWN_CUSTOMER`, `CUSTOMER_INACTIVE`, `PICK_THAANS` (the entry has thaans: send `thaanNos`), `UNKNOWN_THAAN`, `THAAN_TAKEN` (already issued), `QTY_REQUIRED`, `NOT_ENOUGH_METERS` (`details.balanceMeters`), `ISSUE_BEFORE_INWARD`, `LINK_OTHER_CUSTOMER`. 400 if neither customer nor link, or neither thaans nor meters.
- The issue takes **whole thaans**. The SO card can later take all or part of the issued lot as usual; what the card does not take stays in the lot.

## 5. SO card side (what changed in existing answers)
**SO card** (`GET /so-cards`, `/so-cards/:id`, create / update answers) has new fields:
- `clothSource`: `"CUSTOMER"` | `"STORE"` | `"MIXED"` and `clothSourceText` (`Customer cloth` / `Store cloth` / `Customer + store cloth`) — show a tag on the card.
- `replacesSoCards`: `[ { id, cardNo, cardLabel } ]` — the earlier cards this card's store cloth replaces (empty when not linked) — show "Replaces SO 12" and link to it.
- every line in `lots[]`: `source` (`CUSTOMER`/`STORE`), `fromStore` (bool) and `storeIssue` (null for customer cloth) = `{ issueId, issueNo, inwardId, inwardNo, inwardText, vendorName, linkedSoCard: { id, cardNo, cardLabel } | null }`.

**Lots** (`GET /so-cards/available-lots`, `GET /grey-lots`, `GET /grey-lots/:id`): new `source`, `fromStore`, `fabricIssueId`. Filter with **`?source=CUSTOMER|STORE`** on both. The SO-card lot picker shows store lots with a "Store" tag (they belong to the customer, so they appear when that customer is picked). The **fabric return grey** picker never lists store lots.

**Grey inward screen**: a store lot cannot be edited, deleted, un-approved or given back there (422 **`STORE_LOT`**): hide those buttons when `fromStore` is true; the way to undo it is to cancel the fabric issue (section 6).

## 6. Issue list, one issue, cancel
- `GET /api/v1/fabric-inwards/issues?page=&limit=&search=&customerId=&fabricInwardId=&vendorId=&qualityId=&linkedSoCardId=&linked=true|false&status=ISSUED|CANCELLED&dateFrom=&dateTo=&groupBy=customer|vendor|quality|linkedCard` — newest first: `{ data: [issue...], totals: { issues, meters, yards, pieces, linkedIssues, unlinkedIssues }, groups?, page, limit, total }`. `totals` and `groups` do not count cancelled issues. `search` looks at customer, vendor, quality, DC no and (a number) issue no / lot no / linked SO no / inward no. `groups` (with `groupBy`) = `[ { key, label, issues, meters, pieces } ]` — the **report "store cloth used per customer / vendor / quality / linked card"**.
  Each issue row has `soCards` = the SO cards that took this cloth (`[ { id, cardNo, cardLabel, meters } ]`) and `usedMeters`.
- `GET /api/v1/fabric-inwards/issues/:id` — one issue (same shape).
- `POST /api/v1/fabric-inwards/issues/:id/cancel` — undo the issue: the thaans go back to the stock and the lot is removed. Only while `canCancel` is true, i.e. the cloth is on **no SO card** (else 422 `ISSUE_IN_USE`, `details.soCards` says which; cancel that SO card first). A cancelled issue stays in the list with `status: "CANCELLED"`; cancelling twice → 422 `ISSUE_CANCELLED`.
- `GET /api/v1/fabric-inwards/:id` (one fabric inward) now has **`issues`**: everything issued out of that entry (customer, SO cards, linked card).
- An approved entry that has issued cloth cannot be un-approved (422 `INWARD_IN_USE`).

## 7. Ledger — `GET /api/v1/fabric-inwards/ledger`
Query: `fabricInwardId`, `vendorId`, `qualityId`, `customerId` (then only the issues to that customer), `dateFrom`, `dateTo`, `page`, `limit` (default 200).
```json
{ "opening": 0, "closing": 70, "totals": { "inMeters": 140, "outMeters": 70 }, "page": 1, "limit": 200, "total": 4,
  "data": [ { "date": "2026-11-01", "kind": "INWARD", "kindText": "Fabric inward", "refText": "00001", "inwardId": "...", "inwardText": "00001", "party": "Cloth Mills", "quality": "PC TWILL",
              "note": "V-1", "lotNo": null, "linkedSoCard": null, "inMeters": 100, "outMeters": 0, "balanceMeters": 100 },
            { "date": "2026-11-03", "kind": "ISSUE", "kindText": "Issued to SO card", "refText": "00001", "party": "AZ", "lotNo": 3, "linkedSoCard": "12", "inMeters": 0, "outMeters": 30, "balanceMeters": 70 } ] }
```
`kind`: `INWARD` (+, approved entries, party = vendor), `ISSUE` (−, party = customer, `linkedSoCard` = the card it replaces), `ISSUE_UNDO` (+, an issue that was cancelled). Rows before `dateFrom` are summed into `opening`; `balanceMeters` is the running balance. Everything is in meters.

## Database
Migration `20261216000001-fabric-issue.js` (`fabric_issues`, `grey_lots.source` / `fabricIssueId`, `fabric_inward_thaans.issueId`). Run `npm run db:migrate`.

---

# UPDATE (2026-11-23): returning store cloth when the SO card is cancelled, and "replaced by" on the old card

## A. Cancelling an SO card that holds store cloth — the cloth goes BACK TO THE STORE
`DELETE /api/v1/so-cards/:id?storeAction=RETURN|CANCEL|KEEP` (204 as before; the query is optional):
| `storeAction` | What happens to the store cloth of the card |
|---|---|
| `RETURN` (**default**) | The cloth goes **back to the Fabric Store** stock. The issue stays in the issue list with **`status: "RETURNED"`**, `statusText: "Returned to store"` (not "Cancelled"). |
| `CANCEL` | The issue is **cancelled** (`status: "CANCELLED"`); the cloth is back in the stock too. For an issue that was a mistake. |
| `KEEP` | Nothing happens to the cloth: the issued lot stays with the customer, free to be put on another SO card; the issue stays `ISSUED`. |

Show the user this choice in the reject / cancel dialog **only when the card has store cloth** (`card.clothSource` is `STORE` or `MIXED`, or any line has `fromStore`); a card with only customer cloth needs no choice (the parameter is ignored). Default = **Return to store**. On a `MIXED` card only the store lots are affected; the customer's own lot returns to the grey lot balance as before. A store lot that another SO card still uses stays as it is.

Issue statuses are now **`ISSUED` | `RETURNED` | `CANCELLED`** (`statusText`: Issued / Returned to store / Cancelled). `GET /fabric-inwards/issues?status=` accepts all three; the issue list tabs can be All / Issued / Returned / Cancelled. Returned and cancelled issues are not counted in the totals / groups, and both put the thaans back in the stock (`canCancel` is false for them).

**Ledger** (`GET /fabric-inwards/ledger`): a new `kind` **`ISSUE_RETURN`** (+, `kindText` "Returned to store") for a returned issue; `ISSUE_UNDO` ("Issue cancelled") stays for a cancelled one.

## B. The OLD SO card says it was replaced
Every SO card (`GET /so-cards`, `GET /so-cards/:id`, create / update answers) now also has, next to `replacesSoCards`:
- **On the NEW card**: `replacesText` = `"Made to replace SO 34"` (null when not linked) — plus the existing `replacesSoCards: [{ id, cardNo, cardLabel }]` to link to the old card.
- **On the OLD (linked) card**:
  - `isReplaced` (bool), `replacedText` = `"Replaced by SO 35"` (or `"Replacement cloth issued from the store (no SO card made yet)"` while the issue has no SO card), and
  - `replacedBy: [ { issueId, issueNo, issueText, meters, soCards: [ { id, cardNo, cardLabel, meters } ] } ]` — one entry per store issue linked to this card, with the new card(s) that took the cloth.

Show a badge / banner on the old card ("Replaced by SO 35", clickable to the new card, e.g. in the SO Card Summary row and the card view) and "Made to replace SO 34" on the new card. When the new card is cancelled with `RETURN` / `CANCEL`, or its issue is cancelled, the old card stops being `isReplaced`; with `KEEP` it says "Replacement cloth issued ... (no SO card made yet)" until another card takes the lot.

## Database
Migration `20261217000001-fabric-issue-end-kind.js` (`fabric_issues.endKind`). Run `npm run db:migrate`.

---

# UPDATE 2 (2026-11-24): cancel = delete, edit and issue again — this section REPLACES the "CANCELLED" status of the earlier sections

## Statuses
Only **`ISSUED`** and **`RETURNED`** now (`statusText`: "Issued" / "Returned to store"). There is no `CANCELLED` status any more (`?status=CANCELLED` → 400). Old CANCELLED rows were deleted by the migration. Ledger `kind` values: `INWARD`, `ISSUE`, `ISSUE_RETURN` (`ISSUE_UNDO` is gone).

## 1. Cancel = delete — `POST /api/v1/fabric-inwards/issues/:id/cancel` (same URL)
- Allowed for an **ISSUED** issue whose cloth is on **no SO card**, and for a **RETURNED** issue ("delete a returned issue"). Needs FULL on `FABRIC_STORE`.
- The issue row is **removed for good**: its thaans are back in the stock (for a RETURNED issue they already were), the lot it made is removed, and it disappears from `GET /issues`, the totals / groups, the entry's `issues` list and the **ledger** (no ISSUE and no ISSUE_RETURN row: the balance is as if it had never been made).
- Answer `200`: `{ "id": "...", "issueNo": 2, "deleted": true }`. Calling it again → 404.
- ISSUED issue whose cloth is on an SO card → 422 `ISSUE_IN_USE` (`details.soCards`: cancel / return the card first).
- `canCancel` is true for a RETURNED issue and for an ISSUED one on no SO card — show the Delete button on that.
- Issue numbers are **not reused** after a delete.
- `DELETE /so-cards/:id?storeAction=CANCEL` now means the same: the issue is **deleted** and the cloth is back in the stock. `RETURN` (default) keeps the issue as `RETURNED`; `KEEP` as before.

## 2. Edit an issue and issue it again — `PATCH /api/v1/fabric-inwards/issues/:id`
Needs FULL on `FABRIC_STORE` or `SO_CARD`. Allowed when `canEdit` is true: a **RETURNED** issue (edit and issue again), or an **ISSUED** issue on no SO card. Otherwise 422 `ISSUE_IN_USE`.
```json
{ "thaanNos": [1, 2], "meters": 60, "pieces": 2, "customerId": "...", "linkedSoCardId": "..." , "issueDate": "2026-11-05", "remarks": "..." }
```
- All fields optional, at least one. `thaanNos` **or** `meters` (not both). **A field that is not sent keeps its old value** — including the cloth: send nothing for the cloth and the issue takes the same thaans / meters as before.
- `linkedSoCardId: null` **removes the link**; a new id links another card. With a link the customer is that card's customer (a different `customerId` → 422 `LINK_OTHER_CUSTOMER`); without a link, `customerId` (or the old customer when not sent).
- `fabricInwardId` cannot change (422 `INWARD_NOT_CHANGEABLE` if sent different): delete the issue and make a new one.
- The thaans the issue itself holds count as free while editing. Other rules as in `POST /issues`: `THAAN_TAKEN`, `PICK_THAANS`, `UNKNOWN_THAAN`, `NOT_ENOUGH_METERS` (`details.balanceMeters`), `ISSUE_BEFORE_INWARD`, `INWARD_NOT_APPROVED`, `INWARD_INACTIVE`, `CUSTOMER_*`, `UNKNOWN_SO_CARD`. A refused edit changes nothing.
- Result: the issue keeps its **number** and `id`, gets a **new lot** (use the **`greyLotId` of the answer**, it changes), and is **`ISSUED`** again (`cancelledAt` null). Answer `200` = the same JSON as `POST /issues` (`greyLotId`, `lot`, `status` ...).
- Another company's issue → 404.

## 3. `GET /api/v1/fabric-inwards/issues/:id` — fields for the edit form
In addition to the existing fields: 
- `canEdit`, `canCancel` (also on every row of `GET /issues`),
- `thaanNos`: the thaan numbers the issue holds (for a RETURNED issue: the ones it held when it was returned),
- `editThaans`: `[ { thaanNo, meters, yards, width, selected } ]` = the entry's **free** thaans + the ones this issue holds; `selected` = held by this issue (tick it). Empty for an entry without a thaan list, and `[]` when `canEdit` is false,
- `editBalanceMeters`: for an entry **without** a thaan list, the meters the issue may take (entry balance + what an ISSUED issue holds); `null` for thaan-wise entries or when not editable,
- `fabricInward` now has `inwardDate` (`{ id, inwardNo, inwardText, inwardDate, dcNo, vendor, quality }`).

## Database
Migration `20261218000001-fabric-issue-delete-edit.js` (`fabric_issues.thaanNos`, old CANCELLED rows deleted, `endKind` can only be RETURNED). Run `npm run db:migrate`.
