// Salary Tax Voucher (accounting, owner 2026-11-07): the income tax withheld from the salaries, paid to the government from a bank or cash account.
//   DRAFT      saved with the approved payslips of one month whose tax it pays; may be deleted; no accounting entry
//   CONFIRMED  posted:  Debit Salary Tax Payable (what was withheld from the salaries)  /  Credit Bank or Cash
//   un-confirm ("move to draft") posts the reverse entry
// A payslip's tax can be on ONE voucher; the payslip cannot be sent back to draft while it is on one. Several vouchers can pay the same month (payslips approved later).
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { monthLabel } = require('./incomeTaxService');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, q, lock, num, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'SALARY_TAX_VOUCHER';
const LOCK = 'salarytax';
const pad5 = (n) => String(n).padStart(5, '0');
const label = (n) => `STV-${pad5(n)}`;

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", to_char(v.month, 'YYYY-MM') AS month, v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate",
  v."chequeNo", v."refNo", v.notes, v.employees, v.amount::text AS amount, v.status, v."confirmedAt", cb.name AS "confirmedByName", v."createdAt", v."updatedAt",
  a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType"`;
const FROM = `FROM salary_tax_vouchers v JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

async function options(req) {
  return { modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), payFromAccounts: await support.bankAndCashAccounts(req.user.companyId) };
}

/** The approved payslips of a month with tax that no voucher has yet. */
async function openSlips(companyId, month, transaction, ids = null) {
  const repl = { companyId, first: `${month}-01` };
  let extra = '';
  if (ids) { extra = ' AND s.id IN (:ids)'; repl.ids = ids; }
  return q(`SELECT s.id, s."empCode", s."empName", e.cnic, s."departmentName", s."taxAmount"::text AS tax, s.status, (SELECT vl."voucherId" FROM salary_tax_voucher_lines vl WHERE vl."slipId" = s.id) AS "voucherId"
    FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" JOIN payroll_employees e ON e.id = s."employeeId"
    WHERE s."companyId" = :companyId AND r.month = :first AND s.status = 'APPROVED' AND s."taxAmount" > 0${extra} ORDER BY s."empCode"`, repl, transaction);
}

/** GET /salary-tax-vouchers/slips?month= : what can be put on a voucher now (the picker), and what is already on one. */
async function slips(req, { month }) {
  const rows = await openSlips(req.user.companyId, month);
  const free = rows.filter((r) => !r.voucherId);
  return {
    month, monthLabel: monthLabel(month), employees: free.length, amount: num(free.reduce((t, r) => t + toCents(r.tax), 0n)), onVouchers: rows.length - free.length,
    data: free.map((r) => ({ slipId: r.id, employee: { code: r.empCode, label: pad5(r.empCode), name: r.empName, cnic: r.cnic, department: r.departmentName }, tax: num(toCents(r.tax)) })),
  };
}

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate, month: r.month, monthLabel: monthLabel(r.month),
    payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType }, paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode],
    chequeDate: r.chequeDate, chequeNo: r.chequeNo, refNo: r.refNo, notes: r.notes, employees: r.employees, amount: num(toCents(r.amount)),
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED', createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Salary tax voucher');
  return r;
}

async function get(req, id, transaction) {
  const r = await load(req, id, transaction);
  const v = voucherJson(r);
  const lines = await q(`SELECT s.id AS "slipId", s."empCode", s."empName", e.cnic, s."departmentName", vl.amount::text AS amount, s."taxAmount"::text AS tax, s.status
    FROM salary_tax_voucher_lines vl JOIN payroll_slips s ON s.id = vl."slipId" JOIN payroll_employees e ON e.id = s."employeeId" WHERE vl."voucherId" = :id ORDER BY s."empCode"`, { id }, transaction);
  v.lines = lines.map((l) => ({ slipId: l.slipId, employee: { code: l.empCode, label: pad5(l.empCode), name: l.empName, cnic: l.cnic, department: l.departmentName }, tax: num(toCents(l.amount)), slipStatus: l.status,
    changed: toCents(l.tax) !== toCents(l.amount) || l.status !== 'APPROVED' }));
  return v;
}

async function list(req, { page, limit, status, month, dateFrom, dateTo, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (month) { where.push('v.month = :first'); r.first = `${month}-01`; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(a.name ILIKE :like OR v."refNo" ILIKE :like OR v."chequeNo" ILIKE :like OR v.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v.amount), 0)::text AS total, COALESCE(SUM(v.amount) FILTER (WHERE v.status = 'CONFIRMED'), 0)::text AS confirmed ${FROM} WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, amount: num(toCents(sum.total)), confirmed: num(toCents(sum.confirmed)) } };
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    let rows = await openSlips(companyId, data.month, transaction, data.slipIds || null);
    if (data.slipIds) {
      if (rows.length !== new Set(data.slipIds).size) throw AppError.rule('SLIP_NOT_AVAILABLE', 'A payslip is not approved, has no tax, or is of another month');
      const taken = rows.find((r) => r.voucherId);
      if (taken) throw AppError.rule('SLIP_IN_A_VOUCHER', `The tax of ${taken.empName} is already on a salary tax voucher`);
    } else rows = rows.filter((r) => !r.voucherId);
    if (!rows.length) throw AppError.rule('NOTHING_TO_PAY', `No approved payslip of ${monthLabel(data.month)} has tax waiting to be paid`);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    await accounts.ensureDefault(req, 'SALARY_TAX_PAYABLE', transaction);
    const sum = rows.reduce((t, r) => t + toCents(r.tax), 0n);
    const voucherNo = await nextNo('salary_tax_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO salary_tax_vouchers ("companyId", "voucherNo", "voucherDate", month, "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", "refNo", notes, employees, amount, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :first, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :refNo, :notes, :employees, :amount, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), first: `${data.month}-01`, payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null,
      chequeNo: data.chequeNo || null, refNo: data.refNo || null, notes: data.notes || null, employees: rows.length, amount: fromCents(sum), userId: req.user.id }, transaction);
    for (const r of rows) await sequelize.query('INSERT INTO salary_tax_voucher_lines ("companyId", "voucherId", "slipId", amount) VALUES (:companyId, :voucherId, :slipId, :amount)',
      { replacements: { companyId, voucherId: newId, slipId: r.id, amount: r.tax }, transaction });
    await audit.log(req, { action: 'SALARY_TAX_VOUCHER_CREATED', entityType: 'SalaryTaxVoucher', entityId: newId, after: { voucherNo, month: data.month, employees: rows.length, amount: num(sum) } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be changed. Move it to draft first');
    const accountId = changes.payFromAccountId || cur.accountId;
    if (changes.payFromAccountId) await bankOrCash(companyId, accountId, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await sequelize.query(`UPDATE salary_tax_vouchers SET "voucherDate" = :voucherDate, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo, "refNo" = :refNo,
        notes = :notes, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      refNo: pick('refNo', cur.refNo), notes: pick('notes', cur.notes), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_TAX_VOUCHER_UPDATED', entityType: 'SalaryTaxVoucher', entityId: id, after: { voucherNo: cur.voucherNo } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM salary_tax_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'SALARY_TAX_VOUCHER_DELETED', entityType: 'SalaryTaxVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: num(toCents(cur.amount)) } }, { transaction });
  });
}

