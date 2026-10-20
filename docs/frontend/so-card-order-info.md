# SO Card: order details + work instructions (small update)
Run `npm run db:migrate` on the backend first.

## Backend / database changes (migration 20261015000004)
| Table | New column | Meaning |
|---|---|---|
| `so_cards` | `deliveryDate` (date) | when the party wants the order |
| `so_cards` | `article` (text, max 150) | article / style, e.g. "BEDSHEET 90x100" |
| `so_cards` | `instructions` (text, max 1000) | special instructions for the whole order |
| `jobs` | `instructions` (text, max 1000) | what the receiving department must do with this cloth |

All four are OPTIONAL. Nothing else changed.

## 1. SO card form (create and edit)
Add three fields under Description:
- **Delivery date**: a date picker. Send `deliveryDate` as "YYYY-MM-DD", or `null` to clear it.
- **Article / Style**: a text input. Send `article`.
- **Instructions**: a text area. Send `instructions`.

POST `/so-cards` and PATCH `/so-cards/:id` accept them:
```json
{ "cardDate": "2026-10-15", "deliveryDate": "2026-10-30", "article": "BEDSHEET 90x100", "instructions": "Soft finish, no shade variation",
  "lots": [ { "greyLotId": "…", "thaanNos": [1, 3] } ] }
```
Edit follows the same rule as other card fields: it is not allowed after the card is confirmed (`CARD_CONFIRMED`).

## 2. SO card detail / print / list
GET `/so-cards` and GET `/so-cards/:id` now return `deliveryDate`, `article` and `instructions`.
- On the card view and print, show them in the header next to the party.
- In the list, add a "Delivery" column (`deliveryDate`). You may highlight it in red when the date has passed.

## 3. Work instructions when sending
On the **Send** modal (send-many, single send, and the "send straight away" department dropdown on the card form), add a text area **"Work instructions"**.
- POST `/so-cards/send-many`: `{ "soCardIds": [...], "departmentId": "…", "workInstructions": "Dye black, shade 12" }`
- POST `/so-cards/:id/send`: `{ "departmentId": "…", "workInstructions": "…" }`
- POST `/so-cards` or PATCH `/so-cards/:id` with `departmentId`: also add `"workInstructions": "…"`.
- Department to department send (POST `/departments/CODE/send`): the field is called `"instructions"`.

The job then has `instructions`. Show it on the receiving department's incoming list (an info icon or a line under the row) and on the job detail. The SO-wise rows (`view=so`) carry it too.
The sender can change it while the job is still PENDING: PATCH `/jobs/:id` with `{ "instructions": "…" }`.
