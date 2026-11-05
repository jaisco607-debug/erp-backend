// Journal Voucher (JV, accounting chunk 4, owner 2026-10-29): the general voucher. Any debit and credit lines that balance: a transfer from cash
// to the bank, bank charges, an accrual, a prepayment, owner's capital, a loan, an adjustment. (Sales, purchases, payments and receipts have their own vouchers.)
//   DRAFT      saved; may be changed or deleted; no accounting entry
//   CONFIRMED  posted as ONE journal entry (debit = credit, checked in cents)
//   un-confirm ("move to draft") posts the reverse entry and the voucher is a draft again
// A line on a customer / vendor control account (Accounts Receivable / Payable, Customer / Supplier Advances) must name the customer / vendor, so the
// customer and vendor balances keep agreeing with the control accounts. A line on any other account must not name one.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const support = require('./voucherSupport');
const { today } = require('../utils/dates');

const { STATUS_TEXT, label, q, lock, num, nextNo, toCents, fromCents } = support;
const SOURCE = 'JOURNAL_VOUCHER';
// the control accounts that need a customer / vendor on the line
const PARTY_OF_CONTROL = { CUSTOMERS: 'CUSTOMER', CUSTOMER_ADVANCES: 'CUSTOMER', SUPPLIERS: 'VENDOR', SUPPLIER_ADVANCES: 'VENDOR' };

function options() {
  return { statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), partyControlTypes: Object.entries(PARTY_OF_CONTROL).map(([controlType, partyType]) => ({ controlType, partyType })) };
}

/** One debit or one credit, more than zero, as exact cents. */
function sideCents(line, i) {
  const get = (v, name) => {
    if (v === undefined || v === null || v === '' || v === 0 || v === '0' || v === '0.00') return 0n;
    const text = typeof v === 'number' ? v.toFixed(2) : String(v).trim();
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw AppError.rule('BAD_AMOUNT', `Line ${i + 1}: the ${name} must be a number with at most 2 decimals`);
    return toCents(text);
  };
  const debit = get(line.debit, 'debit');
  const credit = get(line.credit, 'credit');
  if ((debit > 0n) === (credit > 0n)) throw AppError.rule('LINE_ONE_SIDE', `Line ${i + 1} must have either a debit or a credit amount (more than zero), not both`);
  return { debit, credit };
}

/** The lines checked against the chart of accounts and the customers / vendors. `forPosting`: the accounts must be switched on (checked again when confirming). */
async function buildLines(req, input, transaction) {
  const { companyId } = req.user;
  if (!Array.isArray(input) || input.length < 2) throw AppError.rule('TOO_FEW_LINES', 'A journal voucher needs at least two lines');
  const ids = [...new Set(input.map((l) => l.accountId))];
  const accts = new Map((await q('SELECT id, code, name, "accountType", "controlType", "isGroup", "isActive" FROM accounts WHERE "companyId" = :companyId AND id IN (:ids)', { companyId, ids }, transaction)).map((a) => [a.id, a]));
  let debit = 0n;
  let credit = 0n;
  const lines = input.map((l, i) => {
    const a = accts.get(l.accountId);
    const where = `Line ${i + 1}`;
    if (!a) throw AppError.rule('ACCOUNT_NOT_FOUND', `${where}: the account does not exist in this company`);
    if (a.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `${where}: ${a.code} (${a.name}) is a folder; use an account inside it`);
    if (!a.isActive) throw AppError.rule('ACCOUNT_INACTIVE', `${where}: account ${a.code} (${a.name}) is switched off`);
    const need = PARTY_OF_CONTROL[a.controlType] || null;
    if (need && !l.partyId) throw AppError.rule('CONTROL_NEEDS_PARTY', `${where}: ${a.code} (${a.name}) follows its ${need === 'CUSTOMER' ? 'customers' : 'vendors'}; name the ${need === 'CUSTOMER' ? 'customer' : 'vendor'} on the line`);
    if (!need && l.partyId) throw AppError.rule('LINE_BAD_PARTY', `${where}: only Accounts Receivable / Payable and the customer / supplier advance accounts name a customer or vendor`);
    const side = sideCents(l, i);
    debit += side.debit;
    credit += side.credit;
    return { accountId: a.id, ...side, narration: l.narration ? String(l.narration).slice(0, 200) : null, partyType: need, partyId: need ? l.partyId : null, account: a };
  });
  if (debit !== credit) {
    throw AppError.rule('UNBALANCED', `Debit (${fromCents(debit)}) and credit (${fromCents(credit)}) are not equal`, { debit: num(debit), credit: num(credit), difference: num(debit > credit ? debit - credit : credit - debit), side: debit > credit ? 'CREDIT' : 'DEBIT' });
  }
  // every named customer / vendor must be this company's own
  for (const l of lines.filter((x) => x.partyId)) {
    const table = l.partyType === 'CUSTOMER' ? 'customers' : 'vendors';
    const [found] = await q(`SELECT 1 AS ok FROM ${table} WHERE id = :id AND "companyId" = :companyId`, { id: l.partyId, companyId }, transaction);
    if (!found) throw AppError.notFound(l.partyType === 'CUSTOMER' ? 'Customer' : 'Vendor');
  }
  return { lines, total: debit };
}

