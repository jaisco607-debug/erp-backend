// Sales Invoice (accounting chunk 2, owner 2026-10-24).
// An invoice is for ONE customer (billed to) and is made of that customer's GATE PASSES. Each gate pass brings the cloth of its packing
// list: the meters of A / B / CP, the rate of each and the amount. "Delivered to" is the destination written on the gate pass.
//   UNAPPROVED  saved; may be changed or deleted; no accounting entry
//   APPROVED    the journal entry is posted:  Debit Accounts Receivable (net)  /  Credit Sales (gross)  /  Credit Sales Tax - Output (tax)
//   un-approve  posts the reversal entry (nothing is erased) and the invoice is open for change again
// Amounts always follow the packing list and are worked out again on every save / approve.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const journal = require('./journalService');
const accounts = require('./accountService');
const credit = require('./creditService');
const packing = require('./packingService');
const { round } = require('../utils/money');
const { today } = require('../utils/dates');
const { soLabel } = require('../utils/soLabel');

const SOURCE = 'SALES_INVOICE';
const DEFAULT_TAX_RATE = 18;
const DEFAULT_HS_CODE = '5208.1100';
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const label = (n) => String(n).padStart(5, '0');
const STATUS_TEXT = { UNAPPROVED: 'Un-approved', APPROVED: 'Approved' };
const lockSales = (companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `sales:${companyId}` }, transaction });

/** The gate passes with what they bring: quantities, rates, billed quantity and amount (each line rounded to the paisa, as the packing list does). */
const GATE_SQL = `
  SELECT g.id AS "gatePassId", g."gatePassNo", to_char(g."passDate", 'YYYY-MM-DD') AS "passDate", g.destination, g."vehicleNo",
    p.id AS "packingListId", p."listNo", p."rateA"::float AS "rateA", p."rateB"::float AS "rateB", p."rateCP"::float AS "rateCP",
    sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn", sc."customerId",
    COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'A'), 0)::float AS "qtyA",
    COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'B'), 0)::float AS "qtyB",
    COALESCE(SUM(pl.meters) FILTER (WHERE pl.grade = 'CP'), 0)::float AS "qtyCP",
    COALESCE(SUM(CASE WHEN (CASE pl.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END) > 0 THEN pl.meters ELSE 0 END), 0)::float AS "billedQty",
    COALESCE(SUM(ROUND(pl.meters * (CASE pl.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END), 2)), 0)::float AS amount,
    (SELECT string_agg(DISTINCT gl."dcNo", ', ') FROM packing_list_lines x JOIN grey_lots gl ON gl.id = x."greyLotId"
      WHERE x."packingListId" = p.id AND gl."dcNo" IS NOT NULL AND gl."dcNo" <> '') AS "dcNo",
    (SELECT i.id FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l."invoiceId" WHERE l."gatePassId" = g.id) AS "invoiceId",
    (SELECT i."invoiceNo" FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l."invoiceId" WHERE l."gatePassId" = g.id) AS "invoiceNo"
  FROM gate_passes g JOIN packing_lists p ON p.id = g."packingListId" JOIN so_cards sc ON sc.id = p."soCardId"
    JOIN packing_list_lines pl ON pl."packingListId" = p.id
  WHERE g."companyId" = :companyId AND p.status = 'FINAL'`;
const GATE_GROUP = 'GROUP BY g.id, p.id, sc.id';

async function packingDeptId(companyId, transaction) {
  const [s] = await q(`SELECT s.id FROM services s JOIN company_services cs ON cs."serviceId" = s.id WHERE cs."companyId" = :companyId AND s.kind = 'PACKING' LIMIT 1`, { companyId }, transaction);
  return s ? s.id : null;
}

/** Adds quality and colour (from the SO card) and the readable SO label to gate pass rows. */
async function describe(req, rows, transaction) {
  const dep = await packingDeptId(req.user.companyId, transaction);
  const info = dep && rows.length ? await packing.cardInfo(req, dep, [...new Set(rows.map((r) => r.soCardId))], transaction) : new Map();
  return rows.map((r) => {
    const i = info.get(r.soCardId) || {};
    return { ...r, soLabel: soLabel(r.cardNo, r.isGreyReturn), quality: i.quality ?? null, colour: i.colour ?? null };
  });
}

