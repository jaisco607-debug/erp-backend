// The Accounting Overview screen in ONE call. Every block is checked on its own against the person's services: a block the person may not see is
// null (a normal answer, never 403 / 404) and the others are still returned. Everything is relative to today (Pakistan time).
//   ACC_SALES        today.sales, recentSales          ACC_PURCHASES   today.purchases, recentPurchases
//   ACC_RECEIPTS     today.received, receipt vouchers  ACC_PAYMENTS    today.paid, payment vouchers       ACC_JOURNAL   journal vouchers
//   ACC_COA          cashBank
//   ACC_REPORTS      partyBalances, topReceivables, topPayables, profit, books, months
//   CHEMICAL_STORE / GENERAL_STORE   stock (the stores the person may see added up)
// The numbers are the ones of the existing screens: profit and books call the Profit & Loss and Balance Sheet reports themselves; the party totals follow
// GET /accounting/balances (what each customer / vendor owes on the ledger, a party on the other side is not counted); months is the Profit & Loss by month.
// Aggregated queries run side by side; money is returned as strings with 2 decimals.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { today } = require('../utils/dates');
const accountService = require('./accountService');
const { companyServices, userServices } = require('./accessService');
const { profitLoss, balanceSheet } = require('./financialStatementService');
const { monthsBack } = require('./storeOverviewService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const pad5 = (n) => String(n).padStart(5, '0');
const STORE_OF = { CHEMICAL_STORE: 'CHEMICAL', GENERAL_STORE: 'GENERAL' };
const MONTHS = 6;

/** The service codes the person may use (any access): a client admin has every service of the company. */
async function allowedCodes(req) {
  const have = (await companyServices(req.user.companyId)).map((s) => s.code);
  if (req.user.userType === 'CLIENT_ADMIN') return new Set(have);
  const own = new Set((await userServices(req.user)).map((g) => g.service.code));
  return new Set(have.filter((c) => own.has(c)));
}

/** Approved invoices dated today: the sum of net and the number. */
const todayInvoices = async (table, c, asOf) => {
  const [r] = await q(`SELECT round(COALESCE(SUM("netAmount"), 0), 2)::text AS net, count(*)::int AS count FROM ${table} WHERE "companyId" = :c AND status = 'APPROVED' AND "invoiceDate" = :asOf`, { c, asOf });
  return r;
};
/** Confirmed vouchers dated today: the net money and the number. */
const todayVouchers = async (table, c, asOf) => {
  const [r] = await q(`SELECT round(COALESCE(SUM("netAmount"), 0), 2)::text AS net, count(*)::int AS count FROM ${table} WHERE "companyId" = :c AND status = 'CONFIRMED' AND "voucherDate" = :asOf`, { c, asOf });
  return r;
};

async function cashBank(c, asOf) {
  const rows = await q(`SELECT a."controlType" AS t, SUM(x.net)::text AS net FROM accounts a
    JOIN (SELECT l."accountId", SUM(l.debit - l.credit) AS net FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" WHERE l."companyId" = :c AND e."entryDate" <= :asOf GROUP BY l."accountId") x ON x."accountId" = a.id
    WHERE a."companyId" = :c AND a."controlType" IN ('CASH', 'BANK') AND NOT a."isGroup" GROUP BY a."controlType"`, { c, asOf });
  const of = (t) => toCents((rows.find((r) => r.t === t) || { net: '0' }).net);
  return { cash: fromCents(of('CASH')), bank: fromCents(of('BANK')), total: fromCents(of('CASH') + of('BANK')) };
}

/** One side of the party balances: the total owed and the 5 biggest, from the ledger up to today (a party on the other side is left out, as in the balances report). */
async function partySide(c, asOf, partyType) {
  const customer = partyType === 'CUSTOMER';
  const rows = await q(`SELECT t."partyId" AS id, p.name, round(t.bal, 2)::text AS balance, round(SUM(t.bal) OVER (), 2)::text AS total
    FROM (SELECT l."partyId", SUM(l.debit - l.credit) * ${customer ? 1 : -1} AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId"
          WHERE l."companyId" = :c AND l."partyType" = :partyType AND e."entryDate" <= :asOf GROUP BY l."partyId" HAVING SUM(l.debit - l.credit) * ${customer ? 1 : -1} > 0) t
    JOIN ${customer ? 'customers' : 'vendors'} p ON p.id = t."partyId" ORDER BY t.bal DESC, p.name LIMIT 5`, { c, asOf, partyType });
  return { total: rows.length ? rows[0].total : '0.00', top: rows.map((r) => ({ partyId: r.id, name: r.name, balance: r.balance })) };
}

async function stockBlock(c, stores) {
  const [r] = await q(`SELECT round(COALESCE(SUM("stockValue"), 0), 2)::text AS value,
      count(*) FILTER (WHERE "isActive" AND ("stockQty" <= 0 OR ("reorderLevel" IS NOT NULL AND "stockQty" <= "reorderLevel")))::int AS "lowCount"
    FROM store_items WHERE "companyId" = :c AND store IN (:stores)`, { c, stores });
  return { value: r.value, lowCount: r.lowCount };
}

/** Revenue and expenses (expenses + cost of sales) of each of the last months, the way the Profit & Loss report adds them up; the opening balances entry is not a movement. */
async function monthsBlock(c, asOf) {
  const list = monthsBack(asOf, MONTHS);
  const rows = await q(`SELECT to_char(e."entryDate", 'YYYY-MM') AS month,
      round(COALESCE(SUM(l.credit - l.debit) FILTER (WHERE a."accountType" = 'INCOME'), 0), 2)::text AS revenue,
      round(COALESCE(SUM(l.debit - l.credit) FILTER (WHERE a."accountType" = 'EXPENSE'), 0), 2)::text AS expenses
    FROM journal_lines l JOIN journal_entries e ON e.id = l."entryId" JOIN accounts a ON a.id = l."accountId"
    WHERE l."companyId" = :c AND e."sourceType" <> 'OPENING' AND e."entryDate" >= :from AND e."entryDate" <= :asOf AND a."accountType" IN ('INCOME', 'EXPENSE') GROUP BY month`, { c, asOf, from: `${list[0]}-01` });
  return list.map((month) => {
    const r = rows.find((x) => x.month === month);
    return { month, revenue: r ? r.revenue : '0.00', expenses: r ? r.expenses : '0.00' };
  });
}

const VOUCHER_TABLE = { payment: 'payment_vouchers', receipt: 'receipt_vouchers', journal: 'journal_vouchers' };

/** Counts of ALL vouchers (any date) of the kinds the person may see. */
async function voucherCounts(c, kinds) {
  const rows = await q(kinds.map((k) => `SELECT '${k}' AS kind, status, count(*)::int AS n FROM ${VOUCHER_TABLE[k]} WHERE "companyId" = :c GROUP BY status`).join(' UNION ALL '), { c });
  const sum = (status) => rows.filter((r) => r.status === status).reduce((t, r) => t + r.n, 0);
  const byKind = Object.fromEntries(Object.keys(VOUCHER_TABLE).map((k) => [k, kinds.includes(k) ? rows.filter((r) => r.kind === k).reduce((t, r) => t + r.n, 0) : null]));
  return { confirmed: sum('CONFIRMED'), draft: sum('DRAFT'), byKind };
}

/** The latest 6 vouchers across the kinds the person may see. */
async function recentVouchers(c, kinds) {
  const parts = {
    payment: `SELECT 'payment' AS kind, v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", p.name AS title, v."netAmount" AS amount, v.status, v."createdAt"
      FROM payment_vouchers v JOIN vendors p ON p.id = v."vendorId" WHERE v."companyId" = :c ORDER BY v."voucherDate" DESC, v."createdAt" DESC LIMIT 6`,
    receipt: `SELECT 'receipt', v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", p.name, v."netAmount", v.status, v."createdAt"
      FROM receipt_vouchers v JOIN customers p ON p.id = v."customerId" WHERE v."companyId" = :c ORDER BY v."voucherDate" DESC, v."createdAt" DESC LIMIT 6`,
    journal: `SELECT 'journal', v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", COALESCE(NULLIF(v.narration, ''), NULLIF(v.reference, ''), ''), v."totalAmount", v.status, v."createdAt"
      FROM journal_vouchers v WHERE v."companyId" = :c ORDER BY v."voucherDate" DESC, v."createdAt" DESC LIMIT 6`,
  };
  const rows = await q(`SELECT * FROM (${kinds.map((k) => `(${parts[k]})`).join(' UNION ALL ')}) u ORDER BY u."voucherDate" DESC, u."createdAt" DESC LIMIT 6`, { c });
  return rows.map((r) => ({
    kind: r.kind, id: r.id, label: pad5(r.voucherNo), date: r.voucherDate,
    title: r.title, amount: fromCents(toCents(r.amount)), status: r.status,
  }));
}

/** The latest 5 invoices (any status), newest first. */
async function recentInvoices(c, kind) {
  const sales = kind === 'sales';
  const rows = await q(`SELECT i.id, p.name, i."${sales ? 'invoiceNo' : 'voucherNo'}" AS no, to_char(i."invoiceDate", 'YYYY-MM-DD') AS date, i."netAmount"::text AS net, (i."netAmount" - i."${sales ? 'receivedAmount' : 'paidAmount'}")::text AS balance,
      i.status, CASE WHEN i.status <> 'APPROVED' THEN NULL WHEN i."${sales ? 'receivedAmount' : 'paidAmount'}" <= 0 THEN 'UNPAID' WHEN i."${sales ? 'receivedAmount' : 'paidAmount'}" >= i."netAmount" THEN 'PAID' ELSE 'PARTIAL' END AS "paymentStatus"
    FROM ${sales ? 'sales_invoices' : 'purchase_invoices'} i JOIN ${sales ? 'customers' : 'vendors'} p ON p.id = i."${sales ? 'customerId' : 'vendorId'}"
    WHERE i."companyId" = :c ORDER BY i."invoiceDate" DESC, i."${sales ? 'invoiceNo' : 'voucherNo'}" DESC LIMIT 5`, { c });
  return rows.map((r) => ({ id: r.id, name: r.name, ref: `${sales ? 'Invoice' : 'Voucher'} ${pad5(r.no)}`, date: r.date, net: fromCents(toCents(r.net)), balance: fromCents(toCents(r.balance)), status: r.status, paymentStatus: r.paymentStatus }));
}

async function overview(req) {
  const asOf = today();
  const c = req.user.companyId;
  const empty = { asOf, today: { sales: null, purchases: null, received: null, paid: null }, cashBank: null, partyBalances: null, stock: null, profit: null, books: null, months: null, vouchers: null,
    topReceivables: null, topPayables: null, recentSales: null, recentPurchases: null, recentVouchers: null };
  if (!c) return empty;
  const can = await allowedCodes(req);
  const has = (code) => can.has(code);
  const reports = has('ACC_REPORTS');
  const stores = Object.entries(STORE_OF).filter(([code]) => has(code)).map(([, store]) => store);
  const kinds = [['payment', 'ACC_PAYMENTS'], ['receipt', 'ACC_RECEIPTS'], ['journal', 'ACC_JOURNAL']].filter(([, code]) => has(code)).map(([k]) => k);
  const when = (ok, fn) => (ok ? fn() : Promise.resolve(null));

  const [sales, purchases, received, paid, cash, receivables, payables, stock, pl, bs, months, vouchers, recentV, recentS, recentP] = await Promise.all([
    when(has('ACC_SALES'), () => todayInvoices('sales_invoices', c, asOf)),
    when(has('ACC_PURCHASES'), () => todayInvoices('purchase_invoices', c, asOf)),
    when(has('ACC_RECEIPTS'), () => todayVouchers('receipt_vouchers', c, asOf)),
    when(has('ACC_PAYMENTS'), () => todayVouchers('payment_vouchers', c, asOf)),
    when(has('ACC_COA'), () => cashBank(c, asOf)),
    when(reports, () => partySide(c, asOf, 'CUSTOMER')),
    when(reports, () => partySide(c, asOf, 'VENDOR')),
    when(stores.length > 0, () => stockBlock(c, stores)),
    when(reports, () => profitLoss(req, {})),
    when(reports, () => balanceSheet(req, {})),
    when(reports, () => monthsBlock(c, asOf)),
    when(kinds.length > 0, () => voucherCounts(c, kinds)),
    when(kinds.length > 0, () => recentVouchers(c, kinds)),
    when(has('ACC_SALES'), () => recentInvoices(c, 'sales')),
    when(has('ACC_PURCHASES'), () => recentInvoices(c, 'purchase')),
  ]);

  return {
    asOf,
    today: { sales, purchases, received, paid },
    cashBank: cash,
    partyBalances: reports ? { receivable: receivables.total, payable: payables.total } : null,
    stock,
    profit: pl ? { result: pl.netProfit.result || 'PROFIT', amount: pl.netProfit.amount, revenue: pl.revenue.total } : null,
    books: bs ? { balanced: bs.balanced, difference: bs.difference } : null,
    months,
    vouchers,
    topReceivables: reports ? receivables.top : null,
    topPayables: reports ? payables.top : null,
    recentSales: recentS,
    recentPurchases: recentP,
    recentVouchers: recentV,
  };
}

module.exports = { overview };
