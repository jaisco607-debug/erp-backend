# AUDIT LOG SCREEN (N-A4)

Owner plan N-A4. The client admin can read the log of **his own company**: who did what, when, and what a record was before and after. **Read only**: nothing can be edited or deleted from the app.

## 1. Who sees what
- **Client admin**: the log of his own company only. Other users (`USER`): **403** on every route below. The menu item "Audit log" is for the client admin only.
- A **super admin who opened a company** sees that company's log (he acts as its client admin). A super admin outside a company still has the old all-companies list (no change for the super admin screen).
- The entries of a company never show another company's data.

## 2. The list: `GET /api/v1/audit-logs`
Query:
| Param | Meaning |
|---|---|
| `from`, `to` | **Required** (YYYY-MM-DD, Pakistan days, both included). At most **92 days** between them. Default in the screen: the last 7 days. |
| `userId` | the person who did it (`options.users[].id`) |
| `entityType` | the kind of record, e.g. `PaymentVoucher`, `GreyLot`, `PayrollEmployee` (`options.entityTypes`) |
| `action` | e.g. `VOUCHER_UPDATED`, `GREY_LOT_DELETED` (`options.actions`) |
| `entityId` | the id of one record: its **history** (see section 5) |
| `search` | free text in action, record type, record id and the user's e-mail |
| `page`, `limit` | `limit` at most **200** (default 50) |

Answer (newest first):
```json
{
  "data": [
    { "id": "1523", "at": "2026-11-25T10:20:00.000Z", "user": { "id": "…", "type": "CLIENT_ADMIN", "email": "boss@mill.com" },
      "action": "VOUCHER_UPDATED", "entityType": "PaymentVoucher", "entityId": "d4f…", "ip": "172.16.0.5", "hasChanges": true }
  ],
  "page": 1, "limit": 50, "total": 128, "maxDays": 92,
  "ipNote": "The IP is the address the server sees. Behind the proxy it can be the proxy address, not the person."
}
```
- `at` is a UTC time: show it in Pakistan time. The list does **not** carry before / after (open one entry for that).
- `user.email` can read `ali@mill.com (via super admin boss@x.com)` when a super admin opened the company: show it as it is.
- **The IP column** shows the address the server sees. Until the Cloudflare lock is done it can be the proxy's address: show a small note under the column (`ipNote`).
- Errors (422, show the `message`): **`DATE_RANGE_REQUIRED`** (no from / to), **`RANGE_TOO_LONG`** (more than 92 days, `details.maxDays`), **`RANGE_INVALID`** (`to` before `from`). `limit` above 200: 400.

## 3. One entry: `GET /api/v1/audit-logs/:id`
```json
{
  "id": "1523", "at": "…", "user": { "id": "…", "type": "CLIENT_ADMIN", "email": "boss@mill.com" }, "action": "VOUCHER_UPDATED",
  "entityType": "PaymentVoucher", "entityId": "d4f…",
  "before": { "amount": 100, "notes": "a" }, "after": { "amount": 150, "notes": "a" },
  "changedFields": ["amount"], "ip": "172.16.0.5", "userAgent": "Mozilla/5.0 …", "requestId": "…"
}
```
- `before` / `after` can be `null` (a create has no `before`, a delete has no `after`).
- **`changedFields`**: the top-level fields whose value differs. Mark them in the two-column view.
- **Secrets are removed** by the server: passwords, tokens and hashes never appear. A **CNIC is shown with its last 4 digits only** (`*********5671`).
- `:id` is a number (string). A wrong id or an id of another company: **404**.

## 4. The filters: `GET /api/v1/audit-logs/options`
```json
{ "users": [ { "id": "…", "name": "Ali", "email": "ali@mill.com", "userType": "USER" } ],
  "entityTypes": ["GreyLot", "PaymentVoucher"], "actions": ["GREY_LOT_DELETED", "VOUCHER_UPDATED"], "maxDays": 92 }
```
`entityTypes` and `actions` are what the log of the **last 180 days** holds. Load it once when the page opens.

## 5. "History" link on a record
On a lot, voucher, invoice and employee screen add a **History** link that opens the Audit log page filtered on that record: `GET /audit-logs?entityId={id}` (+ `entityType` if you like). **A range is not needed when `entityId` is given** (the whole history of the record, newest first, paged). The `entityId` is the record's id as the server stores it.

## 6. The screen (suggested)
- Menu item **Audit log** (client admin only).
- Filters: date range (default last 7 days, the pickers refuse more than 92 days), user, record type, action, search box.
- Table: time, user, action, record (type + id), IP, and a small "changes" mark when `hasChanges`.
- Click a row: a **side panel** with the entry. Two columns **Before | After**, one row per field; rows in `changedFields` are highlighted; a missing side shows "-". Show the user, time, IP and browser (`userAgent`) at the top.
- Four states everywhere: loading, empty ("No entries for these days"), error with a retry button and the server message, data.
- Never offer edit or delete.

## 7. Quick checks
1. As client admin open the page: the last 7 days load, newest first.
2. Choose 100 days: refused with the message (92 at most).
3. Change a voucher, then open its entry: before and after show, the changed field is marked.
4. Open the entry of an employee change: the CNIC shows only the last 4 digits; no password or token anywhere.
5. A normal user: no menu item, and the routes answer 403.
6. The History link on a record shows only that record's entries.
