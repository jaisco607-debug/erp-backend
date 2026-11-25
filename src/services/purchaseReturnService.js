// Purchase Return Invoice (debit note, owner 2026-11-24): goods bought from a vendor and sent back (a store vendor return, with its gate pass and delivery challan).
// One return invoice is for ONE vendor and ONE original purchase invoice, and is made of that vendor's store returns (VR-...) of that bill:
//   UNAPPROVED  saved; may be changed or deleted; no accounting entry
//   APPROVED    posted:  Debit Accounts Payable (net, vendor named)  /  Credit Purchases (gross)  /  Credit Input Sales Tax (tax)   = the purchase entry the other way round
//   un-approve  posts the reverse entry (nothing is erased) and the invoice may be changed again
// What it takes off the original bill: the part of the return that is still unpaid on the bill is added to the bill's settled amount (paidAmount) and shown as
// `returnedAmount`, so the bill's balance, the payment / contra voucher lists and the ageing show the smaller amount. If the bill was already paid, the part that
// cannot be taken off the bill stays as a debit balance of the vendor in the ledger (`unappliedAmount`): the vendor owes us that money.
// Amounts follow the vendor returns: the value of the returned stock at its purchase rate, and the sales tax in the same proportion as the bill charged it.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const vendorReturns = require('./vendorReturnService');
const { round } = require('../utils/money');
const { today } = require('../utils/dates');

const SOURCE = 'PURCHASE_RETURN';
const STATUS_TEXT = { UNAPPROVED: 'Un-approved', APPROVED: 'Approved' };
const STORE_TEXT = { CHEMICAL: 'Chemical Store', GENERAL: 'General Store' };
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const label = (n) => String(n).padStart(5, '0');
// the same lock the purchase invoices and the payment vouchers take: a return and a payment never change one bill together
const lockPurchases = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `purchases:${companyId}` }, transaction });

/** The lines of the vendor returns (stock sent back) with the purchase invoice of the purchase they come from. */
const LINE_SQL = `
  SELECT l.id AS "lineId", r.id AS "vendorReturnId", r.store, r."returnNo", to_char(r."returnDate", 'YYYY-MM-DD') AS "returnDate", r.status AS "returnStatus", r."vendorId",
    r."gatePassNo", r."challanNo", r."vehicleNo", r."driverName", r.reason,
    l."itemId", it.name AS item, it.unit, l.qty::float AS qty, l.rate::float AS rate, l.value::float AS value, l."inwardId", i."ipNo", i."dcNo",
    pil."invoiceId" AS "purchaseInvoiceId", pil.amount::float AS "inwardAmount", pil."salesTax"::float AS "inwardTax",
    pi."voucherNo" AS "invoiceNo", pi.status AS "invoiceStatus", pi."billNo", to_char(pi."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", pi."vendorId" AS "invoiceVendorId",
    (SELECT x."returnInvoiceId" FROM purchase_return_lines x WHERE x."vendorReturnLineId" = l.id) AS "onInvoiceId"
  FROM store_vendor_return_lines l JOIN store_vendor_returns r ON r.id = l."returnId" JOIN store_items it ON it.id = l."itemId" JOIN store_inwards i ON i.id = l."inwardId"
    LEFT JOIN purchase_invoice_lines pil ON pil."inwardId" = l."inwardId" LEFT JOIN purchase_invoices pi ON pi.id = pil."invoiceId"
  WHERE r."companyId" = :companyId`;

/** The money of one returned line: its value, and the bill's sales tax in the same proportion. */
const priced = (r) => ({ ...r, amount: round(r.value, 2), salesTax: r.inwardAmount > 0 ? round((r.value * r.inwardTax) / r.inwardAmount, 2) : 0 });

