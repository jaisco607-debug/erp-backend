# Audit fixes: what the frontend must know (2026-10-21)

Written for: the frontend developer. Almost everything below is a backend-only fix. Where the screen has to react, it is marked **FRONTEND**.
All errors keep the usual shape `{ error: { code, message, details? } }`; show `message` to the user.

## 1. Packing list (packing-lists endpoints)

| Change | Status / code | FRONTEND |
|---|---|---|
| A line cannot hold more meters of a category than Folding sent for that thaan (all lists together). | 422 `MORE_THAN_FOLDING_SENT`, `details.line` = 1-based line number | Show the message; the packing form already pre-fills `suggestedLines`, so normal use never hits it. |
| A list that has a gate pass cannot be reopened or deleted (the cloth has left). | 422 `HAS_GATE_PASS` on `POST .../reopen` and `DELETE .../packing-lists/:id` | Hide / disable Reopen and Delete when the list has a gate pass (`GET /departments/PACKING/packing-lists/:id/gate-pass` returns `saved: true`). |
| A gate pass cannot be dated before its packing list. | 422 `PASS_BEFORE_LIST` | Default the date field to today; show the message. |
| Money: each line amount = meters x rate rounded to the paisa, and the grade / list totals are the **sum of the line amounts**. | none | The totals can now differ by a paisa from `total meters x rate`; always print the totals the API returns, never recompute them. |

## 2. Dates

- A date that does not exist (`2026-02-30`, month 13) is now **400** with `message: "this is not a real date"` (was 500) in every body field and every `dateFrom` / `dateTo` filter.
- Default dates (job date, list date, gate pass date, return date, adjustment date ...) are now the **Pakistan day** (Asia/Karachi), not the UTC day. Day filters (`dateFrom` / `dateTo`) also use the Pakistan day.
- An SO card cannot be dated before the arrival date of its lots: 422 `CARD_BEFORE_LOT`.
- A typed job date cannot be before its SO card: 422 `JOB_BEFORE_CARD`.
- **FRONTEND:** send dates as `YYYY-MM-DD`; when the user leaves a date empty send nothing (the server fills today).

## 3. Jobs and SO cards

- A job on which chemicals were already requested cannot be rejected: 422 `CANNOT_REJECT`. **FRONTEND:** hide the Reject button on a job that has chemical requests (`chemicalRequests > 0` in the job row).
- `GET /so-cards`, `GET /so-cards/:id`: `currentDepartment` and `deliveryText` now follow the cloth ("Delivered to Folding"), not only the first department. `status` keeps its meaning (NEW / SENT / IN_DEPARTMENT) and still locks editing. No change needed.
- `POST /so-cards/:id/accept` on a card that was sent as a job now answers 422 `ACCEPT_ON_JOB` (was 500). Departments accept on the **job** (`PUT /departments/:code/jobs/:id/status`). **FRONTEND:** do not call the SO card accept for cards that came from the job flow. `GET /so-cards/incoming` lists only cards that really wait for the old accept.
- `GET /jobs/so-card/:id` (the road of an SO card): an employee now gets 403 unless one of their departments (or the SO card desk / Grey Store) had the card. Client admins see everything.
- Packing screens: `previousChemicalAmount`, `totalChemicalAmount`, `costPerMeter` are now correct when Folding sent the cloth in two parts (they used to show the cost twice). No change needed.

## 4. Stores and lots

- The chemical store cannot send more than the department asked for on a line: 422 `MORE_THAN_REQUESTED` (`details.lines`). Sending less is still fine. **FRONTEND:** cap the send quantity input at the requested quantity.
- A grey lot made of thaans cannot be edited into a plain total: `PATCH /grey-lots/:id` with `inwardMeters` / `inwardYards` / `pieces` but no `thaans` -> 422 `LOT_HAS_THAANS`. **FRONTEND:** when editing such a lot, send the thaans list again.
- Too-big numbers (quantity x rate beyond the column) answer 400 `NUMBER_TOO_BIG` (was 500). Show the message ("check the number of zeros").

## 5. Rounding

Half a paisa now always rounds **up** (0.29 kg x Rs 0.5 = Rs 0.15). Amounts in old records are unchanged. No frontend change.
