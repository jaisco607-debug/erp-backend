// EOBI Contribution Voucher (accounting, owner 2026-11-06): the EOBI paid for ONE LOCATION of a provider's list of a month, from a bank or cash account.
//   DRAFT      saved; may be changed or deleted; no accounting entry
//   CONFIRMED  posted:  Debit EOBI Payable (the employee shares: what was withheld from the salaries)  /  Debit EOBI Employer Contribution (the employer shares: the company's own cost)
//                       Credit Bank or Cash (both together)
//   un-confirm ("move to draft") posts the reverse entry
// The amounts are the sums of the list's rows of that location, worked out again when the voucher is confirmed; once it is confirmed the rows of that location are locked. A location has one
// voucher a month. The list of the month and a location are needed first, so the employees without a location must be assigned before their money can be paid.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { monthLabel } = require('./eobiService');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, q, lock, num, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'EOBI_VOUCHER';
const LOCK = 'eobi';
const pad5 = (n) => String(n).padStart(5, '0');
const label = (n) => `EOV-${pad5(n)}`;

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."providerId", p.name AS "providerName", v."locationId", loc.name AS "locationName", to_char(v.month, 'YYYY-MM') AS month,
  v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v."refNo", v.notes, v.employees, v."employerAmount"::text AS employer, v."employeeAmount"::text AS "employeeShare", v.amount::text AS amount,
  v.status, v."confirmedAt", cb.name AS "confirmedByName", v."createdAt", v."updatedAt", a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType"`;
const FROM = `FROM eobi_vouchers v JOIN eobi_providers p ON p.id = v."providerId" JOIN eobi_locations loc ON loc.id = v."locationId" JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

async function options(req) {
  return { modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), payFromAccounts: await support.bankAndCashAccounts(req.user.companyId) };
}

/** What the rows of a location say now: the number of employees and the two shares, in cents. */
async function totalsOf(companyId, providerId, locationId, month, transaction) {
  const [t] = await q(`SELECT count(*)::int AS employees, COALESCE(SUM(r."employerAmount"), 0)::text AS employer, COALESCE(SUM(r."employeeAmount"), 0)::text AS share
    FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId" WHERE l."companyId" = :companyId AND l."providerId" = :providerId AND r."locationId" = :locationId AND r.month = :first`,
  { companyId, providerId, locationId, first: `${month}-01` }, transaction);
  return { employees: t.employees, employer: toCents(t.employer), share: toCents(t.share) };
}

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate, provider: { id: r.providerId, name: r.providerName }, location: { id: r.locationId, name: r.locationName },
    month: r.month, monthLabel: monthLabel(r.month), payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, refNo: r.refNo, notes: r.notes,
    employees: r.employees, employer: num(toCents(r.employer)), employeeShare: num(toCents(r.employeeShare)), amount: num(toCents(r.amount)),
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED', createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('EOBI voucher');
  return r;
}

async function get(req, id, transaction) {
  const r = await load(req, id, transaction);
  const v = voucherJson(r);
  const lines = await q(`SELECT e.code, e.name, e.cnic, d.name AS department, r.wage::text AS wage, r."employerAmount"::text AS employer, r."employeeAmount"::text AS share
    FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId" JOIN payroll_employees e ON e.id = r."employeeId" LEFT JOIN payroll_departments d ON d.id = e."departmentId"
    WHERE l."companyId" = :companyId AND l."providerId" = :providerId AND r."locationId" = :locationId AND r.month = :first ORDER BY e.code`, { companyId: req.user.companyId, providerId: r.providerId, locationId: r.locationId, first: `${r.month}-01` }, transaction);
  v.lines = lines.map((l) => ({ employee: { code: l.code, label: pad5(l.code), name: l.name, cnic: l.cnic, department: l.department }, wage: num(toCents(l.wage)), employer: num(toCents(l.employer)), employeeShare: num(toCents(l.share)), total: num(toCents(l.employer) + toCents(l.share)) }));
  return v;
}

