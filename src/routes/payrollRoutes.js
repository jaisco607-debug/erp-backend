// /api/v1/payroll  -  the Payroll module. Chunk 1: the masters (groups, departments, designations, shifts, holidays, banks). Chunk 2: the employee master and its files. Chunk 3: the policy of each group. Chunk 4: the employee joining application (changed with PAYROLL_APPLICATIONS FULL). Chunk 6: attendance (changed with PAYROLL_SALARY FULL). Chunk 7: resignation applications. Chunk 8: employee loan applications. Chunk 9: leave applications and the Annual Leaves report. Chunk 10: the payroll (runs and payslips). Chunk 11: EOBI contribution lists (Reports > Employees Contribution).
// Reading: anyone with any payroll service (VIEW is enough), so the salary and applications screens can fill their dropdowns.
// Changing: the Payroll Employees service (PAYROLL_EMPLOYEES) with FULL access. Company people only.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const requireAnyService = require('../middlewares/requireAnyService');
const v = require('../validators/payrollMasterValidator');
const ev = require('../validators/payrollEmployeeValidator');
const { masters, options } = require('../services/payrollMasterService');
const employees = require('../services/payrollEmployeeService');
const av = require('../validators/payrollApplicationValidator');
const applications = require('../services/payrollApplicationService');
const pv = require('../validators/payrollPolicyValidator');
const policies = require('../services/payrollPolicyService');
const approvers = require('../services/payrollApproverService');
const tv = require('../validators/payrollAttendanceValidator');
const attendance = require('../services/payrollAttendanceService');
const rv = require('../validators/payrollResignationValidator');
const resignations = require('../services/payrollResignationService');
const lv = require('../validators/payrollLoanValidator');
const loansSvc = require('../services/payrollLoanService');
const vv = require('../validators/payrollLeaveValidator');
const leaves = require('../services/payrollLeaveService');
const rn = require('../validators/payrollRunValidator');
const runs = require('../services/payrollRunService');
const overview = require('../services/payrollOverviewService');
const printed = require('../services/payrollReportService');
const payouts = require('../services/payrollPayoutService');
const attendanceReports = require('../services/payrollAttendanceReportService');
const adv = require('../validators/payrollAdvanceValidator');
const advances = require('../services/payrollAdvanceService');
const inv = require('../validators/payrollIncrementValidator');
const increments = require('../services/payrollIncrementService');
const ev2 = require('../validators/eobiValidator');
const eobi = require('../services/eobiService');
const itv = require('../validators/incomeTaxValidator');
const incomeTax = require('../services/incomeTaxService');

const PAYROLL_SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const read = requireAnyService(PAYROLL_SERVICES, 'VIEW');
const write = requireService('PAYROLL_EMPLOYEES', 'FULL');
const writeApplications = requireService('PAYROLL_APPLICATIONS', 'FULL');
const writeSalary = requireService('PAYROLL_SALARY', 'FULL');
const writeReports = requireService('PAYROLL_REPORTS', 'FULL');

const router = express.Router();
router.use(authenticate);

// every active master in one call, for the dropdowns
router.get('/masters', read, async (req, res) => res.json(await options(req)));

function crud(path, kind) {
  const m = masters[kind];
  const rules = v[kind];
  router.get(path, read, validate(rules.list), async (req, res) => res.json(await m.list(req, req.validatedQuery)));
  router.post(path, write, validate(rules.create), async (req, res) => res.status(201).json(await m.create(req, req.body)));
  router.get(`${path}/:id`, read, validate(rules.get), async (req, res) => res.json(await m.get(req, req.params.id)));
  router.patch(`${path}/:id`, write, validate(rules.update), async (req, res) => res.json(await m.update(req, req.params.id, req.body)));
  router.delete(`${path}/:id`, write, validate(rules.get), async (req, res) => { await m.remove(req, req.params.id); res.status(204).end(); });
}
for (const kind of ['groups', 'departments', 'designations', 'shifts', 'holidays', 'banks']) crud(`/${kind}`, kind);

