// Salary increment during the year (owner 2026-11-09): the salary and the three allowances (food, mobile, maintenance) of ONE employee raised, with the approval trail
//   DRAFT 0   made from the employee list (the new figures are the current ones) or from a CSV, edited by HR
//   REVIEW 1  submitted: locked; the approver can send it on (FINAL_REVIEW 2), send it back or reject it with a reason (back to DRAFT with the reason shown)
//   APPROVED 3 (Posted)  the employee master is updated: salary AND allowances; the increment stays as the history (old -> new, date, approver)
// The current figures are read live from the employee master until the increment is posted. An employee has one open increment at a time. The month an increment applies from is
// optional: a payroll of an EARLIER month made after the posting still takes the old figures (see salaryAsOf).
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const accountService = require('./accountService');
const audit = require('./auditService');
const { isApprover } = require('./payrollApproverService');
const { serviceText } = require('./payrollResignationService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad4 = (n) => String(n).padStart(4, '0');
const pad5 = (n) => String(n).padStart(5, '0');
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const monthCode = (m) => `${m.slice(5, 7)}${m.slice(0, 4)}`;

const STATUS = {
  DRAFT: { code: 0, text: 'Draft' }, REVIEW: { code: 1, text: 'Review' }, FINAL_REVIEW: { code: 2, text: 'Final Review' }, APPROVED: { code: 3, text: 'Posted' },
};
const HEADS = [['salary', 'Salary', 'Salary', 'basicSalary'], ['food', 'Food', 'Food', 'foodAllowance'], ['mobile', 'Mobile', 'Mobile', 'mobileAllowance'], ['maintenance', 'Maint', 'Maintenance', 'maintenanceAllowance']];
const cap = (k) => k[0].toUpperCase() + k.slice(1);

const lock = (companyId, transaction) => run('SELECT pg_advisory_xact_lock(hashtext(:key))', { key: `payroll-increment:${companyId}` }, transaction);

// the figures as they are now: live from the master until posted, the stored snapshot afterwards
const LIVE = (stored, master) => `CASE WHEN i.status = 'APPROVED' THEN i."${stored}" ELSE e."${master}" END`;
const SELECT = `i.id, i.code, i.status, i."employeeId", to_char(i."applicationDate", 'YYYY-MM-DD') AS "applicationDate", to_char(i."effectiveMonth", 'YYYY-MM') AS "effectiveMonth", i.remarks, i.source,
  ${HEADS.map(([k, , , col]) => `(${LIVE(`cur${cap(k)}`, col)})::text AS "cur${cap(k)}", i."new${cap(k)}"::text AS "new${cap(k)}"`).join(', ')},
  i."rejectReason", i."rejectedAt", rb.name AS "rejectedByName", i."submittedAt", sb.name AS "submittedByName", i."reviewedAt", vb.name AS "reviewedByName", i."approvedAt", ab.name AS "approvedByName",
  cb.name AS "createdByName", i."createdAt", i."updatedAt",
  e.code AS "empCode", e.name AS "empName", e.cnic, e."isClosed", e.status AS "empStatus", to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, e."groupId", g.name AS "groupName", d.name AS "departmentName", ds.name AS "designationName",
  EXISTS (SELECT 1 FROM payroll_files f WHERE f."ownerType" = 'EMPLOYEE' AND f."ownerId" = e.id AND f.kind = 'PHOTO') AS "hasPhoto"`;
const FROM = `payroll_increments i JOIN payroll_employees e ON e.id = i."employeeId" JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId"
  LEFT JOIN payroll_designations ds ON ds.id = e."designationId" LEFT JOIN users sb ON sb.id = i."submittedById" LEFT JOIN users vb ON vb.id = i."reviewedById" LEFT JOIN users ab ON ab.id = i."approvedById"
  LEFT JOIN users rb ON rb.id = i."rejectedById" LEFT JOIN users cb ON cb.id = i."createdById"`;

const sum = (r, prefix) => HEADS.reduce((t, [k]) => t + toCents(r[`${prefix}${cap(k)}`]), 0n);
const pct = (inc, cur) => (cur > 0n ? Number((inc * 20000n + cur) / (2n * cur)) / 100 : 0); // percent with 2 decimals, half up

function json(r, approver) {
  const st = STATUS[r.status];
  const open = r.status !== 'APPROVED';
  const curTotal = sum(r, 'cur');
  const newTotal = sum(r, 'new');
  const heads = HEADS.map(([k, short, label]) => {
    const cur = toCents(r[`cur${cap(k)}`]);
    const nw = toCents(r[`new${cap(k)}`]);
    return { key: k, label: short, name: label, current: fromCents(cur), increase: fromCents(nw - cur), final: fromCents(nw) };
  });
  return {
    id: r.id, code: r.code, appId: pad5(r.code), status: r.status, statusCode: st.code, statusText: st.text, posted: r.status === 'APPROVED',
    employee: { id: r.employeeId, code: r.empCode, label: pad5(r.empCode), emplId: pad4(r.empCode), name: r.empName, cnic: r.cnic, group: { id: r.groupId, name: r.groupName }, department: r.departmentName,
      designation: r.designationName, joiningDate: r.joined, service: serviceText(r.joined, today()), hasPhoto: r.hasPhoto, isClosed: r.isClosed,
      photoUrl: r.hasPhoto ? `/api/v1/payroll/employees/${r.employeeId}/files/photo` : null },
    applicationDate: r.applicationDate, effectiveMonth: r.effectiveMonth, monthCode: r.effectiveMonth ? monthCode(r.effectiveMonth) : null, monthLabel: r.effectiveMonth ? monthLabel(r.effectiveMonth) : null,
    // the list columns: the salary head
    currentSalary: fromCents(toCents(r.curSalary)), newSalary: fromCents(toCents(r.newSalary)), increase: fromCents(toCents(r.newSalary) - toCents(r.curSalary)),
    heads, total: { current: fromCents(curTotal), increase: fromCents(newTotal - curTotal), final: fromCents(newTotal) }, percent: pct(newTotal - curTotal, curTotal),
    remarks: r.remarks, source: r.source, rejectReason: r.rejectReason, rejectedAt: r.rejectedAt, rejectedBy: r.rejectedAt ? { name: r.rejectedByName } : null,
    createdBy: { name: r.createdByName }, submittedAt: r.submittedAt, submittedBy: r.submittedAt ? { name: r.submittedByName } : null, reviewedAt: r.reviewedAt, reviewedBy: r.reviewedAt ? { name: r.reviewedByName } : null,
    approvedAt: r.approvedAt, approvedBy: r.approvedAt ? { name: r.approvedByName } : null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    canEdit: r.status === 'DRAFT' && !r.isClosed, canDelete: r.status === 'DRAFT', canSubmit: r.status === 'DRAFT' && !r.isClosed, canWithdraw: r.status === 'REVIEW',
    canFinalReview: approver && r.status === 'REVIEW', canApprove: approver && ['REVIEW', 'FINAL_REVIEW'].includes(r.status), canSendBack: approver && open && r.status !== 'DRAFT', canReject: approver && open && r.status !== 'DRAFT',
  };
}

async function approverNames(companyId) {
  const rows = await q(`SELECT name FROM users WHERE "companyId" = :companyId AND "isActive" AND ("userType" = 'CLIENT_ADMIN' OR id IN (SELECT "userId" FROM payroll_approvers WHERE "companyId" = :companyId)) ORDER BY lower(name)`, { companyId });
  return rows.map((r) => r.name);
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE i.id = :id AND i."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF i' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Salary increment');
  return r;
}

// ---- the list ----

function listWhere(companyId, { status, search, groupId, month }) {
  const where = ['i."companyId" = :companyId'];
  const repl = { companyId };
  if (status) { where.push('i.status = :status'); repl.status = status; }
  if (groupId) { where.push('e."groupId" = :groupId'); repl.groupId = groupId; }
  if (month) { where.push('i."effectiveMonth" = :month'); repl.month = `${month}-01`; }
  if (search) {
    repl.like = `%${search.trim()}%`;
    const digits = search.replace(/\D/g, '');
    const numeric = /^\d{1,8}$/.test(search.trim()) ? ' OR e.code = :n OR i.code = :n' : '';
    if (numeric) repl.n = Number(search.trim());
    if (digits.length >= 4) repl.dlike = `%${digits}%`;
    where.push(`(e.name ILIKE :like OR d.name ILIKE :like OR ds.name ILIKE :like${digits.length >= 4 ? ` OR replace(e.cnic, '-', '') LIKE :dlike` : ''}${numeric})`);
  }
  return { w: where.join(' AND '), repl };
}

/** GET /payroll/increments?status=&search=&groupId=: the tab of the screen: the records, the counts of all the tabs and the two cards. */
async function list(req, f) {
  const { companyId } = req.user;
  const { w, repl } = listWhere(companyId, f);
  const limit = f.limit || 200;
  const page = f.page || 1;
  const [card] = await q(`SELECT count(*)::int AS records, COALESCE(SUM(i."newSalary" - (${LIVE('curSalary', 'basicSalary')})), 0)::text AS "salaryIncrease",
      COALESCE(SUM((i."newSalary" + i."newFood" + i."newMobile" + i."newMaintenance") - ((${LIVE('curSalary', 'basicSalary')}) + (${LIVE('curFood', 'foodAllowance')}) + (${LIVE('curMobile', 'mobileAllowance')}) + (${LIVE('curMaintenance', 'maintenanceAllowance')}))), 0)::text AS "totalIncrease"
    FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY i.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const [c] = await q(`SELECT count(*) FILTER (WHERE status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE status = 'REVIEW')::int AS review, count(*) FILTER (WHERE status = 'FINAL_REVIEW')::int AS "finalReview",
    count(*) FILTER (WHERE status = 'APPROVED')::int AS posted FROM payroll_increments WHERE "companyId" = :companyId`, { companyId });
  const approver = await isApprover(req);
  return { data: rows.map((r) => json(r, approver)), page, limit, total: card.records, counts: c,
    cards: { records: card.records, totalIncrease: fromCents(toCents(card.salaryIncrease)), totalIncreaseAll: fromCents(toCents(card.totalIncrease)) } };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET /payroll/increments/csv: the records of the tab as a CSV file. */
async function csv(req, f) {
  const { w, repl } = listWhere(req.user.companyId, f);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY i.code DESC LIMIT 20000`, repl);
  const head = ['ID', 'EmployeeID', 'Name', 'Department', 'Class', 'Month', 'Current_Salary', 'New_Salary', 'Increase', 'Status'];
  const lines = [head.join(',')];
  for (const r of rows.map((x) => json(x, false))) {
    lines.push([r.appId, r.employee.code, r.employee.name, r.employee.department, r.employee.group.name, r.monthCode, r.currentSalary, r.newSalary, r.increase, r.statusText].map(csvCell).join(','));
  }
  return { text: `${lines.join('\n')}\n`, fileName: `salary-increments-${(f.status || 'all').toLowerCase()}.csv` };
}

const sampleCsv = () => ({ text: 'EmployeeID,New_Salary,month_code,Remarks\n564,75000,112026,Annual increment\n550,64000,,Performance\n', fileName: 'salary-increment-sample.csv' });

// ---- the employee list (select) ----

/** GET /payroll/increments/employees: the working employees the increments can be made for (the "List of employees" box). */
async function employees(req, { groupId, search, page, limit }) {
  const { companyId } = req.user;
  const where = [`e."companyId" = :companyId`, `e.status = 'CONFIRMED'`, 'NOT e."isClosed"'];
  const repl = { companyId };
  if (groupId) { where.push('e."groupId" = :groupId'); repl.groupId = groupId; }
  if (search) {
    repl.like = `%${search.trim()}%`;
    const digits = search.replace(/\D/g, '');
    const numeric = /^\d{1,8}$/.test(search.trim()) ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(search.trim());
    if (digits.length >= 4) repl.dlike = `%${digits}%`;
    where.push(`(e.name ILIKE :like OR d.name ILIKE :like OR ds.name ILIKE :like${digits.length >= 4 ? ` OR replace(e.cnic, '-', '') LIKE :dlike` : ''}${numeric})`);
  }
  const from = `payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"`;
  const w = where.join(' AND ');
  const [n] = await q(`SELECT count(*)::int AS n FROM ${from} WHERE ${w}`, repl);
  const rows = await q(`SELECT e.id, e.code, e.name, e.cnic, ds.name AS designation, d.name AS department, g.id AS "groupId", g.name AS "groupName", e."basicSalary"::text AS salary, to_char(e."joiningDate", 'YYYY-MM-DD') AS joined,
      (e."accountNo" IS NOT NULL AND e."accountNo" <> '') AS "hasAccount", EXISTS (SELECT 1 FROM payroll_increments i WHERE i."employeeId" = e.id AND i.status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW')) AS "hasOpen"
    FROM ${from} WHERE ${w} ORDER BY lower(e.name), e.code LIMIT :limit OFFSET :offset`, { ...repl, limit: limit || 200, offset: ((page || 1) - 1) * (limit || 200) });
  return { data: rows.map((r) => ({ id: r.id, code: r.code, label: pad5(r.code), name: r.name, cnic: r.cnic, designation: r.designation, department: r.department, group: { id: r.groupId, name: r.groupName },
    salary: fromCents(toCents(r.salary)), joiningDate: r.joined, payrollAccount: r.hasAccount, hasOpenIncrement: r.hasOpen })), page: page || 1, limit: limit || 200, total: n.n };
}

// ---- making and changing ----

const nextCode = async (companyId, transaction) => ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_increments WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;

async function insertDraft(req, e, { applicationDate, newSalary, effectiveMonth, remarks, source }, transaction) {
  const { companyId } = req.user;
  const code = await nextCode(companyId, transaction);
  const cur = { Salary: e.basicSalary, Food: e.foodAllowance, Mobile: e.mobileAllowance, Maintenance: e.maintenanceAllowance };
  const [{ id }] = await q(`INSERT INTO payroll_increments ("companyId", code, "employeeId", "applicationDate", "effectiveMonth", "curSalary", "curFood", "curMobile", "curMaintenance",
      "newSalary", "newFood", "newMobile", "newMaintenance", remarks, source, "createdById", "updatedById")
    VALUES (:companyId, :code, :employeeId, :applicationDate, :effectiveMonth, :cs, :cf, :cm, :cmt, :ns, :cf, :cm, :cmt, :remarks, :source, :userId, :userId) RETURNING id`,
  { companyId, code, employeeId: e.id, applicationDate: applicationDate || today(), effectiveMonth: effectiveMonth ? `${effectiveMonth}-01` : null, cs: cur.Salary, cf: cur.Food, cm: cur.Mobile, cmt: cur.Maintenance,
    ns: newSalary == null ? cur.Salary : newSalary, remarks: remarks || null, source, userId: req.user.id }, transaction);
  await audit.log(req, { action: 'PAYROLL_INCREMENT_CREATED', entityType: 'PayrollIncrement', entityId: id, after: { code, employee: e.name, newSalary: newSalary == null ? null : newSalary } }, { transaction });
  return { id, code };
}

const EMP_COLS = 'id, code, name, "isClosed", status, "basicSalary"::text AS "basicSalary", "foodAllowance"::text AS "foodAllowance", "mobileAllowance"::text AS "mobileAllowance", "maintenanceAllowance"::text AS "maintenanceAllowance"';

/** POST /payroll/increments {employeeIds, applicationDate?}: a draft for each selected employee (new = current). Employees who cannot get one are reported. */
async function create(req, { employeeIds, applicationDate }) {
  const { companyId } = req.user;
  const created = [];
  const skipped = [];
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const ids = [...new Set(employeeIds)];
    const emps = await q(`SELECT ${EMP_COLS} FROM payroll_employees WHERE "companyId" = :companyId AND id IN (:ids) FOR UPDATE`, { companyId, ids }, transaction);
    if (emps.length !== ids.length) throw AppError.notFound('Employee');
    const open = new Set((await q(`SELECT "employeeId" FROM payroll_increments WHERE "companyId" = :companyId AND status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW') AND "employeeId" IN (:ids)`, { companyId, ids }, transaction)).map((r) => r.employeeId));
    for (const e of emps.sort((a, b) => a.code - b.code)) {
      if (e.isClosed) skipped.push({ code: e.code, name: e.name, reason: 'EMPLOYEE_CLOSED' });
      else if (e.status !== 'CONFIRMED') skipped.push({ code: e.code, name: e.name, reason: 'NOT_CONFIRMED' });
      else if (open.has(e.id)) skipped.push({ code: e.code, name: e.name, reason: 'OPEN_INCREMENT' });
      else created.push((await insertDraft(req, e, { applicationDate, source: 'MANUAL' }, transaction)).id);
    }
  });
  return { created: created.length, skipped, data: await Promise.all(created.map((id) => get(req, id))) };
}

