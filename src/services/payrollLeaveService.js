// Leave applications and annual leave (service PAYROLL_APPLICATIONS to change, any payroll service to read).
//   Annual leave is paid and comes out of the employee's balance. The balance is worked out from the policy of his group (utils/leaveBalance): after `monthsBeforeLeave` months of
//   service he is credited `leaveEarnedPerMonth` on the 1st of every month, at most `maxLeavePerYear` in a calendar year, and what he does not use carries on to the next year.
//   A leave counts WORKING days only: the weekly off day of the policy and the holidays of his group inside the dates are not taken from the balance.
//   DRAFT -> IN_REVIEW -> APPROVED (or REJECTED), the reviewer being a client admin or a chosen approver; an approved leave can be CANCELLED by the reviewer (the days go back to the balance).
//   The balance is checked when the application is sent and again when it is approved; leave already approved or waiting in review is reserved. An approved leave shows as AL
//   in the attendance on the days nobody punched on (see payrollAttendanceService.processRange).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { WEEKDAYS, dayIndex } = require('../utils/attendanceEngine');
const { earnedLeave, eligibleFrom, datesBetween, round2 } = require('../utils/leaveBalance');
const audit = require('./auditService');
const { isApprover } = require('./payrollApproverService');
const { effectivePolicy } = require('./payrollPolicyService');
const attendanceRefresh = require('./attendanceRefresh');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad4 = (n) => String(n).padStart(4, '0');
const pad5 = (n) => String(n).padStart(5, '0');
const NIL = '00000000-0000-0000-0000-000000000000';
const STATUS_TEXT = { DRAFT: 'Draft', IN_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };
const TYPE_TEXT = { ANNUAL: 'Annual leave' };

const SELECT = `l.id, l.code, l.status, l."employeeId", l."leaveType", to_char(l."applicationDate", 'YYYY-MM-DD') AS "applicationDate", to_char(l."fromDate", 'YYYY-MM-DD') AS "fromDate",
  to_char(l."toDate", 'YYYY-MM-DD') AS "toDate", l.days, l.reason, l."submittedAt", sb.name AS "submittedByName", l."approvedAt", ab.name AS "approvedByName", l."rejectedAt", rb.name AS "rejectedByName",
  l."rejectReason", l."cancelledAt", cb.name AS "cancelledByName", l."cancelReason", l."createdAt", l."updatedAt",
  e.code AS "empCode", e.name AS "empName", e."fatherName", e.cnic, e."isClosed", to_char(e."joiningDate", 'YYYY-MM-DD') AS "joiningDate", to_char(e."leavingDate", 'YYYY-MM-DD') AS "leavingDate",
  e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName",
  EXISTS (SELECT 1 FROM payroll_files f WHERE f."ownerType" = 'EMPLOYEE' AND f."ownerId" = e.id AND f.kind = 'PHOTO') AS "hasPhoto"`;
const FROM = `payroll_leaves l JOIN payroll_employees e ON e.id = l."employeeId" JOIN payroll_groups g ON g.id = e."groupId"
  LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"
  LEFT JOIN users sb ON sb.id = l."submittedById" LEFT JOIN users ab ON ab.id = l."approvedById" LEFT JOIN users rb ON rb.id = l."rejectedById" LEFT JOIN users cb ON cb.id = l."cancelledById"`;

// ---- the policy of each month, the holidays, the working days ----

/** A getter for the policy of a group in any month between two months (YYYY-MM), asked from the database once per group and month. */
async function policyBook(companyId, fromMonth, toMonth, transaction) {
  const cache = new Map();
  const months = [];
  for (let m = fromMonth; m <= toMonth; m = nextMonth(m)) months.push(m);
  return {
    async load(groupId) {
      for (const m of months) if (!cache.has(`${groupId}|${m}`)) cache.set(`${groupId}|${m}`, await effectivePolicy(companyId, groupId, m, transaction));
    },
    policyFor: (groupId) => (month) => cache.get(`${groupId}|${month}`),
  };
}
const nextMonth = (month) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

