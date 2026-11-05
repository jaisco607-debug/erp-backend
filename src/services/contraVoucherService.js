// Contra voucher (owner 2026-10-28): a customer's money applied straight to a supplier's bill; no cash or bank account moves.
// "Customer A owes us 200,000 and we owe Supplier B 200,000: A pays B directly." The voucher has ONE amount; it is applied to invoices of the customer
// and, for the same amount, to bills of the vendor. If one side owes more than the other, the amount is the smaller one: only that much is settled
// on both sides, the rest stays open.
//   DRAFT      saved; may be changed or deleted; no accounting entry; the invoices and bills are not touched
//   CONFIRMED  posted:  Debit Accounts Payable (vendor named)  /  Credit Accounts Receivable (customer named)
//              and the "received" of every invoice and the "paid" of every bill grow by the applied amount
//   un-confirm ("move to draft") posts the reverse entry and gives the invoices and bills their amounts back
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { today } = require('../utils/dates');

const { STATUS_TEXT, label, q, lock, amountCents, num, ageDays, nextNo, toCents, fromCents } = support;
const SOURCE = 'CONTRA_VOUCHER';

// the two sides: the invoices of the customer (money we are owed) and the bills of the vendor (money we owe)
const SIDES = {
  INVOICE: {
    table: 'sales_invoices', idKey: 'salesInvoiceId', party: '"customerId"', settled: '"receivedAmount"', noun: 'Sales invoice', other: 'INVOICE_OTHER_CUSTOMER', notApproved: 'INVOICE_NOT_APPROVED', dup: 'DUPLICATE_INVOICE',
    no: 'invoiceNo', extra: 'NULL',
  },
  BILL: {
    table: 'purchase_invoices', idKey: 'purchaseInvoiceId', party: '"vendorId"', settled: '"paidAmount"', noun: 'Purchase invoice', other: 'BILL_OTHER_VENDOR', notApproved: 'BILL_NOT_APPROVED', dup: 'DUPLICATE_BILL',
    no: 'voucherNo', extra: '"billNo"',
  },
};

/** The customers (with their unpaid invoices) and the vendors (with their unpaid bills) of the company: the two pickers of the screen. */
async function options(req) {
  const { companyId } = req.user;
  const customers = await q(`SELECT c.id, c.code, c.name, count(*)::int AS "openCount", SUM(i."netAmount" - i."receivedAmount")::text AS outstanding
    FROM sales_invoices i JOIN customers c ON c.id = i."customerId" WHERE i."companyId" = :companyId AND i.status = 'APPROVED' AND i."netAmount" > i."receivedAmount" GROUP BY c.id ORDER BY lower(c.name)`, { companyId });
  const vendors = await q(`SELECT v.id, v.code, v.name, count(*)::int AS "openCount", SUM(i."netAmount" - i."paidAmount")::text AS outstanding
    FROM purchase_invoices i JOIN vendors v ON v.id = i."vendorId" WHERE i."companyId" = :companyId AND i.status = 'APPROVED' AND i."netAmount" > i."paidAmount" GROUP BY v.id ORDER BY lower(v.name)`, { companyId });
  const clean = (rows) => rows.map((r) => ({ id: r.id, code: r.code, name: r.name, openCount: r.openCount, outstanding: num(toCents(r.outstanding)) }));
  return { statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), customers: clean(customers), vendors: clean(vendors) };
}

/** GET /contra-vouchers/invoices?customerId= : the approved sales invoices of the customer that still have something to receive. */
async function invoices(req, { customerId, search, limit }) {
  const rows = await q(`SELECT i.id, i."invoiceNo", i."voucherNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."invoiceDetails", i."netAmount"::text AS net, i."receivedAmount"::text AS received
    FROM sales_invoices i WHERE i."companyId" = :companyId AND i."customerId" = :customerId AND i.status = 'APPROVED' AND i."netAmount" > i."receivedAmount" ORDER BY i."invoiceDate", i."invoiceNo"`,
  { companyId: req.user.companyId, customerId });
  let data = rows.map((r) => ({
    salesInvoiceId: r.id, invoiceNo: r.invoiceNo, invoiceLabel: label(r.invoiceNo), invoiceDate: r.invoiceDate, invoiceDetails: r.invoiceDetails,
    net: num(toCents(r.net)), received: num(toCents(r.received)), balance: num(toCents(r.net) - toCents(r.received)), ageDays: ageDays(r.invoiceDate),
  }));
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((i) => String(i.invoiceNo) === s || (i.invoiceDetails || '').toLowerCase().includes(s));
  }
  return { data: data.slice(0, limit), total: data.length };
}

