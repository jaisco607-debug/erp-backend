// Salary Payment Voucher (accounting, owner 2026-11-05): the salary paid to the employees of APPROVED payslips from a bank or cash account.
//   DRAFT      saved; may be changed or deleted; no accounting entry
//   CONFIRMED  posted:  Debit Salaries Payable (the default account, what the approved payslips made the company owe)  /  Credit Bank or Cash
//              and every payslip's "paid" grows by its line
//   un-confirm ("move to draft") posts the reverse entry and the paid amounts go back
// A payslip can be paid in more than one voucher; together they can never be more than its net salary. The employees are not customers or vendors: the entry names no party,
// the lines of the voucher are the link to each payslip.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { monthLabel } = require('./payrollRunService');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, q, lock, amountCents, num, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'SALARY_PAYMENT_VOUCHER';
const LOCK = 'payroll-pay';
const pad5 = (n) => String(n).padStart(5, '0');
const label = (n) => `SPV-${pad5(n)}`;
const NIL = '00000000-0000-0000-0000-000000000000';

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v."refNo", v.notes,
  v.amount::text AS amount, v.status, v."confirmedAt", cb.name AS "confirmedByName", v."createdAt", v."updatedAt", a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType",
  (SELECT count(*)::int FROM salary_payment_voucher_lines l WHERE l."voucherId" = v.id) AS "lineCount"`;
const FROM = 'FROM salary_payment_vouchers v JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"';

async function options(req) {
  return { modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), payFromAccounts: await support.bankAndCashAccounts(req.user.companyId) };
}

/** GET /salary-payment-vouchers/slips: the approved payslips with salary still to pay (draft vouchers count as paid, so two vouchers cannot take the same rupee). */
async function slips(req, { search, runId, month, groupId, method, limit }) {
  const where = [`s."companyId" = :companyId`, `s.status = 'APPROVED'`];
  const repl = { companyId: req.user.companyId, limit };
  if (runId) { where.push('s."runId" = :runId'); repl.runId = runId; }
  if (month) { where.push(`to_char(r.month, 'YYYY-MM') = :month`); repl.month = month; }
  if (groupId) { where.push('r."groupId" = :groupId'); repl.groupId = groupId; }
  if (method === 'CASH') where.push(`(s."isCash" OR s."paymentMethod" = 'CASH')`);
  if (method === 'BANK') where.push(`(NOT s."isCash" AND s."paymentMethod" = 'BANK')`);
  if (search) {
    repl.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR s."empCode" = :n OR s.code = :n' : '';
    if (numeric) repl.n = Number(search.trim());
    where.push(`(s."empName" ILIKE :like${numeric})`);
  }
  const rows = await q(`SELECT s.id, s.code, s."empCode", s."empName", s."departmentName", s."paymentMethod", s."isCash", s."accountNo", s."accountTitle", s."bankName", to_char(r.month, 'YYYY-MM') AS month, g.name AS "groupName",
      s."netAmount"::text AS net, s."paidAmount"::text AS paid, COALESCE((SELECT SUM(l.amount) FROM salary_payment_voucher_lines l WHERE l."slipId" = s.id), 0)::text AS "inVouchers"
    FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" JOIN payroll_groups g ON g.id = r."groupId" WHERE ${where.join(' AND ')} ORDER BY r.month, s."empCode"`, repl);
  const data = rows.map((r) => ({
    slipId: r.id, payslipId: r.code, employee: { code: r.empCode, label: pad5(r.empCode), name: r.empName }, department: r.departmentName, group: r.groupName, month: r.month, monthLabel: monthLabel(r.month),
    net: num(toCents(r.net)), paid: num(toCents(r.paid)), toPay: num(toCents(r.net) - toCents(r.inVouchers)), method: r.isCash || r.paymentMethod === 'CASH' ? 'CASH' : 'BANK',
    bank: { name: r.bankName, accountNo: r.accountNo, accountTitle: r.accountTitle },
  })).filter((r) => r.toPay > 0);
  return { data: data.slice(0, limit), total: data.length, totalToPay: num(data.reduce((t, r) => t + toCents(String(r.toPay)), 0n)) };
}

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate, payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, refNo: r.refNo, notes: r.notes, amount: num(toCents(r.amount)), employees: r.lineCount,
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED', createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Salary payment voucher');
  return r;
}