const lineJson = (r) => ({
  lineId: r.lineId, vendorReturnId: r.vendorReturnId, returnNo: r.returnNo, returnText: vendorReturns.text(r.returnNo), returnDate: r.returnDate,
  gatePassNo: r.gatePassNo, gatePassText: vendorReturns.gatePassText(r.gatePassNo), challanNo: r.challanNo, challanText: vendorReturns.challanText(r.challanNo), vehicleNo: r.vehicleNo, driverName: r.driverName,
  store: r.store, storeText: STORE_TEXT[r.store], reasonText: vendorReturns.REASON_TEXT[r.reason],
  item: r.item, unit: r.unit, qty: r.qty, rate: r.rate, ipNo: r.ipNo, dcNo: r.dcNo, amount: r.amount, salesTax: r.salesTax, net: round(r.amount + r.salesTax, 2),
});

const totalsOf = (lines) => {
  const gross = round(lines.reduce((t, l) => t + l.amount, 0), 2);
  const tax = round(lines.reduce((t, l) => t + l.salesTax, 0), 2);
  return { gross, tax, net: round(gross + tax, 2) };
};

/** GET /purchase-returns/vendor-returns?vendorId= : the vendor's returns (stock sent back) that can still be put on a return invoice. */
async function vendorReturnsOf(req, { vendorId, invoiceId, search, limit }) {
  const rows = (await q(`${LINE_SQL} AND r."vendorId" = :vendorId AND r.status = 'POSTED' ORDER BY r."returnDate" DESC, r."returnNo" DESC`, { companyId: req.user.companyId, vendorId }))
    .filter((r) => !r.onInvoiceId || r.onInvoiceId === invoiceId).map(priced);
  const byReturn = new Map();
  for (const r of rows) byReturn.set(r.vendorReturnId, [...(byReturn.get(r.vendorReturnId) || []), r]);
  let data = [...byReturn.values()].map((ls) => {
    const head = ls[0];
    const invoiceIds = [...new Set(ls.map((l) => l.purchaseInvoiceId))];
    const blocked = ls.some((l) => !l.purchaseInvoiceId) ? ['NOT_ON_INVOICE', 'This purchase is not on a purchase invoice yet: make and approve the purchase invoice first']
      : invoiceIds.length > 1 ? ['MANY_INVOICES', 'The purchases of this return are on different purchase invoices: return each purchase in its own return']
        : ls[0].invoiceStatus !== 'APPROVED' ? ['INVOICE_NOT_APPROVED', `Purchase invoice ${label(ls[0].invoiceNo)} is not approved yet`]
          : null;
    const t = totalsOf(ls);
    return {
      vendorReturnId: head.vendorReturnId, returnNo: head.returnNo, returnText: vendorReturns.text(head.returnNo), returnDate: head.returnDate, store: head.store, storeText: STORE_TEXT[head.store],
      gatePassText: vendorReturns.gatePassText(head.gatePassNo), challanText: vendorReturns.challanText(head.challanNo), reasonText: vendorReturns.REASON_TEXT[head.reason],
      items: [...new Set(ls.map((l) => l.item))].join(', '), purchaseInvoice: invoiceIds.length === 1 && ls[0].purchaseInvoiceId ? { id: ls[0].purchaseInvoiceId, voucherNo: ls[0].invoiceNo, voucherLabel: label(ls[0].invoiceNo), billNo: ls[0].billNo, status: ls[0].invoiceStatus } : null,
      gross: t.gross, tax: t.tax, net: t.net, canBill: !blocked, blockedReason: blocked ? blocked[1] : null, blockedCode: blocked ? blocked[0] : null,
    };
  });
  if (search) {
    const s = search.trim().toLowerCase();
    data = data.filter((r) => [r.returnNo].some((n) => String(n) === s) || [r.items, r.gatePassText, r.challanText].some((t) => (t || '').toLowerCase().includes(s)));
  }
  return { data: data.slice(0, limit), total: data.length };
}

