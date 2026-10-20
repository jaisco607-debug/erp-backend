# CHEMICAL REQUEST part C: Chemical cost per Job and per SO card (frontend guide)

Last small step. Read-only screens / panels. No new tables: it is calculated from sent requests.

## C1. How it is calculated
- Only requests that left the store count (In-Way + Delivered). Cost = sent qty x store average rate at send time.
- Request for one SO card -> all its cost goes to that SO card.
- Request for the "whole job" -> shared between the job's SO cards by their meters in that job.
  Example: Job 12 has SO 5 (6000 m) and SO 6 (4000 m). A whole-job request of Rs 250 -> SO 5 gets 150 (60%), SO 6 gets 100 (40%).
- Quantities always come with `qtySplit.text` ("1 KG 500 G"). Never show 1.5 KG.

## C2. Job cost
Department: `GET /departments/:code/jobs/:jobId/chemical-cost`
Chemical Store: `GET /stores/chemical/cost/jobs/:jobId`
```json
{ "job": { "id": "uuid", "jobNo": 12 },
  "totalValue": 300,
  "chemicals": [ { "item": { "label": "COTTON COLOUR (REACTIVE DYES) / RED", "unit": "KG" },
      "qty": 3, "qtySplit": { "text": "3 KG" }, "value": 300, "avgRate": 100 } ],
  "requests": [ { "reqNo": 1, "department": { "name": "Dyeing" }, "status": "DELIVERED", "sentAt": "...", "soCardId": null, "totalValue": 250 } ] }
```
Show on the job detail: a "Chemicals" tab: table Chemical / Qty (`qtySplit.text`) / Value, total at the bottom, and the request list (Req#, date, value).

## C3. SO card cost
`GET /stores/chemical/cost/so-cards/:soCardId`
```json
{ "soCard": { "id": "uuid", "cardNo": 5 },
  "totalValue": 150,
  "chemicals": [ { "item": { "label": "... / RED" }, "qty": 1.5, "qtySplit": { "text": "1 KG 500 G" }, "value": 150, "avgRate": 100 } ],
  "byJob": [ { "job": { "jobNo": 12 }, "department": { "name": "Dyeing" }, "sharePercent": 60, "value": 150, "requests": 2 } ] }
```
Show on the SO card detail: a "Chemical Cost" panel: total, chemicals table, and "by job" table (Job#, Department, Share %, Value).
Needs VIEW on Chemical Store.
