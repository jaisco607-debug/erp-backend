// The Employee master (service PAYROLL_EMPLOYEES): the employee card with personal data, work, salary and payment details, its documents
// (photo, CNIC front and back) and its status.
//   DRAFT      can be edited and deleted.   CONFIRMED  locked ("Edit" = unconfirm takes it back to draft); a confirmed card needs every required field.
//   Closed     the employee has left (a leaving date); a closed card is read only until it is re-opened. A closed employee is never added to a new payroll.
// The departments' head-count (fte) is shown against the working employees (vacancy) but not enforced here, so old employees can be entered freely;
// the joining application blocks a hire above the approved strength.
// Files live in the database (payroll_files, bytea, up to 2 MB): the bytes are read only by `readFile`, never by lists or by the card.
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const accountService = require('./accountService');
const audit = require('./auditService');
const { ensureGroups } = require('./payrollMasterService');
const attendanceRefresh = require('./attendanceRefresh');
const { monthlyDeductions } = require('../utils/payrollDeductions');
const eobiService = require('./eobiService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const money = (v) => fromCents(toCents(v));

const STATUS_TEXT = { DRAFT: 'Draft', CONFIRMED: 'Confirmed' };
const FILE_KINDS = { photo: 'PHOTO', 'cnic-front': 'CNIC_FRONT', 'cnic-back': 'CNIC_BACK' };
const FILE_KEY = { PHOTO: 'photo', CNIC_FRONT: 'cnicFront', CNIC_BACK: 'cnicBack' };
const MAX_FILE = 2 * 1024 * 1024;
// what a file really is is read from its first bytes: the type the browser sends is not trusted
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
];
const ALLOWED = { PHOTO: ['image/jpeg', 'image/png'], CNIC_FRONT: ['image/jpeg', 'image/png', 'application/pdf'], CNIC_BACK: ['image/jpeg', 'image/png', 'application/pdf'] };

const COLUMNS = ['name', 'fatherName', 'motherName', 'cnic', 'ntn', 'dateOfBirth', 'gender', 'maritalStatus', 'religion', 'language', 'phone', 'email', 'address',
  'groupId', 'departmentId', 'designationId', 'shiftId', 'joiningDate', 'salaryType', 'basicSalary', 'foodAllowance', 'maintenanceAllowance', 'mobileAllowance',
  'monthlyIncomeTax', 'eobiNo', 'scssiNo', 'paymentMethod', 'bankId', 'accountNo', 'iban', 'accountTitle'];
const MONEY = ['basicSalary', 'foodAllowance', 'maintenanceAllowance', 'mobileAllowance', 'monthlyIncomeTax'];
const DATES = ['dateOfBirth', 'joiningDate'];
const NULL_IF_EMPTY = ['fatherName', 'motherName', 'cnic', 'ntn', 'religion', 'language', 'phone', 'email', 'address', 'accountNo', 'iban', 'accountTitle', 'eobiNo', 'scssiNo'];

const SELECT = `e.id, e.code, e.name, e."fatherName", e."motherName", e.cnic, e.ntn, to_char(e."dateOfBirth", 'YYYY-MM-DD') AS "dateOfBirth", e.gender, e."maritalStatus", e.religion, e.language,
  e.phone, e.email, e.address, e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", e."designationId", ds.name AS "designationName",
  e."shiftId", s.code AS "shiftCode", to_char(s."startTime", 'HH24:MI') AS "shiftStart", to_char(s."endTime", 'HH24:MI') AS "shiftEnd", s."dutyHours"::float AS "shiftHours",
  to_char(e."joiningDate", 'YYYY-MM-DD') AS "joiningDate", to_char(e."leavingDate", 'YYYY-MM-DD') AS "leavingDate", e."isClosed", e.status, e."confirmedAt",
  e."salaryType", e."basicSalary"::text AS "basicSalary", e."foodAllowance"::text AS "foodAllowance", e."maintenanceAllowance"::text AS "maintenanceAllowance",
  e."mobileAllowance"::text AS "mobileAllowance", e."monthlyIncomeTax"::text AS "monthlyIncomeTax", e."eobiNo", e."scssiNo", e."paymentMethod", e."bankId", b.name AS "bankName", e."accountNo", e.iban, e."accountTitle",
  e."createdAt", e."updatedAt"`;
