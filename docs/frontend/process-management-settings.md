# Process Management: switched on by the super admin, limit, and the client admin chooses his active processes — Frontend Guide

## What it is
- The **super admin** no longer hands out processes one by one. For each company he sets a **toggle "Process Management"** (ON / OFF) and a **limit** (how many processes the company may have ACTIVE).
- With the toggle **ON** the client admin has **Process Management** and a tab **Settings > Processes**. There he **adds his own processes** (any name) and **chooses which processes stay active**.
- With the toggle **OFF** the client admin has **no Process Management at all**: no menu group, no processes, no Settings > Processes tab. Nothing is deleted: switch it ON again and everything (including his on/off choices) is back.
- Everything else (Folding, Packing, SO cards, jobs, the chemical store and the "which department may request chemicals" setting) is unchanged.

## The limit rule (changed 2026-11-17)
> **active own processes + active assigned processes  <=  processLimit**

- **own** = processes the client admin added himself. **assigned** = platform processes the super admin gave the company (earlier, or from the company screen).
- Folding and Packing are **not** counted and are never switched off.
- **Active** = shown in the client admin's menus, can be given to users, can be used in jobs. **Inactive** = hidden everywhere for the company; **nothing is deleted** (jobs, SO cards, data stay). Switching on again brings everything back. The choice is **per company** (two companies sharing one platform process have independent switches).
- Adding a process or switching one **ON** needs `used < limit`. Switching one **OFF** is always allowed.
- **When the super admin lowers the limit below what is active (option A):** nothing is switched off for the client admin. `GET /processes` answers `overLimit: true`, he cannot add or switch on anything until he switches enough OFF himself. Show a banner "Your limit is 5 but 10 are active. Switch off 5."
- Companies that already existed: Process Management stays ON and their limit was set to the number of processes they have, so nobody is over the limit on day one. A company the super admin registers from now on starts with the toggle OFF and limit 0.

