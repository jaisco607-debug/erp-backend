// Receipt Voucher (accounting chunk 4, owner 2026-10-29): money received from a CUSTOMER into a bank or cash account.
// A voucher settles customer invoices (approved sales invoices) and / or is an advance (money received before an invoice). The customer may
// withhold income tax: he pays the cheque (net) and the tax he withheld counts as paid on the invoice. For every line:
//   cheque amount (typed) + income tax = bill amount (what the invoice is settled by).   income tax = cheque x rate / (100 - rate)
//   DRAFT      saved; may be changed or deleted; no accounting entry; the invoices are not touched
//   CONFIRMED  posted:  Debit Bank or Cash (cheques)  /  Debit Income Tax - Customers (withheld)
//                       Credit Accounts Receivable (each invoice, customer named)  /  Credit Customer Advances (each advance)
//              and every invoice's "received" grows by the bill amount
//   un-confirm ("move to draft") posts the reverse entry, the invoices' "received" goes back, the voucher is a draft again
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, INCOME_TAX_RATES, label, q, lock, amountCents, num, rateBp, taxOnNet, ageDays, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'RECEIPT_VOUCHER';
const KIND_TEXT = { BILL: 'Invoice', ADVANCE: 'Advance' };
const invLabel = (n) => String(n).padStart(5, '0');

async function options(req) {
  return {
    modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })),
    depositAccounts: await support.bankAndCashAccounts(req.user.companyId), incomeTaxRates: INCOME_TAX_RATES,
  };
}

/** GET /receipt-vouchers/invoices?customerId= : the approved sales invoices of the customer that still have something to receive. */
async function invoices(req, { customerId, search, limit }) {
  const rows = await q(`SELECT i.id, i."invoiceNo", i."voucherNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."netAmount"::text AS net, i."receivedAmount"::text AS received, i."invoiceDetails"
    FROM sales_invoices i WHERE i."companyId" = :companyId AND i."customerId" = :customerId AND i.status = 'APPROVED' AND i."netAmount" > i."receivedAmount" ORDER BY i."invoiceDate", i."invoiceNo"`,
  { companyId: req.user.companyId, customerId });
  let data = rows.map((r) => ({
    salesInvoiceId: r.id, invoiceNo: r.invoiceNo, invoiceLabel: invLabel(r.invoiceNo), voucherNo: r.voucherNo, voucherLabel: invLabel(r.voucherNo), invoiceDate: r.invoiceDate, invoiceDetails: r.invoiceDetails,
    net: num(toCents(r.net)), received: num(toCents(r.received)), balance: num(toCents(r.net) - toCents(r.received)), ageDays: ageDays(r.invoiceDate),
  }));
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((b) => String(b.invoiceNo) === s || String(b.voucherNo) === s || (b.invoiceDetails || '').toLowerCase().includes(s));
  }
  return { data: data.slice(0, limit), total: data.length };
}

/** The lines of the voucher, checked against the invoices as they are now. Returns { lines, grandTotal, tax, net } in cents. */
async function buildLines(req, customerId, input, transaction) {
  const ids = [...new Set(input.filter((l) => l.salesInvoiceId).map((l) => l.salesInvoiceId))];
  if (ids.length !== input.filter((l) => l.salesInvoiceId).length) throw AppError.rule('DUPLICATE_INVOICE', 'An invoice is on the voucher twice; give one line per invoice');
  const found = ids.length ? await q(`SELECT i.id, i."invoiceNo", i.status, i."customerId", i."netAmount"::text AS net, i."receivedAmount"::text AS received FROM sales_invoices i WHERE i."companyId" = :companyId AND i.id IN (:ids)`,
    { companyId: req.user.companyId, ids }, transaction) : [];
  if (found.length !== ids.length) throw AppError.notFound('Sales invoice');
  const lines = input.map((l, i) => {
    const where = `Line ${i + 1}`;
    const cheque = amountCents(l.chequeAmount, where);
    const rate = Number(l.incomeTaxRate || 0);
    if (!(rate >= 0 && rate < 100)) throw AppError.rule('BAD_RATE', `${where}: the income tax rate must be from 0 up to 99.99`);
    const tax = taxOnNet(cheque, rateBp(rate));
    const bill = cheque + tax;
    const base = { rate, cheque, tax, bill, notes: l.notes || null };
    if (!l.salesInvoiceId) return { ...base, kind: 'ADVANCE', salesInvoiceId: null };
    const inv = found.find((x) => x.id === l.salesInvoiceId);
    const name = `Sales invoice ${invLabel(inv.invoiceNo)}`;
    if (inv.customerId !== customerId) throw AppError.rule('INVOICE_OTHER_CUSTOMER', `${where}: ${name} belongs to another customer`);
    if (inv.status !== 'APPROVED') throw AppError.rule('INVOICE_NOT_APPROVED', `${where}: ${name} is not approved yet`);
    const balance = toCents(inv.net) - toCents(inv.received);
    if (bill > balance) throw AppError.rule('MORE_THAN_BALANCE', `${where}: ${name} has only ${fromCents(balance)} left to receive (this line settles ${fromCents(bill)})`, { salesInvoiceId: inv.id, balance: num(balance), amount: num(bill) });
    return { ...base, kind: 'BILL', salesInvoiceId: inv.id, invoice: inv };
  });
  return {
    lines, grandTotal: lines.reduce((t, l) => t + l.bill, 0n), tax: lines.reduce((t, l) => t + l.tax, 0n), net: lines.reduce((t, l) => t + l.cheque, 0n),
  };
}

