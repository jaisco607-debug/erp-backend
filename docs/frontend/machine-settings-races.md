# Machine settings: two admins at the same moment (A3.3)

No new route, no new field. Only the answers of the existing routes become clear when two people act together.

## What the server does now
- **Add machines** (`POST /machine-settings/:code/machines`) from two screens at once: both work, each machine gets its own number (DYE-01, DYE-02, DYE-03, DYE-04), none twice.
- **Same prefix** (`PATCH /machine-settings/:code` with `prefix`) for two departments at once: one gets it, the other answers **422 `PREFIX_TAKEN`** ("The prefix ZZ is used by another department", `details.field = "prefix"`). Before, a 500 could come.
- **Machine name** (`PATCH /machine-settings/machines/:id` with `name`) taken at the same moment: **422 `NAME_TAKEN`** (`details.field = "name"`).
- **A machine exists already** when adding: **422 `MACHINE_EXISTS`** ("DYE-05 already exists: reload the list and add again").
- **Switch a machine off / delete it / switch the machines of a department off** while a job starts on it at the same moment: one after the other. If the job started first, the answer is the usual **422 `MACHINE_RUNNING`** / **`MACHINES_RUNNING`**; if the switch-off came first, the job cannot be assigned to that machine.
- **Two edits of the same machine run (meters) together** cannot give more meters than the job has (the job is locked first; this was already done in the earlier release).

## Frontend
1. Show these codes as messages next to the field (`details.field`), not as a red page error. On `MACHINE_EXISTS` reload the machine list.
2. Disable the Add / Switch off / Delete / Save button while the request runs.
3. After `MACHINE_RUNNING` reload the board: the machine is running a job.