const FROM = `payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId"
  LEFT JOIN payroll_designations ds ON ds.id = e."designationId" LEFT JOIN payroll_shifts s ON s.id = e."shiftId" LEFT JOIN payroll_banks b ON b.id = e."bankId"`;

/** "4y 6m": the time between two dates (YYYY-MM-DD), whole months. */
function serviceText(from, to) {
  const a = from.split('-').map(Number);
  const b = to.split('-').map(Number);
  let months = (b[0] - a[0]) * 12 + (b[1] - a[1]);
  if (b[2] < a[2]) months -= 1;
  if (months < 0) months = 0;
  const y = Math.floor(months / 12);
  return y ? `${y}y ${months % 12}m` : `${months}m`;
}

function json(r, files, eobiCents = 0n) {
  const named = (id, name) => (id ? { id, name } : null);
  return {
    id: r.id, code: r.code, label: pad5(r.code), name: r.name, fatherName: r.fatherName, motherName: r.motherName, cnic: r.cnic, ntn: r.ntn, dateOfBirth: r.dateOfBirth,
    gender: r.gender, maritalStatus: r.maritalStatus, religion: r.religion, language: r.language, phone: r.phone, email: r.email, address: r.address,
    group: { id: r.groupId, name: r.groupName }, department: named(r.departmentId, r.departmentName), designation: named(r.designationId, r.designationName),
    shift: r.shiftId ? { id: r.shiftId, code: r.shiftCode, label: `${r.shiftCode} (${r.shiftStart}-${r.shiftEnd}, ${r.shiftHours} hrs)`, dutyHours: r.shiftHours } : null,
    joiningDate: r.joiningDate, leavingDate: r.leavingDate, serviceText: serviceText(r.joiningDate, r.leavingDate || today()),
    isClosed: r.isClosed, state: r.isClosed ? 'CLOSED' : 'ACTIVE', status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt,
    salaryType: r.salaryType, basicSalary: money(r.basicSalary), foodAllowance: money(r.foodAllowance), maintenanceAllowance: money(r.maintenanceAllowance),
    mobileAllowance: money(r.mobileAllowance), monthlyIncomeTax: money(r.monthlyIncomeTax), eobiNo: r.eobiNo || null, scssiNo: r.scssiNo || null,
    monthlyDeductions: monthlyDeductions(r, eobiCents),
    paymentMethod: r.paymentMethod, bank: named(r.bankId, r.bankName), accountNo: r.accountNo, iban: r.iban, accountTitle: r.accountTitle,
    files: files || { photo: null, cnicFront: null, cnicBack: null },
    canEdit: r.status === 'DRAFT' && !r.isClosed, canConfirm: r.status === 'DRAFT' && !r.isClosed, canUnconfirm: r.status === 'CONFIRMED' && !r.isClosed,
    canDelete: r.status === 'DRAFT', canClose: !r.isClosed, canReopen: r.isClosed,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function filesOf(ids, transaction) {
  const out = new Map(ids.map((id) => [id, { photo: null, cnicFront: null, cnicBack: null }]));
  if (!ids.length) return out;
  const rows = await q('SELECT "ownerId", kind, "fileName", "mimeType", size, "updatedAt" FROM payroll_files WHERE "ownerType" = \'EMPLOYEE\' AND "ownerId" IN (:ids)', { ids }, transaction);
  for (const f of rows) out.get(f.ownerId)[FILE_KEY[f.kind]] = { fileName: f.fileName, mimeType: f.mimeType, size: f.size, uploadedAt: f.updatedAt };
  return out;
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE e.id = :id AND e."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Employee');
  return r;
}

async function get(req, id, transaction) {
  const r = await loadRow(req.user.companyId, id, transaction);
  const shares = await eobiService.eobiShares(req.user.companyId, [id], today().slice(0, 7), transaction);
  return json(r, (await filesOf([id], transaction)).get(id), shares.get(id));
}

async function list(req, f) {
  const { companyId } = req.user;
  const where = ['e."companyId" = :companyId'];
  const repl = { companyId };
  if (f.closed !== 'all') { where.push('e."isClosed" = :closed'); repl.closed = f.closed === 'true'; }
  for (const k of ['groupId', 'departmentId', 'designationId', 'shiftId', 'status']) if (f[k]) { where.push(`e."${k}" = :${k}`); repl[k] = f[k]; }
  if (f.code) { where.push('e.code = :code'); repl.code = f.code; }
  if (f.name) { where.push('e.name ILIKE :nameLike'); repl.nameLike = `%${f.name}%`; }
  if (f.cnicOrCell) {
    where.push('(e.cnic ILIKE :cc OR e.phone ILIKE :cc OR replace(e.cnic, \'-\', \'\') ILIKE :cc)');
    repl.cc = `%${f.cnicOrCell}%`;
  }
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e."fatherName" ILIKE :like OR e.cnic ILIKE :like OR e.phone ILIKE :like OR d.name ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const files = await filesOf(rows.map((r) => r.id));
  const shares = await eobiService.eobiShares(companyId, rows.map((r) => r.id), today().slice(0, 7));
  return { data: rows.map((r) => json(r, files.get(r.id), shares.get(r.id))), page, limit, total: n };
}

/** The numbers of the tabs of the Employee Master screen: working employees (all and per group), closed, drafts. */
async function summary(req) {
  const { companyId } = req.user;
  await ensureGroups(companyId);
  const groups = await q(`SELECT g.id, g.name, g."systemKey", g."isActive", count(e.id) FILTER (WHERE NOT e."isClosed")::int AS employees, count(e.id) FILTER (WHERE e."isClosed")::int AS closed
    FROM payroll_groups g LEFT JOIN payroll_employees e ON e."groupId" = g.id WHERE g."companyId" = :companyId GROUP BY g.id ORDER BY g."sortOrder", lower(g.name)`, { companyId });
  const [t] = await q(`SELECT count(*) FILTER (WHERE NOT "isClosed")::int AS active, count(*) FILTER (WHERE "isClosed")::int AS closed,
      count(*) FILTER (WHERE NOT "isClosed" AND status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE NOT "isClosed" AND status = 'CONFIRMED')::int AS confirmed
    FROM payroll_employees WHERE "companyId" = :companyId`, { companyId });
  return { total: t.active, closed: t.closed, draft: t.draft, confirmed: t.confirmed, groups: groups.map((g) => ({ id: g.id, name: g.name, isDefault: Boolean(g.systemKey), isActive: g.isActive, employees: g.employees, closed: g.closed })) };
}

/** Normalises what the client sent: capitals are done by the validator; empty texts become null, amounts are exact. */
function clean(data) {
  const v = {};
  for (const c of COLUMNS) if (data[c] !== undefined) v[c] = data[c];
  for (const c of NULL_IF_EMPTY) if (v[c] === '') v[c] = null;
  if (v.monthlyIncomeTax === null) v.monthlyIncomeTax = '0.00'; // an empty tax is 0
  for (const c of MONEY) if (v[c] !== undefined && v[c] !== null) v[c] = money(v[c]);
  return v;
}

/** Group, department, designation, shift and bank must be the company's own; a newly chosen one must be switched on; the department must be of the group. */
async function checkRefs(companyId, merged, changed, transaction) {
  const one = async (table, id, label, key) => {
    const [r] = await q(`SELECT id, "isActive" FROM ${table} WHERE id = :id AND "companyId" = :companyId`, { id, companyId }, transaction);
    if (!r) throw AppError.notFound(label);
    if (changed.has(key) && !r.isActive) throw AppError.rule(`${label.toUpperCase()}_INACTIVE`, `This ${label.toLowerCase()} is switched off`);
  };
  if (changed.has('groupId')) await one('payroll_groups', merged.groupId, 'Group', 'groupId');
  if (merged.departmentId && (changed.has('departmentId') || changed.has('groupId'))) {
    const [d] = await q('SELECT id, "groupId", "isActive" FROM payroll_departments WHERE id = :id AND "companyId" = :companyId', { id: merged.departmentId, companyId }, transaction);
    if (!d) throw AppError.notFound('Department');
    if (d.groupId !== merged.groupId) throw AppError.rule('DEPARTMENT_NOT_IN_GROUP', 'This department belongs to another group');
    if (changed.has('departmentId') && !d.isActive) throw AppError.rule('DEPARTMENT_INACTIVE', 'This department is switched off');
  }
  if (merged.designationId && changed.has('designationId')) await one('payroll_designations', merged.designationId, 'Designation', 'designationId');
  if (merged.shiftId && changed.has('shiftId')) await one('payroll_shifts', merged.shiftId, 'Shift', 'shiftId');
  if (merged.bankId && changed.has('bankId')) await one('payroll_banks', merged.bankId, 'Bank', 'bankId');
}

/** "No bank account: cash automatically". An explicit BANK needs the bank and the account number; if the method is not sent it follows the details. */
function payMethod(merged, explicit, bankPartsChanged) {
  const hasBank = Boolean(merged.bankId && merged.accountNo);
  if (explicit === 'BANK' && !hasBank) throw AppError.rule('BANK_DETAILS_REQUIRED', 'Paying by bank needs the bank and the account number');
  if (explicit) return explicit;
  return bankPartsChanged ? (hasBank ? 'BANK' : 'CASH') : merged.paymentMethod;
}

const taken = (e) => {
  if (e && e.name === 'SequelizeUniqueConstraintError') {
    const field = (e.parent && e.parent.constraint) || '';
    if (field.includes('cnic')) throw AppError.rule('CNIC_TAKEN', 'An employee with this CNIC already exists');
    throw AppError.rule('CODE_TAKEN', 'This employee ID is already used');
  }
  throw e;
};

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-employee:${companyId}` }, transaction });
    await ensureGroups(companyId, transaction);
    const v = clean(data);
    await checkRefs(companyId, v, new Set(Object.keys(v)), transaction);
    v.paymentMethod = payMethod(v, data.paymentMethod, true);
    let code = data.code;
    if (code) {
      if ((await q('SELECT 1 FROM payroll_employees WHERE "companyId" = :companyId AND code = :code', { companyId, code }, transaction)).length) throw AppError.rule('CODE_TAKEN', `Employee ID ${code} is already used`);
    } else {
      code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_employees WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    }
    if (v.cnic && (await q('SELECT 1 FROM payroll_employees WHERE "companyId" = :companyId AND cnic = :cnic', { companyId, cnic: v.cnic }, transaction)).length) throw AppError.rule('CNIC_TAKEN', 'An employee with this CNIC already exists');
    const cols = Object.keys(v);
    const [row] = await q(`INSERT INTO payroll_employees ("companyId", code, "createdById", "updatedById", ${cols.map((c) => `"${c}"`).join(', ')})
      VALUES (:companyId, :code, :userId, :userId, ${cols.map((c) => `:${c}`).join(', ')}) RETURNING id`, { companyId, code, userId: req.user.id, ...v }, transaction).catch(taken);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_CREATED', entityType: 'PayrollEmployee', entityId: row.id, after: { code, name: v.name, group: v.groupId } }, { transaction });
    return row.id;
  });
  await attendanceRefresh.employeeChanged(req.user.companyId, id);
  return get(req, id);
}

async function lockRow(companyId, id, transaction) {
  const [cur] = await q('SELECT * FROM payroll_employees WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!cur) throw AppError.notFound('Employee');
  return cur;
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  let since = null;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company: re-open the card to change it');
    if (cur.status === 'CONFIRMED') throw AppError.rule('EMPLOYEE_CONFIRMED', 'A confirmed card is locked: press Edit (un-confirm) first');
    const before = json(await loadRow(companyId, id, transaction));
    since = ['shiftId', 'groupId', 'joiningDate'].some((k) => changes[k] !== undefined) ? before.joiningDate : null;
    const v = clean(changes);
    const merged = { ...cur, ...v };
    await checkRefs(companyId, merged, new Set(Object.keys(v)), transaction);
    const bankChanged = ['bankId', 'accountNo', 'paymentMethod'].some((k) => v[k] !== undefined);
    if (bankChanged) v.paymentMethod = payMethod(merged, changes.paymentMethod, true);
    if (v.cnic && v.cnic !== cur.cnic && (await q('SELECT 1 FROM payroll_employees WHERE "companyId" = :companyId AND cnic = :cnic AND id <> :id', { companyId, cnic: v.cnic, id }, transaction)).length) {
      throw AppError.rule('CNIC_TAKEN', 'An employee with this CNIC already exists');
    }
    const cols = Object.keys(v);
    if (cols.length) {
      await run(`UPDATE payroll_employees SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...v }, transaction).catch(taken);
    }
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_UPDATED', entityType: 'PayrollEmployee', entityId: id, before, after: json(await loadRow(companyId, id, transaction)) }, { transaction });
  });
  // a new shift, group or joining date changes what the days are: they are worked out again
  if (since) await attendanceRefresh.employeeChanged(companyId, id, since);
  return get(req, id);
}

