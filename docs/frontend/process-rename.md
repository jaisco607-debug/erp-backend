# Rename an assigned process (per company) — Frontend Guide

The client admin can now rename the processes the super admin gave the company (Settings → Processes → "Given by the super admin"). The new name belongs to **this company only**; the shared process and other companies are not touched.

## API
`PATCH /api/v1/processes/:id` on an assigned process now accepts `name` (and/or `isActive`):
```json
{ "name": "Dyeing Unit 1" }
```
- `name`: trimmed, 1–120 characters (400 otherwise).
- Must be unique in the company, own and assigned processes together, case-insensitive: 422 `PROCESS_NAME_TAKEN`. The same name again = 200, nothing changes.
- `code`, `tracksColour`, `sortOrder` may be sent **unchanged**. A changed `tracksColour` / `sortOrder` gives 422 `PROCESS_NOT_EDITABLE` (`details.editable: ["isActive","name"]`); a changed `code` gives 400.
- Sending the original name back removes the rename.
- Response: the same process object as before (`name` = the company's name).
- Still client admin only; 403 `PROCESS_MANAGEMENT_OFF` when the module is off.

`GET /api/v1/processes` → each `assigned[]` item has `name` (the company's name) and the new `originalName` (the super admin's name; show it as a hint or for a "Reset" button, which is just `PATCH { name: originalName }`).

## Where the new name shows
Everywhere this company sees the process, with no change on your side: `/auth/me` services (menu, department pages, user access), SO card / job send-to-department lists, job screens, SO card current department, reports (job, SO card, ledgers, chemical and store reports) and chemical requests. The `code` is unchanged: keep using `code` for routes (`/departments/DYEING/...`).

## Notes
- If the super admin removes the process from the company, the rename is deleted with it; if it is given again it starts with the original name.
- Usage counts, user count and `canDelete` are unchanged.

## Database
Migration `20261130000001-company-process-display-name.js` (`company_services.displayName` and the SQL function `svc_name`). Run `npm run db:migrate`.