// ---- the employee master ----
router.get('/employees', read, validate(ev.list), async (req, res) => res.json(await employees.list(req, req.validatedQuery)));
router.get('/employees/summary', read, async (req, res) => res.json(await employees.summary(req))); // before /:id
router.post('/employees', write, validate(ev.create), async (req, res) => res.status(201).json(await employees.create(req, req.body)));
router.get('/employees/:id', read, validate(ev.get), async (req, res) => res.json(await employees.get(req, req.params.id)));
router.patch('/employees/:id', write, validate(ev.update), async (req, res) => res.json(await employees.update(req, req.params.id, req.body)));
router.delete('/employees/:id', write, validate(ev.get), async (req, res) => { await employees.remove(req, req.params.id); res.status(204).end(); });
router.post('/employees/:id/confirm', write, validate(ev.get), async (req, res) => res.json(await employees.confirm(req, req.params.id)));
router.post('/employees/:id/unconfirm', write, validate(ev.get), async (req, res) => res.json(await employees.unconfirm(req, req.params.id)));
router.post('/employees/:id/close', write, validate(ev.close), async (req, res) => res.json(await employees.close(req, req.params.id, req.body)));
router.post('/employees/:id/reopen', write, validate(ev.get), async (req, res) => res.json(await employees.reopen(req, req.params.id)));

// documents: the file itself is the body of the request (Content-Type image/jpeg, image/png or application/pdf; up to 2 MB), saved in the database.
// The name comes from the X-File-Name header (or ?name=). Any status of the card may get documents. Download needs the login: send the bearer token.
const rawFile = express.raw({ type: ['image/jpeg', 'image/png', 'application/pdf', 'application/octet-stream'], limit: employees.MAX_FILE });
const fileName = (req) => {
  const n = req.headers['x-file-name'] || req.query.name || '';
  try { return decodeURIComponent(String(n)); } catch { return String(n); }
};
router.put('/employees/:id/files/:kind', write, validate(ev.file), rawFile,
  async (req, res) => res.json(await employees.saveFile(req, req.params.id, req.params.kind, { buffer: req.body, fileName: fileName(req) })));
router.get('/employees/:id/files/:kind', read, validate(ev.file), async (req, res) => {
  const f = await employees.readFile(req, req.params.id, req.params.kind);
  res.set({
    'Content-Type': f.mimeType, 'Content-Length': String(f.size), 'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
  });
  res.send(f.data);
});
router.delete('/employees/:id/files/:kind', write, validate(ev.file), async (req, res) => res.json(await employees.removeFile(req, req.params.id, req.params.kind)));

// ---- employee joining applications (the employee form filled by HR; DRAFT -> IN_REVIEW, the approval comes later) ----
router.get('/applications', read, validate(av.list), async (req, res) => res.json(await applications.list(req, req.validatedQuery)));
router.get('/applications/summary', read, async (req, res) => res.json(await applications.summary(req))); // before /:id
router.post('/applications', writeApplications, validate(av.create), async (req, res) => res.status(201).json(await applications.create(req, req.body)));
router.get('/applications/:id', read, validate(av.get), async (req, res) => res.json(await applications.get(req, req.params.id)));
router.patch('/applications/:id', writeApplications, validate(av.update), async (req, res) => res.json(await applications.update(req, req.params.id, req.body)));
router.delete('/applications/:id', writeApplications, validate(av.get), async (req, res) => { await applications.remove(req, req.params.id); res.status(204).end(); });
router.post('/applications/:id/submit', writeApplications, validate(av.get), async (req, res) => res.json(await applications.submit(req, req.params.id)));
router.post('/applications/:id/withdraw', writeApplications, validate(av.get), async (req, res) => res.json(await applications.withdraw(req, req.params.id)));
router.post('/applications/:id/reopen', writeApplications, validate(av.get), async (req, res) => res.json(await applications.reopen(req, req.params.id)));
// the review: a client admin or a chosen approver (checked inside); reading access to payroll is enough to open the screen
router.patch('/applications/:id/review', read, validate(av.review), async (req, res) => res.json(await applications.reviewUpdate(req, req.params.id, req.body)));
router.post('/applications/:id/approve', read, validate(av.get), async (req, res) => res.json(await applications.approve(req, req.params.id)));
router.post('/applications/:id/reject', read, validate(av.reject), async (req, res) => res.json(await applications.reject(req, req.params.id, req.body)));
router.get('/approvers', read, async (req, res) => res.json(await approvers.list(req)));
router.put('/approvers', write, validate(av.approvers), async (req, res) => res.json(await approvers.set(req, req.body.userIds)));
router.put('/applications/:id/files/:kind', writeApplications, validate(av.file), rawFile,
  async (req, res) => res.json(await applications.saveFile(req, req.params.id, req.params.kind, { buffer: req.body, fileName: fileName(req) })));