async function lineRows(id, transaction) {
  return q(`SELECT l."slipId", l.amount::text AS amount, s.code, s."empCode", s."empName", s."departmentName", to_char(r.month, 'YYYY-MM') AS month, s."netAmount"::text AS net, s."paidAmount"::text AS paid, s.status
    FROM salary_payment_voucher_lines l JOIN payroll_slips s ON s.id = l."slipId" JOIN payroll_runs r ON r.id = s."runId" WHERE l."voucherId" = :id ORDER BY s."empCode"`, { id }, transaction);
}

async function get(req, id, transaction) {
  const v = voucherJson(await load(req, id, transaction));
  v.lines = (await lineRows(id, transaction)).map((l) => ({
    slipId: l.slipId, payslipId: l.code, employee: { code: l.empCode, label: pad5(l.empCode), name: l.empName }, department: l.departmentName, month: l.month, monthLabel: monthLabel(l.month),
    net: num(toCents(l.net)), amount: num(toCents(l.amount)), slipStatus: l.status,
  }));
  return v;
}

async function list(req, { page, limit, status, dateFrom, dateTo, slipId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (slipId) { where.push('EXISTS (SELECT 1 FROM salary_payment_voucher_lines l WHERE l."voucherId" = v.id AND l."slipId" = :slipId)'); r.slipId = slipId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(a.name ILIKE :like OR v."chequeNo" ILIKE :like OR v."refNo" ILIKE :like OR v.notes ILIKE :like OR EXISTS (SELECT 1 FROM salary_payment_voucher_lines l JOIN payroll_slips s ON s.id = l."slipId" WHERE l."voucherId" = v.id AND s."empName" ILIKE :like)${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v.amount), 0)::text AS total, COALESCE(SUM(v.amount) FILTER (WHERE v.status = 'CONFIRMED'), 0)::text AS confirmed ${FROM} WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, amount: num(toCents(sum.total)), confirmed: num(toCents(sum.confirmed)) } };
}

/** The lines checked against the payslips as they are now: approved, the company's own, and not more than the net salary less what other vouchers already take. Returns [{ slipId, cents, slip }]. */
async function buildLines(companyId, input, exceptVoucherId, transaction) {
  const ids = input.map((l) => l.slipId);
  if (new Set(ids).size !== ids.length) throw AppError.rule('DUPLICATE_SLIP', 'A payslip is on the voucher twice');
  const found = await q(`SELECT s.id, s.code, s."empName", s.status, s."netAmount"::text AS net, to_char(r.month, 'YYYY-MM') AS month,
      COALESCE((SELECT SUM(l.amount) FROM salary_payment_voucher_lines l WHERE l."slipId" = s.id AND l."voucherId" <> :except), 0)::text AS other
    FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" WHERE s."companyId" = :companyId AND s.id IN (:ids) FOR UPDATE OF s`, { companyId, ids, except: exceptVoucherId || NIL }, transaction);
  if (found.length !== ids.length) throw AppError.notFound('Payslip');
  return input.map((l, i) => {
    const s = found.find((x) => x.id === l.slipId);
    const name = `${s.empName} (payslip ${s.code}, ${monthLabel(s.month)})`;
    if (s.status !== 'APPROVED') throw AppError.rule('SLIP_NOT_APPROVED', `Line ${i + 1}: ${name} is not approved yet`);
    const remaining = toCents(s.net) - toCents(s.other);
    if (remaining <= 0n) throw AppError.rule('NOTHING_TO_PAY', `Line ${i + 1}: ${name} has nothing left to pay`);
    const cents = l.amount === undefined || l.amount === null ? remaining : amountCents(l.amount, `Line ${i + 1}`);
    if (cents > remaining) throw AppError.rule('AMOUNT_MORE_THAN_SALARY', `Line ${i + 1}: only ${fromCents(remaining)} of ${name} is left to pay`, { slipId: s.id, remaining: num(remaining) });
    return { slipId: s.id, cents, slip: s };
  });
}