/** The lines of a return invoice from the chosen vendor returns; every rule is checked here. */
async function buildLines(req, vendorId, returnIds, invoiceId, transaction) {
  const ids = [...new Set(returnIds)];
  const rows = (await q(`${LINE_SQL} AND r.id IN (:ids) ORDER BY r."returnNo", it.name`, { companyId: req.user.companyId, ids }, transaction)).map(priced);
  if (new Set(rows.map((r) => r.vendorReturnId)).size !== ids.length) throw AppError.notFound('Vendor return');
  for (const r of rows) {
    const name = `Return ${vendorReturns.text(r.returnNo)}`;
    if (r.vendorId !== vendorId) throw AppError.rule('OTHER_VENDOR', `${name} is of another vendor`);
    if (r.returnStatus !== 'POSTED') throw AppError.rule('RETURN_CANCELLED', `${name} was cancelled`);
    if (r.onInvoiceId && r.onInvoiceId !== invoiceId) throw AppError.rule('ALREADY_INVOICED', `${name} is already on a purchase return invoice`);
    if (!r.purchaseInvoiceId) throw AppError.rule('NOT_ON_INVOICE', `${name}: the purchase is not on a purchase invoice yet; make and approve the purchase invoice first`);
  }
  const invoices = [...new Set(rows.map((r) => r.purchaseInvoiceId))];
  if (invoices.length > 1) throw AppError.rule('MANY_INVOICES', 'One return invoice is for one purchase invoice; these returns are of purchases on different purchase invoices', { invoices: [...new Set(rows.map((r) => label(r.invoiceNo)))] });
  if (rows[0].invoiceStatus !== 'APPROVED') throw AppError.rule('INVOICE_NOT_APPROVED', `Purchase invoice ${label(rows[0].invoiceNo)} is not approved yet: approve it first`);
  if (rows[0].invoiceVendorId !== vendorId) throw AppError.rule('OTHER_VENDOR', 'The purchase invoice is of another vendor');
  return { purchaseInvoiceId: invoices[0], invoiceNo: rows[0].invoiceNo, invoiceDate: rows[0].invoiceDate, lines: rows };
}

