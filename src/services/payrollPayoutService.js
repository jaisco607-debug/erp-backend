// Paying the salary (owner 2026-11-10), chunk 14 of the Payroll module: the Bank upload file and the Cash sheet of a payroll.
//   Bank file   the approved payslips paid by bank, as the file the accountant uploads to the bank's portal (Meezan Bank layout for now). Every file made is kept as it was made
//               (payroll_bank_files) so it can be downloaded again exactly; the payslips in it get the "bank file made" tick, and a file can be made again at any time.
//   Cash sheet  the approved payslips paid in cash, with the notes each employee's envelope needs (5000, 1000, 500, 100, 50, 20, 10) and the total notes to bring from the bank; JSON, Excel or PDF.
// Both read what the payslips hold. By default they list what is still UNPAID (net - paid); scope=all lists the whole net.
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const audit = require('./auditService');
const runs = require('./payrollRunService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const fmt = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const DEFAULT_NOTES = [5000, 1000, 500, 100, 50, 20, 10];

async function companyName(companyId) {
  const c = await Company.findByPk(companyId);
  return c ? c.name : '';
}

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---- the bank formats: one entry per bank. To add a bank, add its header and how a row is written ----

const FORMATS = {
  MEEZAN: {
    name: 'Meezan Bank',
    // one header row, one row per employee, no total line (the bank's upload would read it as an employee)
    header: ['Sr No', 'Beneficiary Account No / IBAN', 'Beneficiary Title', 'Beneficiary Bank', 'Transfer Type', 'Amount', 'Payment Details', 'Reference No'],
    row: (r) => [r.sr, r.accountNo, r.accountTitle, r.bankName, /meezan/i.test(r.bankName) ? 'Within Meezan' : 'Other Bank (IBFT)', r.amount, r.details, r.reference],
  },
};

/** The approved bank payslips of a payroll that go into the file, and the ones that cannot. */
async function bankRows(companyId, runId, { format, scope, onlyNew }, transaction) {
  const r = await runs.loadRun(companyId, runId, transaction);
  const slips = await q(`SELECT ${runs.SLIP_SELECT} FROM ${runs.SLIP_FROM} WHERE s."runId" = :runId AND s."companyId" = :companyId AND s.status = 'APPROVED' AND s."paymentMethod" = 'BANK' AND NOT s."isCash" ORDER BY s."empCode"`, { runId, companyId }, transaction);
  const [{ n: notApproved }] = await q(`SELECT count(*)::int AS n FROM payroll_slips s WHERE s."runId" = :runId AND s."companyId" = :companyId AND s.status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW') AND s."paymentMethod" = 'BANK' AND NOT s."isCash"`, { runId, companyId }, transaction);
  const monthKey = r.month.replace('-', '');
  const data = [];
  const skipped = [];
  let total = 0n;
  let settled = 0;
  let alreadyInFile = 0;
  for (const s of slips) {
    const amount = scope === 'ALL' ? toCents(s.netAmount) : toCents(s.netAmount) - toCents(s.paidAmount);
    const who = { code: s.empCode, label: pad5(s.empCode), name: s.empName };
    if (amount <= 0n) { settled += 1; continue; }
    if (onlyNew && s.bankFileId) { alreadyInFile += 1; continue; }
    const accountNo = String(s.accountNo || '').replace(/[\s-]/g, '').toUpperCase();
    if (!accountNo) { skipped.push({ slipId: s.id, payslipId: s.code, employee: who, reason: 'NO_ACCOUNT', message: 'The employee has no bank account number' }); continue; }
    total += amount;
    data.push({
      sr: data.length + 1, slipId: s.id, payslipId: s.code, employee: who, accountNo, accountTitle: String(s.accountTitle || s.empName).replace(/\s+/g, ' ').trim(), bankName: s.bankName || '',
      amount: fromCents(amount), details: `Salary ${longMonth(r.month)}`, reference: `SAL-${monthKey}-${pad5(s.empCode)}`,
      alreadyInFile: s.bankFileId ? { id: s.bankFileId, code: s.bankFileCode, label: `BF-${pad5(s.bankFileCode)}` } : null,
    });
  }
  const spec = FORMATS[format];
  const fileName = `${safe(spec.name)}-salary-${safe(r.groupName)}-${r.month}`;
  return { run: r, data, skipped, total, counts: { notApproved, settled, alreadyInFile }, spec, fileName };
}

function bankText(spec, data) {
  return [spec.header, ...data.map((d) => spec.row(d))].map((cols) => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const runBrief = (r) => { const j = runs.runJson(r, null); return { id: j.id, code: j.code, label: j.label, group: j.group, month: j.month, monthLabel: longMonth(j.month) }; };

const fileJson = (f) => ({
  id: f.id, code: f.code, label: `BF-${pad5(f.code)}`, runId: f.runId, format: f.format, formatName: FORMATS[f.format] ? FORMATS[f.format].name : f.format, scope: f.scope.toLowerCase(), fileName: f.fileName,
  employees: f.employees, total: fromCents(toCents(f.total)), createdAt: f.createdAt, createdBy: f.createdByName || null,
});

const FILE_SELECT = `f.id, f.code, f."runId", f.format, f.scope, f."fileName", f.employees, f.total::text AS total, f."createdAt", u.name AS "createdByName"`;
const FILE_FROM = 'payroll_bank_files f LEFT JOIN users u ON u.id = f."createdById"';

/** What the bank file would hold (nothing is saved or ticked). */
async function bankPreview(req, runId, { format = 'MEEZAN', scope = 'unpaid', onlyNew = false } = {}) {
  const { companyId } = req.user;
  const b = await bankRows(companyId, runId, { format, scope: scope.toUpperCase(), onlyNew });
  const files = await q(`SELECT ${FILE_SELECT} FROM ${FILE_FROM} WHERE f."runId" = :runId AND f."companyId" = :companyId ORDER BY f."createdAt" DESC, f.code DESC`, { runId, companyId });
  return {
    run: runBrief(b.run), format: { key: format, name: b.spec.name, columns: b.spec.header }, scope, onlyNew, fileName: `${b.fileName}.csv`,
    data: b.data, total: fromCents(b.total), count: b.data.length, skipped: b.skipped, notApproved: b.counts.notApproved, settled: b.counts.settled, alreadyInFile: b.counts.alreadyInFile,
    files: files.map(fileJson), formats: Object.entries(FORMATS).map(([key, f]) => ({ key, name: f.name })),
  };
}

/** Makes the file, keeps it and ticks the payslips in it. A file can be made again whenever needed. */
async function createBankFile(req, runId, { format = 'MEEZAN', scope = 'unpaid', onlyNew = false } = {}) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `bank-file:${companyId}` }, transaction });
    const b = await bankRows(companyId, runId, { format, scope: scope.toUpperCase(), onlyNew }, transaction);
    if (!b.data.length) throw AppError.rule('NO_ROWS', 'There is nothing to put in the bank file: no approved payslip with a bank account is waiting to be paid');
    const [{ m }] = await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_bank_files WHERE "companyId" = :companyId', { companyId }, transaction);
    const code = Number(m) + 1;
    const fileName = `${b.fileName}-BF${pad5(code)}.csv`;
    const [[row]] = await run(`INSERT INTO payroll_bank_files ("companyId", code, "runId", format, scope, "fileName", content, employees, total, "createdById")
      VALUES (:companyId, :code, :runId, :format, :scope, :fileName, :content, :employees, :total, :userId) RETURNING id`,
    { companyId, code, runId, format, scope: scope.toUpperCase(), fileName, content: bankText(b.spec, b.data), employees: b.data.length, total: fromCents(b.total), userId: req.user.id }, transaction);
    await run('UPDATE payroll_slips SET "bankFileId" = :fileId WHERE id IN (:ids) AND "companyId" = :companyId', { fileId: row.id, ids: b.data.map((d) => d.slipId), companyId }, transaction);
    await audit.log(req, { action: 'PAYROLL_BANK_FILE_MADE', entityType: 'PayrollRun', entityId: runId, after: { file: `BF-${pad5(code)}`, format, scope, employees: b.data.length, total: fromCents(b.total), skipped: b.skipped.length } }, { transaction });
    const [f] = await q(`SELECT ${FILE_SELECT} FROM ${FILE_FROM} WHERE f.id = :id`, { id: row.id }, transaction);
    return { ...fileJson(f), skipped: b.skipped, rows: b.data };
  });
}

