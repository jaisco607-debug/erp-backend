// Purchase Invoice (accounting chunk 3, owner 2026-10-28): the mirror of the Sales Invoice.
// An invoice is for ONE vendor and is made of that vendor's APPROVED store inwards (the chemical and general store purchases: what the vendor
// delivered and what it costs, with the sales tax). We owe the vendor, so the entry is the other way round from a sale:
//   UNAPPROVED  saved; may be changed or deleted; no accounting entry
//   APPROVED    posted:  Debit Purchases (gross)  /  Debit Input Sales Tax (tax)  /  Credit Accounts Payable (net, with the vendor named)
//   un-approve  posts the reverse entry (nothing is erased) and the invoice may be changed again
// Amounts always follow the store inwards and are worked out again on every save / approve. An inward on an invoice cannot be corrected or
// un-approved in the store until the invoice is un-approved or deleted (storeInwardService checks it).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const credit = require('./creditService');
const { round } = require('../utils/money');
const { today } = require('../utils/dates');

const SOURCE = 'PURCHASE_INVOICE';
const STORE_TEXT = { CHEMICAL: 'Chemical Store', GENERAL: 'General Store' };
const STATUS_TEXT = { UNAPPROVED: 'Un-approved', APPROVED: 'Approved' };
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const label = (n) => String(n).padStart(5, '0');
const lockPurchases = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `purchases:${companyId}` }, transaction });

/** The store inwards with what they cost; `invoiceId` is the purchase invoice an inward is already on. */
const INWARD_SQL = `
  SELECT i.id AS "inwardId", i.store, i."idNo", i."ipNo", to_char(i."inwardDate", 'YYYY-MM-DD') AS "inwardDate", i."billType", i."vendorId", i."grnNo", i."dcNo", i.notes,
    i."isApproved", i.amount::float AS amount, i."salesTax"::float AS "salesTax", i."gstPercent"::float AS "gstPercent",
    (SELECT string_agg(it.name, ', ' ORDER BY l."sortOrder") FROM store_inward_lines l JOIN store_items it ON it.id = l."itemId" WHERE l."inwardId" = i.id) AS items,
    (SELECT pl."invoiceId" FROM purchase_invoice_lines pl WHERE pl."inwardId" = i.id) AS "invoiceId",
    (SELECT p."voucherNo" FROM purchase_invoice_lines pl JOIN purchase_invoices p ON p.id = pl."invoiceId" WHERE pl."inwardId" = i.id) AS "invoiceVoucherNo"
  FROM store_inwards i WHERE i."companyId" = :companyId`;

const inwardLine = (r) => ({
  inwardId: r.inwardId, store: r.store, storeText: STORE_TEXT[r.store], idNo: r.idNo, idLabel: label(r.idNo), ipNo: r.ipNo, ipLabel: r.ipNo ? label(r.ipNo) : null,
  inwardDate: r.inwardDate, billType: r.billType, grnNo: r.grnNo, dcNo: r.dcNo, notes: r.notes, items: r.items, gstPercent: r.gstPercent,
  amount: r.amount, salesTax: r.salesTax, net: round(r.amount + r.salesTax, 2),
});

/** GET /purchase-invoices/inwards?vendorId= : the approved purchases of this vendor that can still be put on an invoice. */
async function inwards(req, { vendorId, store, search, invoiceId, limit }) {
  const rows = await q(`${INWARD_SQL} AND i."vendorId" = :vendorId AND i."isApproved" ${store ? 'AND i.store = :store' : ''} ORDER BY i."inwardDate" DESC, i."idNo" DESC`,
    { companyId: req.user.companyId, vendorId, store });
  let data = rows.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => [r.idNo, r.ipNo].some((n) => String(n) === s) || [r.grnNo, r.dcNo, r.notes, r.items].some((t) => (t || '').toLowerCase().includes(s)));
  }
  const total = data.length;
  return { data: data.slice(0, limit).map((r) => ({ ...inwardLine(r), canBill: r.amount + r.salesTax > 0, blockedReason: r.amount + r.salesTax > 0 ? null : 'The purchase has no amount' })), total };
}

