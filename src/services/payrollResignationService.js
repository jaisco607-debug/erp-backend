// Resignation applications (service PAYROLL_APPLICATIONS to change, any payroll service to read): an employee leaving.
//   DRAFT      HR can edit and delete it.        IN_REVIEW  sent for approval (locked; HR's "withdraw" takes it back).
//   APPROVED   "posted": the employee card is closed with the last working day as the leaving date and the application is read only.
//   REJECTED   refused with a reason; HR can re-open it as a draft.
// The reviewer is a client admin or a person chosen in payroll_approvers (the same people as for the joining application); the reviewer may correct the
// last working day and the reason of an application in review. An employee has one open (draft / in review) resignation at a time.
// An employee can be given a resignation after he stopped coming: `absentees` lists the working employees with no punch for N days, with the last day he came.
// The employee's data stays: his days up to the last working day are in the attendance, and the payroll of the month he left counts only those days.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { dayIndex } = require('../utils/attendanceEngine');
const accountService = require('./accountService');
const audit = require('./auditService');
const { isApprover } = require('./payrollApproverService');
const attendanceRefresh = require('./attendanceRefresh');

const { fromCents, toCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad4 = (n) => String(n).padStart(4, '0');
const pad5 = (n) => String(n).padStart(5, '0');
const money = (v) => fromCents(toCents(v));
const STATUS_TEXT = { DRAFT: 'Draft', IN_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected' };

const SELECT = `r.id, r.code, r.status, r."employeeId", to_char(r."applicationDate", 'YYYY-MM-DD') AS "applicationDate", to_char(r."lastWorkingDay", 'YYYY-MM-DD') AS "lastWorkingDay",
  r.reason, r."refNo", r."submittedAt", sb.name AS "submittedByName", r."approvedAt", ab.name AS "approvedByName", r."rejectedAt", rb.name AS "rejectedByName", r."rejectReason", r."createdAt", r."updatedAt",
  e.code AS "empCode", e.name AS "empName", e."fatherName", e.cnic, e."isClosed", to_char(e."joiningDate", 'YYYY-MM-DD') AS "joiningDate", to_char(e."leavingDate", 'YYYY-MM-DD') AS "leavingDate",
  e."basicSalary"::text AS "basicSalary", e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName",
  EXISTS (SELECT 1 FROM payroll_files f WHERE f."ownerType" = 'EMPLOYEE' AND f."ownerId" = e.id AND f.kind = 'PHOTO') AS "hasPhoto"`;
const FROM = `payroll_resignations r JOIN payroll_employees e ON e.id = r."employeeId" JOIN payroll_groups g ON g.id = e."groupId"
  LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"
  LEFT JOIN users sb ON sb.id = r."submittedById" LEFT JOIN users ab ON ab.id = r."approvedById" LEFT JOIN users rb ON rb.id = r."rejectedById"`;

/** "0y 3m": whole months between two dates (YYYY-MM-DD), years and months always shown. */
function serviceText(from, to) {
  const a = from.split('-').map(Number);
  const b = to.split('-').map(Number);
  let months = (b[0] - a[0]) * 12 + (b[1] - a[1]);
  if (b[2] < a[2]) months -= 1;
  if (months < 0) months = 0;
  return `${Math.floor(months / 12)}y ${months % 12}m`;
}

/** How the last working day lies against the application date, for the line under the date: "Left 17 days before the application date". */
function gapOf(applicationDate, lastWorkingDay) {
  const days = dayIndex(applicationDate) - dayIndex(lastWorkingDay); // > 0: the employee stopped before the application was made
  const n = Math.abs(days);
  const s = n === 1 ? 'day' : 'days';
  const text = days > 0 ? `Left ${n} ${s} before the application date` : days < 0 ? `Leaves ${n} ${s} after the application date` : 'Last working day is the application date';
  return { days, text };
}

function json(r, approver = false) {
  const draft = r.status === 'DRAFT';
  const inReview = r.status === 'IN_REVIEW';
  const gap = gapOf(r.applicationDate, r.lastWorkingDay);
  return {
    id: r.id, code: r.code, appId: pad5(r.code), label: `RES-${pad4(r.code)}`, status: r.status, statusText: STATUS_TEXT[r.status], posted: r.status === 'APPROVED',
    employee: {
      id: r.employeeId, code: r.empCode, label: pad5(r.empCode), name: r.empName, fatherName: r.fatherName, cnic: r.cnic, group: { id: r.groupId, name: r.groupName },
      department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, designation: r.designationName, joiningDate: r.joiningDate, basicSalary: money(r.basicSalary),
      hasPhoto: r.hasPhoto, isClosed: r.isClosed, leavingDate: r.leavingDate, service: serviceText(r.joiningDate, r.lastWorkingDay),
    },
    applicationDate: r.applicationDate, lastWorkingDay: r.lastWorkingDay, gapDays: gap.days, gapText: gap.text, hasLeft: r.isClosed && r.leavingDate === r.lastWorkingDay && r.status === 'APPROVED',
    reason: r.reason, refNo: r.refNo, submittedAt: r.submittedAt, submittedBy: r.submittedByName || null,
    approval: r.status === 'APPROVED' ? { by: r.approvedByName, at: r.approvedAt } : r.status === 'REJECTED' ? { by: r.rejectedByName, at: r.rejectedAt, reason: r.rejectReason } : null,
    canEdit: draft, canDelete: draft, canSubmit: draft, canWithdraw: inReview, canReopen: r.status === 'REJECTED',
    canReviewEdit: inReview && approver, canApprove: inReview && approver, canReject: inReview && approver,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE r.id = :id AND r."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Resignation');
  return r;
}
async function lockRow(companyId, id, transaction) {
  const [cur] = await q('SELECT * FROM payroll_resignations WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!cur) throw AppError.notFound('Resignation');
  return cur;
}
const get = async (req, id, transaction) => json(await loadRow(req.user.companyId, id, transaction), await isApprover(req));

async function list(req, f) {
  const { companyId } = req.user;
  const where = ['r."companyId" = :companyId'];
  const repl = { companyId };
  if (f.status) { where.push('r.status = :status'); repl.status = f.status; }
  if (f.departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = f.departmentId; }
  if (f.groupId) { where.push('e."groupId" = :groupId'); repl.groupId = f.groupId; }
  if (f.employeeId) { where.push('r."employeeId" = :employeeId'); repl.employeeId = f.employeeId; }
  if (f.from) { where.push('r."applicationDate" >= :from'); repl.from = f.from; }
  if (f.to) { where.push('r."applicationDate" <= :to'); repl.to = f.to; }
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR r.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR r."refNo" ILIKE :like OR r.reason ILIKE :like OR d.name ILIKE :like OR e.cnic ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY r.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const approver = await isApprover(req);
  return { data: rows.map((r) => json(r, approver)), page, limit, total: n };
}

/** The numbers of the tabs: all, draft, review (and approved / rejected). */
async function summary(req) {
  const [t] = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE status = 'IN_REVIEW')::int AS "inReview",
    count(*) FILTER (WHERE status = 'APPROVED')::int AS approved, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected FROM payroll_resignations WHERE "companyId" = :companyId`, { companyId: req.user.companyId });
  return t;
}

/** The employee the application is for: the company's own, still working, and the last working day not before he joined. */
async function checkEmployee(companyId, employeeId, lastWorkingDay, transaction) {
  const [e] = await q(`SELECT id, code, name, "isClosed", to_char("joiningDate", 'YYYY-MM-DD') AS joined FROM payroll_employees WHERE id = :employeeId AND "companyId" = :companyId`, { employeeId, companyId }, transaction);
  if (!e) throw AppError.notFound('Employee');
  if (e.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', `${e.name} (ID ${e.code}) has already left the company`);
  if (lastWorkingDay < e.joined) throw AppError.rule('LAST_DAY_BEFORE_JOINING', `The last working day cannot be before the joining date (${e.joined})`);
  return e;
}
const openOne = async (employeeId, exceptId, transaction) => {
  const [o] = await q(`SELECT code, status FROM payroll_resignations WHERE "employeeId" = :employeeId AND status IN ('DRAFT', 'IN_REVIEW') AND id <> :exceptId`, { employeeId, exceptId: exceptId || '00000000-0000-0000-0000-000000000000' }, transaction);
  if (o) throw AppError.rule('RESIGNATION_EXISTS', `This employee already has resignation application RES-${pad4(o.code)} (${STATUS_TEXT[o.status].toLowerCase()})`, { code: o.code });
};

async function create(req, data) {
  const { companyId } = req.user;
  if (data.applicationDate > today()) throw AppError.rule('DATE_IN_FUTURE', 'The application date cannot be in the future');
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-resignation:${companyId}` }, transaction });
    const e = await checkEmployee(companyId, data.employeeId, data.lastWorkingDay, transaction);
    await openOne(data.employeeId, null, transaction);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_resignations WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const [row] = await q(`INSERT INTO payroll_resignations ("companyId", code, "employeeId", "applicationDate", "lastWorkingDay", reason, "refNo", "createdById", "updatedById")
      VALUES (:companyId, :code, :employeeId, :applicationDate, :lastWorkingDay, :reason, :refNo, :userId, :userId) RETURNING id`,
    { companyId, code, employeeId: data.employeeId, applicationDate: data.applicationDate, lastWorkingDay: data.lastWorkingDay, reason: data.reason, refNo: data.refNo || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_CREATED', entityType: 'PayrollResignation', entityId: row.id, after: { code, employee: e.name, employeeCode: e.code, lastWorkingDay: data.lastWorkingDay } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

const assertDraft = (cur) => {
  if (cur.status === 'IN_REVIEW') throw AppError.rule('RESIGNATION_IN_REVIEW', 'An application in review is locked: withdraw it first');
  if (cur.status !== 'DRAFT') throw AppError.rule('RESIGNATION_CLOSED', `This application is ${STATUS_TEXT[cur.status].toLowerCase()}`);
};

async function update(req, id, changes) {
  const { companyId } = req.user;
  if (changes.applicationDate && changes.applicationDate > today()) throw AppError.rule('DATE_IN_FUTURE', 'The application date cannot be in the future');
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const before = json(await loadRow(companyId, id, transaction));
    if (changes.employeeId && changes.employeeId !== cur.employeeId) await openOne(changes.employeeId, id, transaction);
    const lastWorkingDay = changes.lastWorkingDay || before.lastWorkingDay;
    await checkEmployee(companyId, changes.employeeId || cur.employeeId, lastWorkingDay, transaction);
    const values = {};
    for (const k of ['employeeId', 'applicationDate', 'lastWorkingDay', 'reason', 'refNo']) if (changes[k] !== undefined) values[k] = k === 'refNo' && changes[k] === '' ? null : changes[k];
    const cols = Object.keys(values);
    if (cols.length) await run(`UPDATE payroll_resignations SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...values }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_UPDATED', entityType: 'PayrollResignation', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

async function submit(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status === 'IN_REVIEW') throw AppError.rule('ALREADY_IN_REVIEW', 'This application is already in review');
    assertDraft(cur);
    await checkEmployee(companyId, cur.employeeId, (await loadRow(companyId, id, transaction)).lastWorkingDay, transaction);
    await run('UPDATE payroll_resignations SET status = \'IN_REVIEW\', "submittedAt" = now(), "submittedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_SUBMITTED', entityType: 'PayrollResignation', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

async function withdraw(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review');
    await run('UPDATE payroll_resignations SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_WITHDRAWN', entityType: 'PayrollResignation', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    await run('DELETE FROM payroll_resignations WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_DELETED', entityType: 'PayrollResignation', entityId: id, before: { code: cur.code } }, { transaction });
  });
}

// ---- the review ----

async function assertApprover(req) {
  if (!(await isApprover(req))) throw AppError.forbidden('Only a reviewer (a client admin or a person chosen as approver) can do this');
}
const assertInReview = (cur) => { if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review'); };

/** The reviewer corrects the last working day and the reason of an application in review. */
async function reviewUpdate(req, id, changes) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const before = json(await loadRow(companyId, id, transaction));
    await checkEmployee(companyId, cur.employeeId, changes.lastWorkingDay || before.lastWorkingDay, transaction);
    const values = {};
    for (const k of ['lastWorkingDay', 'reason', 'refNo']) if (changes[k] !== undefined) values[k] = k === 'refNo' && changes[k] === '' ? null : changes[k];
    const cols = Object.keys(values);
    if (cols.length) await run(`UPDATE payroll_resignations SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...values }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_REVIEW_EDITED', entityType: 'PayrollResignation', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

/**
 * Approve = post: the employee card is closed with the last working day as his leaving date, so he is no longer a working employee and no new payroll takes him.
 * His attendance and the days he worked stay; the days after the last working day are removed from the attendance.
 */
async function approve(req, id) {
  const { companyId } = req.user;
  await assertApprover(req);
  let employeeId;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-employee:${companyId}` }, transaction });
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const full = await loadRow(companyId, id, transaction);
    if (full.lastWorkingDay > today()) throw AppError.rule('LAST_DAY_IN_FUTURE', `The employee works until ${full.lastWorkingDay}: the resignation can be approved from that day`, { lastWorkingDay: full.lastWorkingDay });
    const e = await checkEmployee(companyId, cur.employeeId, full.lastWorkingDay, transaction);
    employeeId = e.id;
    await run('UPDATE payroll_employees SET "isClosed" = true, "leavingDate" = :day, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { id: e.id, day: full.lastWorkingDay, userId: req.user.id }, transaction);
    await run('UPDATE payroll_resignations SET status = \'APPROVED\', "approvedAt" = now(), "approvedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_CLOSED', entityType: 'PayrollEmployee', entityId: e.id, after: { code: e.code, name: e.name, leavingDate: full.lastWorkingDay, fromResignation: cur.code } }, { transaction });
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_APPROVED', entityType: 'PayrollResignation', entityId: id, after: { code: cur.code, employee: e.name, lastWorkingDay: full.lastWorkingDay } }, { transaction });
  });
  await attendanceRefresh.employeeChanged(companyId, employeeId);
  return get(req, id);
}

async function reject(req, id, { reason }) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    await run('UPDATE payroll_resignations SET status = \'REJECTED\', "rejectedAt" = now(), "rejectedById" = :userId, "rejectReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_REJECTED', entityType: 'PayrollResignation', entityId: id, after: { code: cur.code, reason } }, { transaction });
  });
  return get(req, id);
}

/** HR takes a rejected application back to draft, to correct it and send it again (refused when the employee got another open resignation meanwhile). */
async function reopen(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'REJECTED') throw AppError.rule('NOT_REJECTED', 'This application is not rejected');
    await openOne(cur.employeeId, id, transaction);
    await run('UPDATE payroll_resignations SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "rejectedAt" = NULL, "rejectedById" = NULL, "rejectReason" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RESIGNATION_REOPENED', entityType: 'PayrollResignation', entityId: id, after: { code: cur.code } }, { transaction });
  });
  return get(req, id);
}

// ---- who to give a resignation to ----

/**
 * The working employees who stopped coming: no punch for `days` days up to the latest day the machine has data for (not up to today, so a machine that was off
 * does not make everybody a candidate). `suggestedLastWorkingDay` is the last day he punched (null when he never did: HR chooses). Employees who already have an open resignation are left out.
 */
async function absentees(req, { days = 10, groupId, departmentId, page = 1, limit = 100 }) {
  const { companyId } = req.user;
  const where = ['e."companyId" = :companyId', 'NOT e."isClosed"', 'asof.d IS NOT NULL', 'e."joiningDate" <= asof.d', '(asof.d - COALESCE(lp.last, e."joiningDate")) >= :days',
    `NOT EXISTS (SELECT 1 FROM payroll_resignations r WHERE r."employeeId" = e.id AND r.status IN ('DRAFT', 'IN_REVIEW'))`];
  const repl = { companyId, days };
  if (groupId) { where.push('e."groupId" = :groupId'); repl.groupId = groupId; }
  if (departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = departmentId; }
  const from = `payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"
    CROSS JOIN (SELECT max(("punchAt" AT TIME ZONE 'Asia/Karachi')::date) AS d FROM payroll_punches WHERE "companyId" = :companyId) asof
    LEFT JOIN (SELECT "empCode", max(("punchAt" AT TIME ZONE 'Asia/Karachi')::date) AS last FROM payroll_punches WHERE "companyId" = :companyId GROUP BY "empCode") lp ON lp."empCode" = e.code`;
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${from} WHERE ${where.join(' AND ')}`, repl);
  const [{ asof }] = await q(`SELECT to_char(max(("punchAt" AT TIME ZONE 'Asia/Karachi')::date), 'YYYY-MM-DD') AS asof FROM payroll_punches WHERE "companyId" = :companyId`, { companyId });
  const rows = await q(`SELECT e.id, e.code, e.name, g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName", to_char(e."joiningDate", 'YYYY-MM-DD') AS joined,
      to_char(lp.last, 'YYYY-MM-DD') AS "lastPunch", (asof.d - COALESCE(lp.last, e."joiningDate"))::int AS gap
    FROM ${from} WHERE ${where.join(' AND ')} ORDER BY gap DESC, e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  return {
    asOf: asof, days, page, limit, total: n,
    data: rows.map((r) => ({
      employee: { id: r.id, code: r.code, label: pad5(r.code), name: r.name, group: r.groupName, department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, designation: r.designationName, joiningDate: r.joined },
      lastPunchDate: r.lastPunch, neverPunched: !r.lastPunch, daysSincePunch: r.gap, suggestedLastWorkingDay: r.lastPunch,
    })),
  };
}

module.exports = { list, summary, get, create, update, submit, withdraw, remove, reviewUpdate, approve, reject, reopen, absentees, serviceText, gapOf };
