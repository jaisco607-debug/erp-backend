// Receivable ageing and the credit follow-up (owner plan N-C2). Read only, except the follow-up notes (text: nothing is sent).
//
// For every customer: what is unpaid, by how many days past the due date, so the accountant knows whom to ask first.
//   - the unpaid part of every APPROVED sales invoice goes into a bucket by its due date: current (not due yet), 1-30, 31-60, 61-90, over 90 days past due
//     (the due date typed on the invoice, else invoice date + the customer's credit days: the same rule as the invoice itself)
//   - what the ledger says beyond the invoices (an advance the customer paid, an opening balance, a journal entry) is "other", with its sign: an advance is negative,
//     so the total of the row is always the ledger balance of the customer (the same figure as the party ledger and the credit limit warning)
//   - the credit limit is a warning, never a block (credit terms): "available credit" = limit - balance
//   - the total of all customers is compared with the receivable control account of the chart of accounts (the trial balance line)
// The unpaid part of an invoice is as of today; `asOf` only moves the day the age is counted from.
const AppError = require('../utils/AppError');
const { sequelize } = require('../models');
const audit = require('./auditService');
const accountService = require('./accountService');
const { _x } = require('./reportService');
const { today } = require('../utils/dates');

const { toCents } = accountService.internals;
const { q, col, section, respond, needAnyService } = _x;
const ROW_CAP = 5000;
const OVER_DAYS = 60; // a customer with something this many days past due is listed on top
const num = (c) => Number(c) / 100;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const bucketOf = (pastDue) => (pastDue <= 0 ? 'current' : pastDue <= 30 ? 'd1_30' : pastDue <= 60 ? 'd31_60' : pastDue <= 90 ? 'd61_90' : 'd90plus');
const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

/** The unpaid approved invoices of the company (or of one customer) with their due date. */
async function openInvoices(companyId, customerId) {
  return q(`SELECT i.id, i."customerId", i."invoiceNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."netAmount"::text AS net, i."receivedAmount"::text AS received,
      to_char(COALESCE(i."dueDate", i."invoiceDate" + COALESCE(c."creditDays", 0)), 'YYYY-MM-DD') AS "dueDate"
    FROM sales_invoices i JOIN customers c ON c.id = i."customerId" AND c."companyId" = :companyId
    WHERE i."companyId" = :companyId AND i.status = 'APPROVED' AND i."netAmount" > i."receivedAmount"${customerId ? ' AND i."customerId" = :customerId' : ''}
    ORDER BY i."invoiceDate", i."invoiceNo"`, { companyId, customerId });
}

