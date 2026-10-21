# SERVICE ACCESS: the super admin gives everything; tabs and items appear only when allowed

Read this fully before starting. It has three parts: (A) what changed in the backend, (B) the Super Admin screens, (C) the Client Admin / User screens (menu, tabs, guards).

## A. What changed in the backend (migration 20261020000002)

### A1. Nothing is given automatically any more
- Before: every new company got the built-in modules (Grey Store, SO Card, Chemical Store, General Store, Packing, Gate Pass ...) by itself, and the super admin could not give or take them (`422 MODULE_SERVICE`).
- Now: **a new company has no services at all** (`services: []`). The super admin gives every single service the client asked for. Modules, departments and reports are all treated the same way.
- `POST /v1/services/:id/companies` no longer refuses modules. `PUT /v1/companies/:id/services`, `PUT /v1/companies/:id/services/:serviceId` and `PUT /v1/services/:id/companies` already worked for modules and still do.
- Companies that already exist keep what they have today. The super admin can now remove any of it.
- The client admin of a company sees **exactly the services the company was given** (FULL access). A normal user sees only what the client admin gave on the Users screen, and only from the company's services.

### A2. New fields on every service
`GET /v1/services`, `GET /v1/companies/:id`, `GET /v1/auth/me` and the login answer now carry:
```json
{ "id": "uuid", "code": "GREY_STORE", "name": "Grey Store", "kind": "MODULE", "menuGroup": "PRODUCTION", "isBuiltIn": true }
```
(`isBuiltIn` only on `/v1/services`; `access` only on `/auth/me` and login.)
- **`menuGroup`**: the client tab the service belongs to: `PRODUCTION`, `PROCESS`, `STORE`, `REPORTS` (can be `null` for a custom service).
- **`kind`**: now `MODULE`, `PROCESS`, `FOLDING`, `PACKING` or **`REPORT`** (new).
- **`isBuiltIn`**: `true` for the system's own services that can never be deleted (`422 CORE_MODULE`). Hide the delete button for these. This replaces the old "AUTO" badge idea.
- `GET /v1/services?kind=REPORT` (or `kind=PROCESS,FOLDING,PACKING`) works with the new kinds.
- `POST /v1/services` and `PATCH /v1/services/:id` accept `menuGroup` (one of the four, or `null`). A new service of kind PROCESS / FOLDING / PACKING lands in `PROCESS` by itself.

### A3. The service list (all codes)
| menuGroup | code | name | kind |
|---|---|---|---|
| PRODUCTION | `GREY_STORE` | Grey Store | MODULE |
| PRODUCTION | `SO_CARD` | SO / Travel Card | MODULE |
| PRODUCTION | `GATE_PASS` | Gate Pass | MODULE |
| PROCESS | `SINGEING` `DYEING` `DRYER` `FINISHING` `STITCHING` `CUTTING` `PRINTING` `STENTER` `COMPACTING` | the department names | PROCESS |
| PROCESS | `FOLDING` | Folding | FOLDING |
| PROCESS | `PACKING` | Packing | PACKING |
| STORE | `CHEMICAL_STORE` | Chemical Store | MODULE |
| STORE | `GENERAL_STORE` | General Items Store | MODULE |
| STORE | `STORE_REPORTS` | Store Reports | REPORT |
| REPORTS | `REPORT_OVERVIEW` | Overview Report | REPORT |
| REPORTS | `REPORT_GREY` | Grey / Inward Reports | REPORT |
| REPORTS | `REPORT_SO_CARDS` | SO Card Reports | REPORT |
| REPORTS | `REPORT_DEPARTMENTS` | Department Reports | REPORT |
| REPORTS | `REPORT_CHEMICAL_COST` | Chemical Costing Report | REPORT |
| REPORTS | `REPORT_FOLDING` | Folding Report | REPORT |
| REPORTS | `REPORT_ACTIVE_FABRIC` | Active Fabric Report | REPORT |
| REPORTS | `REPORT_PACKING` | Packing Reports | REPORT |
| REPORTS | `REPORT_GATE_PASSES` | Gate Pass Report | REPORT |