async function employeeOr404(companyId, id, transaction) {
  const [e] = await q(`SELECT e.id, e.code, e.name, e."groupId", e."isClosed", to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, to_char(e."leavingDate", 'YYYY-MM-DD') AS "leftOn"
    FROM payroll_employees e WHERE e.id = :id AND e."companyId" = :companyId`, { id, companyId }, transaction);
  if (!e) throw AppError.notFound('Employee');
  return e;
}

/** The working days of a range for an employee and the rest days inside it (the weekly off day and the holidays of his group, with the reason). */
async function splitDays(companyId, emp, from, to, transaction) {
  const book = await policyBook(companyId, from.slice(0, 7), to.slice(0, 7), transaction);
  await book.load(emp.groupId);
  const holidays = await q(`SELECT to_char(h."holidayDate", 'YYYY-MM-DD') AS date, h.name FROM payroll_holidays h
    WHERE h."companyId" = :companyId AND h."holidayDate" BETWEEN :from AND :to
      AND (h."appliesToAll" OR EXISTS (SELECT 1 FROM payroll_holiday_groups hg WHERE hg."holidayId" = h.id AND hg."groupId" = :groupId)) ORDER BY h."holidayDate"`,
  { companyId, from, to, groupId: emp.groupId }, transaction);
  const holiday = new Map(holidays.map((h) => [h.date, h.name]));
  const days = [];
  const rest = [];
  for (const date of datesBetween(from, to)) {
    const policy = book.policyFor(emp.groupId)(date.slice(0, 7));
    if (holiday.has(date)) rest.push({ date, reason: holiday.get(date) });
    else if (WEEKDAYS[new Date(dayIndex(date) * 86400000).getUTCDay()] === policy.weeklyOffDay) rest.push({ date, reason: 'Weekly off' });
    else days.push(date);
  }
  return { days, rest };
}

// ---- the balance ----

/** The leave balance of an employee on a day: earned up to that day, taken (approved), reserved (in review, apart from `exceptId`) and what is available. */
async function balanceAt(companyId, emp, asOf, exceptId, transaction) {
  const book = await policyBook(companyId, emp.joined.slice(0, 7), asOf.slice(0, 7) > emp.joined.slice(0, 7) ? asOf.slice(0, 7) : emp.joined.slice(0, 7), transaction);
  await book.load(emp.groupId);
  const policyFor = book.policyFor(emp.groupId);
  const { earned, byYear } = earnedLeave({ joiningDate: emp.joined, leavingDate: emp.leftOn, asOf, policyFor });
  const [t] = await q(`SELECT COALESCE(SUM(l.days) FILTER (WHERE l.status = 'APPROVED'), 0)::int AS taken, COALESCE(SUM(l.days) FILTER (WHERE l.status = 'IN_REVIEW'), 0)::int AS pending
    FROM payroll_leaves l WHERE l."employeeId" = :id AND l.id <> :except`, { id: emp.id, except: exceptId || NIL }, transaction);
  const startMonth = asOf.slice(0, 7) < emp.joined.slice(0, 7) ? emp.joined.slice(0, 7) : asOf.slice(0, 7);
  const policy = policyFor(startMonth);
  return {
    asOf, earned, taken: t.taken, pending: t.pending, available: round2(earned - t.taken - t.pending), byYear,
    policy: { leaveEarnedPerMonth: Number(policy.leaveEarnedPerMonth), maxLeavePerYear: Number(policy.maxLeavePerYear), monthsBeforeLeave: policy.monthsBeforeLeave },
    eligibleFrom: eligibleFrom(emp.joined, policy.monthsBeforeLeave),
  };
}

// ---- an application as the screen shows it ----