const amt = (v) => fromCents(toCents(String(v)));

/** The new figures of a draft: a final figure, or the increase on the current one, per head; none may be below the current figure. */
function newFigures(row, changes) {
  const out = {};
  for (const [k] of HEADS) {
    const cur = toCents(row[`cur${cap(k)}`]);
    const fin = changes[k];
    const inc = changes[`${k}Increase`];
    if (fin !== undefined && inc !== undefined) throw AppError.rule('FINAL_OR_INCREASE', `Give the final ${k} or its increase, not both`);
    let nw = toCents(row[`new${cap(k)}`]);
    if (fin !== undefined) nw = toCents(String(fin));
    else if (inc !== undefined) nw = cur + toCents(String(inc));
    if (nw < cur) throw AppError.rule('BELOW_CURRENT', `The new ${k} cannot be lower than the current ${fromCents(cur)}`, { head: k });
    out[`new${cap(k)}`] = fromCents(nw);
  }
  return out;
}

/** The current figures of the draft read again from the master (they may have changed). */
async function refreshCurrent(id, employeeId, transaction) {
  await run(`UPDATE payroll_increments i SET "curSalary" = e."basicSalary", "curFood" = e."foodAllowance", "curMobile" = e."mobileAllowance", "curMaintenance" = e."maintenanceAllowance"
    FROM payroll_employees e WHERE i.id = :id AND e.id = :employeeId`, { id, employeeId }, transaction);
}

