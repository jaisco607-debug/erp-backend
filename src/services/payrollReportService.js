// The printed side of the payroll (owner 2026-11-08): the Salary Sheet and the Attendance Sheet of a payroll (as data for the screen, or as an Excel file), and the Payslip as a PDF
// (one payslip, or every payslip of a payroll in one file). They read what the payslips hold, so they always agree with the payroll screens.
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const runs = require('./payrollRunService');
const { datesBetween } = require('../utils/leaveBalance');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const pad5 = (n) => String(n).padStart(5, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (ymd) => WEEK[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
const fmt = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CODES = [['P', 'Present'], ['L', 'Late'], ['HD', 'Half day'], ['A', 'Absent'], ['R', 'Rest / holiday'], ['AL', 'Annual leave'], ['-', 'Not employed']];

async function companyName(companyId) {
  const c = await Company.findByPk(companyId);
  return c ? c.name : '';
}

// ---- the Salary Sheet ----

const SUM_KEYS = ['basicSalary', 'gross', 'additions', 'deductions', 'net', 'paid', 'balance', 'food', 'maintenance', 'mobile', 'othersAdd', 'loan', 'advance', 'eobi', 'incomeTax', 'othersDeduct', 'contribution'];

function sheetRow(s, i) {
  const approved = s.status === 'APPROVED';
  const net = toCents(s.net);
  const paid = toCents(s.paid);
  return {
    sr: i + 1, slipId: s.id, payslipId: s.payslipId, status: s.status, statusText: s.statusText,
    employee: { code: s.employee.code, label: s.employee.label, name: s.employee.name, department: s.employee.department, designation: s.employee.designation },
    salaryType: s.salaryType, basicSalary: s.basicSalary, days: s.days, payableDays: s.payableDays, overtimeHours: s.overtimeHours,
    gross: s.gross, food: s.additions.food, maintenance: s.additions.maintenance, mobile: s.additions.mobile, othersAdd: s.additions.others, additions: s.additions.total,
    loan: s.deductions.loan, advance: s.deductions.advance, eobi: s.deductions.eobi, incomeTax: s.deductions.incomeTax, othersDeduct: s.deductions.others, deductions: s.deductions.total,
    net: s.net, contribution: s.contribution, paid: s.paid, balance: approved ? fromCents(net - paid) : fromCents(0n), paymentMethod: s.paymentMethod, bank: s.bank,
    countedInTotals: s.status !== 'SUSPENDED',
  };
}

/** The rows of a payroll and the totals. A suspended payslip is shown but left out of the totals; paid and balance count the approved ones only. */
async function salarySheet(req, runId) {
  const { companyId } = req.user;
  const r = await runs.loadRun(companyId, runId);
  const rows = await q(`SELECT ${runs.SLIP_SELECT} FROM ${runs.SLIP_FROM} WHERE s."runId" = :runId AND s."companyId" = :companyId ORDER BY s."empCode"`, { runId, companyId });
  const data = rows.map((s, i) => sheetRow(runs.slipJson(s, false), i));
  const sum = Object.fromEntries(SUM_KEYS.map((k) => [k, 0n]));
  let counted = 0;
  for (const d of data) {
    if (!d.countedInTotals) continue;
    counted += 1;
    for (const k of SUM_KEYS) if (d[k] != null) sum[k] += toCents(d[k]);
  }
  // the paid money is of approved payslips only
  const totals = { employees: counted, ...Object.fromEntries(SUM_KEYS.map((k) => [k, fromCents(sum[k])])) };
  const pays = {};
  for (const d of data) if (d.status === 'APPROVED') for (const k of ['paid', 'balance']) pays[k] = (pays[k] || 0n) + toCents(d[k]);
  totals.paid = fromCents(pays.paid || 0n);
  totals.balance = fromCents(pays.balance || 0n);
  const run = runs.runJson(r, null);
  return { run: { id: run.id, code: run.code, label: run.label, group: run.group, month: run.month, monthLabel: longMonth(run.month), daysInMonth: run.daysInMonth }, data, totals };
}

const MONEY_FMT = '#,##0.00';

async function salarySheetXlsx(req, runId) {
  const sheet = await salarySheet(req, runId);
  const name = await companyName(req.user.companyId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Salary Sheet', { views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }] });
  const cols = [
    ['Sr', 'sr', 5], ['ID', (d) => d.employee.label, 8], ['Name', (d) => d.employee.name, 26], ['Department', (d) => d.employee.department, 16], ['Basic', 'basicSalary', 12, true],
    ['P', (d) => d.days.P, 5], ['L', (d) => d.days.L, 5], ['HD', (d) => d.days.HD, 5], ['A', (d) => d.days.A, 5], ['R', (d) => d.days.R, 5], ['AL', (d) => d.days.AL, 5],
    ['Paid days', 'payableDays', 10], ['OT hrs', 'overtimeHours', 8], ['Gross', 'gross', 12, true],
    ['Food', 'food', 10, true], ['Maintenance', 'maintenance', 12, true], ['Mobile', 'mobile', 10, true], ['Other add.', 'othersAdd', 11, true], ['Additions', 'additions', 12, true],
    ['Loan', 'loan', 10, true], ['Advance', 'advance', 10, true], ['EOBI', 'eobi', 10, true], ['Income tax', 'incomeTax', 11, true], ['Other ded.', 'othersDeduct', 11, true], ['Deductions', 'deductions', 12, true],
    ['Net pay', 'net', 13, true], ['Paid', 'paid', 12, true], ['Balance', 'balance', 12, true], ['Status', 'statusText', 13],
  ];
  ws.mergeCells(1, 1, 1, 8);
  ws.getCell(1, 1).value = name;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, 8);
  ws.getCell(2, 1).value = `Salary Sheet - ${sheet.run.label} - ${sheet.run.group.name} - ${sheet.run.monthLabel}`;
  const head = ws.getRow(4);
  cols.forEach((c, i) => { head.getCell(i + 1).value = c[0]; ws.getColumn(i + 1).width = c[2]; });
  head.font = { bold: true };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2EF' } }; cell.border = { bottom: { style: 'thin' } }; });
  const put = (row, d) => cols.forEach((c, i) => {
    const v = typeof c[1] === 'function' ? c[1](d) : d[c[1]];
    const cell = row.getCell(i + 1);
    cell.value = c[3] && v != null ? Number(v) : v;
    if (c[3]) cell.numFmt = MONEY_FMT;
  });
  sheet.data.forEach((d, i) => put(ws.getRow(5 + i), d));
  const t = ws.getRow(5 + sheet.data.length);
  t.getCell(3).value = `Total (${sheet.totals.employees} employees)`;
  cols.forEach((c, i) => {
    const key = c[1];
    if (c[3] && sheet.totals[key] !== undefined) { t.getCell(i + 1).value = Number(sheet.totals[key]); t.getCell(i + 1).numFmt = MONEY_FMT; }
  });
  t.font = { bold: true };
  t.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `salary-sheet-${sheet.run.group.name}-${sheet.run.month}.xlsx` };
}

// ---- the Attendance Sheet ----

async function attendanceSheet(req, runId) {
  const { companyId } = req.user;
  const r = await runs.loadRun(companyId, runId);
  const { first, last } = runs.monthInfo(r.month);
  const dates = datesBetween(first, last);
  const slips = await q(`SELECT s.id, s."empCode", s."empName", s."departmentName", s.status, s."cntP", s."cntL", s."cntHD", s."cntA", s."cntR", s."cntAL", s."overtimeMinutes", s."payableDays"::float AS "payableDays"
    FROM payroll_slips s WHERE s."runId" = :runId AND s."companyId" = :companyId ORDER BY s."empCode"`, { runId, companyId });
  const days = await q(`SELECT d."slipId", to_char(d."dayDate", 'YYYY-MM-DD') AS date, d.code FROM payroll_slip_days d JOIN payroll_slips s ON s.id = d."slipId" WHERE s."runId" = :runId AND s."companyId" = :companyId`, { runId, companyId });
  const by = new Map();
  for (const d of days) { if (!by.has(d.slipId)) by.set(d.slipId, new Map()); by.get(d.slipId).set(d.date, d.code); }
  const data = slips.map((s, i) => ({
    sr: i + 1, slipId: s.id, status: s.status, employee: { code: s.empCode, label: pad5(s.empCode), name: s.empName, department: s.departmentName },
    codes: dates.map((d) => (by.get(s.id) || new Map()).get(d) || null),
    counts: { P: s.cntP, L: s.cntL, HD: s.cntHD, A: s.cntA, R: s.cntR, AL: s.cntAL }, payableDays: s.payableDays, overtimeHours: Math.round((s.overtimeMinutes / 60) * 100) / 100,
  }));
  const run = runs.runJson(r, null);
  return { run: { id: run.id, code: run.code, label: run.label, group: run.group, month: run.month, monthLabel: longMonth(run.month), daysInMonth: run.daysInMonth },
    dates: dates.map((d) => ({ date: d, day: Number(d.slice(8)), weekday: weekday(d) })), legend: CODES.map(([code, text]) => ({ code, text })), data };
}

async function attendanceSheetXlsx(req, runId) {
  const sheet = await attendanceSheet(req, runId);
  const name = await companyName(req.user.companyId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance Sheet', { views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }] });
  const fixed = ['Sr', 'ID', 'Name'];
  const tail = ['P', 'L', 'HD', 'A', 'R', 'AL', 'Paid days', 'OT hrs'];
  ws.getCell(1, 1).value = name;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Attendance Sheet - ${sheet.run.label} - ${sheet.run.group.name} - ${sheet.run.monthLabel}`;
  const dayRow = ws.getRow(4);
  const wdRow = ws.getRow(5);
  fixed.forEach((h, i) => { wdRow.getCell(i + 1).value = h; });
  sheet.dates.forEach((d, i) => { dayRow.getCell(4 + i).value = d.day; wdRow.getCell(4 + i).value = d.weekday; ws.getColumn(4 + i).width = 4.5; });
  tail.forEach((h, i) => { wdRow.getCell(4 + sheet.dates.length + i).value = h; ws.getColumn(4 + sheet.dates.length + i).width = h.length > 3 ? 10 : 5; });
  ws.getColumn(1).width = 5; ws.getColumn(2).width = 8; ws.getColumn(3).width = 26;
  [dayRow, wdRow].forEach((row) => { row.font = { bold: true }; });
  sheet.data.forEach((d, i) => {
    const row = ws.getRow(6 + i);
    row.getCell(1).value = d.sr; row.getCell(2).value = d.employee.label; row.getCell(3).value = d.employee.name;
    d.codes.forEach((c, k) => { row.getCell(4 + k).value = c; row.getCell(4 + k).alignment = { horizontal: 'center' }; });
    const base = 4 + sheet.dates.length;
    ['P', 'L', 'HD', 'A', 'R', 'AL'].forEach((k, n) => { row.getCell(base + n).value = d.counts[k]; });
    row.getCell(base + 6).value = d.payableDays;
    row.getCell(base + 7).value = d.overtimeHours;
  });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `attendance-sheet-${sheet.run.group.name}-${sheet.run.month}.xlsx` };
}

// ---- the Payslip (PDF) ----

const GREEN = '#0f766e';
const GREY = '#6b7280';

function line(doc, y) { doc.moveTo(40, y).lineTo(555, y).strokeColor('#d1d5db').lineWidth(0.5).stroke(); }

function table(doc, title, rows, x, y, width) {
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10).text(title, x, y);
  let cy = y + 16;
  doc.font('Helvetica').fontSize(9).fillColor('#111827');
  for (const [label, value, bold] of rows) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, x, cy, { width: width - 90 });
    doc.text(value, x + width - 90, cy, { width: 90, align: 'right' });
    cy += 14;
  }
  return cy;
}

/** Draws one payslip on the current page of `doc`. `s` is what getSlip gives, `calc` the stored computation. */
function drawPayslip(doc, s, calc, company, run) {
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text(company, 40, 40);
  doc.fillColor('#111827').fontSize(12).text('PAYSLIP', 40, 40, { align: 'right', width: 515 });
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`${longMonth(s.month)}  |  Payroll #${s.runCode == null ? run.code : s.runCode}  |  Payslip ${s.payslipId}`, 40, 62, { width: 515, align: 'right' });
  line(doc, 82);
  // the employee
  const emp = s.employee;
  const info = [
    ['Employee ID', emp.label], ['Name', emp.name], ['Department', emp.department || '-'], ['Designation', emp.designation || '-'],
    ['Joining date', emp.joiningDate || '-'], ['Payment', s.paymentMethod === 'BANK' ? `Bank ${s.bank.name || ''} ${s.bank.accountNo || ''}`.trim() : 'Cash'],
  ];
  info.forEach(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(k, 40 + col * 260, 92 + row * 28);
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text(String(v), 40 + col * 260, 102 + row * 28, { width: 250 });
  });
  line(doc, 182);
  // the attendance summary
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10).text('Attendance', 40, 190);
  const d = s.days;
  const cells = [['P', d.P], ['L', d.L], ['HD', d.HD], ['A', d.A], ['R', d.R], ['AL', d.AL], ['Days', d.total], ['Paid days', s.payableDays], ['OT hrs', s.overtimeHours]];
  cells.forEach(([k, v], i) => {
    const x = 40 + i * 57;
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(k, x, 207, { width: 52 });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11).text(String(v), x, 218, { width: 52 });
  });
  line(doc, 240);
  // earnings and deductions side by side
  const earned = calc && calc.earned != null ? calc.earned : s.gross;
  const overtime = calc && calc.overtimeAmount != null ? calc.overtimeAmount : '0.00';
  const left = [['Basic earned', fmt(earned)], ['Overtime', fmt(overtime)], ['Gross', fmt(s.gross), true], ['Food', fmt(s.additions.food)], ['Maintenance', fmt(s.additions.maintenance)],
    ['Mobile', fmt(s.additions.mobile)], ['Other additions', fmt(s.additions.others)], ['Total additions', fmt(s.additions.total), true]];
  const right = [['Loan instalment', fmt(s.deductions.loan)], ['Advance', fmt(s.deductions.advance)], ['EOBI', fmt(s.deductions.eobi)], ['Income tax', fmt(s.deductions.incomeTax)], ['Other deductions', fmt(s.deductions.others)], ['Total deductions', fmt(s.deductions.total), true]];
  const ly = table(doc, 'Earnings', left, 40, 250, 245);
  const ry = table(doc, 'Deductions', right, 310, 250, 245);
  const y = Math.max(ly, ry) + 10;
  line(doc, y);
  // the result
  doc.rect(40, y + 8, 515, 54).fillColor('#ecfdf5').fill();
  const res = [['Net pay', s.net], ['Paid', s.paid], ['Balance', s.balance]];
  res.forEach(([k, v], i) => {
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(k, 55 + i * 170, y + 16);
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(14).text(fmt(v), 55 + i * 170, y + 30);
  });
  doc.fillColor(GREY).font('Helvetica').fontSize(8).text(`Status: ${s.statusText}${s.status === 'APPROVED' ? '' : ' (not final)'}`, 40, y + 72);
  if (s.status !== 'APPROVED') doc.fillColor('#fca5a5').font('Helvetica-Bold').fontSize(60).opacity(0.25).text(s.statusText.toUpperCase(), 100, 420, { width: 400, align: 'center' }).opacity(1);
  doc.fillColor(GREY).font('Helvetica').fontSize(8).text('This is a computer generated payslip.', 40, 790, { width: 515, align: 'center' });
}

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