function json(r, approver = false) {
  const draft = r.status === 'DRAFT';
  const inReview = r.status === 'IN_REVIEW';
  return {
    id: r.id, code: r.code, appId: pad5(r.code), label: `LV-${pad4(r.code)}`, status: r.status, statusText: STATUS_TEXT[r.status],
    employee: {
      id: r.employeeId, code: r.empCode, label: pad5(r.empCode), name: r.empName, fatherName: r.fatherName, cnic: r.cnic, group: { id: r.groupId, name: r.groupName },
      department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, designation: r.designationName, joiningDate: r.joiningDate, hasPhoto: r.hasPhoto, isClosed: r.isClosed,
    },
    leaveType: r.leaveType, leaveTypeText: TYPE_TEXT[r.leaveType], applicationDate: r.applicationDate, fromDate: r.fromDate, toDate: r.toDate, days: r.days, reason: r.reason,
    submittedAt: r.submittedAt, submittedBy: r.submittedByName || null,
    approval: r.status === 'APPROVED' ? { by: r.approvedByName, at: r.approvedAt }
      : r.status === 'REJECTED' ? { by: r.rejectedByName, at: r.rejectedAt, reason: r.rejectReason }
        : r.status === 'CANCELLED' ? { by: r.cancelledByName, at: r.cancelledAt, reason: r.cancelReason, approvedBy: r.approvedByName } : null,
    canEdit: draft, canDelete: draft, canSubmit: draft, canWithdraw: inReview, canReopen: r.status === 'REJECTED',
    canReviewEdit: inReview && approver, canApprove: inReview && approver, canReject: inReview && approver, canCancel: r.status === 'APPROVED' && approver,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE l.id = :id AND l."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Leave application');
  return r;
}
async function lockRow(companyId, id, transaction) {
  const [cur] = await q('SELECT * FROM payroll_leaves WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!cur) throw AppError.notFound('Leave application');
  return cur;
}

/** The detail: the application, the days it takes from the balance, the rest days inside it, the balance now and the last leaves of the employee. */
async function get(req, id, transaction) {
  const { companyId } = req.user;
  const r = await loadRow(companyId, id, transaction);
  const out = json(r, await isApprover(req));
  const emp = await employeeOr404(companyId, r.employeeId, transaction);
  const stored = (await q('SELECT to_char("leaveDate", \'YYYY-MM-DD\') AS d FROM payroll_leave_days WHERE "leaveId" = :id ORDER BY "leaveDate"', { id }, transaction)).map((x) => x.d);
  const split = await splitDays(companyId, emp, r.fromDate, r.toDate, transaction);
  out.dates = ['APPROVED', 'CANCELLED'].includes(r.status) ? stored : split.days;
  out.restDays = split.rest;
  const open = ['DRAFT', 'IN_REVIEW', 'REJECTED'].includes(r.status);
  const bal = await balanceAt(companyId, emp, r.fromDate, r.status === 'APPROVED' ? null : id, transaction);
  out.balance = {
    earned: bal.earned, taken: bal.taken, pending: bal.pending, available: bal.available, eligibleFrom: bal.eligibleFrom, asOf: bal.asOf,
    enough: open ? bal.available >= out.dates.length : true, requested: out.dates.length,
  };
  const prev = await q(`SELECT l.id, l.code, l.status, to_char(l."fromDate", 'YYYY-MM-DD') AS "fromDate", to_char(l."toDate", 'YYYY-MM-DD') AS "toDate", l.days, l.reason
    FROM payroll_leaves l WHERE l."employeeId" = :employeeId AND l.id <> :id ORDER BY l.code DESC LIMIT 10`, { employeeId: r.employeeId, id }, transaction);
  out.previousLeaves = prev.map((p) => ({ id: p.id, appId: pad5(p.code), fromDate: p.fromDate, toDate: p.toDate, days: p.days, reason: p.reason, status: p.status, statusText: STATUS_TEXT[p.status] }));
  return out;
}

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
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR l.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like OR d.name ILIKE :like OR l.reason ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY l.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const approver = await isApprover(req);
  return { data: rows.map((r) => json(r, approver)), page, limit, total: n };
}

async function summary(req) {
  const [t] = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE status = 'IN_REVIEW')::int AS "inReview",
    count(*) FILTER (WHERE status = 'APPROVED')::int AS approved, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected, count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
    FROM payroll_leaves WHERE "companyId" = :companyId`, { companyId: req.user.companyId });
  return t;
}

// ---- the rules ----

/** The employee works here, the dates make sense (not before he joined) and do not overlap another leave of his; returns the working days. */
async function checkDates(companyId, employeeId, from, to, exceptId, transaction) {
  const emp = await employeeOr404(companyId, employeeId, transaction);
  if (emp.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', `${emp.name} (ID ${emp.code}) has left the company`);
  if (to < from) throw AppError.rule('TO_BEFORE_FROM', 'The last day of the leave is before its first day');
  if (from < emp.joined) throw AppError.rule('LEAVE_BEFORE_JOINING', `The employee joined on ${emp.joined}`);
  if (dayIndex(to) - dayIndex(from) > 365) throw AppError.rule('LEAVE_TOO_LONG', 'A leave application covers at most one year');
  const [clash] = await q(`SELECT code, status, to_char("fromDate", 'YYYY-MM-DD') AS "fromDate", to_char("toDate", 'YYYY-MM-DD') AS "toDate" FROM payroll_leaves
    WHERE "employeeId" = :employeeId AND id <> :exceptId AND status IN ('DRAFT', 'IN_REVIEW', 'APPROVED') AND "fromDate" <= :to AND "toDate" >= :from LIMIT 1`, { employeeId, exceptId: exceptId || NIL, from, to }, transaction);
  if (clash) throw AppError.rule('LEAVE_OVERLAP', `This employee already has leave application #${clash.code} (${STATUS_TEXT[clash.status].toLowerCase()}) from ${clash.fromDate} to ${clash.toDate}`, { code: clash.code, fromDate: clash.fromDate, toDate: clash.toDate });
  const split = await splitDays(companyId, emp, from, to, transaction);
  if (!split.days.length) throw AppError.rule('NO_WORKING_DAYS', 'Every day of these dates is a weekly off day or a holiday: there is no leave to take', { restDays: split.rest });
  return { emp, ...split };
}