async function get(req, id) {
  const r = await load(req, id);
  const { companyId } = req.user;
  const out = json(r, await isApprover(req));
  const approvers = await approverNames(companyId);
  const by = r.approvedAt ? r.approvedByName : r.reviewedAt ? r.reviewedByName : null;
  out.flow = [
    { step: 1, title: 'Creator', text: 'Submit for approval', by: r.submittedAt ? r.submittedByName : r.createdByName, done: r.status !== 'DRAFT' },
    { step: 2, title: 'Approver', text: by || approvers.join(', '), approvers, by: r.approvedAt ? r.approvedByName : null, current: ['REVIEW', 'FINAL_REVIEW'].includes(r.status), done: r.status === 'APPROVED' },
    { step: 3, title: 'Posted', text: 'Profile Updated', done: r.status === 'APPROVED' },
  ];
  const names = approvers.join(', ');
  out.banner = r.status === 'APPROVED' ? { tone: 'success', title: 'Approved', text: "this increment has been posted to the employee's salary." }
    : r.status === 'REVIEW' ? { tone: 'warning', title: 'Waiting for approval', text: `submitted to the approver (${names}). It can no longer be edited.` }
      : r.status === 'FINAL_REVIEW' ? { tone: 'warning', title: 'Waiting for final approval', text: `with the approver (${names}). It can no longer be edited.` }
        : r.rejectReason ? { tone: 'danger', title: 'Sent back', text: `${r.rejectedByName || 'The approver'}: ${r.rejectReason}` } : { tone: 'info', title: 'Draft', text: 'Change the figures and submit it for approval.' };
  // the history of the employee: the increments posted, the loans, the donations (not built yet)
  const posted = await q(`SELECT to_char("applicationDate", 'YYYY-MM-DD') AS date, "curSalary"::text AS "curSalary", "newSalary"::text AS "newSalary", ("curSalary" + "curFood" + "curMobile" + "curMaintenance")::text AS "curTotal",
      ("newSalary" + "newFood" + "newMobile" + "newMaintenance")::text AS "newTotal", to_char("effectiveMonth", 'YYYY-MM') AS "effectiveMonth" FROM payroll_increments WHERE "employeeId" = :employeeId AND status = 'APPROVED' ORDER BY "applicationDate" DESC, code DESC`, { employeeId: r.employeeId });
  out.salaryHistory = posted.map((p) => ({ date: p.date, last: fromCents(toCents(p.curSalary)), increase: fromCents(toCents(p.newSalary) - toCents(p.curSalary)), new: fromCents(toCents(p.newSalary)),
    totalLast: fromCents(toCents(p.curTotal)), totalIncrease: fromCents(toCents(p.newTotal) - toCents(p.curTotal)), totalNew: fromCents(toCents(p.newTotal)), status: 3, effectiveMonth: p.effectiveMonth }));
  const loans = await q(`SELECT to_char(l."applicationDate", 'YYYY-MM-DD') AS date, l."approvedAmount"::text AS amount, (l."approvedAmount" - COALESCE((SELECT SUM(x.amount) FROM payroll_loan_deductions x WHERE x."loanId" = l.id), 0))::text AS balance
    FROM payroll_loans l WHERE l."employeeId" = :employeeId AND l.status = 'APPROVED' ORDER BY l."applicationDate" DESC, l.code DESC`, { employeeId: r.employeeId });
  out.loanHistory = loans.map((l) => ({ date: l.date, amount: fromCents(toCents(l.amount)), balance: fromCents(toCents(l.balance)) }));
  out.donationHistory = []; // the donation (zakat / charity) module is not built yet
  return out;
}

