// Trial Balance and the account ledger (service ACC_REPORTS, read only). Everything is worked out from the journal lines, never from saved totals.
//   Trial Balance   for every account: opening (debit / credit), movement of the period (debit / credit), closing (debit / credit).
//                   Debit and credit must be equal in every column pair: that is how the books are checked.
//   Ledger          the lines of ONE account in the period, with a running balance (the "View" of an account).
// "Opening" = everything dated before the start of the period, plus the opening balances entry (sourceType OPENING) whatever its date,
// as long as it is not after the end of the period. All amounts are exact (cents as BigInt, shown as strings), never floats.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const { today, isRealDate } = require('../utils/dates');

const { loadAll, toCents, fromCents } = accountService.internals;
const q = (sql, bind) => sequelize.query(sql, { bind }).then(([rows]) => rows);
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The fiscal year that starts in `year` and the month `startMonth`: its first and last day. */
function fiscalYearRange(year, startMonth) {
  const from = `${year}-${pad(startMonth)}-01`;
  if (startMonth === 1) return { from, to: `${year}-12-31` };
  return { from, to: `${year + 1}-${pad(startMonth - 1)}-${pad(lastDay(year + 1, startMonth - 1))}` };
}

/** The start of the fiscal year that contains `date`. */
function fiscalYearStart(date, startMonth) {
  const [y, m] = date.split('-').map(Number);
  return `${m >= startMonth ? y : y - 1}-${pad(startMonth)}-01`;
}

async function range(companyId, { dateFrom, dateTo, fiscalYear }) {
  const [c] = await q('SELECT "fiscalYearStartMonth" AS m FROM companies WHERE id = $1', [companyId]);
  const startMonth = c ? c.m : 7;
  let from = dateFrom;
  let to = dateTo;
  if (fiscalYear) ({ from, to } = fiscalYearRange(fiscalYear, startMonth));
  to = to || today();
  from = from || fiscalYearStart(to, startMonth);
  if (!isRealDate(from) || !isRealDate(to)) throw AppError.rule('BAD_DATE', 'The date is not a real date');
  if (from > to) throw AppError.rule('BAD_RANGE', 'The start of the period is after its end');
  return { from, to, startMonth };
}

const sides = (net) => ({ debit: fromCents(net > 0n ? net : 0n), credit: fromCents(net < 0n ? -net : 0n) });
const abs = (n) => (n < 0n ? -n : n);