/** The lines of an invoice from the chosen inwards; every rule about an inward is checked here. */
async function buildLines(req, vendorId, inwardIds, invoiceId, transaction) {
  const ids = [...new Set(inwardIds)];
  const rows = await q(`${INWARD_SQL} AND i.id IN (:ids)`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Purchase entry');
  for (const r of rows) {
    const name = `Purchase ${label(r.ipNo || r.idNo)} (${STORE_TEXT[r.store]})`;
    if (!r.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', `${name} is not approved in the store yet`);
    if (r.vendorId !== vendorId) throw AppError.rule('INWARD_OTHER_VENDOR', `${name} belongs to another vendor; one invoice is for one vendor`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('INWARD_TAKEN', `${name} is already on purchase invoice ${label(r.invoiceVoucherNo)}`);
    if (!(r.amount + r.salesTax > 0)) throw AppError.rule('NO_AMOUNT', `${name} has no amount, so there is nothing to bill`);
  }
  return rows.sort((a, b) => (a.inwardDate < b.inwardDate ? -1 : a.inwardDate > b.inwardDate ? 1 : a.idNo - b.idNo));
}

/**
 * The tax of the lines (owner 2026-10-28): the sales tax is chosen on the invoice (taxRate %). It is worked out on every purchase that carries no tax of its own
 * (every new store inward); an older inward that still has its own GST keeps it, so a purchase is never taxed twice.
 */
function priced(rows, taxRate) {
  const rate = Number(taxRate) || 0;
  return rows.map((r) => ({ ...r, salesTax: r.salesTax > 0 ? r.salesTax : round((r.amount * rate) / 100, 2) }));
}

// others (owner 2026-10-28): an amount taken off the bill (goods damaged / short), with a note. It is not taxed; it cannot be more than gross + tax.
function totalsOf(lines, othersAmount = 0) {
  const gross = round(lines.reduce((t, l) => t + l.amount, 0), 2);
  const tax = round(lines.reduce((t, l) => t + l.salesTax, 0), 2);
  const others = round(Number(othersAmount) || 0, 2);
  if (others > round(gross + tax, 2)) throw AppError.rule('OTHERS_MORE_THAN_BILL', `Others (${others}) cannot be more than the bill (${round(gross + tax, 2)})`, { others, bill: round(gross + tax, 2) });
  return { gross, tax, others, net: round(gross + tax - others, 2) };
}

async function writeLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_invoice_lines WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO purchase_invoice_lines ("invoiceId", "companyId", "lineNo", "inwardId", store, amount, "salesTax")
      VALUES (:invoiceId, :companyId, :lineNo, :inwardId, :store, :amount, :salesTax)`,
    { replacements: { ...l, invoiceId, companyId, lineNo }, transaction }); // the inward row has its own "invoiceId": ours must win
  }
}

const COLS = `p.id, p."voucherNo", p."billNo", to_char(p."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", to_char(p."dueDate", 'YYYY-MM-DD') AS "storedDue",
  to_char(COALESCE(p."dueDate", p."invoiceDate" + v."creditDays"), 'YYYY-MM-DD') AS "dueDate", p.notes, p."billDetails",
  p."taxRate"::float AS "taxRate", p."othersAmount"::float AS others, p."othersNote", p."grossAmount"::float AS gross, p."taxAmount"::float AS tax, p."netAmount"::float AS net, p."paidAmount"::float AS paid, p.status, p."approvedAt", p."createdAt", p."updatedAt",
  v.id AS "vendorId", v.code AS "vendorCode", v.name AS "vendorName", v.ntn AS "vendorNtn", v.address AS "vendorAddress", v.city AS "vendorCity",
  (SELECT count(*)::int FROM purchase_invoice_lines l WHERE l."invoiceId" = p.id) AS "inwardCount", ab.name AS "approvedByName"`;
const FROM = `FROM purchase_invoices p JOIN vendors v ON v.id = p."vendorId" LEFT JOIN users ab ON ab.id = p."approvedById"`;

function invoiceJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), billNo: r.billNo, invoiceDate: r.invoiceDate, dueDate: r.dueDate,
    isOverdue: r.status === 'APPROVED' && r.net - r.paid > 0 && r.dueDate < today(),
    vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName, ntn: r.vendorNtn, address: r.vendorAddress, city: r.vendorCity },
    notes: r.notes, billDetails: r.billDetails, inwardCount: r.inwardCount,
    taxRate: r.taxRate, othersAmount: r.others, othersNote: r.othersNote, othersEffect: 'DEDUCT', gross: r.gross, tax: r.tax, net: r.net, paid: r.paid, balance: round(r.net - r.paid),
    paymentStatus: r.paid <= 0 ? 'UNPAID' : r.paid >= r.net ? 'PAID' : 'PARTIAL',
    status: r.status, statusText: STATUS_TEXT[r.status], approvedAt: r.approvedAt, approvedBy: r.approvedAt ? { name: r.approvedByName } : null,
    canEdit: r.status === 'UNAPPROVED', canDelete: r.status === 'UNAPPROVED', canApprove: r.status === 'UNAPPROVED', canUnapprove: r.status === 'APPROVED' && r.paid === 0,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, lock = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE p.id = :id AND p."companyId" = :companyId${lock ? ' FOR UPDATE OF p' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Purchase invoice');
  return r;
}

async function get(req, id, transaction) {
  const inv = invoiceJson(await load(req, id, transaction));
  inv.creditWarning = await credit.warning(req, 'VENDOR', inv.vendor.id, { status: inv.status, net: inv.net }, transaction); // we owe the vendor more than his credit limit, or null
  const stored = await q('SELECT "inwardId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_invoice_lines WHERE "invoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
  const live = stored.length ? await q(`${INWARD_SQL} AND i.id IN (:ids)`, { companyId: req.user.companyId, ids: stored.map((s) => s.inwardId) }, transaction) : [];
  inv.lines = stored.map((s) => {
    const r = live.find((x) => x.inwardId === s.inwardId) || {};
    // the amounts are the ones saved on the invoice; the descriptions come from the store entry
    return { lineNo: s.lineNo, ...inwardLine({ ...r, amount: s.amount, salesTax: s.salesTax }) };
  });
  // the money paid against the invoice: the confirmed payment vouchers (the "Payments" tab)
  inv.payments = (await q(`SELECT pv.id AS "voucherId", pv."voucherNo", to_char(pv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", pv."paymentMode", pv."chequeNo", l.amount::float AS amount
    FROM payment_voucher_lines l JOIN payment_vouchers pv ON pv.id = l."voucherId" WHERE l."purchaseInvoiceId" = :id AND pv.status = 'CONFIRMED' ORDER BY pv."voucherDate", pv."voucherNo"`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'PAYMENT', voucherLabel: label(p.voucherNo) }));
  // money settled by a contra voucher (a customer pays this vendor's bill directly) is also a payment of the bill
  const contra = (await q(`SELECT cv.id AS "voucherId", cv."voucherNo", to_char(cv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", 'CONTRA' AS "paymentMode", NULL AS "chequeNo", l.amount::float AS amount
    FROM contra_voucher_lines l JOIN contra_vouchers cv ON cv.id = l."voucherId" WHERE l."purchaseInvoiceId" = :id AND cv.status = 'CONFIRMED'`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'CONTRA', voucherLabel: label(p.voucherNo) }));
  inv.payments = [...inv.payments, ...contra].sort((a, b) => (a.voucherDate < b.voucherDate ? -1 : a.voucherDate > b.voucherDate ? 1 : a.voucherNo - b.voucherNo));
  return inv;
}

function options() {
  return { statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), stores: Object.entries(STORE_TEXT).map(([code, text]) => ({ code, text })), taxRates: [0, 5, 10, 15, 17, 18], defaultTaxRate: 0 };
}

async function list(req, { page, limit, status, dateFrom, dateTo, vendorId, search }) {
  const where = ['p."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('p.status = :status'); r.status = status; }
  if (dateFrom) { where.push('p."invoiceDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('p."invoiceDate" <= :dateTo'); r.dateTo = dateTo; }
  if (vendorId) { where.push('p."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR p."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(v.name ILIKE :like OR v.ntn ILIKE :like OR p."billNo" ILIKE :like OR p."billDetails" ILIKE :like OR p.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS invoices, COALESCE(SUM(p."grossAmount"), 0)::float AS amount, COALESCE(SUM(p."taxAmount"), 0)::float AS tax,
      COALESCE(SUM(p."netAmount"), 0)::float AS net, COALESCE(SUM(p."paidAmount"), 0)::float AS paid FROM purchase_invoices p JOIN vendors v ON v.id = p."vendorId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY p."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map(invoiceJson), page, limit, total: sum.invoices,
    summary: { invoices: sum.invoices, amount: round(sum.amount), tax: round(sum.tax), net: round(sum.net), paid: round(sum.paid), balance: round(sum.net - sum.paid) },
  };
}

async function vendorOr404(req, vendorId, transaction) {
  const [v] = await q('SELECT id, name FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: vendorId, companyId: req.user.companyId }, transaction);
  if (!v) throw AppError.notFound('Vendor');
  return v;
}

async function checkBillNo(companyId, vendorId, billNo, exceptId, transaction) {
  if (!billNo) return;
  const [dup] = await q(`SELECT "voucherNo" FROM purchase_invoices WHERE "companyId" = :companyId AND "vendorId" = :vendorId AND lower("billNo") = lower(:billNo) AND id <> :exceptId`,
    { companyId, vendorId, billNo, exceptId: exceptId || '00000000-0000-0000-0000-000000000000' }, transaction);
  if (dup) throw AppError.rule('BILL_NO_TAKEN', `This vendor's bill ${billNo} is already entered (purchase invoice ${label(dup.voucherNo)})`);
}

const nextVoucherNo = async (companyId, transaction) => ((await q('SELECT MAX("voucherNo") AS m FROM purchase_invoices WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    await vendorOr404(req, data.vendorId, transaction);
    const taxRate = data.taxRate ?? 0;
    const lines = priced(await buildLines(req, data.vendorId, data.inwardIds, null, transaction), taxRate);
    const totals = totalsOf(lines, data.othersAmount);
    const billNo = data.billNo ? data.billNo.trim() : null;
    await checkBillNo(companyId, data.vendorId, billNo, null, transaction);
    const invoiceDate = data.invoiceDate || today();
    const dueDate = data.dueDate || (await credit.defaultDueDate(companyId, 'VENDOR', data.vendorId, invoiceDate, transaction));
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    const voucherNo = await nextVoucherNo(companyId, transaction);
    // the three default accounts exist from the first invoice on (found if the company has them, made if not); a draft posts nothing to them
    await accounts.ensureDefault(req, 'PURCHASES', transaction);
    await accounts.ensureDefault(req, 'INPUT_TAX', transaction);
    await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const [{ id: newId }] = await q(`INSERT INTO purchase_invoices ("companyId", "voucherNo", "invoiceDate", "dueDate", "vendorId", "billNo", notes, "billDetails", "taxRate", "othersAmount", "othersNote", "grossAmount", "taxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :invoiceDate, :dueDate, :vendorId, :billNo, :notes, :billDetails, :taxRate, :others, :othersNote, :gross, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, invoiceDate, dueDate, vendorId: data.vendorId, billNo, notes: data.notes || null, billDetails: data.billDetails || null, taxRate, othersNote: data.othersNote || null, ...totals, userId: req.user.id }, transaction);
    await writeLines(newId, companyId, lines, transaction);
    await audit.log(req, { action: 'PURCHASE_INVOICE_CREATED', entityType: 'PurchaseInvoice', entityId: newId, after: { voucherNo, billNo, vendorId: data.vendorId, inwards: lines.length, ...totals } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be changed. Un-approve it first');
    const vendorId = changes.vendorId ?? cur.vendorId;
    if (changes.vendorId && changes.vendorId !== cur.vendorId) {
      await vendorOr404(req, vendorId, transaction);
      if (!changes.inwardIds) throw AppError.rule('INWARDS_REQUIRED', 'The vendor changed: choose the purchases of the new vendor');
    }
    const ids = changes.inwardIds || (await q('SELECT "inwardId" FROM purchase_invoice_lines WHERE "invoiceId" = :id', { id }, transaction)).map((l) => l.inwardId);
    const taxRate = changes.taxRate ?? cur.taxRate;
    const lines = priced(await buildLines(req, vendorId, ids, id, transaction), taxRate);
    const totals = totalsOf(lines, changes.othersAmount ?? cur.others);
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    const billNo = changes.billNo === undefined ? cur.billNo : (changes.billNo ? changes.billNo.trim() : null);
    await checkBillNo(companyId, vendorId, billNo, id, transaction);
    const invoiceDate = changes.invoiceDate || cur.invoiceDate;
    // a typed due date wins; an empty one (or a new date / vendor without one) is worked out again from the vendor's credit days; otherwise it stays
    const redo = changes.dueDate === undefined ? Boolean(changes.invoiceDate || changes.vendorId) : !changes.dueDate;
    const dueDate = changes.dueDate || (redo ? await credit.defaultDueDate(companyId, 'VENDOR', vendorId, invoiceDate, transaction) : cur.storedDue);
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    await writeLines(id, companyId, lines, transaction);
    await sequelize.query(`UPDATE purchase_invoices SET "vendorId" = :vendorId, "billNo" = :billNo, "invoiceDate" = :invoiceDate, "dueDate" = :dueDate, notes = :notes, "billDetails" = :billDetails, "taxRate" = :taxRate, "othersAmount" = :others, "othersNote" = :othersNote,
        "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, vendorId, billNo, invoiceDate, dueDate, notes: pick('notes', cur.notes), billDetails: pick('billDetails', cur.billDetails), taxRate, othersNote: pick('othersNote', cur.othersNote), ...totals, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_UPDATED', entityType: 'PurchaseInvoice', entityId: id, before: { gross: cur.gross, tax: cur.tax, net: cur.net, billNo: cur.billNo }, after: { billNo, inwards: lines.length, ...totals } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be deleted. Un-approve it first');
    await sequelize.query('DELETE FROM purchase_invoices WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_DELETED', entityType: 'PurchaseInvoice', entityId: id, before: { voucherNo: cur.voucherNo, billNo: cur.billNo, net: cur.net } }, { transaction });
  });
}

/** Posts the accounting entry: Debit Purchases and Input Sales Tax, Credit Accounts Payable (the vendor named on the line). */
async function approve(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('ALREADY_APPROVED', 'This invoice is already approved');
    const ids = (await q('SELECT "inwardId" FROM purchase_invoice_lines WHERE "invoiceId" = :id', { id }, transaction)).map((l) => l.inwardId);
    if (!ids.length) throw AppError.rule('NO_LINES', 'The invoice has no purchases');
    const lines = priced(await buildLines(req, cur.vendorId, ids, id, transaction), cur.taxRate);
    const totals = totalsOf(lines, cur.others);
    if (!(totals.net > 0)) throw AppError.rule('NOTHING_TO_BILL', 'The invoice amount is zero');
    await writeLines(id, companyId, lines, transaction);

    const purchases = await accounts.ensureDefault(req, 'PURCHASES', transaction);
    const payable = await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const taxAccount = totals.tax > 0 ? await accounts.ensureDefault(req, 'INPUT_TAX', transaction) : null;
    const narration = `Purchase invoice ${label(cur.voucherNo)} - ${cur.vendorName}${cur.billNo ? ` (bill ${cur.billNo})` : ''}`;
    const entry = await journal.post(req, {
      entryDate: cur.invoiceDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: purchases, debit: totals.gross, narration },
        // an amount taken off the bill (goods damaged / short): credited to the purchases account on its own line, with the reason
        ...(totals.others > 0 ? [{ accountId: purchases, credit: totals.others, narration: `${narration}: others${cur.othersNote ? ` - ${cur.othersNote}` : ''}` }] : []),
        ...(taxAccount ? [{ accountId: taxAccount, debit: totals.tax, narration: `${narration} (sales tax)` }] : []),
        { accountId: payable, credit: totals.net, partyType: 'VENDOR', partyId: cur.vendorId, narration },
      ],
    }, transaction);
    await sequelize.query(`UPDATE purchase_invoices SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = :userId, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net,
      "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id, ...totals }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_APPROVED', entityType: 'PurchaseInvoice', entityId: id, after: { voucherNo: cur.voucherNo, journalEntryNo: entry.entryNo, ...totals } }, { transaction });
  });
  return get(req, id);
}

/** Takes the invoice back to un-approved: the entry is reversed (both stay in the books) and the invoice may be changed again. */
async function unapprove(req, id, { reason } = {}) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'APPROVED') throw AppError.rule('NOT_APPROVED', 'This invoice is not approved');
    if (cur.paid > 0) throw AppError.rule('HAS_PAYMENTS', 'Money was paid against this invoice; it cannot be un-approved');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`,
      { companyId: req.user.companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this invoice was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `purchase invoice ${label(cur.voucherNo)} un-approved` }, transaction); // dated like the entry it reverses
    await sequelize.query(`UPDATE purchase_invoices SET status = 'UNAPPROVED', "approvedAt" = NULL, "approvedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_INVOICE_UNAPPROVED', entityType: 'PurchaseInvoice', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

/** The "Accounts" button: the entries of the invoice. `current` is the live posting (null while un-approved). */
async function accountsEntry(req, id) {
  const inv = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { invoiceId: id, invoiceLabel: label(inv.voucherNo), status: inv.status, posted: Boolean(current), current, entries };
}

const creditOf = (req, vendorId) => credit.publicStatus(req, 'VENDOR', vendorId);

module.exports = { creditOf, options, inwards, list, get, create, update, remove, approve, unapprove, accountsEntry };
