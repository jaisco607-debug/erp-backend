# Attendance: frontend guide (chunk 6)

## 1. How it works
- **Punches** come in from an Excel file today and from the machine API later. Both end in the same store, so the screens do not care where a punch came from.
- A punch is only three things: the **Employee ID** (the `code` of the Employee Master, shown as `00593`), a **date** and a **time** (Pakistan clock). The machine's device and mode are optional.
- From the punches, the employee's **shift** and the **policy** of the employee's group, the server works out **a code for every day**:
  - `P` present, `L` late, `HD` half day, `A` absent, `R` rest day (weekly off day or a holiday), `AL` leave (set by HR for now).
  - The first punch of the shift's day is the "in", the last one the "out". A night shift belongs to the day it started.
  - Late minutes = minutes the "in" is after the shift start. Up to the policy's late limit: P. Up to the half-day limit: L. More: HD. No punch: A (R on a rest day).
  - **Overtime** = hours worked (out minus in) less the shift's duty hours, never below 0. On a rest day all the hours worked are overtime. Month-end it is shown in **days**: overtime hours divided by the duty hours (20 hours on an 8 hour shift = 2.5 days).
  - Only one punch (or two within an hour) = the day is **incomplete** (`incomplete: true`): coded from the "in", no overtime, for HR to complete.
- Re-importing the same file is safe: a punch already stored is skipped. Days are worked out again automatically after every import.
- A day nobody punched on (the machine was off, the file does not reach it) is **left empty**, not marked absent for everyone.
- HR can set any day by hand to **P, L, HD, A, R or AL** (for example leave, or a missed machine day). The code the machine had worked out is kept as `originalCode`, so the screen can show "was L, HR made it P". A hand-set day (`manual: true`) is kept through every AUTOMATIC recalculation. Only the **Recalculate** button gives it back to what the machine says.
- **Automatic recalculation.** The days are worked out again by themselves, with no button, when: a file is imported, a holiday is created / changed / deleted, a policy version is created / changed / deleted, a shift's times or duty hours change, an employee is created, approved (from a joining application), changes shift / group / joining date, leaves or comes back. Hand-set days are kept.
- **Rest days are filled in by themselves:** after an import, the whole month of the file up to today is worked out, so every Sunday (weekly off day) and holiday gets its `R` even if no file was uploaded for that date. A working day nobody punched on stays empty (no data), it is not marked absent.
- **A holiday:** nobody is absent on it. Whoever worked on it keeps code `R` and ALL the hours worked are overtime; no late or half-day is judged.
- Employee IDs: the ID on the machine / in the Excel must be the Employee ID of the Employee Master. A punch whose ID has no employee yet is kept as **unmapped** and is picked up the moment that employee is created (no re-import).

## 2. Access
Base URL `/api/v1/payroll/attendance`. Read: any payroll service. Import, correct, recalculate, undo, rename a device: service `PAYROLL_SALARY` with `FULL` (`403` otherwise). A record of another company is `404`.

## 3. The Excel upload (Attendance > Upload)
The frontend reads the sheet and sends rows as JSON (the server has no Excel reader).
1. Template columns: **Employee ID**, **Date**, **Time**; optional **Device**, **Mode**. Offer a downloadable sample.
2. Turn every row into `{ "employeeId": 593, "date": "2026-10-30", "time": "08:05" }` (optional `"device": "Boat Basin"`, `"mode": 8`). Send **dates as text** as the sheet shows them: `2026-10-30` or `30/10/2026` (day first), time as `08:05`, `08:05:30` or `8:05 PM`. One `punchedAt` (`"2026-10-30 08:05:30"`) can replace date + time. Do not send Excel serial numbers.
3. **At most 5000 rows per call.** A bigger file is sent in pieces of 5000 (one preview and one import per piece; add up the numbers).
4. **Preview first**, then Import.