- The old single `REPORTS` service is **gone**. Everybody who had it got all nine `REPORT_*` services (same VIEW / FULL), and everybody who had `CHEMICAL_STORE` got `STORE_REPORTS`, so nobody lost access.
- Never hardcode ids; ids differ per database. Always use `code`.

### A4. What the backend now enforces (so a hidden tab is also closed by the API)
| Service | What it protects |
|---|---|
| `CHEMICAL_STORE` | everything of `/v1/stores/chemical/...` **except** the cost reports: items, categories, brands, inwards, stock, batches, adjustments, department access, requests from departments, returns |
| `GENERAL_STORE` | everything of `/v1/stores/general/...` |
| `STORE_REPORTS` | the chemical cost reports: `/v1/stores/chemical/cost/jobs`, `/cost/so-cards`, `/cost/jobs/:id`, `/cost/so-cards/:id`. A person with only `STORE_REPORTS` (no `CHEMICAL_STORE`) can open these and nothing else of the store |
| `REPORT_*` | `/v1/reports/...` (see `reports.md`) |
| `GREY_STORE` | grey lots, customers, qualities, give back, fabric return grey |
| `SO_CARD` | SO cards, jobs sent from the SO desk, colours |
| each department code | that department's screens (`/v1/departments/:code/...`) |
| `PACKING` | packing lists **and gate passes** (gate pass APIs live under `/v1/departments/PACKING/...` and check the Packing access) |

- No access: **403** `{ "error": { "code": "FORBIDDEN", "message": "You do not have this service" } }`. VIEW only on a FULL action: 403 "You can only view this service".
- Chemical vs General are separate: a company can have one, both or none. Having `CHEMICAL_STORE` opens **all** chemical screens; the store tab then shows the chemical items.

---

## B. SUPER ADMIN screens

### B1. Services page (`/super-admin/services`)
1. **Remove the "AUTO" badge and the "Modules (AUTO)" stat card.** Nothing is automatic any more. Show the total and one count per `menuGroup` instead.
2. **Group the cards by `menuGroup`** in this order: Production, Process, Store, Reports (these are the same four tabs the client sees). Inside a group, keep the order the API returns (`sortOrder`). A service with `menuGroup: null` goes into an "Other" group at the end.
3. **Show the delete (trash) button only when `isBuiltIn` is `false`.** Built-in services (modules, packing, all report services) cannot be deleted. (The API also refuses with 422 `CORE_MODULE`.) The departments (Singeing, Dyeing ...) are not built in, so they keep their trash button as today.
4. Show a small badge of the `kind` if you like (Module, Process, Folding, Packing, Report). The new kind is `REPORT`.
5. **"Add Service" form:** add an optional **Tab (menuGroup)** dropdown (Production / Process / Store / Reports / none). Send `menuGroup` in `POST /v1/services`. When the user picks kind PROCESS or FOLDING and leaves the tab empty, the backend uses `PROCESS`.
6. Service detail (click a card): it already lists companies with ticks (`GET /v1/services/:id/company-options`). **Remove any rule that disables ticking for modules.** Saving with `POST /v1/services/:id/companies` `{ companyIds }` now works for modules and report services (before it answered 422 `MODULE_SERVICE`).

### B2. Company registration
1. `POST /v1/companies` (unchanged request). The answer has `services: []`.
2. After a successful registration **go straight to the new company's "Assign services" screen** (B3) and show a hint: "This company has no services yet. Choose what the client asked for." Do not tell the user that anything was given automatically (it was removed).
3. In the companies list, `serviceCount` now counts **every** service (before it skipped modules). Show a "No services" warning chip when it is `0`.

### B3. Company page: "Assign services" (the main new screen)
Show **one checkbox list in the same shape as the client's tabs**, so the super admin can think in the client's words. Load the list with `GET /v1/services?isActive=true` and the company's current services with `GET /v1/companies/:id` (`services[]`), then tick the ones the company has.

Layout (four panels or accordions, in this order):

**1. Production Management** (`menuGroup = PRODUCTION`)
- ☐ Grey Store (`GREY_STORE`): Inwards: Fabric Inwards, Customers, Fabric Quality
- ☐ SO / Travel Card (`SO_CARD`)
- ☐ Gate Pass (`GATE_PASS`)

