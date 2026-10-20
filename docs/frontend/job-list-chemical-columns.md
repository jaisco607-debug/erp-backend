# Job list: CHEMICAL and COST/MTR columns now come from the backend

Small change. No database change (no migration).

## What changed in the backend
The department job lists now send the chemical numbers in every row, so the frontend does NOT need one extra call per row any more.
Lists: `GET /departments/:code/incoming`, `/sent`, `/rejected` (and `/jobs`), both `view=job` and `view=so`.

New / filled fields in each row:
| field | meaning |
|---|---|
| `chemicalCount` | how many different chemicals the store sent for this row (In-Way + Received, minus returns) |
| `chemicalAmount` | their value in Rs (after returns) |
| `costPerMeter` | `chemicalAmount` / meters of the row (4 decimals) |
| `chemicalRequests` | how many sent requests make up this cost |
| `pendingChemicalRequests` | requests of this job still waiting at the store (Pending / Accepted), NOT in the cost yet |

- Job Wise row: numbers of the whole job.
- SO Wise row: only that SO card's part (a request for one SO card goes to it; a "whole job" request is shared by meters). Same rule as the cost screens.

Example row:
```json
{ "jobNo": 10, "totalMeters": 20, "chemicalCount": 2, "chemicalAmount": 82004, "costPerMeter": 4100.2,
  "chemicalRequests": 1, "pendingChemicalRequests": 0 }
```

## What to change in the frontend
1. Remove the extra per-row cost calls (the 5-at-a-time loader and the "…" placeholder).
2. CHEMICAL column: `chemicalCount` 0 -> white "0" button; more -> gold "N chem" button. Tooltip: "N chemical(s) · Rs chemicalAmount". If `pendingChemicalRequests` > 0 add a small "+N pending" in the tooltip. Click still opens the detail (job cost API).
3. COST/MTR column: show `costPerMeter` (e.g. "Rs 4,100.20").
4. Refresh button simply reloads the list.
