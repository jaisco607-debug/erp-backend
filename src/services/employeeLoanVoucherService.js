// Employee Loan Voucher (accounting, owner 2026-11-03): the money paid out to an employee for an APPROVED loan application of the payroll, from a bank or cash account.
//   DRAFT      saved; may be changed or deleted; no accounting entry
//   CONFIRMED  posted:  Debit Employee Loans (the default account of that role)  /  Credit Bank or Cash
//   un-confirm ("move to draft") posts the reverse entry; refused when the payroll already deducted more than what would stay paid out
// A loan can be paid in more than one voucher; together they can never be more than the approved amount. The loan's balance = what the confirmed vouchers paid
// less what the payroll deducted from the salaries. The employee is not a customer or vendor, so the entry names no party: the loan is found through the voucher.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { voucherLabel } = require('./payrollLoanService');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, q, lock, amountCents, num, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'EMPLOYEE_LOAN_VOUCHER';
const LOCK = 'payroll-loan';

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."loanId", v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v."refNo", v.notes,
  v.amount::text AS amount, v.status, v."confirmedAt", cb.name AS "confirmedByName", v."createdAt", v."updatedAt",
  a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType",
  l.code AS "loanCode", l.status AS "loanStatus", l."approvedAmount"::text AS approved, to_char(l."applicationDate", 'YYYY-MM-DD') AS "loanDate",
  e.id AS "employeeId", e.code AS "employeeCode", e.name AS "employeeName", e.cnic`;
const FROM = `FROM employee_loan_vouchers v JOIN payroll_loans l ON l.id = v."loanId" JOIN payroll_employees e ON e.id = l."employeeId"
  JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

async function options(req) {
  return { modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), payFromAccounts: await support.bankAndCashAccounts(req.user.companyId) };
}

/** What has been paid out against a loan: confirmed vouchers and drafts (a draft already counts, so two vouchers cannot both take the last rupee). */
async function paidOn(loanId, exceptVoucherId, transaction) {
  const [r] = await q(`SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'CONFIRMED'), 0)::text AS confirmed, COALESCE(SUM(amount), 0)::text AS everything
    FROM employee_loan_vouchers WHERE "loanId" = :loanId AND id <> :except`, { loanId, except: exceptVoucherId || '00000000-0000-0000-0000-000000000000' }, transaction);
  return { confirmed: toCents(r.confirmed), everything: toCents(r.everything) };
}

/** GET /employee-loan-vouchers/loans: the approved loans with something still to pay out (the loan picker of the voucher). */
async function loans(req, { search, limit }) {
  const where = [`l."companyId" = :companyId`, `l.status = 'APPROVED'`];
  const repl = { companyId: req.user.companyId, limit };
  if (search) {
    repl.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR l.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(search.trim());
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like${numeric})`);
  }
  const rows = await q(`SELECT l.id, l.code, l."approvedAmount"::text AS approved, l.months, to_char(l."deductFrom", 'YYYY-MM') AS "deductFrom", e.id AS "employeeId", e.code AS "employeeCode", e.name, e.cnic,
      COALESCE((SELECT SUM(v.amount) FROM employee_loan_vouchers v WHERE v."loanId" = l.id AND v.status = 'CONFIRMED'), 0)::text AS paid,
      COALESCE((SELECT SUM(v.amount) FROM employee_loan_vouchers v WHERE v."loanId" = l.id), 0)::text AS "paidAndDraft"
    FROM payroll_loans l JOIN payroll_employees e ON e.id = l."employeeId" WHERE ${where.join(' AND ')} ORDER BY l.code DESC`, repl);
  const data = rows.map((r) => ({
    loanId: r.id, appId: String(r.code).padStart(5, '0'), employee: { id: r.employeeId, code: r.employeeCode, name: r.name, cnic: r.cnic }, approved: num(toCents(r.approved)), paid: num(toCents(r.paid)),
    toPay: num(toCents(r.approved) - toCents(r.paidAndDraft)), months: r.months, deductFrom: r.deductFrom,
  })).filter((r) => r.toPay > 0);
  return { data: data.slice(0, limit), total: data.length };
}

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: voucherLabel(r.voucherNo), voucherDate: r.voucherDate,
    loan: { id: r.loanId, appId: String(r.loanCode).padStart(5, '0'), status: r.loanStatus, approved: num(toCents(r.approved)), applicationDate: r.loanDate },
    employee: { id: r.employeeId, code: r.employeeCode, name: r.employeeName, cnic: r.cnic },
    payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, refNo: r.refNo, notes: r.notes, amount: num(toCents(r.amount)),
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED', createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Loan voucher');
  return r;
}
const get = async (req, id, transaction) => voucherJson(await load(req, id, transaction));

async function list(req, { page, limit, status, dateFrom, dateTo, loanId, employeeId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (loanId) { where.push('v."loanId" = :loanId'); r.loanId = loanId; }
  if (employeeId) { where.push('e.id = :employeeId'); r.employeeId = employeeId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n OR e.code = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(e.name ILIKE :like OR a.name ILIKE :like OR v."chequeNo" ILIKE :like OR v."refNo" ILIKE :like OR v.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v.amount), 0)::text AS total, COALESCE(SUM(v.amount) FILTER (WHERE v.status = 'CONFIRMED'), 0)::text AS confirmed ${FROM} WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, amount: num(toCents(sum.total)), confirmed: num(toCents(sum.confirmed)) } };
}

/** The loan must be approved, the date not before the application, and the amount within what is still to be paid out. */
async function checkLoan(companyId, loanId, voucherDate, cents, exceptVoucherId, transaction) {
  const [l] = await q(`SELECT l.id, l.code, l.status, l."approvedAmount"::text AS approved, to_char(l."applicationDate", 'YYYY-MM-DD') AS "applicationDate", e.name FROM payroll_loans l JOIN payroll_employees e ON e.id = l."employeeId"
    WHERE l.id = :loanId AND l."companyId" = :companyId FOR UPDATE OF l`, { loanId, companyId }, transaction);
  if (!l) throw AppError.notFound('Loan application');
  if (l.status !== 'APPROVED') throw AppError.rule('LOAN_NOT_APPROVED', `Loan application #${l.code} is not approved yet`);
  if (voucherDate < l.applicationDate) throw AppError.rule('VOUCHER_BEFORE_APPLICATION', `The loan was applied for on ${l.applicationDate}; the voucher cannot be dated before it`);
  const paid = await paidOn(loanId, exceptVoucherId, transaction);
  const remaining = toCents(l.approved) - paid.everything;
  if (cents > remaining) throw AppError.rule('AMOUNT_MORE_THAN_LOAN', `Only ${fromCents(remaining > 0n ? remaining : 0n)} of loan #${l.code} (${l.name}) is left to pay out`, { approved: num(toCents(l.approved)), alreadyPaid: num(paid.everything), remaining: num(remaining > 0n ? remaining : 0n) });
  return l;
}