**2. Process Management** (`menuGroup = PROCESS`)
- ☐ one checkbox per department: Singeing, Dyeing, Dryer, Finishing, Stitching, Cutting, Printing, Stenter, Compacting, Folding, Packing
- A "Select all departments" link is a good idea.

**3. Store** (`menuGroup = STORE`)
- ☐ Chemical Store (`CHEMICAL_STORE`): all chemical inwards, outwards and stock
- ☐ General Items Store (`GENERAL_STORE`)
- ☐ Store Reports (`STORE_REPORTS`): the cost reports of the Store tab
- Any of them can be given alone. One, two, three or none are all valid.

**4. Reports** (`menuGroup = REPORTS`)
- ☐ Overview, ☐ Grey / Inward, ☐ SO Card, ☐ Departments, ☐ Chemical Costing, ☐ Folding, ☐ Active Fabric, ☐ Packing, ☐ Gate Pass (the nine `REPORT_*` services)
- "Select all reports" link.

Each panel header has a **select all / clear** link and a counter ("3 of 9 given").

**Saving:**
- Easiest: one **Save** button that sends the whole ticked list: `PUT /v1/companies/:id/services` with `{ "serviceIds": ["uuid", ...] }` (replaces the list; an empty list removes everything).
- Or one switch per checkbox: `PUT /v1/companies/:id/services/:serviceId` with `{ "enabled": true | false }`.
- Both answer the full company object (`services[]` with `menuGroup`).
- **Taking a service away also removes it from that company's users at once** (the backend does it). Show a confirmation: "Users of this company will lose it too."
- A switched-off service (`isActive: false`) cannot be given (422 `UNKNOWN_SERVICE` / `SERVICE_INACTIVE`); show those greyed out.

**Remember:** the client admin can only give users what the company has. If the super admin did not tick Folding, the client admin never sees Folding anywhere.

---

## C. CLIENT ADMIN and USER screens (menu, tabs, guards)

### C1. Where the menu comes from
Everything comes from `GET /v1/auth/me` (and the login answer), `services[]`:
```json
{ "user": { ... }, "company": { ... },
  "services": [
    { "id": "uuid", "code": "GREY_STORE", "name": "Grey Store", "kind": "MODULE", "menuGroup": "PRODUCTION", "access": "FULL" },
    { "id": "uuid", "code": "DYEING", "name": "Dyeing", "kind": "PROCESS", "menuGroup": "PROCESS", "access": "VIEW" },
    { "id": "uuid", "code": "REPORT_GREY", "name": "Grey / Inward Reports", "kind": "REPORT", "menuGroup": "REPORTS", "access": "VIEW" } ] }
```
- Client admin: all the company's services, `FULL`.
- User: only what the client admin gave, `VIEW` or `FULL`.
- Keep this list in your auth state (refresh it after login and on app start with `/auth/me`). **Do not call the backend to ask "is this tab allowed"; just read this list.**
- Make one helper: `has(code)` returns `true` when `services` has that `code`; and `canEdit(code)` returns `true` when its `access` is `FULL`.

### C2. The one rule for every tab, card and menu item
> **An item is visible only if the person has its service. A tab (or dashboard card) is visible only if at least one of its items is visible. If nothing inside is visible, the tab disappears completely.**

Build every menu from a **config table** in the frontend, not from `if` statements spread around. Each item lists the service code(s) that open it; a tab is a list of items. Visibility:
```
item.visible  = item.services.some(has)            // any of its service codes
tab.visible   = tab.items.some(i => i.visible)
```
(Items with `services: []` are not built in the backend yet: hide them, see C3.)

### C3. The mapping for the current UI (use this as the config table)

**Dashboard cards** (`/client-admin/dashboard`):
| Card | Visible when |
|---|---|
| Production Management | any item of Production Management is visible |
| Process Management | any item of Process Management is visible |
| Store | any item of Store is visible |
| Reports | `services` has at least one `REPORT_*` |
| Accounts, Dyeing Process, Accounts (KB), HR & Payroll | not built in the backend: hide them (or show "coming soon" without a link) |