/** Annual leave needs enough balance: the days asked for are not more than what is available on the first day of the leave. */
async function checkBalance(companyId, emp, from, count, exceptId, transaction) {
  const bal = await balanceAt(companyId, emp, from, exceptId, transaction);
  if (bal.available < count) {
    throw AppError.rule('LEAVE_BALANCE_LOW', `${emp.name} has ${bal.available} day${bal.available === 1 ? '' : 's'} of annual leave available on ${from}; ${count} asked for`,
      { available: bal.available, requested: count, earned: bal.earned, taken: bal.taken, pending: bal.pending, eligibleFrom: bal.eligibleFrom });
  }
  return bal;
}

async function writeDays(companyId, leaveId, employeeId, dates, transaction) {
  await run('DELETE FROM payroll_leave_days WHERE "leaveId" = :leaveId', { leaveId }, transaction);
  for (const d of dates) await run('INSERT INTO payroll_leave_days ("leaveId", "companyId", "employeeId", "leaveDate") VALUES (:leaveId, :companyId, :employeeId, :d)', { leaveId, companyId, employeeId, d }, transaction);
  await run('UPDATE payroll_leaves SET days = :n WHERE id = :leaveId', { leaveId, n: dates.length }, transaction);
}

const assertDraft = (cur) => {
  if (cur.status === 'IN_REVIEW') throw AppError.rule('LEAVE_IN_REVIEW', 'An application in review is locked: withdraw it first');
  if (cur.status !== 'DRAFT') throw AppError.rule('LEAVE_CLOSED', `This application is ${STATUS_TEXT[cur.status].toLowerCase()}`);
};

// ---- the preview and the balance for the form ----