async function bankFiles(req, runId) {
  const { companyId } = req.user;
  await runs.loadRun(companyId, runId);
  const files = await q(`SELECT ${FILE_SELECT} FROM ${FILE_FROM} WHERE f."runId" = :runId AND f."companyId" = :companyId ORDER BY f."createdAt" DESC, f.code DESC`, { runId, companyId });
  return { data: files.map(fileJson) };
}

/** A file made earlier, exactly as it was made. */
async function bankFileDownload(req, fileId) {
  const [f] = await q('SELECT "fileName", content FROM payroll_bank_files WHERE id = :id AND "companyId" = :companyId', { id: fileId, companyId: req.user.companyId });
  if (!f) throw AppError.notFound('Bank file');
  return { text: f.content, fileName: f.fileName };
}

// ---- the Cash sheet ----

/** The notes an amount is made of, biggest first; what is left under the smallest note is the "rest" (coins and paisa). */
function breakdown(cents, notes) {
  let left = cents;
  const out = {};
  for (const n of notes) {
    const value = BigInt(n) * 100n;
    out[n] = Number(left / value);
    left %= value;
  }
  return { notes: out, rest: left };
}

async function cashSheet(req, runId, { scope = 'unpaid', denominations = DEFAULT_NOTES } = {}) {
  const { companyId } = req.user;
  const r = await runs.loadRun(companyId, runId);
  const notes = [...new Set(denominations)].sort((a, b) => b - a);
  const slips = await q(`SELECT ${runs.SLIP_SELECT} FROM ${runs.SLIP_FROM} WHERE s."runId" = :runId AND s."companyId" = :companyId AND s.status = 'APPROVED' AND (s."paymentMethod" = 'CASH' OR s."isCash") ORDER BY s."empCode"`, { runId, companyId });
  const [{ n: notApproved }] = await q(`SELECT count(*)::int AS n FROM payroll_slips s WHERE s."runId" = :runId AND s."companyId" = :companyId AND s.status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW') AND (s."paymentMethod" = 'CASH' OR s."isCash")`, { runId, companyId });
  const data = [];
  const totalNotes = Object.fromEntries(notes.map((n) => [n, 0]));
  let total = 0n;
  let totalRest = 0n;
  let settled = 0;
  for (const s of slips) {
    const amount = scope === 'all' ? toCents(s.netAmount) : toCents(s.netAmount) - toCents(s.paidAmount);
    if (amount <= 0n) { settled += 1; continue; }
    const b = breakdown(amount, notes);
    for (const n of notes) totalNotes[n] += b.notes[n];
    total += amount;
    totalRest += b.rest;
    data.push({
      sr: data.length + 1, slipId: s.id, payslipId: s.code, employee: { code: s.empCode, label: pad5(s.empCode), name: s.empName, department: s.departmentName, designation: s.designationName },
      amount: fromCents(amount), notes: b.notes, rest: fromCents(b.rest),
    });
  }
  return {
    run: runBrief(r), scope, denominations: notes, data,
    totals: {
      employees: data.length, amount: fromCents(total), notes: totalNotes, rest: fromCents(totalRest),
      // what to bring from the bank: every note with its value, so the cashier can check it adds up to the total
      noteValues: notes.map((n) => ({ denomination: n, count: totalNotes[n], value: fromCents(BigInt(n) * BigInt(totalNotes[n]) * 100n) })),
    },
    notApproved, settled,
  };
}