router.get('/applications/:id/files/:kind', read, validate(av.file), async (req, res) => {
  const f = await applications.readFile(req, req.params.id, req.params.kind);
  res.set({
    'Content-Type': f.mimeType, 'Content-Length': String(f.size), 'Cache-Control': 'private, max-age=60',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
  });
  res.send(f.data);
});
router.delete('/applications/:id/files/:kind', writeApplications, validate(av.file), async (req, res) => res.json(await applications.removeFile(req, req.params.id, req.params.kind)));

// ---- attendance: punches (Excel rows now, the machine API later), the days worked out from them, HR's corrections ----
// Reading: any payroll service. Changing: PAYROLL_SALARY with FULL access.
router.get('/attendance/overview', read, validate(tv.overview), async (req, res) => res.json(await attendance.overview(req, req.validatedQuery)));
router.post('/attendance/punches/preview', writeSalary, validate(tv.preview), async (req, res) => res.json(await attendance.preview(req, req.body)));
router.post('/attendance/punches/import', writeSalary, validate(tv.import), async (req, res) => { const out = await attendance.importRows(req, req.body); res.status(out.inserted ? 201 : 200).json(out); });
router.get('/attendance/punches', read, validate(tv.punches), async (req, res) => res.json(await attendance.punches(req, req.validatedQuery)));
router.get('/attendance/unmapped', read, validate(tv.unmapped), async (req, res) => res.json(await attendance.unmapped(req, req.validatedQuery)));
// month reports: the attendance report (code + in / out) and the punch report (every punch as it came), all employees, one employee, Excel
const month_ = (q) => ({ ...q, month: q.month });
router.get('/attendance/report', read, validate(tv.report), async (req, res) => {
  const { format, ...f } = req.validatedQuery;
  if (format === 'xlsx') return send(res, await attendanceReports.attendanceReportXlsx(req, f), XLSX);
  return res.json(await attendanceReports.attendanceReport(req, f));
});
router.get('/attendance/report/employees/:id', read, validate(tv.reportEmployee), async (req, res) => {
  if (req.validatedQuery.format === 'xlsx') return send(res, await attendanceReports.attendanceEmployeeXlsx(req, req.params.id, month_(req.validatedQuery)), XLSX);
  return res.json(await attendanceReports.attendanceEmployee(req, req.params.id, month_(req.validatedQuery)));
});
router.get('/attendance/punch-report', read, validate(tv.report), async (req, res) => {
  const { format, ...f } = req.validatedQuery;
  if (format === 'xlsx') return send(res, await attendanceReports.punchReportXlsx(req, f), XLSX);
  return res.json(await attendanceReports.punchReport(req, f));
});
router.get('/attendance/punch-report/employees/:id', read, validate(tv.reportEmployee), async (req, res) => {
  if (req.validatedQuery.format === 'xlsx') return send(res, await attendanceReports.punchEmployeeXlsx(req, req.params.id, month_(req.validatedQuery)), XLSX);
  return res.json(await attendanceReports.punchEmployee(req, req.params.id, month_(req.validatedQuery)));
});
router.get('/attendance/batches', read, validate(tv.batches), async (req, res) => res.json(await attendance.batches(req, req.validatedQuery)));
router.delete('/attendance/batches/:id', writeSalary, validate(tv.batch), async (req, res) => res.json(await attendance.undoBatch(req, req.params.id)));
router.get('/attendance/devices', read, async (req, res) => res.json(await attendance.devices(req)));
router.patch('/attendance/devices/:id', writeSalary, validate(tv.device), async (req, res) => res.json(await attendance.updateDevice(req, req.params.id, req.body)));
router.post('/attendance/fetch', writeSalary, validate(tv.fetch), async (req, res) => res.json(await attendance.fetchFromApi(req, req.body)));
router.post('/attendance/process', writeSalary, validate(tv.process), async (req, res) => res.json(await attendance.process(req, req.body)));
router.get('/attendance/days', read, validate(tv.days), async (req, res) => res.json(await attendance.days(req, req.validatedQuery)));
router.get('/attendance/summary', read, validate(tv.days), async (req, res) => res.json(await attendance.summary(req, req.validatedQuery)));
router.get('/attendance/daily', read, validate(tv.daily), async (req, res) => res.json(await attendance.daily(req, req.validatedQuery)));
router.patch('/attendance/days/:employeeId/:date', writeSalary, validate(tv.editDay), async (req, res) => res.json(await attendance.editDay(req, req.params.employeeId, req.params.date, req.body)));
router.delete('/attendance/days/:employeeId/:date', writeSalary, validate(tv.day), async (req, res) => res.json(await attendance.resetDay(req, req.params.employeeId, req.params.date)));