/** What a leave would take: the working days, the rest days inside the dates and the balance, before anything is saved. */
async function preview(req, { employeeId, fromDate, toDate, exceptId }) {
  const { companyId } = req.user;
  const emp = await employeeOr404(companyId, employeeId);
  if (toDate < fromDate) throw AppError.rule('TO_BEFORE_FROM', 'The last day of the leave is before its first day');
  if (dayIndex(toDate) - dayIndex(fromDate) > 365) throw AppError.rule('LEAVE_TOO_LONG', 'A leave application covers at most one year');
  const split = await splitDays(companyId, emp, fromDate, toDate);
  const bal = await balanceAt(companyId, emp, fromDate, exceptId);
  return { employeeId, fromDate, toDate, days: split.days.length, dates: split.days, restDays: split.rest, balance: { earned: bal.earned, taken: bal.taken, pending: bal.pending, available: bal.available, eligibleFrom: bal.eligibleFrom }, enough: bal.available >= split.days.length };
}

/** The leave balance of one employee on a day (today by default). */
async function balance(req, { employeeId, date }) {
  const emp = await employeeOr404(req.user.companyId, employeeId);
  const bal = await balanceAt(req.user.companyId, emp, date || today());
  return { employee: { id: emp.id, code: emp.code, label: pad5(emp.code), name: emp.name, joiningDate: emp.joined }, ...bal };
}

// ---- making and changing an application ----