/** The fields a confirmed card must have. */
function missingFor(r) {
  const missing = [];
  for (const [key, label] of [['cnic', 'cnic'], ['departmentId', 'departmentId'], ['designationId', 'designationId'], ['shiftId', 'shiftId']]) if (!r[key]) missing.push(label);
  if (!(toCents(r.basicSalary) > 0n)) missing.push('basicSalary');
  if (r.paymentMethod === 'BANK' && !r.accountTitle) missing.push('accountTitle');
  return missing;
}

async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This card is already confirmed');
    const missing = missingFor(cur);
    if (missing.length) throw AppError.rule('EMPLOYEE_INCOMPLETE', 'Fill in the missing details before confirming', { missing });
    await run(`UPDATE payroll_employees SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_CONFIRMED', entityType: 'PayrollEmployee', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  return get(req, id);
}

async function unconfirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This card is not confirmed');
    await run(`UPDATE payroll_employees SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedAt" = now() WHERE id = :id`, { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_UNCONFIRMED', entityType: 'PayrollEmployee', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  return get(req, id);
}

async function close(req, id, { leavingDate }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const [cur] = await q(`SELECT *, to_char("joiningDate", 'YYYY-MM-DD') AS joined FROM payroll_employees WHERE id = :id AND "companyId" = :companyId FOR UPDATE`, { id, companyId }, transaction);
    if (!cur) throw AppError.notFound('Employee');
    if (cur.isClosed) throw AppError.rule('ALREADY_CLOSED', 'This employee has already left the company');
    if (leavingDate < cur.joined) throw AppError.rule('LEAVING_BEFORE_JOINING', `The leaving date cannot be before the joining date (${cur.joined})`);
    await run('UPDATE payroll_employees SET "isClosed" = true, "leavingDate" = :leavingDate, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, leavingDate, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_CLOSED', entityType: 'PayrollEmployee', entityId: id, after: { code: cur.code, name: cur.name, leavingDate } }, { transaction });
  });
  await attendanceRefresh.employeeChanged(companyId, id);
  return get(req, id);
}