/** GET /contra-vouchers/bills?vendorId= : the approved purchase invoices of the vendor that still have something to pay. */
async function bills(req, { vendorId, search, limit }) {
  const rows = await q(`SELECT p.id, p."voucherNo", p."billNo", to_char(p."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", to_char(p."dueDate", 'YYYY-MM-DD') AS "dueDate",
      p."netAmount"::text AS net, p."paidAmount"::text AS paid, p."billDetails"
    FROM purchase_invoices p WHERE p."companyId" = :companyId AND p."vendorId" = :vendorId AND p.status = 'APPROVED' AND p."netAmount" > p."paidAmount" ORDER BY p."invoiceDate", p."voucherNo"`,
  { companyId: req.user.companyId, vendorId });
  let data = rows.map((r) => ({
    purchaseInvoiceId: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), billNo: r.billNo, invoiceDate: r.invoiceDate, dueDate: r.dueDate, billDetails: r.billDetails,
    net: num(toCents(r.net)), paid: num(toCents(r.paid)), balance: num(toCents(r.net) - toCents(r.paid)), ageDays: ageDays(r.invoiceDate),
  }));
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((b) => String(b.voucherNo) === s || (b.billNo || '').toLowerCase().includes(s) || (b.billDetails || '').toLowerCase().includes(s));
  }
  return { data: data.slice(0, limit), total: data.length };
}

