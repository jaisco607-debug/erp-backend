// The accounting engine (owner 2026-10-24). Every invoice / voucher turns into ONE journal entry made of lines
// (account + debit OR credit). The General Ledger and the Trial Balance are always worked out from these lines.
//   post(...)      checks the lines and saves the entry; debit must equal credit, accounts must be active posting accounts of the company
//   reverse(...)   a mistake is never edited: the same lines are posted the other way round and the first entry is marked REVERSED
// Both need the caller's transaction, so the invoice and its entry are saved together or not at all.
// The database repeats the main rules (no change or delete of posted lines, debit = credit at commit): see migration 20261025000002.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const { round } = require('../utils/money');
const { today, isRealDate } = require('../utils/dates');

const PARTY_TYPES = ['CUSTOMER', 'VENDOR'];
const cents = (n) => Math.round(round(n, 2) * 100);
const q = (sql, bind, transaction) => sequelize.query(sql, { bind, transaction }).then(([rows]) => rows);

/** Cleans and checks the lines; returns rows with rounded amounts. Debit and credit totals must be equal. */
function checkLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw AppError.rule('TOO_FEW_LINES', 'A journal entry needs at least two lines');
  let debit = 0;
  let credit = 0;
  const clean = lines.map((l, i) => {
    const d = round(l.debit || 0, 2);
    const c = round(l.credit || 0, 2);
    if (!l.accountId) throw AppError.rule('LINE_NO_ACCOUNT', `Line ${i + 1} has no account`);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) {
      throw AppError.rule('LINE_ONE_SIDE', `Line ${i + 1} must have either a debit or a credit amount (more than zero), not both`);
    }
    if (Boolean(l.partyType) !== Boolean(l.partyId) || (l.partyType && !PARTY_TYPES.includes(l.partyType))) {
      throw AppError.rule('LINE_BAD_PARTY', `Line ${i + 1}: party type and party must be given together (CUSTOMER or VENDOR)`);
    }
    debit += cents(d);
    credit += cents(c);
    return { accountId: l.accountId, debit: d, credit: c, partyType: l.partyType || null, partyId: l.partyId || null, narration: l.narration ? String(l.narration).slice(0, 300) : null };
  });
  if (debit !== credit) throw AppError.rule('UNBALANCED', `Debit (${debit / 100}) and credit (${credit / 100}) are not equal`, { debit: debit / 100, credit: credit / 100 });
  return clean;
}

/**
 * Posts one journal entry.
 * @param entry   { entryDate?, sourceType, sourceId?, narration?, lines: [{ accountId, debit?, credit?, partyType?, partyId?, narration? }] }
 * @param options { reversalOfId, allowInactive }  (used by reverse(): an account switched off later must not block a reversal)
 * @returns the saved entry with its lines
 */
async function post(req, entry, transaction, options = {}) {
  if (!transaction) throw new Error('journalService.post needs the caller\'s transaction');
  const { companyId } = req.user;
  const entryDate = entry.entryDate || today();
  if (!isRealDate(entryDate)) throw AppError.rule('BAD_DATE', 'The entry date is not a real date');
  const lines = checkLines(entry.lines);

  // the accounts: this company's, posting (not group), active; held with a share lock so nobody changes them while the entry is saved
  const ids = [...new Set(lines.map((l) => l.accountId))];
  const accounts = new Map((await q('SELECT id, code, name, "isGroup", "isActive" FROM accounts WHERE "companyId" = $1 AND id = ANY($2::uuid[]) FOR SHARE', [companyId, ids], transaction)).map((a) => [a.id, a]));
  for (const id of ids) {
    const a = accounts.get(id);
    if (!a) throw AppError.rule('ACCOUNT_NOT_FOUND', 'An account of the entry does not exist in this company');
    if (a.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `Account ${a.code} (${a.name}) is a group account; entries cannot be posted to it`);
    if (!a.isActive && !options.allowInactive) throw AppError.rule('ACCOUNT_INACTIVE', `Account ${a.code} (${a.name}) is switched off`);
  }

  // a line that names a customer / vendor: that party must belong to this company (the callers check too; the engine never trusts an id)
  for (const [type, table] of [['CUSTOMER', 'customers'], ['VENDOR', 'vendors']]) {
    const partyIds = [...new Set(lines.filter((l) => l.partyType === type).map((l) => l.partyId))];
    if (!partyIds.length) continue;
    const found = await q(`SELECT id FROM ${table} WHERE "companyId" = $1 AND id = ANY($2::uuid[])`, [companyId, partyIds], transaction);
    if (found.length !== partyIds.length) throw AppError.rule('PARTY_NOT_FOUND', `A ${type.toLowerCase()} of the entry does not exist in this company`);
  }

  const entryNo = await counters.take(companyId, 'journal_no', async () => ((await q('SELECT MAX("entryNo") AS m FROM journal_entries WHERE "companyId" = $1', [companyId], transaction))[0].m || 0) + 1, transaction);
  const [{ id }] = await q(`INSERT INTO journal_entries ("companyId", "entryNo", "entryDate", "sourceType", "sourceId", narration, "reversalOfId", "createdById")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
  [companyId, entryNo, entryDate, entry.sourceType, entry.sourceId || null, entry.narration ? String(entry.narration).slice(0, 300) : null, options.reversalOfId || null, req.user.id], transaction);
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await q(`INSERT INTO journal_lines ("entryId", "companyId", "lineNo", "accountId", debit, credit, "partyType", "partyId", narration)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, companyId, lineNo, l.accountId, l.debit, l.credit, l.partyType, l.partyId, l.narration], transaction);
  }
  const saved = await get(req, id, transaction);
  await audit.log(req, {
    action: options.reversalOfId ? 'JOURNAL_REVERSAL_POSTED' : 'JOURNAL_POSTED', entityType: 'JournalEntry', entityId: id,
    after: { entryNo, entryDate, sourceType: saved.sourceType, sourceId: saved.sourceId, debit: saved.totals.debit, credit: saved.totals.credit },
  }, { transaction });
  return saved;
}