async function create(req, data) {
  const { companyId } = req.user;
  const cents = amountCents(data.amount, 'Amount');
  const voucherDate = data.voucherDate || today();
  const id = await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const loan = await checkLoan(companyId, data.loanId, voucherDate, cents, null, transaction);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    await accounts.ensureDefault(req, 'EMPLOYEE_LOANS', transaction); // the account exists from the first voucher on
    const voucherNo = await nextNo('employee_loan_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO employee_loan_vouchers ("companyId", "voucherNo", "voucherDate", "loanId", "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", "refNo", notes, amount, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :loanId, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :refNo, :notes, :amount, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate, loanId: data.loanId, payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null, chequeNo: data.chequeNo || null,
      refNo: data.refNo || null, notes: data.notes || null, amount: fromCents(cents), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'EMPLOYEE_LOAN_VOUCHER_CREATED', entityType: 'EmployeeLoanVoucher', entityId: newId, after: { voucherNo, loan: loan.code, employee: loan.name, amount: num(cents) } }, { transaction });
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
    if (changes.loanId && changes.loanId !== cur.loanId && changes.amount === undefined) throw AppError.rule('AMOUNT_REQUIRED', 'The loan changed: enter the amount again');
    const loanId = changes.loanId || cur.loanId;
    const cents = changes.amount !== undefined ? amountCents(changes.amount, 'Amount') : toCents(cur.amount);
    const voucherDate = changes.voucherDate || cur.voucherDate;
    await checkLoan(companyId, loanId, voucherDate, cents, id, transaction);
    const accountId = changes.payFromAccountId || cur.accountId;
    if (changes.payFromAccountId) await bankOrCash(companyId, accountId, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await sequelize.query(`UPDATE employee_loan_vouchers SET "voucherDate" = :voucherDate, "loanId" = :loanId, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo,
        "refNo" = :refNo, notes = :notes, amount = :amount, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate, loanId, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      refNo: pick('refNo', cur.refNo), notes: pick('notes', cur.notes), amount: fromCents(cents), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_LOAN_VOUCHER_UPDATED', entityType: 'EmployeeLoanVoucher', entityId: id, before: { amount: num(toCents(cur.amount)) }, after: { amount: num(cents) } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM employee_loan_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_LOAN_VOUCHER_DELETED', entityType: 'EmployeeLoanVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: num(toCents(cur.amount)) } }, { transaction });
  });
}

/** Posts the entry: Debit Employee Loans, Credit the bank or cash account. The loan is checked again as it is now. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const cents = toCents(cur.amount);
    await checkLoan(companyId, cur.loanId, cur.voucherDate, cents, id, transaction);
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const loanAccount = await accounts.ensureDefault(req, 'EMPLOYEE_LOANS', transaction);
    const narration = `Employee loan voucher ${voucherLabel(cur.voucherNo)} - ${cur.employeeName} (loan #${cur.loanCode})${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [{ accountId: loanAccount, debit: num(cents), narration }, { accountId: bank.id, credit: num(cents), narration }],
    }, transaction);
    await sequelize.query(`UPDATE employee_loan_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_LOAN_VOUCHER_CONFIRMED', entityType: 'EmployeeLoanVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(cents) } }, { transaction });
  });
  return get(req, id);
}

/** "Move to draft": the entry is reversed (both stay in the books). Refused when the payroll already deducted more than what would stay paid out. */
async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const paid = await paidOn(cur.loanId, id, transaction); // the other confirmed vouchers
    const [d] = await q('SELECT COALESCE(SUM(amount), 0)::text AS n FROM payroll_loan_deductions WHERE "loanId" = :loanId', { loanId: cur.loanId }, transaction);
    if (paid.confirmed < toCents(d.n)) throw AppError.rule('LOAN_ALREADY_DEDUCTED', `The payroll already deducted ${fromCents(toCents(d.n))} against this loan: the voucher cannot be moved to draft`);
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `employee loan voucher ${voucherLabel(cur.voucherNo)} moved to draft` }, transaction);
    await sequelize.query(`UPDATE employee_loan_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_LOAN_VOUCHER_UNCONFIRMED', entityType: 'EmployeeLoanVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: voucherLabel(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, loans, list, get, create, update, remove, confirm, unconfirm, accountsEntry, SOURCE };