async function report(req, f) {
  await needAnyService(req, ['ACC_REPORTS', 'ACC_SALES', 'ACC_RECEIPTS']);
  const { companyId } = req.user;
  const asOf = f.asOf || today();
  const [customers, balances, invoices, notes, control] = await Promise.all([
    q(`SELECT id, code, name, "creditLimit"::text AS "creditLimit", "creditDays" FROM customers WHERE "companyId" = :companyId AND "deletedAt" IS NULL${f.customerId ? ' AND id = :customerId' : ''}
       ORDER BY name`, { companyId, customerId: f.customerId }),
    q(`SELECT "partyId" AS id, COALESCE(SUM(debit - credit), 0)::text AS balance FROM journal_lines WHERE "companyId" = :companyId AND "partyType" = 'CUSTOMER' GROUP BY "partyId"`, { companyId }),
    openInvoices(companyId, f.customerId),
    q(`SELECT DISTINCT ON (n."customerId") n."customerId" AS id, to_char(n."date", 'YYYY-MM-DD') AS "date", n.note, to_char(n."promisedDate", 'YYYY-MM-DD') AS "promisedDate", n."promisedAmount"::float AS "promisedAmount",
         u.name AS "by", (SELECT count(*)::int FROM customer_follow_ups x WHERE x."customerId" = n."customerId" AND x."companyId" = :companyId) AS total
       FROM customer_follow_ups n LEFT JOIN users u ON u.id = n."createdById" WHERE n."companyId" = :companyId ORDER BY n."customerId", n."date" DESC, n."createdAt" DESC`, { companyId }),
    // the receivable control account of the chart of accounts: what the trial balance says customers owe
    q(`SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS balance FROM journal_lines l JOIN accounts a ON a.id = l."accountId" WHERE l."companyId" = :companyId AND a."controlType" = 'CUSTOMERS'`, { companyId }),
  ]);
  const balOf = new Map(balances.map((b) => [b.id, toCents(b.balance)]));
  const noteOf = new Map(notes.map((n) => [n.id, n]));
  const invOf = new Map();
  for (const i of invoices) { if (!invOf.has(i.customerId)) invOf.set(i.customerId, []); invOf.get(i.customerId).push(i); }

  let rows = [];
  for (const c of customers) {
    const mine = invOf.get(c.id) || [];
    const balance = balOf.get(c.id) || 0n;
    if (!mine.length && balance === 0n) continue; // nothing owed, nothing to chase
    const b = Object.fromEntries(BUCKETS.map((k) => [k, 0n]));
    let open = 0n;
    let maxPast = 0;
    for (const i of mine) {
      const out = toCents(i.net) - toCents(i.received);
      const past = days(i.dueDate, asOf);
      b[bucketOf(past)] += out;
      open += out;
      if (past > maxPast) maxPast = past;
    }
    const other = balance - open; // advances (negative), opening balance, journal entries: the ledger beyond the invoices
    const limit = c.creditLimit === null ? null : toCents(c.creditLimit);
    const overLimit = limit !== null && balance > limit;
    const reasons = [...(overLimit ? ['OVER_LIMIT'] : []), ...(maxPast > OVER_DAYS ? ['OVER_60_DAYS'] : [])];
    const n = noteOf.get(c.id);
    rows.push({
      customerId: c.id, code: c.code, name: c.name, creditLimit: limit === null ? null : num(limit), creditDays: c.creditDays,
      ...Object.fromEntries(BUCKETS.map((k) => [k, num(b[k])])), other: num(other), balance: num(balance),
      openInvoices: mine.length, oldestInvoiceDate: mine.length ? mine[0].invoiceDate : null, oldestInvoiceNo: mine.length ? mine[0].invoiceNo : null, maxDaysPastDue: maxPast,
      availableCredit: limit === null ? null : num(limit - balance), overLimit, attention: reasons.length > 0, attentionReasons: reasons,
      followUps: n ? n.total : 0, lastFollowUp: n ? { date: n.date, note: n.note, promisedDate: n.promisedDate, promisedAmount: n.promisedAmount, by: n.by } : null,
    });
  }
  if (f.search) { const s = f.search.toLowerCase(); rows = rows.filter((r) => r.name.toLowerCase().includes(s) || String(r.code) === s); }
  if (f.tab === 'attention') rows = rows.filter((r) => r.attention);
  // the customers to chase first: over the limit or past 60 days, then the biggest balance
  rows.sort((a, b) => Number(b.attention) - Number(a.attention) || b.balance - a.balance || a.name.localeCompare(b.name));
  if (rows.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', `The report has more than ${ROW_CAP} customers: choose one customer or a search`, { cap: ROW_CAP });

  const columns = [col('code', 'Code', 'number'), col('name', 'Customer'), col('current', 'Not due yet', 'money'), col('d1_30', '1-30 days', 'money'), col('d31_60', '31-60 days', 'money'), col('d61_90', '61-90 days', 'money'),
    col('d90plus', 'Over 90 days', 'money'), col('other', 'Advances / other', 'money'), col('balance', 'Balance', 'money'), col('creditLimit', 'Credit limit', 'money'), col('availableCredit', 'Available credit', 'money'),
    col('oldestInvoiceDate', 'Oldest invoice', 'date'), col('maxDaysPastDue', 'Days past due', 'number'), col('attentionText', 'Attention', 'tag'), col('followUps', 'Follow-ups', 'number')];
  const shown = rows.map((r) => ({ ...r, attentionText: r.attention ? r.attentionReasons.map((x) => (x === 'OVER_LIMIT' ? 'Over credit limit' : 'Over 60 days')).join(', ') : '' }));
  const sec = section('ageing', 'Receivable ageing', columns, shown, [...BUCKETS, 'other', 'balance']);
  sec.totals.customers = rows.length;
  sec.totals.attention = rows.filter((r) => r.attention).length;
  const ledgerTotal = rows.reduce((t, r) => t + Math.round(r.balance * 100), 0) / 100;
  const out = respond('Receivable ageing', { ...f, asOf }, [sec], f);
  out.asOf = asOf;
  out.buckets = BUCKETS;
  // the total of the customers' ledgers against the receivable account of the trial balance (only when the whole company is shown)
  out.reconciliation = f.customerId || f.search || f.tab ? null : { customersTotal: ledgerTotal, controlAccountBalance: num(toCents(control[0].balance)), difference: Math.round((ledgerTotal - num(toCents(control[0].balance))) * 100) / 100 };
  return out;
}

/** GET /reports/receivable-ageing/:customerId: the unpaid invoices of one customer with their age, and his follow-up notes (the drawer). */
async function detail(req, customerId) {
  await needAnyService(req, ['ACC_REPORTS', 'ACC_SALES', 'ACC_RECEIPTS']);
  const { companyId } = req.user;
  const asOf = today();
  const [c] = await q('SELECT id, code, name, "creditLimit"::text AS "creditLimit", "creditDays" FROM customers WHERE id = :customerId AND "companyId" = :companyId AND "deletedAt" IS NULL', { customerId, companyId });
  if (!c) throw AppError.notFound('Customer');
  const invoices = (await openInvoices(companyId, customerId)).map((i) => {
    const past = days(i.dueDate, asOf);
    return { invoiceId: i.id, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate, dueDate: i.dueDate, net: num(toCents(i.net)), received: num(toCents(i.received)), unpaid: num(toCents(i.net) - toCents(i.received)), daysPastDue: Math.max(0, past), bucket: bucketOf(past) };
  });
  const [bal] = await q('SELECT COALESCE(SUM(debit - credit), 0)::text AS balance FROM journal_lines WHERE "companyId" = :companyId AND "partyType" = \'CUSTOMER\' AND "partyId" = :customerId', { companyId, customerId });
  return {
    customer: { id: c.id, code: c.code, name: c.name, creditLimit: c.creditLimit === null ? null : Number(c.creditLimit), creditDays: c.creditDays }, asOf, balance: num(toCents(bal.balance)),
    invoices, followUps: await followUps(req, customerId),
  };
}

/* ---------------- the follow-up notes ---------------- */

async function followUps(req, customerId) {
  return (await q(`SELECT n.id, to_char(n."date", 'YYYY-MM-DD') AS "date", n.note, to_char(n."promisedDate", 'YYYY-MM-DD') AS "promisedDate", n."promisedAmount"::float AS "promisedAmount", u.name AS "by", n."createdAt"
    FROM customer_follow_ups n LEFT JOIN users u ON u.id = n."createdById" WHERE n."companyId" = :companyId AND n."customerId" = :customerId ORDER BY n."date" DESC, n."createdAt" DESC LIMIT 500`,
  { companyId: req.user.companyId, customerId })).map((n) => ({ ...n, createdAt: new Date(n.createdAt).toISOString() }));
}

async function listFollowUps(req, customerId) {
  const [c] = await q('SELECT id FROM customers WHERE id = :customerId AND "companyId" = :companyId', { customerId, companyId: req.user.companyId });
  if (!c) throw AppError.notFound('Customer');
  return { data: await followUps(req, customerId) };
}

/** Adds a note: text only, nothing is sent to the customer. */
async function addFollowUp(req, customerId, { date, note, promisedDate, promisedAmount }) {
  const { companyId } = req.user;
  const [c] = await q('SELECT id, name FROM customers WHERE id = :customerId AND "companyId" = :companyId AND "deletedAt" IS NULL', { customerId, companyId });
  if (!c) throw AppError.notFound('Customer');
  const day = date || today();
  if (promisedDate && promisedDate < day) throw AppError.rule('PROMISE_BEFORE_NOTE', 'The promised day cannot be before the day of the note', { field: 'promisedDate' });
  await sequelize.transaction(async (transaction) => {
    const [row] = await sequelize.query(`INSERT INTO customer_follow_ups ("companyId", "customerId", "date", note, "promisedDate", "promisedAmount", "createdById")
      VALUES (:companyId, :customerId, :day, :note, :promisedDate, :promisedAmount, :userId) RETURNING id`,
    { replacements: { companyId, customerId, day, note, promisedDate: promisedDate || null, promisedAmount: promisedAmount ?? null, userId: req.user.id }, type: 'SELECT', transaction });
    await audit.log(req, { action: 'CUSTOMER_FOLLOW_UP_ADDED', entityType: 'Customer', entityId: customerId, after: { id: row.id, date: day, note, promisedDate: promisedDate || null, promisedAmount: promisedAmount ?? null, customer: c.name } }, { transaction });
  });
  return listFollowUps(req, customerId);
}

module.exports = { report, detail, listFollowUps, addFollowUp };
