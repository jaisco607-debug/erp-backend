# Attendance Report and Punch Report (monthly) — Frontend Guide

Base URL `/api/v1/payroll`. Two reports with the **same screen shape**:
- **Attendance Report**: for every employee and date, the code (Present / Late / Half day / Absent / Rest day / Annual leave) with the **in and out time**.
- **Punch Report**: for every employee and date, **every punch exactly as it came** (from the Excel file or the machine). No in / out, no code.

Each has: a month sheet with **all employees** (rows = employees, columns = dates), filters, an Excel download, and, when a row is clicked, the **full month of that one employee** (one line per date) with details and its own Excel download.

Permission: any payroll service (VIEW is enough). Everything is scoped to the company in the token (another company's employee gives 404).

## Filters (same on both month sheets)
`GET ...?month=2026-10&groupId=&departmentId=&designationId=&employeeId=&search=&closed=false|all&page=1&limit=100`
- `month` is `YYYY-MM` (default: this month). Get the dropdown data from `GET /payroll/masters` (groups, departments, designations) and the employee dropdown from `GET /payroll/employees`.
- **Department wise** = `departmentId`. **Employee wise** = `employeeId` (a dropdown) or `search` (name, CNIC or employee ID).
- `closed=false` (default): employees who left before the month are hidden; `all` shows them.
- Paging: `page`, `limit` (max 1000). `total` is the number of employees matching, for the pager.
- Excel: add `&format=xlsx`. The file has **all** matching employees (page and limit are ignored).
- A wrong month (e.g. `2026-13`) gives 400.

---

## 1. Attendance Report

### 1a. All employees, one sheet
`GET /attendance/report?month=2026-10&...`
```
{
  month:"2026-10", monthLabel:"October 2026", page, limit, total,
  dates:[{ date:"2026-10-01", day:1, weekday:"Thu" }, ... one per day of the month],      // the table columns
  legend:[{code:"P",text:"Present"},{code:"L",text:"Late"},{code:"HD",text:"Half day"},{code:"A",text:"Absent"},{code:"R",text:"Rest day"},{code:"AL",text:"Annual leave"}],
  summary:{ employees, P, L, HD, A, R, AL },                                              // of the employees on this page
  data:[{
    sr, employee:{ id, code, label:"00593", name, group:{id,name}, department:{id,name}|null, shift, isClosed },
    days:[{ date, code:"P"|"L"|"HD"|"A"|"R"|"AL"|null, in:"08:05"|null, out:"18:00"|null, outNextDay:false,
            lateMinutes, overtimeMinutes, punches, incomplete, manual }],               // SAME ORDER AND LENGTH as `dates`
    totals:{ P, L, HD, A, R, AL, lateMinutes, overtimeMinutes, overtimeHours, workedMinutes }
  }]
}
```
- Show each cell as the code with the two times under it (for example **P** 08:05 – 18:00). Colour by code (Present green, Late amber, Half day orange, Absent red, Rest grey, Annual leave blue).
- `code: null` = no result for that date (the employee had not joined yet, or the day is after the last data). Show `-`.
- `outNextDay: true` = the out time is on the **next morning** (night shift): show for example `06:10 (+1)`.
- `incomplete: true` = only one punch that day (no out time): show a small warning dot. `manual: true` = HR changed the code by hand: show a small pencil.
- Freeze the first columns (ID, Name, Department) and scroll the dates sideways. Put the `totals` at the end of the row.
- Clicking a row opens the employee page (1b).

### 1b. One employee, the whole month
`GET /attendance/report/employees/:employeeId?month=2026-10` (`&format=xlsx` for Excel)
```
{
  month, monthLabel, employee:{ ...same as above, joiningDate, leavingDate }, legend:[...],
  data:[{ date:"2026-10-01", weekday:"Thu", status:"Present"|"Late"|"Half day"|"Absent"|"Rest day"|"Annual leave"|"No data"|"Not employed",
          code, in:"08:05", out:"18:00", outNextDay, worked:"9h 55m", workedMinutes, lateMinutes, overtime:"1h 55m"|null, overtimeMinutes,
          punches, restDay, incomplete, manual, originalCode, note, employed }],       // one line for EVERY date of the month
  totals:{ P, L, HD, A, R, AL, worked:"..h ..m", workedMinutes, lateMinutes, overtimeMinutes, overtimeHours, incompleteDays, manualDays }
}
```
- A table with one line per date: Date, Day, Status, In, Out, Worked, Late, Overtime, Punches, Note. A line with `manual: true` shows `originalCode` (what the machine had) next to the code.
- A header card with the employee name, ID, department, and the `totals` (P / L / HD / A / R / AL counts, hours).
- A **Punch record** button/tab on this page opens the same employee in the Punch Report (2b).
- 404 for an unknown employee; 422 `NOT_IN_MONTH` if he joined after that month.

---

## 2. Punch Report

### 2a. All employees, one sheet
`GET /attendance/punch-report?month=2026-10&...` (same filters; `&format=xlsx`)
```
{
  month, monthLabel, page, limit, total,
  dates:[{ date, day, weekday }, ...],
  summary:{ employees, punches },
  data:[{ sr, employee:{ id, code, label, name, group, department, ... },
          days:[{ date, times:["08:05:00","18:00:00"] }],        // same order and length as `dates`; times:[] when no punch
          totalPunches, daysWithPunches }]
}
```
- Each cell shows the times one under the other (all of the day's punches, with seconds). An empty cell = no punch.
- A punch belongs to the **calendar date it happened on** (a night shift's 06:10 morning punch is on the next date). This is a raw record: no codes, no in / out.
- Punches of an ID that has no employee yet are not here (they are on the "Unmapped IDs" list).
- Clicking a row opens 2b.

### 2b. One employee, the whole month
`GET /attendance/punch-report/employees/:employeeId?month=2026-10` (`&format=xlsx`)
```
{
  month, monthLabel, employee:{...},
  data:[{ date, weekday, count, punches:[{ id, time:"19:55:00", device:"Boat Basin"|null, mode:8|null, source:"EXCEL"|"API"|"MANUAL" }] }],   // every date of the month
  totals:{ punches, daysWithPunches }
}
```
- A list grouped by date; show the device and mode columns (`null` = `—`). Dates with `count: 0` can be greyed or hidden with an "Only days with punches" switch.

---

## Downloads need the token
Excel files cannot be opened by a plain link (no Authorization header). Fetch with the token and save the blob:
```js
const res = await fetch(url + '&format=xlsx', { headers: { Authorization: `Bearer ${token}` } });
const blob = await res.blob();
const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'attendance-report-2026-10.xlsx'; a.click();
```

## Notes
- The attendance report reads the **worked-out days** (after HR's corrections and the policy). When new punches are uploaded the days are already worked out by the upload.
- The Punch Report reads the **raw punches** and never changes with HR's corrections.
- Not built: a status filter ("only absent employees"), a PDF version, a printable A3 layout.