async function writeLines(voucherId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM receipt_voucher_lines WHERE "voucherId" = :voucherId', { replacements: { voucherId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO receipt_voucher_lines ("voucherId", "companyId", "lineNo", kind, "salesInvoiceId", "chequeAmount", "incomeTaxRate", "incomeTaxAmount", "billAmount", notes)
      VALUES (:voucherId, :companyId, :lineNo, :kind, :salesInvoiceId, :cheque, :rate, :tax, :bill, :notes)`,
    { replacements: { voucherId, companyId, lineNo, kind: l.kind, salesInvoiceId: l.salesInvoiceId, cheque: fromCents(l.cheque), rate: l.rate, tax: fromCents(l.tax), bill: fromCents(l.bill), notes: l.notes }, transaction });
  }
}

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v.notes,
  v."grandTotal"::float AS "grandTotal", v."incomeTaxAmount"::float AS "incomeTax", v."netAmount"::float AS net, v.status, v."confirmedAt", v."createdAt", v."updatedAt",
  c.id AS "customerId", c.code AS "customerCode", c.name AS "customerName", c.ntn AS "customerNtn",
  a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType",
  (SELECT string_agg(DISTINCT l.kind, ',') FROM receipt_voucher_lines l WHERE l."voucherId" = v.id) AS kinds, cb.name AS "confirmedByName"`;
const FROM = `FROM receipt_vouchers v JOIN customers c ON c.id = v."customerId" JOIN accounts a ON a.id = v."depositAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

function voucherJson(r) {
  const kinds = ['BILL', 'ADVANCE'].filter((k) => (r.kinds || '').split(',').includes(k));
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate,
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName, ntn: r.customerNtn },
    depositInto: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, notes: r.notes,
    grandTotal: r.grandTotal, incomeTax: r.incomeTax, net: r.net,
    typeText: kinds.map((k) => KIND_TEXT[k]).join(' + '), status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Receipt voucher');
  return r;
}

async function get(req, id, transaction) {
  const v = voucherJson(await load(req, id, transaction));
  const lines = await q(`SELECT l."lineNo", l.kind, l."salesInvoiceId", l."chequeAmount"::text AS cheque, l."incomeTaxRate"::float AS rate, l."incomeTaxAmount"::text AS tax, l."billAmount"::text AS bill, l.notes,
      i."invoiceNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."netAmount"::text AS "invoiceNet", i."receivedAmount"::text AS "invoiceReceived"
    FROM receipt_voucher_lines l LEFT JOIN sales_invoices i ON i.id = l."salesInvoiceId" WHERE l."voucherId" = :id ORDER BY l."lineNo"`, { id }, transaction);
  v.lines = lines.map((l) => ({
    lineNo: l.lineNo, kind: l.kind, kindText: KIND_TEXT[l.kind], salesInvoiceId: l.salesInvoiceId, invoiceNo: l.invoiceNo, invoiceLabel: l.invoiceNo ? invLabel(l.invoiceNo) : null, invoiceDate: l.invoiceDate,
    invoiceNet: l.invoiceNet ? num(toCents(l.invoiceNet)) : null, invoiceBalance: l.invoiceNet ? num(toCents(l.invoiceNet) - toCents(l.invoiceReceived)) : null,
    chequeAmount: num(toCents(l.cheque)), incomeTaxRate: l.rate, incomeTax: num(toCents(l.tax)), billAmount: num(toCents(l.bill)), notes: l.notes,
  }));
  return v;
}

async function list(req, { page, limit, status, dateFrom, dateTo, customerId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (customerId) { where.push('v."customerId" = :customerId'); r.customerId = customerId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(c.name ILIKE :like OR a.name ILIKE :like OR v."chequeNo" ILIKE :like OR v.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v."grandTotal"), 0)::text AS total, COALESCE(SUM(v."incomeTaxAmount"), 0)::text AS tax, COALESCE(SUM(v."netAmount"), 0)::text AS net
    FROM receipt_vouchers v JOIN customers c ON c.id = v."customerId" JOIN accounts a ON a.id = v."depositAccountId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map(voucherJson), page, limit, total: sum.vouchers,
    summary: { vouchers: sum.vouchers, invoiceAmount: num(toCents(sum.total)), withholding: num(toCents(sum.tax)), netReceived: num(toCents(sum.net)) },
  };
}

async function customerOr404(req, customerId, transaction) {
  const [c] = await q('SELECT id, name FROM customers WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id: customerId, companyId: req.user.companyId }, transaction);
  if (!c) throw AppError.notFound('Customer');
  return c;
}

async function ensureAccounts(req, built, transaction) {
  if (built.lines.some((l) => l.kind === 'BILL')) await accounts.ensureDefault(req, 'CUSTOMERS', transaction);
  if (built.lines.some((l) => l.kind === 'ADVANCE')) await accounts.ensureDefault(req, 'CUSTOMER_ADVANCES', transaction);
  if (built.tax > 0n) await accounts.ensureDefault(req, 'INCOME_TAX_CUSTOMERS', transaction);
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock('sales', companyId, transaction);
    await customerOr404(req, data.customerId, transaction);
    await bankOrCash(companyId, data.depositAccountId, transaction);
    const built = await buildLines(req, data.customerId, data.lines, transaction);
    const voucherNo = await nextNo('receipt_vouchers', companyId, transaction);
    await ensureAccounts(req, built, transaction);
    const [{ id: newId }] = await q(`INSERT INTO receipt_vouchers ("companyId", "voucherNo", "voucherDate", "customerId", "depositAccountId", "paymentMode", "chequeDate", "chequeNo", notes,
        "grandTotal", "incomeTaxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :customerId, :depositAccountId, :paymentMode, :chequeDate, :chequeNo, :notes, :grand, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), customerId: data.customerId, depositAccountId: data.depositAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null,
      chequeNo: data.chequeNo || null, notes: data.notes || null, grand: fromCents(built.grandTotal), tax: fromCents(built.tax), net: fromCents(built.net), userId: req.user.id }, transaction);
    await writeLines(newId, companyId, built.lines, transaction);
    await audit.log(req, { action: 'RECEIPT_VOUCHER_CREATED', entityType: 'ReceiptVoucher', entityId: newId, after: { voucherNo, customerId: data.customerId, grandTotal: num(built.grandTotal), incomeTax: num(built.tax), net: num(built.net), lines: built.lines.length } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('sales', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be changed. Move it to draft first');
    const customerId = changes.customerId ?? cur.customerId;
    if (changes.customerId && changes.customerId !== cur.customerId) {
      await customerOr404(req, customerId, transaction);
      if (!changes.lines) throw AppError.rule('LINES_REQUIRED', 'The customer changed: enter the lines again');
    }
    const accountId = changes.depositAccountId ?? cur.accountId;
    if (changes.depositAccountId) await bankOrCash(companyId, accountId, transaction);
    const input = changes.lines || (await q(`SELECT "salesInvoiceId", "chequeAmount"::text AS "chequeAmount", "incomeTaxRate"::float AS "incomeTaxRate", notes FROM receipt_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"`, { id }, transaction));
    const built = await buildLines(req, customerId, input, transaction);
    await ensureAccounts(req, built, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query(`UPDATE receipt_vouchers SET "voucherDate" = :voucherDate, "customerId" = :customerId, "depositAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo,
        notes = :notes, "grandTotal" = :grand, "incomeTaxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, customerId, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      notes: pick('notes', cur.notes), grand: fromCents(built.grandTotal), tax: fromCents(built.tax), net: fromCents(built.net), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'RECEIPT_VOUCHER_UPDATED', entityType: 'ReceiptVoucher', entityId: id, before: { grandTotal: cur.grandTotal, incomeTax: cur.incomeTax, net: cur.net }, after: { grandTotal: num(built.grandTotal), incomeTax: num(built.tax), net: num(built.net), lines: built.lines.length } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock('sales', req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM receipt_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'RECEIPT_VOUCHER_DELETED', entityType: 'ReceiptVoucher', entityId: id, before: { voucherNo: cur.voucherNo, grandTotal: cur.grandTotal, net: cur.net } }, { transaction });
  });
}

async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('sales', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const input = await q(`SELECT "salesInvoiceId", "chequeAmount"::text AS "chequeAmount", "incomeTaxRate"::float AS "incomeTaxRate", notes FROM receipt_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"`, { id }, transaction);
    if (!input.length) throw AppError.rule('NO_LINES', 'The voucher has no lines');
    await customerOr404(req, cur.customerId, transaction);
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const built = await buildLines(req, cur.customerId, input, transaction);
    if (built.grandTotal <= 0n) throw AppError.rule('NOTHING_TO_RECEIVE', 'The voucher amount is zero');
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query('UPDATE receipt_vouchers SET "grandTotal" = :grand, "incomeTaxAmount" = :tax, "netAmount" = :net WHERE id = :id', { replacements: { id, grand: fromCents(built.grandTotal), tax: fromCents(built.tax), net: fromCents(built.net) }, transaction });

    const receivable = built.lines.some((l) => l.kind === 'BILL') ? await accounts.ensureDefault(req, 'CUSTOMERS', transaction) : null;
    const advance = built.lines.some((l) => l.kind === 'ADVANCE') ? await accounts.ensureDefault(req, 'CUSTOMER_ADVANCES', transaction) : null;
    const taxAccount = built.tax > 0n ? await accounts.ensureDefault(req, 'INCOME_TAX_CUSTOMERS', transaction) : null;
    const narration = `Receipt voucher ${label(cur.voucherNo)} - ${cur.customerName}${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: bank.id, debit: num(built.net), narration },
        ...(taxAccount ? [{ accountId: taxAccount, debit: num(built.tax), narration: `${narration}: income tax withheld` }] : []),
        ...built.lines.map((l) => (l.kind === 'BILL'
          ? { accountId: receivable, credit: num(l.bill), partyType: 'CUSTOMER', partyId: cur.customerId, narration: `${narration}: invoice ${invLabel(l.invoice.invoiceNo)}` }
          : { accountId: advance, credit: num(l.bill), partyType: 'CUSTOMER', partyId: cur.customerId, narration: `${narration}: advance` })),
      ],
    }, transaction);
    for (const l of built.lines.filter((x) => x.kind === 'BILL')) {
      await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = "receivedAmount" + :amount, "updatedAt" = now() WHERE id = :invoice AND "companyId" = :companyId',
        { replacements: { amount: fromCents(l.bill), invoice: l.salesInvoiceId, companyId }, transaction });
    }
    await sequelize.query(`UPDATE receipt_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'RECEIPT_VOUCHER_CONFIRMED', entityType: 'ReceiptVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, grandTotal: num(built.grandTotal), incomeTax: num(built.tax), net: num(built.net) } }, { transaction });
  });
  return get(req, id);
}

async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('sales', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `receipt voucher ${label(cur.voucherNo)} moved to draft` }, transaction); // dated like the entry it reverses
    const billLines = await q(`SELECT "salesInvoiceId", "billAmount"::text AS amount FROM receipt_voucher_lines WHERE "voucherId" = :id AND kind = 'BILL'`, { id }, transaction);
    for (const l of billLines) {
      await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = "receivedAmount" - :amount, "updatedAt" = now() WHERE id = :invoice AND "companyId" = :companyId', { replacements: { amount: l.amount, invoice: l.salesInvoiceId, companyId }, transaction });
    }
    await sequelize.query(`UPDATE receipt_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'RECEIPT_VOUCHER_UNCONFIRMED', entityType: 'ReceiptVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, invoices, list, get, create, update, remove, confirm, unconfirm, accountsEntry };