| Call | What |
|---|---|
| `POST /punches/preview` body `{ rows }` | saves nothing. Returns `{ total, valid, invalid, invalidRows: [ { row, reason, data } ], duplicatesInFile, alreadyInSystem, toImport, employees, unknownIdCount, unknownIds: [ { employeeId, punches } ], devices, from, to }`. `row` is the 1-based position in the rows you sent |
| `POST /punches/import` body `{ rows, source: "EXCEL", fileName }` | 201 `{ batchId, total, inserted, duplicates, invalid, invalidRows, unknownIdCount, unknownIds, from, to, processed: { employees, days } }`. Good rows are saved even when some rows are refused |

Show the preview as: "X new punches for Y employees from `from` to `to`; Z already in the system; N rows refused (list with the reason); K unknown IDs (list)". Refused rows do not stop the import. Unknown IDs are imported and shown under Unmapped.

## 4. Summary screen (Attendance Summary)
`GET /overview?month=2026-10` (month optional, default this month):
```json
{ "month": "2026-10", "punches": 12008, "employees": 265, "deviceCount": 21, "today": 197, "unmappedPunches": 340, "unmappedIds": 293,
  "api": { "configured": false },
  "lastSync": { "id": "...", "source": "EXCEL", "fileName": "oct.xlsx", "totalRows": 440, "inserted": 0, "duplicates": 440, "invalid": 0, "fromDate": "2026-11-01", "toDate": "2026-11-02", "createdAt": "...", "by": "haris", "label": "File: 0 new punches, 440 duplicates, 0 refused" },
  "manualDays": 0, "devices": [ { "id": "...", "code": "Boat Basin", "name": "Boat Basin", "isActive": true, "punches": 432, "lastRecord": "2026-11-01 20:07", "missingDates": ["2026-10-14"] } ],
  "daily": [ { "date": "2026-10-31", "punches": 422, "employees": 260 } ], "firstDay": "2026-10-01", "lastDay": "2026-10-31" }
```
- Chips: `punches`, `employees`, `deviceCount`, `today`, `unmappedIds` (red).
- Devices table: name, month `punches`, `lastRecord`, `missingDates` (empty = tick). Rename or switch off a device: `PATCH /devices/:id` `{ name?, isActive? }`. `GET /devices` lists them all.
- Daily counts: click a date to load its details.
- **Details of a date:** `GET /punches?date=2026-10-30&page=&limit=` (also `from`, `to`, `employeeCode`, `deviceId`, `unmapped=true`; limit up to 1000, default 200). Rows: `{ id, time: "2026-10-30 08:05:00", employeeCode, employeeLabel, employee: { id, name } | null, device: { id, name } | null, mode, source, unmapped }`.
- **Unmapped:** `GET /unmapped?month=` returns `{ total, data: [ { employeeCode, employeeLabel, punches, firstSeen, lastSeen, devices } ] }`: the IDs HR must create as employees (Employee Master, `code` = that ID).
- **Fetch via API button:** show it disabled while `api.configured` is false. `POST /fetch` answers `422 API_NOT_CONFIGURED` ("upload the Excel file instead") until the machine API is connected.

## 5. Import history and undo
- `GET /batches?page=&limit=` returns `{ data: [ { id, source, fileName, totalRows, inserted, duplicates, invalid, fromDate, toDate, createdAt, by, isUndone, canUndo } ] }`.
- `DELETE /batches/:id` takes a wrong import back (its punches go, the days are worked out again, hand-set days stay): `{ id, removed }`. Ask for confirmation. `422 ALREADY_UNDONE` if done twice.

## 6. Month grid and totals
- `GET /days?month=2026-10&groupId=&departmentId=&designationId=&employeeId=&search=&closed=false|all&page=&limit=` (limit up to 500, default 100) returns `{ month, dates: ["2026-10-01", ...], page, limit, total, data: [ { employee, days, totals } ] }`:
  - `employee`: `{ id, code, label, name, group, department, shift: { code, dutyHours } | null, isClosed }`.
  - `days`: an object keyed by date, only for dates that have a result (a date with no key = no data yet): `{ code, originalCode, firstIn: "2026-10-01 08:05", lastOut: "2026-10-02 06:10", punches, workedMinutes, lateMinutes, overtimeMinutes, overtimeHours, incomplete, restDay, manual, note }`. `lastOut` can be on the next date for a night shift.
  - `totals`: `{ P, L, HD, A, R, AL, marked, workedMinutes, lateMinutes, overtimeMinutes, overtimeHours, overtimeDays, incompleteDays, manualDays }`.
  - Colour suggestion: P green, L amber, HD orange, A red, R grey, AL blue; a dot for `incomplete`; a pencil for `manual`.