// ---- resignation applications (an employee leaving; DRAFT -> IN_REVIEW -> APPROVED posts it and closes the employee card) ----
// Reading: any payroll service. HR (PAYROLL_APPLICATIONS FULL) writes and sends; the review calls are for a client admin or a chosen approver (checked inside).
router.get('/resignations', read, validate(rv.list), async (req, res) => res.json(await resignations.list(req, req.validatedQuery)));
router.get('/resignations/summary', read, async (req, res) => res.json(await resignations.summary(req))); // before /:id
router.get('/resignations/absentees', read, validate(rv.absentees), async (req, res) => res.json(await resignations.absentees(req, req.validatedQuery)));
router.post('/resignations', writeApplications, validate(rv.create), async (req, res) => res.status(201).json(await resignations.create(req, req.body)));
router.get('/resignations/:id', read, validate(rv.get), async (req, res) => res.json(await resignations.get(req, req.params.id)));
router.patch('/resignations/:id', writeApplications, validate(rv.update), async (req, res) => res.json(await resignations.update(req, req.params.id, req.body)));
router.delete('/resignations/:id', writeApplications, validate(rv.get), async (req, res) => { await resignations.remove(req, req.params.id); res.status(204).end(); });
router.post('/resignations/:id/submit', writeApplications, validate(rv.get), async (req, res) => res.json(await resignations.submit(req, req.params.id)));
router.post('/resignations/:id/withdraw', writeApplications, validate(rv.get), async (req, res) => res.json(await resignations.withdraw(req, req.params.id)));
router.post('/resignations/:id/reopen', writeApplications, validate(rv.get), async (req, res) => res.json(await resignations.reopen(req, req.params.id)));
router.patch('/resignations/:id/review', read, validate(rv.review), async (req, res) => res.json(await resignations.reviewUpdate(req, req.params.id, req.body)));
router.post('/resignations/:id/approve', read, validate(rv.get), async (req, res) => res.json(await resignations.approve(req, req.params.id)));
router.post('/resignations/:id/reject', read, validate(rv.reject), async (req, res) => res.json(await resignations.reject(req, req.params.id, req.body)));