/** PATCH /payroll/increments/:id (draft only): the final figures or the increases, the remarks, the month it applies from, the date. */
async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'DRAFT') throw AppError.rule('INCREMENT_LOCKED', `An increment in ${STATUS[cur.status].text.toLowerCase()} cannot be edited${cur.status === 'APPROVED' ? '' : ': send it back to draft first'}`);
    if (cur.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    await refreshCurrent(id, cur.employeeId, transaction);
    const fresh = await load(req, id, transaction);
    const figures = newFigures(fresh, changes);
    const set = { ...figures };
    if (changes.remarks !== undefined) set.remarks = changes.remarks || null;
    if (changes.applicationDate !== undefined) set.applicationDate = changes.applicationDate;
    if (changes.effectiveMonth !== undefined) set.effectiveMonth = changes.effectiveMonth ? `${changes.effectiveMonth}-01` : null;
    const keys = Object.keys(set);
    await run(`UPDATE payroll_increments SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, ...set }, transaction);
    await audit.log(req, { action: 'PAYROLL_INCREMENT_UPDATED', entityType: 'PayrollIncrement', entityId: id, after: { code: cur.code, changed: Object.keys(changes) } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'DRAFT') throw AppError.rule('INCREMENT_LOCKED', 'Only a draft can be deleted');
    await run('DELETE FROM payroll_increments WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_INCREMENT_DELETED', entityType: 'PayrollIncrement', entityId: id, before: { code: cur.code, employee: cur.empName } }, { transaction });
  });
}

// ---- the approval ----

const assertApprover = async (req) => { if (!(await isApprover(req))) throw AppError.forbidden('Only a client admin or a chosen approver can do this'); };

/** One step of one increment, inside the caller's transaction. */
async function step(req, id, action, { reason } = {}, transaction) {
  const { companyId } = req.user;
  const cur = await load(req, id, transaction, true);
  const st = cur.status;
  const need = (...from) => { if (!from.includes(st)) throw AppError.rule('WRONG_STATUS', `This increment is in ${STATUS[st].text.toLowerCase()}: it cannot be ${{ submit: 'submitted', withdraw: 'withdrawn', 'final-review': 'sent to final review', approve: 'approved', 'send-back': 'sent back', reject: 'rejected' }[action]}`); };
  if (action === 'submit') {
    need('DRAFT');
    if (cur.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    await refreshCurrent(id, cur.employeeId, transaction);
    const fresh = await load(req, id, transaction);
    newFigures(fresh, {}); // nothing may be below the (refreshed) current figures
    if (sum(fresh, 'new') <= sum(fresh, 'cur')) throw AppError.rule('NO_INCREASE', 'There is no increase: raise the salary or an allowance first');
    await run(`UPDATE payroll_increments SET status = 'REVIEW', "submittedAt" = now(), "submittedById" = :userId, "rejectReason" = NULL, "rejectedAt" = NULL, "rejectedById" = NULL, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id }, transaction);
  } else if (action === 'withdraw') {
    need('REVIEW');
    await run(`UPDATE payroll_increments SET status = 'DRAFT', "submittedAt" = NULL, "submittedById" = NULL, "updatedAt" = now() WHERE id = :id`, { id }, transaction);
  } else if (action === 'final-review') {
    await assertApprover(req);
    need('REVIEW');
    await run(`UPDATE payroll_increments SET status = 'FINAL_REVIEW', "reviewedAt" = now(), "reviewedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id }, transaction);
  } else if (action === 'send-back' || action === 'reject') {
    await assertApprover(req);
    need('REVIEW', 'FINAL_REVIEW');
    if (action === 'reject' && !(reason && reason.trim())) throw AppError.rule('REASON_REQUIRED', 'A rejection needs a reason');
    await run(`UPDATE payroll_increments SET status = 'DRAFT', "submittedAt" = NULL, "submittedById" = NULL, "reviewedAt" = NULL, "reviewedById" = NULL, "rejectReason" = :reason, "rejectedAt" = now(), "rejectedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { id, userId: req.user.id, reason: action === 'reject' ? reason.trim() : null }, transaction);
    if (action === 'send-back') await run('UPDATE payroll_increments SET "rejectedAt" = NULL, "rejectedById" = NULL WHERE id = :id', { id }, transaction);
  } else if (action === 'approve') {
    await assertApprover(req);
    need('REVIEW', 'FINAL_REVIEW');
    // the employee master: locked, read again; the figures must still be an increase on it
    const [e] = await q(`SELECT ${EMP_COLS}, status FROM payroll_employees WHERE id = :id AND "companyId" = :companyId FOR UPDATE`, { id: cur.employeeId, companyId }, transaction);
    if (e.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', `${e.name} has left the company`);
    const live = { Salary: toCents(e.basicSalary), Food: toCents(e.foodAllowance), Mobile: toCents(e.mobileAllowance), Maintenance: toCents(e.maintenanceAllowance) };
    let newTotal = 0n;
    let liveTotal = 0n;
    for (const [k] of HEADS) {
      const nw = toCents(cur[`new${cap(k)}`]);
      if (nw < live[cap(k)]) throw AppError.rule('BELOW_CURRENT', `The salary of ${e.name} changed meanwhile: the ${k} is now ${fromCents(live[cap(k)])}, more than this increment gives. Send it back and correct it`, { head: k });
      newTotal += nw;
      liveTotal += live[cap(k)];
    }
    if (newTotal <= liveTotal) throw AppError.rule('NO_INCREASE', 'There is no increase on the current salary: send it back and correct it');
    await run(`UPDATE payroll_employees SET "basicSalary" = :s, "foodAllowance" = :f, "mobileAllowance" = :m, "maintenanceAllowance" = :t, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { id: cur.employeeId, s: cur.newSalary, f: cur.newFood, m: cur.newMobile, t: cur.newMaintenance, userId: req.user.id }, transaction);
    await run(`UPDATE payroll_increments SET status = 'APPROVED', "curSalary" = :cs, "curFood" = :cf, "curMobile" = :cm, "curMaintenance" = :ct, "approvedAt" = now(), "approvedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { id, cs: fromCents(live.Salary), cf: fromCents(live.Food), cm: fromCents(live.Mobile), ct: fromCents(live.Maintenance), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_EMPLOYEE_SALARY_CHANGED', entityType: 'PayrollEmployee', entityId: cur.employeeId, before: { basicSalary: e.basicSalary, foodAllowance: e.foodAllowance, mobileAllowance: e.mobileAllowance, maintenanceAllowance: e.maintenanceAllowance },
      after: { basicSalary: cur.newSalary, foodAllowance: cur.newFood, mobileAllowance: cur.newMobile, maintenanceAllowance: cur.newMaintenance, increment: cur.code } }, { transaction });
  } else throw AppError.rule('UNKNOWN_ACTION', 'Unknown action');
  await audit.log(req, { action: 'PAYROLL_INCREMENT_MOVED', entityType: 'PayrollIncrement', entityId: id, before: { status: st }, after: { action, code: cur.code, reason: reason || null } }, { transaction });
}