/** GET /accounting/trial-balance */
async function trialBalance(req, { dateFrom, dateTo, fiscalYear, includeZero, accountType }) {
  const { companyId } = req.user;
  const { from, to, startMonth } = await range(companyId, { dateFrom, dateTo, fiscalYear });

  const sums = await q(`SELECT l."accountId",
      COALESCE(SUM(l.debit - l.credit) FILTER (WHERE e."entryDate" < $2 OR e."sourceType" = 'OPENING'), 0)::text AS opening,
      COALESCE(SUM(l.debit) FILTER (WHERE e."entryDate" >= $2 AND e."sourceType" <> 'OPENING'), 0)::text AS pd,
      COALESCE(SUM(l.credit) FILTER (WHERE e."entryDate" >= $2 AND e."sourceType" <> 'OPENING'), 0)::text AS pc
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND e."entryDate" <= $3 GROUP BY l."accountId"`, [companyId, from, to]);
  const by = new Map(sums.map((s) => [s.accountId, { opening: toCents(s.opening), pd: toCents(s.pd), pc: toCents(s.pc) }]));

  const { rows: accounts, byId } = await loadAll(companyId);
  const folder = (a) => {
    const names = [];
    for (let p = a.parentId && byId.get(a.parentId); p; p = p.parentId && byId.get(p.parentId)) names.unshift(p.name);
    return names.join(' > ');
  };
  const depth = (a) => { let n = 1; for (let p = a.parentId && byId.get(a.parentId); p; p = p.parentId && byId.get(p.parentId)) n += 1; return n; };

  const total = { od: 0n, oc: 0n, pd: 0n, pc: 0n, cd: 0n, cc: 0n };
  const sections = new Map();
  const rows = [];
  for (const a of accounts.filter((x) => !x.isGroup && (!accountType || x.accountType === accountType)).sort(accountService.internals.byCode)) {
    const s = by.get(a.id) || { opening: 0n, pd: 0n, pc: 0n };
    const closing = s.opening + s.pd - s.pc;
    if (!includeZero && s.opening === 0n && s.pd === 0n && s.pc === 0n && closing === 0n) continue;
    const o = sides(s.opening);
    const c = sides(closing);
    rows.push({
      accountId: a.id, code: a.code, name: a.name, accountType: a.accountType, isActive: a.isActive, isContra: a.isContra, level: depth(a), parentCode: byId.get(a.parentId)?.code ?? null, folder: folder(a),
      openingDebit: o.debit, openingCredit: o.credit, periodDebit: fromCents(s.pd), periodCredit: fromCents(s.pc), closingDebit: c.debit, closingCredit: c.credit,
    });
    total.od += s.opening > 0n ? s.opening : 0n;
    total.oc += s.opening < 0n ? -s.opening : 0n;
    total.pd += s.pd;
    total.pc += s.pc;
    total.cd += closing > 0n ? closing : 0n;
    total.cc += closing < 0n ? -closing : 0n;
    const sec = sections.get(a.accountType) || { od: 0n, oc: 0n, pd: 0n, pc: 0n, cd: 0n, cc: 0n };
    sec.od += s.opening > 0n ? s.opening : 0n;
    sec.oc += s.opening < 0n ? -s.opening : 0n;
    sec.pd += s.pd;
    sec.pc += s.pc;
    sec.cd += closing > 0n ? closing : 0n;
    sec.cc += closing < 0n ? -closing : 0n;
    sections.set(a.accountType, sec);
  }
  const fmt = (t) => ({ openingDebit: fromCents(t.od), openingCredit: fromCents(t.oc), periodDebit: fromCents(t.pd), periodCredit: fromCents(t.pc), closingDebit: fromCents(t.cd), closingCredit: fromCents(t.cc) });
  const balanced = total.od === total.oc && total.pd === total.pc && total.cd === total.cc;

  const checks = [
    {
      key: 'TRIAL_BALANCE_BALANCED', ok: balanced,
      message: balanced ? 'Debit equals credit in every column.' : 'Debit and credit are NOT equal. Something is wrong in the books.',
      details: { openingDifference: fromCents(total.od - total.oc), periodDifference: fromCents(total.pd - total.pc), closingDifference: fromCents(total.cd - total.cc) },
    },
    await controlCheck(companyId, to),
    await salesInvoiceCheck(companyId),
    await purchaseInvoiceCheck(companyId),
    await voucherCheck(companyId, { table: 'payment_vouchers', source: 'PAYMENT_VOUCHER', key: 'PAYMENT_VOUCHERS_MATCH_LEDGER', noun: 'payment voucher', total: 'billsTotal' }),
    await voucherCheck(companyId, { table: 'receipt_vouchers', source: 'RECEIPT_VOUCHER', key: 'RECEIPT_VOUCHERS_MATCH_LEDGER', noun: 'receipt voucher', total: 'grandTotal' }),
    await voucherCheck(companyId, { table: 'journal_vouchers', source: 'JOURNAL_VOUCHER', key: 'JOURNAL_VOUCHERS_MATCH_LEDGER', noun: 'journal voucher', total: 'totalAmount' }),
    await contraCheck(companyId),
    await settlementCheck(companyId),
  ];
  return {
    dateFrom: from, dateTo: to, fiscalYearStartMonth: startMonth,
    rows, totals: fmt(total),
    sections: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'].filter((t) => sections.has(t)).map((t) => ({ accountType: t, ...fmt(sections.get(t)) })),
    balanced, difference: fromCents(total.cd - total.cc), checks, ok: checks.every((c) => c.ok),
  };
}