// ---- employee loan applications (DRAFT -> IN_REVIEW -> APPROVED; the money is paid by an Employee Loan Voucher of the accounting module) ----
router.get('/loans', read, validate(lv.list), async (req, res) => res.json(await loansSvc.list(req, req.validatedQuery)));
router.get('/loans/summary', read, async (req, res) => res.json(await loansSvc.summary(req))); // before /:id
router.post('/loans', writeApplications, validate(lv.create), async (req, res) => res.status(201).json(await loansSvc.create(req, req.body)));
router.get('/loans/:id', read, validate(lv.get), async (req, res) => res.json(await loansSvc.get(req, req.params.id)));
router.patch('/loans/:id', writeApplications, validate(lv.update), async (req, res) => res.json(await loansSvc.update(req, req.params.id, req.body)));
router.delete('/loans/:id', writeApplications, validate(lv.get), async (req, res) => { await loansSvc.remove(req, req.params.id); res.status(204).end(); });
router.post('/loans/:id/submit', writeApplications, validate(lv.get), async (req, res) => res.json(await loansSvc.submit(req, req.params.id)));
router.post('/loans/:id/withdraw', writeApplications, validate(lv.get), async (req, res) => res.json(await loansSvc.withdraw(req, req.params.id)));
router.post('/loans/:id/reopen', writeApplications, validate(lv.get), async (req, res) => res.json(await loansSvc.reopen(req, req.params.id)));
router.patch('/loans/:id/review', read, validate(lv.review), async (req, res) => res.json(await loansSvc.reviewUpdate(req, req.params.id, req.body)));
router.post('/loans/:id/approve', read, validate(lv.get), async (req, res) => res.json(await loansSvc.approve(req, req.params.id)));
router.post('/loans/:id/reject', read, validate(lv.reject), async (req, res) => res.json(await loansSvc.reject(req, req.params.id, req.body)));
// attachments: the file is the raw body (as for the employee documents); each upload is a new attachment with its own key
router.post('/loans/:id/attachments', writeApplications, validate(lv.get), rawFile, async (req, res) => res.status(201).json(await loansSvc.addAttachment(req, req.params.id, { buffer: req.body, fileName: fileName(req) })));
router.get('/loans/:id/attachments/:key', read, validate(lv.attachment), async (req, res) => {
  const f = await loansSvc.readAttachment(req, req.params.id, req.params.key);
  res.set({ 'Content-Type': f.mimeType, 'Content-Length': String(f.size), 'Cache-Control': 'private, max-age=60', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}` });
  res.send(f.data);
});
router.delete('/loans/:id/attachments/:key', writeApplications, validate(lv.attachment), async (req, res) => res.json(await loansSvc.removeAttachment(req, req.params.id, req.params.key)));

// ---- leave applications (annual leave, from the balance the policy gives) and the Annual Leaves report ----
router.get('/leaves', read, validate(vv.list), async (req, res) => res.json(await leaves.list(req, req.validatedQuery)));
router.get('/leaves/summary', read, async (req, res) => res.json(await leaves.summary(req))); // before /:id
router.get('/leaves/preview', read, validate(vv.preview), async (req, res) => res.json(await leaves.preview(req, req.validatedQuery)));
router.get('/leaves/balance', read, validate(vv.balance), async (req, res) => res.json(await leaves.balance(req, req.validatedQuery)));
router.post('/leaves', writeApplications, validate(vv.create), async (req, res) => res.status(201).json(await leaves.create(req, req.body)));
router.get('/leaves/:id', read, validate(vv.get), async (req, res) => res.json(await leaves.get(req, req.params.id)));
router.patch('/leaves/:id', writeApplications, validate(vv.update), async (req, res) => res.json(await leaves.update(req, req.params.id, req.body)));
router.delete('/leaves/:id', writeApplications, validate(vv.get), async (req, res) => { await leaves.remove(req, req.params.id); res.status(204).end(); });
router.post('/leaves/:id/submit', writeApplications, validate(vv.get), async (req, res) => res.json(await leaves.submit(req, req.params.id)));
router.post('/leaves/:id/withdraw', writeApplications, validate(vv.get), async (req, res) => res.json(await leaves.withdraw(req, req.params.id)));
router.post('/leaves/:id/reopen', writeApplications, validate(vv.get), async (req, res) => res.json(await leaves.reopen(req, req.params.id)));
router.patch('/leaves/:id/review', read, validate(vv.review), async (req, res) => res.json(await leaves.reviewUpdate(req, req.params.id, req.body)));
router.post('/leaves/:id/approve', read, validate(vv.get), async (req, res) => res.json(await leaves.approve(req, req.params.id)));
router.post('/leaves/:id/reject', read, validate(vv.reject), async (req, res) => res.json(await leaves.reject(req, req.params.id, req.body)));
router.post('/leaves/:id/cancel', read, validate(vv.cancel), async (req, res) => res.json(await leaves.cancel(req, req.params.id, req.body)));
router.get('/reports/annual-leaves', read, validate(vv.annualLeaves), async (req, res) => res.json(await leaves.annualLeaves(req, req.validatedQuery)));
router.get('/reports/annual-leaves/:id', read, validate(vv.statement), async (req, res) => res.json(await leaves.employeeStatement(req, req.params.id, req.validatedQuery)));

// ---- the payroll: a payroll per class and month, its payslips, their flow and the changes HR makes ----
// Reading: any payroll service. HR (PAYROLL_SALARY FULL) makes the payroll, changes payslips and sends them to Review; the reviewers (a client admin or a chosen approver, checked inside) move them on.
router.get('/overview', read, validate(rn.overview), async (req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(await overview.get(req, req.validatedQuery));
});
// salary increments during the year (Salary > Salary Increment): HR makes and submits (PAYROLL_APPLICATIONS FULL), the approvers review and post
const sendText = (res, f) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${f.fileName}"` }); res.send(f.text); };
router.get('/increments', read, validate(inv.list), async (req, res) => res.json(await increments.list(req, req.validatedQuery)));
router.get('/increments/csv', read, validate(inv.csv), async (req, res) => sendText(res, await increments.csv(req, req.validatedQuery)));
router.get('/increments/sample.csv', read, async (req, res) => sendText(res, increments.sampleCsv()));
router.get('/increments/employees', read, validate(inv.employees), async (req, res) => res.json(await increments.employees(req, req.validatedQuery)));
router.post('/increments', writeApplications, validate(inv.create), async (req, res) => res.status(201).json(await increments.create(req, req.body)));
router.post('/increments/import', writeApplications, validate(inv.import), async (req, res) => res.json(await increments.importRows(req, req.body)));
for (const [action, guard] of [['submit', writeApplications], ['withdraw', writeApplications], ['final-review', read], ['approve', read], ['send-back', read], ['reject', read]]) {
  router.post(`/increments/bulk/${action}`, guard, validate(action === 'reject' ? inv.bulkReject : inv.bulk), async (req, res) => res.json(await increments.moveMany(req, req.body.ids, action, { reason: req.body.reason })));
}
router.get('/increments/:id', read, validate(inv.get), async (req, res) => res.json(await increments.get(req, req.params.id)));
router.patch('/increments/:id', writeApplications, validate(inv.update), async (req, res) => res.json(await increments.update(req, req.params.id, req.body)));
router.delete('/increments/:id', writeApplications, validate(inv.get), async (req, res) => { await increments.remove(req, req.params.id); res.status(204).end(); });
for (const [action, guard] of [['submit', writeApplications], ['withdraw', writeApplications], ['final-review', read], ['approve', read], ['send-back', read]]) {
  router.post(`/increments/:id/${action}`, guard, validate(inv.get), async (req, res) => res.json(await increments.move(req, req.params.id, action)));
}
router.post('/increments/:id/reject', read, validate(inv.reject), async (req, res) => res.json(await increments.move(req, req.params.id, 'reject', { reason: req.body.reason })));

