// Opening balances as ONE real journal entry (sourceType OPENING), dated the day the books start.
// An account has no opening balance field of its own any more (the old field stays readable but is not used).
//   GET /accounting/opening-balances?date=   the lines of the opening entry, the totals, and whether it can still be changed
//   PUT /accounting/opening-balances         replaces the opening entry: the old one is reversed (nothing is erased), the new one is posted
// Rules:
//   - debit must equal credit, counted in cents over ALL accounts (switched-off ones too); `balancingAccountId` takes the difference
//   - once any other entry exists in the books, the opening balances are locked (OPENING_LOCKED)
//   - Accounts Receivable / Payable: when the company has customers / vendors, each line names the customer / vendor (CONTROL_USES_SUBLEDGER)
//   - income and expense accounts may only have an opening balance when the books start in the middle of a fiscal year (PL_OPENING_NOT_ALLOWED)
const { sequelize, Account, Company } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accountService = require('./accountService');
const { isRealDate } = require('../utils/dates');

const { lockCompany, toCents, fromCents } = accountService.internals;
const SOURCE = 'OPENING';
const q = (sql, bind, transaction) => sequelize.query(sql, { bind, transaction }).then(([rows]) => rows);

/** The fiscal year starts on the 1st of this month. A book start on that day has no income / expense yet; any other day is "mid-year". */
function plOpeningAllowed(date, startMonth) {
  const [, month, day] = String(date).split('-').map(Number);
  return !(month === startMonth && day === 1);
}

/** The amount of a line as exact cents: a decimal string ("1500.50") or a number with at most 2 decimals. */
function amountCents(value, where) {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw AppError.rule('BAD_AMOUNT', `${where}: the amount must be a positive number with at most 2 decimals`);
  return toCents(text);
}

async function liveEntry(companyId, transaction) {
  const [e] = await q(`SELECT id, "entryNo", to_char("entryDate", 'YYYY-MM-DD') AS "entryDate" FROM journal_entries
    WHERE "companyId" = $1 AND "sourceType" = $2 AND status = 'POSTED' AND "reversalOfId" IS NULL ORDER BY "entryNo" DESC LIMIT 1`, [companyId, SOURCE], transaction);
  return e || null;
}

async function lockState(companyId, transaction) {
  const [other] = await q('SELECT count(*)::int AS n FROM journal_entries WHERE "companyId" = $1 AND "sourceType" <> $2', [companyId, SOURCE], transaction);
  return other.n > 0 ? { locked: true, lockedReason: 'Entries other than the opening balances already exist in the books' } : { locked: false, lockedReason: null };
}

async function startMonthOf(companyId, transaction) {
  const [c] = await q('SELECT "fiscalYearStartMonth" AS m FROM companies WHERE id = $1', [companyId], transaction);
  return c ? c.m : 7;
}

/** GET */
async function get(req, { date } = {}, transaction) {
  const { companyId } = req.user;
  const entry = await liveEntry(companyId, transaction);
  const month = await startMonthOf(companyId, transaction);
  const when = entry ? entry.entryDate : date || null;
  const state = await lockState(companyId, transaction);
  const out = {
    date: when, entryId: entry ? entry.id : null, entryNo: entry ? entry.entryNo : null, fiscalYearStartMonth: month,
    plOpeningAllowed: when ? plOpeningAllowed(when, month) : null,
    ...state, lines: [], totals: { debit: '0.00', credit: '0.00' }, balanced: true,
  };
  if (!entry) return out;
  const lines = await q(`SELECT l."accountId", a.code, a.name, a."accountType", a."isActive", l.debit::text AS debit, l.credit::text AS credit, l."partyType", l."partyId", l.narration
    FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."entryId" = $1 ORDER BY l."lineNo"`, [entry.id], transaction);
  let debit = 0n;
  let credit = 0n;
  out.lines = lines.map((l) => {
    const d = toCents(l.debit);
    const c = toCents(l.credit);
    debit += d;
    credit += c;
    return { accountId: l.accountId, code: l.code, name: l.name, accountType: l.accountType, isActive: l.isActive, side: d > 0n ? 'DEBIT' : 'CREDIT', amount: fromCents(d > 0n ? d : c), partyType: l.partyType, partyId: l.partyId };
  });
  out.totals = { debit: fromCents(debit), credit: fromCents(credit) };
  out.balanced = debit === credit;
  return out;
}