/** The receivable and payable control accounts against what the customers / vendors owe (the lines that name a customer / vendor). */
async function controlCheck(companyId, to) {
  const rows = await q(`SELECT a.id, a.code, a.name, a."controlType",
      COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" WHERE l."accountId" = a.id AND e."entryDate" <= $2), 0)::text AS gl,
      COALESCE((SELECT SUM(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" WHERE l."accountId" = a.id AND e."entryDate" <= $2 AND l."partyId" IS NOT NULL), 0)::text AS sub
    FROM accounts a WHERE a."companyId" = $1 AND a."controlType" IN ('CUSTOMERS', 'SUPPLIERS', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES') ORDER BY a.code`, [companyId, to]);
  const accounts = rows.map((r) => {
    const gl = toCents(r.gl);
    const sub = toCents(r.sub);
    return {
      accountId: r.id, code: r.code, name: r.name, controlType: r.controlType,
      glBalance: fromCents(abs(gl)), glSide: gl > 0n ? 'DEBIT' : gl < 0n ? 'CREDIT' : null,
      subledgerBalance: fromCents(abs(sub)), subledgerSide: sub > 0n ? 'DEBIT' : sub < 0n ? 'CREDIT' : null,
      difference: fromCents(gl - sub), ok: gl === sub,
    };
  });
  const ok = accounts.every((a) => a.ok);
  return {
    key: 'CONTROL_ACCOUNTS_MATCH_SUBLEDGERS', ok, accounts,
    message: ok ? 'Accounts Receivable / Payable agree with what the customers / vendors owe.' : 'A control account has an amount that no customer / vendor is named on.',
  };
}

/** Every approved sales invoice has exactly one live entry of its own total; a draft has none. */
async function salesInvoiceCheck(companyId) {
  const rows = await q(`SELECT i.id, i."invoiceNo", i.status, i."netAmount"::text AS net,
      (SELECT count(*)::int FROM journal_entries e WHERE e."companyId" = i."companyId" AND e."sourceType" = 'SALES_INVOICE' AND e."sourceId" = i.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS live,
      (SELECT COALESCE(SUM(l.debit), 0)::text FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id
        WHERE e."companyId" = i."companyId" AND e."sourceType" = 'SALES_INVOICE' AND e."sourceId" = i.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS ledger
    FROM sales_invoices i WHERE i."companyId" = $1 ORDER BY i."invoiceNo"`, [companyId]);
  const mismatches = [];
  for (const r of rows) {
    const label = String(r.invoiceNo).padStart(5, '0');
    if (r.status === 'APPROVED' && r.live !== 1) mismatches.push({ invoiceId: r.id, invoiceNo: r.invoiceNo, reason: r.live === 0 ? 'APPROVED_WITHOUT_ENTRY' : 'APPROVED_WITH_MANY_ENTRIES', message: `Invoice ${label} is approved but has ${r.live} live entries`, invoiceNet: r.net, ledgerDebit: r.ledger });
    else if (r.status === 'APPROVED' && toCents(r.ledger) !== toCents(r.net)) mismatches.push({ invoiceId: r.id, invoiceNo: r.invoiceNo, reason: 'AMOUNT_DIFFERS', message: `Invoice ${label}: the invoice says ${r.net}, the ledger has ${r.ledger}`, invoiceNet: r.net, ledgerDebit: r.ledger });
    else if (r.status === 'UNAPPROVED' && r.live !== 0) mismatches.push({ invoiceId: r.id, invoiceNo: r.invoiceNo, reason: 'DRAFT_IN_LEDGER', message: `Invoice ${label} is a draft but has an entry in the ledger`, invoiceNet: r.net, ledgerDebit: r.ledger });
  }
  return {
    key: 'SALES_INVOICES_MATCH_LEDGER', ok: mismatches.length === 0, checked: rows.length, mismatches,
    message: mismatches.length ? 'Some sales invoices do not agree with the ledger.' : 'Every approved sales invoice agrees with the ledger; drafts are not in it.',
  };
}