// the printed side: salary sheet and attendance sheet (data or Excel), payslip PDFs
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const send = (res, file, type) => {
  res.set({ 'Content-Type': type, 'Content-Length': String(file.buffer.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}` });
  res.end(file.buffer);
};
router.get('/runs/:id/salary-sheet', read, validate(rn.sheet), async (req, res) => {
  if (req.validatedQuery.format === 'xlsx') return send(res, await printed.salarySheetXlsx(req, req.params.id), XLSX);
  return res.json(await printed.salarySheet(req, req.params.id));
});
router.get('/runs/:id/attendance-sheet', read, validate(rn.sheet), async (req, res) => {
  if (req.validatedQuery.format === 'xlsx') return send(res, await printed.attendanceSheetXlsx(req, req.params.id), XLSX);
  return res.json(await printed.attendanceSheet(req, req.params.id));
});
// advances (Applications > Advance): no approval; HR writes them down (PAYROLL_APPLICATIONS FULL), the accountant pays them with an advance voucher, the next payroll takes them back
router.get('/advances', read, validate(adv.list), async (req, res) => res.json(await advances.list(req, req.validatedQuery)));
router.get('/advances/summary', read, async (req, res) => res.json(await advances.summary(req)));
router.get('/advances/employee/:id', read, validate(adv.employee), async (req, res) => res.json(await advances.employeeInfo(req, req.params.id)));
router.post('/advances', writeApplications, validate(adv.create), async (req, res) => res.status(201).json(await advances.create(req, req.body)));
router.get('/advances/:id', read, validate(adv.get), async (req, res) => res.json(await advances.get(req, req.params.id)));
router.patch('/advances/:id', writeApplications, validate(adv.update), async (req, res) => res.json(await advances.update(req, req.params.id, req.body)));
router.delete('/advances/:id', writeApplications, validate(adv.get), async (req, res) => { await advances.remove(req, req.params.id); res.status(204).end(); });

// paying the salary: the bank upload file (made and kept, can be made again) and the cash sheet with the notes
const sendCsv = (res, f) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}` }); res.send(f.text); };
router.get('/runs/:id/bank-file', read, validate(rn.bankFile), async (req, res) => res.json(await payouts.bankPreview(req, req.params.id, req.validatedQuery)));
router.get('/runs/:id/bank-files', read, validate(rn.get), async (req, res) => res.json(await payouts.bankFiles(req, req.params.id)));
router.post('/runs/:id/bank-file', writeSalary, validate(rn.makeBankFile), async (req, res) => res.status(201).json(await payouts.createBankFile(req, req.params.id, req.body)));
router.get('/bank-files/:id/download', read, validate(rn.slip), async (req, res) => sendCsv(res, await payouts.bankFileDownload(req, req.params.id)));
router.get('/runs/:id/cash-sheet', read, validate(rn.cashSheet), async (req, res) => {
  const { format, ...opts } = req.validatedQuery;
  if (format === 'xlsx') return send(res, await payouts.cashSheetXlsx(req, req.params.id, opts), XLSX);
  if (format === 'pdf') return send(res, await payouts.cashSheetPdf(req, req.params.id, opts), 'application/pdf');
  return res.json(await payouts.cashSheet(req, req.params.id, opts));
});
router.get('/runs/:id/payslips.pdf', read, validate(rn.get), async (req, res) => send(res, await printed.runPayslipsPdf(req, req.params.id), 'application/pdf'));
router.get('/slips/:id/pdf', read, validate(rn.slip), async (req, res) => send(res, await printed.payslipPdf(req, req.params.id), 'application/pdf'));
router.get('/runs', read, validate(rn.list), async (req, res) => res.json(await runs.listRuns(req, req.validatedQuery)));
router.post('/runs', writeSalary, validate(rn.create), async (req, res) => res.status(201).json(await runs.createRun(req, req.body)));
router.get('/runs/:id', read, validate(rn.get), async (req, res) => res.json(await runs.getRun(req, req.params.id)));
router.delete('/runs/:id', writeSalary, validate(rn.get), async (req, res) => { await runs.removeRun(req, req.params.id); res.status(204).end(); });
router.patch('/runs/:id/policy', writeSalary, validate(rn.policy), async (req, res) => res.json(await runs.setPolicy(req, req.params.id, req.body)));
router.post('/runs/:id/add-employees', writeSalary, validate(rn.get), async (req, res) => res.json(await runs.addMissing(req, req.params.id)));
router.get('/runs/:id/slips', read, validate(rn.slips), async (req, res) => res.json(await runs.listSlips(req, req.params.id, req.validatedQuery)));
router.get('/runs/:id/attendance', read, validate(rn.get), async (req, res) => res.json(await runs.runAttendance(req, req.params.id)));
// moving payslips to Review is HR's step (PAYROLL_SALARY FULL); the other steps are the reviewers' (checked inside)
router.post('/runs/:id/slips/move', validate(rn.moveMany), (req, res, next) => (req.body.action === 'review' ? writeSalary : read)(req, res, next), async (req, res) => res.json(await runs.moveMany(req, req.params.id, req.body)));
router.get('/slips/:id', read, validate(rn.slip), async (req, res) => res.json(await runs.getSlip(req, req.params.id)));
router.patch('/slips/:id', writeSalary, validate(rn.updateSlip), async (req, res) => res.json(await runs.updateSlip(req, req.params.id, req.body)));
router.delete('/slips/:id', writeSalary, validate(rn.slip), async (req, res) => { await runs.removeSlip(req, req.params.id); res.status(204).end(); });
router.put('/slips/:id/days/:date', writeSalary, validate(rn.day), async (req, res) => res.json(await runs.editDay(req, req.params.id, req.params.date, req.body)));
router.post('/slips/:id/get-attendance', writeSalary, validate(rn.slip), async (req, res) => res.json(await runs.getAttendance(req, req.params.id)));
router.post('/slips/:id/calculate', writeSalary, validate(rn.calculate), async (req, res) => res.json(await runs.calculateSlip(req, req.params.id, req.body)));
router.post('/slips/:id/suspend', writeSalary, validate(rn.suspend), async (req, res) => res.json(await runs.suspend(req, req.params.id, req.body)));
router.post('/slips/:id/resume', writeSalary, validate(rn.slip), async (req, res) => res.json(await runs.resume(req, req.params.id)));
router.post('/slips/:id/review', writeSalary, validate(rn.slip), async (req, res) => res.json(await runs.move(req, req.params.id, 'review')));
router.post('/slips/:id/final-review', read, validate(rn.slip), async (req, res) => res.json(await runs.move(req, req.params.id, 'final-review')));
router.post('/slips/:id/approve', read, validate(rn.slip), async (req, res) => res.json(await runs.move(req, req.params.id, 'approve')));
router.post('/slips/:id/send-back', read, validate(rn.slip), async (req, res) => res.json(await runs.move(req, req.params.id, 'send-back')));

