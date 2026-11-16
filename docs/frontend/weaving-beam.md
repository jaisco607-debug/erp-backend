# Weaving — Beam master — Frontend Guide

**Weaving > Masters > Beam.** A form to **add, change and delete beams**. (Every loom takes 2 beams; the beam is sized, outsourced for now, and put on a loom. The beam **stock** — empty / full / at loom — and the **sizing** come in the next steps on top of this master.)

All calls are under `/api/v1/weaving/beams`, service `WEAVING_MASTERS` (`VIEW` reads, `FULL` adds / changes / deletes), same as the other weaving masters.

## The form
A beam has:
| Field | |
|---|---|
| **Beam no** (`beamNo`) | the beam's number. **Optional**: leave it out and the server gives the next free number. Whole number >= 1, **unique** among the company's beams. |
| **Name** (`name`) | typed by the user, 1 to 80 characters (extra spaces are squeezed). Required. Two beams may have the same name; the number is what identifies a beam. |
| **Date** (`beamDate`) | `YYYY-MM-DD`; **default today** when left out. |
| **Active** (`isActive`) | switch, default on. |

To open the "New beam" form call **`GET /beams/next`** → `{ "beamNo": 7, "date": "2026-11-18" }` and prefill the number and the date (the user may change both). Sending the prefilled number is fine; if somebody else takes it meanwhile the save answers 422 `BEAM_NO_TAKEN` — ask for the next number again.

## API
| Call | Needs | |
|---|---|---|
| `GET /beams/next` | VIEW | the next free number and today's date |
| `GET /beams?page=&limit=&search=&isActive=&dateFrom=&dateTo=` | VIEW | the list ordered by beam no. `limit` up to 500 (default 100): use it for dropdowns. `search` finds part of the name or the exact beam no. |
| `GET /beams/:id` | VIEW | one beam |
| `POST /beams` `{ beamNo?, name, beamDate?, isActive? }` | FULL | add, 201 |
| `PATCH /beams/:id` any of `beamNo, name, beamDate, isActive` | FULL | change (at least one field) |
| `DELETE /beams/:id` | FULL | delete → `{ deleted: true, id }` |

A beam: `{ id, beamNo, beamLabel: "00007", name, beamDate, isActive, createdAt }`. The list answers `{ data, page, limit, total }`.

## Rules and errors
- 422 `BEAM_NO_TAKEN` (`details: { field: "beamNo" }`): the number is used by another beam. A beam may keep its own number on an edit.
- A **deleted** beam is hidden from the lists and dropdowns (kept in the database for the records that will use it later). Its number can be typed again, but the automatic number never goes back.
- 400 `VALIDATION_FAILED`: no name / empty name / more than 80 characters, `beamNo` < 1, bad date, nothing to change on a `PATCH`.
- 403 no `WEAVING_MASTERS` or `VIEW` only for a change. 404 unknown beam / another company's. Each company has its own beams and numbering.

## Screen suggestion
Table: **Beam no** (`beamLabel`), **Name**, **Date**, Active switch (`PATCH { isActive }`), Edit, Delete. Filters: search box, date range, active. "New beam": Beam no (prefilled), Name, Date (prefilled today). Switched-off beams stay in the list; the dropdowns of later screens should call `?isActive=true`.

## Database
Migration `20261209000001-weaving-beams.js` (`yarn_beams`). Run `npm run db:migrate`.