/** The same for purchase invoices: every approved one has exactly one live entry of its own total; a draft has none. */
async function purchaseInvoiceCheck(companyId) {
  // the entry credits the payable (net) and, when the bill has an "others" deduction, the purchases account (others): together net + others
  const rows = await q(`SELECT i.id, i."voucherNo", i.status, (i."netAmount" + i."othersAmount")::text AS net,
      (SELECT count(*)::int FROM journal_entries e WHERE e."companyId" = i."companyId" AND e."sourceType" = 'PURCHASE_INVOICE' AND e."sourceId" = i.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS live,
      (SELECT COALESCE(SUM(l.credit), 0)::text FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id
        WHERE e."companyId" = i."companyId" AND e."sourceType" = 'PURCHASE_INVOICE' AND e."sourceId" = i.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS ledger
    FROM purchase_invoices i WHERE i."companyId" = $1 ORDER BY i."voucherNo"`, [companyId]);
  const mismatches = [];
  const add = (r, reason, message) => mismatches.push({ invoiceId: r.id, voucherNo: r.voucherNo, reason, message, invoiceNet: r.net, ledgerCredit: r.ledger });
  for (const r of rows) {
    const label = String(r.voucherNo).padStart(5, '0');
    if (r.status === 'APPROVED' && r.live !== 1) add(r, r.live === 0 ? 'APPROVED_WITHOUT_ENTRY' : 'APPROVED_WITH_MANY_ENTRIES', `Purchase invoice ${label} is approved but has ${r.live} live entries`);
    else if (r.status === 'APPROVED' && toCents(r.ledger) !== toCents(r.net)) add(r, 'AMOUNT_DIFFERS', `Purchase invoice ${label}: the invoice says ${r.net}, the ledger has ${r.ledger}`);
    else if (r.status === 'UNAPPROVED' && r.live !== 0) add(r, 'DRAFT_IN_LEDGER', `Purchase invoice ${label} is a draft but has an entry in the ledger`);
  }
  return {
    key: 'PURCHASE_INVOICES_MATCH_LEDGER', ok: mismatches.length === 0, checked: rows.length, mismatches,
    message: mismatches.length ? 'Some purchase invoices do not agree with the ledger.' : 'Every approved purchase invoice agrees with the ledger; drafts are not in it.',
  };
}

/** Every confirmed voucher has exactly one live entry whose debit is its total; a draft has none. */
async function voucherCheck(companyId, { table, source, key, noun, total }) {
  const rows = await q(`SELECT v.id, v."voucherNo", v.status, v."${total}"::text AS total,
      (SELECT count(*)::int FROM journal_entries e WHERE e."companyId" = v."companyId" AND e."sourceType" = $2 AND e."sourceId" = v.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS live,
      (SELECT COALESCE(SUM(l.debit), 0)::text FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id
        WHERE e."companyId" = v."companyId" AND e."sourceType" = $2 AND e."sourceId" = v.id AND e.status = 'POSTED' AND e."reversalOfId" IS NULL) AS ledger
    FROM ${table} v WHERE v."companyId" = $1 ORDER BY v."voucherNo"`, [companyId, source]);
  const mismatches = [];
  const add = (r, reason, message) => mismatches.push({ voucherId: r.id, voucherNo: r.voucherNo, reason, message, voucherTotal: r.total, ledgerDebit: r.ledger });
  for (const r of rows) {
    const label = String(r.voucherNo).padStart(5, '0');
    if (r.status === 'CONFIRMED' && r.live !== 1) add(r, r.live === 0 ? 'CONFIRMED_WITHOUT_ENTRY' : 'CONFIRMED_WITH_MANY_ENTRIES', `Confirmed ${noun} ${label} has ${r.live} live entries`);
    else if (r.status === 'CONFIRMED' && toCents(r.ledger) !== toCents(r.total)) add(r, 'AMOUNT_DIFFERS', `The ${noun} ${label} says ${r.total}, the ledger has ${r.ledger}`);
    else if (r.status === 'DRAFT' && r.live !== 0) add(r, 'DRAFT_IN_LEDGER', `The ${noun} ${label} is a draft but has an entry in the ledger`);
  }
  return {
    key, ok: mismatches.length === 0, checked: rows.length, mismatches,
    message: mismatches.length ? `Some ${noun}s do not agree with the ledger.` : `Every confirmed ${noun} agrees with the ledger; drafts are not in it.`,
  };
}

