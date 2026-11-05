// Employee Joining Application (service PAYROLL_APPLICATIONS): the employee card's form, filled by HR from the paper form the candidate wrote by hand.
//   DRAFT      can be edited and deleted.   IN_REVIEW  sent for approval (locked; HR's "withdraw" takes it back to draft).
//   APPROVED   the reviewer approved it: the employee card was made (confirmed) from it.   REJECTED  the reviewer refused it, with a reason; HR can re-open it as a draft.
// The reviewer (a client admin or a person chosen in payroll_approvers) may correct the work and salary details of an application in review before approving.
// Documents (photo, CNIC front and back, the scanned signed form) live in payroll_files (ownerType 'JOINING'), like the employee's own.
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const audit = require('./auditService');
const { ensureGroups } = require('./payrollMasterService');
const { clean, checkRefs, detect, cleanName, COLUMNS } = require('./payrollEmployeeService');
const { isApprover } = require('./payrollApproverService');
const attendanceRefresh = require('./attendanceRefresh');
const { ZONE } = require('../utils/dates');
const { monthlyDeductions } = require('../utils/payrollDeductions');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const money = (v) => fromCents(toCents(v));
const pad5 = (n) => String(n).padStart(5, '0');

/** The application never demands a bank: BANK only when it already has the bank and the account number (an old draft); otherwise cash. */
const appMethod = (merged, explicit) => (explicit !== 'CASH' && merged.bankId && merged.accountNo ? 'BANK' : 'CASH');

const STATUS_TEXT = { DRAFT: 'Draft', IN_REVIEW: 'In review', APPROVED: 'Approved', REJECTED: 'Rejected' };
// what the reviewer may correct: the work and salary details (the personal data and the documents stay as HR typed them)
const REVIEW_FIELDS = ['joiningDate', 'groupId', 'departmentId', 'designationId', 'shiftId', 'salaryType', 'basicSalary', 'foodAllowance', 'maintenanceAllowance', 'mobileAllowance', 'monthlyIncomeTax', 'remarks'];
const OWNER = 'JOINING';
const FILE_KINDS = { photo: 'PHOTO', 'cnic-front': 'CNIC_FRONT', 'cnic-back': 'CNIC_BACK', form: 'FORM' };
const FILE_KEY = { PHOTO: 'photo', CNIC_FRONT: 'cnicFront', CNIC_BACK: 'cnicBack', FORM: 'form' };
const IMAGE = ['image/jpeg', 'image/png'];
const ALLOWED = { PHOTO: IMAGE, CNIC_FRONT: [...IMAGE, 'application/pdf'], CNIC_BACK: [...IMAGE, 'application/pdf'], FORM: [...IMAGE, 'application/pdf'] };
const MAX_FILE = 2 * 1024 * 1024;
const REQUIRED_FILES = ['photo', 'cnic-front', 'cnic-back'];

const SELECT = `a.id, a.code, a.status, a."submittedAt", a.name, a."fatherName", a."motherName", a.cnic, a.ntn, to_char(a."dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth", a.gender, a."maritalStatus",
  a.religion, a.language, a.phone, a.email, a.address, a."groupId", g.name AS "groupName", a."departmentId", d.name AS "departmentName", a."designationId", ds.name AS "designationName",
  a."shiftId", s.code AS "shiftCode", to_char(s."startTime", 'HH24:MI') AS "shiftStart", to_char(s."endTime", 'HH24:MI') AS "shiftEnd", s."dutyHours"::float AS "shiftHours",
  to_char(a."joiningDate", 'YYYY-MM-DD') AS "joiningDate", a."salaryType", a."basicSalary"::text AS "basicSalary", a."foodAllowance"::text AS "foodAllowance",
  a."maintenanceAllowance"::text AS "maintenanceAllowance", a."mobileAllowance"::text AS "mobileAllowance", a."monthlyIncomeTax"::text AS "monthlyIncomeTax", a."eobiNo", a."scssiNo", a.iban,
  a."paymentMethod", a."bankId", b.name AS "bankName", a."accountNo", a."accountTitle", a.remarks, a."employeeId", a."approvedAt", ua.name AS "approvedByName", a."rejectedAt", ur.name AS "rejectedByName", a."rejectReason", us.name AS "submittedByName",
  a."createdAt", a."updatedAt"`;