const gateLine = (r) => ({
  gatePassId: r.gatePassId, gatePassNo: r.gatePassNo, gatePassLabel: label(r.gatePassNo), passDate: r.passDate,
  packingListId: r.packingListId, listNo: r.listNo, soCardId: r.soCardId, soLabel: r.soLabel, dcNo: r.dcNo, quality: r.quality, colour: r.colour,
  deliveredTo: r.destination, vehicleNo: r.vehicleNo,
  qtyA: r.qtyA, qtyB: r.qtyB, qtyCP: r.qtyCP, totalQty: round(r.qtyA + r.qtyB + r.qtyCP),
  billedQty: r.billedQty, rateA: r.rateA, rateB: r.rateB, rateCP: r.rateCP, amount: r.amount,
});

/** Gate passes that can still be put on an invoice (the screen's dropdown): of one customer, final list, not sold yet. */
async function gatePasses(req, { customerId, destination, search, invoiceId, limit }) {
  const { companyId } = req.user;
  const base = `${GATE_SQL} AND sc."customerId" = :customerId AND NOT sc."isGreyReturn"`;
  const repl = { companyId, customerId, invoiceId: invoiceId || null };
  const all = await q(`${base} ${GATE_GROUP} ORDER BY g."gatePassNo" DESC`, repl);
  // not on an invoice yet (a gate pass of the invoice being edited stays in the list)
  let rows = all.filter((r) => !r.invoiceId || r.invoiceId === invoiceId);
  const destinations = [...new Set(rows.map((r) => (r.destination || '').trim()).filter(Boolean))].sort();
  if (destination) rows = rows.filter((r) => (r.destination || '').trim().toLowerCase() === destination.trim().toLowerCase());
  if (search) {
    const s = search.trim().toLowerCase();
    rows = rows.filter((r) => [r.gatePassNo, r.listNo, r.cardNo].some((n) => String(n) === s) || (r.destination || '').toLowerCase().includes(s) || (r.vehicleNo || '').toLowerCase().includes(s));
  }
  const total = rows.length;
  const data = (await describe(req, rows.slice(0, limit), null)).map((r) => ({ ...gateLine(r), canBill: r.amount > 0, blockedReason: r.amount > 0 ? null : 'The packing list has no rates, so it has no amount' }));
  return { data, total, destinations };
}

/** The lines of an invoice from the chosen gate passes; every rule about a gate pass is checked here. */
async function buildLines(req, customerId, gatePassIds, invoiceId, transaction) {
  const ids = [...new Set(gatePassIds)];
  const rows = await q(`${GATE_SQL} AND g.id IN (:ids) ${GATE_GROUP}`, { companyId: req.user.companyId, ids }, transaction);
  if (rows.length !== ids.length) throw AppError.notFound('Gate pass');
  for (const r of rows) {
    const name = `Gate pass ${r.gatePassNo}`;
    if (r.isGreyReturn) throw AppError.rule('GREY_RETURN_NOT_SOLD', `${name} is a fabric return (not processed): it is not sold`);
    if (r.customerId !== customerId) throw AppError.rule('GATE_PASS_OTHER_CUSTOMER', `${name} belongs to another customer; one invoice is for one customer`);
    if (r.invoiceId && r.invoiceId !== invoiceId) throw AppError.rule('GATE_PASS_TAKEN', `${name} is already on invoice ${label(r.invoiceNo)}`);
    if (!(r.amount > 0)) throw AppError.rule('NO_RATES', `${name}: the packing list has no rates, so there is nothing to bill`);
  }
  return (await describe(req, rows.sort((a, b) => a.gatePassNo - b.gatePassNo), transaction));
}

// others (owner 2026-10-28): an extra amount on the bill (with a note); the tax is worked out on the gross only, others is added to the bill
function totalsOf(lines, taxRate, othersAmount = 0) {
  const gross = round(lines.reduce((t, l) => t + l.amount, 0), 2);
  const tax = round((gross * taxRate) / 100, 2);
  const others = round(Number(othersAmount) || 0, 2);
  return { gross, tax, others, net: round(gross + tax + others, 2) };
}