async function list(req, { page, limit, status, month, providerId, locationId, dateFrom, dateTo, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (month) { where.push('v.month = :first'); r.first = `${month}-01`; }
  if (providerId) { where.push('v."providerId" = :providerId'); r.providerId = providerId; }
  if (locationId) { where.push('v."locationId" = :locationId'); r.locationId = locationId; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(loc.name ILIKE :like OR p.name ILIKE :like OR a.name ILIKE :like OR v."refNo" ILIKE :like OR v."chequeNo" ILIKE :like OR v.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v.amount), 0)::text AS total, COALESCE(SUM(v.amount) FILTER (WHERE v.status = 'CONFIRMED'), 0)::text AS confirmed ${FROM} WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, amount: num(toCents(sum.total)), confirmed: num(toCents(sum.confirmed)) } };
}

/** GET /eobi-vouchers/locations?month=&providerId=: the locations of the lists of a month, with what each owes and its voucher (the picker of the voucher). */
async function locations(req, { month, providerId }) {
  const repl = { companyId: req.user.companyId, first: `${month}-01` };
  let extra = '';
  if (providerId) { extra = ' AND l."providerId" = :providerId'; repl.providerId = providerId; }
  const rows = await q(`SELECT l."providerId", p.name AS provider, r."locationId", loc.name AS location, count(*)::int AS employees, SUM(r."employerAmount")::text AS employer, SUM(r."employeeAmount")::text AS share,
      v.id AS "voucherId", v."voucherNo", v.status
    FROM eobi_list_rows r JOIN eobi_lists l ON l.id = r."listId" JOIN eobi_providers p ON p.id = l."providerId" JOIN eobi_locations loc ON loc.id = r."locationId"
    LEFT JOIN eobi_vouchers v ON v."providerId" = l."providerId" AND v."locationId" = r."locationId" AND v.month = r.month
    WHERE l."companyId" = :companyId AND r.month = :first${extra} GROUP BY l."providerId", p.name, r."locationId", loc.name, v.id ORDER BY p.name, loc.name`, repl);
  return { month, monthLabel: monthLabel(month), data: rows.map((r) => ({ providerId: r.providerId, provider: r.provider, locationId: r.locationId, location: r.location, employees: r.employees, employer: num(toCents(r.employer)), employeeShare: num(toCents(r.share)),
    total: num(toCents(r.employer) + toCents(r.share)), voucher: r.voucherId ? { id: r.voucherId, label: label(r.voucherNo), status: r.status } : null })) };
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const [loc] = await q('SELECT id, name FROM eobi_locations WHERE id = :locationId AND "providerId" = :providerId AND "companyId" = :companyId', { locationId: data.locationId, providerId: data.providerId, companyId }, transaction);
    if (!loc) throw AppError.notFound('Location');
    const [list] = await q('SELECT id FROM eobi_lists WHERE "providerId" = :providerId AND month = :first AND "companyId" = :companyId', { providerId: data.providerId, first: `${data.month}-01`, companyId }, transaction);
    if (!list) throw AppError.rule('NO_LIST', `There is no EOBI list for ${monthLabel(data.month)}`);
    const t = await totalsOf(companyId, data.providerId, data.locationId, data.month, transaction);
    if (!t.employees) throw AppError.rule('NO_EMPLOYEES', `No employee of the list is under ${loc.name}: assign the location first`);
    const [exists] = await q('SELECT "voucherNo" FROM eobi_vouchers WHERE "providerId" = :providerId AND "locationId" = :locationId AND month = :first', { providerId: data.providerId, locationId: data.locationId, first: `${data.month}-01` }, transaction);
    if (exists) throw AppError.rule('VOUCHER_EXISTS', `${loc.name} already has EOBI voucher ${label(exists.voucherNo)} for ${monthLabel(data.month)}`);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    await accounts.ensureDefault(req, 'EOBI_PAYABLE', transaction);
    await accounts.ensureDefault(req, 'EOBI_EMPLOYER_EXPENSE', transaction);
    const voucherNo = await nextNo('eobi_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO eobi_vouchers ("companyId", "voucherNo", "voucherDate", "providerId", "locationId", month, "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", "refNo", notes,
        employees, "employerAmount", "employeeAmount", amount, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :providerId, :locationId, :first, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :refNo, :notes, :employees, :employer, :share, :amount, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), providerId: data.providerId, locationId: data.locationId, first: `${data.month}-01`, payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode,
      chequeDate: data.chequeDate || null, chequeNo: data.chequeNo || null, refNo: data.refNo || null, notes: data.notes || null, employees: t.employees, employer: fromCents(t.employer), share: fromCents(t.share),
      amount: fromCents(t.employer + t.share), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'EOBI_VOUCHER_CREATED', entityType: 'EobiVoucher', entityId: newId, after: { voucherNo, month: data.month, location: loc.name, employees: t.employees, amount: num(t.employer + t.share) } }, { transaction });
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
    const t = await totalsOf(companyId, cur.providerId, cur.locationId, cur.month, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await sequelize.query(`UPDATE eobi_vouchers SET "voucherDate" = :voucherDate, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo, "refNo" = :refNo, notes = :notes,
        employees = :employees, "employerAmount" = :employer, "employeeAmount" = :share, amount = :amount, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      refNo: pick('refNo', cur.refNo), notes: pick('notes', cur.notes), employees: t.employees, employer: fromCents(t.employer), share: fromCents(t.share), amount: fromCents(t.employer + t.share), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EOBI_VOUCHER_UPDATED', entityType: 'EobiVoucher', entityId: id, after: { amount: num(t.employer + t.share) } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM eobi_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'EOBI_VOUCHER_DELETED', entityType: 'EobiVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: num(toCents(cur.amount)) } }, { transaction });
  });
}

/** Posts the entry for the amounts the rows of the location say now. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock(LOCK, companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const t = await totalsOf(companyId, cur.providerId, cur.locationId, cur.month, transaction);
    if (!t.employees || t.employer + t.share <= 0n) throw AppError.rule('NOTHING_TO_PAY', 'No employee is left under this location, or the amounts are zero');
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const payable = await accounts.ensureDefault(req, 'EOBI_PAYABLE', transaction);
    const expense = await accounts.ensureDefault(req, 'EOBI_EMPLOYER_EXPENSE', transaction);
    const sum = t.employer + t.share;
    const narration = `EOBI contribution voucher ${label(cur.voucherNo)} - ${cur.providerName} / ${cur.locationName}, ${monthLabel(cur.month)} (${t.employees} employee${t.employees === 1 ? '' : 's'})${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const lines = [];
    if (t.share > 0n) lines.push({ accountId: payable, debit: num(t.share), narration: `${narration}: employee share` });
    if (t.employer > 0n) lines.push({ accountId: expense, debit: num(t.employer), narration: `${narration}: employer share` });
    lines.push({ accountId: bank.id, credit: num(sum), narration });
    const entry = await journal.post(req, { entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration, lines }, transaction);
    await sequelize.query(`UPDATE eobi_vouchers SET employees = :employees, "employerAmount" = :employer, "employeeAmount" = :share, amount = :amount, status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId,
        "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, employees: t.employees, employer: fromCents(t.employer), share: fromCents(t.share), amount: fromCents(sum), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EOBI_VOUCHER_CONFIRMED', entityType: 'EobiVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(sum), employees: t.employees } }, { transaction });
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
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `EOBI voucher ${label(cur.voucherNo)} moved to draft` }, transaction);
    await sequelize.query(`UPDATE eobi_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'EOBI_VOUCHER_UNCONFIRMED', entityType: 'EobiVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, locations, list, get, create, update, remove, confirm, unconfirm, accountsEntry, SOURCE };
