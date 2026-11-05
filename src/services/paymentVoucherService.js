// Payment Voucher (accounting chunk 4, owner 2026-10-29): money paid to a VENDOR from a bank or cash account.
// A voucher pays vendor bills (approved purchase invoices) and / or is an advance (money paid before a bill). Income tax is withheld from the
// payment at a rate given on the voucher (the tax section): the vendor receives the net, the withheld tax is owed to the government.
//   DRAFT      saved; may be changed or deleted; no accounting entry; the bills are not touched
//   CONFIRMED  posted:  Debit Accounts Payable (each bill, vendor named) / Debit Supplier Advances (each advance)
//                       Credit Bank or Cash (net)  /  Credit Income Tax - Vendors (withheld)
//              and every bill's "paid" grows by the amount
//   un-confirm ("move to draft") posts the reverse entry, the bills' "paid" goes back, the voucher is a draft again
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const support = require('./voucherSupport');
const { today } = require('../utils/dates');

const { MODES, MODE_TEXT, STATUS_TEXT, INCOME_TAX_RATES, label, q, lock, amountCents, num, rateBp, taxOnGross, ageDays, bankOrCash, nextNo, toCents, fromCents } = support;
const SOURCE = 'PAYMENT_VOUCHER';
const KIND_TEXT = { BILL: 'Bill', ADVANCE: 'Advance' };

async function options(req) {
  return {
    modes: MODES.map((code) => ({ code, text: MODE_TEXT[code] })), statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })),
    payFromAccounts: await support.bankAndCashAccounts(req.user.companyId), incomeTaxRates: INCOME_TAX_RATES,
  };
}

/** GET /payment-vouchers/bills?vendorId= : the approved purchase invoices of the vendor that still have something to pay. */
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

/** The lines of the voucher, checked against the bills as they are now. Returns { lines, billsTotal, tax, net } in cents. */
async function buildLines(req, vendorId, input, taxRate, transaction) {
  const ids = [...new Set(input.filter((l) => l.purchaseInvoiceId).map((l) => l.purchaseInvoiceId))];
  if (ids.length !== input.filter((l) => l.purchaseInvoiceId).length) throw AppError.rule('DUPLICATE_BILL', 'A bill is on the voucher twice; give one line per bill');
  const found = ids.length ? await q(`SELECT p.id, p."voucherNo", p."billNo", p.status, p."vendorId", p."netAmount"::text AS net, p."paidAmount"::text AS paid, to_char(p."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate"
    FROM purchase_invoices p WHERE p."companyId" = :companyId AND p.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction) : [];
  if (found.length !== ids.length) throw AppError.notFound('Purchase invoice');
  const lines = input.map((l, i) => {
    const where = `Line ${i + 1}`;
    const cents = amountCents(l.amount, where);
    if (!l.purchaseInvoiceId) return { kind: 'ADVANCE', purchaseInvoiceId: null, cents, notes: l.notes || null };
    const b = found.find((x) => x.id === l.purchaseInvoiceId);
    const name = `Purchase invoice ${label(b.voucherNo)}${b.billNo ? ` (bill ${b.billNo})` : ''}`;
    if (b.vendorId !== vendorId) throw AppError.rule('BILL_OTHER_VENDOR', `${where}: ${name} belongs to another vendor`);
    if (b.status !== 'APPROVED') throw AppError.rule('BILL_NOT_APPROVED', `${where}: ${name} is not approved yet`);
    const balance = toCents(b.net) - toCents(b.paid);
    if (cents > balance) throw AppError.rule('MORE_THAN_BALANCE', `${where}: ${name} has only ${fromCents(balance)} left to pay`, { purchaseInvoiceId: b.id, balance: num(balance), amount: num(cents) });
    return { kind: 'BILL', purchaseInvoiceId: b.id, cents, notes: l.notes || null, bill: b };
  });
  const billsTotal = lines.reduce((t, l) => t + l.cents, 0n);
  const tax = taxOnGross(billsTotal, rateBp(taxRate));
  return { lines, billsTotal, tax, net: billsTotal - tax };
}

async function writeLines(voucherId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM payment_voucher_lines WHERE "voucherId" = :voucherId', { replacements: { voucherId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO payment_voucher_lines ("voucherId", "companyId", "lineNo", kind, "purchaseInvoiceId", amount, notes) VALUES (:voucherId, :companyId, :lineNo, :kind, :purchaseInvoiceId, :amount, :notes)`,
      { replacements: { voucherId, companyId, lineNo, kind: l.kind, purchaseInvoiceId: l.purchaseInvoiceId, amount: fromCents(l.cents), notes: l.notes }, transaction });
  }
}

