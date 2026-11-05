// Salary income tax (owner 2026-11-07). The tax of an employee is set by the government for his salary and changes every year, so it is kept per employee as a HISTORY:
// from a month on, either a fixed monthly amount or a percent of the basic. A payslip uses the latest row not later than its month; an employee with no row keeps using the
// fixed monthly amount of his card (monthlyIncomeTax). HR edits one employee by hand, or uploads a sheet (employee ID or CNIC + the new amount / percent) for many at once.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const accountService = require('./accountService');

const { toCents, fromCents } = accountService.internals;
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const pad5 = (n) => String(n).padStart(5, '0');
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const money = (c) => fromCents(c);
const roundRupee = (c) => ((c + 50n) / 100n) * 100n;
const pct = (cents, percent) => (percent == null ? 0n : (cents * BigInt(Math.round(Number(percent) * 100)) + 5000n) / 10000n);
const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/** The tax that applies to each employee in a month: Map(employeeId -> { fixed: cents | null, percent: number | null }); employees with no history row are in it only when their card has a monthly tax. */
async function settingsFor(companyId, employeeIds, month, transaction) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await q(`SELECT DISTINCT ON ("employeeId") "employeeId", "monthlyAmount"::text AS amount, percent::float AS percent FROM payroll_income_tax
    WHERE "companyId" = :companyId AND "employeeId" IN (:ids) AND month <= :first ORDER BY "employeeId", month DESC`, { companyId, ids: employeeIds, first: `${month}-01` }, transaction);
  for (const r of rows) out.set(r.employeeId, { fixed: r.amount == null ? null : toCents(r.amount), percent: r.percent });
  // no history: the fixed monthly amount of the card
  const rest = employeeIds.filter((id) => !out.has(id));
  if (rest.length) {
    const cards = await q('SELECT id, "monthlyIncomeTax"::text AS amount FROM payroll_employees WHERE "companyId" = :companyId AND id IN (:ids) AND "monthlyIncomeTax" > 0', { companyId, ids: rest }, transaction);
    for (const c of cards) out.set(c.id, { fixed: toCents(c.amount), percent: null });
  }
  return out;
}

/** What the setting comes to for a basic salary, in cents (a fixed amount, else the percent rounded to the rupee). */
function amountOf(basicCents, fixed, percent) {
  if (fixed != null) return fixed;
  return percent ? roundRupee(pct(basicCents, percent)) : 0n;
}

const sourceOf = (h, card) => (h ? (h.amount != null ? 'AMOUNT' : h.percent != null ? 'PERCENT' : 'NONE') : card ? 'CARD' : 'NONE');

function rowJson(e) {
  const basic = toCents(e.basic);
  const card = toCents(e.cardAmount || 0) > 0n;
  const fixed = e.hAmount != null ? toCents(e.hAmount) : !e.hId && card ? toCents(e.cardAmount) : null;
  const percent = e.hAmount != null ? null : e.hId ? e.hPercent : null;
  const source = sourceOf(e.hId ? { amount: e.hAmount, percent: e.hPercent } : null, card);
  return {
    employee: { id: e.id, code: e.code, label: pad5(e.code), name: e.name, cnic: e.cnic, department: e.department, designation: e.designation, group: e.groupName },
    salaryType: e.salaryType, basicSalary: money(basic), monthlyAmount: fixed == null ? null : money(fixed), percent: percent == null ? null : percent,
    monthlyTax: money(amountOf(basic, fixed, percent)), estimated: e.salaryType === 'DAILY' && fixed == null && Boolean(percent), source,
    effectiveFrom: e.hMonth || null, cardAmount: money(toCents(e.cardAmount || 0)),
  };
}

