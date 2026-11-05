# Send cloth back to the SO Card section — Frontend Guide

## What it is
An SO card is made and sent to a department (Dyeing, Singeing ...). Until now the receiving department could only Receive / Accept it, and a job that came **straight from an SO card could not be rejected**. Now the receiving department has a new action: **Return to SO Card**.

The cloth goes back to the SO Card section as if it had never been sent: the meters become free again at the SO Card desk, the SO card is "not sent" again (it can be edited, or sent to **any** department again). Everything else is unchanged: sending from one department to another, Receive, Accept, Reject (for cloth that came from another department) work as before.

Two SO cards sent together in one job can be returned **both**, **only one**, or **none**.

## Where the button is
On the receiving department's screens (incoming jobs list, the job page): a **Return to SO Card** button.
- Show it only when the job JSON says `canReturnToSoCard: true`. That is: the cloth came straight from an SO card (not from another department) and the job is still **In-Way, Queue or Pending** (not processing yet). It is the counterpart of Reject, so `canReject` is `false` for these jobs and `canReturnToSoCard` is `true`; for jobs that came from another department it is the other way round.
- Needs **FULL** access to the receiving department (the same as Receive / Accept / Reject). Others get 403.

## 1. Return a job (all of it, or some of its SO cards)
`POST /api/v1/departments/:code/jobs/:jobId/return-to-so-card`

Body (send **one** of these three; `reason` is optional, max 300):
```json
{ "all": true, "reason": "Wrong department" }                                    // the whole job
{ "soCardIds": ["<soCardId>", "<soCardId>"], "reason": "..." }                   // only these SO cards of the job
{ "jobItemIds": ["<job item id>", ...] }                                         // only these rows of the job
```
A job holds the SO cards in `job.items[]` (`items[].soCard.id`, `items[].id`). On the job page show a checkbox for every SO card (row) and a **Return to SO Card** button with an optional reason box. Nothing ticked = nothing to send (the button is disabled); the user can also simply not press it and Accept the job as usual.

## 2. Return rows of several jobs at once
`POST /api/v1/departments/:code/return-to-so-card` with `{ "jobItemIds": ["...", "..."], "reason": "..." }`
Use this from the incoming list when the user ticks rows of different jobs. Every row must belong to a job of this department.

## 3. The answer (both calls)
```
{
  returned: [ { jobId, jobNo, returnedJobId, returnedJobNo, whole: true|false, meters, rows } ],
  soCards:  [ { id, cardNo, cardLabel, status: "NEW"|"SENT", backAtSoCard: true|false } ],
  jobs:     [ <job JSON>, ... ]       // the jobs after the change
}
```
- `whole: true`: the whole job was returned. The job itself is now marked returned (`jobs[0]`).
- `whole: false`: only some rows were returned. They moved to a **new job of their own with a new Job#** (`returnedJobNo`) which is the returned one (`returnedFromJobId` = the original job). The original job stays with the rest of the SO cards, its `totalMeters` is smaller, and it goes on normally. `jobs` has the original first, then the returned job.
- `soCards[].backAtSoCard`: `true` when all the cloth of that SO card is back, then its `status` is `NEW` ("Not sent to any department yet"); the card can be edited, cancelled or sent again.
- Show a message like "SO 4740 returned to the SO Card section" (and for a partial return: "Job# 51 created for the returned part").

## 4. How a returned job looks
The returned job (in `jobs` and in every list) has:
```
status: "REJECTED", statusText: "Returned to SO Card",
returnedToSoCard: true, returnReason, returnedAt, returnedBy: {id, name}, returnedFromJobId,
canReturnToSoCard: false, canReject: false, canUndoReject: false,
isRejected: false, rejectReason: null     // it is NOT a rejection: do not show the rejection texts or the sender's "answer" buttons
```
- Show **Returned to SO Card** (any colour you like, e.g. grey) instead of "Rejected", with the reason and who/when.
- It leaves the department's working list. `GET /departments/:code/incoming` (default `show=active`) no longer has it; `?show=sent` lists it.
- It is final: it cannot be taken back with the status dropdown (`PUT .../status` gives 422 `JOB_RETURNED`). The SO Card section sends the cloth again as a new job.
- The SO Card section's sent list (`GET /api/v1/jobs?side=out`) shows it with the same `statusText`.

## 5. At the SO Card section
- `GET /api/v1/jobs/form-data` (the "send" screen of the SO Card desk) lists the returned cloth again, ready to be ticked and sent to any department.
- The SO card (`GET /so-cards/:id`) is `status: "NEW"` with `deliveryText: "Not sent to any department yet"` once all its cloth is back. If only one of two lots came back, the card stays `SENT` for the part still with the department.

## Errors (HTTP 422 unless noted)
| Code | When |
|---|---|
| `NOT_FROM_SO_CARD` | the job came from another department: use Reject instead |
| `CANNOT_RETURN` | the job is already Processing / Complete / Rejected / returned, or chemicals were requested for it |
| `JOB_WRONG_DEPARTMENT` | the job was not sent to this department |
| `NOT_IN_JOB` | an SO card or row is not in this job |
| `ROWS_REQUIRED` | no row matched |
| `UNKNOWN_ROWS` | a row id does not exist |
| `JOB_RETURNED` | status change on a returned job |
| 400 | the body has none of `all` / `soCardIds` / `jobItemIds`, or more than one of them |
| 403 | no FULL access to the department |

## Not changed
Sending from department to department, Receive, Accept, Reject (and the sender's accept / dispute answer), Folding and Packing, chemical requests. Only cloth that came **straight from an SO card** can be returned; cloth that came from another department is rejected as before.

## Database
Migration `20261124000001-job-return-to-so-card.js` (columns on `jobs`: `returnedToSoCard`, `returnReason`, `returnedAt`, `returnedById`, `returnedFromJobId`). Run `npm run db:migrate`.