// ---- EOBI (Reports > Employees Contribution): the rates, the lists of a provider and month, their locations; read: any payroll service, change: PAYROLL_REPORTS FULL ----
// income tax of the employees (the employee list: edit by hand or upload a sheet); the report of what was withheld and paid
router.get('/income-tax', read, validate(itv.list), async (req, res) => res.json(await incomeTax.list(req, req.validatedQuery)));
router.get('/income-tax/report', read, validate(itv.report), async (req, res) => res.json(await incomeTax.report(req, req.validatedQuery)));
router.post('/income-tax/import', write, validate(itv.import), async (req, res) => res.json(await incomeTax.importRows(req, req.body)));
router.get('/income-tax/employees/:id', read, validate(itv.employee), async (req, res) => res.json(await incomeTax.history(req, req.params.id)));
router.put('/income-tax/employees/:id', write, validate(itv.set), async (req, res) => res.json(await incomeTax.set(req, req.params.id, req.body)));
router.delete('/income-tax/:id', write, validate(itv.removeRow), async (req, res) => { await incomeTax.removeRow(req, req.params.id); res.status(204).end(); });

router.get('/eobi/providers', read, async (req, res) => res.json(await eobi.providers(req)));
router.post('/eobi/providers', writeReports, validate(ev2.providers.create), async (req, res) => res.status(201).json(await eobi.createProvider(req, req.body)));
router.patch('/eobi/providers/:id', writeReports, validate(ev2.providers.update), async (req, res) => res.json(await eobi.updateProvider(req, req.params.id, req.body)));
router.delete('/eobi/providers/:id', writeReports, validate(ev2.get), async (req, res) => { await eobi.removeProvider(req, req.params.id); res.status(204).end(); });
router.post('/eobi/locations', writeReports, validate(ev2.locations.create), async (req, res) => res.status(201).json(await eobi.createLocation(req, req.body)));
router.patch('/eobi/locations/:id', writeReports, validate(ev2.locations.update), async (req, res) => res.json(await eobi.updateLocation(req, req.params.id, req.body)));
router.delete('/eobi/locations/:id', writeReports, validate(ev2.get), async (req, res) => { await eobi.removeLocation(req, req.params.id); res.status(204).end(); });
router.get('/eobi/rates', read, validate(ev2.rates.list), async (req, res) => res.json(await eobi.listRates(req, req.validatedQuery)));
router.put('/eobi/rates', writeReports, validate(ev2.rates.save), async (req, res) => res.json(await eobi.saveRate(req, req.body)));
router.delete('/eobi/rates/:id', writeReports, validate(ev2.get), async (req, res) => { await eobi.removeRate(req, req.params.id); res.status(204).end(); });
router.get('/eobi/summary', read, validate(ev2.summary), async (req, res) => res.json(await eobi.summary(req, req.validatedQuery)));
router.get('/eobi/lists', read, validate(ev2.view), async (req, res) => res.json(await eobi.view(req, req.validatedQuery)));
router.post('/eobi/lists', writeReports, validate(ev2.create), async (req, res) => res.status(201).json(await eobi.createList(req, req.body)));
router.delete('/eobi/lists/:id', writeReports, validate(ev2.get), async (req, res) => { await eobi.removeList(req, req.params.id); res.status(204).end(); });
router.get('/eobi/lists/:id/candidates', read, validate(ev2.candidates), async (req, res) => res.json(await eobi.candidates(req, req.params.id, req.validatedQuery)));
router.post('/eobi/lists/:id/rows', writeReports, validate(ev2.addRows), async (req, res) => res.status(201).json(await eobi.addRows(req, req.params.id, req.body)));
router.post('/eobi/lists/:id/rows/remove', writeReports, validate(ev2.removeRows), async (req, res) => res.json(await eobi.removeRows(req, req.params.id, req.body)));
router.put('/eobi/lists/:id/rows/locations', writeReports, validate(ev2.setLocations), async (req, res) => res.json(await eobi.setLocations(req, req.params.id, req.body)));
router.post('/eobi/lists/:id/recalculate', writeReports, validate(ev2.get), async (req, res) => res.json(await eobi.recalculate(req, req.params.id)));
router.post('/eobi/lists/:id/import', writeReports, validate(ev2.import), async (req, res) => res.json(await eobi.importRows(req, req.params.id, req.body)));

// ---- the policy of each group (versions from a month) ----
router.get('/policies', read, validate(pv.list), async (req, res) => res.json(await policies.list(req, req.validatedQuery)));
router.get('/policies/by-group', read, validate(pv.byGroup), async (req, res) => res.json(await policies.byGroup(req, req.validatedQuery))); // before /:id
router.get('/policies/effective', read, validate(pv.effective), async (req, res) => res.json(await policies.effective(req, req.validatedQuery)));
router.post('/policies', write, validate(pv.create), async (req, res) => res.status(201).json(await policies.create(req, req.body)));
router.get('/policies/:id', read, validate(pv.get), async (req, res) => res.json(await policies.get(req, req.params.id)));
router.patch('/policies/:id', write, validate(pv.update), async (req, res) => res.json(await policies.update(req, req.params.id, req.body)));
router.delete('/policies/:id', write, validate(pv.get), async (req, res) => { await policies.remove(req, req.params.id); res.status(204).end(); });

module.exports = router;
