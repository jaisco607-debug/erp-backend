# Edit locks: what the backend does and what the frontend must send

Written for: the frontend developer. The API in your request is built and tested (`tests/locks.test.js`). Read section 2 first: it has the one thing the backend needs from you that was not in the request (the `X-Tab-Id` header).

## 1. Endpoints (any signed-in person, always inside their own company)

| Call | Answer |
|---|---|
| `POST /v1/locks` `{ resourceType, resourceId, tabId }` | **200** `{ lockId, resourceType, resourceId, acquiredAt, expiresAt, holder: { id, name } }` when the record was free, the old lock had run out, or it is already yours in the same tab (the same `lockId` comes back, `expiresAt` is renewed). |
| same call, record held by someone else, or by you in another tab | **423** `{ error: { code: "LOCKED", message: "<name> is editing this", details: { holder: { id, name }, since, expiresAt } } }` |
| same call, unknown `resourceType` or missing field | **400** `VALIDATION_FAILED` |
| same call, record does not exist in your company | **404** `NOT_FOUND` |
| same call, you are not allowed to edit it (VIEW only, other department, employee asking for `user` / `company_services`, client admin asking for `company_services`) | **403** `FORBIDDEN` |
| `PUT /v1/locks/:lockId/heartbeat` | **200** `{ expiresAt }` (now + 90 s). If the lock is gone, ran out, or is someone else's: **404** `{ error: { code: "LOCK_LOST" } }`. Call it every 30 s. |
| `DELETE /v1/locks/:lockId` | **204**, empty body, normal `Authorization` header (works with `fetch(..., { keepalive: true })`). Only the holder can delete (others **403**). A lock that is already gone is still **204**. |
| `GET /v1/locks?resourceType=&resourceId=` | the current holder `{ lockId, holder, acquiredAt, expiresAt }` or `null` (for "being edited" badges). |

A lock lives **90 seconds**. A closed browser frees the record by itself within 90 s.
When the user logs out of everywhere, is switched off, or is deleted, all their locks end at once.

## 2. IMPORTANT: send `X-Tab-Id` on every write

Every write (POST / PUT / PATCH / DELETE) that edits a record must carry the same tab id you used when taking the lock:

```
X-Tab-Id: <the tabId you sent to POST /v1/locks>
```

Why: two tabs of one person count as two editors. Without this header the backend cannot tell which tab is writing, so it lets the lock holder's request through from any tab. With the header, a write from another tab of the same person gets 423 like anybody else.
Put it in your shared fetch / axios wrapper for all calls (it is harmless on reads).

## 3. What the backend checks on every write

If a **live** lock on the record is held by someone else (or by you in another tab, when `X-Tab-Id` is sent), the write answers **423 `LOCKED`** with `details.holder`, and **nothing is written**. If nobody holds a lock, the write goes through (quick one-click actions need no lock, but they respect somebody else's lock). A write that touches several records (for example sending rows of several jobs) checks all of them.

| `resourceType` | `resourceId` | Writes that are checked |
|---|---|---|
| `job` | jobId | `PATCH /jobs/:id`, `PUT /jobs/:id/status`, `PUT /jobs/:id/operator`, `PUT /departments/:code/jobs/:id/(status\|colour\|operator)`, `POST /departments/:code/jobs/:id/(receive\|accept\|reject\|reject-answer)`, and `POST /departments/:code/send` (the jobs the sent rows come from) |
| `so_card` | soCardId | `PATCH` / `DELETE /so-cards/:id`, `PUT .../confirm`, `POST .../send`, `POST .../accept`, `POST /so-cards/send-many` (every card), and `POST /jobs` from the SO card desk (the cards of the sent rows) |
| `folding_row` | `"<jobId>:<soCardId>"` | `PUT /departments/:code/folding/:jobId/:soCardId`, `.../grades`, `.../close`, `.../confirm`, `POST .../send-packing` |
| `grey_lot` | greyLotId | `PATCH` / `DELETE /grey-lots/:id`, `PUT .../active`, `POST .../approve`, `.../unapprove`, `.../give-back`, `DELETE .../give-back/:returnId`, and `POST /grey-lots/fabric-return` (every lot in `lots`) |
| `packing_list` | listId, or `"so:<soCardId>"` while a new list is being made | create (checks `so:<soCardId>`), `PUT` / `DELETE /departments/:code/packing-lists/:id`, `.../final`, `.../reopen`, `PUT .../gate-pass` |
| `chemical_request` | requestId | store: `POST /stores/:store/requests/:id/(accept\|reject\|send)`, `.../lines/:lineId/(alternate\|eta)`; department: `PATCH /departments/:code/chemical-requests/:id`, `.../cancel`, `.../receive`, `.../lines/:lineId/alternate` |
| `company_services` | companyId | super admin: `PUT /companies/:id/services`, `PUT /companies/:id/services/:serviceId` |
| `user` | userId | client admin: `PATCH /users/:id`, `PUT /users/:id/services`, `POST /users/:id/reset-password` |

## 4. Who may take a lock (so you know when to expect 403)

- Client admin: any record of the company, except `company_services`.
- Employee: only with **FULL** access to a service that edits the record (the job's department, SO Card / Grey Store for SO cards, Grey Store for lots, Packing for packing lists, the department or Chemical Store for chemical requests). Not `user` or `company_services`.
- Super admin: only `company_services`.

## 5. What to do in the UI

1. Opening an edit window: `POST /v1/locks`. On **200** keep `lockId` and start a 30 s heartbeat. On **423** show "`details.holder.name` is editing" and open the record read-only.
2. Heartbeat answers **404 `LOCK_LOST`**: stop editing, tell the user the lock ended (they can try to take it again; unsaved changes are theirs to copy).
3. Close / save / cancel / tab close: `DELETE /v1/locks/:lockId` (`keepalive: true` on tab close).
4. A write answers **423**: show the same "X is editing" message from `details.holder.name`.
5. If `POST /v1/locks` answers 404 / 405 / 501 the page may treat locks as off (as your request says); the endpoints now exist, so this should not happen.

## 6. Not done yet: version check (`expectedVersion`)

The optional "recommended extra" (a `version` on each record, `expectedVersion` on writes, **409 `STALE_VERSION`**) is **not built**. The lock covers the main case. If you want it, tell the backend team which records come first; no frontend change is needed until then.