/** Contra vouchers: like the other vouchers, and both tables of a voucher must add up to its amount. */
async function contraCheck(companyId) {
  const base = await voucherCheck(companyId, { table: 'contra_vouchers', source: 'CONTRA_VOUCHER', key: 'CONTRA_VOUCHERS_MATCH_LEDGER', noun: 'contra voucher', total: 'amount' });
  const rows = await q(`SELECT v.id, v."voucherNo", v.amount::text AS amount,
      COALESCE((SELECT SUM(l.amount) FROM contra_voucher_lines l WHERE l."voucherId" = v.id AND l.side = 'INVOICE'), 0)::text AS inv,
      COALESCE((SELECT SUM(l.amount) FROM contra_voucher_lines l WHERE l."voucherId" = v.id AND l.side = 'BILL'), 0)::text AS bill
    FROM contra_vouchers v WHERE v."companyId" = $1 ORDER BY v."voucherNo"`, [companyId]);
  for (const r of rows) {
    if (toCents(r.inv) !== toCents(r.amount) || toCents(r.bill) !== toCents(r.amount)) {
      base.mismatches.push({ voucherId: r.id, voucherNo: r.voucherNo, reason: 'TABLES_DO_NOT_MATCH', message: `The contra voucher ${String(r.voucherNo).padStart(5, '0')} says ${r.amount}, its invoices add up to ${r.inv} and its bills to ${r.bill}`, voucherTotal: r.amount, ledgerDebit: null });
    }
  }
  base.ok = base.mismatches.length === 0;
  if (!base.ok) base.message = 'Some contra vouchers do not agree with the ledger or with their own tables.';
  return base;
}

/** What the invoices say was received / paid against what the confirmed vouchers settled. */
async function settlementCheck(companyId) {
  const sales = await q(`SELECT i.id, i."invoiceNo" AS no, i."receivedAmount"::text AS said,
      (COALESCE((SELECT SUM(l."billAmount") FROM receipt_voucher_lines l JOIN receipt_vouchers v ON v.id = l."voucherId" WHERE l."salesInvoiceId" = i.id AND v.status = 'CONFIRMED'), 0)
        + COALESCE((SELECT SUM(l.amount) FROM contra_voucher_lines l JOIN contra_vouchers v ON v.id = l."voucherId" WHERE l."salesInvoiceId" = i.id AND v.status = 'CONFIRMED'), 0))::text AS vouchers
    FROM sales_invoices i WHERE i."companyId" = $1`, [companyId]);
  const purchases = await q(`SELECT i.id, i."voucherNo" AS no, i."paidAmount"::text AS said,
      (COALESCE((SELECT SUM(l.amount) FROM payment_voucher_lines l JOIN payment_vouchers v ON v.id = l."voucherId" WHERE l."purchaseInvoiceId" = i.id AND v.status = 'CONFIRMED'), 0)
        + COALESCE((SELECT SUM(l.amount) FROM contra_voucher_lines l JOIN contra_vouchers v ON v.id = l."voucherId" WHERE l."purchaseInvoiceId" = i.id AND v.status = 'CONFIRMED'), 0))::text AS vouchers
    FROM purchase_invoices i WHERE i."companyId" = $1`, [companyId]);
  const mismatches = [];
  for (const [kind, rows, noun] of [['SALES', sales, 'Sales invoice'], ['PURCHASE', purchases, 'Purchase invoice']]) {
    for (const r of rows) {
      if (toCents(r.said) !== toCents(r.vouchers)) mismatches.push({ kind, invoiceId: r.id, invoiceNo: r.no, message: `${noun} ${String(r.no).padStart(5, '0')} says ${r.said} ${kind === 'SALES' ? 'received' : 'paid'}, the confirmed vouchers settled ${r.vouchers}`, invoiceSays: r.said, vouchersSettled: r.vouchers });
    }
  }
  return {
    key: 'INVOICE_PAYMENTS_MATCH_VOUCHERS', ok: mismatches.length === 0, checked: sales.length + purchases.length, mismatches,
    message: mismatches.length ? 'Some invoices show a received / paid amount that the confirmed vouchers do not explain.' : 'The received / paid amount of every invoice agrees with the confirmed vouchers.',
  };
}