async function writeLines(invoiceId, companyId, lines, transaction) {
  await sequelize.query('DELETE FROM sales_invoice_lines WHERE "invoiceId" = :invoiceId', { replacements: { invoiceId }, transaction });
  let lineNo = 0;
  for (const l of lines) {
    lineNo += 1;
    await sequelize.query(`INSERT INTO sales_invoice_lines ("invoiceId", "companyId", "lineNo", "gatePassId", "packingListId", "qtyA", "qtyB", "qtyCP", "rateA", "rateB", "rateCP", "billedQty", amount)
      VALUES (:invoiceId, :companyId, :lineNo, :gatePassId, :packingListId, :qtyA, :qtyB, :qtyCP, :rateA, :rateB, :rateCP, :billedQty, :amount)`,
    { replacements: { ...l, invoiceId, companyId, lineNo }, transaction }); // the gate pass row has its own "invoiceId" (the invoice it is on): ours must win
  }
}

const COLS = `i.id, i."voucherNo", i."invoiceNo", to_char(i."invoiceDate", 'YYYY-MM-DD') AS "invoiceDate", to_char(i."dueDate", 'YYYY-MM-DD') AS "storedDue",
  to_char(COALESCE(i."dueDate", i."invoiceDate" + c."creditDays"), 'YYYY-MM-DD') AS "dueDate", i.notes, i."invoiceDetails", i."hsCode", i."taxRate"::float AS "taxRate", i."othersAmount"::float AS others, i."othersNote",
  i."grossAmount"::float AS gross, i."taxAmount"::float AS tax, i."netAmount"::float AS net, i."receivedAmount"::float AS received, i.status, i."approvedAt", i."createdAt", i."updatedAt",
  c.id AS "customerId", c.code AS "customerCode", c.name AS "customerName", c.ntn AS "customerNtn", c.address AS "customerAddress", c.city AS "customerCity",
  (SELECT COALESCE(SUM(l."billedQty"), 0)::float FROM sales_invoice_lines l WHERE l."invoiceId" = i.id) AS qty,
  ab.name AS "approvedByName"`;
const FROM = `FROM sales_invoices i JOIN customers c ON c.id = i."customerId" LEFT JOIN users ab ON ab.id = i."approvedById"`;

