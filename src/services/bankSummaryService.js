// Bank Summary (service ACC_BANK: VIEW reads, FULL sets or removes a clearing date).
// The bank lines of one bank account in a period with a running balance, the date each cheque / transfer cleared (kept in bank_clearings,
// the journal itself never changes), the lines the bank has not cleared yet, and the figures to agree the books with the bank statement.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const accountService = require('./accountService');
const { range } = require('./trialBalanceService');
const { SOURCE_JOINS, SOURCE_COLS, sourceFields } = require('./partyLedgerService');
const { isRealDate } = require('../utils/dates');

const { toCents, fromCents } = accountService.internals;
const q = (sql, bind, transaction) => sequelize.query(sql, { bind, transaction }).then(([rows]) => rows);
const abs = (n) => (n < 0n ? -n : n);
const side = (n) => (n > 0n ? 'DEBIT' : n < 0n ? 'CREDIT' : null);

/** GET /accounting/bank-accounts : the bank accounts of the company (the picker of the screen). */
async function accounts(req) {
  return q(`SELECT id, code, name FROM accounts WHERE "companyId" = $1 AND "controlType" = 'BANK' AND "isGroup" = false AND "isActive" = true ORDER BY code`, [req.user.companyId]);
}

async function bankAccountOr404(companyId, accountId) {
  const [a] = await q('SELECT id, code, name, "controlType", "isGroup" FROM accounts WHERE id = $1 AND "companyId" = $2', [accountId, companyId]);
  if (!a) throw AppError.notFound('Account');
  if (a.isGroup || a.controlType !== 'BANK') throw AppError.rule('NOT_BANK_ACCOUNT', `${a.code} (${a.name}) is not a bank account`);
  return a;
}

/** GET /accounting/bank-summary?accountId= */
async function summary(req, { accountId, dateFrom, dateTo, fiscalYear, status, search }) {
  const { companyId } = req.user;
  const { from, to } = await range(companyId, { dateFrom, dateTo, fiscalYear });
  const a = await bankAccountOr404(companyId, accountId);

  const [{ opening }] = await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS opening FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."accountId" = $1 AND e."entryDate" <= $3 AND (e."entryDate" < $2 OR e."sourceType" = 'OPENING')`, [accountId, from, to]);
  const LIMIT = 5000;
  const rows = await q(`SELECT l.id AS "lineId", e.id AS "entryId", e."entryNo", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate", e."sourceType", e."sourceId", e.status, e."reversalOfId" IS NOT NULL AS "isReversal",
      e.narration, l.narration AS "lineNarration", l.debit::text AS debit, l.credit::text AS credit, to_char(bc."clearedDate", 'YYYY-MM-DD') AS "clearedDate", ${SOURCE_COLS}
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" LEFT JOIN bank_clearings bc ON bc."journalLineId" = l.id ${SOURCE_JOINS}
    WHERE l."accountId" = $1 AND e."entryDate" >= $2 AND e."entryDate" <= $3 AND e."sourceType" <> 'OPENING'
    ORDER BY e."entryDate", e."entryNo", l."lineNo" LIMIT ${LIMIT + 1}`, [accountId, from, to]);
  const truncated = rows.length > LIMIT;

  let running = toCents(opening);
  const startNet = running;
  let debit = 0n;
  let credit = 0n;
  const all = rows.slice(0, LIMIT).map((r) => {
    const d = toCents(r.debit);
    const c = toCents(r.credit);
    debit += d;
    credit += c;
    running += d - c;
    const live = r.status === 'POSTED' && !r.isReversal;
    return {
      lineId: r.lineId, entryId: r.entryId, date: r.entryDate, ...sourceFields(r), isReversal: r.isReversal, reversed: r.status === 'REVERSED',
      chequeNo: r.chequeNo, chequeDate: r.chequeDate, particulars: r.lineNarration || r.narration,
      debit: fromCents(d), credit: fromCents(c), balance: fromCents(abs(running)), balanceSide: side(running),
      clearedDate: r.clearedDate, cleared: !!r.clearedDate, canClear: live,
    };
  });
  const needle = search ? String(search).trim().toLowerCase() : '';
  const lines = all.filter((l) => (!status || status === 'ALL' || (status === 'CLEARED' ? l.cleared : !l.cleared && l.canClear))
    && (!needle || [l.particulars, l.chequeNo, l.docLabel, l.sourceText].some((t) => t && String(t).toLowerCase().includes(needle))));

  // not cleared by the end of the period: live lines (not reversed, not a reversal) without a clearing date, or cleared after the end of the period
  const open = await q(`SELECT l.id AS "lineId", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate", e."sourceType", e."sourceId", e.narration, l.narration AS "lineNarration",
      l.debit::text AS debit, l.credit::text AS credit, ${SOURCE_COLS}
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" LEFT JOIN bank_clearings bc ON bc."journalLineId" = l.id ${SOURCE_JOINS}
    WHERE l."accountId" = $1 AND e."entryDate" <= $2 AND e."sourceType" <> 'OPENING' AND e.status = 'POSTED' AND e."reversalOfId" IS NULL
      AND (bc.id IS NULL OR bc."clearedDate" > $2)
    ORDER BY e."entryDate", e."entryNo", l."lineNo"`, [accountId, to]);
  let openDebit = 0n;
  let openCredit = 0n;
  const uncleared = open.map((r) => {
    const d = toCents(r.debit);
    const c = toCents(r.credit);
    openDebit += d;
    openCredit += c;
    return { lineId: r.lineId, date: r.entryDate, ...sourceFields(r), chequeNo: r.chequeNo, chequeDate: r.chequeDate, particulars: r.lineNarration || r.narration, debit: fromCents(d), credit: fromCents(c) };
  });

  // the books at the end of the period, and what the bank statement should show: the books less the deposits the bank has not seen
  // plus the payments the bank has not paid yet
  const [{ book }] = await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS book FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" WHERE l."accountId" = $1 AND e."entryDate" <= $2`, [accountId, to]);
  const bookNet = toCents(book);
  const bankNet = bookNet - (openDebit - openCredit);

  return {
    account: { id: a.id, code: a.code, name: a.name },
    dateFrom: from, dateTo: to,
    opening: { balance: fromCents(abs(startNet)), balanceSide: side(startNet) },
    totals: { debit: fromCents(debit), credit: fromCents(credit) },
    closing: { balance: fromCents(abs(running)), balanceSide: side(running) },
    total: all.length, shown: lines.length, truncated, lines,
    uncleared: { count: uncleared.length, totals: { debit: fromCents(openDebit), credit: fromCents(openCredit) }, lines: uncleared },
    reconciliation: {
      booksBalance: fromCents(abs(bookNet)), booksSide: side(bookNet),
      unclearedDeposits: fromCents(openDebit), unclearedPayments: fromCents(openCredit),
      bankBalance: fromCents(abs(bankNet)), bankSide: side(bankNet),
    },
  };
}

