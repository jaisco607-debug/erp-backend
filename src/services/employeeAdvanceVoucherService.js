// Employee Advance Voucher (accounting, owner 2026-11-14): the money paid out to an employee for an ADVANCE written down in the payroll (Payroll > Applications > Advance), from a bank or cash account.
//   DRAFT      saved; may be changed or deleted; no accounting entry
//   CONFIRMED  posted:  Debit Employee Advances (the default account of that role)  /  Credit Bank or Cash
//   un-confirm ("move to draft") posts the reverse entry; refused once the payroll has taken the advance from a salary.
// An advance is paid by ONE voucher for its whole amount (the next payroll takes the whole amount back). The accountant picks "Advance" as the purpose of the voucher and then the advance.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { voucherLabel, DEDUCTED } = require('./payrollAdvanceService');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, q, lock, amountCents, num, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'EMPLOYEE_ADVANCE_VOUCHER';
const LOCK = 'payroll-advance';

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."advanceId", v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v."refNo", v.notes,
  v.amount::text AS amount, v.status, v."confirmedAt", cb.name AS "confirmedByName", v."createdAt", v."updatedAt",
  a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType",
  ad.code AS "advanceCode", ad.amount::text AS "advanceAmount", to_char(ad."advanceDate", 'YYYY-MM-DD') AS "advanceDate",
  e.id AS "employeeId", e.code AS "employeeCode", e.name AS "employeeName", e.cnic`;
const FROM = `FROM employee_advance_vouchers v JOIN payroll_advances ad ON ad.id = v."advanceId" JOIN payroll_employees e ON e.id = ad."employeeId"
  JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

async function options(req) {
  return { purpose: 'ADVANCE', modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), payFromAccounts: await support.bankAndCashAccounts(req.user.companyId) };
}

/** GET /employee-advance-vouchers/advances: the advances nobody has made a voucher for yet (the advance picker of the voucher). */
async function advances(req, { search, limit }) {
  const where = ['ad."companyId" = :companyId', 'NOT EXISTS (SELECT 1 FROM employee_advance_vouchers v WHERE v."advanceId" = ad.id)'];
  const repl = { companyId: req.user.companyId, limit };
  if (search) {
    repl.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR ad.code = :n OR e.code = :n' : '';
    if (numeric) repl.n = Number(search.trim());
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like${numeric})`);
  }
  const rows = await q(`SELECT ad.id, ad.code, ad.amount::text AS amount, to_char(ad."advanceDate", 'YYYY-MM-DD') AS "advanceDate", ad.remarks, e.id AS "employeeId", e.code AS "employeeCode", e.name, e.cnic
    FROM payroll_advances ad JOIN payroll_employees e ON e.id = ad."employeeId" WHERE ${where.join(' AND ')} ORDER BY ad.code DESC LIMIT :limit`, repl);
  return {
    data: rows.map((r) => ({ advanceId: r.id, appId: String(r.code).padStart(5, '0'), label: `ADV-${String(r.code).padStart(5, '0')}`, employee: { id: r.employeeId, code: r.employeeCode, name: r.name, cnic: r.cnic },
      amount: num(toCents(r.amount)), toPay: num(toCents(r.amount)), advanceDate: r.advanceDate, remarks: r.remarks })),
    total: rows.length,
  };
}

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: voucherLabel(r.voucherNo), voucherDate: r.voucherDate, purpose: 'ADVANCE',
    advance: { id: r.advanceId, appId: String(r.advanceCode).padStart(5, '0'), label: `ADV-${String(r.advanceCode).padStart(5, '0')}`, amount: num(toCents(r.advanceAmount)), advanceDate: r.advanceDate },
    employee: { id: r.employeeId, code: r.employeeCode, name: r.employeeName, cnic: r.cnic },
    payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, refNo: r.refNo, notes: r.notes, amount: num(toCents(r.amount)),
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED', createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Advance voucher');
  return r;
}
const get = async (req, id, transaction) => voucherJson(await load(req, id, transaction));

async function list(req, { page, limit, status, dateFrom, dateTo, advanceId, employeeId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (advanceId) { where.push('v."advanceId" = :advanceId'); r.advanceId = advanceId; }
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

/** The advance must exist, have no other voucher, the amount must be its amount and the date not before it. */
async function checkAdvance(companyId, advanceId, voucherDate, cents, exceptVoucherId, transaction) {
  const [a] = await q(`SELECT ad.id, ad.code, ad.amount::text AS amount, to_char(ad."advanceDate", 'YYYY-MM-DD') AS "advanceDate", e.name FROM payroll_advances ad JOIN payroll_employees e ON e.id = ad."employeeId"
    WHERE ad.id = :advanceId AND ad."companyId" = :companyId FOR UPDATE OF ad`, { advanceId, companyId }, transaction);
  if (!a) throw AppError.notFound('Advance');
  if (voucherDate < a.advanceDate) throw AppError.rule('VOUCHER_BEFORE_ADVANCE', `The advance is dated ${a.advanceDate}; the voucher cannot be dated before it`);
  const [other] = await q('SELECT "voucherNo" FROM employee_advance_vouchers WHERE "advanceId" = :advanceId AND id <> :except LIMIT 1', { advanceId, except: exceptVoucherId || '00000000-0000-0000-0000-000000000000' }, transaction);
  if (other) throw AppError.rule('ADVANCE_ALREADY_PAID', `Advance ${a.code} (${a.name}) already has voucher ${voucherLabel(other.voucherNo)}`, { voucherNo: other.voucherNo });
  if (cents !== toCents(a.amount)) throw AppError.rule('AMOUNT_NOT_ADVANCE', `The voucher pays the whole advance: ${fromCents(toCents(a.amount))}`, { amount: num(toCents(a.amount)) });
  return a;
}

async function create(req, data) {
  const { companyId } = req.user;
  const voucherDate = data.voucherDate || today();
  const id = await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    // the amount is the advance's amount (it is only checked when it is sent)
    const [adv] = await q('SELECT amount::text AS amount FROM payroll_advances WHERE id = :id AND "companyId" = :companyId', { id: data.advanceId, companyId }, transaction);
    if (!adv) throw AppError.notFound('Advance');
    const cents = data.amount === undefined ? toCents(adv.amount) : amountCents(data.amount, 'Amount');
    const advance = await checkAdvance(companyId, data.advanceId, voucherDate, cents, null, transaction);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    await accounts.ensureDefault(req, 'EMPLOYEE_ADVANCES', transaction); // the account exists from the first voucher on
    const voucherNo = await nextNo('employee_advance_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO employee_advance_vouchers ("companyId", "voucherNo", "voucherDate", "advanceId", "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", "refNo", notes, amount, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :advanceId, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :refNo, :notes, :amount, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate, advanceId: data.advanceId, payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null, chequeNo: data.chequeNo || null,
      refNo: data.refNo || null, notes: data.notes || null, amount: fromCents(cents), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'EMPLOYEE_ADVANCE_VOUCHER_CREATED', entityType: 'EmployeeAdvanceVoucher', entityId: newId, after: { voucherNo, advance: advance.code, employee: advance.name, amount: num(cents) } }, { transaction });
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
    const advanceId = changes.advanceId || cur.advanceId;
    const voucherDate = changes.voucherDate || cur.voucherDate;
    let cents = toCents(cur.amount);
    if (changes.advanceId && changes.advanceId !== cur.advanceId) {
      const [adv] = await q('SELECT amount::text AS amount FROM payroll_advances WHERE id = :id AND "companyId" = :companyId', { id: changes.advanceId, companyId }, transaction);
      if (!adv) throw AppError.notFound('Advance');
      cents = toCents(adv.amount);
    }
    if (changes.amount !== undefined) cents = amountCents(changes.amount, 'Amount');
    await checkAdvance(companyId, advanceId, voucherDate, cents, id, transaction);
    const accountId = changes.payFromAccountId || cur.accountId;
    if (changes.payFromAccountId) await bankOrCash(companyId, accountId, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await sequelize.query(`UPDATE employee_advance_vouchers SET "voucherDate" = :voucherDate, "advanceId" = :advanceId, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo,
        "refNo" = :refNo, notes = :notes, amount = :amount, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate, advanceId, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      refNo: pick('refNo', cur.refNo), notes: pick('notes', cur.notes), amount: fromCents(cents), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_ADVANCE_VOUCHER_UPDATED', entityType: 'EmployeeAdvanceVoucher', entityId: id, before: { amount: num(toCents(cur.amount)) }, after: { amount: num(cents) } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM employee_advance_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_ADVANCE_VOUCHER_DELETED', entityType: 'EmployeeAdvanceVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: num(toCents(cur.amount)) } }, { transaction });
  });
}