const MONEY_FMT = '#,##0.00';

async function cashSheetXlsx(req, runId, opts) {
  const sheet = await cashSheet(req, runId, opts);
  const name = await companyName(req.user.companyId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Sheet', { views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }] });
  ws.getCell(1, 1).value = name;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = `Cash Sheet - ${sheet.run.label} - ${sheet.run.group.name} - ${sheet.run.monthLabel}`;
  const heads = ['Sr', 'ID', 'Name', 'Department', 'Amount', ...sheet.denominations.map(String), 'Rest', 'Signature'];
  const widths = [5, 8, 26, 16, 13, ...sheet.denominations.map(() => 8), 10, 24];
  const head = ws.getRow(4);
  heads.forEach((h, i) => { head.getCell(i + 1).value = h; ws.getColumn(i + 1).width = widths[i]; });
  head.font = { bold: true };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F2EF' } }; cell.border = { bottom: { style: 'thin' } }; });
  const firstNote = 6;
  const restCol = firstNote + sheet.denominations.length;
  sheet.data.forEach((d, i) => {
    const row = ws.getRow(5 + i);
    row.getCell(1).value = d.sr; row.getCell(2).value = d.employee.label; row.getCell(3).value = d.employee.name; row.getCell(4).value = d.employee.department;
    row.getCell(5).value = Number(d.amount); row.getCell(5).numFmt = MONEY_FMT;
    sheet.denominations.forEach((n, k) => { row.getCell(firstNote + k).value = d.notes[n]; });
    row.getCell(restCol).value = Number(d.rest); row.getCell(restCol).numFmt = MONEY_FMT;
    row.height = 22;
  });
  const t = ws.getRow(5 + sheet.data.length);
  t.getCell(3).value = `Total (${sheet.totals.employees} employees)`;
  t.getCell(5).value = Number(sheet.totals.amount); t.getCell(5).numFmt = MONEY_FMT;
  sheet.denominations.forEach((n, k) => { t.getCell(firstNote + k).value = sheet.totals.notes[n]; });
  t.getCell(restCol).value = Number(sheet.totals.rest); t.getCell(restCol).numFmt = MONEY_FMT;
  t.font = { bold: true };
  t.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
  // the notes to bring from the bank
  let y = 7 + sheet.data.length;
  ws.getCell(y, 3).value = 'Notes to bring';
  ws.getCell(y, 3).font = { bold: true };
  for (const nv of sheet.totals.noteValues) {
    y += 1;
    ws.getCell(y, 3).value = `${nv.denomination} x ${nv.count}`;
    ws.getCell(y, 5).value = Number(nv.value); ws.getCell(y, 5).numFmt = MONEY_FMT;
  }
  y += 1;
  ws.getCell(y, 3).value = 'Coins / rest';
  ws.getCell(y, 5).value = Number(sheet.totals.rest); ws.getCell(y, 5).numFmt = MONEY_FMT;
  y += 1;
  ws.getCell(y, 3).value = 'Total cash';
  ws.getCell(y, 5).value = Number(sheet.totals.amount); ws.getCell(y, 5).numFmt = MONEY_FMT;
  ws.getRow(y).font = { bold: true };
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `cash-sheet-${safe(sheet.run.group.name)}-${sheet.run.month}.xlsx` };
}

