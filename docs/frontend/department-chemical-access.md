# Chemical requests per department (client admin settings) — Frontend Guide

## What it is
The **super admin** gives a company the **Chemical Store**. Now the **client admin** decides, **department by department** (Dyeing, Stitching, Folding ...), whether that department may **request chemicals** from the Chemical Store.

A department that was **not** given chemical requests:
- has **no** chemical request / return / chemical-cost screens (the tabs and menu items must not be shown);
- sees **no chemical field at all** with its jobs, SO cards or Folding: no chemical count, amount, previous chemical amount, cost per meter, Folding cost.

Everything else of the department (receive, accept, process, send, reject, Folding grading, ...) works exactly as before.

Rules:
- The switch matters only while the company **has the Chemical Store** (given by the super admin). Without the store no department can request chemicals (`chemicalRequests: false` for all, and the switch cannot be changed).
- **Default = ON** for every existing department, so nothing changes until the client admin switches one off.
- Only the **client admin** can change it. The client admin himself still sees all chemical fields everywhere (he is not "the department").
- Chemicals the Chemical Store allowed for a department (Store > Department access) are a separate thing and stay as they are; they only matter while the switch is ON.
- Requests the department already made stay with the store (the store still sees and can finish them). Switching OFF only closes the department's own screens.

---
## 1. The settings screen (client admin): Settings > Departments
`GET /api/v1/department-settings` (client admin only; others get 403)
```
{ chemicalStore: true|false,                      // does the company have the Chemical Store? false = show a note "Ask the super admin for the Chemical Store" and disable the switches
  data: [{ id, code:"DYEING", name:"Dyeing", kind:"PROCESS"|"FOLDING",
           chemicalRequests: true,                // the switch (what the admin chose)
           chemicalEnabled: true,                 // what really counts now (store given AND switch on)
           chemicalCount: 12 }] }                 // how many chemicals the store allowed this department
```
A table: Department, **Chemical requests** (toggle), and the number of chemicals allowed (link to Store > Department access). Packing is not listed (it does not request chemicals).

Change one: `PATCH /api/v1/department-settings/:code` body `{ "chemicalRequests": false }` → the whole list again (same as GET).
Change several at once (Save button): `PUT /api/v1/department-settings` body `{ "departments": [{ "code": "DYEING", "chemicalRequests": false }, { "code": "FOLDING", "chemicalRequests": true }] }` → the whole list.
- 422 `NO_CHEMICAL_STORE` when the company does not have the Chemical Store; 404 for an unknown department; 400 for a wrong body; 403 for a user who is not the client admin.
- Every change is written to the audit log (`DEPARTMENT_CHEMICAL_REQUESTS_CHANGED`).

## 2. What the department's screens must do
**The login answer and `GET /api/v1/auth/me`** list the services of the person. Every **department service** (kind `PROCESS` or `FOLDING`) now has **`chemicalRequests`: true | false**:
```
services: [{ id, code:"DYEING", name:"Dyeing", kind:"PROCESS", menuGroup, access:"FULL", chemicalRequests:false }, ...]
```
- `chemicalRequests: false` → **hide** in that department: the Chemical Request tab, Chemical Return tab, "My chemicals", the chemical cost report links, the "Request chemicals" button on a job / SO card, and every chemical column (Chemical count, Chemical amount, Cost per meter, Previous chemical, Folding cost).
- `GET /api/v1/departments` (the department list) is unchanged.
- After the client admin changes a switch, the users get the new value the next time `/auth/me` is called (refresh it when the department opens, or at the next login).

**If the screen still calls a chemical endpoint** of a department without access it gets **403** `CHEMICAL_NOT_ALLOWED` ("Dyeing has no chemical request access"). These endpoints are closed for that department (also for the client admin while using that department's URLs):
`/departments/:code/chemicals`, `/departments/:code/chemical-requests*`, `/departments/:code/chemical-returns*`, `/departments/:code/chemical-cost/*`, `/departments/:code/jobs/:id/chemical-cost`, `/departments/:code/so-cards/:id/chemical-cost`.

**The chemical fields are removed by the server** from every JSON of `/api/v1/departments/:code/...` for the people of that department (job lists incoming / sent / rejected, one job, job actions like receive / accept / status, SO Wise view, the Folding screens). The keys that disappear: `chemicalCount`, `chemicalAmount`, `previousChemicalAmount`, `totalChemicalAmount`, `costPerMeter`, `totalCostPerMeter`, `chemicalRequests`, `pendingChemicalRequests`, `foldingChemicalAmount`, and the Folding `cost` object / line `cost`. The screen must simply not break when a key is missing (do not read `row.chemicalAmount.toFixed()` without a check; show nothing).
The client admin gets all the fields as before.

## 3. Not changed
- The Chemical Store's own screens (its list of requests, costing, Department access, reports) and the general reports: they keep showing everything.
- Sending cloth, SO cards on the SO Card desk, Grey Store.

## Database
Migration `20261126000001-department-chemical-requests.js` (`company_services.chemicalRequests`, default true). Run `npm run db:migrate`.