async function reopen(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (!cur.isClosed) throw AppError.rule('NOT_CLOSED', 'This employee has not left the company');
    await run('UPDATE payroll_employees SET "isClosed" = false, "leavingDate" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_REOPENED', entityType: 'PayrollEmployee', entityId: id, after: { code: cur.code, name: cur.name } }, { transaction });
  });
  await attendanceRefresh.employeeChanged(companyId, id);
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await lockRow(companyId, id, transaction);
    if (cur.status === 'CONFIRMED') throw AppError.rule('EMPLOYEE_CONFIRMED', 'A confirmed card cannot be deleted: press Edit (un-confirm) first, or close the employee instead');
    // payslips and loans will count here when those exist
    if ((await q('SELECT 1 FROM payroll_resignations WHERE "employeeId" = :id UNION ALL SELECT 1 FROM payroll_loans WHERE "employeeId" = :id UNION ALL SELECT 1 FROM payroll_leaves WHERE "employeeId" = :id UNION ALL SELECT 1 FROM payroll_slips WHERE "employeeId" = :id LIMIT 1', { id }, transaction)).length) throw AppError.rule('IN_USE', 'This employee has a resignation, loan or leave application or a payslip and cannot be deleted');
    await run('DELETE FROM payroll_files WHERE "ownerType" = \'EMPLOYEE\' AND "ownerId" = :id', { id }, transaction);
    await run('DELETE FROM payroll_employees WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_DELETED', entityType: 'PayrollEmployee', entityId: id, before: { code: cur.code, name: cur.name } }, { transaction });
  });
}