async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const lines = await q(`SELECT vl.amount::text AS amount, s."taxAmount"::text AS tax, s.status, s."empName" FROM salary_tax_voucher_lines vl JOIN payroll_slips s ON s.id = vl."slipId" WHERE vl."voucherId" = :id`, { id }, transaction);
    const bad = lines.find((l) => l.status !== 'APPROVED' || toCents(l.tax) !== toCents(l.amount));
    if (bad) throw AppError.rule('SLIP_CHANGED', `The payslip of ${bad.empName} is no longer approved or its tax changed: delete this voucher and make it again`);
    const sum = lines.reduce((t, l) => t + toCents(l.amount), 0n);
    if (!lines.length || sum <= 0n) throw AppError.rule('NOTHING_TO_PAY', 'There is no tax on this voucher');
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const payable = await accounts.ensureDefault(req, 'SALARY_TAX_PAYABLE', transaction);
    const narration = `Salary tax voucher ${label(cur.voucherNo)} - income tax withheld from salaries, ${monthLabel(cur.month)} (${lines.length} employee${lines.length === 1 ? '' : 's'})${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, { entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration, lines: [
      { accountId: payable, debit: num(sum), narration }, { accountId: bank.id, credit: num(sum), narration }] }, transaction);
    await sequelize.query(`UPDATE salary_tax_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_TAX_VOUCHER_CONFIRMED', entityType: 'SalaryTaxVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(sum), employees: lines.length } }, { transaction });
  });
  return get(req, id);
}

async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `Salary tax voucher ${label(cur.voucherNo)} moved to draft` }, transaction);
    await sequelize.query(`UPDATE salary_tax_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_TAX_VOUCHER_UNCONFIRMED', entityType: 'SalaryTaxVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, slips, list, get, create, update, remove, confirm, unconfirm, accountsEntry, SOURCE };