async function writeLines(voucherId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM journal_voucher_lines WHERE "voucherId" = :voucherId', { replacements: { voucherId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO journal_voucher_lines ("voucherId", "companyId", "lineNo", "accountId", debit, credit, narration, "partyType", "partyId")
      VALUES (:voucherId, :companyId, :lineNo, :accountId, :debit, :credit, :narration, :partyType, :partyId)`,
    { replacements: { voucherId, companyId, lineNo, accountId: l.accountId, debit: fromCents(l.debit), credit: fromCents(l.credit), narration: l.narration, partyType: l.partyType, partyId: l.partyId }, transaction });
  }
}

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v.reference, v.narration, v."totalAmount"::float AS total, v.status, v."confirmedAt", v."createdAt", v."updatedAt",
  (SELECT count(*)::int FROM journal_voucher_lines l WHERE l."voucherId" = v.id) AS "lineCount", cb.name AS "confirmedByName"`;
const FROM = 'FROM journal_vouchers v LEFT JOIN users cb ON cb.id = v."confirmedById"';

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate, reference: r.reference, narration: r.narration, total: r.total, lineCount: r.lineCount,
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Journal voucher');
  return r;
}

async function get(req, id, transaction) {
  const v = voucherJson(await load(req, id, transaction));
  const lines = await q(`SELECT l."lineNo", l."accountId", a.code, a.name, a."accountType", l.debit::text AS debit, l.credit::text AS credit, l.narration, l."partyType", l."partyId", COALESCE(c.name, vd.name) AS "partyName"
    FROM journal_voucher_lines l JOIN accounts a ON a.id = l."accountId" LEFT JOIN customers c ON l."partyType" = 'CUSTOMER' AND c.id = l."partyId" LEFT JOIN vendors vd ON l."partyType" = 'VENDOR' AND vd.id = l."partyId"
    WHERE l."voucherId" = :id ORDER BY l."lineNo"`, { id }, transaction);
  v.lines = lines.map((l) => ({
    lineNo: l.lineNo, account: { id: l.accountId, code: l.code, name: l.name, accountType: l.accountType }, debit: num(toCents(l.debit)), credit: num(toCents(l.credit)), narration: l.narration,
    partyType: l.partyType, partyId: l.partyId, partyName: l.partyName,
  }));
  v.totals = { debit: num(lines.reduce((t, l) => t + toCents(l.debit), 0n)), credit: num(lines.reduce((t, l) => t + toCents(l.credit), 0n)) };
  v.balanced = v.totals.debit === v.totals.credit;
  return v;
}

async function list(req, { page, limit, status, dateFrom, dateTo, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(v.reference ILIKE :like OR v.narration ILIKE :like OR EXISTS (SELECT 1 FROM journal_voucher_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."voucherId" = v.id AND (a.name ILIKE :like OR l.narration ILIKE :like))${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v."totalAmount"), 0)::text AS total FROM journal_vouchers v WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, totalAmount: num(toCents(sum.total)) } };
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock('journalvouchers', companyId, transaction);
    const built = await buildLines(req, data.lines, transaction);
    const voucherNo = await nextNo('journal_vouchers', companyId, transaction);
    const [{ id: newId }] = await q(`INSERT INTO journal_vouchers ("companyId", "voucherNo", "voucherDate", reference, narration, "totalAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :reference, :narration, :total, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), reference: data.reference || null, narration: data.narration || null, total: fromCents(built.total), userId: req.user.id }, transaction);
    await writeLines(newId, companyId, built.lines, transaction);
    await audit.log(req, { action: 'JOURNAL_VOUCHER_CREATED', entityType: 'JournalVoucher', entityId: newId, after: { voucherNo, total: num(built.total), lines: built.lines.length } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('journalvouchers', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be changed. Move it to draft first');
    const input = changes.lines || (await q('SELECT "accountId", debit::text AS debit, credit::text AS credit, narration, "partyId" FROM journal_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"', { id }, transaction));
    const built = await buildLines(req, input, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query('UPDATE journal_vouchers SET "voucherDate" = :voucherDate, reference = :reference, narration = :narration, "totalAmount" = :total, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id',
      { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, reference: pick('reference', cur.reference), narration: pick('narration', cur.narration), total: fromCents(built.total), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'JOURNAL_VOUCHER_UPDATED', entityType: 'JournalVoucher', entityId: id, before: { total: cur.total }, after: { total: num(built.total), lines: built.lines.length } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock('journalvouchers', req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM journal_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'JOURNAL_VOUCHER_DELETED', entityType: 'JournalVoucher', entityId: id, before: { voucherNo: cur.voucherNo, total: cur.total } }, { transaction });
  });
}

async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('journalvouchers', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const input = await q('SELECT "accountId", debit::text AS debit, credit::text AS credit, narration, "partyId" FROM journal_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"', { id }, transaction);
    const built = await buildLines(req, input, transaction); // the accounts may have changed since the draft was saved
    const narration = `Journal voucher ${label(cur.voucherNo)}${cur.reference ? ` (${cur.reference})` : ''}${cur.narration ? ` - ${cur.narration}` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: built.lines.map((l) => ({ accountId: l.accountId, debit: num(l.debit), credit: num(l.credit), partyType: l.partyType, partyId: l.partyId, narration: l.narration || narration })),
    }, transaction);
    await sequelize.query(`UPDATE journal_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'JOURNAL_VOUCHER_CONFIRMED', entityType: 'JournalVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, total: num(built.total) } }, { transaction });
  });
  return get(req, id);
}

async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('journalvouchers', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `journal voucher ${label(cur.voucherNo)} moved to draft` }, transaction); // dated like the entry it reverses
    await sequelize.query(`UPDATE journal_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'JOURNAL_VOUCHER_UNCONFIRMED', entityType: 'JournalVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, list, get, create, update, remove, confirm, unconfirm, accountsEntry };