async function create(req, data) {
  const { companyId } = req.user;
  const applicationDate = data.applicationDate || today();
  if (applicationDate > today()) throw AppError.rule('DATE_IN_FUTURE', 'The application date cannot be in the future');
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-leave:${companyId}` }, transaction });
    const c = await checkDates(companyId, data.employeeId, data.fromDate, data.toDate, null, transaction);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_leaves WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const [row] = await q(`INSERT INTO payroll_leaves ("companyId", code, "employeeId", "applicationDate", "fromDate", "toDate", reason, "createdById", "updatedById")
      VALUES (:companyId, :code, :employeeId, :applicationDate, :from, :to, :reason, :userId, :userId) RETURNING id`,
    { companyId, code, employeeId: data.employeeId, applicationDate, from: data.fromDate, to: data.toDate, reason: data.reason, userId: req.user.id }, transaction);
    await writeDays(companyId, row.id, data.employeeId, c.days, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_CREATED', entityType: 'PayrollLeave', entityId: row.id, after: { code, employee: c.emp.name, fromDate: data.fromDate, toDate: data.toDate, days: c.days.length } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  if (changes.applicationDate && changes.applicationDate > today()) throw AppError.rule('DATE_IN_FUTURE', 'The application date cannot be in the future');
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const before = json(await loadRow(companyId, id, transaction));
    const from = changes.fromDate || before.fromDate;
    const to = changes.toDate || before.toDate;
    const c = await checkDates(companyId, cur.employeeId, from, to, id, transaction);
    await run('UPDATE payroll_leaves SET "applicationDate" = :applicationDate, "fromDate" = :from, "toDate" = :to, reason = :reason, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id',
      { id, applicationDate: changes.applicationDate || before.applicationDate, from, to, reason: changes.reason || cur.reason, userId: req.user.id }, transaction);
    await writeDays(companyId, id, cur.employeeId, c.days, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_UPDATED', entityType: 'PayrollLeave', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
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
    const c = await checkDates(companyId, cur.employeeId, r.fromDate, r.toDate, id, transaction);
    await checkBalance(companyId, c.emp, r.fromDate, c.days.length, id, transaction);
    await writeDays(companyId, id, cur.employeeId, c.days, transaction);
    await run('UPDATE payroll_leaves SET status = \'IN_REVIEW\', "submittedAt" = now(), "submittedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_SUBMITTED', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code, days: c.days.length } }, { transaction });
  });
  return get(req, id);
}

async function withdraw(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review');
    await run('UPDATE payroll_leaves SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_WITHDRAWN', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    await run('DELETE FROM payroll_leaves WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_DELETED', entityType: 'PayrollLeave', entityId: id, before: { code: cur.code } }, { transaction });
  });
}

// ---- the review ----

async function assertApprover(req) {
  if (!(await isApprover(req))) throw AppError.forbidden('Only a reviewer (a client admin or a person chosen as approver) can do this');
}
const assertInReview = (cur) => { if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review'); };

/** The reviewer may correct the dates and the reason of an application in review (the working days are counted again). */
async function reviewUpdate(req, id, changes) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const before = json(await loadRow(companyId, id, transaction));
    const from = changes.fromDate || before.fromDate;
    const to = changes.toDate || before.toDate;
    const c = await checkDates(companyId, cur.employeeId, from, to, id, transaction);
    await checkBalance(companyId, c.emp, from, c.days.length, id, transaction);
    await run('UPDATE payroll_leaves SET "fromDate" = :from, "toDate" = :to, reason = :reason, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, from, to, reason: changes.reason || cur.reason, userId: req.user.id }, transaction);
    await writeDays(companyId, id, cur.employeeId, c.days, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_REVIEW_EDITED', entityType: 'PayrollLeave', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

/** Approve: the days are counted again (a holiday may have been added), the balance is checked again, and the days become AL in the attendance. */
async function approve(req, id) {
  const { companyId } = req.user;
  await assertApprover(req);
  let range;
  let employeeId;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const r = await loadRow(companyId, id, transaction);
    const c = await checkDates(companyId, cur.employeeId, r.fromDate, r.toDate, id, transaction);
    await checkBalance(companyId, c.emp, r.fromDate, c.days.length, id, transaction);
    await writeDays(companyId, id, cur.employeeId, c.days, transaction);
    await run('UPDATE payroll_leaves SET status = \'APPROVED\', "approvedAt" = now(), "approvedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_APPROVED', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code, employee: c.emp.name, fromDate: r.fromDate, toDate: r.toDate, days: c.days.length } }, { transaction });
    range = { from: r.fromDate, to: r.toDate };
    employeeId = cur.employeeId;
  });
  await attendanceRefresh.leaveChanged(companyId, employeeId, range.from, range.to);
  return get(req, id);
}

async function reject(req, id, { reason }) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    await run('UPDATE payroll_leaves SET status = \'REJECTED\', "rejectedAt" = now(), "rejectedById" = :userId, "rejectReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_REJECTED', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code, reason } }, { transaction });
  });
  return get(req, id);
}

async function reopen(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'REJECTED') throw AppError.rule('NOT_REJECTED', 'This application is not rejected');
    await run('UPDATE payroll_leaves SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "rejectedAt" = NULL, "rejectedById" = NULL, "rejectReason" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_REOPENED', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

/** The reviewer cancels an APPROVED leave (taken back, or the employee did not go): the days return to the balance and the AL days of the attendance are worked out again. */
async function cancel(req, id, { reason }) {
  const { companyId } = req.user;
  await assertApprover(req);
  let range;
  let employeeId;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'APPROVED') throw AppError.rule('NOT_APPROVED', 'Only an approved leave can be cancelled');
    const r = await loadRow(companyId, id, transaction);
    await run('UPDATE payroll_leaves SET status = \'CANCELLED\', "cancelledAt" = now(), "cancelledById" = :userId, "cancelReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PAYROLL_LEAVE_CANCELLED', entityType: 'PayrollLeave', entityId: id, after: { code: cur.code, days: cur.days, reason } }, { transaction });
    range = { from: r.fromDate, to: r.toDate };
    employeeId = cur.employeeId;
  });
  await attendanceRefresh.leaveChanged(companyId, employeeId, range.from, range.to);
  return get(req, id);
}

// ---- the report: Annual Leaves ----

/** The year of the report: up to today for the running year, the whole year otherwise. */
const asOfOf = (year) => (year === Number(today().slice(0, 4)) ? today() : `${year}-12-31`);

/** One employee's leave for a year: carried from before, earned in the year, taken, waiting in review and what is left. */
function yearRow(emp, year, book, takenBy, pendingBy) {
  const { earned, byYear } = earnedLeave({ joiningDate: emp.joined, leavingDate: emp.leftOn, asOf: asOfOf(year), policyFor: book.policyFor(emp.groupId) });
  let carried = 0;
  let earnedYear = 0;
  let creditedYear = 0;
  for (const r of byYear) {
    if (r.year < year) carried += r.earned;
    if (r.year === year) { earnedYear = r.earned; creditedYear = r.credited; }
  }
  const takenBefore = [...takenBy].filter(([y]) => y < year).reduce((t, [, n]) => t + n, 0);
  const takenYear = takenBy.get(year) || 0;
  const pendingYear = pendingBy.get(year) || 0;
  const opening = round2(carried - takenBefore);
  const balance = round2(opening + earnedYear - takenYear);
  return { opening, earned: earnedYear, creditedBeforeCap: creditedYear, taken: takenYear, pending: pendingYear, balance, available: round2(balance - pendingYear), earnedAllYears: earned };
}

async function leaveDaysByYear(companyId, employeeIds, transaction) {
  const out = new Map(employeeIds.map((id) => [id, { taken: new Map(), pending: new Map() }]));
  if (!employeeIds.length) return out;
  const rows = await q(`SELECT d."employeeId", EXTRACT(YEAR FROM d."leaveDate")::int AS year, l.status, count(*)::int AS n FROM payroll_leave_days d JOIN payroll_leaves l ON l.id = d."leaveId"
    WHERE d."companyId" = :companyId AND d."employeeId" IN (:ids) AND l.status IN ('APPROVED', 'IN_REVIEW') GROUP BY 1, 2, 3`, { companyId, ids: employeeIds }, transaction);
  for (const r of rows) out.get(r.employeeId)[r.status === 'APPROVED' ? 'taken' : 'pending'].set(r.year, r.n);
  return out;
}

/** The Annual Leaves report: every employee with the leave carried, earned, taken and left for the year. */
async function annualLeaves(req, f) {
  const { companyId } = req.user;
  const year = f.year || Number(today().slice(0, 4));
  const where = ['e."companyId" = :companyId', 'e."joiningDate" <= :end', '(NOT e."isClosed" OR e."leavingDate" >= :start)'];
  const repl = { companyId, start: `${year}-01-01`, end: `${year}-12-31` };
  if (f.closed === 'all') where.splice(2, 1);
  for (const k of ['groupId', 'departmentId']) if (f[k]) { where.push(`e."${k}" = :${k}`); repl[k] = f[k]; }
  if (f.employeeId) { where.push('e.id = :employeeId'); repl.employeeId = f.employeeId; }
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const from = 'payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"';
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${from} WHERE ${where.join(' AND ')}`, repl);
  const emps = await q(`SELECT e.id, e.code, e.name, e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName", e."isClosed",
      to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, to_char(e."leavingDate", 'YYYY-MM-DD') AS "leftOn"
    FROM ${from} WHERE ${where.join(' AND ')} ORDER BY e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const byEmployee = await leaveDaysByYear(companyId, emps.map((e) => e.id));
  const earliest = emps.reduce((m, e) => (e.joined.slice(0, 7) < m ? e.joined.slice(0, 7) : m), `${year}-01`);
  const book = await policyBook(companyId, earliest, asOfOf(year).slice(0, 7));
  for (const g of new Set(emps.map((e) => e.groupId))) await book.load(g);
  const data = emps.map((e) => {
    const t = byEmployee.get(e.id);
    const row = yearRow(e, year, book, t.taken, t.pending);
    const policy = book.policyFor(e.groupId)(asOfOf(year).slice(0, 7) < e.joined.slice(0, 7) ? e.joined.slice(0, 7) : asOfOf(year).slice(0, 7));
    return {
      employee: { id: e.id, code: e.code, label: pad5(e.code), name: e.name, group: { id: e.groupId, name: e.groupName }, department: e.departmentId ? { id: e.departmentId, name: e.departmentName } : null, designation: e.designationName, joiningDate: e.joined, leavingDate: e.leftOn, isClosed: e.isClosed },
      eligibleFrom: eligibleFrom(e.joined, policy.monthsBeforeLeave), ...row,
    };
  });
  const sum = (k) => round2(data.reduce((t, r) => t + r[k], 0));
  return { year, asOf: asOfOf(year), page, limit, total: n, totals: { opening: sum('opening'), earned: sum('earned'), taken: sum('taken'), pending: sum('pending'), balance: sum('balance') }, data };
}

/** One employee's leave statement for a year: the figures, month by month, and the leaves of the year. */
async function employeeStatement(req, employeeId, { year: y }) {
  const { companyId } = req.user;
  const year = y || Number(today().slice(0, 4));
  const emp = await employeeOr404(companyId, employeeId);
  const [info] = await q('SELECT g.name AS "groupName" FROM payroll_groups g WHERE g.id = :id', { id: emp.groupId });
  const asOf = asOfOf(year);
  const book = await policyBook(companyId, emp.joined.slice(0, 7), asOf.slice(0, 7) < emp.joined.slice(0, 7) ? emp.joined.slice(0, 7) : asOf.slice(0, 7));
  await book.load(emp.groupId);
  const policyFor = book.policyFor(emp.groupId);
  const byEmployee = (await leaveDaysByYear(companyId, [emp.id])).get(emp.id);
  const figures = yearRow(emp, year, book, byEmployee.taken, byEmployee.pending);
  const monthTaken = await q(`SELECT to_char(d."leaveDate", 'YYYY-MM') AS month, l.status, count(*)::int AS n FROM payroll_leave_days d JOIN payroll_leaves l ON l.id = d."leaveId"
    WHERE d."employeeId" = :id AND l.status IN ('APPROVED', 'IN_REVIEW') AND EXTRACT(YEAR FROM d."leaveDate") = :year GROUP BY 1, 2`, { id: emp.id, year });
  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const month = `${year}-${String(m).padStart(2, '0')}`;
    const credited = month <= asOf.slice(0, 7) && month >= emp.joined.slice(0, 7) ? earnedLeave({ joiningDate: emp.joined, leavingDate: emp.leftOn, asOf: `${month}-01`, policyFor }).byYear : [];
    const before = month > `${year}-01` ? earnedLeave({ joiningDate: emp.joined, leavingDate: emp.leftOn, asOf: `${year}-${String(m - 1).padStart(2, '0')}-01`, policyFor }).byYear : [];
    const get1 = (rows) => (rows.find((r) => r.year === year) || { credited: 0 }).credited;
    months.push({ month, credited: round2(get1(credited) - get1(before)), taken: (monthTaken.find((t) => t.month === month && t.status === 'APPROVED') || { n: 0 }).n, pending: (monthTaken.find((t) => t.month === month && t.status === 'IN_REVIEW') || { n: 0 }).n });
  }
  const leaves = await q(`SELECT ${SELECT} FROM ${FROM} WHERE l."employeeId" = :id AND l."fromDate" <= :end AND l."toDate" >= :start ORDER BY l."fromDate"`, { id: emp.id, start: `${year}-01-01`, end: `${year}-12-31` });
  return {
    year, asOf, employee: { id: emp.id, code: emp.code, label: pad5(emp.code), name: emp.name, group: info.groupName, joiningDate: emp.joined, leavingDate: emp.leftOn },
    eligibleFrom: eligibleFrom(emp.joined, policyFor(asOf.slice(0, 7) < emp.joined.slice(0, 7) ? emp.joined.slice(0, 7) : asOf.slice(0, 7)).monthsBeforeLeave), ...figures, months,
    leaves: leaves.map((l) => json(l)).map((l) => ({ id: l.id, appId: l.appId, label: l.label, fromDate: l.fromDate, toDate: l.toDate, days: l.days, reason: l.reason, status: l.status, statusText: l.statusText })),
  };
}

module.exports = { list, summary, get, create, update, submit, withdraw, remove, reviewUpdate, approve, reject, reopen, cancel, preview, balance, annualLeaves, employeeStatement, balanceAt };