/** GET /accounting/ledger?accountId= : the lines of one account with a running balance. */
async function ledger(req, { accountId, dateFrom, dateTo, fiscalYear }) {
  const { companyId } = req.user;
  const { from, to } = await range(companyId, { dateFrom, dateTo, fiscalYear });
  const [a] = await q('SELECT id, code, name, "accountType", "normalBalance", "isGroup", "isContra" FROM accounts WHERE id = $1 AND "companyId" = $2', [accountId, companyId]);
  if (!a) throw AppError.notFound('Account');
  if (a.isGroup) throw AppError.rule('NOT_POSTING_ACCOUNT', `${a.code} (${a.name}) is a folder; open one of the accounts inside it`);

  const [{ opening }] = await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS opening FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."accountId" = $1 AND e."entryDate" <= $3 AND (e."entryDate" < $2 OR e."sourceType" = 'OPENING')`, [accountId, from, to]);
  const LIMIT = 5000;
  const lines = await q(`SELECT e.id AS "entryId", e."entryNo", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate", e."sourceType", e."sourceId", e.status, e."reversalOfId" IS NOT NULL AS "isReversal",
      e.narration, l.narration AS "lineNarration", l.debit::text AS debit, l.credit::text AS credit, l."partyType", l."partyId", COALESCE(c.name, v.name) AS "partyName"
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
      LEFT JOIN customers c ON l."partyType" = 'CUSTOMER' AND c.id = l."partyId" LEFT JOIN vendors v ON l."partyType" = 'VENDOR' AND v.id = l."partyId"
    WHERE l."accountId" = $1 AND e."entryDate" >= $2 AND e."entryDate" <= $3 AND e."sourceType" <> 'OPENING'
    ORDER BY e."entryDate", e."entryNo", l."lineNo" LIMIT ${LIMIT + 1}`, [accountId, from, to]);
  const truncated = lines.length > LIMIT;

  let running = toCents(opening);
  const startNet = running;
  let debit = 0n;
  let credit = 0n;
  const out = lines.slice(0, LIMIT).map((l) => {
    const d = toCents(l.debit);
    const c = toCents(l.credit);
    debit += d;
    credit += c;
    running += d - c;
    return { ...l, debit: fromCents(d), credit: fromCents(c), balance: fromCents(abs(running)), balanceSide: running > 0n ? 'DEBIT' : running < 0n ? 'CREDIT' : null };
  });
  const side = (n) => (n > 0n ? 'DEBIT' : n < 0n ? 'CREDIT' : null);
  return {
    account: { id: a.id, code: a.code, name: a.name, accountType: a.accountType, normalBalance: a.normalBalance, isContra: a.isContra },
    dateFrom: from, dateTo: to,
    opening: { balance: fromCents(abs(startNet)), balanceSide: side(startNet) },
    lines: out, truncated,
    totals: { debit: fromCents(debit), credit: fromCents(credit) },
    closing: { balance: fromCents(abs(running)), balanceSide: side(running) },
  };
}

module.exports = { trialBalance, ledger, fiscalYearRange, fiscalYearStart, range };
