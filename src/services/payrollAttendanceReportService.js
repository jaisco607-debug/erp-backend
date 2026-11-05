// Attendance reports of a month (Payroll > Reports): two sheets, each for ALL employees of the month on one screen, and the full month of ONE employee when a row is clicked.
//   Attendance Report  per employee and day: P / L / HD / A / R / AL with the in and out time (what the payroll works from, after HR's corrections).
//   Punch Report       per employee and day: every punch exactly as it came from the Excel file or the machine (no in / out, no code).
// Both take the same filters (group, department, designation, one employee, search) and can be downloaded as Excel.
const ExcelJS = require('exceljs');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const attendance = require('./payrollAttendanceService');

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const pad5 = (n) => String(n).padStart(5, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (ymd) => WEEK[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const LEGEND = [['P', 'Present'], ['L', 'Late'], ['HD', 'Half day'], ['A', 'Absent'], ['R', 'Rest day'], ['AL', 'Annual leave']];
const TEXT = Object.fromEntries(LEGEND);
const ALL = 5000; // an Excel file holds every employee the filters match

const hm = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
/** "2026-10-01 08:05" -> the time "08:05"; and whether it is on another day than `date`. */
const timeOf = (stamp, date) => (stamp ? { time: stamp.slice(11), nextDay: stamp.slice(0, 10) !== date } : { time: null, nextDay: false });

async function companyName(companyId) {
  const c = await Company.findByPk(companyId);
  return c ? c.name : '';
}

const datesJson = (dates) => dates.map((d) => ({ date: d, day: Number(d.slice(8)), weekday: weekday(d) }));
const personJson = (e) => ({ ...attendance.employeeJson(e) });

function dayCell(date, row) {
  if (!row) return { date, code: null, in: null, out: null, outNextDay: false };
  const i = timeOf(row.firstIn, date);
  const o = timeOf(row.lastOut, date);
  return {
    date, code: row.code, in: i.time, out: o.time, outNextDay: o.nextDay, lateMinutes: row.lateMinutes, overtimeMinutes: row.overtimeMinutes, punches: row.punches,
    incomplete: row.incomplete, manual: row.isManual,
  };
}

// ---- Attendance report ----

/** GET /payroll/attendance/report?month=&groupId=&departmentId=&designationId=&employeeId=&search=&page=&limit= : one row per employee, one cell per date. */
async function attendanceReport(req, f) {
  const m = await attendance.loadMonth(req, f);
  const counts = { P: 0, L: 0, HD: 0, A: 0, R: 0, AL: 0 };
  const data = m.emps.map((e, i) => {
    const rows = m.byEmp.get(e.id);
    const by = new Map(rows.map((r) => [r.date, r]));
    const t = attendance.totalsOf(rows);
    for (const k of Object.keys(counts)) counts[k] += t[k];
    return {
      sr: (m.page - 1) * m.limit + i + 1, employee: personJson(e), days: m.dates.map((d) => dayCell(d, by.get(d))),
      totals: { P: t.P, L: t.L, HD: t.HD, A: t.A, R: t.R, AL: t.AL, lateMinutes: t.lateMinutes, overtimeMinutes: t.overtimeMinutes, overtimeHours: t.overtimeHours, workedMinutes: t.workedMinutes },
    };
  });
  return {
    month: m.month, monthLabel: longMonth(m.month), dates: datesJson(m.dates), legend: LEGEND.map(([code, text]) => ({ code, text })), page: m.page, limit: m.limit, total: m.total,
    summary: { employees: data.length, ...counts }, data,
  };
}

/** GET /payroll/attendance/report/employees/:id?month= : every date of the month of one employee with the in and out time, the hours, the late minutes. */
async function attendanceEmployee(req, id, { month }) {
  const { companyId } = req.user;
  const m = await attendance.loadMonth(req, { month, employeeId: id, closed: 'all', limit: 1 });
  if (!m.emps.length) {
    // not working in that month (or not his company): tell them apart
    await attendance.employeeOr404(companyId, id);
    throw AppError.rule('NOT_IN_MONTH', 'This employee was not employed in that month');
  }
  const e = m.emps[0];
  const [card] = await q(`SELECT to_char("joiningDate", 'YYYY-MM-DD') AS joined, to_char("leavingDate", 'YYYY-MM-DD') AS "leftOn" FROM payroll_employees WHERE id = :id`, { id });
  const rows = m.byEmp.get(e.id);
  const by = new Map(rows.map((r) => [r.date, r]));
  const data = m.dates.map((date) => {
    const r = by.get(date);
    const employed = date >= card.joined && (!card.leftOn || date <= card.leftOn);
    const c = dayCell(date, r);
    const worked = r ? r.workedMinutes : 0;
    return {
      ...c, weekday: weekday(date), employed, status: r ? TEXT[r.code] : employed ? 'No data' : 'Not employed',
      workedMinutes: worked, worked: r && worked ? hm(worked) : null, lateMinutes: r ? r.lateMinutes : 0, overtimeMinutes: r ? r.overtimeMinutes : 0, overtime: r && r.overtimeMinutes ? hm(r.overtimeMinutes) : null,
      punches: r ? r.punches : 0, restDay: r ? r.restDay : false, incomplete: r ? r.incomplete : false, manual: r ? r.isManual : false, originalCode: r && r.isManual ? r.originalCode : null, note: r ? r.note : null,
    };
  });
  const t = attendance.totalsOf(rows);
  return {
    month: m.month, monthLabel: longMonth(m.month), employee: { ...personJson(e), joiningDate: card.joined, leavingDate: card.leftOn }, legend: LEGEND.map(([code, text]) => ({ code, text })), data,
    totals: { P: t.P, L: t.L, HD: t.HD, A: t.A, R: t.R, AL: t.AL, workedMinutes: t.workedMinutes, worked: hm(t.workedMinutes), lateMinutes: t.lateMinutes, overtimeMinutes: t.overtimeMinutes, overtimeHours: t.overtimeHours, incompleteDays: t.incompleteDays, manualDays: t.manualDays },
  };
}

function head(ws, row) {
  row.font = { bold: true };
  row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2EF' } }; cell.border = { bottom: { style: 'thin' } }; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
}

async function attendanceReportXlsx(req, f) {
  const r = await attendanceReport(req, { ...f, page: 1, limit: ALL });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance', { views: [{ state: 'frozen', xSplit: 4, ySplit: 5 }] });
  ws.getCell(1, 1).value = await companyName(req.user.companyId);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Attendance Report - ${r.monthLabel}`;
  const tail = ['P', 'L', 'HD', 'A', 'R', 'AL', 'Late min', 'OT hrs'];
  const dayRow = ws.getRow(4);
  const wdRow = ws.getRow(5);
  ['Sr', 'ID', 'Name', 'Department'].forEach((h, i) => { wdRow.getCell(i + 1).value = h; });
  r.dates.forEach((d, i) => { dayRow.getCell(5 + i).value = d.day; wdRow.getCell(5 + i).value = d.weekday; ws.getColumn(5 + i).width = 10; });
  tail.forEach((h, i) => { wdRow.getCell(5 + r.dates.length + i).value = h; ws.getColumn(5 + r.dates.length + i).width = h.length > 3 ? 9 : 5; });
  ws.getColumn(1).width = 5; ws.getColumn(2).width = 8; ws.getColumn(3).width = 26; ws.getColumn(4).width = 16;
  head(ws, dayRow); head(ws, wdRow);
  r.data.forEach((d, i) => {
    const row = ws.getRow(6 + i);
    row.getCell(1).value = d.sr; row.getCell(2).value = d.employee.label; row.getCell(3).value = d.employee.name; row.getCell(4).value = d.employee.department ? d.employee.department.name : '';
    d.days.forEach((c, k) => {
      const cell = row.getCell(5 + k);
      cell.value = c.code ? `${c.code}${c.in || c.out ? `\n${c.in || ''}-${c.out || ''}` : ''}` : '';
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    const base = 5 + r.dates.length;
    ['P', 'L', 'HD', 'A', 'R', 'AL'].forEach((k, n) => { row.getCell(base + n).value = d.totals[k]; });
    row.getCell(base + 6).value = d.totals.lateMinutes;
    row.getCell(base + 7).value = d.totals.overtimeHours;
    row.height = 30;
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `attendance-report-${r.month}.xlsx` };
}

async function attendanceEmployeeXlsx(req, id, f) {
  const r = await attendanceEmployee(req, id, f);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.getCell(1, 1).value = await companyName(req.user.companyId);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Attendance - ${r.employee.label} ${r.employee.name} - ${r.employee.department ? r.employee.department.name : ''} - ${r.monthLabel}`;
  const cols = [['Date', 12], ['Day', 6], ['Status', 14], ['Code', 6], ['In', 8], ['Out', 8], ['Worked', 10], ['Late min', 9], ['OT', 9], ['Punches', 9], ['Note', 30]];
  const hr = ws.getRow(5);
  cols.forEach(([h, w], i) => { hr.getCell(i + 1).value = h; ws.getColumn(i + 1).width = w; });
  head(ws, hr);
  r.data.forEach((d, i) => {
    const row = ws.getRow(6 + i);
    [d.date, d.weekday, d.status, d.code || '', d.in || '', d.out ? `${d.out}${d.outNextDay ? ' (+1)' : ''}` : '', d.worked || '', d.lateMinutes || '', d.overtime || '', d.punches || '', d.note || ''].forEach((v, k) => { row.getCell(k + 1).value = v; });
  });
  const t = ws.getRow(6 + r.data.length);
  t.getCell(1).value = 'Total';
  t.getCell(3).value = `P ${r.totals.P}  L ${r.totals.L}  HD ${r.totals.HD}  A ${r.totals.A}  R ${r.totals.R}  AL ${r.totals.AL}`;
  t.getCell(7).value = r.totals.worked; t.getCell(8).value = r.totals.lateMinutes;
  t.font = { bold: true };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `attendance-${r.employee.label}-${r.month}.xlsx` };
}

// ---- Punch report ----

const PUNCH_SQL = `SELECT p.id, p."empCode", to_char(p."punchAt" AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS date, to_char(p."punchAt" AT TIME ZONE 'Asia/Karachi', 'HH24:MI:SS') AS time,
  d.name AS device, p.mode, p.source FROM payroll_punches p LEFT JOIN payroll_devices d ON d.id = p."deviceId"`;

async function punchesOf(companyId, codes, dates) {
  if (!codes.length) return [];
  return q(`${PUNCH_SQL} WHERE p."companyId" = :companyId AND p."empCode" IN (:codes) AND (p."punchAt" AT TIME ZONE 'Asia/Karachi')::date BETWEEN :first AND :last ORDER BY p."punchAt"`,
    { companyId, codes, first: dates[0], last: dates[dates.length - 1] });
}

/** GET /payroll/attendance/punch-report : one row per employee, one cell per date holding every punch time of that date. */
async function punchReport(req, f) {
  const m = await attendance.loadMonth(req, f);
  const punches = await punchesOf(req.user.companyId, m.emps.map((e) => e.code), m.dates);
  const by = new Map();
  for (const p of punches) {
    const k = `${p.empCode}|${p.date}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(p.time);
  }
  let total = 0;
  const data = m.emps.map((e, i) => {
    const days = m.dates.map((date) => ({ date, times: by.get(`${e.code}|${date}`) || [] }));
    const count = days.reduce((t, d) => t + d.times.length, 0);
    total += count;
    return { sr: (m.page - 1) * m.limit + i + 1, employee: personJson(e), days, totalPunches: count, daysWithPunches: days.filter((d) => d.times.length).length };
  });
  return { month: m.month, monthLabel: longMonth(m.month), dates: datesJson(m.dates), page: m.page, limit: m.limit, total: m.total, summary: { employees: data.length, punches: total }, data };
}

/** GET /payroll/attendance/punch-report/employees/:id?month= : every punch of one employee in the month, grouped by date, with the device and the source. */
async function punchEmployee(req, id, { month }) {
  const { companyId } = req.user;
  const m = await attendance.loadMonth(req, { month, employeeId: id, closed: 'all', limit: 1 });
  if (!m.emps.length) {
    await attendance.employeeOr404(companyId, id);
    throw AppError.rule('NOT_IN_MONTH', 'This employee was not employed in that month');
  }
  const e = m.emps[0];
  const punches = await punchesOf(companyId, [e.code], m.dates);
  const by = new Map();
  for (const p of punches) {
    if (!by.has(p.date)) by.set(p.date, []);
    by.get(p.date).push({ id: p.id, time: p.time, device: p.device || null, mode: p.mode == null ? null : p.mode, source: p.source });
  }
  const data = m.dates.map((date) => ({ date, weekday: weekday(date), count: (by.get(date) || []).length, punches: by.get(date) || [] }));
  return {
    month: m.month, monthLabel: longMonth(m.month), employee: personJson(e), data,
    totals: { punches: punches.length, daysWithPunches: data.filter((d) => d.count).length },
  };
}

async function punchReportXlsx(req, f) {
  const r = await punchReport(req, { ...f, page: 1, limit: ALL });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Punches', { views: [{ state: 'frozen', xSplit: 4, ySplit: 5 }] });
  ws.getCell(1, 1).value = await companyName(req.user.companyId);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Punch Report - ${r.monthLabel}`;
  const dayRow = ws.getRow(4);
  const wdRow = ws.getRow(5);
  ['Sr', 'ID', 'Name', 'Department'].forEach((h, i) => { wdRow.getCell(i + 1).value = h; });
  r.dates.forEach((d, i) => { dayRow.getCell(5 + i).value = d.day; wdRow.getCell(5 + i).value = d.weekday; ws.getColumn(5 + i).width = 11; });
  ws.getCell(5, 5 + r.dates.length).value = 'Punches';
  ws.getColumn(1).width = 5; ws.getColumn(2).width = 8; ws.getColumn(3).width = 26; ws.getColumn(4).width = 16;
  head(ws, dayRow); head(ws, wdRow);
  r.data.forEach((d, i) => {
    const row = ws.getRow(6 + i);
    row.getCell(1).value = d.sr; row.getCell(2).value = d.employee.label; row.getCell(3).value = d.employee.name; row.getCell(4).value = d.employee.department ? d.employee.department.name : '';
    d.days.forEach((c, k) => { const cell = row.getCell(5 + k); cell.value = c.times.join('\n'); cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true }; });
    row.getCell(5 + r.dates.length).value = d.totalPunches;
    row.height = Math.max(18, 14 * Math.max(1, ...d.days.map((c) => c.times.length)));
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `punch-report-${r.month}.xlsx` };
}

async function punchEmployeeXlsx(req, id, f) {
  const r = await punchEmployee(req, id, f);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Punches', { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.getCell(1, 1).value = await companyName(req.user.companyId);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Punch Record - ${r.employee.label} ${r.employee.name} - ${r.employee.department ? r.employee.department.name : ''} - ${r.monthLabel}`;
  const cols = [['Date', 12], ['Day', 6], ['Time', 10], ['Device', 20], ['Mode', 7], ['Source', 9]];
  const hr = ws.getRow(5);
  cols.forEach(([h, w], i) => { hr.getCell(i + 1).value = h; ws.getColumn(i + 1).width = w; });
  head(ws, hr);
  let n = 6;
  for (const d of r.data) {
    if (!d.punches.length) continue;
    for (const p of d.punches) {
      [d.date, d.weekday, p.time, p.device || '', p.mode == null ? '' : p.mode, p.source].forEach((v, k) => { ws.getRow(n).getCell(k + 1).value = v; });
      n += 1;
    }
  }
  ws.getRow(n).getCell(1).value = `Total ${r.totals.punches} punches on ${r.totals.daysWithPunches} days`;
  ws.getRow(n).font = { bold: true };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `punch-record-${r.employee.label}-${r.month}.xlsx` };
}

module.exports = { attendanceReport, attendanceEmployee, attendanceReportXlsx, attendanceEmployeeXlsx, punchReport, punchEmployee, punchReportXlsx, punchEmployeeXlsx };