/** PUT { date, lines: [{ accountId, amount, side?, partyType?, partyId? }], balancingAccountId? } */
async function save(req, { date, lines, balancingAccountId }) {
  const { companyId } = req.user;
  if (!isRealDate(date)) throw AppError.rule('BAD_DATE', 'The opening date is not a real date');
  await sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const state = await lockState(companyId, transaction);
    if (state.locked) throw AppError.rule('OPENING_LOCKED', `The opening balances can no longer be changed: ${state.lockedReason.toLowerCase()}`);

    const ids = [...new Set([...lines.map((l) => l.accountId), ...(balancingAccountId ? [balancingAccountId] : [])])];
    const accounts = new Map((await q('SELECT id, code, name, "accountType", "normalBalance", "isGroup", "controlType" FROM accounts WHERE "companyId" = $1 AND id = ANY($2::uuid[])', [companyId, ids], transaction)).map((a) => [a.id, a]));
    const month = await startMonthOf(companyId, transaction);
    const plAllowed = plOpeningAllowed(date, month);
    const [{ customers }] = await q('SELECT count(*)::int AS customers FROM customers WHERE "companyId" = $1 AND "deletedAt" IS NULL', [companyId], transaction);
    const [{ vendors }] = await q('SELECT count(*)::int AS vendors FROM vendors WHERE "companyId" = $1', [companyId], transaction);

    const out = [];
    let debit = 0n;
    let credit = 0n;
    lines.forEach((l, i) => {
      const a = accounts.get(l.accountId);
      const where = `Line ${i + 1}`;
      if (!a) throw AppError.rule('ACCOUNT_NOT_FOUND', `${where}: the account does not exist in this company`);
      if (a.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `${where}: ${a.code} (${a.name}) is a folder; an opening balance goes on an account inside it`);
      const cents = amountCents(l.amount, where);
      if (cents === 0n) return; // a zero line is simply left out
      if ((a.accountType === 'INCOME' || a.accountType === 'EXPENSE') && !plAllowed) {
        throw AppError.rule('PL_OPENING_NOT_ALLOWED', `${where}: ${a.code} (${a.name}) is an ${a.accountType.toLowerCase()} account. Income and expenses start from zero when the books begin on the first day of the fiscal year`);
      }
      const subledger = a.controlType === 'CUSTOMERS' ? { needed: customers > 0, type: 'CUSTOMER', who: 'customer' } : a.controlType === 'SUPPLIERS' ? { needed: vendors > 0, type: 'VENDOR', who: 'vendor' } : null;
      let partyType = null;
      let partyId = null;
      if (subledger && subledger.needed) {
        if (!l.partyId) throw AppError.rule('CONTROL_USES_SUBLEDGER', `${where}: ${a.code} (${a.name}) follows its ${subledger.who}s. Enter the opening balance of each ${subledger.who} (partyId)`);
        partyType = subledger.type;
        partyId = l.partyId;
      } else if (l.partyId) {
        throw AppError.rule('LINE_BAD_PARTY', `${where}: only Accounts Receivable and Accounts Payable lines name a customer or vendor`);
      }
      const side = l.side || a.normalBalance;
      if (side === 'DEBIT') debit += cents; else credit += cents;
      out.push({ accountId: a.id, debit: side === 'DEBIT' ? fromCents(cents) : 0, credit: side === 'CREDIT' ? fromCents(cents) : 0, partyType, partyId, narration: 'Opening balance' });
    });

    // every named customer / vendor must be this company's own
    for (const l of out.filter((x) => x.partyId)) {
      const table = l.partyType === 'CUSTOMER' ? 'customers' : 'vendors';
      const [found] = await q(`SELECT 1 FROM ${table} WHERE id = $1 AND "companyId" = $2`, [l.partyId, companyId], transaction);
      if (!found) throw AppError.notFound(l.partyType === 'CUSTOMER' ? 'Customer' : 'Vendor');
    }

    // the difference goes to the balancing account
    if (debit !== credit && balancingAccountId) {
      const b = accounts.get(balancingAccountId);
      if (!b) throw AppError.rule('ACCOUNT_NOT_FOUND', 'The balancing account does not exist in this company');
      if (b.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `The balancing account ${b.code} (${b.name}) is a folder`);
      if (b.controlType === 'CUSTOMERS' || b.controlType === 'SUPPLIERS') throw AppError.rule('CONTROL_USES_SUBLEDGER', 'A customer or supplier control account cannot take the difference');
      const diff = debit > credit ? debit - credit : credit - debit;
      out.push({ accountId: b.id, debit: debit > credit ? 0 : fromCents(diff), credit: debit > credit ? fromCents(diff) : 0, narration: 'Opening balance (balancing)' });
      if (debit > credit) credit += diff; else debit += diff;
    }
    if (debit !== credit) {
      throw AppError.rule('UNBALANCED', `Debit (${fromCents(debit)}) and credit (${fromCents(credit)}) are not equal. Give a balancing account, or correct the amounts`,
        { debit: fromCents(debit), credit: fromCents(credit), difference: fromCents(debit > credit ? debit - credit : credit - debit), side: debit > credit ? 'CREDIT' : 'DEBIT' });
    }

    // the old opening entry is reversed (it stays in the books), then the new one is posted
    const old = await liveEntry(companyId, transaction);
    if (old) await journal.reverse(req, old.id, { reason: 'opening balances changed', entryDate: date >= old.entryDate ? date : old.entryDate }, transaction);
    let posted = null;
    if (out.length) {
      posted = await journal.post(req, { entryDate: date, sourceType: SOURCE, narration: 'Opening balances', lines: out }, transaction, { allowInactive: true });
    }
    await audit.log(req, { action: 'OPENING_BALANCES_SAVED', entityType: 'JournalEntry', entityId: posted ? posted.id : old ? old.id : null, after: { date, lines: out.length, debit: fromCents(debit), credit: fromCents(credit), replaced: Boolean(old) } }, { transaction });
  });
  return get(req, {});
}

// ---- settings ---------------------------------------------------------------------------------------------------------------------

async function getSettings(req) {
  return { fiscalYearStartMonth: await startMonthOf(req.user.companyId) };
}

async function saveSettings(req, { fiscalYearStartMonth }) {
  const before = await getSettings(req);
  await Company.update({ fiscalYearStartMonth }, { where: { id: req.user.companyId } });
  await audit.log(req, { action: 'ACCOUNTING_SETTINGS_SAVED', entityType: 'Company', entityId: req.user.companyId, before, after: { fiscalYearStartMonth } });
  return getSettings(req);
}

module.exports = { get, save, getSettings, saveSettings, plOpeningAllowed };