async function slipCalc(companyId, id) {
  const s = await runs.loadSlip(companyId, id);
  return s.calc || {};
}

/** One payslip as a PDF. */
async function payslipPdf(req, slipId) {
  const { companyId } = req.user;
  const s = await runs.getSlip(req, slipId);
  const run = await runs.loadRun(companyId, s.runId);
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const done = collect(doc);
  drawPayslip(doc, s, await slipCalc(companyId, slipId), await companyName(companyId), run);
  doc.end();
  return { buffer: await done, fileName: `payslip-${s.employee.label}-${s.month}.pdf` };
}

/** Every payslip of a payroll (the suspended ones left out), one page each, in one PDF. */
async function runPayslipsPdf(req, runId) {
  const { companyId } = req.user;
  const run = await runs.loadRun(companyId, runId);
  const slips = await q(`SELECT id FROM payroll_slips WHERE "runId" = :runId AND "companyId" = :companyId AND status <> 'SUSPENDED' ORDER BY "empCode"`, { runId, companyId });
  if (!slips.length) throw AppError.rule('NO_PAYSLIPS', 'This payroll has no payslips to print');
  const name = await companyName(companyId);
  const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false });
  const done = collect(doc);
  for (const { id } of slips) {
    doc.addPage();
    drawPayslip(doc, await runs.getSlip(req, id), await slipCalc(companyId, id), name, run);
  }
  doc.end();
  return { buffer: await done, fileName: `payslips-${run.groupName}-${run.month}.pdf` };
}

module.exports = { salarySheet, salarySheetXlsx, attendanceSheet, attendanceSheetXlsx, payslipPdf, runPayslipsPdf };
