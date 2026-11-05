// Customer / vendor balances and Receivable & payable as on a cut-off date (service ACC_REPORTS, read only).
// Two views of the same money:
//   the LEDGER view   what the journal says each customer / vendor owes (or is owed) on the date: opening balances, invoices, vouchers, journal vouchers, advances.
//   the INVOICE view  the approved sales invoices / purchase invoices dated up to the date that were still unpaid on it, and what was received / paid since.
// "Received / paid before the cut-off" counts the CONFIRMED vouchers dated up to the cut-off, "after" the ones dated later. All amounts are exact
// (cents as BigInt, shown as strings).
const { sequelize } = require('../models');
const accountService = require('./accountService');
const { range } = require('./trialBalanceService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, bind) => sequelize.query(sql, { bind }).then(([rows]) => rows);
const abs = (n) => (n < 0n ? -n : n);
const side = (n) => (n > 0n ? 'DEBIT' : n < 0n ? 'CREDIT' : null);
const pad5 = (n) => String(n).padStart(5, '0');

const KIND = {
  SALES: {
    partyType: 'CUSTOMER', partyTable: 'customers', invoices: 'sales_invoices', no: 'i."invoiceNo"', label: 'invoiceNo', amount: 'i."netAmount"', settled: 'i."receivedAmount"', party: 'i."customerId"', bill: 'NULL',
    settle: `SELECT l."salesInvoiceId" AS iid, v."voucherDate" AS vdate, l."billAmount" AS paid FROM receipt_voucher_lines l JOIN receipt_vouchers v ON v.id = l."voucherId" WHERE v."companyId" = $1 AND v.status = 'CONFIRMED' AND l."salesInvoiceId" IS NOT NULL
      UNION ALL SELECT l."salesInvoiceId", v."voucherDate", l.amount FROM contra_voucher_lines l JOIN contra_vouchers v ON v.id = l."voucherId" WHERE v."companyId" = $1 AND v.status = 'CONFIRMED' AND l."salesInvoiceId" IS NOT NULL`,
    type: `CASE WHEN i."taxRate" > 0 THEN 'WITH_TAX' ELSE 'WITHOUT_TAX' END`,
  },
  PURCHASE: {
    partyType: 'VENDOR', partyTable: 'vendors', invoices: 'purchase_invoices', no: 'i."voucherNo"', label: 'voucherNo', amount: 'i."netAmount"', settled: 'i."paidAmount"', party: 'i."vendorId"', bill: 'i."billNo"',
    settle: `SELECT l."purchaseInvoiceId" AS iid, v."voucherDate" AS vdate, l.amount AS paid FROM payment_voucher_lines l JOIN payment_vouchers v ON v.id = l."voucherId" WHERE v."companyId" = $1 AND v.status = 'CONFIRMED' AND l."purchaseInvoiceId" IS NOT NULL
      UNION ALL SELECT l."purchaseInvoiceId", v."voucherDate", l.amount FROM contra_voucher_lines l JOIN contra_vouchers v ON v.id = l."voucherId" WHERE v."companyId" = $1 AND v.status = 'CONFIRMED' AND l."purchaseInvoiceId" IS NOT NULL`,
    type: `(SELECT CASE WHEN count(*) = 0 THEN NULL WHEN bool_and(pl.store = 'CHEMICAL') THEN 'CHEMICAL' WHEN bool_and(pl.store = 'GENERAL') THEN 'GENERAL' ELSE 'MIXED' END FROM purchase_invoice_lines pl WHERE pl."invoiceId" = i.id)`,
  },
};
const TYPE_TEXT = { WITH_TAX: 'With sales tax', WITHOUT_TAX: 'Without sales tax', CHEMICAL: 'Chemicals', GENERAL: 'General items', MIXED: 'Chemicals and general items', null: 'Other' };

/** The approved invoices / bills dated up to `cut` that were still unpaid on `cut`, with what was settled before and after it. Optional party filter. */
async function openItems(companyId, kind, cut, partyId) {
  const k = KIND[kind];
  const bind = [companyId, cut];
  let partyFilter = '';
  if (partyId) { bind.push(partyId); partyFilter = `AND ${k.party} = $3`; }
  const rows = await q(`SELECT i.id, ${k.no} AS no, ${k.bill} AS "billNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS date, to_char(COALESCE(i."dueDate", i."invoiceDate" + p."creditDays"), 'YYYY-MM-DD') AS "dueDate", ${k.party} AS "partyId", p.code AS "partyCode", p.name AS "partyName", p.ntn, p.cnic,
      ${k.type} AS type, ${k.amount}::text AS amount, ${k.settled}::text AS said,
      COALESCE(s.b, 0)::text AS before, COALESCE(s.a, 0)::text AS after
    FROM ${k.invoices} i JOIN ${k.partyTable} p ON p.id = ${k.party}
      LEFT JOIN (SELECT x.iid, SUM(x.paid) FILTER (WHERE x.vdate <= $2) AS b, SUM(x.paid) FILTER (WHERE x.vdate > $2) AS a FROM (${k.settle}) x GROUP BY x.iid) s ON s.iid = i.id
    WHERE i."companyId" = $1 AND i.status = 'APPROVED' AND i."invoiceDate" <= $2 ${partyFilter}
    ORDER BY p.name, i."invoiceDate", ${k.no}`, bind);
  const out = [];
  let mismatched = 0;
  for (const r of rows) {
    const amount = toCents(r.amount);
    const before = toCents(r.before);
    const after = toCents(r.after);
    const flagged = toCents(r.said) !== before + after;
    if (amount - before <= 0n) continue; // paid in full by the cut-off
    if (flagged) mismatched += 1;
    out.push({
      id: r.id, kind, no: r.no, label: pad5(r.no), billNo: r.billNo, date: r.date, dueDate: r.dueDate, partyId: r.partyId, partyCode: r.partyCode, partyName: r.partyName, ntn: r.ntn, cnic: r.cnic,
      type: r.type, typeText: TYPE_TEXT[r.type] || r.type,
      amount: fromCents(amount), before: fromCents(before), balance: fromCents(amount - before), after: fromCents(after), stillPending: fromCents(amount - before - after), flagged,
      _c: { amount, before, after },
    });
  }
  return { items: out, mismatched };
}

/** The balance of every party of a kind in the ledger on `cut`, as {partyId -> cents}, positive = the party owes us (customer) / we owe the party (vendor). */
async function ledgerBalances(companyId, kind, cut) {
  const k = KIND[kind];
  const rows = await q(`SELECT l."partyId", SUM(l.debit - l.credit)::text AS net FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
    WHERE l."companyId" = $1 AND l."partyType" = $2 AND e."entryDate" <= $3 GROUP BY l."partyId"`, [companyId, k.partyType, cut]);
  const sign = kind === 'SALES' ? 1n : -1n;
  return new Map(rows.map((r) => [r.partyId, sign * toCents(r.net)]));
}

const matches = (needle, ...texts) => !needle || texts.some((t) => t && String(t).toLowerCase().includes(needle));

/** GET /accounting/balances : the two lists of the "Customer / vendor balances" screen: who owes us and whom we owe, on a date. */
async function balances(req, { date, search }) {
  const { companyId } = req.user;
  const { to } = await range(companyId, { dateTo: date });
  const needle = search ? String(search).trim().toLowerCase() : '';
  const result = { date: to };
  for (const [key, kind] of [['receivables', 'SALES'], ['payables', 'PURCHASE']]) {
    const k = KIND[kind];
    const led = await ledgerBalances(companyId, kind, to);
    const { items } = await openItems(companyId, kind, to);
    const count = new Map();
    for (const i of items) count.set(i.partyId, (count.get(i.partyId) || 0) + 1);
    const parties = await q(`SELECT id, code, name, ntn, cnic FROM ${k.partyTable} WHERE "companyId" = $1 ORDER BY lower(name), code`, [companyId]);
    let total = 0n;
    let reversed = 0n;
    let reversedCount = 0;
    const rows = [];
    for (const p of parties) {
      const bal = led.get(p.id) || 0n;
      if (bal === 0n) continue;
      if (bal < 0n) { reversed += -bal; reversedCount += 1; continue; } // the other side: a customer who has paid in advance, a vendor we paid in advance
      total += bal;
      if (matches(needle, p.name, p.ntn, p.cnic, String(p.code))) rows.push({ partyId: p.id, code: p.code, name: p.name, ntn: p.ntn, cnic: p.cnic, openCount: count.get(p.id) || 0, balance: fromCents(bal) });
    }
    result[key] = { total: fromCents(total), partyCount: rows.length, otherSide: { count: reversedCount, total: fromCents(reversed) }, rows };
  }
  return result;
}

/** GET /accounting/balances/open-items : the "Invoices" / "Bills" button of a row: the unpaid documents of one party on a date. */
async function partyOpenItems(req, { partyType, partyId, date }) {
  const { companyId } = req.user;
  const { to } = await range(companyId, { dateTo: date });
  const kind = partyType === 'CUSTOMER' ? 'SALES' : 'PURCHASE';
  const k = KIND[kind];
  const [p] = await q(`SELECT id, code, name, ntn, cnic FROM ${k.partyTable} WHERE id = $1 AND "companyId" = $2`, [partyId, companyId]);
  if (!p) throw require('../utils/AppError').notFound(partyType === 'CUSTOMER' ? 'Customer' : 'Vendor');
  const { items } = await openItems(companyId, kind, to, partyId);
  const clean = items.map(({ _c, ...rest }) => rest);
  const sum = (f) => items.reduce((t, i) => t + f(i._c), 0n);
  return {
    party: { type: partyType, id: p.id, code: p.code, name: p.name, ntn: p.ntn, cnic: p.cnic }, date: to,
    totals: { amount: fromCents(sum((c) => c.amount)), balance: fromCents(sum((c) => c.amount - c.before)) },
    items: clean,
  };
}

/** One side (receivable or payable) of the cut-off report. */
async function cutoffSide(companyId, kind, cut, { detail, needle }) {
  const k = KIND[kind];
  const { items, mismatched } = await openItems(companyId, kind, cut);
  const led = await ledgerBalances(companyId, kind, cut);
  const ledgerTotal = [...led.values()].reduce((t, v) => t + v, 0n);
  const ledgerParties = [...led.values()].filter((v) => v !== 0n).length;

  const sumOf = (list) => list.reduce((t, i) => ({ n: t.n + 1, amount: t.amount + i._c.amount, before: t.before + i._c.before, after: t.after + i._c.after }), { n: 0, amount: 0n, before: 0n, after: 0n });
  const fmt = (t) => ({ count: t.n, amount: fromCents(t.amount), before: fromCents(t.before), balance: fromCents(t.amount - t.before), after: fromCents(t.after), stillPending: fromCents(t.amount - t.before - t.after) });
  const all = sumOf(items);

  // by type
  const types = new Map();
  for (const i of items) types.set(i.type, [...(types.get(i.type) || []), i]);
  const byType = [...types.entries()].sort().map(([type, list]) => ({ type, text: TYPE_TEXT[type] || type, ...fmt(sumOf(list)) }));

  // by party
  const parties = new Map();
  for (const i of items) parties.set(i.partyId, [...(parties.get(i.partyId) || []), i]);
  const partyRows = [];
  for (const [partyId, list] of parties) {
    const f = list[0];
    if (!matches(needle, f.partyName, f.ntn, f.cnic, String(f.partyCode))) continue;
    const t = sumOf(list);
    const perLedger = led.get(partyId) || 0n;
    partyRows.push({ partyId, code: f.partyCode, name: f.partyName, ntn: f.ntn, cnic: f.cnic, ...fmt(t), perLedger: fromCents(perLedger), perLedgerSide: perLedger >= 0n ? 'NORMAL' : 'REVERSED', ledgerLessInvoices: fromCents(perLedger - (t.amount - t.before)) });
  }
  partyRows.sort((a, b) => a.name.localeCompare(b.name));

  const other = ledgerTotal - (all.amount - all.before);
  return {
    ledgerBalance: fromCents(ledgerTotal), ledgerPartyCount: ledgerParties,
    invoices: { ...fmt(all), mismatched },
    byType,
    // what the ledger has that is not an unpaid invoice: opening balances, journal vouchers, advances
    otherPostings: fromCents(other),
    parties: partyRows,
    ...(detail ? { documents: items.filter((i) => matches(needle, i.partyName, i.ntn, i.cnic, i.label, i.billNo)).map(({ _c, ...rest }) => rest) } : {}),
  };
}

/** GET /accounting/cutoff : Receivable & payable as on a cut-off date. */
async function cutoff(req, { date, search, detail }) {
  const { companyId } = req.user;
  const { to } = await range(companyId, { dateTo: date });
  const needle = search ? String(search).trim().toLowerCase() : '';
  return {
    cutoffDate: to,
    receivable: await cutoffSide(companyId, 'SALES', to, { detail, needle }),
    payable: await cutoffSide(companyId, 'PURCHASE', to, { detail, needle }),
  };
}

module.exports = { balances, partyOpenItems, cutoff, openItems };