async function writeLines(voucherId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM salary_payment_voucher_lines WHERE "voucherId" = :voucherId', { replacements: { voucherId }, transaction });
  for (const l of lines) {
    await sequelize.query('INSERT INTO salary_payment_voucher_lines ("voucherId", "companyId", "slipId", amount) VALUES (:voucherId, :companyId, :slipId, :amount)', { replacements: { voucherId, companyId, slipId: l.slipId, amount: fromCents(l.cents) }, transaction });
  }
}
const total = (lines) => lines.reduce((t, l) => t + l.cents, 0n);

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    const lines = await buildLines(companyId, data.lines, null, transaction);
    await accounts.ensureDefault(req, 'SALARIES_PAYABLE', transaction);
    const voucherNo = await nextNo('salary_payment_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO salary_payment_vouchers ("companyId", "voucherNo", "voucherDate", "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", "refNo", notes, amount, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :refNo, :notes, :amount, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null, chequeNo: data.chequeNo || null,
      refNo: data.refNo || null, notes: data.notes || null, amount: fromCents(total(lines)), userId: req.user.id }, transaction);
    await writeLines(newId, companyId, lines, transaction);
    await audit.log(req, { action: 'SALARY_PAYMENT_VOUCHER_CREATED', entityType: 'SalaryPaymentVoucher', entityId: newId, after: { voucherNo, employees: lines.length, amount: num(total(lines)) } }, { transaction });
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
    const input = changes.lines || (await lineRows(id, transaction)).map((l) => ({ slipId: l.slipId, amount: l.amount }));
    const lines = await buildLines(companyId, input, id, transaction);
    const accountId = changes.payFromAccountId || cur.accountId;
    if (changes.payFromAccountId) await bankOrCash(companyId, accountId, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await writeLines(id, companyId, lines, transaction);
    await sequelize.query(`UPDATE salary_payment_vouchers SET "voucherDate" = :voucherDate, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo,
        "refNo" = :refNo, notes = :notes, amount = :amount, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      refNo: pick('refNo', cur.refNo), notes: pick('notes', cur.notes), amount: fromCents(total(lines)), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_PAYMENT_VOUCHER_UPDATED', entityType: 'SalaryPaymentVoucher', entityId: id, before: { amount: num(toCents(cur.amount)) }, after: { amount: num(total(lines)), employees: lines.length } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM salary_payment_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'SALARY_PAYMENT_VOUCHER_DELETED', entityType: 'SalaryPaymentVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: num(toCents(cur.amount)) } }, { transaction });
  });
}

/** Posts the entry (Debit Salaries Payable, Credit the bank or cash account) and adds each line to the paid amount of its payslip. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const input = (await lineRows(id, transaction)).map((l) => ({ slipId: l.slipId, amount: l.amount }));
    if (!input.length) throw AppError.rule('NO_LINES', 'The voucher has no payslips');
    const lines = await buildLines(companyId, input, id, transaction);
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const payable = await accounts.ensureDefault(req, 'SALARIES_PAYABLE', transaction);
    const sum = total(lines);
    const narration = `Salary payment voucher ${label(cur.voucherNo)} - ${lines.length} employee${lines.length === 1 ? '' : 's'}${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [{ accountId: payable, debit: num(sum), narration }, { accountId: bank.id, credit: num(sum), narration }],
    }, transaction);
    for (const l of lines) {
      await sequelize.query('UPDATE payroll_slips SET "paidAmount" = "paidAmount" + :amount, "updatedAt" = now() WHERE id = :slipId', { replacements: { amount: fromCents(l.cents), slipId: l.slipId }, transaction });
    }
    await sequelize.query('UPDATE salary_payment_vouchers SET amount = :amount, status = \'CONFIRMED\', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { replacements: { id, amount: fromCents(sum), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_PAYMENT_VOUCHER_CONFIRMED', entityType: 'SalaryPaymentVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(sum), employees: lines.length } }, { transaction });
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
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `salary payment voucher ${label(cur.voucherNo)} moved to draft` }, transaction);
    for (const l of await lineRows(id, transaction)) {
      await sequelize.query('UPDATE payroll_slips SET "paidAmount" = "paidAmount" - :amount, "updatedAt" = now() WHERE id = :slipId', { replacements: { amount: l.amount, slipId: l.slipId }, transaction });
    }
    await sequelize.query('UPDATE salary_payment_vouchers SET status = \'DRAFT\', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id', { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALARY_PAYMENT_VOUCHER_UNCONFIRMED', entityType: 'SalaryPaymentVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
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