const COLS = `v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS "voucherDate", v."paymentMode", to_char(v."chequeDate", 'YYYY-MM-DD') AS "chequeDate", v."chequeNo", v.notes, v."taxSection",
  v."incomeTaxRate"::float AS "incomeTaxRate", v."billsTotal"::float AS "billsTotal", v."incomeTaxAmount"::float AS "incomeTax", v."netAmount"::float AS net, v.status, v."confirmedAt", v."createdAt", v."updatedAt",
  vd.id AS "vendorId", vd.code AS "vendorCode", vd.name AS "vendorName", vd.ntn AS "vendorNtn", vd.iban AS "vendorIban", vd."bankName" AS "vendorBank",
  a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", a."controlType" AS "accountType",
  (SELECT string_agg(DISTINCT l.kind, ',') FROM payment_voucher_lines l WHERE l."voucherId" = v.id) AS kinds, cb.name AS "confirmedByName"`;
const FROM = `FROM payment_vouchers v JOIN vendors vd ON vd.id = v."vendorId" JOIN accounts a ON a.id = v."payFromAccountId" LEFT JOIN users cb ON cb.id = v."confirmedById"`;

function voucherJson(r) {
  const kinds = ['BILL', 'ADVANCE'].filter((k) => (r.kinds || '').split(',').includes(k));
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), voucherDate: r.voucherDate,
    vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName, ntn: r.vendorNtn, bankName: r.vendorBank, iban: r.vendorIban },
    payFrom: { id: r.accountId, code: r.accountCode, name: r.accountName, controlType: r.accountType },
    paymentMode: r.paymentMode, paymentModeText: MODE_TEXT[r.paymentMode], chequeDate: r.chequeDate, chequeNo: r.chequeNo, notes: r.notes,
    taxSection: r.taxSection, incomeTaxRate: r.incomeTaxRate, billsTotal: r.billsTotal, incomeTax: r.incomeTax, net: r.net,
    typeText: kinds.map((k) => KIND_TEXT[k]).join(' + '), status: r.status, statusText: STATUS_TEXT[r.status], confirmedAt: r.confirmedAt, confirmedBy: r.confirmedAt ? { name: r.confirmedByName } : null,
    canEdit: r.status === 'DRAFT', canDelete: r.status === 'DRAFT', canConfirm: r.status === 'DRAFT', canUnconfirm: r.status === 'CONFIRMED',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, forUpdate = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE v.id = :id AND v."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF v' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Payment voucher');
  return r;
}

