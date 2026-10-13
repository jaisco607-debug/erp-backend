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