async function writeLines(returnInvoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM purchase_return_lines WHERE "returnInvoiceId" = :returnInvoiceId', { replacements: { returnInvoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO purchase_return_lines ("returnInvoiceId", "companyId", "lineNo", "vendorReturnId", "vendorReturnLineId", amount, "salesTax")
      VALUES (:returnInvoiceId, :companyId, :lineNo, :vendorReturnId, :lineId, :amount, :salesTax)`, { replacements: { returnInvoiceId, companyId, lineNo, vendorReturnId: l.vendorReturnId, lineId: l.lineId, amount: l.amount, salesTax: l.salesTax }, transaction });
  }
}

const COLS = `p.id, p."voucherNo", to_char(p."returnDate", 'YYYY-MM-DD') AS "returnDate", p.notes, p."grossAmount"::float AS gross, p."taxAmount"::float AS tax, p."netAmount"::float AS net,
  p."appliedAmount"::float AS applied, p.status, p."approvedAt", p."createdAt", p."updatedAt", p."purchaseInvoiceId",
  v.id AS "vendorId", v.code AS "vendorCode", v.name AS "vendorName", v.ntn AS "vendorNtn", v.address AS "vendorAddress", v.city AS "vendorCity",
  pi."voucherNo" AS "invoiceNo", pi."billNo", to_char(pi."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", pi."netAmount"::float AS "invoiceNet", pi."paidAmount"::float AS "invoicePaid", pi."returnedAmount"::float AS "invoiceReturned",
  (SELECT count(*)::int FROM purchase_return_lines l WHERE l."returnInvoiceId" = p.id) AS "lineCount"`;
const FROM = 'FROM purchase_returns p JOIN vendors v ON v.id = p."vendorId" JOIN purchase_invoices pi ON pi.id = p."purchaseInvoiceId"';

function returnJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), returnDate: r.returnDate, notes: r.notes,
    vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName, ntn: r.vendorNtn, address: r.vendorAddress, city: r.vendorCity },
    purchaseInvoice: { id: r.purchaseInvoiceId, voucherNo: r.invoiceNo, voucherLabel: label(r.invoiceNo), billNo: r.billNo, invoiceDate: r.invoiceDate, net: r.invoiceNet, paid: round(r.invoicePaid - r.invoiceReturned), returnedAmount: r.invoiceReturned, balance: round(r.invoiceNet - r.invoicePaid) },
    lineCount: r.lineCount, gross: r.gross, tax: r.tax, net: r.net, appliedAmount: r.applied, unappliedAmount: r.status === 'APPROVED' ? round(r.net - r.applied) : null,
    status: r.status, statusText: STATUS_TEXT[r.status], approvedAt: r.approvedAt, approvedBy: r.approvedAt ? { name: r.approvedByName } : null,
    canEdit: r.status === 'UNAPPROVED', canDelete: r.status === 'UNAPPROVED', canApprove: r.status === 'UNAPPROVED', canUnapprove: r.status === 'APPROVED',
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, lock = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE p.id = :id AND p."companyId" = :companyId${lock ? ' FOR UPDATE OF p' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Purchase return invoice');
  return r;
}

async function get(req, id, transaction) {
  const inv = returnJson(await load(req, id, transaction));
  const stored = await q('SELECT "vendorReturnLineId" AS "lineId", "lineNo", amount::float AS amount, "salesTax"::float AS "salesTax" FROM purchase_return_lines WHERE "returnInvoiceId" = :id ORDER BY "lineNo"', { id }, transaction);
  const live = stored.length ? await q(`${LINE_SQL} AND l.id IN (:ids)`, { companyId: req.user.companyId, ids: stored.map((s) => s.lineId) }, transaction) : [];
  // the amounts are the ones saved on the invoice; the descriptions come from the vendor returns
  inv.lines = stored.map((s) => ({ lineNo: s.lineNo, ...lineJson({ ...(live.find((x) => x.lineId === s.lineId) || {}), amount: s.amount, salesTax: s.salesTax }) }));
  inv.vendorReturns = [...new Map(inv.lines.map((l) => [l.vendorReturnId, { id: l.vendorReturnId, returnText: l.returnText, returnDate: l.returnDate, gatePassText: l.gatePassText, challanText: l.challanText, vehicleNo: l.vehicleNo, driverName: l.driverName, store: l.store }])).values()];
  return inv;
}

async function list(req, { page, limit, status, dateFrom, dateTo, vendorId, purchaseInvoiceId, search }) {
  const where = ['p."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('p.status = :status'); r.status = status; }
  if (dateFrom) { where.push('p."returnDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('p."returnDate" <= :dateTo'); r.dateTo = dateTo; }
  if (vendorId) { where.push('p."vendorId" = :vendorId'); r.vendorId = vendorId; }
  if (purchaseInvoiceId) { where.push('p."purchaseInvoiceId" = :purchaseInvoiceId'); r.purchaseInvoiceId = purchaseInvoiceId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR p."voucherNo" = :n OR pi."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(v.name ILIKE :like OR pi."billNo" ILIKE :like OR p.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS invoices, COALESCE(SUM(p."grossAmount"), 0)::float AS amount, COALESCE(SUM(p."taxAmount"), 0)::float AS tax, COALESCE(SUM(p."netAmount"), 0)::float AS net ${FROM} WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY p."voucherNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return { data: rows.map(returnJson), page, limit, total: sum.invoices, summary: { invoices: sum.invoices, amount: round(sum.amount), tax: round(sum.tax), net: round(sum.net) } };
}

async function vendorOr404(req, vendorId, transaction) {
  const [v] = await q('SELECT id, name FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: vendorId, companyId: req.user.companyId }, transaction);
  if (!v) throw AppError.notFound('Vendor');
  return v;
}

const nextVoucherNo = async (companyId, transaction) => ((await q('SELECT MAX("voucherNo") AS m FROM purchase_returns WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;

function checkDate(date, invoiceDate) {
  if (date < invoiceDate) throw AppError.rule('RETURN_BEFORE_INVOICE', `The return invoice cannot be dated before the purchase invoice (${invoiceDate})`, { invoiceDate });
}

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    await vendorOr404(req, data.vendorId, transaction);
    const built = await buildLines(req, data.vendorId, data.vendorReturnIds, null, transaction);
    const totals = totalsOf(built.lines);
    const returnDate = data.returnDate || today();
    checkDate(returnDate, built.invoiceDate);
    const voucherNo = await nextVoucherNo(companyId, transaction);
    // the accounts exist from the first invoice on (found if the company has them, made if not); a draft posts nothing to them
    await accounts.ensureDefault(req, 'PURCHASES', transaction);
    await accounts.ensureDefault(req, 'INPUT_TAX', transaction);
    await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const [{ id: newId }] = await q(`INSERT INTO purchase_returns ("companyId", "voucherNo", "returnDate", "vendorId", "purchaseInvoiceId", notes, "grossAmount", "taxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :returnDate, :vendorId, :purchaseInvoiceId, :notes, :gross, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, returnDate, vendorId: data.vendorId, purchaseInvoiceId: built.purchaseInvoiceId, notes: data.notes || null, ...totals, userId: req.user.id }, transaction);
    await writeLines(newId, companyId, built.lines, transaction);
    await audit.log(req, { action: 'PURCHASE_RETURN_CREATED', entityType: 'PurchaseReturn', entityId: newId, after: { voucherNo, vendorId: data.vendorId, purchaseInvoiceNo: built.invoiceNo, returns: data.vendorReturnIds.length, ...totals } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('RETURN_APPROVED', 'An approved return invoice cannot be changed. Un-approve it first');
    const ids = changes.vendorReturnIds || [...new Set((await q('SELECT "vendorReturnId" FROM purchase_return_lines WHERE "returnInvoiceId" = :id', { id }, transaction)).map((l) => l.vendorReturnId))];
    const built = await buildLines(req, cur.vendorId, ids, id, transaction);
    const totals = totalsOf(built.lines);
    const returnDate = changes.returnDate || cur.returnDate;
    checkDate(returnDate, built.invoiceDate);
    await writeLines(id, companyId, built.lines, transaction);
    await sequelize.query(`UPDATE purchase_returns SET "purchaseInvoiceId" = :invoiceId, "returnDate" = :returnDate, notes = :notes, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
      { replacements: { id, invoiceId: built.purchaseInvoiceId, returnDate, notes: changes.notes === undefined ? cur.notes : changes.notes || null, ...totals, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_RETURN_UPDATED', entityType: 'PurchaseReturn', entityId: id, before: { gross: cur.gross, tax: cur.tax, net: cur.net }, after: { returns: ids.length, ...totals } }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('RETURN_APPROVED', 'An approved return invoice cannot be deleted. Un-approve it first');
    await sequelize.query('DELETE FROM purchase_returns WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PURCHASE_RETURN_DELETED', entityType: 'PurchaseReturn', entityId: id, before: { voucherNo: cur.voucherNo, net: cur.net } }, { transaction });
  });
}

/** Posts the entry (Debit Accounts Payable, Credit Purchases and Input Sales Tax) and takes the amount off the original bill. */
async function approve(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('ALREADY_APPROVED', 'This return invoice is already approved');
    const ids = [...new Set((await q('SELECT "vendorReturnId" FROM purchase_return_lines WHERE "returnInvoiceId" = :id', { id }, transaction)).map((l) => l.vendorReturnId))];
    if (!ids.length) throw AppError.rule('NO_LINES', 'The return invoice has no returns');
    const built = await buildLines(req, cur.vendorId, ids, id, transaction);
    const totals = totalsOf(built.lines);
    if (!(totals.net > 0)) throw AppError.rule('NOTHING_TO_RETURN', 'The return invoice amount is zero');
    checkDate(cur.returnDate, built.invoiceDate);
    await writeLines(id, companyId, built.lines, transaction);
    // the bill: what is still unpaid on it is what the return can take off
    const [bill] = await q('SELECT "netAmount"::float AS net, "paidAmount"::float AS paid FROM purchase_invoices WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id: built.purchaseInvoiceId, companyId }, transaction);
    const applied = round(Math.min(totals.net, Math.max(0, bill.net - bill.paid)), 2);

    const purchases = await accounts.ensureDefault(req, 'PURCHASES', transaction);
    const payable = await accounts.ensureDefault(req, 'SUPPLIERS', transaction);
    const taxAccount = totals.tax > 0 ? await accounts.ensureDefault(req, 'INPUT_TAX', transaction) : null;
    const narration = `Purchase return ${label(cur.voucherNo)} - ${cur.vendorName} (purchase invoice ${label(cur.invoiceNo)}${cur.billNo ? `, bill ${cur.billNo}` : ''})`;
    const entry = await journal.post(req, {
      entryDate: cur.returnDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: payable, debit: totals.net, partyType: 'VENDOR', partyId: cur.vendorId, narration },
        { accountId: purchases, credit: totals.gross, narration },
        ...(taxAccount ? [{ accountId: taxAccount, credit: totals.tax, narration: `${narration} (sales tax)` }] : []),
      ],
    }, transaction);
    await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" + :applied, "returnedAmount" = "returnedAmount" + :applied, "updatedAt" = now() WHERE id = :id', { replacements: { applied, id: built.purchaseInvoiceId }, transaction });
    await sequelize.query(`UPDATE purchase_returns SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = :userId, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net, "appliedAmount" = :applied,
      "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id, applied, ...totals }, transaction });
    await audit.log(req, { action: 'PURCHASE_RETURN_APPROVED', entityType: 'PurchaseReturn', entityId: id, after: { voucherNo: cur.voucherNo, purchaseInvoiceNo: cur.invoiceNo, journalEntryNo: entry.entryNo, appliedToBill: applied, ...totals } }, { transaction });
  });
  return get(req, id);
}

/** Takes the return invoice back to un-approved: the entry is reversed (both stay in the books) and the amount goes back on the bill. */
async function unapprove(req, id, { reason } = {}) {
  await sequelize.transaction(async (transaction) => {
    await lockPurchases(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'APPROVED') throw AppError.rule('NOT_APPROVED', 'This return invoice is not approved');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`,
      { companyId: req.user.companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this return invoice was not found');
    await sequelize.query('SELECT id FROM purchase_invoices WHERE id = :id FOR UPDATE', { replacements: { id: cur.purchaseInvoiceId }, transaction });
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `purchase return ${label(cur.voucherNo)} un-approved` }, transaction); // dated like the entry it reverses
    await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = "paidAmount" - :applied, "returnedAmount" = "returnedAmount" - :applied, "updatedAt" = now() WHERE id = :id', { replacements: { applied: cur.applied, id: cur.purchaseInvoiceId }, transaction });
    await sequelize.query(`UPDATE purchase_returns SET status = 'UNAPPROVED', "approvedAt" = NULL, "approvedById" = NULL, "appliedAmount" = 0, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PURCHASE_RETURN_UNAPPROVED', entityType: 'PurchaseReturn', entityId: id, after: { voucherNo: cur.voucherNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

/** The "Accounts" button: the entries of the return invoice. `current` is the live posting (null while un-approved). */
async function accountsEntry(req, id) {
  const inv = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { returnId: id, returnLabel: label(inv.voucherNo), status: inv.status, posted: Boolean(current), current, entries };
}

module.exports = { vendorReturnsOf, list, get, create, update, remove, approve, unapprove, accountsEntry };