async function get(req, id, transaction) {
  const v = voucherJson(await load(req, id, transaction));
  const lines = await q(`SELECT l."lineNo", l.kind, l."purchaseInvoiceId", l.amount::text AS amount, l.notes, p."voucherNo" AS "billVoucherNo", p."billNo", to_char(p."invoiceDate", 'YYYY-MM-DD') AS "billDate",
      p."netAmount"::text AS "billNet", p."paidAmount"::text AS "billPaid"
    FROM payment_voucher_lines l LEFT JOIN purchase_invoices p ON p.id = l."purchaseInvoiceId" WHERE l."voucherId" = :id ORDER BY l."lineNo"`, { id }, transaction);
  v.lines = lines.map((l) => ({
    lineNo: l.lineNo, kind: l.kind, kindText: KIND_TEXT[l.kind], purchaseInvoiceId: l.purchaseInvoiceId, billVoucherNo: l.billVoucherNo, billVoucherLabel: l.billVoucherNo ? label(l.billVoucherNo) : null,
    billNo: l.billNo, billDate: l.billDate, billNet: l.billNet ? num(toCents(l.billNet)) : null, billBalance: l.billNet ? num(toCents(l.billNet) - toCents(l.billPaid)) : null,
    amount: num(toCents(l.amount)), notes: l.notes,
  }));
  return v;
}