- `GET /summary?...same filters` returns the month's totals per employee: the totals above plus `lateDeductionDays` (half a day for every `latesPerHalfDay` lates of the policy) and `payableDays` (P + L + R + AL + half of HD, less the late deduction). This is a preview: the payroll copies the policy when it is created. Use it for the Overtime tab (`overtimeDays`, `overtimeHours`).
- `GET /daily?date=2026-10-30&code=A` (Daily P/A/L) returns `{ date, counts: { P, L, HD, A, R, AL }, total, punches, noData, data: [ { employee, code, firstIn, lastOut, lateMinutes, overtimeMinutes, ... } ] }`. `noData: true` = nobody punched that day.

## 7. HR corrections and recalculation
- `PATCH /days/:employeeId/:date` body `{ code, overtimeMinutes?, note? }` (`code` one of P, L, HD, A, R, AL; `overtimeMinutes` 0 to 1440; note up to 300 characters). Returns `{ employeeId, date, day }`. `overtimeMinutes` not sent: P / L / HD / R keep the machine's overtime, A / AL get 0. Errors: `422 DATE_IN_FUTURE`, `BEFORE_JOINING`, `AFTER_LEAVING`, `404` unknown employee.
- `DELETE /days/:employeeId/:date` gives a hand-set day back to the machine (worked out again from the punches). `422 NOT_MANUAL` if the day was not set by hand.
- `POST /process` body `{ from, to, groupId?, employeeId?, keepManual? }` (up to 93 days) is the **Recalculate** button. By default it gives the days HR set by hand **back to what the machine says** (`keepManual: true` keeps them). Returns `{ employees, days, manualReset, from, to }`: `manualReset` is how many hand-set days went back. Errors: `422 RANGE_BACKWARDS`, `RANGE_TOO_LONG`. **Ask for confirmation** and show `manualDays` first (`GET /overview` has `manualDays` for the month, the grid `totals.manualDays` per employee): "N days set by HR will go back to the machine's answer".
- Policies, shifts, holidays and employees already recalculate the days by themselves (section 1), so Recalculate is only needed to undo HR's hand-set days or to redo a range by choice.
- Once the payroll of a month exists, the payroll will lock that month's attendance. That lock is not built yet.

## 8. Errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | no rows, more than 5000 rows, a bad month or date, an unknown field |
| `403` | not enough access (changing needs PAYROLL_SALARY FULL) |
| `404 NOT_FOUND` | unknown employee, device or import |
| `422 API_NOT_CONFIGURED` | `POST /fetch` while the machine API is not connected |
| `422 ALREADY_UNDONE`, `NOT_MANUAL`, `DATE_IN_FUTURE`, `BEFORE_JOINING`, `AFTER_LEAVING`, `RANGE_BACKWARDS`, `RANGE_TOO_LONG` | see above |

## 9. Build checklist
1. Payroll > Salary > **Attendance Summary**: month picker, chips, devices table, daily counts, details of the clicked date, Unmapped list, last import line, **Upload** and **Fetch via API** (disabled for now) buttons, **Daily P/A/L** and **Import history**.
2. **Upload**: read the sheet (Employee ID, Date, Time, optional Device and Mode), pieces of 5000 rows, preview, then import; show the refused rows with their reasons.
3. **Month grid** (employees down, dates across) with the colours, a click on a cell opens the correction form (code, overtime minutes, note) and a Reset button for hand-set days; a **Recalculate** button (`/process`).
4. **Overtime** tab from `/summary`: overtime hours and days per employee.
5. Test: import 593 / 594 rows (a night shift 20:00 to 06:00 included), see P / L / HD / R and the overtime; import the same file again (everything a duplicate); an unknown ID shows under Unmapped and disappears when the employee with that Employee ID is created; set AL by hand, recalculate, it stays; undo the import.
