// Employee advances (service PAYROLL_APPLICATIONS to change, any payroll service to read), Payroll > Applications > Advance.
//   No approval: when an employee asks for an advance (5,000 ...) HR writes it down. The accountant pays it with an Employee Advance voucher of the accounting module
//   (Debit Employee Advances, Credit Bank / Cash); the next payroll made for that month (or any month after it) takes the WHOLE amount from the salary, and the advance is closed.
//   Status (worked out, never typed):  WAITING_VOUCHER (no confirmed voucher yet) -> PAID (money paid out, not yet recovered) -> RECOVERED (the payroll took it).
//   The form shows the employee's loan history (is it finished, what is left) so HR can see what he already owes before giving an advance.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const accountService = require('./accountService');
const audit = require('./auditService');
const loansSvc = require('./payrollLoanService');
const { amountCents } = require('./voucherSupport');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const money = (c) => fromCents(c);
const STATUS_TEXT = { WAITING_VOUCHER: 'Waiting for voucher', PAID: 'Paid, to be taken from the salary', RECOVERED: 'Recovered from the salary' };
const voucherLabel = (n) => `EAV-${pad5(n)}`;

const PAID = `EXISTS (SELECT 1 FROM employee_advance_vouchers v WHERE v."advanceId" = a.id AND v.status = 'CONFIRMED')`;
const DEDUCTED = 'COALESCE((SELECT SUM(x.amount) FROM payroll_advance_deductions x WHERE x."advanceId" = a.id), 0)';
const SELECT = `a.id, a.code, a."employeeId", to_char(a."advanceDate", 'YYYY-MM-DD') AS "advanceDate", a.amount::text AS amount, a.remarks, a."createdAt", a."updatedAt", cb.name AS "createdByName",
  e.code AS "empCode", e.name AS "empName", e.cnic, e."isClosed", e."basicSalary"::text AS salary, e."groupId", g.name AS "groupName", e."departmentId", d.name AS "departmentName", ds.name AS "designationName",
  ${PAID} AS paid, ${DEDUCTED}::text AS deducted,
  (SELECT to_char(MAX(x.month), 'YYYY-MM') FROM payroll_advance_deductions x WHERE x."advanceId" = a.id) AS "recoveredMonth",
  (SELECT v.id FROM employee_advance_vouchers v WHERE v."advanceId" = a.id ORDER BY v."voucherNo" DESC LIMIT 1) AS "voucherId",
  (SELECT v."voucherNo" FROM employee_advance_vouchers v WHERE v."advanceId" = a.id ORDER BY v."voucherNo" DESC LIMIT 1) AS "voucherNo",
  (SELECT v.status FROM employee_advance_vouchers v WHERE v."advanceId" = a.id ORDER BY v."voucherNo" DESC LIMIT 1) AS "voucherStatus"`;
const FROM = `payroll_advances a JOIN payroll_employees e ON e.id = a."employeeId" JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId"
  LEFT JOIN payroll_designations ds ON ds.id = e."designationId" LEFT JOIN users cb ON cb.id = a."createdById"`;

function json(r) {
  const amount = toCents(r.amount);
  const deducted = toCents(r.deducted);
  const status = deducted >= amount ? 'RECOVERED' : r.paid ? 'PAID' : 'WAITING_VOUCHER';
  const untouched = !r.voucherId && deducted === 0n;
  return {
    id: r.id, code: r.code, appId: pad5(r.code), label: `ADV-${pad5(r.code)}`,
    employee: {
      id: r.employeeId, code: r.empCode, label: pad5(r.empCode), name: r.empName, cnic: r.cnic, group: { id: r.groupId, name: r.groupName },
      department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, designation: r.designationName, salary: money(toCents(r.salary)), isClosed: r.isClosed,
    },
    advanceDate: r.advanceDate, amount: money(amount), remarks: r.remarks,
    status, statusText: STATUS_TEXT[status], paid: Boolean(r.paid), recovered: money(deducted), toRecover: money(r.paid && amount > deducted ? amount - deducted : 0n), recoveredMonth: r.recoveredMonth || null,
    voucher: r.voucherId ? { id: r.voucherId, voucherNo: r.voucherNo, voucherLabel: voucherLabel(r.voucherNo), status: r.voucherStatus } : null,
    createdBy: r.createdByName || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    // an advance nobody has paid or recovered yet can still be changed or deleted
    canEdit: untouched, canDelete: untouched, canPay: !r.voucherId,
  };
}

