# COLOURS: who can see, add and give a colour (Dyeing employee fix, 2026-10-20)

## 1. The rule (owner)
**Only the Dyeing department gives the cloth its colour.** Every other department only **shows** the colour the cloth already has (it never picks or creates one). The colour list is kept by the SO card desk and used by Dyeing.

## 2. What was wrong
`GET /v1/colours` and `POST /v1/colours` needed the **SO Card** service. A Dyeing employee who only has the **Dyeing** service got `403 "You do not have this service"` on both, so the colour picker could not open, a new colour could not be added, and the colour names could not be looked up. The client admin (who has every service) never saw the problem. Giving the colour to the job itself (`PUT /v1/departments/DYEING/jobs/:jobId/colour`) always worked with the Dyeing service.

## 3. What the backend does now (nothing to change in the calls)
| Call | Who may use it |
|---|---|
| `GET /v1/colours`, `GET /v1/colours/:id` | **Dyeing** (VIEW or FULL) **or** SO Card (VIEW or FULL) **or** the client admin |
| `POST /v1/colours` `{ "name": "Navy" }` → 201 | **Dyeing FULL** **or** SO Card FULL **or** the client admin. VIEW only → `403 "You can only view this service"` |
| `PATCH /v1/colours/:id`, `DELETE /v1/colours/:id` | SO Card FULL (or the client admin), as before. A Dyeing employee cannot rename or delete a colour |
| `PUT /v1/departments/DYEING/jobs/:jobId/colour` `{ "colourId", "soCardId"? }` | unchanged: FULL on Dyeing |

- An employee with **only Singeing / Finishing / Folding / Packing / ...** (any department other than Dyeing, with no SO Card service) still gets `403 "You do not have this service"` on `/v1/colours`. They do not need the list: the colour comes inside the job data (section 4).
- Colours stay **inside the company**: a user never sees another company's colours.
- A Dyeing employee does **not** get the rest of the SO Card section (`/v1/so-cards ...` still answers 403). Only the colour list was opened.
- Note for the person who asked for "any department with `tracksColour = true`": **do not** use `tracksColour` for this. It is `true` for almost every department (Singeing, Finishing, Printing ...), so it would let all of them create colours. The backend uses the rule "colour is given by Dyeing" instead.

## 4. "The colour I gave as client admin does not show for the Dyeing employee"
The backend already sends the colour to the Dyeing employee inside the job data, whoever set it. Where it comes (all work for an employee with only the Dyeing service):
- `GET /v1/departments/DYEING/incoming` and `GET /v1/departments/DYEING/jobs/:jobId` (and the sent / rejected lists): on every job `colour` (`{ id, name }` or `null` when the SO cards of the job have different colours), `colours` (list of names) and on every item `items[].colour` (`{ id, name }`).
- `GET /v1/departments/DYEING/send-form`: `colours` (the dropdown list).
- Later departments get the same colour (it travels with the cloth).

The reason it did not show was the 403 above: if your screen finds the name by looking up `colourId` in the `GET /v1/colours` list, that list was empty for the employee. Now it is filled.

**Frontend steps:**
1. **Show the colour from the job data**, not from a lookup: use `job.colour.name`, `job.colours` and `items[].colour.name`. Do not call `/v1/colours` just to translate an id into a name.
2. Call `GET /v1/colours` only for the **picker** (the Dyeing screens where someone chooses or adds a colour). Show the picker only when the job has `canSetColour: true` (only Dyeing, and only after Accept).
3. In the picker, "Add new colour" (type a name, `POST /v1/colours`) must be shown for a Dyeing employee with **FULL** access and hidden or disabled with VIEW only (the API answers 403 "You can only view this service").
4. After saving a colour (`PUT .../colour`), take the colour from the answer (the full job comes back with `colour` and `items[].colour`) and refresh the list.
5. Route guard / menu: the Dyeing screens need the **Dyeing** service only. Do not require the SO Card service for the colour picker.
6. If a Dyeing employee still sees "You do not have this service" somewhere, open the browser Network tab and send the URL of the request that answers 403: it tells which service that screen still asks for.

## 5. Where the code is (backend)
- `src/routes/greyRoutes.js` (the colour routes), new middleware `src/middlewares/requireAnyService.js` (passes when the person has any of several services), new `src/utils/colourDepartments.js` (the list of departments that give colours: Dyeing).
- Tests: `tests/colours.test.js` (Dyeing FULL / VIEW, SO Card, Singeing, no service, client admin, another company, and "the colour of the client admin shows to the Dyeing employee").