const FROM = `payroll_joining_applications a JOIN payroll_groups g ON g.id = a."groupId" LEFT JOIN payroll_departments d ON d.id = a."departmentId"
  LEFT JOIN payroll_designations ds ON ds.id = a."designationId" LEFT JOIN payroll_shifts s ON s.id = a."shiftId" LEFT JOIN payroll_banks b ON b.id = a."bankId"
  LEFT JOIN users ua ON ua.id = a."approvedById" LEFT JOIN users ur ON ur.id = a."rejectedById" LEFT JOIN users us ON us.id = a."submittedById"`;

const NO_FILES = { photo: null, cnicFront: null, cnicBack: null, form: null };
function json(r, files, approver = false) {
  const named = (id, name) => (id ? { id, name } : null);
  const inReview = r.status === 'IN_REVIEW';
  const draft = r.status === 'DRAFT';
  return {
    id: r.id, code: r.code, label: `JA-${pad5(r.code)}`, status: r.status, statusText: STATUS_TEXT[r.status], submittedAt: r.submittedAt,
    name: r.name, fatherName: r.fatherName, motherName: r.motherName, cnic: r.cnic, ntn: r.ntn, dateOfBirth: r.dateOfBirth, gender: r.gender, maritalStatus: r.maritalStatus,
    religion: r.religion, language: r.language, phone: r.phone, email: r.email, address: r.address,
    group: { id: r.groupId, name: r.groupName }, department: named(r.departmentId, r.departmentName), designation: named(r.designationId, r.designationName),
    shift: r.shiftId ? { id: r.shiftId, code: r.shiftCode, label: `${r.shiftCode} (${r.shiftStart}-${r.shiftEnd}, ${r.shiftHours} hrs)`, dutyHours: r.shiftHours } : null,
    joiningDate: r.joiningDate, salaryType: r.salaryType, basicSalary: money(r.basicSalary), foodAllowance: money(r.foodAllowance), maintenanceAllowance: money(r.maintenanceAllowance),
    mobileAllowance: money(r.mobileAllowance), monthlyIncomeTax: money(r.monthlyIncomeTax), eobiNo: r.eobiNo || null, scssiNo: r.scssiNo || null,
    monthlyDeductions: monthlyDeductions(r),
    paymentMethod: r.paymentMethod, bank: named(r.bankId, r.bankName), accountNo: r.accountNo, iban: r.iban, accountTitle: r.accountTitle, remarks: r.remarks,
    files: files || NO_FILES,
    submittedBy: r.submittedByName || null,
    approval: r.status === 'APPROVED' ? { by: r.approvedByName, at: r.approvedAt, employeeId: r.employeeId } : r.status === 'REJECTED' ? { by: r.rejectedByName, at: r.rejectedAt, reason: r.rejectReason } : null,
    canEdit: draft, canDelete: draft, canSubmit: draft, canWithdraw: inReview, canReopen: r.status === 'REJECTED',
    canReviewEdit: inReview && approver, canApprove: inReview && approver, canReject: inReview && approver,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function filesOf(ids, transaction) {
  const out = new Map(ids.map((id) => [id, { ...NO_FILES }]));
  if (!ids.length) return out;
  const rows = await q('SELECT "ownerId", kind, "fileName", "mimeType", size, "updatedAt" FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" IN (:ids)', { ids, owner: OWNER }, transaction);
  for (const f of rows) out.get(f.ownerId)[FILE_KEY[f.kind]] = { fileName: f.fileName, mimeType: f.mimeType, size: f.size, uploadedAt: f.updatedAt };
  return out;
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE a.id = :id AND a."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Application');
  return r;
}
async function get(req, id, transaction) {
  const r = await loadRow(req.user.companyId, id, transaction);
  return json(r, (await filesOf([id], transaction)).get(id), await isApprover(req));
}

async function list(req, f) {
  const { companyId } = req.user;
  const where = ['a."companyId" = :companyId'];
  const repl = { companyId };
  for (const k of ['groupId', 'departmentId', 'designationId', 'status']) if (f[k]) { where.push(`a."${k}" = :${k}`); repl[k] = f[k]; }
  if (f.from) { where.push(`(a."createdAt" AT TIME ZONE '${ZONE}')::date >= :from`); repl.from = f.from; }
  if (f.to) { where.push(`(a."createdAt" AT TIME ZONE '${ZONE}')::date <= :to`); repl.to = f.to; }
  if (f.search) {
    repl.like = `%${f.search}%`;
    where.push('(a.name ILIKE :like OR a."fatherName" ILIKE :like OR a.cnic ILIKE :like OR a.phone ILIKE :like OR replace(a.cnic, \'-\', \'\') ILIKE :like)');
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY a.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const files = await filesOf(rows.map((r) => r.id));
  const approver = await isApprover(req);
  return { data: rows.map((r) => json(r, files.get(r.id), approver)), page, limit, total: n };
}

/** The numbers of the tabs of the Applications screen. */
async function summary(req) {
  const [t] = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE status = 'IN_REVIEW')::int AS "inReview",
    count(*) FILTER (WHERE status = 'APPROVED')::int AS approved, count(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
    FROM payroll_joining_applications WHERE "companyId" = :companyId`, { companyId: req.user.companyId });
  return t;
}

const taken = (e) => { throw e; };

/** Only a draft can be edited, deleted or get documents. */
function assertDraft(cur) {
  if (cur.status === 'IN_REVIEW') throw AppError.rule('APPLICATION_IN_REVIEW', 'An application in review is locked: withdraw it first');
  if (cur.status !== 'DRAFT') throw AppError.rule('APPLICATION_CLOSED', `This application is ${STATUS_TEXT[cur.status].toLowerCase()}`);
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-application:${companyId}` }, transaction });
    await ensureGroups(companyId, transaction);
    const v = clean(data);
    if (data.remarks !== undefined) v.remarks = data.remarks === '' ? null : data.remarks;
    await checkRefs(companyId, v, new Set(Object.keys(v)), transaction);
    v.paymentMethod = appMethod(v, data.paymentMethod);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_joining_applications WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const cols = Object.keys(v);
    const [row] = await q(`INSERT INTO payroll_joining_applications ("companyId", code, "createdById", "updatedById", ${cols.map((c) => `"${c}"`).join(', ')})
      VALUES (:companyId, :code, :userId, :userId, ${cols.map((c) => `:${c}`).join(', ')}) RETURNING id`, { companyId, code, userId: req.user.id, ...v }, transaction).catch(taken);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_CREATED', entityType: 'PayrollJoiningApplication', entityId: row.id, after: { code, name: v.name, group: v.groupId } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

async function lockRow(companyId, id, transaction) {
  const [cur] = await q('SELECT * FROM payroll_joining_applications WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!cur) throw AppError.notFound('Application');
  return cur;
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const before = json(await loadRow(companyId, id, transaction));
    const v = clean(changes);
    if (changes.remarks !== undefined) v.remarks = changes.remarks === '' ? null : changes.remarks;
    const merged = { ...cur, ...v };
    await checkRefs(companyId, merged, new Set(Object.keys(v)), transaction);
    if (['bankId', 'accountNo', 'paymentMethod'].some((k) => v[k] !== undefined)) v.paymentMethod = appMethod(merged, changes.paymentMethod);
    const cols = Object.keys(v);
    if (cols.length) await run(`UPDATE payroll_joining_applications SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...v }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_UPDATED', entityType: 'PayrollJoiningApplication', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

/** What must be there before the application can go for review. */
async function missingFor(cur, transaction) {
  const missing = [];
  for (const key of ['cnic', 'departmentId', 'designationId', 'shiftId']) if (!cur[key]) missing.push(key);
  if (!(toCents(cur.basicSalary) > 0n)) missing.push('basicSalary');
  const have = new Set((await q('SELECT kind FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id', { owner: OWNER, id: cur.id }, transaction)).map((f) => f.kind));
  for (const k of REQUIRED_FILES) if (!have.has(FILE_KINDS[k])) missing.push(`file:${k}`);
  return missing;
}

/** The person must be new to the company and the department must have a seat. `approving`: applications still in review do not hold a seat yet, only working employees do. */
async function checkHire(companyId, cur, transaction, approving) {
  const [emp] = await q('SELECT code, name, "isClosed" FROM payroll_employees WHERE "companyId" = :companyId AND cnic = :cnic', { companyId, cnic: cur.cnic }, transaction);
  if (emp) {
    throw AppError.rule('CNIC_TAKEN', emp.isClosed ? `${emp.name} (ID ${emp.code}) has left the company: re-open that employee card instead of a new application` : `An employee with this CNIC already exists (${emp.name}, ID ${emp.code})`);
  }
  if (!approving) {
    const [dup] = await q('SELECT code FROM payroll_joining_applications WHERE "companyId" = :companyId AND cnic = :cnic AND status = \'IN_REVIEW\' AND id <> :id', { companyId, cnic: cur.cnic, id: cur.id }, transaction);
    if (dup) throw AppError.rule('CNIC_IN_REVIEW', `Application JA-${pad5(dup.code)} with this CNIC is already in review`);
  }
  // the approved head-count (fte 0 = not set = no limit) against the working employees (and, when sending, the applications already in review)
  const [dept] = await q('SELECT name, fte FROM payroll_departments WHERE id = :d AND "companyId" = :companyId FOR UPDATE', { d: cur.departmentId, companyId }, transaction);
  if (dept && dept.fte > 0) {
    const [{ n }] = await q(`SELECT (SELECT count(*) FROM payroll_employees WHERE "departmentId" = :d AND NOT "isClosed")
      + (SELECT count(*) FROM payroll_joining_applications WHERE "departmentId" = :d AND status = 'IN_REVIEW' AND id <> :id AND NOT :approving) AS n`, { d: cur.departmentId, id: cur.id, approving }, transaction);
    if (Number(n) >= dept.fte) throw AppError.rule('NO_VACANCY', `${dept.name} has no vacancy: ${n} of ${dept.fte} seats are taken`, { department: dept.name, fte: dept.fte, taken: Number(n) });
  }
}

/** HR sends the application for review: complete, not a person we already have, and the department must have a vacancy. */
async function submit(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status === 'IN_REVIEW') throw AppError.rule('ALREADY_IN_REVIEW', 'This application is already in review');
    assertDraft(cur);
    const missing = await missingFor(cur, transaction);
    if (missing.length) throw AppError.rule('APPLICATION_INCOMPLETE', 'Fill in the missing details before sending for review', { missing });
    await checkHire(companyId, cur, transaction, false);
    await run('UPDATE payroll_joining_applications SET status = \'IN_REVIEW\', "submittedAt" = now(), "submittedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_SUBMITTED', entityType: 'PayrollJoiningApplication', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  return get(req, id);
}

async function withdraw(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review');
    await run('UPDATE payroll_joining_applications SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_WITHDRAWN', entityType: 'PayrollJoiningApplication', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    await run('DELETE FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id', { owner: OWNER, id }, transaction);
    await run('DELETE FROM payroll_joining_applications WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_DELETED', entityType: 'PayrollJoiningApplication', entityId: id, before: { code: cur.code, name: cur.name } }, { transaction });
  });
}

// ---- the review: correct the salary and work details, approve (makes the employee card) or reject ----

async function assertApprover(req) {
  if (!(await isApprover(req))) throw AppError.forbidden('Only a reviewer (a client admin or a person chosen as approver) can do this');
}
const assertInReview = (cur) => { if (cur.status !== 'IN_REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'This application is not in review'); };

/** The reviewer corrects the work and salary details of an application in review. */
async function reviewUpdate(req, id, changes) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const before = json(await loadRow(companyId, id, transaction));
    const v = clean(changes);
    if (changes.remarks !== undefined) v.remarks = changes.remarks === '' ? null : changes.remarks;
    for (const k of Object.keys(v)) if (!REVIEW_FIELDS.includes(k)) delete v[k];
    const merged = { ...cur, ...v };
    await checkRefs(companyId, merged, new Set(Object.keys(v)), transaction);
    const missing = [];
    for (const key of ['departmentId', 'designationId', 'shiftId']) if (!merged[key]) missing.push(key);
    if (!(toCents(merged.basicSalary) > 0n)) missing.push('basicSalary');
    if (missing.length) throw AppError.rule('APPLICATION_INCOMPLETE', 'These details cannot be empty on an application in review', { missing });
    const cols = Object.keys(v);
    if (cols.length) await run(`UPDATE payroll_joining_applications SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...v }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_REVIEW_EDITED', entityType: 'PayrollJoiningApplication', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  return get(req, id);
}

/** Approve: the employee card is made (confirmed) from the application, with its photo and CNIC copies. */
async function approve(req, id) {
  const { companyId } = req.user;
  await assertApprover(req);
  let employeeId;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-employee:${companyId}` }, transaction });
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    const missing = await missingFor(cur, transaction);
    if (missing.length) throw AppError.rule('APPLICATION_INCOMPLETE', 'The application is not complete', { missing });
    await checkRefs(companyId, cur, new Set(['groupId', 'departmentId', 'designationId', 'shiftId', 'bankId']), transaction);
    await checkHire(companyId, cur, transaction, true);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_employees WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const cols = COLUMNS.map((c) => `"${c}"`).join(', ');
    const [emp] = await q(`INSERT INTO payroll_employees ("companyId", code, status, "confirmedAt", "confirmedById", "createdById", "updatedById", ${cols})
      SELECT "companyId", :code, 'CONFIRMED', now(), :userId, :userId, :userId, ${cols} FROM payroll_joining_applications WHERE id = :id RETURNING id`, { id, code, userId: req.user.id }, transaction)
      .catch((e) => { if (e && e.name === 'SequelizeUniqueConstraintError') throw AppError.rule('CNIC_TAKEN', 'An employee with this CNIC already exists'); throw e; });
    await run(`INSERT INTO payroll_files ("companyId", "ownerType", "ownerId", kind, "fileName", "mimeType", size, sha256, data, "uploadedById")
      SELECT "companyId", 'EMPLOYEE', :emp, kind, "fileName", "mimeType", size, sha256, data, "uploadedById" FROM payroll_files
      WHERE "ownerType" = :owner AND "ownerId" = :id AND kind IN ('PHOTO', 'CNIC_FRONT', 'CNIC_BACK')`, { emp: emp.id, owner: OWNER, id }, transaction);
    employeeId = emp.id;
    await run('UPDATE payroll_joining_applications SET status = \'APPROVED\', "approvedAt" = now(), "approvedById" = :userId, "employeeId" = :emp, "updatedAt" = now() WHERE id = :id', { id, emp: emp.id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_CREATED', entityType: 'PayrollEmployee', entityId: emp.id, after: { code, name: cur.name, group: cur.groupId, fromApplication: cur.code } }, { transaction });
    await audit.log(req, { action: 'PAYROLL_APPLICATION_APPROVED', entityType: 'PayrollJoiningApplication', entityId: id, after: { code: cur.code, name: cur.name, employeeId: emp.id, employeeCode: code } }, { transaction });
  });
  await attendanceRefresh.employeeChanged(companyId, employeeId); // the punches that came before the employee existed now count
  return get(req, id);
}

async function reject(req, id, { reason }) {
  const { companyId } = req.user;
  await assertApprover(req);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertInReview(cur);
    await run('UPDATE payroll_joining_applications SET status = \'REJECTED\', "rejectedAt" = now(), "rejectedById" = :userId, "rejectReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_REJECTED', entityType: 'PayrollJoiningApplication', entityId: id, after: { code: cur.code, name: cur.name, reason } }, { transaction });
  });
  return get(req, id);
}

/** HR takes a rejected application back to draft, to correct it and send it again. */
async function reopen(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status !== 'REJECTED') throw AppError.rule('NOT_REJECTED', 'This application is not rejected');
    await run('UPDATE payroll_joining_applications SET status = \'DRAFT\', "submittedAt" = NULL, "submittedById" = NULL, "rejectedAt" = NULL, "rejectedById" = NULL, "rejectReason" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_APPLICATION_REOPENED', entityType: 'PayrollJoiningApplication', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  return get(req, id);
}

// ---- files ----

async function saveFile(req, id, kindParam, { buffer, fileName }) {
  const { companyId } = req.user;
  const kind = FILE_KINDS[kindParam];
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw AppError.rule('NO_FILE', 'Send the file as the body of the request (JPG, PNG or PDF)');
  if (buffer.length > MAX_FILE) throw AppError.rule('FILE_TOO_LARGE', 'The file is more than 2 MB');
  const type = detect(buffer);
  if (!type) throw AppError.rule('FILE_TYPE', 'Only JPG, PNG or PDF files are accepted');
  if (!ALLOWED[kind].includes(type.mime)) throw AppError.rule('FILE_TYPE', `This document must be ${ALLOWED[kind].map((m) => m.split('/')[1].toUpperCase()).join(' or ')}`);
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    await run(`INSERT INTO payroll_files ("companyId", "ownerType", "ownerId", kind, "fileName", "mimeType", size, sha256, data, "uploadedById")
      VALUES (:companyId, :owner, :id, :kind, :fileName, :mime, :size, :sha, :data, :userId)
      ON CONFLICT ("ownerType", "ownerId", kind) DO UPDATE SET "fileName" = EXCLUDED."fileName", "mimeType" = EXCLUDED."mimeType", size = EXCLUDED.size, sha256 = EXCLUDED.sha256,
        data = EXCLUDED.data, "uploadedById" = EXCLUDED."uploadedById", "updatedAt" = now()`,
    { companyId, owner: OWNER, id, kind, fileName: cleanName(fileName, type.ext), mime: type.mime, size: buffer.length, sha: crypto.createHash('sha256').update(buffer).digest('hex'), data: buffer, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_FILE_SAVED', entityType: 'PayrollJoiningApplication', entityId: id, after: { kind, mimeType: type.mime, size: buffer.length } }, { transaction });
  });
  return get(req, id);
}

async function readFile(req, id, kindParam) {
  const { companyId } = req.user;
  await loadRow(companyId, id);
  const [f] = await q('SELECT "fileName", "mimeType", size, data FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id AND kind = :kind AND "companyId" = :companyId', { owner: OWNER, id, kind: FILE_KINDS[kindParam], companyId });
  if (!f) throw AppError.notFound('File');
  return f;
}

async function removeFile(req, id, kindParam) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    assertDraft(cur);
    const [gone] = await run('DELETE FROM payroll_files WHERE "ownerType" = :owner AND "ownerId" = :id AND kind = :kind AND "companyId" = :companyId RETURNING id', { owner: OWNER, id, kind: FILE_KINDS[kindParam], companyId }, transaction);
    if (!gone.length) throw AppError.notFound('File');
    await audit.log(req, { action: 'PAYROLL_FILE_DELETED', entityType: 'PayrollJoiningApplication', entityId: id, after: { kind: FILE_KINDS[kindParam] } }, { transaction });
  });
  return get(req, id);
}

module.exports = { list, summary, get, create, update, submit, withdraw, reviewUpdate, approve, reject, reopen, remove, saveFile, readFile, removeFile, MAX_FILE, COLUMNS };