/** GET /payroll/income-tax?month=&search=&groupId=&departmentId= : every employee with the tax the payroll will take in that month. */
async function list(req, { month, search, groupId, departmentId, source, page, limit }) {
  const { companyId } = req.user;
  const first = `${month}-01`;
  const where = [`e."companyId" = :companyId`, `e.status = 'CONFIRMED'`, `e."joiningDate" <= (CAST(:first AS date) + interval '1 month' - interval '1 day')`, `(NOT e."isClosed" OR e."leavingDate" >= :first)`];
  const repl = { companyId, first };
  if (search) {
    repl.like = `%${search.trim()}%`;
    repl.digits = digitsOf(search);
    repl.n = /^\d{1,8}$/.test(search.trim()) ? Number(search.trim()) : -1;
    where.push(`(e.name ILIKE :like OR e.code = :n${repl.digits.length >= 4 ? ' OR replace(e.cnic, \'-\', \'\') LIKE :dlike' : ''})`);
    if (repl.digits.length >= 4) repl.dlike = `%${repl.digits}%`;
  }
  if (groupId) { where.push('e."groupId" = :groupId'); repl.groupId = groupId; }
  if (departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = departmentId; }
  const from = `FROM payroll_employees e LEFT JOIN payroll_departments d ON d.id = e."departmentId" LEFT JOIN payroll_designations ds ON ds.id = e."designationId" LEFT JOIN payroll_groups g ON g.id = e."groupId"
    LEFT JOIN LATERAL (SELECT id, to_char(month, 'YYYY-MM') AS month, "monthlyAmount"::text AS amount, percent::float AS percent FROM payroll_income_tax t WHERE t."employeeId" = e.id AND t.month <= :first ORDER BY t.month DESC LIMIT 1) h ON true`;
  const srcSql = `CASE WHEN h.id IS NOT NULL THEN (CASE WHEN h.amount IS NOT NULL THEN 'AMOUNT' WHEN h.percent IS NOT NULL THEN 'PERCENT' ELSE 'NONE' END) WHEN COALESCE(e."monthlyIncomeTax", 0) > 0 THEN 'CARD' ELSE 'NONE' END`;
  if (source) { where.push(`${srcSql} = :source`); repl.source = source; }
  const w = where.join(' AND ');
  const [n] = await q(`SELECT count(*)::int AS n ${from} WHERE ${w}`, repl);
  const rows = await q(`SELECT e.id, e.code, e.name, e.cnic, e."salaryType", e."basicSalary"::text AS basic, e."monthlyIncomeTax"::text AS "cardAmount", d.name AS department, ds.name AS designation, g.name AS "groupName",
      h.id AS "hId", h.month AS "hMonth", h.amount AS "hAmount", h.percent AS "hPercent" ${from} WHERE ${w} ORDER BY e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const [t] = await q(`SELECT count(*) FILTER (WHERE ${srcSql} <> 'NONE')::int AS "withTax" ${from} WHERE ${w}`, repl);
  return { month, monthLabel: monthLabel(month), data: rows.map(rowJson), page, limit, total: n.n, summary: { employees: n.n, withTax: t.withTax, withoutTax: n.n - t.withTax } };
}

async function employeeOr404(companyId, id, transaction) {
  const [e] = await q(`SELECT id, code, name, "isClosed", status, "monthlyIncomeTax"::text AS "cardAmount", "basicSalary"::text AS basic, "salaryType" FROM payroll_employees WHERE id = :id AND "companyId" = :companyId`, { id, companyId }, transaction);
  if (!e) throw AppError.notFound('Employee');
  return e;
}

/** GET /payroll/income-tax/employees/:id : the history of one employee, newest first. */
async function history(req, id) {
  const { companyId } = req.user;
  const e = await employeeOr404(companyId, id);
  const rows = await q(`SELECT t.id, to_char(t.month, 'YYYY-MM') AS month, t."monthlyAmount"::text AS amount, t.percent::float AS percent, t.source, u.name AS "by", t."createdAt"
    FROM payroll_income_tax t LEFT JOIN users u ON u.id = t."createdById" WHERE t."employeeId" = :id ORDER BY t.month DESC`, { id });
  const basic = toCents(e.basic);
  return {
    employee: { id: e.id, code: e.code, label: pad5(e.code), name: e.name }, basicSalary: money(basic), cardAmount: money(toCents(e.cardAmount || 0)),
    data: rows.map((r) => ({ id: r.id, month: r.month, monthLabel: monthLabel(r.month), monthlyAmount: r.amount == null ? null : money(toCents(r.amount)), percent: r.percent,
      monthlyTax: money(amountOf(basic, r.amount == null ? null : toCents(r.amount), r.percent)), source: r.source, by: r.by, createdAt: r.createdAt })),
  };
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Sets the tax of an employee from a month: a monthly amount, a percent, or neither (= no tax). The same month again changes it. Returns what was saved. */
async function put(companyId, userId, e, month, { monthlyAmount, percent }, source, transaction) {
  const [row] = await q(`INSERT INTO payroll_income_tax ("companyId", "employeeId", month, "monthlyAmount", percent, source, "createdById") VALUES (:companyId, :id, :first, :amount, :percent, :source, :userId)
    ON CONFLICT ("employeeId", month) DO UPDATE SET "monthlyAmount" = EXCLUDED."monthlyAmount", percent = EXCLUDED.percent, source = EXCLUDED.source, "createdById" = EXCLUDED."createdById", "updatedAt" = now()
    RETURNING id`, { companyId, id: e.id, first: `${month}-01`, amount: monthlyAmount == null ? null : monthlyAmount, percent: monthlyAmount == null && percent != null ? percent : null, source, userId }, transaction);
  return row.id;
}

/** PUT /payroll/income-tax/employees/:id {effectiveFrom, monthlyAmount | percent}: by hand, for one employee, from a month. */
async function set(req, id, { effectiveFrom, monthlyAmount, percent }) {
  const { companyId } = req.user;
  const month = effectiveFrom || currentMonth();
  await sequelize.transaction(async (transaction) => {
    const e = await employeeOr404(companyId, id, transaction);
    if (e.isClosed) throw AppError.rule('EMPLOYEE_CLOSED', 'This employee has left the company');
    if (e.status !== 'CONFIRMED') throw AppError.rule('EMPLOYEE_NOT_CONFIRMED', 'Confirm the employee card first');
    if (monthlyAmount != null && percent != null) throw AppError.rule('AMOUNT_OR_PERCENT', 'Give the monthly amount or the percent, not both');
    const amount = monthlyAmount == null ? null : money(toCents(monthlyAmount));
    const before = await q(`SELECT to_char(month, 'YYYY-MM') AS month, "monthlyAmount"::text AS amount, percent::float AS percent FROM payroll_income_tax WHERE "employeeId" = :id AND month <= :first ORDER BY month DESC LIMIT 1`, { id, first: `${month}-01` }, transaction);
    await put(companyId, req.user.id, e, month, { monthlyAmount: amount, percent }, 'MANUAL', transaction);
    await audit.log(req, { action: 'PAYROLL_INCOME_TAX_SET', entityType: 'PayrollEmployee', entityId: id, before: before[0] || null, after: { from: month, monthlyAmount: amount, percent: amount == null ? percent : null } }, { transaction });
  });
  return history(req, id);
}

/** DELETE /payroll/income-tax/:rowId : takes one history row away (the earlier row, or the card percent, applies again). */
async function removeRow(req, rowId) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const [r] = await q(`SELECT id, "employeeId", to_char(month, 'YYYY-MM') AS month FROM payroll_income_tax WHERE id = :rowId AND "companyId" = :companyId`, { rowId, companyId }, transaction);
    if (!r) throw AppError.notFound('Income tax row');
    await run('DELETE FROM payroll_income_tax WHERE id = :rowId', { rowId }, transaction);
    await audit.log(req, { action: 'PAYROLL_INCOME_TAX_REMOVED', entityType: 'PayrollEmployee', entityId: r.employeeId, before: { from: r.month } }, { transaction });
  });
}

const parseAmount = (v) => {
  if (v == null || String(v).trim() === '') return undefined;
  const s = String(v).trim().replace(/,/g, '');
  return /^\d{1,10}(\.\d{1,2})?$/.test(s) ? s : null; // null = not a valid amount
};
const parsePercent = (v) => {
  if (v == null || String(v).trim() === '') return undefined;
  const s = String(v).trim().replace(/%$/, '');
  return /^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) <= 100 ? Number(s) : null;
};

/**
 * POST /payroll/income-tax/import {effectiveFrom, rows:[{employeeId, cnic, monthlyAmount | percent}], dryRun}: the sheet of the new taxes. An employee is found by his ID, else by CNIC. Rows with a
 * monthly amount set a fixed amount, rows with a percent set a percent; a row with neither (or both) is not used. The report says what happened to every row.
 */
async function importRows(req, { effectiveFrom, rows, dryRun }) {
  const { companyId } = req.user;
  const month = effectiveFrom || currentMonth();
  let report;
  await sequelize.transaction(async (transaction) => {
    const codes = rows.map((r) => (/^\d{1,8}$/.test(String(r.employeeId == null ? '' : r.employeeId).trim()) ? Number(String(r.employeeId).trim()) : null)).filter((c) => c);
    const cnics = rows.map((r) => digitsOf(r.cnic)).filter((c) => c.length === 13);
    const emps = codes.length || cnics.length
      ? await q(`SELECT id, code, name, "isClosed", status, replace(cnic, '-', '') AS cnic FROM payroll_employees WHERE "companyId" = :companyId AND (code IN (:codes) OR replace(cnic, '-', '') IN (:cnics))`,
        { companyId, codes: codes.length ? codes : [0], cnics: cnics.length ? cnics : ['-'] }, transaction)
      : [];
    const byCode = new Map(emps.map((e) => [e.code, e]));
    const byCnic = new Map(emps.filter((e) => e.cnic).map((e) => [e.cnic, e]));
    const current = await settingsFor(companyId, emps.map((e) => e.id), month, transaction);
    const seen = new Set();
    const results = [];
    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i];
      const idText = String(raw.employeeId == null ? '' : raw.employeeId).trim();
      const cnic = digitsOf(raw.cnic);
      const amount = parseAmount(raw.monthlyAmount !== undefined ? raw.monthlyAmount : raw.tax);
      const percent = parsePercent(raw.percent);
      const res = { row: i + 1, employeeId: idText || null, cnic: raw.cnic == null || raw.cnic === '' ? null : String(raw.cnic), monthlyAmount: amount == null ? null : amount, percent: percent == null ? null : percent };
      let e = null;
      if (idText && /^\d{1,8}$/.test(idText)) e = byCode.get(Number(idText)) || null;
      if (!e && cnic.length === 13) e = byCnic.get(cnic) || null;
      if (!idText && !cnic) res.status = 'NO_ID';
      else if (!e) res.status = 'NOT_FOUND';
      else {
        res.employee = { code: e.code, name: e.name };
        if (seen.has(e.id)) res.status = 'DUPLICATE_IN_FILE';
        else if (e.isClosed) res.status = 'EMPLOYEE_CLOSED';
        else if (e.status !== 'CONFIRMED') res.status = 'EMPLOYEE_NOT_CONFIRMED';
        else if (amount === null || percent === null) res.status = 'INVALID_VALUE';
        else if (amount === undefined && percent === undefined) res.status = 'NO_TAX_VALUE';
        else if (amount !== undefined && percent !== undefined) res.status = 'AMOUNT_AND_PERCENT';
        else {
          seen.add(e.id);
          const now = current.get(e.id);
          const same = now && (amount !== undefined ? now.fixed != null && now.fixed === toCents(amount) : now.fixed == null && now.percent === percent);
          res.status = same ? 'UNCHANGED' : 'UPDATED';
          if (!dryRun && !same) await put(companyId, req.user.id, e, month, { monthlyAmount: amount !== undefined ? amount : null, percent: percent !== undefined ? percent : null }, 'EXCEL', transaction);
        }
      }
      results.push(res);
    }
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    if (!dryRun && counts.UPDATED) {
      await audit.log(req, { action: 'PAYROLL_INCOME_TAX_IMPORTED', entityType: 'PayrollEmployee', entityId: companyId, after: { from: month, updated: counts.UPDATED, rows: rows.length } }, { transaction });
    }
    report = { dryRun: Boolean(dryRun), effectiveFrom: month, effectiveFromLabel: monthLabel(month), total: rows.length, updated: counts.UPDATED || 0, unchanged: counts.UNCHANGED || 0,
      notUsed: rows.length - (counts.UPDATED || 0) - (counts.UNCHANGED || 0), counts, results: results.slice(0, 1000) };
  });
  return report;
}

/** GET /payroll/income-tax/report?month=&groupId=&search= : the tax withheld from the payslips of a month, who it was, and how much of it has been paid to the government. */
async function report(req, { month, groupId, search, page, limit }) {
  const { companyId } = req.user;
  const where = [`s."companyId" = :companyId`, `r.month = :first`, `s.status <> 'SUSPENDED'`, `s."taxAmount" > 0`];
  const repl = { companyId, first: `${month}-01` };
  if (groupId) { where.push('r."groupId" = :groupId'); repl.groupId = groupId; }
  if (search) {
    repl.like = `%${search.trim()}%`;
    repl.n = /^\d{1,8}$/.test(search.trim()) ? Number(search.trim()) : -1;
    where.push('(s."empName" ILIKE :like OR s."empCode" = :n)');
  }
  const w = where.join(' AND ');
  const from = `FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" JOIN payroll_employees e ON e.id = s."employeeId"
    LEFT JOIN salary_tax_voucher_lines vl ON vl."slipId" = s.id LEFT JOIN salary_tax_vouchers v ON v.id = vl."voucherId"`;
  const [t] = await q(`SELECT count(*)::int AS slips, COALESCE(SUM(s."taxAmount"), 0)::text AS total,
      COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED'), 0)::text AS approved,
      COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED' AND v.status = 'CONFIRMED'), 0)::text AS paid,
      COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED' AND v.status = 'DRAFT'), 0)::text AS "onDraft",
      COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED' AND v.id IS NULL), 0)::text AS "toPay" ${from} WHERE ${w}`, repl);
  const rows = await q(`SELECT s.id, s."empCode", s."empName", e.cnic, s."departmentName", s."basicSalary"::text AS basic, s."grossAmount"::text AS gross, s."taxAmount"::text AS tax, s.status, v.id AS "voucherId", v."voucherNo", v.status AS "voucherStatus"
    ${from} WHERE ${w} ORDER BY s."empCode" LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  return {
    month, monthLabel: monthLabel(month), page, limit, total: t.slips,
    cards: { employees: t.slips, deducted: money(toCents(t.total)), approved: money(toCents(t.approved)), paidToGovernment: money(toCents(t.paid)), onDraftVoucher: money(toCents(t.onDraft)), toPay: money(toCents(t.toPay)) },
    data: rows.map((r) => ({ slipId: r.id, employee: { code: r.empCode, label: pad5(r.empCode), name: r.empName, cnic: r.cnic, department: r.departmentName }, basicSalary: money(toCents(r.basic)), gross: money(toCents(r.gross)),
      tax: money(toCents(r.tax)), slipStatus: r.status, voucher: r.voucherId ? { id: r.voucherId, label: `STV-${String(r.voucherNo).padStart(5, '0')}`, status: r.voucherStatus } : null,
      paymentStatus: r.status !== 'APPROVED' ? 'NOT_APPROVED' : r.voucherStatus === 'CONFIRMED' ? 'PAID' : r.voucherId ? 'ON_VOUCHER' : 'UNPAID' })),
  };
}

module.exports = { settingsFor, amountOf, list, history, set, removeRow, importRows, report, monthLabel };