const GREEN = '#0f766e';
const GREY = '#6b7280';

async function cashSheetPdf(req, runId, opts) {
  const sheet = await cashSheet(req, runId, opts);
  const name = await companyName(req.user.companyId);
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks = [];
  const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 30;
  const widths = [24, 38, 130, 80, 66, ...sheet.denominations.map(() => 34), 44];
  const used = widths.reduce((a, b) => a + b, 0);
  const sign = Math.max(60, 782 - used);
  const heads = ['Sr', 'ID', 'Name', 'Department', 'Amount', ...sheet.denominations.map(String), 'Rest', 'Signature'];
  const cols = [...widths, sign];
  const rowH = 22;
  const header = (y) => {
    doc.rect(left, y, cols.reduce((a, b) => a + b, 0), 18).fillColor('#e6f2ef').fill();
    let x = left;
    heads.forEach((h, i) => { doc.fillColor('#111827').font('Helvetica-Bold').fontSize(8).text(h, x + 3, y + 5, { width: cols[i] - 6, align: i >= 4 && i < heads.length - 1 ? 'right' : 'left' }); x += cols[i]; });
    return y + 18;
  };
  const page = () => {
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(15).text(name, left, 28);
    doc.fillColor('#111827').fontSize(11).text('CASH SHEET', left, 30, { align: 'right', width: 782 });
    doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`${sheet.run.label}  |  ${sheet.run.group.name}  |  ${sheet.run.monthLabel}  |  ${sheet.scope === 'all' ? 'whole net salary' : 'unpaid balance'}`, left, 50, { align: 'right', width: 782 });
    return header(72);
  };
  let y = page();
  const cell = (text, i, rowY, opts2 = {}) => {
    const x = left + cols.slice(0, i).reduce((a, b) => a + b, 0);
    doc.text(text, x + 3, rowY + 6, { width: cols[i] - 6, align: opts2.right ? 'right' : 'left', lineBreak: false, ellipsis: true });
  };
  doc.font('Helvetica').fontSize(8).fillColor('#111827');
  for (const d of sheet.data) {
    if (y + rowH > 560) { doc.addPage(); y = page(); doc.font('Helvetica').fontSize(8).fillColor('#111827'); }
    doc.font('Helvetica').fontSize(8).fillColor('#111827');
    cell(String(d.sr), 0, y); cell(d.employee.label, 1, y); cell(d.employee.name, 2, y); cell(d.employee.department || '', 3, y); cell(fmt(d.amount), 4, y, { right: true });
    sheet.denominations.forEach((n, k) => cell(d.notes[n] ? String(d.notes[n]) : '-', 5 + k, y, { right: true }));
    cell(Number(d.rest) ? fmt(d.rest) : '-', 5 + sheet.denominations.length, y, { right: true });
    doc.moveTo(left, y + rowH).lineTo(left + cols.reduce((a, b) => a + b, 0), y + rowH).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    y += rowH;
  }
  // totals and the notes to bring
  if (y + 90 > 560) { doc.addPage(); y = page(); }
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#111827');
  cell(`Total (${sheet.totals.employees})`, 2, y);
  cell(fmt(sheet.totals.amount), 4, y, { right: true });
  sheet.denominations.forEach((n, k) => cell(String(sheet.totals.notes[n]), 5 + k, y, { right: true }));
  cell(fmt(sheet.totals.rest), 5 + sheet.denominations.length, y, { right: true });
  doc.moveTo(left, y).lineTo(left + cols.reduce((a, b) => a + b, 0), y).strokeColor('#111827').lineWidth(0.8).stroke();
  y += 28;
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('Notes to bring from the bank', left, y);
  y += 14;
  doc.fillColor('#111827').font('Helvetica').fontSize(8);
  for (const nv of sheet.totals.noteValues) {
    doc.text(`${nv.denomination} x ${nv.count}`, left, y, { width: 90 });
    doc.text(fmt(nv.value), left + 90, y, { width: 90, align: 'right' });
    y += 12;
  }
  doc.text('Coins / rest', left, y, { width: 90 });
  doc.text(fmt(sheet.totals.rest), left + 90, y, { width: 90, align: 'right' });
  y += 12;
  doc.font('Helvetica-Bold').text('Total cash', left, y, { width: 90 });
  doc.text(fmt(sheet.totals.amount), left + 90, y, { width: 90, align: 'right' });
  doc.end();
  return { buffer: await done, fileName: `cash-sheet-${safe(sheet.run.group.name)}-${sheet.run.month}.pdf` };
}

module.exports = { bankPreview, createBankFile, bankFiles, bankFileDownload, cashSheet, cashSheetXlsx, cashSheetPdf, FORMATS, DEFAULT_NOTES };