/** One side of the voucher, checked against the documents as they are now. Returns { lines: [{ id, cents, doc }], total } in cents. */
async function buildSide(req, side, partyId, input, transaction) {
  const s = SIDES[side];
  const ids = input.map((l) => l[s.idKey]);
  if (new Set(ids).size !== ids.length) throw AppError.rule(s.dup, `A document is on the ${side === 'INVOICE' ? 'invoice' : 'bill'} table twice; give one line per document`);
  const found = ids.length ? await q(`SELECT id, "${s.no}" AS no, ${s.extra} AS "billNo", status, ${s.party} AS "partyId", "netAmount"::text AS net, ${s.settled}::text AS settled, to_char("invoiceDate", 'YYYY-MM-DD') AS "invoiceDate"
    FROM ${s.table} WHERE "companyId" = :companyId AND id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction) : [];
  if (found.length !== ids.length) throw AppError.notFound(s.noun);
  const lines = input.map((l, i) => {
    const where = `${side === 'INVOICE' ? 'Invoice' : 'Bill'} line ${i + 1}`;
    const cents = amountCents(l.amount, where);
    const d = found.find((x) => x.id === l[s.idKey]);
    const name = `${s.noun} ${label(d.no)}${d.billNo ? ` (bill ${d.billNo})` : ''}`;
    if (d.partyId !== partyId) throw AppError.rule(s.other, `${where}: ${name} belongs to another ${side === 'INVOICE' ? 'customer' : 'vendor'}`);
    if (d.status !== 'APPROVED') throw AppError.rule(s.notApproved, `${where}: ${name} is not approved yet`);
    const balance = toCents(d.net) - toCents(d.settled);
    if (cents > balance) throw AppError.rule('MORE_THAN_BALANCE', `${where}: ${name} has only ${fromCents(balance)} left`, { [s.idKey]: d.id, balance: num(balance), amount: num(cents) });
    return { id: d.id, cents, doc: d };
  });
  return { lines, total: lines.reduce((t, l) => t + l.cents, 0n) };
}

/** Both sides, and the rule of the voucher: each side adds up to exactly the voucher amount. */
async function buildAll(req, { customerId, vendorId, amount, invoicesIn, billsIn }, transaction) {
  const cents = amountCents(amount, 'Contra amount');
  const inv = await buildSide(req, 'INVOICE', customerId, invoicesIn, transaction);
  const bill = await buildSide(req, 'BILL', vendorId, billsIn, transaction);
  if (inv.total !== cents || bill.total !== cents) {
    throw AppError.rule('TABLES_DO_NOT_MATCH', `Both tables must add up to exactly the contra amount (${fromCents(cents)}): the invoices add up to ${fromCents(inv.total)}, the bills to ${fromCents(bill.total)}`,
      { amount: num(cents), invoicesTotal: num(inv.total), billsTotal: num(bill.total) });
  }
  return { cents, inv, bill };
}

async function writeLines(voucherId, companyId, built, transaction) {
  await sequelize.query('DELETE FROM contra_voucher_lines WHERE "voucherId" = :voucherId', { replacements: { voucherId }, transaction });
  let lineNo = 0;
  for (const [side, rows] of [['INVOICE', built.inv.lines], ['BILL', built.bill.lines]]) {
    for (const l of rows) {
      lineNo += 1;
      await sequelize.query(`INSERT INTO contra_voucher_lines ("voucherId", "companyId", "lineNo", side, "salesInvoiceId", "purchaseInvoiceId", amount) VALUES (:voucherId, :companyId, :lineNo, :side, :sales, :purchase, :amount)`,
        { replacements: { voucherId, companyId, lineNo, side, sales: side === 'INVOICE' ? l.id : null, purchase: side === 'BILL' ? l.id : null, amount: fromCents(l.cents) }, transaction });
    }
  }
}

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v.amount::float AS amount, v.amount::text AS "amountText", v.reference, v.narration, v.status, v."confirmedAt", v."createdAt", v."updatedAt",
  c.id AS "customerId", c.code AS "customerCode", c.name AS "customerName", c.ntn AS "customerNtn", vd.id AS "vendorId", vd.code AS "vendorCode", vd.name AS "vendorName", vd.ntn AS "vendorNtn",
  cb.name AS "confirmedByName"`;
const FROM = `FROM contra_vouchers v JOIN customers c ON c.id = v."customerId" JOIN vendors vd ON vd.id = v."vendorId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

function voucherJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate,
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName, ntn: r.customerNtn },
    vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName, ntn: r.vendorNtn },
    amount: r.amount, reference: r.reference, narration: r.narration,
    status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Contra voucher');
  return r;
}

async function get(req, id, transaction) {
  const v = voucherJson(await load(req, id, transaction));
  const inv = await q(`SELECT l."lineNo", l."salesInvoiceId", l.amount::text AS amount, i."invoiceNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", i."netAmount"::text AS net, i."receivedAmount"::text AS received
    FROM contra_voucher_lines l JOIN sales_invoices i ON i.id = l."salesInvoiceId" WHERE l."voucherId" = :id AND l.side = 'INVOICE' ORDER BY l."lineNo"`, { id }, transaction);
  const bill = await q(`SELECT l."lineNo", l."purchaseInvoiceId", l.amount::text AS amount, p."voucherNo", p."billNo", to_char(p."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", p."netAmount"::text AS net, p."paidAmount"::text AS paid
    FROM contra_voucher_lines l JOIN purchase_invoices p ON p.id = l."purchaseInvoiceId" WHERE l."voucherId" = :id AND l.side = 'BILL' ORDER BY l."lineNo"`, { id }, transaction);
  v.invoices = inv.map((l) => ({
    lineNo: l.lineNo, salesInvoiceId: l.salesInvoiceId, invoiceNo: l.invoiceNo, invoiceLabel: label(l.invoiceNo), invoiceDate: l.invoiceDate,
    invoiceNet: num(toCents(l.net)), outstanding: num(toCents(l.net) - toCents(l.received)), amount: num(toCents(l.amount)),
  }));
  v.bills = bill.map((l) => ({
    lineNo: l.lineNo, purchaseInvoiceId: l.purchaseInvoiceId, billVoucherNo: l.voucherNo, billVoucherLabel: label(l.voucherNo), billNo: l.billNo, billDate: l.invoiceDate,
    billNet: num(toCents(l.net)), outstanding: num(toCents(l.net) - toCents(l.paid)), amount: num(toCents(l.amount)),
  }));
  v.appliedToInvoices = num(inv.reduce((t, l) => t + toCents(l.amount), 0n));
  v.appliedToBills = num(bill.reduce((t, l) => t + toCents(l.amount), 0n));
  return v;
}

async function list(req, { page, limit, status, dateFrom, dateTo, customerId, vendorId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (customerId) { where.push('v."customerId" = :customerId'); r.customerId = customerId; }
  if (vendorId) { where.push('v."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(c.name ILIKE :like OR vd.name ILIKE :like OR v.reference ILIKE :like OR v.narration ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v.amount), 0)::text AS total FROM contra_vouchers v JOIN customers c ON c.id = v."customerId" JOIN vendors vd ON vd.id = v."vendorId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(voucherJson), page, limit, total: sum.vouchers, summary: { vouchers: sum.vouchers, totalAmount: num(toCents(sum.total)) } };
}

async function partyOr404(req, table, id, noun, transaction) {
  const [p] = await q(`SELECT id, name FROM ${table} WHERE id = :id AND "companyId" = :companyId`, { id, companyId: req.user.companyId }, transaction);
  if (!p) throw AppError.notFound(noun);
  return p;
}

// a contra touches both the sales and the purchase side: always lock sales first, then purchases (one order everywhere, so two people never wait for each other)
async function lockBoth(companyId, transaction) {
  await lock('sales', companyId, transaction);
  await lock('purchases', companyId, transaction);
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lockBoth(companyId, transaction);
    await partyOr404(req, 'customers', data.customerId, 'Customer', transaction);
    await partyOr404(req, 'vendors', data.vendorId, 'Vendor', transaction);
    const built = await buildAll(req, { customerId: data.customerId, vendorId: data.vendorId, amount: data.amount, invoicesIn: data.invoices, billsIn: data.bills }, transaction);
    const voucherNo = await nextNo('contra_vouchers', companyId, transaction);
    // the accounts the voucher will post to exist from the first voucher on
    await accounts.ensureDefault(req, 'CUSTOMERS', transaction);
    await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const [{ id: newId }] = await q(`INSERT INTO contra_vouchers ("companyId", "voucherNo", "voucherDate", "customerId", "vendorId", amount, reference, narration, "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :customerId, :vendorId, :amount, :reference, :narration, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), customerId: data.customerId, vendorId: data.vendorId, amount: fromCents(built.cents), reference: data.reference || null, narration: data.narration || null, userId: req.user.id }, transaction);
    await writeLines(newId, companyId, built, transaction);
    await audit.log(req, { action: 'CONTRA_VOUCHER_CREATED', entityType: 'ContraVoucher', entityId: newId, after: { voucherNo, customerId: data.customerId, vendorId: data.vendorId, amount: num(built.cents), invoices: built.inv.lines.length, bills: built.bill.lines.length } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockBoth(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be changed. Move it to draft first');
    const customerId = changes.customerId ?? cur.customerId;
    const vendorId = changes.vendorId ?? cur.vendorId;
    if (changes.customerId && changes.customerId !== cur.customerId) await partyOr404(req, 'customers', customerId, 'Customer', transaction);
    if (changes.vendorId && changes.vendorId !== cur.vendorId) await partyOr404(req, 'vendors', vendorId, 'Vendor', transaction);
    if ((changes.customerId && changes.customerId !== cur.customerId && !changes.invoices) || (changes.vendorId && changes.vendorId !== cur.vendorId && !changes.bills)) {
      throw AppError.rule('LINES_REQUIRED', 'The customer or the vendor changed: enter its table again');
    }
    const stored = async (side) => q(`SELECT "${SIDES[side].idKey}", amount::text AS amount FROM contra_voucher_lines WHERE "voucherId" = :id AND side = :side ORDER BY "lineNo"`, { id, side }, transaction);
    const built = await buildAll(req, {
      customerId, vendorId, amount: changes.amount ?? cur.amountText, invoicesIn: changes.invoices || await stored('INVOICE'), billsIn: changes.bills || await stored('BILL'),
    }, transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await writeLines(id, companyId, built, transaction);
    await sequelize.query(`UPDATE contra_vouchers SET "voucherDate" = :voucherDate, "customerId" = :customerId, "vendorId" = :vendorId, amount = :amount, reference = :reference, narration = :narration,
        "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, customerId, vendorId, amount: fromCents(built.cents), reference: pick('reference', cur.reference), narration: pick('narration', cur.narration), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'CONTRA_VOUCHER_UPDATED', entityType: 'ContraVoucher', entityId: id, before: { amount: cur.amount }, after: { amount: num(built.cents), invoices: built.inv.lines.length, bills: built.bill.lines.length } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lockBoth(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM contra_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'CONTRA_VOUCHER_DELETED', entityType: 'ContraVoucher', entityId: id, before: { voucherNo: cur.voucherNo, amount: cur.amount } }, { transaction });
  });
}

/** Posts the entry and adds the applied amounts to the invoices and bills. Both tables are checked again against the documents as they are now. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockBoth(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const stored = async (side) => q(`SELECT "${SIDES[side].idKey}", amount::text AS amount FROM contra_voucher_lines WHERE "voucherId" = :id AND side = :side ORDER BY "lineNo"`, { id, side }, transaction);
    const invoicesIn = await stored('INVOICE');
    const billsIn = await stored('BILL');
    if (!invoicesIn.length || !billsIn.length) throw AppError.rule('NO_LINES', 'The voucher needs invoices and bills');
    await partyOr404(req, 'customers', cur.customerId, 'Customer', transaction);
    await partyOr404(req, 'vendors', cur.vendorId, 'Vendor', transaction);
    const built = await buildAll(req, { customerId: cur.customerId, vendorId: cur.vendorId, amount: cur.amountText, invoicesIn, billsIn }, transaction);

    const receivable = await accounts.ensureDefault(req, 'CUSTOMERS', transaction);
    const payable = await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const narration = `Contra voucher ${label(cur.voucherNo)}: ${cur.customerName} pays ${cur.vendorName}${cur.reference ? ` (${cur.reference})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: payable, debit: num(built.cents), partyType: 'VENDOR', partyId: cur.vendorId, narration: `${narration}: settles the bills of ${cur.vendorName}` },
        { accountId: receivable, credit: num(built.cents), partyType: 'CUSTOMER', partyId: cur.customerId, narration: `${narration}: settles the invoices of ${cur.customerName}` },
      ],
    }, transaction);
    for (const l of built.inv.lines) {
      await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = "receivedAmount" + :amount, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId', { replacements: { amount: fromCents(l.cents), id: l.id, companyId }, transaction });
    }
    for (const l of built.bill.lines) {
      await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" + :amount, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId', { replacements: { amount: fromCents(l.cents), id: l.id, companyId }, transaction });
    }
    await sequelize.query(`UPDATE contra_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'CONTRA_VOUCHER_CONFIRMED', entityType: 'ContraVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, amount: num(built.cents) } }, { transaction });
  });
  return get(req, id);
}

/** "Move to draft": the entry is reversed (both stay in the books), the invoices and bills get their amounts back, the voucher is a draft again. */
async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockBoth(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `contra voucher ${label(cur.voucherNo)} moved to draft` }, transaction); // dated like the entry it reverses
    const lines = await q('SELECT side, "salesInvoiceId", "purchaseInvoiceId", amount::text AS amount FROM contra_voucher_lines WHERE "voucherId" = :id', { id }, transaction);
    for (const l of lines) {
      if (l.side === 'INVOICE') await sequelize.query('UPDATE sales_invoices SET "receivedAmount" = "receivedAmount" - :amount, "updatedAt" = now() WHERE id = :doc AND "companyId" = :companyId', { replacements: { amount: l.amount, doc: l.salesInvoiceId, companyId }, transaction });
      else await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" - :amount, "updatedAt" = now() WHERE id = :doc AND "companyId" = :companyId', { replacements: { amount: l.amount, doc: l.purchaseInvoiceId, companyId }, transaction });
    }
    await sequelize.query(`UPDATE contra_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'CONTRA_VOUCHER_UNCONFIRMED', entityType: 'ContraVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, invoices, bills, list, get, create, update, remove, confirm, unconfirm, accountsEntry };