async function move(req, id, action, extra) {
  await sequelize.transaction(async (transaction) => { await lock(req.user.companyId, transaction); await step(req, id, action, extra, transaction); });
  return get(req, id);
}

/** The same step for many increments (the ticked rows). Every one is its own transaction; the answer says what happened to each. */
async function moveMany(req, ids, action, extra) {
  const results = [];
  for (const id of [...new Set(ids)]) {
    try {
      await sequelize.transaction(async (transaction) => { await lock(req.user.companyId, transaction); await step(req, id, action, extra, transaction); });
      results.push({ id, ok: true });
    } catch (e) {
      if (!(e instanceof AppError) || e.status === 403) throw e;
      results.push({ id, ok: false, code: e.code, message: e.message });
    }
  }
  return { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

// ---- the CSV upload ----

function parseMonth(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return { month: null };
  let m = /^(0[1-9]|1[0-2])(20\d\d)$/.exec(s);
  if (m) return { month: `${m[2]}-${m[1]}` };
  m = /^(20\d\d)-(0[1-9]|1[0-2])$/.exec(s);
  return m ? { month: s } : { error: true };
}

/**
 * POST /payroll/increments/import {rows:[{employeeId, newSalary, monthCode, remarks}], dryRun}: drafts from the CSV. The current salary is read live from the employee master. Employees with an
 * increment already open, or whose New_Salary is not higher than the current salary, are skipped.
 */
async function importRows(req, { rows, dryRun, applicationDate }) {
  const { companyId } = req.user;
  let report;
  await sequelize.transaction(async (transaction) => {
    await lock(companyId, transaction);
    const codes = rows.map((r) => (/^\d{1,8}$/.test(String(r.employeeId == null ? '' : r.employeeId).trim()) ? Number(String(r.employeeId).trim()) : null)).filter((c) => c);
    const emps = codes.length ? await q(`SELECT ${EMP_COLS} FROM payroll_employees WHERE "companyId" = :companyId AND code IN (:codes) FOR UPDATE`, { companyId, codes }, transaction) : [];
    const byCode = new Map(emps.map((e) => [e.code, e]));
    const open = new Set((await q(`SELECT "employeeId" FROM payroll_increments WHERE "companyId" = :companyId AND status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW')`, { companyId }, transaction)).map((r) => r.employeeId));
    const seen = new Set();
    const results = [];
    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i];
      const idText = String(raw.employeeId == null ? '' : raw.employeeId).trim();
      const salaryText = String(raw.newSalary == null ? '' : raw.newSalary).trim().replace(/,/g, '');
      const res = { row: i + 1, employeeId: idText || null, newSalary: salaryText || null, monthCode: raw.monthCode == null || raw.monthCode === '' ? null : String(raw.monthCode), remarks: raw.remarks ? String(raw.remarks) : null };
      const e = /^\d{1,8}$/.test(idText) ? byCode.get(Number(idText)) : null;
      const month = parseMonth(raw.monthCode);
      if (!idText) res.status = 'NO_ID';
      else if (!e) res.status = 'NOT_FOUND';
      else {
        res.employee = { code: e.code, name: e.name, currentSalary: fromCents(toCents(e.basicSalary)) };
        if (seen.has(e.id)) res.status = 'DUPLICATE_IN_FILE';
        else if (e.isClosed) res.status = 'EMPLOYEE_CLOSED';
        else if (e.status !== 'CONFIRMED') res.status = 'NOT_CONFIRMED';
        else if (!/^\d{1,10}(\.\d{1,2})?$/.test(salaryText)) res.status = 'INVALID_SALARY';
        else if (month.error) res.status = 'INVALID_MONTH';
        else if (res.remarks && res.remarks.length > 300) res.status = 'INVALID_REMARKS';
        else if (open.has(e.id)) res.status = 'OPEN_INCREMENT';
        else if (toCents(salaryText) <= toCents(e.basicSalary)) res.status = 'NOT_HIGHER';
        else {
          res.status = 'CREATED';
          seen.add(e.id);
          if (!dryRun) { const made = await insertDraft(req, e, { applicationDate, newSalary: amt(salaryText), effectiveMonth: month.month, remarks: res.remarks, source: 'CSV' }, transaction); res.id = made.id; res.appId = pad5(made.code); }
        }
        if (res.status !== 'CREATED') seen.add(e.id);
      }
      results.push(res);
    }
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    report = { dryRun: Boolean(dryRun), total: rows.length, created: counts.CREATED || 0, skipped: rows.length - (counts.CREATED || 0), counts, results: results.slice(0, 2000) };
  });
  return report;
}

/** The salary figures an employee had in a month when an increment that applies from a LATER month has been posted since: { basic, food, maint, mobile } (text), else not in the map. */
async function salaryAsOf(companyId, employeeIds, month, transaction) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await q(`SELECT DISTINCT ON ("employeeId") "employeeId", "curSalary"::text AS basic, "curFood"::text AS food, "curMaintenance"::text AS maint, "curMobile"::text AS mobile
    FROM payroll_increments WHERE "companyId" = :companyId AND status = 'APPROVED' AND "employeeId" IN (:ids) AND "effectiveMonth" > :first ORDER BY "employeeId", "effectiveMonth", code`,
  { companyId, ids: employeeIds, first: `${month.slice(0, 7)}-01` }, transaction);
  for (const r of rows) out.set(r.employeeId, r);
  return out;
}

module.exports = { list, csv, sampleCsv, employees, create, get, update, remove, move, moveMany, importRows, salaryAsOf, STATUS };