async function loadRow(companyId, id, transaction) {
  const [r] = await q(`SELECT ${SELECT} FROM ${FROM} WHERE a.id = :id AND a."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Advance');
  return r;
}
const get = async (req, id, transaction) => json(await loadRow(req.user.companyId, id, transaction));

/** GET /payroll/advances?search=&employeeId=&status=&groupId=&departmentId=&from=&to=&page=&limit= */
async function list(req, f) {
  const { companyId } = req.user;
  const where = ['a."companyId" = :companyId'];
  const repl = { companyId };
  if (f.employeeId) { where.push('a."employeeId" = :employeeId'); repl.employeeId = f.employeeId; }
  if (f.departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = f.departmentId; }
  if (f.groupId) { where.push('e."groupId" = :groupId'); repl.groupId = f.groupId; }
  if (f.from) { where.push('a."advanceDate" >= :from'); repl.from = f.from; }
  if (f.to) { where.push('a."advanceDate" <= :to'); repl.to = f.to; }
  if (f.status === 'RECOVERED') where.push(`${DEDUCTED} >= a.amount`);
  if (f.status === 'PAID') where.push(`${PAID} AND ${DEDUCTED} < a.amount`);
  if (f.status === 'WAITING_VOUCHER') where.push(`NOT ${PAID} AND ${DEDUCTED} < a.amount`);
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR a.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like OR replace(e.cnic, '-', '') ILIKE :like OR d.name ILIKE :like OR a.remarks ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [t] = await q(`SELECT count(*)::int AS n, COALESCE(SUM(a.amount), 0)::text AS amount FROM ${FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SELECT} FROM ${FROM} WHERE ${w} ORDER BY a.code DESC LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  return { data: rows.map(json), page, limit, total: t.n, totals: { amount: money(toCents(t.amount)) } };
}

/** The numbers of the tabs: all, waiting for a voucher, paid (to be taken from the salary), recovered; and the money. */
async function summary(req) {
  const [t] = await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE ${DEDUCTED} >= a.amount)::int AS recovered,
      count(*) FILTER (WHERE ${PAID} AND ${DEDUCTED} < a.amount)::int AS paid,
      count(*) FILTER (WHERE NOT ${PAID} AND ${DEDUCTED} < a.amount)::int AS waiting,
      COALESCE(SUM(a.amount), 0)::text AS amount,
      COALESCE(SUM(a.amount - ${DEDUCTED}) FILTER (WHERE ${PAID}), 0)::text AS "toRecover"
    FROM payroll_advances a WHERE a."companyId" = :companyId`, { companyId: req.user.companyId });
  return { total: t.total, waitingVoucher: t.waiting, paid: t.paid, recovered: t.recovered, amount: money(toCents(t.amount)), toRecover: money(toCents(t.toRecover)) };
}

/**
 * GET /payroll/advances/employee/:employeeId: what the advance form shows once an employee is picked: his salary, his LOAN HISTORY (every loan with what was paid out, what the payroll
 * took and what is left, and whether it is finished), and his earlier advances with what is still to be taken from his salary.
 */
async function employeeInfo(req, employeeId) {
  const { companyId } = req.user;
  const [e] = await q(`SELECT e.id, e.code, e.name, e.cnic, e."isClosed", e.status, e."basicSalary"::text AS salary, e."salaryType", e."paymentMethod", g.name AS "groupName", d.name AS "departmentName", ds.name AS "designationName"
    FROM payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId"
    WHERE e.id = :employeeId AND e."companyId" = :companyId`, { employeeId, companyId });
  if (!e) throw AppError.notFound('Employee');
  const loans = (await loansSvc.list(req, { employeeId, page: 1, limit: 200 })).data.filter((l) => l.status === 'APPROVED').map((l) => ({
    id: l.id, appId: l.appId, label: l.label, applicationDate: l.applicationDate, approved: l.approved, months: l.months, deductFrom: l.deductFrom, emi: l.emi,
    paid: l.paid, deducted: l.deducted, balance: l.balance, toPay: l.toPay,
    // finished = the whole loan was paid out and the payroll took it all back
    isFinished: toCents(l.approved) > 0n && toCents(l.paid) >= toCents(l.approved) && toCents(l.deducted) >= toCents(l.paid), statusText: toCents(l.deducted) >= toCents(l.approved) ? 'Finished' : toCents(l.paid) === 0n ? 'Not paid out yet' : 'Running',
  }));
  const advances = (await list(req, { employeeId, page: 1, limit: 50 })).data;
  const open = (a) => a.status !== 'RECOVERED';
  return {
    employee: { id: e.id, code: e.code, label: pad5(e.code), name: e.name, cnic: e.cnic, group: e.groupName, department: e.departmentName, designation: e.designationName, salary: money(toCents(e.salary)), salaryType: e.salaryType, paymentMethod: e.paymentMethod, isClosed: e.isClosed, isConfirmed: e.status === 'CONFIRMED' },
    loans, loanSummary: { count: loans.length, running: loans.filter((l) => l.statusText === 'Running').length, balance: money(loans.reduce((t, l) => t + (toCents(l.balance) > 0n ? toCents(l.balance) : 0n), 0n)) },
    advances: advances.map((a) => ({ id: a.id, appId: a.appId, label: a.label, advanceDate: a.advanceDate, amount: a.amount, status: a.status, statusText: a.statusText, recoveredMonth: a.recoveredMonth })),
    advanceSummary: { pending: money(advances.filter(open).reduce((t, a) => t + toCents(a.amount), 0n)), count: advances.filter(open).length },
  };
}

async function create(req, data) {
  const { companyId } = req.user;
  const cents = amountCents(data.amount, 'Amount');
  const date = data.advanceDate || today();
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-advance:${companyId}` }, transaction });
    const [e] = await q('SELECT id, code, name, "isClosed", status, to_char("joiningDate", \'YYYY-MM-DD\') AS joined FROM payroll_employees WHERE id = :id AND "companyId" = :companyId', { id: data.employeeId, companyId }, transaction);
    if (!e) throw AppError.notFound('Employee');
    if (e.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    if (e.status !== 'CONFIRMED') throw AppError.rule('EMPLOYEE_NOT_CONFIRMED', 'Confirm the employee card first');
    if (date < e.joined) throw AppError.rule('BEFORE_JOINING', `The employee joined on ${e.joined}`);
    const [{ m }] = await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_advances WHERE "companyId" = :companyId', { companyId }, transaction);
    const [row] = await q(`INSERT INTO payroll_advances ("companyId", code, "employeeId", "advanceDate", amount, remarks, "createdById") VALUES (:companyId, :code, :employeeId, :date, :amount, :remarks, :userId) RETURNING id`,
      { companyId, code: Number(m) + 1, employeeId: data.employeeId, date, amount: fromCents(cents), remarks: data.remarks || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_ADVANCE_CREATED', entityType: 'PayrollAdvance', entityId: row.id, after: { code: Number(m) + 1, employee: e.name, amount: fromCents(cents), advanceDate: date } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

/** Only an advance with no voucher and nothing recovered can still be changed or deleted. */
async function assertUntouched(companyId, id, transaction) {
  const r = await loadRow(companyId, id, transaction);
  if (r.voucherId) throw AppError.rule('ADVANCE_HAS_VOUCHER', 'A voucher was made for this advance: delete or change the voucher first');
  if (toCents(r.deducted) > 0n) throw AppError.rule('ADVANCE_RECOVERED', 'The payroll already took this advance from a salary');
  return r;
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await assertUntouched(companyId, id, transaction);
    const set = {};
    if (changes.amount !== undefined) set.amount = fromCents(amountCents(changes.amount, 'Amount'));
    if (changes.advanceDate !== undefined) {
      const [e] = await q('SELECT to_char("joiningDate", \'YYYY-MM-DD\') AS joined FROM payroll_employees WHERE id = :id', { id: cur.employeeId }, transaction);
      if (changes.advanceDate < e.joined) throw AppError.rule('BEFORE_JOINING', `The employee joined on ${e.joined}`);
      set.advanceDate = changes.advanceDate;
    }
    if (changes.remarks !== undefined) set.remarks = changes.remarks || null;
    const keys = Object.keys(set);
    if (keys.length) await run(`UPDATE payroll_advances SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { id, ...set }, transaction);
    await audit.log(req, { action: 'PAYROLL_ADVANCE_UPDATED', entityType: 'PayrollAdvance', entityId: id, before: { amount: money(toCents(cur.amount)), advanceDate: cur.advanceDate }, after: set }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const cur = await assertUntouched(companyId, id, transaction);
    await run('DELETE FROM payroll_advances WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_ADVANCE_DELETED', entityType: 'PayrollAdvance', entityId: id, before: { code: cur.code, employee: cur.empName, amount: money(toCents(cur.amount)) } }, { transaction });
  });
}

module.exports = { list, summary, get, create, update, remove, employeeInfo, voucherLabel, PAID, DEDUCTED };
