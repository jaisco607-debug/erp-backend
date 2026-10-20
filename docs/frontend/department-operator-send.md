# DEPARTMENTS: operator + process date, send window, colour only in Dyeing (+ UI advice)

## 1. What changed in the backend and database (migration 20261019000001)
- New column `jobs.processDate` (date): the day the operator processed the cloth.
- Every change is in the audit log.

## 2. Operator name + process date
- Each job row (Job Wise and SO Wise) has these fields: `operatorName`, `processDate`, `operatorSetBy`, `operatorSetAt` and **`canEditOperator`**.
- `canEditOperator` is true after Accept, until the cloth is sent on. After sending, show the values read-only.
- Save one or both fields:
  `PUT /departments/:code/jobs/:jobId/operator` with `{ "operatorName": "Aslam", "processDate": "2026-10-18" }`
- After sending on, you get the error `ALREADY_SENT_ON`.

## 3. Send window: only the row it was opened from is ticked
- Open the window from a row with:
  - `GET /departments/:code/send-form?jobId=<jobId>` (from a Job Wise row), or
  - `?soCardId=<soCardId>` (from an SO Wise row), or both.
- Every row in `rows` now has **`selected`** (true only for the job / SO card the window was opened from) and `colour` (the cloth's colour).
- Tick only the rows where `selected` is true. The others stay visible but unticked, so the user can add more if they want.
- When the window is opened from the top "Send" button (no jobId / soCardId), nothing is ticked.

## 4. Colour only in Dyeing
- `send-form` returns **`canSetColour`**, which is true only in Dyeing.
- When it is false, do not show a colour dropdown. Show the colour as text (`rows[].colour`, e.g. "BLACK", or "Not dyed").
- The backend refuses a colour from other departments with the error `COLOUR_ONLY_DYEING` (on send and on edit).

## 5. UI advice (keep it simple for operators)
1. **One row, one action button.** Show only the next step as a big button:
   - In-Way: **Receive**
   - Queue: **Accept**
   - Pending / Processing: **Complete**
   - Complete: **Send**
   Put Reject and the other actions in a small "..." menu.
2. **Operator box on the row.** Show the operator name and date in a small cell like "Aslam · 18 Oct". Clicking it opens a 2-field popup:
   - Name: a text box with the last used names as suggestions.
   - Date: a date picker, default today.
   Save with one button.
3. **Send window as a short form:**
   - Department dropdown: big buttons or a dropdown with the most used departments first.
   - Rows: already ticked from where it was opened, with meters and colour visible.
   - Colour: dropdown in Dyeing only, text everywhere else.
   - Sent through / Remarks / Instructions: collapsed under "More" (most of the time not needed).
   - One **Send** button. Show "Job# 45 sent to Finishing" afterwards.
4. **Colours as badges.** Show status as coloured badges: In-Way grey, Queue amber, Pending blue, Processing purple, Complete green, Rejected red.
5. **Less typing.** Use dropdowns, toggles and date pickers. Default the dates to today. Remember the last department chosen.
6. **Clear errors.** Show the backend `message` as a toast. It is written in plain English.