**Production Management** (`/client-admin/production`)
| Menu item | Service code(s) |
|---|---|
| Inwards > Fabric Inwards | `GREY_STORE` |
| Inwards > Customers | `GREY_STORE` |
| Inwards > Fabric Quality | `GREY_STORE` |
| Outwards > Fabric Returns (Grey) | `GREY_STORE` only. Use the Grey Store APIs `GET /v1/grey-lots/fabric-returns`, `.../fabric-returns/:id`, `.../fabric-return/lots` (see `fabric-return-grey.md` section 5). The company also needs Folding and Packing to finish the flow |
| Outwards > other sections | map each section to the service of the API it calls: SO card / send to department = `SO_CARD`; give back to party = `GREY_STORE`; gate pass = `PACKING` (see A4) |
| Contracts, Master Card | no backend yet: hide |
| Reports | visible if the person has any `REPORT_*` (opens `/client-admin/reports`) |
The "Inwards" group is visible when any of its three items is visible. The tab shows a group only if it has a visible item.

**Process Management** (`/client-admin/process-management`)
| Menu item | Service code(s) |
|---|---|
| SO Card Summary | `SO_CARD` |
| Dyeing > colour picker (list, add a colour, give it to a job) | `DYEING` only (FULL to add a colour). Not `SO_CARD`. See `colours.md` |
| Production > Singeing / Dyeing / Dryer / Finishing / Stitching / Cutting / Printing / Stenter / Compacting | the department's own code (`SINGEING`, `DYEING` ...) |
| Production > Folding | `FOLDING` |
| Packing (if/when added to the UI) | `PACKING` |
- **Build the department list from `services` (kind `PROCESS`, `FOLDING`, `PACKING`), not from a hardcoded array.** Then a new department added by the super admin appears by itself, and a department the company does not have never shows. Keep the order from `services` (it is already in menu order).
- The "Production" group opens only when at least one department is visible. The Process Management card on the dashboard hides when neither SO Card Summary nor any department is visible.

**Store** (`/client-admin/store`)
| Menu item | Service code(s) |
|---|---|
| Inwards > Chemical Inwards | `CHEMICAL_STORE` |
| Inwards > General Inwards | `GENERAL_STORE` |
| Outwards > Chemical Outwards (requests from departments, returns) | `CHEMICAL_STORE` |
| Outwards > General Outwards | `GENERAL_STORE` |
| Stock > Chemical Stock | `CHEMICAL_STORE` |
| Stock > General Stock | `GENERAL_STORE` |
| Reports (Chemical cost reports) | `STORE_REPORTS` |
- Inside Inwards / Outwards / Stock show **only the chemical entry, only the general entry, or both**, depending on what the company gave. If only one is visible, you may skip the sub-menu and open it directly.
- With `CHEMICAL_STORE`, **all chemical screens are open** (inwards, outwards, stock, items, categories, brands, vendors, adjustments, department access). With `GENERAL_STORE`, all general ones.
- **Store > Reports** is its own service: a person with `CHEMICAL_STORE` but not `STORE_REPORTS` does not see it (and the cost APIs answer 403). A person with only `STORE_REPORTS` sees only the Store tab with Reports in it.
- Chemical vs general in the URL: `/v1/stores/chemical/...` and `/v1/stores/general/...`.

**Reports** (`/client-admin/reports`)
- Call `GET /v1/reports`. It returns **only the reports the person may open** (see `reports.md`). Build the left menu from `reports[]`, grouped by `service`. Show the "Overview" entry only if `REPORT_OVERVIEW` is in the list.
- The groups of the current UI map to services: Overview = `REPORT_OVERVIEW`; Grey / Inward (3) = `REPORT_GREY`; SO Cards (3) = `REPORT_SO_CARDS`; Departments (3) = `REPORT_DEPARTMENTS`; Chemical costing = `REPORT_CHEMICAL_COST`; Folding = `REPORT_FOLDING`; Active fabric = `REPORT_ACTIVE_FABRIC`; Packing (2) = `REPORT_PACKING`; Gate passes = `REPORT_GATE_PASSES`.
- A group appears only if at least one report of it is in the list. Open the first allowed report by default. **Do not open "Overview" by default when the person does not have it** (the call would answer 403).

