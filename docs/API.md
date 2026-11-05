# Textile ERP API (for the frontend)

Base URL: `http://localhost:3000/api` (on the server it will be the server's address + `/api`).
Ready-made Postman collection: `postman/textile-erp.postman_collection.json` (Import it in Postman).

## Rules for every request
- Body is JSON: header `Content-Type: application/json`.
- Protected routes need header `Authorization: Bearer <accessToken>`.
- Unknown fields in a body or query are refused (400).
- Every response has header `X-Request-Id`. Show it on error screens: it finds the request in the server logs.

### Error format (all errors look the same)
```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Validation failed",
  "details": [ { "field": "body.email", "message": "email must be a valid email" } ] } }
```
| HTTP | code | Meaning for the frontend |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Show `details[].message` next to the field (`field` = `body.<name>`) |
| 401 | `UNAUTHORIZED` | Token missing/expired: call refresh once, if that fails go to login |
| 403 | `FORBIDDEN` | Logged in but not allowed: hide the screen/button |
| 404 | `NOT_FOUND` | Record does not exist |
| 409 | `DUPLICATE` | e.g. email already used |
| 422 | rule code, e.g. `WRONG_PASSWORD`, `CANNOT_DEACTIVATE_SELF` | Show `message` |
| 429 | `TOO_MANY_REQUESTS` | Too many login tries from this computer, wait 15 min |
| 500 | `INTERNAL_ERROR` | Show "something went wrong" + `requestId` |

## Login flow
1. `POST /v1/auth/login` -> keep `accessToken` (15 min) and `refreshToken` (7 days).
2. Send `accessToken` with every request.
3. On a 401, call `POST /v1/auth/refresh` with the refresh token **once**, save the new pair (the old refresh token no longer works), retry the request.
4. If refresh also gives 401, clear tokens and show the login screen.
5. `user.userType` decides the home screen: `SUPER_ADMIN`, `CLIENT_ADMIN` or `USER`.
6. `services` decides the menu: show only these. `access` is `FULL` (add/edit) or `VIEW` (see and reports only).

### Login screen fields
- **Company code** (required for everyone): super admins type the super admins' code (one code shared by all of them); client admins and company users type their company's code. Both look like `K7QM-4XPA` (made at random by the server; small letters or no dash also work).
- **Email**, **Password**.
The same email can exist in two different companies; the company code tells them apart.

---

## Health
`GET /health` -> `200 {"status":"ok"}` or `503 {"status":"database_unavailable"}`

## Auth (everyone uses the same endpoints)

### `POST /v1/auth/login`
Super admin:
```json
{ "companyCode": "R4TW-9KXE", "email": "admin@example.com", "password": "..." }
```
Client admin / company user:
```json
{ "companyCode": "K7QM-4XPA", "email": "waqas@example.com", "password": "..." }
```
200:
```json
{ "accessToken": "eyJ...", "refreshToken": "qSJ_...", "tokenType": "Bearer",
  "user": { "id": "0ebc...", "name": "Waqas Owais", "email": "waqas@example.com", "userType": "CLIENT_ADMIN",
            "companyId": "5a1d...", "isActive": true, "lastLoginAt": "...", "createdAt": "..." },
  "company": { "id": "5a1d...", "name": "Waqas Textile", "code": "K7QM-4XPA" },
  "services": [
    { "code": "DYEING",  "name": "Dyeing",  "kind": "PROCESS", "access": "FULL" },
    { "code": "FOLDING", "name": "Folding", "kind": "FOLDING", "access": "FULL" } ] }
```
For a super admin `company` is `null` and `services` is `[]` (they manage the platform).
401 `Company code, email or password is incorrect` for a wrong code/email/password, locked account (5 wrong tries = 15 min lock), switched-off account or switched-off company. The same message on purpose.

### `POST /v1/auth/refresh`
`{ "refreshToken": "..." }` -> 200 `{ accessToken, refreshToken, tokenType }`

### `POST /v1/auth/logout`
`{ "refreshToken": "..." }` -> 204. Ends this device's session.

### `POST /v1/auth/logout-all` (token needed)
-> 204. Ends every session of this user on all devices.

### `GET /v1/auth/me` (token needed)
-> 200 `{ user, company, services }`, same as login without the tokens. Call it when the app opens to rebuild the menu (services can change any time).

### `POST /v1/auth/change-password` (token needed)
```json
{ "currentPassword": "...", "newPassword": "New-Password-123" }
```
-> 204, then all sessions end: send the user to login.
New password: 10+ characters with a capital letter, a small letter and a digit.
422 `WRONG_PASSWORD` / `SAME_PASSWORD`.

## Super admins (only `SUPER_ADMIN`)

### `GET /v1/super-admins?page=1&limit=25&search=ali&isActive=true`
-> 200 `{ "data": [ user, ... ], "page": 1, "limit": 25, "total": 3 }` (limit max 100)

### `POST /v1/super-admins`
```json
{ "name": "Ali Khan", "email": "ali@example.com", "password": "Ali-Pass-12345" }
```
-> 201 user. 409 if the email is already used.

### `GET /v1/super-admins/login-code`
-> 200 `{ "code": "R4TW-9KXE" }`: the code all super admins type on the login screen.

### `POST /v1/super-admins/login-code/new`
No body -> 200 `{ "code": "..." }`. A new random code; the old one stops working at once (people already logged in stay logged in). Audited as `SUPER_ADMIN_CODE_CHANGED`.

### `PATCH /v1/super-admins/:id`
`{ "name": "Ali Raza" }` and/or `{ "isActive": false }` -> 200 user.
Switching someone off logs them out everywhere at once. 422 `CANNOT_DEACTIVATE_SELF`.

### `POST /v1/super-admins/:id/reset-password`
`{ "newPassword": "Reset-Pass-12345" }` -> 204. Also unlocks the account and logs them out everywhere.

## Companies (only `SUPER_ADMIN`)

### `GET /v1/companies?page=1&limit=25&search=waqas&isActive=true`
-> 200 `{ "data": [ { "id", "name", "code", "contactPerson", "phone", "address", "isActive", "createdAt", "serviceCount": 2 (services given by the super admin; modules not counted), "userCount": 1 } ], "page", "limit", "total" }`

### `POST /v1/companies` (register a company)
```json
{ "name": "Waqas Textile",
  "contactPerson": "Waqas Owais", "phone": "0300-1234567", "address": "Faisalabad",
  "admin": { "name": "Waqas Owais", "email": "waqas@example.com", "password": "Waqas-Pass-123" } }
```
- Do **not** send `code`: the server makes a random, unique code like `K7QM-4XPA` (8 letters/digits, no 0/O/1/I/L), so nobody can guess it from the name. It comes back in the response as `code`.
- `admin` is the company's first client admin; they log in with this code.
- A new company gets every active **MODULE** service at once (Grey Store, SO card, Chemical Store, Packing, Gate Pass). The rest are switched on by the super admin. Give them afterwards: from the company (`PUT /v1/companies/:id/services`) or from a service (`PUT /v1/services/:id/companies`).
-> 201 company details (below, `services: []`).

### `GET /v1/companies/:id`
-> 200
```json
{ "id", "name", "code", "contactPerson", "phone", "address", "isActive", "createdAt",
  "services": [ { "id", "code", "name", "kind" } ],
  "clientAdmins": [ user, ... ], "userCount": 1 }
```

### `PATCH /v1/companies/:id`
Any of `name`, `contactPerson`, `phone`, `address`, `isActive` -> 200 company details.
`isActive: false` switches the company off: all its people are logged out at once and cannot log in until it is switched on again.
The code cannot be changed here.

### `DELETE /v1/companies/:id`
-> 204. The company disappears from lists and all its people are logged out and switched off. Nothing is wiped (soft delete); audited as `COMPANY_DELETED`.

### `PATCH /v1/companies/:id/admins/:userId` (edit a client admin)
Any of `name`, `email`, `isActive` -> 200 user. `userId` = an id from `clientAdmins` in the company details. `isActive: false` logs them out at once. 409 if the email is used in this company.

### `POST /v1/companies/:id/admins/:userId/reset-password`
`{ "newPassword": "Fresh-Pass-123" }` -> 204. Unlocks and logs them out everywhere.

### `POST /v1/companies/:id/new-code`
No body -> 200 company details with a new random `code`. Use it when a code reached the wrong person: the old code stops working at once (people already logged in stay logged in). Audited as `COMPANY_CODE_CHANGED`.

### `PUT /v1/companies/:id/services/:serviceId` (one toggle)
`{ "enabled": true }` gives this one service, `{ "enabled": false }` takes it away -> 200 company details. Users of the company lose a service taken away.

### `PUT /v1/companies/:id/services`
`{ "serviceIds": ["...", "..."] }` (ids from `GET /v1/services`) -> 200 company details. Replaces the whole list (send `[]` to take all away); menus change at the next `/me`. 422 `UNKNOWN_SERVICE`.
Screen idea: company page with a checkbox per service.

## Services (only `SUPER_ADMIN`)

### `GET /v1/services?isActive=true&kind=PROCESS,FOLDING`
`kind` (optional): only these kinds. For the company services screen use `kind=PROCESS,FOLDING` (modules are given automatically and not shown).

-> 200 `{ "data": [ { "id", "code", "name", "kind", "tracksColour", "isActive", "sortOrder" } ] }`
Ready from the start: GREY_STORE, SO_CARD, SINGEING, DYEING, DRYER, FINISHING, STITCHING, CUTTING, PRINTING, STENTER, COMPACTING, FOLDING, CHEMICAL_STORE, PACKING, GATE_PASS.
`kind`: `MODULE` (a screen), `PROCESS` (a department), `FOLDING`.

### `POST /v1/services`
`{ "code": "WASHING", "name": "Washing", "kind": "PROCESS", "tracksColour": true }` -> 201. 422 `SERVICE_CODE_TAKEN`.

### `PATCH /v1/services/:id`
Any of `name`, `tracksColour`, `isActive`, `sortOrder` -> 200. `isActive: false` removes it from every company's menu.

### `DELETE /v1/services/:id`
Deletes a service. Every company (and its users) that had it loses it. Reply: `{ deleted: true, id, removedFromCompanies }`.
422 `CORE_MODULE` for the 5 built-in modules (Grey Store, SO card, Chemical Store, Packing, Gate Pass); modules you added can be deleted. To hide a service but keep it, use `PATCH /v1/services/:id` with `{ "isActive": false }` instead.

### `GET /v1/services/:id/companies`
-> 200 `{ "service": { ... }, "companies": [ { "id", "name", "code", "isActive" } ] }`: the companies that have this service.

### `GET /v1/services/:id/company-options`
Checkbox list for the service screen: every company with `hasService`. Show `hasService: true` ticked and disabled (already given).
```json
{ "service": { "id": "...", "code": "PRINTING", "kind": "PROCESS" },
  "companies": [ { "id": "...", "name": "Alpha Mills", "code": "K7QM-4XPA", "isActive": true, "hasService": true },
                 { "id": "...", "name": "Beta Mills",  "code": "P3RT-8WXZ", "isActive": true, "hasService": false } ] }
```

### `POST /v1/services/:id/companies`
Gives the service to the ticked companies only; no company loses it. Body `{ "companyIds": ["...", "..."] }` (at least 1).
Reply: `{ added: [...ids], alreadyGiven: [...ids], service, companies }`. Companies that already had it are skipped.
Errors: 422 `MODULE_SERVICE` (modules are given automatically), 422 `UNKNOWN_COMPANY`, 422 `SERVICE_INACTIVE`.

### `PUT /v1/services/:id/companies`
`{ "companyIds": ["...", "..."] }` (ids from `GET /v1/companies`) -> 200, same shape as above.
Gives this service to exactly these companies and takes it away from every other company (send `[]` to take it from all).
422 `UNKNOWN_COMPANY`, 422 `SERVICE_INACTIVE` (switch the service on first).
Screen idea: service page with a checkbox per company.

## Company users (only `CLIENT_ADMIN`, own company only)
A client admin adds the users of their company and gives each some of the company's services.
Users log in with the **same company code** + their own email + password. Another company's users answer 404.
`services` in the client admin's login / `/me` answer is the list of company services they can give (with `id`).

### `GET /v1/users?page=1&limit=25&search=ali&isActive=true`
-> 200 `{ "data": [ user ], "page", "limit", "total" }`

### `POST /v1/users`
```json
{ "name": "Ali Operator", "email": "ali@example.com", "password": "Ali-Pass-12345",
  "services": [ { "serviceId": "...", "access": "FULL" }, { "serviceId": "...", "access": "VIEW" } ] }
```
`services` optional (default none). `access`: `FULL` (add/edit) or `VIEW` (see and reports).
-> 201 user:
```json
{ "id", "name", "email", "userType": "USER", "companyId", "isActive", "lastLoginAt", "createdAt",
  "services": [ { "id", "code", "name", "kind", "access" } ] }
```
409 email already used in this company. 422 `SERVICE_NOT_IN_COMPANY` (the company does not have that service).

### `GET /v1/users/:id`
-> 200 user (as above).

### `PATCH /v1/users/:id`
Any of `name`, `isActive` -> 200 user. `isActive: false` logs them out at once and stops their login.

### `POST /v1/users/:id/reset-password`
`{ "newPassword": "Ali-New-Pass-1" }` -> 204. Unlocks the account and logs them out everywhere.

### `PUT /v1/users/:id/services`
`{ "services": [ { "serviceId": "...", "access": "VIEW" } ] }` -> 200 user. Replaces the whole list (`[]` takes all away); their menu changes at the next `/me`.
When the super admin takes a service away from the company, every user of that company loses it too.

## Audit log (only `SUPER_ADMIN`)

### `GET /v1/audit-logs`
Query (all optional): `page`, `limit`, `action`, `actorId`, `companyId`, `entityType`, `entityId`, `from`, `to` (ISO dates).
-> 200, newest first:
```json
{ "data": [ { "id": "5", "at": "2026-10-10T08:56:39.194Z", "actorId": "0ebc...", "actorType": "SUPER_ADMIN",
  "actorEmail": "admin@example.com", "companyId": null, "action": "SUPER_ADMIN_CREATED", "entityType": "User",
  "entityId": "39e7...", "before": null, "after": { "name": "Ali Khan", "...": "..." },
  "ip": "127.0.0.1", "userAgent": "...", "requestId": "5cb1..." } ], "page": 1, "limit": 1, "total": 5 }
```
Actions so far: `LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `LOGOUT_ALL`, `PASSWORD_CHANGED`, `PASSWORD_RESET`, `SESSION_REUSE_DETECTED`, `SUPER_ADMIN_CREATED`, `SUPER_ADMIN_UPDATED`, `COMPANY_CREATED`, `COMPANY_UPDATED`, `COMPANY_SERVICES_CHANGED`, `CLIENT_ADMIN_CREATED`, `SERVICE_CREATED`, `SERVICE_UPDATED`, `SERVICE_COMPANIES_CHANGED`.

## CORS
The backend only answers browsers from addresses listed in `.env` -> `CORS_ORIGINS` (comma separated), e.g. `CORS_ORIGINS=http://localhost:5173,http://localhost:3001`. Tell the backend owner your frontend address.

## Step 3: Grey (fabric) inward

All of these are for company people (client admin, users). The company must have the **Grey Store** service;
a user needs Grey Store **VIEW** to read and **FULL** to add/edit. Super admins get 403.

### Customers (parties who send cloth): `/v1/customers`
- `GET /v1/customers?search=&isActive=&page=&limit=` (search by name or code; limit up to 500 for dropdowns)
- `POST /v1/customers` `{ "code": 130, "name": "AZ Textiles", "phone": "", "address": "" }`. `code` is optional; left out, the next number is used. 422 `NAME_TAKEN`, `CODE_TAKEN`.
- `GET /v1/customers/:id`, `PATCH /v1/customers/:id` `{ name, phone, address, isActive }`
- `DELETE /v1/customers/:id` → 204. Hidden from the list and dropdowns but kept in the database, so old lots still show the party. Its name/code can be used again.

### Qualities: `/v1/qualities`
- `GET /v1/qualities?search=&isActive=`, `POST /v1/qualities` `{ "name": "CANVAS 10X7/72X30=65.50\"" }`, `GET/PATCH /v1/qualities/:id` `{ name, isActive }`, `DELETE /v1/qualities/:id` → 204 (kept in the database like customers)

### Grey lots: `/v1/grey-lots`
Every arrival of cloth is one lot. If a party sends 5000 m in three parts, enter three lots (put the party's own order no in `partyRef` to link them).

`POST /v1/grey-lots`
```json
{ "inwardDate": "2026-10-08", "customerId": "...", "qualityId": "...", "inwardMeters": 11305, "pieces": 62,
  "dcNo": "5010", "partyRef": "AZ-PO-77", "vehicleNo": "LES-1234", "remarks": "",
  "isReprocess": false, "reprocessOfLotId": null }
```
`lotNo` and `typeNo` are given by the server (next in line). For cloth sent back for re-processing set `isReprocess: true`
(optionally `reprocessOfLotId` = the earlier lot).

Reply (also the shape of each list row):
```json
{ "id": "...", "lotNo": 2436, "typeNo": "0612", "dcNo": "5010", "inwardDate": "2026-10-08",
  "customer": { "id": "...", "code": 130, "name": "AZ Textiles" }, "quality": { "id": "...", "name": "CANVAS ..." },
  "inwardMeters": 11305, "pieces": 62, "outwardMeters": 0, "balanceMeters": 11305,
  "partyRef": null, "vehicleNo": null, "remarks": null, "isReprocess": false, "reprocessOf": null,
  "isApproved": false, "approvedAt": null, "isActive": true, "createdAt": "..." }
```

- `GET /v1/grey-lots?search=&customerId=&qualityId=&isActive=&isApproved=&isReprocess=&dateFrom=2026-10-01&dateTo=2026-10-31&page=&limit=`
  (newest lot first; search matches lot no, type no, DC#, party ref, customer, quality)
- `GET /v1/grey-lots/:id`
- `PATCH /v1/grey-lots/:id` any of the create fields. 422 `LOT_APPROVED` once approved.
- `PUT /v1/grey-lots/:id/active` `{ "isActive": false }` the active toggle
- `DELETE /v1/grey-lots/:id` → 204. Hidden but kept in the database; its lot number is never reused. 422 `LOT_APPROVED` (approved lot), `LOT_IN_USE` (cloth already went out).
- `POST /v1/grey-lots/:id/approve` (FULL access; 422 `LOT_INACTIVE` if switched off)
- `POST /v1/grey-lots/:id/unapprove` (client admin only)
- `GET /v1/grey-lots/numbering` → `{ "nextLotNo": 2437, "nextTypeNo": "0613" }`
- `PUT /v1/grey-lots/numbering` `{ "nextLotNo": 2437, "nextTypeNo": 613 }` (client admin; to continue from the old system; 422 `NUMBER_USED` if lower than a used number)

Errors: 422 `UNKNOWN_CUSTOMER`, `UNKNOWN_QUALITY`, `UNKNOWN_LOT`, `CUSTOMER_INACTIVE`, `QUALITY_INACTIVE`, `BELOW_OUTWARD`.
`outwardMeters` stays 0 until the next steps send cloth out.

## Step 4: SO card (travel card): `/v1/so-cards`

Company people with the **SO Card** service (VIEW to read, FULL to make/send/cancel).
Departments are the company's **Process** and **Folding** services (Singeing, Dyeing, Folding ...).

- `GET /v1/so-cards/departments` → `{ data: [{ id, code, name }] }` departments to send to
- `GET /v1/so-cards/available-lots?customerId=&search=<lot no>` → approved, active grey lots with balance left
  (`{ data: [{ id, lotNo, typeNo, dcNo, customer, quality, inwardMeters, outwardMeters, balanceMeters, isReprocess }] }`)
- `POST /v1/so-cards` make a card from one or more lots of **one party**:
```json
{ "cardDate": "2026-10-13", "remarks": "",
  "lots": [ { "greyLotId": "...", "meters": 2000, "pieces": 20 }, { "greyLotId": "...", "meters": 1500, "pieces": 15 } ] }
```
  Each lot's outward goes up (its grey balance goes down). 422 `NOT_ENOUGH_METERS` (details list the lots short),
  `MIXED_CUSTOMERS`, `LOT_NOT_APPROVED`, `LOT_INACTIVE`, `UNKNOWN_LOT`.
  Reply:
```json
{ "id": "...", "cardNo": 1, "cardDate": "2026-10-13", "customer": { "id": "...", "code": 130, "name": "AZ Textiles" },
  "totalMeters": 3500, "totalPieces": 35, "isReprocess": false, "status": "NEW", "currentDepartment": null, "lastMove": null,
  "lots": [ { "greyLotId": "...", "lotNo": 2436, "typeNo": "0612", "dcNo": "5010", "quality": { "id": "...", "name": "..." }, "isReprocess": false, "meters": 2000, "pieces": 20 } ],
  "moves": [], "remarks": null, "createdAt": "..." }
```
- `GET /v1/so-cards?search=&customerId=&departmentId=&status=NEW|SENT|IN_DEPARTMENT&isReprocess=&dateFrom=&dateTo=&page=&limit=`
  (search = card no, a lot no on the card, or party name)
- `GET /v1/so-cards/:id`, `PATCH /v1/so-cards/:id` `{ cardDate, remarks }`
- `DELETE /v1/so-cards/:id` → 204, cancel a card that was **not sent yet**; its meters go back to the lots (422 `CARD_SENT`)
- `POST /v1/so-cards/:id/send` `{ "departmentId": "...", "sentThrough": "Akram (loader)", "remarks": "" }` → status `SENT`
  (422 `UNKNOWN_DEPARTMENT`, `SAME_DEPARTMENT`, `CARD_SENT` if still waiting to be accepted)
- `POST /v1/so-cards/:id/accept` → status `IN_DEPARTMENT`. Client admin, or a user with **FULL** access to the receiving department (403 otherwise)
- `GET /v1/so-cards/incoming?departmentId=...` cards on their way to that department (for its Accept screen)

`moves` is the card's history: `{ from, to, sentThrough, remarks, sentBy, sentAt, acceptedBy, acceptedAt }`; `lastMove` is the latest one.

### Step 4b: SO card single screen (2026-10-13)
- `GET /v1/so-cards/form-data` → `{ nextCardNo, nextIdNo, departments[], customers[{id, code, name, balanceMeters, lots[]}] }`. Everything the one screen needs.
- `POST /v1/so-cards` now also takes `description`, `qualityId` (optional; taken from the lots when they all share one quality), `departmentId` + `sentThrough` (optional: create and send in one click).
- Card response adds `idNo` (ID#), `quality`, `description`, `isConfirmed`, `confirmedAt`.
- `PUT /v1/so-cards/:id/confirm` `{ isConfirmed }`: Conf. toggle. A confirmed card cannot be edited or cancelled (422 `CARD_CONFIRMED`).
- `PUT /v1/so-cards/numbering` `{ nextCardNo?, nextIdNo? }` (client admin): continue SO#/ID# from the old system; 422 `NUMBER_USED` if lower.
- List filter `isConfirmed=true|false`; `search` also matches ID#.
- `PATCH /v1/so-cards/:id` also takes `lots` (same shape as create) while the card is NEW and not confirmed: old meters return to lots, new ones are taken. 422 `CARD_SENT` after sending.
- `PATCH /v1/so-cards/:id` also takes `departmentId` + `sentThrough`: sends the card (works on confirmed cards too). Every card response has `deliveryText` ("Not sent to any department yet" / "Sent to Dyeing (waiting for accept)" / "Delivered to Dyeing").

## Step 5: Departments, Job# (2026-10-13)
- `/v1/colours` CRUD (SO Card service): colour dropdown list.
- `GET /v1/jobs/form-data?fromDepartmentId=` (empty = SO card desk): `{ nextJobNo, departments, colours, rows }` rows to tick.
- `POST /v1/jobs` `{ fromDepartmentId?, departmentId, colourId?, jobDate?, sentThrough?, remarks?, items: [{soCardLotId, meters?}] | [{jobItemId}] }` one job = one Job#.
- `GET /v1/jobs?departmentId=&side=in|out&view=job|so&status=&isReprocess=&colourId=&search=&dateFrom=&dateTo=`.
- `GET /v1/jobs/:id`, `PATCH /v1/jobs/:id` (sender, while PENDING: colourId/sentThrough/remarks), `PUT /v1/jobs/:id/status` `{status: PENDING|PROCESSING|COMPLETE|REJECTED}` (receiving dept FULL).
- `GET /v1/jobs/so-card/:soCardId` the card's whole road.
- `/v1/departments` (list), `/v1/departments/:code/incoming|sent|rejected|send-form` (GET), `POST /v1/departments/:code/send` `{toDepartmentCode, colourId?, sentThrough?, items:[{jobItemId}]}`: same as /v1/jobs, addressed by department code.

## Step 6: Folding (2026-10-14)
- `GET /v1/departments/FOLDING/folding?tab=all|draft&search=&dateFrom=&dateTo=` rows per SO card in each job: jobNo, pageNo, soCard, jobDate, customer, quality, colour, soQnty, stock{a,b,cp,total}, diff, diffPercent, inStock, isConfirmed; plus draftCount.
- `PUT /v1/departments/FOLDING/folding/:jobId/:soCardId` `{pageNo?, a?, b?, cp?}` (draft).
- `PUT /v1/departments/FOLDING/folding/:jobId/:soCardId/confirm` `{isConfirmed}`.
- Jobs sent from a FOLDING department get `isRework: true` (RE-WORK badge); every later job of that cloth keeps it until it is back in Folding.
- Folding rows: `sentForRework`, `sentBackTo` (inStock 0 once sent back). Full guide: `docs/frontend/step6-folding.md`.

## Step 7: Chemical Store and General Items Store (2026-10-14)
Full frontend guide: `docs/frontend/step7-stores.md`. `:store` is `chemical` or `general`.
- Vendors (shared): `GET/POST /v1/vendors`, `GET/PATCH/DELETE /v1/vendors/:id`.
- Per store: `/v1/stores/:store/categories`, `/brands`, `/items` (CRUD), `GET /items/:id/moves`, `GET /stock?groupBy=category|brand`.
- Inwards: `GET /v1/stores/:store/inwards/form-data`, `GET /inwards?tab=all|gst|other|draft&dateFrom&dateTo&ipNo&dcNo&grnNo&vendor&description`,
  `POST /inwards`, `GET/PATCH/DELETE /inwards/:id`, `POST /inwards/:id/approve`, `POST /inwards/:id/unapprove` (client admin).

## Reports (2026-10-20)
Full frontend guide (screens, PDF / Excel download): `docs/frontend/accounting-reports.md`. Every report group is its own service (`REPORT_OVERVIEW`, `REPORT_GREY`, `REPORT_SO_CARDS`, `REPORT_DEPARTMENTS`, `REPORT_CHEMICAL_COST`, `REPORT_FOLDING`, `REPORT_ACTIVE_FABRIC`, `REPORT_PACKING`, `REPORT_GATE_PASSES`); VIEW is enough. `GET /v1/reports` lists only the reports the person may open. All `GET`.
Every list report answers `{ report, title, filters, columns: [{key, label, type, total?}], rows, totals, page, limit, total }`; `totals` are over all filtered rows; `all=true` sends every row (max 20,000) for downloads. Common query: `page`, `limit` (max 500), `all`, `dateFrom`, `dateTo`, `customerId`.
- `GET /v1/reports`: report list + filter dropdowns (departments, customers, qualities, statuses).
- `GET /v1/reports/overview`: headline numbers of every module (`rows` + `summary`).
- `GET /v1/reports/grey/parties` · `/grey/lots?qualityId&stock=all|in-stock|finished&search` · `/grey/returns`.
- `GET /v1/reports/so-cards?departmentId&status&search` · `/so-cards/lots?soCardId&search` · `/so-cards/:id` (full story: `header`, `headerFields`, `tables[]`).
- `GET /v1/reports/departments?departmentId` · `/departments/jobs?departmentId&fromDepartmentId&soCardId&status&operatorName&search` · `/departments/operators?departmentId&operatorName`.
- `GET /v1/reports/chemical-cost?by=so-card|lot|thaan|chemical|item&departmentId&soCardId&itemId` (dates = sent by the store).
- `GET /v1/reports/folding?by=row|party|from-department&fromDepartmentId&tab=all|open|closed&search`.
- `GET /v1/reports/active-fabric?by=party|so-card|department|detail&departmentId` (always "now").
- `GET /v1/reports/packing-lists?soCardId&status&gatePass=all|yes|no&search` · `/packing-lists/lines?grade=A|B|CP` · `/gate-passes?search`.

## Service access (2026-10-20)
Full frontend guide: `docs/frontend/service-access.md`.
- **A new company gets no services.** The super admin gives every one (modules, departments, reports): `PUT /v1/companies/:id/services` `{ serviceIds }`, `PUT /v1/companies/:id/services/:serviceId` `{ enabled }`, `POST|PUT /v1/services/:id/companies` (modules are allowed now; `MODULE_SERVICE` is gone).
- Every service has `kind` (`MODULE`, `PROCESS`, `FOLDING`, `PACKING`, `REPORT`), `menuGroup` (`PRODUCTION`, `PROCESS`, `STORE`, `REPORTS` or null; the client tab) and, on `/v1/services`, `isBuiltIn` (cannot be deleted). `POST /v1/services` and `PATCH /v1/services/:id` take `menuGroup`; `GET /v1/services?kind=REPORT`.
- New services: `STORE_REPORTS` (the store cost reports `/v1/stores/chemical/cost/...` need it, not `CHEMICAL_STORE`) and the nine `REPORT_*`. The single `REPORTS` service is removed (holders got all nine).
- `GET /v1/auth/me` and login: each service now has `menuGroup`. The client menu is built from it: an item shows only with its service, a tab only when one of its items shows.

## Fabric return: Grey Store only (2026-10-20)
Details: `docs/frontend/fabric-return-grey.md` section 5. A fabric return needs only the `GREY_STORE` service (it used to need `SO_CARD` too).
- `GET /v1/grey-lots/fabric-returns?page&limit&search&customerId&dateFrom&dateTo` (VIEW): fabric returns with `stage`, `stageText`, `packingLists[]` (each with `gatePass`), `gatePassCount`.
- `GET /v1/grey-lots/fabric-returns/:id` (VIEW) · `GET /v1/grey-lots/fabric-return/lots?customerId&search&limit` (VIEW, the lot / thaan picker) · `POST /v1/grey-lots/fabric-return` (FULL, now checks the Grey Store, not the SO card desk).
- `GET /v1/so-cards?isGreyReturn=true|false` filter added.

## Fabric return is separate from SO cards (2026-10-20)
Details: `docs/frontend/fabric-return-grey.md` section 6. Fabric returns are hidden from the SO Card section by the backend: `GET /v1/so-cards` (normal cards unless `?isGreyReturn=true`), `GET /v1/so-cards/incoming`, `GET /v1/jobs?side=out` without `departmentId`, the SO card reports and the overview. Grey lots: `soCardMeters` excludes them; new `fabricReturnMeters`.

## Fabric return numbers: FR-1, FR-2 (2026-10-20)
Details: `docs/frontend/fabric-return-grey.md` section 7. A fabric return has its own gap-free series, so the SO card numbers stay continuous. Show `cardLabel` (`"5"` or `"FR-5"`) instead of `cardNo`, and `soLabels` instead of `soNos`. `soCard.cardLabel` is on every soCard object (jobs, Folding, Packing, packing list, gate pass, chemical screens). Report "SO #" columns have the key `cardLabel`. `GET /v1/grey-lots/fabric-return/lots` also returns `nextCardNo` and `nextCardLabel`. Searches accept `FR-3`.

## Employees and client admins (2026-10-20)
Full frontend guide: `docs/frontend/employees.md`.
- **Client admin** (own company only): `GET /v1/users/service-options` (the company's services, `accessLevels`), `GET|POST /v1/users` (`name`, `email`, `phone?`, `password`, `services?`), `GET|PATCH /v1/users/:id` (`name`, `email`, `phone`, `isActive`), `POST /v1/users/:id/reset-password`, `PUT /v1/users/:id/services` (replaces the list; report services are always VIEW; 422 `SERVICE_NOT_IN_COMPANY`). `409 EMAIL_TAKEN` (email unique per company). Employee objects have `phone`, `serviceCount`, `services[]` (with `menuGroup`).
- **Super admin, client admins:** `POST /v1/companies/:id/admins` (new), `PATCH /v1/companies/:id/admins/:userId` (`name`, `email`, `phone`, `isActive`), `DELETE /v1/companies/:id/admins/:userId` (new, soft delete, answers `{ deleted, id, effect }`), reset password as before. Answers carry `effect: { activeAdmins, employees, employeesBlocked }`.
- **Super admin, read only:** `GET /v1/admin/users?page&limit&search&companyId&userType&isActive` (with `summary`) and `GET /v1/admin/users/:id` (with `services[]`; a client admin also shows `employees[]` with their services). The super admin cannot create or change employees.
- **Lock-out rule:** an employee works only while the company is on and has an active client admin; switching off / deleting the last one locks all his employees out (login, open sessions, refresh).

## Colours: Dyeing employees (2026-10-20)
Details: `docs/frontend/colours.md`. `GET /v1/colours` (+ `/:id`) and `POST /v1/colours` are open to **Dyeing** (the only department that gives colours) as well as to the SO Card service: list = VIEW on either, create = FULL on either. `PATCH` / `DELETE` stay with SO Card FULL. Other departments still get 403. The job data (`colour`, `colours`, `items[].colour`) carries the colour to every department, so screens should not look names up in `/v1/colours`.

## Accounting: Chart of Accounts, journal, Sales Invoice (2026-10-24 to 2026-10-26)

All under `/api/v1`. Guides: `docs/frontend/chart-of-accounts.md`, `docs/frontend/sales-invoice.md`. The list of what changed in version 2 is `docs/CHANGELOG-accounts-v2.md`.

- **Chart of Accounts** (service `ACC_COA`): `GET /accounts/options`, `/accounts/tree`, `/accounts`, `/accounts/next-code`, `/accounts/presets`, `/accounts/templates`, `/accounts/issues`, `/accounts/:id`; `POST /accounts`, `POST /accounts/apply-template`; `PATCH` and `DELETE /accounts/:id`.
- **Opening balances and settings** (service `ACC_COA`): `GET|PUT /accounting/opening-balances`, `GET|PUT /accounting/settings`.
- **Sales Invoice** (service `ACC_SALES`): `GET /sales-invoices/options`, `/sales-invoices/gate-passes`, `/sales-invoices`, `/sales-invoices/:id`, `/sales-invoices/:id/accounts-entry`; `POST /sales-invoices`, `POST /sales-invoices/:id/approve`, `POST /sales-invoices/:id/unapprove`; `PATCH` and `DELETE /sales-invoices/:id`.
- **Customers** now carry the vendor-style fields (legal name, status, type, payment, CNIC, NTN, GST#, email, city, province, bank); `GET /customers/options` has the dropdown values.
- **Purchase Invoice** (service `ACC_PURCHASES`): `GET /purchase-invoices/options`, `/purchase-invoices/inwards`, `/purchase-invoices`, `/purchase-invoices/:id`, `/purchase-invoices/:id/accounts-entry`; `POST /purchase-invoices`, `POST /purchase-invoices/:id/approve`, `POST /purchase-invoices/:id/unapprove`; `PATCH` and `DELETE /purchase-invoices/:id`. Guide: `docs/frontend/purchase-invoice.md`.
- **Reports** (service `ACC_REPORTS`, read only): `GET /accounting/trial-balance`, `GET /accounting/ledger?accountId=`. Guide: `docs/frontend/trial-balance.md`.
- The journal (the accounting engine) has no endpoints of its own yet: invoices and vouchers post through `journalService`; a posted line is never changed (a reversal entry is posted instead).

## Vouchers (accounting)

- **Payment Voucher** (`ACC_PAYMENTS`): `/payment-vouchers` - `GET /options`, `GET /bills?vendorId`, `GET /`, `POST /`, `GET|PATCH|DELETE /:id`, `POST /:id/confirm`, `POST /:id/unconfirm`, `GET /:id/accounts-entry`.
- **Receipt Voucher** (`ACC_RECEIPTS`): `/receipt-vouchers` - same, with `GET /invoices?customerId`.
- **Journal Voucher** (`ACC_JOURNAL`): `/journal-vouchers` - same, without the picker.
Guide: `docs/frontend/vouchers.md`.

## Ledgers (accounting reports)

- `GET /accounting/party-ledger?partyType&partyId`, `GET /accounting/payables`, `GET /accounting/receivables` (ACC_REPORTS).
- `GET /accounting/bank-accounts`, `GET /accounting/bank-summary?accountId`, `PUT /accounting/bank-clearing`, `DELETE /accounting/bank-clearing/:lineId` (ACC_BANK).
Guide: `docs/frontend/ledgers.md`.

## Reports (accounting, ACC_REPORTS)

`GET /accounting/profit-loss`, `/balance-sheet`, `/balances`, `/balances/open-items`, `/cutoff` (and `/trial-balance`, `/ledger`). Guide: `docs/frontend/accounting-reports.md`.

Credit terms (2026-10-29): customers / vendors carry `creditLimit` (optional) and `creditDays`; both invoices have `dueDate`, `isOverdue` and `creditWarning` (a warning only); `GET /sales-invoices/credit/:customerId`, `GET /purchase-invoices/credit/:vendorId`; `GET /accounting/due-schedule` (receivable / payable / net by due date; `date`, `buckets=15,30,60`, `search`, `detail`). Guide: `docs/frontend/credit-terms.md`.

## Contra voucher (accounting, ACC_CONTRA)

`/contra-vouchers`: `GET /options`, `GET /invoices?customerId`, `GET /bills?vendorId`, `GET /`, `POST /`, `GET|PATCH|DELETE /:id`, `POST /:id/confirm`, `POST /:id/unconfirm`, `GET /:id/accounts-entry`. Guide: `docs/frontend/contra-voucher.md`.

## Default accounts (ACC_COA)

`GET /accounts/defaults`, `GET /accounts/defaults/:key/candidates`, `PUT /accounts/defaults/:key`, `POST /accounts/defaults/:key/create`, `POST /accounts/defaults/create-all`. Guide: `docs/frontend/default-accounts.md`.

Open an employee's account (2026-10-29): `POST /users/:id/open` (client admin only) answers `{ accessToken, tokenType, expiresIn: "4h", user, company, services }`, no refresh token. Guide: `docs/frontend/open-employee-account.md`.

Process overview (2026-10-30): `GET /v1/departments/overview` answers an array, one item per department the person may see (a client admin: all; a user: the ones given): `{ id, code, name, kind, counts: { IN_WAY, QUEUE, PENDING, PROCESSING, COMPLETE, REJECTED, rejectedHere } }`. The five statuses are the incoming list with show=active; `REJECTED` = the department's `/rejected` list (jobs it sent that were rejected); `rejectedHere` = incoming with status=REJECTED. Rate limit: every signed-in person has their own bucket (`RATE_LIMIT_USER_PER_MINUTE`, default 1200/min), anonymous requests share `RATE_LIMIT_IP_PER_MINUTE` (default 300/min) per IP; before, 300/min was shared by everyone behind one IP.

Store overview (2026-10-30): `GET /v1/stores/overview?months=6` (1 to 12, default 6, including the current month) answers `{ asOf, stores: [ { store, name, series[months], stock { value, itemCount, lowCount, outCount, byCategory[] }, topVendors[5], drafts { inwards, outwards } } ] }` for the stores the person has a service for (an empty list when none). Inwards = approved inwards by date at the billed amount (amount + tax); outwards = ISSUE store moves at the stock rate (the General Store has none: zeros); `drafts.outwards` = chemical requests still waiting in the store (Queue / Process). Money is a string with 2 decimals. Seven aggregated queries for all stores together. Test: `tests/storeOverview.test.js`.

Accounting overview (2026-10-30): `GET /v1/accounting/overview` answers the whole Accounting Overview screen: `asOf`, `today { sales, purchases, received, paid }`, `cashBank`, `partyBalances`, `stock`, `profit`, `books`, `months` (6), `vouchers`, `topReceivables`, `topPayables`, `recentSales`, `recentPurchases`, `recentVouchers`. Every block is checked on its own against the person's services (ACC_SALES, ACC_PURCHASES, ACC_RECEIPTS, ACC_PAYMENTS, ACC_JOURNAL, ACC_COA, ACC_REPORTS, CHEMICAL_STORE / GENERAL_STORE): a block the person may not see is `null` (200, never 403), an allowed empty list is `[]`. Money is a string with 2 decimals, counts are integers. `profit` and `books` are the Profit & Loss and Balance Sheet reports' own answers; `partyBalances` follow `/accounting/balances`; `months` is the Profit & Loss by month. Test: `tests/accountingOverview.test.js`.

Payroll services (2026-10-30): `PAYROLL` is a valid `menuGroup` (create / edit service). Four built-in MODULE services in that tab (VIEW / FULL): `PAYROLL_SALARY`, `PAYROLL_REPORTS`, `PAYROLL_APPLICATIONS`, `PAYROLL_EMPLOYEES`. They are given to companies and employees like every other service and show in `GET /services`, `GET /users/service-options` and `GET /auth/me` (`services[]`). No payroll data endpoints yet.

Employee job roles and access levels (2026-10-30): `users.jobRole` (a label and a filter, never a permission; list in `src/utils/jobRoles.js`: Employee, Supervisor, Assistant Manager, Manager, Department Manager, Accountant, Finance, Assistant Accountant, Store Manager, Store Inventory Employee ...). `GET /v1/users/roles` -> `{ default: "EMPLOYEE", data: [{ code, label, count }] }`; `POST /v1/users` takes `jobRole` (default EMPLOYEE), `PATCH /v1/users/:id` can change it; `GET /v1/users?jobRole=ACCOUNTANT,MANAGER` filters; user objects (list, get, auth/me, login) have `jobRole` and `jobRoleText` (null for admins). Every service, report services too, can be given to an employee as VIEW or FULL (`accessLevels` is always `["VIEW","FULL"]`, a report service is no longer forced to VIEW).

Payroll masters (2026-10-30, chunk 1 of Payroll): `/v1/payroll/{groups,departments,designations,shifts,holidays,banks}` (list, create, get, patch, delete; list `{ data, page, limit, total }`) and `GET /v1/payroll/masters` (all active masters for the dropdowns). Read: any payroll service (VIEW); change: `PAYROLL_EMPLOYEES` FULL. The four default groups (Factory, Outlet, Head Office, Admin) are made per company on first use and can never be deleted; a group, department, designation, shift, bank or holiday is deleted only when nothing uses it (`IN_USE`). Guide: `docs/frontend/payroll-masters.md`.

Payroll employee master (2026-10-30, chunk 2): `/v1/payroll/employees` (list with filters and `closed=false|true|all`, `/summary` for the tab numbers, create, get, patch, delete a draft), `POST /:id/confirm`, `/unconfirm`, `/close` `{ leavingDate }`, `/reopen`, and the documents `PUT|GET|DELETE /:id/files/{photo,cnic-front,cnic-back}`. Files are kept in the database (`payroll_files`, bytea, up to 2 MB, JPG / PNG / PDF, the type read from the first bytes); upload = the raw file as the request body (not multipart) with `X-File-Name`; download needs the bearer token. Money is a string with 2 decimals; payment is cash automatically without bank details. Read: any payroll service; change: `PAYROLL_EMPLOYEES` FULL. Guide: `docs/frontend/payroll-employees.md`.

Payroll policy (2026-10-30, chunk 3): `/v1/payroll/policies` (list, create, get, patch, delete), `GET /policies/by-group?month=YYYY-MM` (the policy in force for every active group) and `GET /policies/effective?groupId&month`. A policy is a version of a group that holds from its month until the next version; a month with none uses the built-in defaults (`source: DEFAULT`). Rules: late limit, half-day limit (must be more than the late limit), lates per half day, weekly off day, overtime factor, leave earned per month, max leave per year, months before leave. A new version starts from the policy in force that month. Read: any payroll service; change: `PAYROLL_EMPLOYEES` FULL. The payroll will copy the policy when it is created. Guide: `docs/frontend/payroll-policy.md`.

Payroll joining applications (2026-10-31, chunk 4): `/v1/payroll/applications` (list, summary, create, get, patch, delete, `POST /:id/submit`, `POST /:id/withdraw`, `PUT|GET|DELETE /:id/files/:kind` with kind photo, cnic-front, cnic-back, form). Read: any payroll service; change: `PAYROLL_APPLICATIONS` FULL. The employee card has `yearlyIncomeTax` (renamed from `monthlyIncomeTax`) and `monthlyEobi`. See docs/frontend/payroll-applications.md.

Payroll application approval (2026-10-31, chunk 5): `PATCH /v1/payroll/applications/:id/review`, `POST /applications/:id/approve`, `POST /applications/:id/reject` (reviewer: client admin or a chosen approver), `POST /applications/:id/reopen` (HR); `GET|PUT /v1/payroll/approvers`. Application statuses DRAFT / IN_REVIEW / APPROVED / REJECTED; approving creates a CONFIRMED employee card with the photo and CNIC copies. See docs/frontend/payroll-approval.md.

Payroll IBAN and percents (2026-10-31): employees and joining applications have `iban` (PK + 22 characters, optional, apart from `accountNo`), `yearlyIncomeTaxPercent` and `monthlyEobiPercent` (0 to 100, 2 decimals, percent of the basic salary; they replace the amount fields `yearlyIncomeTax` and `monthlyEobi`) and the read only `monthlyDeductions { incomeTax, eobi, total }`.

Payroll attendance (2026-11-01, chunk 6): `/v1/payroll/attendance`: `GET /overview`, `POST /punches/preview`, `POST /punches/import` (rows of employee ID + date + time, up to 5000 per call), `GET /punches`, `GET /unmapped`, `GET /batches`, `DELETE /batches/:id` (undo an import), `GET /devices`, `PATCH /devices/:id`, `POST /fetch` (machine API, answers `API_NOT_CONFIGURED` for now), `POST /process`, `GET /days` (month grid), `GET /summary` (totals, overtime days, payable days), `GET /daily`, `PATCH|DELETE /days/:employeeId/:date` (HR correction / reset). Read: any payroll service; change: `PAYROLL_SALARY` FULL. See docs/frontend/payroll-attendance.md.

Payroll resignation applications (2026-11-02, chunk 7): `/v1/payroll/resignations` (list, summary, create, get, patch, delete, `POST /:id/submit`, `/withdraw`, `/reopen` for HR; `PATCH /:id/review`, `POST /:id/approve`, `/reject` for a client admin or chosen approver), `GET /resignations/absentees?days=N` (employees with no punch for N days). Approving closes the employee card with the last working day. Read: any payroll service; HR writes with `PAYROLL_APPLICATIONS` FULL. See docs/frontend/payroll-resignations.md.

Employee loans (2026-11-03, chunk 8): `/v1/payroll/loans` (list, summary, create, get, patch, delete, `POST /:id/submit`, `/withdraw`, `/reopen`, `/attachments` for HR; `PATCH /:id/review`, `POST /:id/approve`, `/reject` for a client admin or chosen approver; `GET /loans/summary` for the tabs). The money is paid by the new **Employee Loan Voucher**: `/v1/employee-loan-vouchers` (same shape as the other vouchers, service `ACC_PAYMENTS`; `GET /loans` is the loan picker): Debit Employee Loans, Credit Bank / Cash. New default account role `EMPLOYEE_LOANS` (group PAYROLL) in `GET /accounts/defaults`. See docs/frontend/payroll-loans.md.

Payroll leave applications and the Annual Leaves report (2026-11-04, chunk 9): `/v1/payroll/leaves` (list, summary, preview, balance, create, get, patch, delete, `POST /:id/submit`, `/withdraw`, `/reopen` for HR; `PATCH /:id/review`, `POST /:id/approve`, `/reject`, `/cancel` for a client admin or chosen approver), `GET /v1/payroll/reports/annual-leaves` and `/annual-leaves/:employeeId`. Annual leave comes from the group policy (earned per month, yearly maximum, months before leave); an approved leave shows as AL in the attendance. See docs/frontend/payroll-leaves.md.

Payroll (2026-11-05, chunk 10): `/v1/payroll/runs` (list by month, create, get, delete, `PATCH /:id/policy`, `POST /:id/add-employees`, `GET /:id/slips`, `GET /:id/attendance`, `POST /:id/slips/move`), `/v1/payroll/slips/:id` (get, patch, delete, `PUT /days/:date`, `POST /get-attendance`, `/calculate`, `/suspend`, `/resume`, `/review`, `/final-review`, `/approve`, `/send-back`). HR (`PAYROLL_SALARY` FULL) changes; a client admin or chosen approver reviews and approves. Approving a payslip posts the entry (Debit Salaries, Credit Salaries Payable / Employee Loans / EOBI Payable / Income Tax Payable - Salaries / Other Employee Deductions) and writes the loan instalment. Salary is paid by the **Salary Payment Voucher** `/v1/salary-payment-vouchers` (service `ACC_PAYMENTS`; `GET /slips` is the payslip picker). Five new default account roles (group PAYROLL). See docs/frontend/payroll-runs.md.

## EOBI Contribution List (payroll reports) and EOBI voucher
Full guide: `docs/frontend/eobi.md`. Routes under `/payroll/eobi/*` (providers, locations, rates, lists, rows, import, summary; read = any payroll service, write = `PAYROLL_REPORTS` FULL) and `/v1/eobi-vouchers` (`ACC_PAYMENTS`, label `EOV-`). Confirming posts Dr EOBI Payable + Dr EOBI Employer Contribution / Cr Bank. New default role `EOBI_EMPLOYER_EXPENSE`.

## Employee income tax and the salary tax voucher
Full guide: `docs/frontend/income-tax.md`. `/payroll/income-tax` (list with tax per employee, `PUT employees/:id` edit from a month, `POST import` sheet with `dryRun`, `report`; read = any payroll service, write = `PAYROLL_EMPLOYEES` FULL) and `/v1/salary-tax-vouchers` (`ACC_PAYMENTS`, label `STV-`; confirm posts Dr Income Tax Payable - Salaries / Cr Bank). Payslips expose `taxSource`.

## Services: edit, Packing in Production, Process brings Folding + Packing
`PATCH /v1/services/:id` (super admin): `name`, `kind`, `menuGroup`, `tracksColour`, `isActive`, `sortOrder`; `code` is refused (400). Built-in modules: `kind` / `menuGroup` / `tracksColour` changes give 403 `CORE_MODULE` (rename allowed). A `PACKING` service always has `menuGroup = PRODUCTION`. Enabling a `PROCESS` service for a company (toggle, list, from the service side) also gives it every active `FOLDING` and `PACKING` service; a user granted a process also gets the company's folding / packing as VIEW (an access level already given is kept). Disabling is not coupled.

## Payroll overview
`GET /api/v1/payroll/overview?month=YYYY-MM` (any payroll service, VIEW enough; `Cache-Control: private, max-age=30`): month, monthLabel, employees, payroll {totals, runs[]} (same as `/payroll/runs`, no payslips), trend (6 months; net = approved net), breakdown (basic = gross - overtime), attendance, compliance {eobi, tax}, approvals.waiting. A part that cannot be worked out is left out. Test: `tests/payrollOverview.test.js`.

## Salary sheet, attendance sheet, payslip PDF
Guide: `docs/frontend/payroll-sheets.md`. `GET /payroll/runs/:id/salary-sheet|attendance-sheet[?format=xlsx]`, `GET /payroll/slips/:id/pdf`, `GET /payroll/runs/:id/payslips.pdf` (any payroll service). Food and maintenance are now pro-rata on P + L + HD + R (FIXED salary: in full; HR-typed figures stay). New dependencies `pdfkit`, `exceljs`.

## Salary increment (during the year)
Guide: `docs/frontend/salary-increment.md`. `/payroll/increments` (list with tabs and counts, csv, sample.csv, employees picker, create drafts, import CSV, page, edit, delete, submit / withdraw / final-review / approve / send-back / reject, bulk steps). HR = `PAYROLL_APPLICATIONS` FULL, approvers = client admin or a chosen approver. Posting updates salary AND food / mobile / maintenance on the employee master. Migration `20261120000001-salary-increments.js`.

## Bank upload file and cash sheet
Guide: `docs/frontend/bank-file-cash-sheet.md`. Bank file (Meezan Bank layout): `GET /payroll/runs/:id/bank-file[?scope=unpaid|all&onlyNew=true]` (preview, saves nothing), `POST /payroll/runs/:id/bank-file {format, scope, onlyNew}` (PAYROLL_SALARY FULL: makes and keeps the file, ticks the payslips; can be made again), `GET /payroll/runs/:id/bank-files` (history), `GET /payroll/bank-files/:id/download` (the file exactly as made). Payslip JSON has `bankFile` (null or {id, code, label}); the payroll JSON has `bankFile {bankSlips, inFile, last}`. Cash sheet: `GET /payroll/runs/:id/cash-sheet[?scope=&denominations=5000,1000,...&format=json|xlsx|pdf]`. Migration `20261121000001-bank-files.js`.

## Employee card and joining application: fixed tax, no EOBI percent (2026-11-11)
Guide: `docs/frontend/employee-card-changes.md`. `monthlyIncomeTax` (money string, a fixed amount every month; "0" clears) replaces `yearlyIncomeTaxPercent`; `monthlyEobiPercent` is removed (EOBI comes from the EOBI list); new optional `eobiNo`, `scssiNo` (max 30). The joining application no longer needs any bank data (no bank = cash; old bank data is kept); the reviewer edits `monthlyIncomeTax`. Income-tax screens: `cardPercent` is now `cardAmount`. Migration `20261122000001`.

## Attendance punches upload: strict rows, duplicates (2026-11-11)
`POST /payroll/attendance/punches/preview|import` rows are `{ employeeId, date: "YYYY-MM-DD", time: "HH:MM" | "HH:MM:SS", device?, mode? }` (max 5000). Only that date and 24-hour time format is accepted (year 2000 to 2100); anything else is an `invalidRows` entry with the reason `Date must be YYYY-MM-DD` / `Time must be HH:MM or HH:MM:SS`. `device` and `mode` are optional (stored as null; no "Unknown" device). A punch is identified by company + employee + exact second; a file with nothing new answers **200** with `inserted: 0`, `batchId: null` and makes no batch and no recalculation (new punches answer 201). The optional server-side `month` check was NOT added.

## Attendance Report and Punch Report (monthly)
Guide: `docs/frontend/attendance-reports.md`. `GET /payroll/attendance/report` (all employees x dates: code + in / out), `GET /payroll/attendance/report/employees/:id?month=` (one employee, every date), `GET /payroll/attendance/punch-report` (all employees x dates: every punch time), `GET /payroll/attendance/punch-report/employees/:id?month=` (every punch with device and source). Filters: `month, groupId, departmentId, designationId, employeeId, search, closed, page, limit`; `&format=xlsx` for Excel. Any payroll service (VIEW). Test: `tests/payrollAttendance.test.js`.

## Grey width (2026-11-12)
Guide: `docs/frontend/grey-width.md`. `width` (lot) and `thaans[]` items `{ length, width }` on `POST/PATCH /grey-lots`; lot JSON has `width`, `widths`, `thaans[].width`. The width follows the thaan to the SO card (`lots[].width/widths/thaans[].width`), job items, Folding rows, the packing form and the packing list lines. Migration `20261123000001-grey-width.js`. Test: `tests/greyWidth.test.js`.

Grey width in reports: a `width` column (list text, e.g. "58, 60, 63") on grey lot-wise, grey returns, SO card lots, one SO card (lots and cloth now), cloth now, folding; a numeric `width` per line on packing lists (thaan wise). See `docs/frontend/grey-width.md` section 6.

## Return cloth to the SO Card section (2026-11-13)
Guide: `docs/frontend/return-to-so-card.md`. `POST /departments/:code/jobs/:jobId/return-to-so-card {all | soCardIds | jobItemIds, reason}` and `POST /departments/:code/return-to-so-card {jobItemIds, reason}`: cloth that came straight from an SO card goes back to the SO desk (job `canReturnToSoCard`; In-Way / Queue / Pending only; FULL access to the department). A job is returned in full (REJECTED + `returnedToSoCard`, statusText "Returned to SO Card") or, for some SO cards only, the returned rows move to a new job. Migration `20261124000001`. Test: `tests/returnToSoCard.test.js`.

## Advance (employee advance, 2026-11-14)
Guide: `docs/frontend/advance.md`. No approval. `/payroll/advances` (list, summary, `employee/:id` = the form data with the loan history, create / change / delete; HR = PAYROLL_APPLICATIONS FULL), `/v1/employee-advance-vouchers` (accounting voucher with the advance picker, confirm posts Debit Employee Advances / Credit Bank or Cash), payslip `deductions.advance` (+ `advances[]` on the slip, adjustable with `advances: [{advanceId, amount}]`), salary sheet and payslip PDF column. New default account role `EMPLOYEE_ADVANCES`. Migration `20261125000001`. Test: `tests/payrollAdvances.test.js`.

## Chemical requests per department (2026-11-15)
Guide: `docs/frontend/department-chemical-access.md`. Client admin: `GET /department-settings`, `PUT /department-settings {departments:[{code, chemicalRequests}]}`, `PATCH /department-settings/:code {chemicalRequests}`. `company_services.chemicalRequests` (default true) per department, only counts while the company has the Chemical Store. A department without it: chemical request / return / cost / own-chemicals endpoints give 403 `CHEMICAL_NOT_ALLOWED`; every JSON under `/departments/:code/...` for its people drops the chemical fields; `/auth/me` services of kind PROCESS / FOLDING have `chemicalRequests`. Migration `20261126000001`. Test: `tests/departmentChemicalAccess.test.js`.