async function clearableLine(companyId, lineId, transaction) {
  const [l] = await q(`SELECT l.id, a."controlType", e.status, e."reversalOfId", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate"
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" JOIN accounts a ON a.id = l."accountId"
    WHERE l.id = $1 AND l."companyId" = $2`, [lineId, companyId], transaction);
  if (!l) throw AppError.notFound('Bank line');
  if (l.controlType !== 'BANK') throw AppError.rule('NOT_BANK_ACCOUNT', 'This line is not on a bank account');
  if (l.status !== 'POSTED' || l.reversalOfId) throw AppError.rule('NOT_CLEARABLE', 'A reversed entry, or the reversal itself, has no clearing date');
  return l;
}

/** PUT /accounting/bank-clearing : set (or change) the date the bank cleared a line. */
async function setCleared(req, { journalLineId, clearedDate }) {
  const { companyId, id: userId } = req.user;
  if (!isRealDate(clearedDate)) throw AppError.rule('BAD_DATE', 'The date is not a real date');
  return sequelize.transaction(async (transaction) => {
    const l = await clearableLine(companyId, journalLineId, transaction);
    if (clearedDate < l.entryDate) throw AppError.rule('CLEARED_BEFORE_ENTRY', `The line is dated ${l.entryDate}; it cannot clear before that`);
    const [before] = await q('SELECT to_char("clearedDate", \'YYYY-MM-DD\') AS d FROM bank_clearings WHERE "journalLineId" = $1', [journalLineId], transaction);
    await q(`INSERT INTO bank_clearings ("companyId", "journalLineId", "clearedDate", "clearedById") VALUES ($1, $2, $3, $4)
      ON CONFLICT ("journalLineId") DO UPDATE SET "clearedDate" = EXCLUDED."clearedDate", "clearedById" = EXCLUDED."clearedById", "updatedAt" = now()`, [companyId, journalLineId, clearedDate, userId], transaction);
    await audit.log(req, { action: 'BANK_LINE_CLEARED', entityType: 'JournalLine', entityId: journalLineId, before: before ? { clearedDate: before.d } : null, after: { clearedDate } }, { transaction });
    return { journalLineId, clearedDate };
  });
}

/** DELETE /accounting/bank-clearing/:lineId : the line is not cleared (again). */
async function removeCleared(req, journalLineId) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const [row] = await q('SELECT to_char("clearedDate", \'YYYY-MM-DD\') AS d FROM bank_clearings WHERE "journalLineId" = $1 AND "companyId" = $2', [journalLineId, companyId], transaction);
    if (!row) throw AppError.notFound('Clearing date');
    await q('DELETE FROM bank_clearings WHERE "journalLineId" = $1 AND "companyId" = $2', [journalLineId, companyId], transaction);
    await audit.log(req, { action: 'BANK_LINE_UNCLEARED', entityType: 'JournalLine', entityId: journalLineId, before: { clearedDate: row.d }, after: null }, { transaction });
  });
}

module.exports = { accounts, summary, setCleared, removeCleared };