/** Posts the entry: Debit Employee Advances, Credit the bank or cash account. The advance is checked again as it is now. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const cents = toCents(cur.amount);
    await checkAdvance(companyId, cur.advanceId, cur.voucherDate, cents, id, transaction);
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const advanceAccount = await accounts.ensureDefault(req, 'EMPLOYEE_ADVANCES', transaction);
    const narration = `Employee advance voucher ${voucherLabel(cur.voucherNo)} - ${cur.employeeName} (advance #${cur.advanceCode})${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [{ accountId: advanceAccount, debit: num(cents), narration }, { accountId: bank.id, credit: num(cents), narration }],
    }, transaction);
    await sequelize.query(`UPDATE employee_advance_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_ADVANCE_VOUCHER_CONFIRMED', entityType: 'EmployeeAdvanceVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(cents) } }, { transaction });
  });
  return get(req, id);
}

/** "Move to draft": the entry is reversed (both stay in the books). Refused once the payroll has taken the advance from a salary. */
async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [d] = await q(`SELECT ${DEDUCTED.replace(/a\.id/g, ':advanceId')}::text AS n`, { advanceId: cur.advanceId }, transaction);
    if (toCents(d.n) > 0n) throw AppError.rule('ADVANCE_ALREADY_RECOVERED', `The payroll already took ${fromCents(toCents(d.n))} of this advance from a salary: the voucher cannot be moved to draft`);
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `employee advance voucher ${voucherLabel(cur.voucherNo)} moved to draft` }, transaction);
    await sequelize.query(`UPDATE employee_advance_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EMPLOYEE_ADVANCE_VOUCHER_UNCONFIRMED', entityType: 'EmployeeAdvanceVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: voucherLabel(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, advances, list, get, create, update, remove, confirm, unconfirm, accountsEntry, SOURCE };
