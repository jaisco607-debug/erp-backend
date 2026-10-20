# CHEMICAL REQUEST part E: Cost reports + SO card cost on department screens

Small add-on to part C. No database change (no migration). Only new read-only APIs.

## E1. What changed in the backend
- A department can now see the chemical cost of an SO card from its own screen (only its own jobs).
- New report lists: all Jobs or all SO cards with their chemical cost, with date / party filters.
- Same rules as part C: only chemicals that left the store (In-Way + Received) count; a "whole job" request is shared between the job's SO cards by meters. The date filter uses the date the store **sent** the chemicals.

## E2. Department: SO card cost
`GET /departments/:code/so-cards/:soCardId/chemical-cost`
Same response as part C3 (`soCard`, `totalValue`, `chemicals` with `qtySplit.text`, `byJob`), but only this department's jobs.
404 = this SO card never came to this department. Needs VIEW on the department.
Show it as a "Chemical Cost" button on the department's job / SO card rows.

## E3. Report screens
Department (only its own jobs):
- `GET /departments/:code/chemical-cost/jobs?dateFrom=&dateTo=&customerId=&page=1&limit=20`
- `GET /departments/:code/chemical-cost/so-cards?...same filters`

Chemical Store / admin (all departments; extra filter `departmentId`):
- `GET /stores/chemical/cost/jobs?dateFrom=&dateTo=&customerId=&departmentId=&page=1&limit=20`
- `GET /stores/chemical/cost/so-cards?...same filters`

Jobs report:
```json
{ "data": [ { "job": { "id": "uuid", "jobNo": 12, "jobDate": "2026-10-11", "status": "PROCESSING" },
    "soNos": [5, 6], "customers": ["AZ TEXTILES"], "departments": ["Dyeing"],
    "value": 300, "requests": 2, "jobNos": [12], "lastSentAt": "2026-10-17T10:00:00Z" } ],
  "total": 1, "page": 1, "limit": 20, "totalValue": 300 }
```
SO cards report:
```json
{ "data": [ { "soCard": { "id": "uuid", "cardNo": 5, "cardDate": "2026-10-11" }, "customer": { "id": "uuid", "name": "AZ TEXTILES" },
    "departments": ["Dyeing", "Printing"], "jobNos": [12, 15], "value": 150, "requests": 2, "lastSentAt": "..." } ],
  "total": 2, "page": 1, "limit": 20, "totalValue": 300 }
```
Screen (one screen, two tabs "By Job" / "By SO Card"):
- Filters on top: Date from / to (date pickers), Party (customer dropdown from `/customers`), Department dropdown (store screen only).
- Table By Job: Job#, Date, SO#s, Party, Department, Requests, Chemical Cost.
- Table By SO Card: SO#, Date, Party, Departments, Job#s, Requests, Chemical Cost.
- Footer: "Total: Rs 300" (`totalValue` = all rows, not only this page).
- Click a row: open the detail (part C2 job cost, or C3 / E2 SO card cost) to see each chemical in KG + G.
