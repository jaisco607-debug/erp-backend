// Employee loan applications (service PAYROLL_APPLICATIONS to change, any payroll service to read).
//   DRAFT -> IN_REVIEW -> APPROVED (or REJECTED), like the other applications: HR makes and sends it, a client admin or a chosen approver reviews it.
//   The loan can never be more than the employee's current (basic) salary. HR chooses the number of monthly instalments (1 to 12) and the month the deduction starts;
//   the instalments are worked out from them (utils/loanSchedule) and the payroll takes one from each month's salary from that month on.
//   Approving does not pay anything: the money is paid out by an Employee Loan Voucher of the accounting module (Debit Employee Loans, Credit Bank / Cash),
//   which may pay the loan in more than one piece. balance = what the confirmed vouchers paid less what the payroll deducted (the deductions come from the payroll run).
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { schedule, monthCode } = require('../utils/loanSchedule');
const accountService = require('./accountService');
const audit = require('./auditService');
const { isApprover } = require('./payrollApproverService');
const { detect, cleanName, MAX_FILE } = require('./payrollEmployeeService');
const { amountCents } = require('./voucherSupport');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const money = (c) => fromCents(c);
const STATUS_TEXT = { DRAFT: 'Draft', IN_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected' };
const OWNER = 'LOAN';
const MAX_ATTACHMENTS = 5;
const ATTACHMENT_KEY = /^ATT_[0-9a-f]{10}$/;
const NIL = '00000000-0000-0000-0000-000000000000';

const PAID = `COALESCE((SELECT SUM(v.amount) FROM employee_loan_vouchers v WHERE v."loanId" = l.id AND v.status = 'CONFIRMED'), 0)`;
const DEDUCTED = 'COALESCE((SELECT SUM(x.amount) FROM payroll_loan_deductions x WHERE x."loanId" = l.id), 0)';
const SELECT = `l.id, l.code, l.status, l."employeeId", to_char(l."applicationDate", 'YYYY-MM-DD') AS "applicationDate", l."appliedAmount"::text AS applied, l."approvedAmount"::text AS approved,
  l.months, to_char(l."deductFrom", 'YYYY-MM') AS "deductFrom", l.remarks, l."salaryAtApproval"::text AS "salaryAtApproval", l."submittedAt", sb.name AS "submittedByName",
  l."approvedAt", ab.name AS "approvedByName", l."rejectedAt", rb.name AS "rejectedByName", l."rejectReason", l."createdAt", l."updatedAt",
  e.code AS "empCode", e.name AS "empName", e."fatherName", e.cnic, e."isClosed", to_char(e."joiningDate", 'YYYY-MM-DD') AS "joiningDate", e."basicSalary"::text AS salary,
  e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName",
  EXISTS (SELECT 1 FROM payroll_files f WHERE f."ownerType" = 'EMPLOYEE' AND f."ownerId" = e.id AND f.kind = 'PHOTO') AS "hasPhoto",
  ${PAID}::text AS paid, COALESCE((SELECT SUM(v.amount) FROM employee_loan_vouchers v WHERE v."loanId" = l.id AND v.status = 'DRAFT'), 0)::text AS "draftPaid", ${DEDUCTED}::text AS deducted`;
const FROM = `payroll_loans l JOIN payroll_employees e ON e.id = l."employeeId" JOIN payroll_groups g ON g.id = e."groupId"
  LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"
  LEFT JOIN users sb ON sb.id = l."submittedById" LEFT JOIN users ab ON ab.id = l."approvedById" LEFT JOIN users rb ON rb.id = l."rejectedById"`;

/** "1y 2m": whole months between two dates (YYYY-MM-DD). */
function serviceText(from, to) {
  const a = from.split('-').map(Number);
  const b = to.split('-').map(Number);
  let months = (b[0] - a[0]) * 12 + (b[1] - a[1]);
  if (b[2] < a[2]) months -= 1;
  if (months < 0) months = 0;
  return `${Math.floor(months / 12)}y ${months % 12}m`;
}

function json(r, approver = false) {
  const draft = r.status === 'DRAFT';
  const inReview = r.status === 'IN_REVIEW';
  const applied = toCents(r.applied);
  const approved = r.approved == null ? null : toCents(r.approved);
  const paid = toCents(r.paid);
  const deducted = toCents(r.deducted);
  const plan = schedule(approved == null ? applied : approved, r.months, r.deductFrom);
  const isApproved = r.status === 'APPROVED';
  const toPay = isApproved ? approved - paid : 0n;
  return {
    id: r.id, code: r.code, appId: pad5(r.code), label: `Application # ${r.code}`, status: r.status, statusText: STATUS_TEXT[r.status],
    employee: {
      id: r.employeeId, code: r.empCode, label: pad5(r.empCode), name: r.empName, fatherName: r.fatherName, cnic: r.cnic, group: { id: r.groupId, name: r.groupName },
      department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, designation: r.designationName, joiningDate: r.joiningDate,
      service: serviceText(r.joiningDate, today()), salary: money(toCents(r.salary)), hasPhoto: r.hasPhoto, isClosed: r.isClosed,
    },
    applicationDate: r.applicationDate, applied: money(applied), approved: approved == null ? null : money(approved), months: r.months,
    deductFrom: r.deductFrom, deductFromCode: monthCode(r.deductFrom), emi: money(plan[0].cents), remarks: r.remarks,
    paid: money(paid), deducted: money(deducted), balance: money(paid - deducted), toPay: money(toPay), draftPayments: money(toCents(r.draftPaid)),
    salaryAtApproval: r.salaryAtApproval == null ? null : money(toCents(r.salaryAtApproval)),
    submittedAt: r.submittedAt, submittedBy: r.submittedByName || null,
    approval: isApproved ? { by: r.approvedByName, at: r.approvedAt } : r.status === 'REJECTED' ? { by: r.rejectedByName, at: r.rejectedAt, reason: r.rejectReason } : null,
    canEdit: draft, canDelete: draft, canSubmit: draft, canWithdraw: inReview, canReopen: r.status === 'REJECTED',
    canReviewEdit: inReview && approver, canApprove: inReview && approver, canReject: inReview && approver, canPay: isApproved && toPay > 0n,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** The instalment schedule with its total: [{ month, label, emi }]. */
function scheduleJson(r) {
  const total = r.approved == null ? toCents(r.applied) : toCents(r.approved);
  const rows = schedule(total, r.months, r.deductFrom).map((s) => ({ month: s.month, label: s.label, emi: money(s.cents) }));
  return { rows, total: money(total) };
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE l.id = :id AND l."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Loan application');
  return r;
}
async function lockRow(companyId, id, transaction) {
  const [cur] = await q('SELECT * FROM payroll_loans WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!cur) throw AppError.notFound('Loan application');
  return cur;
}

/** The whole answer: the application with its schedule, the employee's present loans, the vouchers paid against it, the deductions and the documents. */
async function get(req, id, transaction) {
  const { companyId } = req.user;
  const r = await loadRow(companyId, id, transaction);
  const out = json(r, await isApprover(req));
  out.schedule = scheduleJson(r);
  const [cur] = await q(`SELECT COALESCE(SUM(${PAID} - ${DEDUCTED}), 0)::text AS n FROM payroll_loans l WHERE l."employeeId" = :employeeId AND l.status = 'APPROVED'`, { employeeId: r.employeeId }, transaction);
  out.employee.currentLoan = money(toCents(cur.n));
  out.employee.currentAdvance = '0.00'; // the salary advance comes with its own application
  const prev = await q(`SELECT l.id, l.code, l.status, to_char(l."applicationDate", 'YYYY-MM-DD') AS date, l."appliedAmount"::text AS applied, (${PAID} - ${DEDUCTED})::text AS balance
    FROM payroll_loans l WHERE l."employeeId" = :employeeId AND l.id <> :id ORDER BY l.code DESC LIMIT 10`, { employeeId: r.employeeId, id }, transaction);
  out.previousLoans = prev.map((p) => ({ id: p.id, appId: pad5(p.code), date: p.date, applied: money(toCents(p.applied)), balance: money(toCents(p.balance)), status: p.status, statusText: STATUS_TEXT[p.status] }));
  const vouchers = await q(`SELECT v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS date, a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", v."refNo", v.notes, v.amount::text AS amount, v.status
    FROM employee_loan_vouchers v JOIN accounts a ON a.id = v."payFromAccountId" WHERE v."loanId" = :id ORDER BY v."voucherNo"`, { id }, transaction);
  out.payments = vouchers.map((v) => ({ voucherId: v.id, voucherNo: v.voucherNo, voucherLabel: voucherLabel(v.voucherNo), date: v.date, paidFrom: { id: v.accountId, code: v.accountCode, name: v.accountName },
    refNo: v.refNo, remarks: v.notes, amount: money(toCents(v.amount)), status: v.status, statusText: v.status === 'CONFIRMED' ? 'Confirmed' : 'Draft' }));
  const deductions = await q(`SELECT x.id, to_char(x.month, 'YYYY-MM') AS month, x.amount::text AS amount, x.source, x."payrollId" FROM payroll_loan_deductions x WHERE x."loanId" = :id ORDER BY x.month, x."createdAt"`, { id }, transaction);
  out.deductions = deductions.map((x) => ({ id: x.id, month: x.month, amount: money(toCents(x.amount)), source: x.source, payrollId: x.payrollId }));
  out.attachments = await attachmentsOf(id, transaction);
  return out;
}

const voucherLabel = (n) => `ELV-${pad5(n)}`;

async function list(req, f) {
  const { companyId } = req.user;
  const where = ['l."companyId" = :companyId'];
  const repl = { companyId };
  if (f.status) { where.push('l.status = :status'); repl.status = f.status; }
  if (f.departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = f.departmentId; }
  if (f.groupId) { where.push('e."groupId" = :groupId'); repl.groupId = f.groupId; }
  if (f.employeeId) { where.push('l."employeeId" = :employeeId'); repl.employeeId = f.employeeId; }
  if (f.from) { where.push('l."applicationDate" >= :from'); repl.from = f.from; }
  if (f.to) { where.push('l."applicationDate" <= :to'); repl.to = f.to; }
  if (f.balanceOnly) where.push(`l.status = 'APPROVED' AND ${PAID} - ${DEDUCTED} > 0`);
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR l.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like OR replace(e.cnic, '-', '') ILIKE :like OR d.name ILIKE :like OR l.remarks ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [t] = await q(`SELECT count(*)::int AS n, COALESCE(SUM(l."appliedAmount"), 0)::text AS applied, COALESCE(SUM(l."approvedAmount") FILTER (WHERE l.status = 'APPROVED'), 0)::text AS approved,
      COALESCE(SUM(${PAID} - ${DEDUCTED}) FILTER (WHERE l.status = 'APPROVED'), 0)::text AS balance FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY l.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const approver = await isApprover(req);
  return { data: rows.map((r) => json(r, approver)), page, limit, total: t.n, totals: { applied: money(toCents(t.applied)), approved: money(toCents(t.approved)), balance: money(toCents(t.balance)) } };
}

/** The numbers of the tabs: Applications, Draft, Review, Rejected, Balance (loans paid out that are not repaid yet). */
async function summary(req) {
  const [t] = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE l.status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE l.status = 'IN_REVIEW')::int AS "inReview",
      count(*) FILTER (WHERE l.status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE l.status = 'APPROVED')::int AS approved,
      count(*) FILTER (WHERE l.status = 'APPROVED' AND ${PAID} - ${DEDUCTED} > 0)::int AS balance
    FROM payroll_loans l WHERE l."companyId" = :companyId`, { companyId: req.user.companyId });
  return t;
}

// ---- the rules of a loan ----

/**
 * The employee works here, the amounts are more than zero and not more than his salary, the approved amount is not more than the applied one, the instalments
 * are at least a rupee each, and the deduction does not start before the month of the application.
 */
async function checkTerms(companyId, { employeeId, applicationDate, applied, approved, months, deductFrom }, transaction) {
  const [e] = await q('SELECT id, code, name, "isClosed", "basicSalary"::text AS salary FROM payroll_employees WHERE id = :employeeId AND "companyId" = :companyId', { employeeId, companyId }, transaction);
  if (!e) throw AppError.notFound('Employee');
  if (e.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', `${e.name} (ID ${e.code}) has left the company`);
  if (applicationDate > today()) throw AppError.rule('DATE_IN_FUTURE', 'The application date cannot be in the future');
  if (deductFrom < applicationDate.slice(0, 7)) throw AppError.rule('DEDUCT_FROM_BEFORE_APPLICATION', 'The deduction cannot start before the month of the application', { applicationMonth: applicationDate.slice(0, 7) });
  const salary = toCents(e.salary);
  for (const [name, c] of [['applied', applied], ['approved', approved]]) {
    if (c == null) continue;
    if (c > salary) throw AppError.rule('LOAN_MORE_THAN_SALARY', `The ${name} amount ${money(c)} is more than the salary of the employee (${money(salary)}): a loan cannot be more than the salary`, { salary: money(salary), amount: money(c) });
    if (c < BigInt(months) * 100n) throw AppError.rule('LOAN_TOO_SMALL_FOR_PERIOD', `The ${name} amount ${money(c)} is too small to be paid in ${months} months: each instalment must be at least Rs 1`, { months });
  }
  if (approved != null && approved > applied) throw AppError.rule('APPROVED_MORE_THAN_APPLIED', 'The approved amount cannot be more than the applied amount', { applied: money(applied), approved: money(approved) });
  return e;
}

async function openOne(employeeId, exceptId, transaction) {
  const [o] = await q(`SELECT code, status FROM payroll_loans WHERE "employeeId" = :employeeId AND status IN ('DRAFT', 'IN_REVIEW') AND id <> :exceptId`, { employeeId, exceptId: exceptId || NIL }, transaction);
  if (o) throw AppError.rule('LOAN_APPLICATION_OPEN', `This employee already has loan application #${o.code} (${STATUS_TEXT[o.status].toLowerCase()})`, { code: o.code });
}

const assertDraft = (cur) => {
  if (cur.status === 'IN_REVIEW') throw AppError.rule('LOAN_IN_REVIEW', 'An application in review is locked: withdraw it first');
  if (cur.status !== 'DRAFT') throw AppError.rule('LOAN_CLOSED', `This application is ${STATUS_TEXT[cur.status].toLowerCase()}`);
};

async function create(req, data) {
  const { companyId } = req.user;
  const applicationDate = data.applicationDate || today();
  const applied = amountCents(data.appliedAmount, 'Loan applied');
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-loan:${companyId}` }, transaction });
    const e = await checkTerms(companyId, { employeeId: data.employeeId, applicationDate, applied, months: data.months, deductFrom: data.deductFrom }, transaction);
    await openOne(data.employeeId, null, transaction);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_loans WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const [row] = await q(`INSERT INTO payroll_loans ("companyId", code, "employeeId", "applicationDate", "appliedAmount", months, "deductFrom", remarks, "createdById", "updatedById")
      VALUES (:companyId, :code, :employeeId, :applicationDate, :applied, :months, :deductFrom, :remarks, :userId, :userId) RETURNING id`,
    { companyId, code, employeeId: data.employeeId, applicationDate, applied: money(applied), months: data.months, deductFrom: `${data.deductFrom}-01`, remarks: data.remarks || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_CREATED', entityType: 'PayrollLoan', entityId: row.id, after: { code, employee: e.name, employeeCode: e.code, applied: money(applied), months: data.months, deductFrom: data.deductFrom } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const before = json(await loadRow(companyId, id, transaction));
    const applicationDate = changes.applicationDate || before.applicationDate;
    const applied = changes.appliedAmount !== undefined ? amountCents(changes.appliedAmount, 'Loan applied') : toCents(before.applied);
    const months = changes.months || cur.months;
    const deductFrom = changes.deductFrom || before.deductFrom;
    await checkTerms(companyId, { employeeId: cur.employeeId, applicationDate, applied, months, deductFrom }, transaction);
    await run(`UPDATE payroll_loans SET "applicationDate" = :applicationDate, "appliedAmount" = :applied, months = :months, "deductFrom" = :deductFrom, remarks = :remarks, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { id, applicationDate, applied: money(applied), months, deductFrom: `${deductFrom}-01`, remarks: changes.remarks === undefined ? cur.remarks : changes.remarks || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_UPDATED', entityType: 'PayrollLoan', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

async function submit(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status === 'IN_REVIEW') throw AppError.rule('ALREADY_IN_REVIEW', 'This application is already in review');
    assertDraft(cur);
    const r = await loadRow(companyId, id, transaction);
    await checkTerms(companyId, { employeeId: cur.employeeId, applicationDate: r.applicationDate, applied: toCents(r.applied), months: cur.months, deductFrom: r.deductFrom }, transaction);
    await run('UPDATE payroll_loans SET status = \'IN_REVIEW\', "submittedAt" = now(), "submittedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_SUBMITTED', entityType: 'PayrollLoan', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

async function withdraw(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review');
    await run('UPDATE payroll_loans SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_WITHDRAWN', entityType: 'PayrollLoan', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    await run('DELETE FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id', { owner: OWNER, id }, transaction);
    await run('DELETE FROM payroll_loans WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_DELETED', entityType: 'PayrollLoan', entityId: id, before: { code: cur.code } }, { transaction });
  });
}

// ---- the review ----

async function assertApprover(req) {
  if (!(await isApprover(req))) throw AppError.forbidden('Only a reviewer (a client admin or a person chosen as approver) can do this');
}
const assertInReview = (cur) => { if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review'); };

/** The reviewer sets the approved amount (not more than applied, nor than the salary) and may change the instalments, the first month and the remarks. */
async function reviewUpdate(req, id, changes) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const r = await loadRow(companyId, id, transaction);
    const before = json(r);
    const approved = changes.approvedAmount !== undefined ? amountCents(changes.approvedAmount, 'Loan approved') : r.approved == null ? null : toCents(r.approved);
    const months = changes.months || cur.months;
    const deductFrom = changes.deductFrom || r.deductFrom;
    await checkTerms(companyId, { employeeId: cur.employeeId, applicationDate: r.applicationDate, applied: toCents(r.applied), approved, months, deductFrom }, transaction);
    await run(`UPDATE payroll_loans SET "approvedAmount" = :approved, months = :months, "deductFrom" = :deductFrom, remarks = :remarks, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { id, approved: approved == null ? null : money(approved), months, deductFrom: `${deductFrom}-01`, remarks: changes.remarks === undefined ? cur.remarks : changes.remarks || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_REVIEW_EDITED', entityType: 'PayrollLoan', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

/** Approve: the approved amount is the one the reviewer set, else the applied one; the salary of the day is kept on the loan. The money is paid by a voucher. */
async function approve(req, id) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const r = await loadRow(companyId, id, transaction);
    const applied = toCents(r.applied);
    const approved = r.approved == null ? applied : toCents(r.approved);
    const e = await checkTerms(companyId, { employeeId: cur.employeeId, applicationDate: r.applicationDate, applied, approved, months: cur.months, deductFrom: r.deductFrom }, transaction);
    await run('UPDATE payroll_loans SET status = \'APPROVED\', "approvedAmount" = :approved, "salaryAtApproval" = :salary, "approvedAt" = now(), "approvedById" = :userId, "updatedAt" = now() WHERE id = :id',
      { id, approved: money(approved), salary: money(toCents(e.salary)), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_APPROVED', entityType: 'PayrollLoan', entityId: id, after: { code: cur.code, employee: e.name, applied: money(applied), approved: money(approved), months: cur.months, deductFrom: r.deductFrom } }, { transaction });
  });
  return get(req, id);
}

async function reject(req, id, { reason }) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    await run('UPDATE payroll_loans SET status = \'REJECTED\', "rejectedAt" = now(), "rejectedById" = :userId, "rejectReason" = :reason, "approvedAmount" = NULL, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_REJECTED', entityType: 'PayrollLoan', entityId: id, after: { code: cur.code, reason } }, { transaction });
  });
  return get(req, id);
}

async function reopen(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'REJECTED') throw AppError.rule('NOT_REJECTED', 'This application is not rejected');
    await openOne(cur.employeeId, id, transaction);
    await run('UPDATE payroll_loans SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "rejectedAt" = NULL, "rejectedById" = NULL, "rejectReason" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LOAN_REOPENED', entityType: 'PayrollLoan', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

// ---- attachments (documents of the application: up to 5 files of 2 MB, JPG / PNG / PDF; changed only while it is a draft) ----

async function attachmentsOf(id, transaction) {
  const rows = await q('SELECT kind, "fileName", "mimeType", size, "createdAt" FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id ORDER BY "createdAt", kind', { owner: OWNER, id }, transaction);
  return rows.map((f) => ({ key: f.kind, fileName: f.fileName, mimeType: f.mimeType, size: f.size, uploadedAt: f.createdAt }));
}

async function addAttachment(req, id, { buffer, fileName }) {
  const { companyId } = req.user;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw AppError.rule('NO_FILE', 'Send the file as the body of the request (JPG, PNG or PDF)');
  if (buffer.length > MAX_FILE) throw AppError.rule('FILE_TOO_LARGE', 'The file is more than 2 MB');
  const type = detect(buffer);
  if (!type) throw AppError.rule('FILE_TYPE', 'Only JPG, PNG or PDF files are accepted');
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id', { owner: OWNER, id }, transaction);
    if (n >= MAX_ATTACHMENTS) throw AppError.rule('TOO_MANY_FILES', `An application can have at most ${MAX_ATTACHMENTS} attachments`);
    const kind = `ATT_${crypto.randomBytes(5).toString('hex')}`;
    await run(`INSERT INTO payroll_files ("companyId", "ownerType", "ownerId", kind, "fileName", "mimeType", size, sha256, data, "uploadedById")
      VALUES (:companyId, :owner, :id, :kind, :fileName, :mime, :size, :sha, :data, :userId)`,
    { companyId, owner: OWNER, id, kind, fileName: cleanName(fileName, type.ext), mime: type.mime, size: buffer.length, sha: crypto.createHash('sha256').update(buffer).digest('hex'), data: buffer, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_FILE_SAVED', entityType: 'PayrollLoan', entityId: id, after: { kind, mimeType: type.mime, size: buffer.length } }, { transaction });
  });
  return get(req, id);
}

async function readAttachment(req, id, key) {
  const { companyId } = req.user;
  await loadRow(companyId, id);
  const [f] = await q('SELECT "fileName", "mimeType", size, data FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id AND kind = :key AND "companyId" = :companyId', { owner: OWNER, id, key, companyId });
  if (!f) throw AppError.notFound('File');
  return f;
}

async function removeAttachment(req, id, key) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const gone = await q('DELETE FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id AND kind = :key AND "companyId" = :companyId RETURNING id', { owner: OWNER, id, key, companyId }, transaction);
    if (!gone.length) throw AppError.notFound('File');
    await audit.log(req, { action: 'PAYROLL_FILE_DELETED', entityType: 'PayrollLoan', entityId: id, after: { kind: key } }, { transaction });
  });
  return get(req, id);
}

module.exports = { list, summary, get, create, update, submit, withdraw, remove, reviewUpdate, approve, reject, reopen, addAttachment, readAttachment, removeAttachment, voucherLabel, loadRow, json, ATTACHMENT_KEY };