### C4. Route guards (people can type a URL)
Hiding the menu is not enough. On every page route:
1. Wrap each route with its service code(s) from the config table. If the person lacks them, redirect to the first page they can open (their dashboard) and show a toast "You do not have access to this page".
2. A tab's landing page (e.g. `/client-admin/production`) with nothing visible inside redirects to the dashboard.
3. After login, send the person to the dashboard. If **no** card is visible at all, show an empty state: "No services have been given to your account yet. Please contact your administrator."
4. Treat **HTTP 403 `FORBIDDEN`** from any API as "no access": do not show a raw error; go back to the dashboard (the person's services may have changed since login; refresh `/auth/me` and rebuild the menu).

### C5. VIEW vs FULL
- `access: "VIEW"` = read only (lists, details, reports); `"FULL"` = may also add, edit, approve.
- Hide or disable "Add", "Edit", "Delete", "Approve", "Send", "Accept" buttons when `canEdit(code)` is false. The API also answers 403 "You can only view this service".
- Reports need only VIEW.

### C6. Users screen (client admin gives services to users)
- The list of services the client admin can give is **only the company's services** (the client admin's own `/auth/me` `services`), nothing else. Show it in the same four tabs as B3 (use `menuGroup`), with a VIEW / FULL choice per service. For report services only VIEW makes sense; you may hide the FULL option for `kind: "REPORT"`.
- Save with `PUT /v1/users/:id/services` `{ "services": [ { "serviceId": "uuid", "access": "VIEW" } ] }`. Giving a service the company does not have answers 422.
- If the super admin later takes a service away from the company, the users lose it too (reload `/auth/me` to see it).

---

## Step-by-step checklist for the frontend developer

**Super admin**
1. Services page: remove the AUTO badge and "Modules (AUTO)" card; group by `menuGroup` (Production, Process, Store, Reports, Other); hide delete when `isBuiltIn`; add the Tab dropdown to "Add Service".
2. Service detail: allow ticking companies for modules and report services too.
3. Company registration: after saving, go to "Assign services"; show a "No services" chip in the companies list when `serviceCount` is 0.
4. Company page: build the four-panel "Assign services" checklist (B3) and save with `PUT /v1/companies/:id/services`; confirm before removing a service (users lose it too).

**Client side**
5. Keep `services` from `/auth/me` in auth state; add `has(code)` and `canEdit(code)` helpers.
6. Write one menu config table (C3) and one function that computes visible items and tabs (C2). Use it for the sidebar, the tab landing cards and the dashboard cards.
7. Build the Process Management department list from `services` (kind PROCESS / FOLDING / PACKING), not from a fixed array.
8. Store: show Chemical and General entries separately; show Reports only with `STORE_REPORTS`.
9. Reports page: menu from `GET /v1/reports`; first allowed report as default.
10. Add route guards (C4), the "no services yet" empty state, and the 403 handling.
11. Hide Add / Edit / Approve buttons when the access is VIEW (C5).
12. Users screen: offer only the company's services, in four tabs, VIEW / FULL (C6).
13. Test with four logins: (a) client admin with everything; (b) a company with only `GENERAL_STORE`; (c) a user with only `REPORT_GREY`; (d) a user with no service. Check that tabs and dashboard cards disappear exactly as in C2, and that typing a forbidden URL redirects.

## Errors you may see
| HTTP | code | When |
|---|---|---|
| 403 | `FORBIDDEN` | no service / VIEW only on a FULL action (go to dashboard, refresh `/auth/me`) |
| 422 | `CORE_MODULE` | deleting a built-in service (hide the button when `isBuiltIn`) |
| 422 | `UNKNOWN_SERVICE` | a service id in the list does not exist or is switched off |
| 422 | `SERVICE_INACTIVE` | giving a switched-off service to a company |
| 400 | `VALIDATION_FAILED` | bad `menuGroup` or `kind` |