function invoiceJson(r) {
  return {
    id: r.id, voucherNo: r.voucherNo, voucherLabel: label(r.voucherNo), invoiceNo: r.invoiceNo, invoiceLabel: label(r.invoiceNo), invoiceDate: r.invoiceDate, dueDate: r.dueDate,
    isOverdue: r.status === 'APPROVED' && r.net - r.received > 0 && r.dueDate < today(),
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName, ntn: r.customerNtn, address: r.customerAddress, city: r.customerCity },
    notes: r.notes, invoiceDetails: r.invoiceDetails, hsCode: r.hsCode, taxRate: r.taxRate, othersAmount: r.others, othersNote: r.othersNote, othersEffect: 'ADD',
    qty: round(r.qty), gross: r.gross, tax: r.tax, net: r.net, received: r.received, balance: round(r.net - r.received),
    paymentStatus: r.received <= 0 ? 'UNPAID' : r.received >= r.net ? 'PAID' : 'PARTIAL',
    status: r.status, statusText: STATUS_TEXT[r.status], approvedAt: r.approvedAt, approvedBy: r.approvedAt ? { name: r.approvedByName } : null,
    canEdit: r.status === 'UNAPPROVED', canDelete: r.status === 'UNAPPROVED', canApprove: r.status === 'UNAPPROVED', canUnapprove: r.status === 'APPROVED' && r.received === 0,
    // the Billora / FBR upload comes in a later step
    fbrStatus: null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function load(req, id, transaction, lock = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE i.id = :id AND i."companyId" = :companyId${lock ? ' FOR UPDATE OF i' : ''}`, { id, companyId: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Sales invoice');
  return r;
}

async function get(req, id, transaction) {
  const inv = invoiceJson(await load(req, id, transaction));
  inv.creditWarning = await credit.warning(req, 'CUSTOMER', inv.customer.id, { status: inv.status, net: inv.net }, transaction); // over the customer's credit limit, or null
  const stored = await q(`SELECT "gatePassId", "lineNo", "qtyA"::float AS "qtyA", "qtyB"::float AS "qtyB", "qtyCP"::float AS "qtyCP", "rateA"::float AS "rateA", "rateB"::float AS "rateB",
      "rateCP"::float AS "rateCP", "billedQty"::float AS "billedQty", amount::float AS amount FROM sales_invoice_lines WHERE "invoiceId" = :id ORDER BY "lineNo"`, { id }, transaction);
  const live = await describe(req, stored.length ? await q(`${GATE_SQL} AND g.id IN (:ids) ${GATE_GROUP}`, { companyId: req.user.companyId, ids: stored.map((s) => s.gatePassId) }, transaction) : [], transaction);
  inv.lines = stored.map((s) => {
    const g = live.find((x) => x.gatePassId === s.gatePassId);
    // the numbers are the ones saved on the invoice; the descriptions come from the gate pass
    return { lineNo: s.lineNo, ...gateLine({ ...g, ...s }) };
  });
  // the money received against the invoice: the confirmed receipt vouchers (the "Payments" tab)
  inv.payments = (await q(`SELECT rv.id AS "voucherId", rv."voucherNo", to_char(rv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", rv."paymentMode", rv."chequeNo",
      l."chequeAmount"::float AS "chequeAmount", l."incomeTaxAmount"::float AS "incomeTax", l."billAmount"::float AS "billAmount"
    FROM receipt_voucher_lines l JOIN receipt_vouchers rv ON rv.id = l."voucherId" WHERE l."salesInvoiceId" = :id AND rv.status = 'CONFIRMED' ORDER BY rv."voucherDate", rv."voucherNo"`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'RECEIPT', voucherLabel: label(p.voucherNo) }));
  // money settled by a contra voucher (a customer's money applied to a vendor's bill) is also a receipt against the invoice
  const contra = (await q(`SELECT cv.id AS "voucherId", cv."voucherNo", to_char(cv."voucherDate", 'YYYY-MM-DD') AS "voucherDate", 'CONTRA' AS "paymentMode", NULL AS "chequeNo",
      l.amount::float AS "chequeAmount", 0::float AS "incomeTax", l.amount::float AS "billAmount"
    FROM contra_voucher_lines l JOIN contra_vouchers cv ON cv.id = l."voucherId" WHERE l."salesInvoiceId" = :id AND cv.status = 'CONFIRMED'`, { id }, transaction))
    .map((p) => ({ ...p, voucherType: 'CONTRA', voucherLabel: label(p.voucherNo) }));
  inv.payments = [...inv.payments, ...contra].sort((a, b) => (a.voucherDate < b.voucherDate ? -1 : a.voucherDate > b.voucherDate ? 1 : a.voucherNo - b.voucherNo));
  return inv;
}

function options() {
  return { statuses: Object.entries(STATUS_TEXT).map(([code, text]) => ({ code, text })), taxRates: [0, 5, 10, 15, 18], defaultTaxRate: DEFAULT_TAX_RATE, defaultHsCode: DEFAULT_HS_CODE };
}

async function list(req, { page, limit, status, dateFrom, dateTo, customerId, search }) {
  const where = ['i."companyId" = :companyId'];
  const r = { companyId: req.user.companyId };
  if (status) { where.push('i.status = :status'); r.status = status; }
  if (dateFrom) { where.push('i."invoiceDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('i."invoiceDate" <= :dateTo'); r.dateTo = dateTo; }
  if (customerId) { where.push('i."customerId" = :customerId'); r.customerId = customerId; }
  if (search) {
    r.like = `%${search.trim()}%`;
    const numeric = /^\d+$/.test(search.trim()) ? ' OR i."invoiceNo" = :n OR i."voucherNo" = :n' : '';
    if (numeric) r.n = Number(search.trim());
    where.push(`(c.name ILIKE :like OR c.ntn ILIKE :like OR i."hsCode" ILIKE :like OR i."invoiceDetails" ILIKE :like OR i.notes ILIKE :like${numeric})`);
  }
  const w = where.join(' AND ');
  const [sum] = await q(`SELECT count(*)::int AS invoices, COALESCE(SUM(i."grossAmount"), 0)::float AS amount, COALESCE(SUM(i."taxAmount"), 0)::float AS tax,
      COALESCE(SUM(i."netAmount"), 0)::float AS net, COALESCE(SUM(i."receivedAmount"), 0)::float AS received FROM sales_invoices i JOIN customers c ON c.id = i."customerId" WHERE ${w}`, r);
  const rows = await q(`SELECT ${COLS} ${FROM} WHERE ${w} ORDER BY i."invoiceNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map(invoiceJson), page, limit, total: sum.invoices,
    summary: { invoices: sum.invoices, amount: round(sum.amount), tax: round(sum.tax), net: round(sum.net), received: round(sum.received), balance: round(sum.net - sum.received) },
  };
}

async function customerOr404(req, customerId, transaction) {
  const [c] = await q('SELECT id, name FROM customers WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id: customerId, companyId: req.user.companyId }, transaction);
  if (!c) throw AppError.notFound('Customer');
  return c;
}

const nextNo = async (column, companyId, transaction) => ((await q(`SELECT MAX("${column}") AS m FROM sales_invoices WHERE "companyId" = :companyId`, { companyId }, transaction))[0].m || 0) + 1;

async function create(req, data) {
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    await lockSales(companyId, transaction);
    await customerOr404(req, data.customerId, transaction);
    const lines = await buildLines(req, data.customerId, data.gatePassIds, null, transaction);
    const taxRate = data.taxRate ?? DEFAULT_TAX_RATE;
    const totals = totalsOf(lines, taxRate, data.othersAmount);
    const invoiceNo = data.invoiceNo || (await nextNo('invoiceNo', companyId, transaction));
    if ((await q('SELECT 1 FROM sales_invoices WHERE "companyId" = :companyId AND "invoiceNo" = :invoiceNo', { companyId, invoiceNo }, transaction)).length) {
      throw AppError.rule('INVOICE_NO_TAKEN', `Invoice number ${label(invoiceNo)} is already used`);
    }
    const voucherNo = await nextNo('voucherNo', companyId, transaction);
    const invoiceDate = data.invoiceDate || today();
    const dueDate = data.dueDate || (await credit.defaultDueDate(companyId, 'CUSTOMER', data.customerId, invoiceDate, transaction));
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    // the three default accounts exist from the first invoice on (found if the company has them, made if not); a draft posts nothing to them
    await accounts.ensureDefault(req, 'CUSTOMERS', transaction);
    await accounts.ensureDefault(req, 'SALES', transaction);
    await accounts.ensureDefault(req, 'OUTPUT_TAX', transaction);
    const [{ id: newId }] = await q(`INSERT INTO sales_invoices ("companyId", "voucherNo", "invoiceNo", "invoiceDate", "dueDate", "customerId", notes, "invoiceDetails", "hsCode", "taxRate",
        "othersAmount", "othersNote", "grossAmount", "taxAmount", "netAmount", "createdById", "updatedById")
      VALUES (:companyId, :voucherNo, :invoiceNo, :invoiceDate, :dueDate, :customerId, :notes, :invoiceDetails, :hsCode, :taxRate, :others, :othersNote, :gross, :tax, :net, :userId, :userId) RETURNING id`,
    { companyId, voucherNo, invoiceNo, invoiceDate, dueDate, customerId: data.customerId, notes: data.notes || null, invoiceDetails: data.invoiceDetails || null,
      hsCode: data.hsCode === undefined ? DEFAULT_HS_CODE : data.hsCode || null, taxRate, othersNote: data.othersNote || null, ...totals, userId: req.user.id }, transaction);
    await writeLines(newId, companyId, lines, transaction);
    await audit.log(req, { action: 'SALES_INVOICE_CREATED', entityType: 'SalesInvoice', entityId: newId, after: { invoiceNo, voucherNo, customerId: data.customerId, gatePasses: lines.length, ...totals } }, { transaction });
    return newId;
  });
  return get(req, id);
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockSales(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be changed. Un-approve it first');
    const customerId = changes.customerId ?? cur.customerId;
    if (changes.customerId && changes.customerId !== cur.customerId) {
      await customerOr404(req, customerId, transaction);
      if (!changes.gatePassIds) throw AppError.rule('GATE_PASSES_REQUIRED', 'The customer changed: choose the gate passes of the new customer');
    }
    const ids = changes.gatePassIds || (await q('SELECT "gatePassId" FROM sales_invoice_lines WHERE "invoiceId" = :id', { id }, transaction)).map((l) => l.gatePassId);
    const lines = await buildLines(req, customerId, ids, id, transaction);
    const taxRate = changes.taxRate ?? cur.taxRate;
    const totals = totalsOf(lines, taxRate, changes.othersAmount ?? cur.others);
    let invoiceNo = cur.invoiceNo;
    if (changes.invoiceNo && changes.invoiceNo !== cur.invoiceNo) {
      if ((await q('SELECT 1 FROM sales_invoices WHERE "companyId" = :companyId AND "invoiceNo" = :n AND id <> :id', { companyId, n: changes.invoiceNo, id }, transaction)).length) {
        throw AppError.rule('INVOICE_NO_TAKEN', `Invoice number ${label(changes.invoiceNo)} is already used`);
      }
      invoiceNo = changes.invoiceNo;
    }
    const pick = (k, old) => (changes[k] === undefined ? old : changes[k] || null);
    const invoiceDate = changes.invoiceDate || cur.invoiceDate;
    // a typed due date wins; an empty one (or a new date / customer without one) is worked out again from the customer's credit days; otherwise it stays
    const redo = changes.dueDate === undefined ? Boolean(changes.invoiceDate || changes.customerId) : !changes.dueDate;
    const dueDate = changes.dueDate || (redo ? await credit.defaultDueDate(companyId, 'CUSTOMER', customerId, invoiceDate, transaction) : cur.storedDue);
    if (dueDate && dueDate < invoiceDate) throw AppError.rule('DUE_BEFORE_DATE', 'The due date cannot be before the invoice date');
    await writeLines(id, companyId, lines, transaction);
    await sequelize.query(`UPDATE sales_invoices SET "invoiceNo" = :invoiceNo, "invoiceDate" = :invoiceDate, "dueDate" = :dueDate, "customerId" = :customerId, notes = :notes, "invoiceDetails" = :invoiceDetails,
        "hsCode" = :hsCode, "taxRate" = :taxRate, "othersAmount" = :others, "othersNote" = :othersNote, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`,
    { replacements: { id, invoiceNo, invoiceDate, dueDate, customerId, notes: pick('notes', cur.notes), invoiceDetails: pick('invoiceDetails', cur.invoiceDetails),
      hsCode: pick('hsCode', cur.hsCode), taxRate, othersNote: pick('othersNote', cur.othersNote), ...totals, userId: req.user.id }, transaction });
    await audit.log(req, {
      action: 'SALES_INVOICE_UPDATED', entityType: 'SalesInvoice', entityId: id,
      before: { invoiceNo: cur.invoiceNo, gross: cur.gross, tax: cur.tax, net: cur.net, taxRate: cur.taxRate }, after: { invoiceNo, gatePasses: lines.length, ...totals, taxRate },
    }, { transaction });
  });
  return get(req, id);
}