/** Reverses a posted entry: posts the same lines the other way round and marks the first entry REVERSED. */
async function reverse(req, entryId, { reason, entryDate } = {}, transaction) {
  if (!transaction) throw new Error('journalService.reverse needs the caller\'s transaction');
  const { companyId } = req.user;
  const [old] = await q(`SELECT id, "entryNo", to_char("entryDate", 'YYYY-MM-DD') AS "entryDate", "sourceType", "sourceId", status, "reversalOfId"
    FROM journal_entries WHERE id = $1 AND "companyId" = $2 FOR UPDATE`, [entryId, companyId], transaction);
  if (!old) throw AppError.notFound('Journal entry');
  if (old.reversalOfId) throw AppError.rule('CANNOT_REVERSE_A_REVERSAL', 'A reversal entry cannot be reversed; post the entry again instead');
  if (old.status === 'REVERSED') throw AppError.rule('ALREADY_REVERSED', `Entry ${old.entryNo} is already reversed`);
  // the reversal of a document is dated like the document: the party ledger then reads original, reversal, new entry in order, and nothing sits in between
  const date = entryDate || old.entryDate;
  if (isRealDate(date) && date < old.entryDate) throw AppError.rule('REVERSAL_BEFORE_ENTRY', `The entry is dated ${old.entryDate}; it cannot be reversed on an earlier date`);

  const lines = await q('SELECT "accountId", debit::float AS debit, credit::float AS credit, "partyType", "partyId", narration FROM journal_lines WHERE "entryId" = $1 ORDER BY "lineNo"', [entryId], transaction);
  const reversal = await post(req, {
    entryDate: date, sourceType: old.sourceType, sourceId: old.sourceId,
    narration: `Reversal of entry ${old.entryNo}${reason ? `: ${reason}` : ''}`,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, partyType: l.partyType, partyId: l.partyId, narration: l.narration })),
  }, transaction, { reversalOfId: old.id, allowInactive: true });
  await q('UPDATE journal_entries SET status = \'REVERSED\' WHERE id = $1', [entryId], transaction);
  return reversal;
}

const ENTRY_COLUMNS = `e.id, e."entryNo", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate", e."sourceType", e."sourceId", e.narration, e.status, e."reversalOfId", e."createdAt"`;

async function withLines(req, entries, transaction) {
  if (!entries.length) return [];
  const lines = await q(`SELECT l."entryId", l."lineNo", l."accountId", a.code AS "accountCode", a.name AS "accountName", l.debit::float AS debit, l.credit::float AS credit,
      l."partyType", l."partyId", l.narration
    FROM journal_lines l JOIN accounts a ON a.id = l."accountId"
    WHERE l."companyId" = $1 AND l."entryId" = ANY($2::uuid[]) ORDER BY l."entryId", l."lineNo"`, [req.user.companyId, entries.map((e) => e.id)], transaction);
  return entries.map((e) => {
    const own = lines.filter((l) => l.entryId === e.id).map((l) => ({
      lineNo: l.lineNo, account: { id: l.accountId, code: l.accountCode, name: l.accountName }, debit: l.debit, credit: l.credit,
      partyType: l.partyType, partyId: l.partyId, narration: l.narration,
    }));
    const debit = round(own.reduce((t, l) => t + l.debit, 0), 2);
    const credit = round(own.reduce((t, l) => t + l.credit, 0), 2);
    return { ...e, lines: own, totals: { debit, credit }, balanced: debit === credit };
  });
}

/** One entry with its lines. */
async function get(req, id, transaction) {
  const rows = await q(`SELECT ${ENTRY_COLUMNS} FROM journal_entries e WHERE e.id = $1 AND e."companyId" = $2`, [id, req.user.companyId], transaction);
  if (!rows.length) throw AppError.notFound('Journal entry');
  return (await withLines(req, rows, transaction))[0];
}

/** Every entry of one document (a sales invoice ...), oldest first: its posting and, if any, its reversals. */
async function entriesOfSource(req, sourceType, sourceId, transaction) {
  const rows = await q(`SELECT ${ENTRY_COLUMNS} FROM journal_entries e WHERE e."companyId" = $1 AND e."sourceType" = $2 AND e."sourceId" = $3 ORDER BY e."entryNo"`,
    [req.user.companyId, sourceType, sourceId], transaction);
  return withLines(req, rows, transaction);
}

module.exports = { post, reverse, get, entriesOfSource, PARTY_TYPES };