---
## 1. Super admin: the company screen
Fields on the company (create, edit, list, one company):
```
processManagement: true | false      // the toggle
processLimit: 0..1000                // how many ACTIVE processes the company may have
processesUsed: 10                    // ACTIVE own + ACTIVE assigned now (read-only). Show "10 of 5" in red when it is more than the limit
```
- `POST /api/v1/companies` accepts `processManagement` (default `false`) and `processLimit` (default `0`). `PATCH /api/v1/companies/:id` accepts either (send only what changed). Lowering the limit below `processesUsed` is allowed, nothing is switched off.
- `GET /api/v1/companies` (list) and `GET /api/v1/companies/:id` have the three fields; the single company also has `ownProcesses: [...]` (made by the client admin) next to `services` (platform services given).
- Switching the toggle **ON** gives the company Folding and Packing if it does not have them.
- On the company screen: a **Process Management** toggle, a **Process limit** number box (disabled while OFF) and "Active: 10 of 5".
- `PUT /companies/:id/services` ("exactly this list") and the service screens (give a service to companies) **keep the client admin's on/off choices**: a process that is already given keeps its switch; a process added to the list starts **active** (the limit is not checked for what the super admin gives; the client admin then sees `overLimit` and chooses). The client admin's own processes are never removed by these calls.
- `GET /api/v1/services` (the super admin's list) shows only platform services.

## 2. Client admin: what he sees
`GET /api/v1/auth/me` (and the login answer) lists his services. With the toggle **OFF** there is no service with `menuGroup: "PROCESS"` in it. With the toggle **ON** it has Folding, Packing, and the processes that are **ACTIVE** (own + assigned). **Inactive processes are not in `services[]`** (so they are not in the menus and cannot be given to users). Users lose an inactive process from their menu as well (their grant is kept and comes back when it is switched on again). Build the menu from `services[]` as before; call `/auth/me` again after any change.

Show **Settings > Processes** when `GET /api/v1/processes` answers 200; it answers **403 `PROCESS_MANAGEMENT_OFF`** when the toggle is OFF (hide the tab). Only a client admin may call it (others 403 `FORBIDDEN`).

## 3. Settings > Processes (client admin)
`GET /api/v1/processes`
```
{ enabled: true, limit: 5, used: 10, remaining: 0, canAdd: false, overLimit: true,
  data: [ { id, code, name, kind:"PROCESS", menuGroup:"PROCESS", tracksColour, isActive, sortOrder, isOwn: true,
            userCount, usage:{ jobs: 4 }, canDelete } ],        // the processes he added (editable)
  assigned: [ { id, code, name, kind, menuGroup, tracksColour, sortOrder, isOwn: false,
                isActive: true|false,                           // HIS choice for his company
                userCount, usage:{...} } ] }                    // given by the super admin (only the switch is his)
```
- `used` = active own + active assigned. `remaining = max(0, limit - used)`. `canAdd = used < limit` (false when the toggle is off). `overLimit = used > limit`.
- Show two lists (or one list with a badge "Added by you" / "Given by admin"), each row with an **Active** toggle. Show "Used 10 of 5" and the banner when `overLimit`.
- A switch that would go over the limit should be **disabled** when `remaining` is 0 and the process is off (the server also refuses it); switching OFF is always possible.

`PATCH /api/v1/processes/:id`
- **Own process**: any of `{ name, isActive, tracksColour, sortOrder }`. A rename that equals another of his processes gives 422 `PROCESS_NAME_TAKEN`.
- **Assigned process**: **only** `{ "isActive": true | false }`. Anything else (name, tracksColour, sortOrder) gives **422 `PROCESS_NOT_EDITABLE`** (`details: { editable: ["isActive"] }`). `code` always gives 400.
- Response: the process plus `{ isOwn, isActive, limit, used, overLimit }` (the numbers after the change), so the counter can be updated without a new GET.
- Switching **ON** while `used >= limit` gives **422 `PROCESS_LIMIT_REACHED`** with `details: { limit, used }` (used = active before the change).
- 404 for a process that is not his (another company's, or a platform process his company does not have).

`POST /api/v1/processes` body `{ "name": "Washing Unit", "tracksColour": true }` → 201 the process. The code is made by the server (`WASHING_UNIT`, a number is added when taken); it cannot be typed or changed. 422 `PROCESS_LIMIT_REACHED` (`details: { limit, used }`) when `used >= limit`, 422 `PROCESS_NAME_TAKEN`, 403 `PROCESS_MANAGEMENT_OFF`, 400 for a wrong name (2 to 120 characters).

`DELETE /api/v1/processes/:id` → `{ deleted: true }`. Only his **own** process that was **never used** (`canDelete: true`); users lose it. 422 `PROCESS_IN_USE` (`details.usage`) when there is work in it: show "Switch it off instead". **A platform (assigned) process can never be deleted by him** (404).

After any change refresh the menu: call `/auth/me` again and rebuild the sidebar.

## 4. After he adds a process
It is a normal department of his company: users get it in the Users screen, and its pages use the same URLs by code (`/api/v1/departments/WASHING_UNIT/...`). In Settings > Departments (the chemical request switch) it shows up too. Two companies can have a process with the same name and code.

## Errors summary
| Code | Where | Meaning |
|---|---|---|
| 403 `PROCESS_MANAGEMENT_OFF` | any `/processes` call | toggle OFF: hide the tab |
| 422 `PROCESS_LIMIT_REACHED` | add, switch ON | `used >= limit`; `details: { limit, used }` |
| 422 `PROCESS_NOT_EDITABLE` | PATCH an assigned process | only `isActive` can be changed |
| 422 `PROCESS_NAME_TAKEN` | add / rename | he already has a process with this name |
| 422 `PROCESS_IN_USE` | delete | work in it: switch it off |
| 404 | PATCH / DELETE | not his process; or DELETE of an assigned process |

## Database
Migrations `20261127000001-process-management-toggle.js` (`companies.processManagement`, `companies.processLimit`, `services.companyId`) and `20261128000001-company-process-active.js` (`company_services.isActive`; existing companies get a limit equal to their process count). Run `npm run db:migrate`.
