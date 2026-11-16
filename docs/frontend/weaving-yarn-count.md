# Weaving — Yarn Count master — Frontend Guide

First screen of the new **Weaving** module: **Weaving > Masters > Yarn Count**. A yarn count is a text such as `22|s`, `22|1`, `22|s Cotton`, `22|s Polister Cotton`. Each company keeps its own list.

## Access (new menu tab + service)
- New menu group (tab) **`WEAVING`** and one service **`WEAVING_MASTERS`** ("Weaving Masters"), kind `MODULE`. It appears in `/auth/me` `services` like every other service (`menuGroup: "WEAVING"`).
- The super admin gives it to a company (Companies > Services, or Services > give to companies). The client admin gives it to users with access `VIEW` (read only) or `FULL` (add / edit / delete) in Users.
- Show the Weaving tab only when the user has `WEAVING_MASTERS`. Hide the Add / Edit / Delete buttons for `VIEW`.
- The Services screen of the super admin: `menuGroup` can now be `WEAVING` (add it to the tab list / filter / group names). `WEAVING_MASTERS` is built in: it cannot be deleted.

## API (all `/api/v1/weaving/yarn-counts`, signed in, company people only)
| Call | Needs | What |
|---|---|---|
| `GET /yarn-counts?page=&limit=&search=&isActive=` | VIEW | list, ordered by `code`. `limit` up to 500 (default 100) so a dropdown can take all. Answer `{ data, page, limit, total }`. `search` finds part of the name, any letter case. |
| `GET /yarn-counts/:id` | VIEW | one |
| `POST /yarn-counts` `{ "name": "22\|s Cotton", "isActive": true? }` | FULL | add, answer 201 |
| `PATCH /yarn-counts/:id` `{ "name"?, "isActive"? }` | FULL | change (at least one field) |
| `DELETE /yarn-counts/:id` | FULL | delete, answer `{ deleted: true, id }` |

A row: `{ id, code, name, isActive, createdAt }`
- `id` is the unique id (uuid) — use it in later forms (yarn inward etc.).
- `code` is the running number of the company: 1, 2, 3 ... Show it as the **ID** column. A deleted count's number is never given again.
- `name` is saved **as typed** (outer spaces cut, repeated spaces squeezed to one). Capital / small letters are kept as the user typed them.

## Duplicates
The name must be unique inside the company **ignoring capital / small letters and extra spaces**: `22|s cotton`, `22|s Cotton`, `22|S  COTTON` are the same count.
- Add or change into an existing name: **422** `DUPLICATE_ENTRY`, `message: "Duplicate entry: yarn count \"22|s Cotton\" already exists"`, `details: { field: "name" }`. Show the message under the Name field.
- Saving a count with its own name again (or only changing the letter case of its own name) is fine.
- A deleted count frees its name (it can be added again, with a new `code`).
- The server also guards two people saving at the same moment: one gets 201, the other 422 `DUPLICATE_ENTRY`.
- You may also check while typing with `GET /yarn-counts?search=<text>` and compare in lower case, but the server is the final judge.

## Other errors
- 400 `VALIDATION_FAILED`: name empty or longer than 80 characters.
- 403: the user has no `WEAVING_MASTERS`, or only `VIEW` for a change.
- 404 `NOT_FOUND`: unknown id or an id of another company.

## Screen suggestion
Table: ID (`code`), Yarn Count (`name`), Active switch (`PATCH { isActive }`), Edit, Delete. Add form: one Name box + Save. Search box on top. Inactive counts stay in the list; dropdowns of later forms should call `?isActive=true`.

## Database
Migration `20261201000001-weaving-yarn-counts.js` (table `yarn_counts`, service `WEAVING_MASTERS`, menu group `WEAVING`). Run `npm run db:migrate`.
