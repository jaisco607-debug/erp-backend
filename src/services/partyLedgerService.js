// Party Ledger and Accounts Payables / Receivables (service ACC_REPORTS, read only). Worked out from the journal lines of the party
// (a line that names a customer or a vendor), never from saved totals. The Party Ledger is the "View" of a row of Accounts Payables / Receivables.
// Amounts are exact (cents as BigInt, shown as strings).
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const accountService = require('./accountService');
const { range } = require('./trialBalanceService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, bind) => sequelize.query(sql, { bind }).then(([rows]) => rows);
const abs = (n) => (n < 0n ? -n : n);
const side = (n) => (n > 0n ? 'DEBIT' : n < 0n ? 'CREDIT' : null);
const pad5 = (n) => (n == null ? null : String(n).padStart(5, '0'));

const PARTY_TABLE = { CUSTOMER: 'customers', VENDOR: 'vendors' };
const SOURCE_TEXT = {
  OPENING: 'Opening balance', SALES_INVOICE: 'Sales invoice', PURCHASE_INVOICE: 'Purchase invoice',
  PAYMENT_VOUCHER: 'Vendor payment', RECEIPT_VOUCHER: 'Customer receipt', JOURNAL_VOUCHER: 'Journal voucher', CONTRA_VOUCHER: 'Contra',
};

// What a journal entry came from: the number of the document, the cheque and the bill number. Joined into the ledger queries.
const SOURCE_JOINS = `
  LEFT JOIN payment_vouchers pv ON e."sourceType" = 'PAYMENT_VOUCHER' AND pv.id = e."sourceId"
  LEFT JOIN receipt_vouchers rv ON e."sourceType" = 'RECEIPT_VOUCHER' AND rv.id = e."sourceId"
  LEFT JOIN journal_vouchers jv ON e."sourceType" = 'JOURNAL_VOUCHER' AND jv.id = e."sourceId"
  LEFT JOIN contra_vouchers cv ON e."sourceType" = 'CONTRA_VOUCHER' AND cv.id = e."sourceId"
  LEFT JOIN purchase_invoices pi ON e."sourceType" = 'PURCHASE_INVOICE' AND pi.id = e."sourceId"
  LEFT JOIN sales_invoices si ON e."sourceType" = 'SALES_INVOICE' AND si.id = e."sourceId"`;
const SOURCE_COLS = `COALESCE(pv."voucherNo", rv."voucherNo", jv."voucherNo", cv."voucherNo", pi."voucherNo", si."invoiceNo") AS "docNo",
  COALESCE(pv."chequeNo", rv."chequeNo") AS "chequeNo", to_char(COALESCE(pv."chequeDate", rv."chequeDate"), 'YYYY-MM-DD') AS "chequeDate", pi."billNo" AS "billNo"`;

// What the screen shows next to a line without another call: the money breakdown of an invoice and the texts of the invoice / voucher.
const DOC_COLS = `COALESCE(si."grossAmount", pi."grossAmount")::text AS "grossAmount", COALESCE(si."taxAmount", pi."taxAmount")::text AS "taxAmount",
  COALESCE(si."taxRate", pi."taxRate")::float AS "taxRate", COALESCE(si."othersAmount", pi."othersAmount")::text AS "othersAmount", COALESCE(si."othersNote", pi."othersNote") AS "othersNote",
  COALESCE(si.notes, pi.notes, pv.notes, rv.notes) AS "docNotes", COALESCE(si."invoiceDetails", pi."billDetails") AS "docDetails", COALESCE(jv.narration, cv.narration) AS "voucherNarration"`;
// the entry a reversal undoes / the entry that undid this one, so the screen can pair and hide both
const PAIR_COLS = `e."reversalOfId" AS "reversesEntryId", (SELECT o."entryNo" FROM journal_entries o WHERE o.id = e."reversalOfId") AS "reversesEntryNo",
  (SELECT r.id FROM journal_entries r WHERE r."reversalOfId" = e.id) AS "reversedByEntryId", (SELECT r."entryNo" FROM journal_entries r WHERE r."reversalOfId" = e.id) AS "reversedByEntryNo"`;

const money = (v) => (v == null ? null : fromCents(toCents(v)));
const docFields = (r) => ({
  gross: money(r.grossAmount), tax: money(r.taxAmount), taxRate: r.taxRate, othersAmount: money(r.othersAmount), othersNote: r.othersNote || null,
  notes: r.docNotes || null, details: r.docDetails || null, voucherNarration: r.voucherNarration || null, entryNarration: r.narration,
});

const sourceFields = (r) => ({
  sourceType: r.sourceType, sourceText: SOURCE_TEXT[r.sourceType] || r.sourceType, sourceId: r.sourceId,
  docNo: r.docNo, docLabel: pad5(r.docNo),
});

async function partyOr404(companyId, partyType, partyId) {
  const table = PARTY_TABLE[partyType];
  const [p] = await q(`SELECT id, code, name, ntn, cnic FROM ${table} WHERE id = $1 AND "companyId" = $2`, [partyId, companyId]);
  if (!p) throw AppError.notFound(partyType === 'VENDOR' ? 'Vendor' : 'Customer');
  return p;
}

/** GET /accounting/party-ledger?partyType=&partyId= : every line of one customer / vendor in the period, with a running balance. */
async function partyLedger(req, { partyType, partyId, dateFrom, dateTo, fiscalYear, search, kind }) {
  const { companyId } = req.user;
  const { from, to } = await range(companyId, { dateFrom, dateTo, fiscalYear });
  const party = await partyOr404(companyId, partyType, partyId);

  const [{ opening }] = await q(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS opening FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND l."partyType" = $2 AND l."partyId" = $3 AND e."entryDate" <= $5 AND (e."entryDate" < $4 OR e."sourceType" = 'OPENING')`, [companyId, partyType, partyId, from, to]);
  const LIMIT = 5000;
  const rows = await q(`SELECT e.id AS "entryId", e."entryNo", to_char(e."entryDate", 'YYYY-MM-DD') AS "entryDate", e."sourceType", e."sourceId", e.status, e."reversalOfId" IS NOT NULL AS "isReversal",
      e.narration, l.narration AS "lineNarration", l.debit::text AS debit, l.credit::text AS credit, a.code AS "accountCode", a.name AS "accountName", ${SOURCE_COLS}, ${DOC_COLS}, ${PAIR_COLS}
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" JOIN accounts a ON a.id = l."accountId" ${SOURCE_JOINS}
    WHERE l."companyId" = $1 AND l."partyType" = $2 AND l."partyId" = $3 AND e."entryDate" >= $4 AND e."entryDate" <= $5 AND e."sourceType" <> 'OPENING'
    ORDER BY e."entryDate", e."entryNo", l."lineNo" LIMIT ${LIMIT + 1}`, [companyId, partyType, partyId, from, to]);
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
    return {
      entryId: r.entryId, entryNo: r.entryNo, date: r.entryDate, ...sourceFields(r),
      isReversal: r.isReversal, reversed: r.status === 'REVERSED',
      reversesEntryId: r.reversesEntryId, reversesEntryNo: r.reversesEntryNo, reversedByEntryId: r.reversedByEntryId, reversedByEntryNo: r.reversedByEntryNo,
      ...docFields(r),
      ref: r.chequeNo || r.billNo || null, chequeNo: r.chequeNo, chequeDate: r.chequeDate,
      particulars: r.lineNarration || r.narration, account: { code: r.accountCode, name: r.accountName },
      debit: fromCents(d), credit: fromCents(c), balance: fromCents(abs(running)), balanceSide: side(running),
    };
  });

  // the tabs: how many lines of each kind (before the search and the kind are applied)
  const counts = {};
  for (const l of all) counts[l.sourceType] = (counts[l.sourceType] || 0) + 1;
  const kinds = Object.keys(counts).sort().map((k) => ({ code: k, text: SOURCE_TEXT[k] || k, count: counts[k] }));

  const needle = search ? String(search).trim().toLowerCase() : '';
  const shown = all.filter((l) => (!kind || l.sourceType === kind)
    && (!needle || [l.particulars, l.ref, l.docLabel, l.sourceText, l.account.name].some((t) => t && String(t).toLowerCase().includes(needle))));

  return {
    party: { type: partyType, id: party.id, code: party.code, name: party.name, ntn: party.ntn, cnic: party.cnic },
    dateFrom: from, dateTo: to,
    opening: { balance: fromCents(abs(startNet)), balanceSide: side(startNet) },
    totals: { debit: fromCents(debit), credit: fromCents(credit) },
    closing: { balance: fromCents(abs(running)), balanceSide: side(running) },
    kinds, total: all.length, shown: shown.length, truncated, lines: shown,
  };
}

/** GET /accounting/payables and /receivables : one row per vendor / customer with the debit and credit up to a date and the balance. */
async function partiesReport(req, partyType, { date, search, includeZero, page, limit }) {
  const { companyId } = req.user;
  const { to } = await range(companyId, { dateTo: date });
  const table = PARTY_TABLE[partyType];
  const bind = [companyId, partyType, to];
  let where = 'p."companyId" = $1';
  if (search) {
    bind.push(`%${String(search).trim()}%`);
    where += ' AND (p.name ILIKE $4 OR p.ntn ILIKE $4 OR p.cnic ILIKE $4 OR p.code::text ILIKE $4)';
  }
  const rows = await q(`SELECT p.id, p.code, p.name, p.ntn, p.cnic, COALESCE(t.d, 0)::text AS debit, COALESCE(t.c, 0)::text AS credit
    FROM ${table} p LEFT JOIN (
      SELECT l."partyId", SUM(l.debit) AS d, SUM(l.credit) AS c FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
      WHERE l."companyId" = $1 AND l."partyType" = $2 AND e."entryDate" <= $3 GROUP BY l."partyId") t ON t."partyId" = p.id
    WHERE ${where} ORDER BY lower(p.name), p.code`, bind);

  let totalDebit = 0n;
  let totalCredit = 0n;
  const all = [];
  for (const r of rows) {
    const d = toCents(r.debit);
    const c = toCents(r.credit);
    if (!includeZero && d === c) continue;
    totalDebit += d;
    totalCredit += c;
    const net = d - c;
    all.push({ id: r.id, code: r.code, name: r.name, ntn: r.ntn, cnic: r.cnic, debit: fromCents(d), credit: fromCents(c), balance: fromCents(abs(net)), balanceSide: side(net) });
  }
  const net = totalDebit - totalCredit;
  return {
    partyType, date: to, page, limit, total: all.length,
    totals: { debit: fromCents(totalDebit), credit: fromCents(totalCredit), balance: fromCents(abs(net)), balanceSide: side(net) },
    data: all.slice((page - 1) * limit, page * limit),
  };
}

const payables = (req, query) => partiesReport(req, 'VENDOR', query);
const receivables = (req, query) => partiesReport(req, 'CUSTOMER', query);

module.exports = { partyLedger, payables, receivables, SOURCE_JOINS, SOURCE_COLS, sourceFields, SOURCE_TEXT, pad5 };
