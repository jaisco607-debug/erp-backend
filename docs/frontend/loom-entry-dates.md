# Loom entry (K-ID) dates: no future start / end date (A1.2)

## What changed
- **Start date** of a loom entry (`POST /sizing/loom-beams`, `PATCH /sizing/loom-beams/:id`) and the **end date** of **cut-off** (`POST .../cut-off`) and **half-cut** (`POST .../half-cut`) cannot be a day that has not come yet.
  A later day answers **422 `FUTURE_DATE`**: `{ "error": { "code": "FUTURE_DATE", "message": "This date has not come yet; use today or an earlier day", "details": { "field": "startDate" } } }`. Show the message next to the field in `details.field` (`startDate` or `endDate`).
- Also the general date rule applies: at most 5 years back (`GET /api/v1/limits` -> `dates.min`); see `limits-and-dates.md`.
- **Moving the start date moves the production units.** The units of the loom entered on the days of the entry are linked to it (K-ID and meters show). When the start date is changed, the server links again: days from the new start date belong to the entry, days before it do not. The same entry reopens its units after you move the date back. Nothing to send: reload the entry and its production register after the change.

## Frontend
1. Start date picker and the end date of cut-off / half-cut: `max = today` (use `dates.today` from `GET /limits`, or `todayPK()`), `min = dates.min`.
2. Show `FUTURE_DATE` next to the date field.
3. After a start-date change, refresh the K-ID register and the production day sheet (the K-ID / meters of some days can appear or disappear).