async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    await lockSales(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('INVOICE_APPROVED', 'An approved invoice cannot be deleted. Un-approve it first');
    await sequelize.query('DELETE FROM sales_invoices WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'SALES_INVOICE_DELETED', entityType: 'SalesInvoice', entityId: id, before: { invoiceNo: cur.invoiceNo, voucherNo: cur.voucherNo, net: cur.net } }, { transaction });
  });
}

/** Posts the accounting entry. The three default accounts are found (or made) here; amounts are worked out again from the gate passes first. */
async function approve(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lockSales(companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status === 'APPROVED') throw AppError.rule('ALREADY_APPROVED', 'This invoice is already approved');
    const ids = (await q('SELECT "gatePassId" FROM sales_invoice_lines WHERE "invoiceId" = :id', { id }, transaction)).map((l) => l.gatePassId);
    if (!ids.length) throw AppError.rule('NO_LINES', 'The invoice has no gate passes');
    const lines = await buildLines(req, cur.customerId, ids, id, transaction);
    const totals = totalsOf(lines, cur.taxRate, cur.others);
    if (!(totals.net > 0)) throw AppError.rule('NOTHING_TO_BILL', 'The invoice amount is zero');
    await writeLines(id, companyId, lines, transaction);

    const receivable = await accounts.ensureDefault(req, 'CUSTOMERS', transaction);
    const sales = await accounts.ensureDefault(req, 'SALES', transaction);
    const taxAccount = totals.tax > 0 ? await accounts.ensureDefault(req, 'OUTPUT_TAX', transaction) : null;
    const narration = `Sales invoice ${label(cur.invoiceNo)} - ${cur.customerName}`;
    const entry = await journal.post(req, {
      entryDate: cur.invoiceDate, sourceType: SOURCE, sourceId: id, narration,
      lines: [
        { accountId: receivable, debit: totals.net, partyType: 'CUSTOMER', partyId: cur.customerId, narration },
        { accountId: sales, credit: totals.gross, narration },
        // an extra charge on the bill: credited to the sales account on its own line, with the reason
        ...(totals.others > 0 ? [{ accountId: sales, credit: totals.others, narration: `${narration}: others${cur.othersNote ? ` - ${cur.othersNote}` : ''}` }] : []),
        ...(taxAccount ? [{ accountId: taxAccount, credit: totals.tax, narration: `${narration} (sales tax ${cur.taxRate}%)` }] : []),
      ],
    }, transaction);
    await sequelize.query(`UPDATE sales_invoices SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = :userId, "grossAmount" = :gross, "taxAmount" = :tax, "netAmount" = :net,
      "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id, ...totals }, transaction });
    await audit.log(req, { action: 'SALES_INVOICE_APPROVED', entityType: 'SalesInvoice', entityId: id, after: { invoiceNo: cur.invoiceNo, journalEntryNo: entry.entryNo, ...totals } }, { transaction });
  });
  return get(req, id);
}

/** Takes the invoice back to un-approved: the entry is reversed (both stay in the books) and the invoice may be changed again. */
async function unapprove(req, id, { reason } = {}) {
  await sequelize.transaction(async (transaction) => {
    await lockSales(req.user.companyId, transaction);
    const cur = await load(req, id, transaction, true);
    if (cur.status !== 'APPROVED') throw AppError.rule('NOT_APPROVED', 'This invoice is not approved');
    if (cur.received > 0) throw AppError.rule('HAS_RECEIPTS', 'Money was received against this invoice; it cannot be un-approved');
    const [entry] = await q(`SELECT id, "entryNo" FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`,
      { companyId: req.user.companyId, source: SOURCE, id }, transaction);
    if (!entry) throw AppError.rule('NO_ENTRY', 'The accounting entry of this invoice was not found');
    const reversal = await journal.reverse(req, entry.id, { reason: reason || `invoice ${label(cur.invoiceNo)} un-approved` }, transaction); // dated like the entry it reverses
    await sequelize.query(`UPDATE sales_invoices SET status = 'UNAPPROVED', "approvedAt" = NULL, "approvedById" = NULL, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id`, { replacements: { id, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'SALES_INVOICE_UNAPPROVED', entityType: 'SalesInvoice', entityId: id, after: { invoiceNo: cur.invoiceNo, reversedEntryNo: entry.entryNo, reversalEntryNo: reversal.entryNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

/** The "Accounts" button: the entries of the invoice. `current` is the live posting (null while un-approved). */
async function accountsEntry(req, id) {
  const inv = await load(req, id);
  const entries = await journal.entriesOfSource(req, SOURCE, id);
  const current = entries.find((e) => e.status === 'POSTED' && !e.reversalOfId) || null;
  return { invoiceId: id, invoiceLabel: label(inv.invoiceNo), status: inv.status, posted: Boolean(current), current, entries };
}

const creditOf = (req, customerId) => credit.publicStatus(req, 'CUSTOMER', customerId);

module.exports = { creditOf, options, gatePasses, list, get, create, update, remove, approve, unapprove, accountsEntry };