async function list(req, { page, limit, status, dateFrom, dateTo, vendorId, search }) {
  const where = ['v."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('v.status = :status'); r.status = status; }
  if (dateFrom) { where.push('v."voucherDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('v."voucherDate" <= :dateTo'); r.dateTo = dateTo; }
  if (vendorId) { where.push('v."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR v."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(vd.name ILIKE :like OR a.name ILIKE :like OR v."chequeNo" ILIKE :like OR v.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS vouchers, COALESCE(SUM(v."billsTotal"), 0)::text AS bills, COALESCE(SUM(v."incomeTaxAmount"), 0)::text AS tax, COALESCE(SUM(v."netAmount"), 0)::text AS net
    FROM payment_vouchers v JOIN vendors vd ON vd.id = v."vendorId" JOIN accounts a ON a.id = v."payFromAccountId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY v."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map(voucherJson), page, limit, total: sum.vouchers,
    summary: { vouchers: sum.vouchers, billAmount: num(toCents(sum.bills)), withholding: num(toCents(sum.tax)), netPaid: num(toCents(sum.net)) },
  };
}

async function vendorOr404(req, vendorId, transaction) {
  const [v] = await q('SELECT id, name FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: vendorId, companyId: req.user.companyId }, transaction);
  if (!v) throw AppError.notFound('Vendor');
  return v;
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lock('purchases', companyId, transaction);
    await vendorOr404(req, data.vendorId, transaction);
    await bankOrCash(companyId, data.payFromAccountId, transaction);
    const rate = data.incomeTaxRate ?? 0;
    const built = await buildLines(req, data.vendorId, data.lines, rate, transaction);
    const voucherNo = await nextNo('payment_vouchers', companyId, transaction);
    // the accounts the voucher will post to exist from the first voucher on
    if (built.lines.some((l) => l.kind === 'BILL')) await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    if (built.lines.some((l) => l.kind === 'ADVANCE')) await accounts.ensureDefault(req, 'SUPPLIER_ADVANCES', transaction);
    if (built.tax > 0n) await accounts.ensureDefault(req, 'INCOME_TAX_VENDORS', transaction);
    const [{ id: newId }] = await q(`INSERT INTO payment_vouchers ("companyId", "voucherNo", "voucherDate", "vendorId", "payFromAccountId", "paymentMode", "chequeDate", "chequeNo", notes, "taxSection", "incomeTaxRate",
        "billsTotal", "incomeTaxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :voucherDate, :vendorId, :payFromAccountId, :paymentMode, :chequeDate, :chequeNo, :notes, :taxSection, :rate, :bills, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, voucherDate: data.voucherDate || today(), vendorId: data.vendorId, payFromAccountId: data.payFromAccountId, paymentMode: data.paymentMode, chequeDate: data.chequeDate || null,
      chequeNo: data.chequeNo || null, notes: data.notes || null, taxSection: data.taxSection || null, rate, bills: fromCents(built.billsTotal), tax: fromCents(built.tax), net: fromCents(built.net), userId: req.user.id }, transaction);
    await writeLines(newId, companyId, built.lines, transaction);
    await audit.log(req, { action: 'PAYMENT_VOUCHER_CREATED', entityType: 'PaymentVoucher', entityId: newId, after: { voucherNo, vendorId: data.vendorId, billsTotal: num(built.billsTotal), incomeTax: num(built.tax), net: num(built.net), lines: built.lines.length } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('purchases', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be changed. Move it to draft first');
    const vendorId = changes.vendorId ?? cur.vendorId;
    if (changes.vendorId && changes.vendorId !== cur.vendorId) {
      await vendorOr404(req, vendorId, transaction);
      if (!changes.lines) throw AppError.rule('LINES_REQUIRED', 'The vendor changed: enter the lines again');
    }
    const accountId = changes.payFromAccountId ?? cur.accountId;
    if (changes.payFromAccountId) await bankOrCash(companyId, accountId, transaction);
    const rate = changes.incomeTaxRate ?? cur.incomeTaxRate;
    const input = changes.lines || (await q('SELECT "purchaseInvoiceId", amount::text AS amount, notes FROM payment_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"', { id }, transaction));
    const built = await buildLines(req, vendorId, input, rate, transaction);
    if (built.lines.some((l) => l.kind === 'BILL')) await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    if (built.lines.some((l) => l.kind === 'ADVANCE')) await accounts.ensureDefault(req, 'SUPPLIER_ADVANCES', transaction);
    if (built.tax > 0n) await accounts.ensureDefault(req, 'INCOME_TAX_VENDORS', transaction);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query(`UPDATE payment_vouchers SET "voucherDate" = :voucherDate, "vendorId" = :vendorId, "payFromAccountId" = :accountId, "paymentMode" = :paymentMode, "chequeDate" = :chequeDate, "chequeNo" = :chequeNo,
        notes = :notes, "taxSection" = :taxSection, "incomeTaxRate" = :rate, "billsTotal" = :bills, "incomeTaxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, voucherDate: changes.voucherDate || cur.voucherDate, vendorId, accountId, paymentMode: changes.paymentMode || cur.paymentMode, chequeDate: pick('chequeDate', cur.chequeDate), chequeNo: pick('chequeNo', cur.chequeNo),
      notes: pick('notes', cur.notes), taxSection: pick('taxSection', cur.taxSection), rate, bills: fromCents(built.billsTotal), tax: fromCents(built.tax), net: fromCents(built.net), userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PAYMENT_VOUCHER_UPDATED', entityType: 'PaymentVoucher', entityId: id, before: { billsTotal: cur.billsTotal, incomeTax: cur.incomeTax, net: cur.net }, after: { billsTotal: num(built.billsTotal), incomeTax: num(built.tax), net: num(built.net), lines: built.lines.length } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lock('purchases', req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('VOUCHER_CONFIRMED', 'A confirmed voucher cannot be deleted. Move it to draft first');
    await sequelize.query('DELETE FROM payment_vouchers WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PAYMENT_VOUCHER_DELETED', entityType: 'PaymentVoucher', entityId: id, before: { voucherNo: cur.voucherNo, billsTotal: cur.billsTotal, net: cur.net } }, { transaction });
  });
}

/** Posts the entry and adds the payments to the bills. The lines are checked again against the bills as they are now. */
async function confirm(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('purchases', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'CONFIRMED') throw AppError.rule('ALREADY_CONFIRMED', 'This voucher is already confirmed');
    const input = await q('SELECT "purchaseInvoiceId", amount::text AS amount, notes FROM payment_voucher_lines WHERE "voucherId" = :id ORDER BY "lineNo"', { id }, transaction);
    if (!input.length) throw AppError.rule('NO_LINES', 'The voucher has no lines');
    await vendorOr404(req, cur.vendorId, transaction);
    const bank = await bankOrCash(companyId, cur.accountId, transaction);
    const built = await buildLines(req, cur.vendorId, input, cur.incomeTaxRate, transaction);
    if (built.billsTotal <= 0n) throw AppError.rule('NOTHING_TO_PAY', 'The voucher amount is zero');
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query(`UPDATE payment_vouchers SET "billsTotal" = :bills, "incomeTaxAmount" = :tax, "netAmount" = :net WHERE id = :id`, { replacements: { id, bills: fromCents(built.billsTotal), tax: fromCents(built.tax), net: fromCents(built.net) }, transaction });

    const payable = built.lines.some((l) => l.kind === 'BILL') ? await accounts.ensureDefault(req, 'SUPPLIERS', transaction) : null;
    const advance = built.lines.some((l) => l.kind === 'ADVANCE') ? await accounts.ensureDefault(req, 'SUPPLIER_ADVANCES', transaction) : null;
    const taxAccount = built.tax > 0n ? await accounts.ensureDefault(req, 'INCOME_TAX_VENDORS', transaction) : null;
    const narration = `Payment voucher ${label(cur.voucherNo)} - ${cur.vendorName}${cur.chequeNo && cur.paymentMode === 'CHEQUE' ? ` (cheque ${cur.chequeNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.voucherDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        ...built.lines.map((l) => (l.kind === 'BILL'
          ? { accountId: payable, debit: num(l.cents), partyType: 'VENDOR', partyId: cur.vendorId, narration: `${narration}: bill ${label(l.bill.voucherNo)}${l.bill.billNo ? ` (${l.bill.billNo})` : ''}` }
          : { accountId: advance, debit: num(l.cents), partyType: 'VENDOR', partyId: cur.vendorId, narration: `${narration}: advance` })),
        ...(taxAccount ? [{ accountId: taxAccount, credit: num(built.tax), narration: `${narration}: income tax withheld` }] : []),
        ...(built.net > 0n ? [{ accountId: bank.id, credit: num(built.net), narration }] : []),
      ],
    }, transaction);
    for (const l of built.lines.filter((x) => x.kind === 'BILL')) {
      await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" + :amount, "updatedAt" = now() WHERE id = :bill AND "companyId" = :companyId',
        { replacements: { amount: fromCents(l.cents), bill: l.purchaseInvoiceId, companyId }, transaction });
    }
    await sequelize.query(`UPDATE payment_vouchers SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedById" = :userId, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PAYMENT_VOUCHER_CONFIRMED', entityType: 'PaymentVoucher', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, billsTotal: num(built.billsTotal), incomeTax: num(built.tax), net: num(built.net) } }, { transaction });
  });
  return get(req, id);
}

/** "Move to draft": the entry is reversed (both stay in the books), the bills' paid amounts go back, the voucher is a draft again. */
async function unconfirm(req, id, { reason } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('purchases', companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'CONFIRMED') throw AppError.rule('NOT_CONFIRMED', 'This voucher is not confirmed');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this voucher was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `payment voucher ${label(cur.voucherNo)} moved to draft` }, transaction); // dated like the entry it reverses
    const billLines = await q(`SELECT "purchaseInvoiceId", amount::text AS amount FROM payment_voucher_lines WHERE "voucherId" = :id AND kind = 'BILL'`, { id }, transaction);
    for (const l of billLines) {
      await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" - :amount, "updatedAt" = now() WHERE id = :bill AND "companyId" = :companyId', { replacements: { amount: l.amount, bill: l.purchaseInvoiceId, companyId }, transaction });
    }
    await sequelize.query(`UPDATE payment_vouchers SET status = 'DRAFT', "confirmedAt" = NULL, "confirmedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PAYMENT_VOUCHER_UNCONFIRMED', entityType: 'PaymentVoucher', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

async function accountsEntry(req, id) {
  const v = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { voucherId: id, voucherLabel: label(v.voucherNo), status: v.status, posted: Boolean(current), current, entries };
}

module.exports = { options, bills, list, get, create, update, remove, confirm, unconfirm, accountsEntry };