// ---- files ----

/** The type of a file from its first bytes, or null when it is not a JPEG, PNG or PDF. */
const detect = (buffer) => SIGNATURES.find((s) => s.test(buffer)) || null;
const cleanName = (n, ext) => {
  const base = String(n || '').split(/[\\/]/).pop().replace(/[^\w.\- ()]/g, '_').trim().slice(0, 150);
  return base || `file.${ext}`;
};

/** Saves (or replaces) one document of an employee. The file is the raw body of the request. */
async function saveFile(req, id, kindParam, { buffer, fileName }) {
  const { companyId } = req.user;
  const kind = FILE_KINDS[kindParam];
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw AppError.rule('NO_FILE', 'Send the file as the body of the request (JPG, PNG or PDF)');
  if (buffer.length > MAX_FILE) throw AppError.rule('FILE_TOO_LARGE', 'The file is more than 2 MB');
  const type = detect(buffer);
  if (!type) throw AppError.rule('FILE_TYPE', 'Only JPG, PNG or PDF files are accepted');
  if (!ALLOWED[kind].includes(type.mime)) throw AppError.rule('FILE_TYPE', `This document must be ${ALLOWED[kind].map((m) => m.split('/')[1].toUpperCase()).join(' or ')}`);
  await sequelize.transaction(async (transaction) => {
    await lockRow(companyId, id, transaction);
    await run(`INSERT INTO payroll_files ("companyId", "ownerType", "ownerId", kind, "fileName", "mimeType", size, sha256, data, "uploadedById")
      VALUES (:companyId, 'EMPLOYEE', :id, :kind, :fileName, :mime, :size, :sha, :data, :userId)
      ON CONFLICT ("ownerType", "ownerId", kind) DO UPDATE SET "fileName" = EXCLUDED."fileName", "mimeType" = EXCLUDED."mimeType", size = EXCLUDED.size, sha256 = EXCLUDED.sha256,
        data = EXCLUDED.data, "uploadedById" = EXCLUDED."uploadedById", "updatedAt" = now()`,
    { companyId, id, kind, fileName: cleanName(fileName, type.ext), mime: type.mime, size: buffer.length, sha: crypto.createHash('sha256').update(buffer).digest('hex'), data: buffer, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_FILE_SAVED', entityType: 'PayrollEmployee', entityId: id, after: { kind, mimeType: type.mime, size: buffer.length } }, { transaction });
  });
  return get(req, id);
}

/** The bytes of one document (for the download call only). */
async function readFile(req, id, kindParam) {
  const { companyId } = req.user;
  await loadRow(companyId, id);
  const [f] = await q('SELECT "fileName", "mimeType", size, data FROM payroll_files WHERE "ownerType" = \'EMPLOYEE\' AND "ownerId" = :id AND kind = :kind AND "companyId" = :companyId', { id, kind: FILE_KINDS[kindParam], companyId });
  if (!f) throw AppError.notFound('File');
  return f;
}

async function removeFile(req, id, kindParam) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockRow(companyId, id, transaction);
    const [gone] = await run('DELETE FROM payroll_files WHERE "ownerType" = \'EMPLOYEE\' AND "ownerId" = :id AND kind = :kind AND "companyId" = :companyId RETURNING id', { id, kind: FILE_KINDS[kindParam], companyId }, transaction);
    if (!gone.length) throw AppError.notFound('File');
    await audit.log(req, { action: 'PAYROLL_FILE_DELETED', entityType: 'PayrollEmployee', entityId: id, after: { kind: FILE_KINDS[kindParam] } }, { transaction });
  });
  return get(req, id);
}

module.exports = { clean, checkRefs, payMethod, detect, cleanName, COLUMNS, list, summary, get, create, update, confirm, unconfirm, close, reopen, remove, saveFile, readFile, removeFile, serviceText, MAX_FILE };
