// Store reports and ledgers (owner 2026-10-22). Service STORE_REPORTS, read only, same answer shape as the
// other reports (see reportService): { title, generatedAt, filters, sections, page, limit, total, export }.
//   day-book        every stock movement (purchase, issue, return, adjustment, correction) with the running stock
//   item-ledger     one chemical: opening, every movement with balance, closing
//   stock-on-date   stock of every item on a given day
//   stock-summary   opening + purchased - issued + returned +/- adjusted = closing, per item, for a period
//   purchases       per vendor, per chemical, rates (same chemical at different rates / from different vendors)
//   vendor-ledger   one vendor: every purchase line and the running total
//   inwards         the inward entries register (drafts included)
//   issues          what departments took: dept, Job#, SO#, operator, requested / issued / short / returned, cost, stock before and after
//   operators       per operator: requested, issued, short, returned, used
//   returns         chemicals sent back by departments
//   vendor-returns bought stock sent back to vendors
//   stock-ageing    age of the stock in the store (by purchase date), non-moving stock
//   monthly-summary month by month purchased / issued / returned / adjusted
//   adjustments     stock adjustments (count, damage, expiry ...) with stock before and after
//   low-stock       items at or below their minimum stock
//   batch-stock     stock batch by batch (vendor, rate, age)
//   stock-audit     do the books agree (stock = movements = batches, issues costed from batches ...)
// A movement is dated by its own date; a corrected purchase carries the date of the purchase.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');

const { round } = require('../utils/money');
const { today } = require('../utils/dates');
const q = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const col = (key, label, type = 'text') => ({ key, label, type });
const KIND_TEXT = { INWARD: 'Purchase', INWARD_UNDO: 'Purchase undone', INWARD_EDIT: 'Purchase corrected', VENDOR_RETURN: 'Returned to vendor', VENDOR_RETURN_UNDO: 'Vendor return cancelled', ISSUE: 'Issued to department', RETURN: 'Returned by department', ADJUST: 'Stock adjustment' };
const STATUS_TEXT = { PENDING: 'Pending', ACCEPTED: 'Accepted', IN_WAY: 'In-Way', DELIVERED: 'Delivered', CANCELLED: 'Cancelled', REJECTED: 'Rejected', RECEIVED: 'Received' };

function section(key, title, columns, rows, sum = []) {
  const totals = {};
  for (const k of sum) totals[k] = round(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0), 3);
  return { key, title, columns, rows, totals };
}
function respond(title, filters, sections, f) {
  const first = sections[0];
  const total = first ? first.rows.length : 0;
  const page = f.page || 1;
  const limit = f.limit || 100;
  if (first && !f.export) first.rows = first.rows.slice((page - 1) * limit, page * limit);
  return { title, generatedAt: new Date().toISOString(), filters, sections, page, limit: f.export ? total : limit, total, export: Boolean(f.export) };
}
const NAME = (store) => (store === 'CHEMICAL' ? 'Chemical' : 'Item');

/* running stock of every item, then the wanted window of movements */
const MOVES = `
  SELECT mv.*, SUM(mv.qty) OVER w AS "balQty", SUM(mv.value) OVER w AS "balValue"
  FROM store_moves mv WHERE mv."companyId" = :companyId AND mv.store = :store
  WINDOW w AS (PARTITION BY mv."itemId" ORDER BY mv."moveDate", mv."createdAt", mv.id)`;

async function movements(companyId, store, f) {
  const rep = { companyId, store };
  const where = [];
  if (f.dateFrom) { where.push('m."moveDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('m."moveDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.itemId) { where.push('m."itemId" = :itemId'); rep.itemId = f.itemId; }
  if (f.categoryId) { where.push('it."categoryId" = :categoryId'); rep.categoryId = f.categoryId; }
  if (f.departmentId) { where.push('m."departmentId" = :departmentId'); rep.departmentId = f.departmentId; }
  if (f.vendorId) { where.push('COALESCE(inw."vendorId", vr."vendorId") = :vendorId'); rep.vendorId = f.vendorId; }
  if (f.kind) { where.push('m.kind = :kind'); rep.kind = f.kind; }
  if (f.jobNo) { where.push('j."jobNo" = :jobNo'); rep.jobNo = f.jobNo; }
  const rows = await q(`
    WITH m AS (${MOVES})
    SELECT m.id, m."moveDate", m."createdAt", m.kind, m.qty::float AS qty, m.value::float AS value, m."balQty"::float AS "balQty", m."balValue"::float AS "balValue",
           it.id AS "itemId", it.name AS item, it.unit, c.name AS category, b.name AS brand,
           inw."ipNo", inw."dcNo", COALESCE(v.name, vrv.name) AS vendor, vr."returnNo" AS "vrNo", vr.reason AS "vrReason", dep.name AS department,
           r."reqNo", j."jobNo", j."operatorName" AS operator, ru.name AS "requestedBy", mu.name AS "doneBy",
           COALESCE(sc."cardNo"::text, (SELECT string_agg(DISTINCT s2."cardNo"::text, ', ') FROM job_items ji JOIN so_cards s2 ON s2.id = ji."soCardId" WHERE ji."jobId" = r."jobId")) AS "soNos",
           rt."returnNo", adj."adjNo", adj.reason AS "adjReason"
    FROM m JOIN store_items it ON it.id = m."itemId"
    LEFT JOIN store_categories c ON c.id = it."categoryId" LEFT JOIN store_brands b ON b.id = it."brandId"
    LEFT JOIN store_inwards inw ON inw.id = m."inwardId" LEFT JOIN vendors v ON v.id = inw."vendorId"
    LEFT JOIN store_vendor_returns vr ON vr.id = m."vendorReturnId" LEFT JOIN vendors vrv ON vrv.id = vr."vendorId"
    LEFT JOIN services dep ON dep.id = m."departmentId"
    LEFT JOIN chemical_requests r ON r.id = m."requestId" LEFT JOIN jobs j ON j.id = r."jobId" LEFT JOIN so_cards sc ON sc.id = r."soCardId"
    LEFT JOIN users ru ON ru.id = r."requestedById" LEFT JOIN users mu ON mu.id = m."createdById"
    LEFT JOIN chemical_returns rt ON rt.id = m."returnId" LEFT JOIN store_adjustments adj ON adj.id = m."adjustmentId"
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m."moveDate", m."createdAt", m.id`, rep);
  return rows.map((r) => ({
    date: r.moveDate, kindText: KIND_TEXT[r.kind] || r.kind, category: r.category, item: r.item, unit: r.unit, brand: r.brand,
    qtyIn: r.qty > 0 ? r.qty : 0, qtyOut: r.qty < 0 ? -r.qty : 0, value: r.value, balQty: round(r.balQty, 3), balValue: round(r.balValue),
    rate: r.qty ? round(Math.abs(r.value / r.qty), 4) : 0,
    ipNo: r.ipNo, dcNo: r.dcNo, vendor: r.vendor, department: r.department, reqNo: r.reqNo, jobNo: r.jobNo, soNos: r.soNos, operator: r.operator, requestedBy: r.requestedBy,
    returnNo: r.returnNo, adjNo: r.adjNo, vrNo: r.vrNo, reason: r.adjReason || r.vrReason, doneBy: r.doneBy, itemId: r.itemId, kind: r.kind, createdAt: r.createdAt,
  }));
}

const DAYBOOK_COLS = (store) => [col('date', 'Date', 'date'), col('kindText', 'Entry'), col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'),
  col('qtyIn', 'In', 'number'), col('qtyOut', 'Out', 'number'), col('rate', 'Rate', 'money'), col('value', 'Value', 'money'), col('balQty', 'Stock after', 'number'), col('balValue', 'Stock value after', 'money'),
  col('vendor', 'Vendor'), col('ipNo', 'IP#', 'number'), col('dcNo', 'DC#'), col('department', 'Department'), col('reqNo', 'Req#', 'number'), col('jobNo', 'Job#', 'number'), col('soNos', 'SO#'),
  col('requestedBy', 'Requested by'), col('operator', 'Operator'), col('returnNo', 'Return#', 'number'), col('vrNo', 'Vendor return#', 'number'), col('adjNo', 'Adjust#', 'number'), col('reason', 'Reason'), col('doneBy', 'Done by')];

async function dayBook(req, store, f) {
  const rows = await movements(req.user.companyId, store, f);
  return respond(`${NAME(store)} day book`, f, [section('moves', 'Stock movements', DAYBOOK_COLS(store), rows, ['qtyIn', 'qtyOut', 'value'])], f);
}

/** One chemical: stock before the first day, every movement with its balance, stock at the end. */
async function itemLedger(req, store, f) {
  if (!f.itemId) throw AppError.rule('ITEM_REQUIRED', 'Select the chemical');
  const item = (await q('SELECT it.id, it.name, it.unit, it."stockQty"::float AS "stockQty", it."stockValue"::float AS "stockValue", c.name AS category FROM store_items it LEFT JOIN store_categories c ON c.id = it."categoryId" WHERE it.id = :itemId AND it."companyId" = :companyId AND it.store = :store',
    { itemId: f.itemId, companyId: req.user.companyId, store }))[0];
  if (!item) throw AppError.notFound('Item');
  const all = await movements(req.user.companyId, store, { itemId: f.itemId });
  const before = f.dateFrom ? all.filter((r) => String(r.date) < f.dateFrom) : [];
  const inside = all.filter((r) => (!f.dateFrom || String(r.date) >= f.dateFrom) && (!f.dateTo || String(r.date) <= f.dateTo));
  const last = (list) => (list.length ? list[list.length - 1] : null);
  const open = last(before) ? { qty: last(before).balQty, value: last(before).balValue } : { qty: 0, value: 0 };
  const close = last(inside) ? { qty: last(inside).balQty, value: last(inside).balValue } : open;
  const summary = [{ item: item.name, category: item.category, unit: item.unit, openingQty: open.qty, openingValue: open.value,
    purchased: round(inside.filter((r) => r.kind === 'INWARD' || r.kind === 'INWARD_EDIT' || r.kind === 'INWARD_UNDO').reduce((t, r) => t + r.qtyIn - r.qtyOut, 0), 3),
    issued: round(inside.filter((r) => r.kind === 'ISSUE').reduce((t, r) => t + r.qtyOut, 0), 3),
    vendorReturned: round(inside.filter((r) => r.kind === 'VENDOR_RETURN' || r.kind === 'VENDOR_RETURN_UNDO').reduce((t, r) => t + r.qtyOut - r.qtyIn, 0), 3),
    returned: round(inside.filter((r) => r.kind === 'RETURN').reduce((t, r) => t + r.qtyIn, 0), 3),
    adjusted: round(inside.filter((r) => r.kind === 'ADJUST').reduce((t, r) => t + r.qtyIn - r.qtyOut, 0), 3),
    closingQty: close.qty, closingValue: close.value, stockNow: item.stockQty }];
  const sCols = [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('openingQty', 'Opening', 'number'), col('purchased', 'Purchased', 'number'), col('issued', 'Issued', 'number'),
    col('returned', 'Returned by dept', 'number'), col('vendorReturned', 'Returned to vendor', 'number'), col('adjusted', 'Adjusted', 'number'), col('closingQty', 'Closing', 'number'), col('closingValue', 'Closing value', 'money')];
  const first = section('summary', 'Summary', sCols, summary);
  const ledger = section('ledger', 'Ledger', DAYBOOK_COLS(store), inside, ['qtyIn', 'qtyOut', 'value']);
  const out = respond(`${item.name}: stock ledger`, f, [ledger, first], f);
  return out;
}

/** Stock of every item on one day (and its value), from the movements up to that day. */
async function stockOnDate(req, store, f) {
  const date = f.date || f.dateTo;
  if (!date) throw AppError.rule('DATE_REQUIRED', 'Select the date');
  const rep = { companyId: req.user.companyId, store, date };
  let more = '';
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  if (f.itemId) { more += ' AND it.id = :itemId'; rep.itemId = f.itemId; }
  const rows = await q(`
    SELECT c.name AS category, b.name AS brand, it.name AS item, it.unit, COALESCE(SUM(mv.qty), 0)::float AS qty, COALESCE(SUM(mv.value), 0)::float AS value
    FROM store_items it LEFT JOIN store_moves mv ON mv."itemId" = it.id AND mv."moveDate" <= :date
    LEFT JOIN store_categories c ON c.id = it."categoryId" LEFT JOIN store_brands b ON b.id = it."brandId"
    WHERE it."companyId" = :companyId AND it.store = :store ${more}
    GROUP BY c.name, b.name, it.name, it.unit ORDER BY c.name NULLS LAST, it.name`, rep);
  const data = rows.map((r) => ({ ...r, qty: round(r.qty, 3), value: round(r.value), rate: r.qty > 0 ? round(r.value / r.qty, 4) : 0 })).filter((r) => f.showZero || r.qty !== 0);
  const columns = [col('category', 'Category'), col('item', NAME(store)), col('brand', 'Brand'), col('unit', 'Unit'), col('qty', 'Stock', 'number'), col('rate', 'Average rate', 'money'), col('value', 'Stock value', 'money')];
  return respond(`${NAME(store)} stock on ${date}`, { ...f, date }, [section('stock', 'Stock', columns, data, ['value'])], f);
}

/** Opening, purchased, issued, returned, adjusted and closing per item for a period. */
async function stockSummary(req, store, f) {
  if (!f.dateFrom || !f.dateTo) throw AppError.rule('DATE_REQUIRED', 'Select the dates (from and to)');
  const rep = { companyId: req.user.companyId, store, dateFrom: f.dateFrom, dateTo: f.dateTo };
  let more = '';
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  if (f.itemId) { more += ' AND it.id = :itemId'; rep.itemId = f.itemId; }
  const rows = await q(`
    SELECT c.name AS category, it.name AS item, it.unit,
      COALESCE(SUM(mv.qty) FILTER (WHERE mv."moveDate" < :dateFrom), 0)::float AS "openingQty", COALESCE(SUM(mv.value) FILTER (WHERE mv."moveDate" < :dateFrom), 0)::float AS "openingValue",
      COALESCE(SUM(mv.qty) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind IN ('INWARD','INWARD_UNDO','INWARD_EDIT')), 0)::float AS purchased,
      COALESCE(SUM(mv.value) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind IN ('INWARD','INWARD_UNDO','INWARD_EDIT')), 0)::float AS "purchasedValue",
      COALESCE(-SUM(mv.qty) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind = 'ISSUE'), 0)::float AS issued,
      COALESCE(-SUM(mv.value) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind = 'ISSUE'), 0)::float AS "issuedValue",
      COALESCE(SUM(mv.qty) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind = 'RETURN'), 0)::float AS returned,
      COALESCE(-SUM(mv.qty) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind IN ('VENDOR_RETURN','VENDOR_RETURN_UNDO')), 0)::float AS "vendorReturned",
      COALESCE(-SUM(mv.value) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind IN ('VENDOR_RETURN','VENDOR_RETURN_UNDO')), 0)::float AS "vendorReturnedValue",
      COALESCE(SUM(mv.qty) FILTER (WHERE mv."moveDate" BETWEEN :dateFrom AND :dateTo AND mv.kind = 'ADJUST'), 0)::float AS adjusted,
      COALESCE(SUM(mv.qty) FILTER (WHERE mv."moveDate" <= :dateTo), 0)::float AS "closingQty", COALESCE(SUM(mv.value) FILTER (WHERE mv."moveDate" <= :dateTo), 0)::float AS "closingValue"
    FROM store_items it LEFT JOIN store_moves mv ON mv."itemId" = it.id LEFT JOIN store_categories c ON c.id = it."categoryId"
    WHERE it."companyId" = :companyId AND it.store = :store ${more}
    GROUP BY c.name, it.name, it.unit ORDER BY c.name NULLS LAST, it.name`, rep);
  const data = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round(v, 3) : v])))
    .filter((r) => ['openingQty', 'purchased', 'issued', 'returned', 'vendorReturned', 'adjusted', 'closingQty'].some((k) => r[k] !== 0));
  const columns = [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('openingQty', 'Opening', 'number'), col('purchased', 'Purchased', 'number'), col('issued', 'Issued', 'number'),
    col('returned', 'Returned by dept', 'number'), col('vendorReturned', 'Returned to vendor', 'number'), col('adjusted', 'Adjusted', 'number'), col('closingQty', 'Closing', 'number'), col('openingValue', 'Opening value', 'money'), col('purchasedValue', 'Purchased value', 'money'),
    col('issuedValue', 'Issued value', 'money'), col('vendorReturnedValue', 'Returned to vendor value', 'money'), col('closingValue', 'Closing value', 'money')];
  return respond(`${NAME(store)} stock summary ${f.dateFrom} to ${f.dateTo}`, f, [section('summary', 'Stock summary', columns, data, ['openingValue', 'purchasedValue', 'issuedValue', 'vendorReturnedValue', 'closingValue'])], f);
}

/* purchases: lines of approved inwards */
async function purchaseLines(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['i."companyId" = :companyId', 'i.store = :store', 'i."isApproved"'];
  if (f.dateFrom) { where.push('i."inwardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('i."inwardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.vendorId) { where.push('i."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  if (f.categoryId) { where.push('it."categoryId" = :categoryId'); rep.categoryId = f.categoryId; }
  return q(`SELECT i."inwardDate" AS date, i."ipNo", i."idNo", i."dcNo", i."vendorId", COALESCE(v.name, '(no vendor)') AS vendor, it.id AS "itemId", it.name AS item, it.unit, c.name AS category,
      l.qty::float AS qty, l.rate::float AS rate, l.amount::float AS amount
    FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId" LEFT JOIN vendors v ON v.id = i."vendorId"
    WHERE ${where.join(' AND ')} ORDER BY i."inwardDate", i."ipNo", l."sortOrder"`, rep);
}

/** Lines returned to vendors (posted returns only). */
async function vendorReturnLines(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['x."companyId" = :companyId', 'x.store = :store', "x.status = 'POSTED'"];
  if (f.dateFrom) { where.push('x."returnDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('x."returnDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.vendorId) { where.push('x."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  if (f.categoryId) { where.push('it."categoryId" = :categoryId'); rep.categoryId = f.categoryId; }
  return q(`SELECT x."returnDate" AS date, x."returnNo", x.reason, x."vendorId", v.name AS vendor, it.id AS "itemId", it.name AS item, it.unit, c.name AS category, i."ipNo", i."dcNo", i."inwardDate",
      l.qty::float AS qty, l.rate::float AS rate, l.value::float AS value, l."packType", l."packCount", l."qtyPerPack"::float AS "qtyPerPack"
    FROM store_vendor_return_lines l JOIN store_vendor_returns x ON x.id = l."returnId" JOIN vendors v ON v.id = x."vendorId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    JOIN store_inwards i ON i.id = l."inwardId" WHERE ${where.join(' AND ')} ORDER BY x."returnDate", x."returnNo"`, rep);
}

const groupBy = (rows, keyFn) => { const g = new Map(); for (const r of rows) { const k = keyFn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
const stats = (list) => {
  const qty = list.reduce((t, r) => t + r.qty, 0); const amount = list.reduce((t, r) => t + r.amount, 0);
  const rates = list.map((r) => round(r.rate, 4));
  return { purchases: list.length, qty: round(qty, 3), amount: round(amount), avgRate: qty ? round(amount / qty, 4) : 0, minRate: Math.min(...rates), maxRate: Math.max(...rates), distinctRates: new Set(rates).size };
};

async function purchases(req, store, f) {
  const lines = await purchaseLines(req, store, f);
  const rets = await vendorReturnLines(req, store, f);
  const retBy = (key) => { const g = groupBy(rets, key); return (k) => { const l = g.get(k) || []; return { returnedQty: round(l.reduce((t, r) => t + r.qty, 0), 3), returnedAmount: round(l.reduce((t, r) => t + r.value, 0)) }; }; };
  const retVendor = retBy((r) => r.vendor); const retItem = retBy((r) => r.itemId);
  const byVendor = [...groupBy(lines, (r) => r.vendor).entries()].map(([vendor, l]) => { const r = retVendor(vendor); return { vendor, chemicals: new Set(l.map((x) => x.itemId)).size, ...stats(l), ...r, netAmount: round(stats(l).amount - r.returnedAmount) }; }).sort((a, b) => b.amount - a.amount);
  const byItem = [...groupBy(lines, (r) => r.itemId).entries()].map(([id, l]) => ({ category: l[0].category, item: l[0].item, unit: l[0].unit, vendors: new Set(l.map((r) => r.vendor)).size, ...stats(l), ...retItem(id), netQty: round(stats(l).qty - retItem(id).returnedQty, 3),
    differentRates: new Set(l.map((r) => round(r.rate, 4))).size > 1 ? 'Yes' : 'No' })).sort((a, b) => a.item.localeCompare(b.item));
  const matrix = [...groupBy(lines, (r) => `${r.vendor}|${r.itemId}`).values()].map((l) => ({ vendor: l[0].vendor, category: l[0].category, item: l[0].item, unit: l[0].unit, ...stats(l) })).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.item.localeCompare(b.item));
  const stat = [col('purchases', 'Purchases', 'number'), col('qty', 'Qty', 'number'), col('avgRate', 'Avg rate', 'money'), col('minRate', 'Lowest rate', 'money'), col('maxRate', 'Highest rate', 'money'), col('distinctRates', 'Different rates', 'number'), col('amount', 'Amount', 'money')];
  return respond(`${NAME(store)} purchases`, f, [
    section('byVendor', 'By vendor', [col('vendor', 'Vendor'), col('chemicals', `${NAME(store)}s`, 'number'), col('purchases', 'Purchases', 'number'), col('amount', 'Amount', 'money'), col('returnedAmount', 'Returned to vendor', 'money'), col('netAmount', 'Net amount', 'money')], byVendor, ['amount', 'returnedAmount', 'netAmount']),
    section('byItem', `By ${NAME(store).toLowerCase()}`, [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('vendors', 'Vendors', 'number'), ...stat, col('returnedQty', 'Returned to vendor', 'number'), col('netQty', 'Net qty', 'number'), col('differentRates', 'Rates differ')], byItem, ['amount']),
    section('vendorItem', `Vendor x ${NAME(store).toLowerCase()}`, [col('vendor', 'Vendor'), col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), ...stat], matrix, ['amount']),
  ], { ...f, page: 1, limit: 100000, export: true });
}

async function vendorLedger(req, store, f) {
  if (!f.vendorId) throw AppError.rule('VENDOR_REQUIRED', 'Select the vendor');
  const vendor = (await q('SELECT id, code, name FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: f.vendorId, companyId: req.user.companyId }))[0];
  if (!vendor) throw AppError.notFound('Vendor');
  let run = 0;
  const buy = (await purchaseLines(req, store, f)).map((r) => ({ ...r, entry: 'Purchase', sort: `${r.date}|1|${r.ipNo}` }));
  const back = (await vendorReturnLines(req, store, f)).map((r) => ({ ...r, entry: `Return VR-${String(r.returnNo).padStart(5, '0')}`, qty: -r.qty, amount: -r.value, sort: `${r.date}|2|${r.returnNo}` }));
  const rows = [...buy, ...back].sort((a, b) => a.sort.localeCompare(b.sort)).map((r) => { run = round(run + r.amount); return { ...r, runningAmount: run }; });
  const columns = [col('date', 'Date', 'date'), col('entry', 'Entry'), col('ipNo', 'IP#', 'number'), col('dcNo', 'DC#'), col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('qty', 'Qty', 'number'), col('rate', 'Rate', 'money'), col('amount', 'Amount', 'money'), col('runningAmount', 'Balance (purchases less returns)', 'money')];
  return respond(`Vendor ledger: ${vendor.name} (${vendor.code})`, f, [section('lines', 'Purchases', columns, rows, ['qty', 'amount'])], f);
}

async function inwards(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['i."companyId" = :companyId', 'i.store = :store'];
  if (f.dateFrom) { where.push('i."inwardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('i."inwardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.vendorId) { where.push('i."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  const rows = (await q(`SELECT i."inwardDate" AS date, i."idNo", i."ipNo", i."dcNo", i."grnNo", v.name AS vendor, i."billType", i."totalQty"::float AS "totalQty", i.amount::float AS amount, i."salesTax"::float AS tax,
      i."isApproved" AS ok FROM store_inwards i LEFT JOIN vendors v ON v.id = i."vendorId" WHERE ${where.join(' AND ')} ORDER BY i."inwardDate", i."idNo"`, rep))
    .map((r) => ({ ...r, billed: round(r.amount + r.tax), status: r.ok ? 'Approved' : 'Draft' }));
  const columns = [col('date', 'Date', 'date'), col('idNo', 'ID#', 'number'), col('ipNo', 'IP#', 'number'), col('dcNo', 'DC#'), col('grnNo', 'GRN#'), col('vendor', 'Vendor'), col('billType', 'Bill'), col('totalQty', 'Qty', 'number'),
    col('amount', 'Amount', 'money'), col('tax', 'Sales tax', 'money'), col('billed', 'Billed', 'money'), col('status', 'Status')];
  return respond(`${NAME(store)} inwards`, f, [section('inwards', 'Inwards', columns, rows, ['amount', 'tax', 'billed'])], f);
}

/* ---- what departments took (chemical store only) ---- */

/** One row per sent request line, with the stock before and after the issue. */
async function issueLines(req, f) {
  const rep = { companyId: req.user.companyId };
  const where = ['r."companyId" = :companyId', 'r."sentAt" IS NOT NULL'];
  if (f.dateFrom) { where.push(`(r."sentAt" AT TIME ZONE 'Asia/Karachi')::date >= :dateFrom`); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push(`(r."sentAt" AT TIME ZONE 'Asia/Karachi')::date <= :dateTo`); rep.dateTo = f.dateTo; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  if (f.categoryId) { where.push('it."categoryId" = :categoryId'); rep.categoryId = f.categoryId; }
  if (f.departmentId) { where.push('r."departmentId" = :departmentId'); rep.departmentId = f.departmentId; }
  if (f.jobNo) { where.push('j."jobNo" = :jobNo'); rep.jobNo = f.jobNo; }
  if (f.operator) { where.push('(ru.name ILIKE :op OR j."operatorName" ILIKE :op)'); rep.op = `%${f.operator}%`; }
  const rows = await q(`
    WITH m AS (${MOVES.replace(':store', "'CHEMICAL'")})
    SELECT r.id AS "requestId", r."reqNo", r."sentAt", r."requestedAt", r."jobId", r."soCardId", dep.name AS department, j."jobNo", j."operatorName" AS operator, ru.name AS "requestedBy",
           it.id AS "itemId", it.name AS item, it.unit, c.name AS category, l.qty::float AS requested, COALESCE(l."sentQty", 0)::float AS issued, l."returnedQty"::float AS returned,
           l.value::float AS value, l."returnedValue"::float AS "returnedValue",
           (SELECT (mv."balQty" - mv.qty)::float FROM m mv WHERE mv."requestId" = r.id AND mv."itemId" = l."itemId" AND mv.kind = 'ISSUE' LIMIT 1) AS "stockBefore",
           (SELECT mv."balQty"::float FROM m mv WHERE mv."requestId" = r.id AND mv."itemId" = l."itemId" AND mv.kind = 'ISSUE' LIMIT 1) AS "stockAfter"
    FROM chemical_request_lines l JOIN chemical_requests r ON r.id = l."requestId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    JOIN services dep ON dep.id = r."departmentId" LEFT JOIN jobs j ON j.id = r."jobId" LEFT JOIN users ru ON ru.id = r."requestedById"
    WHERE ${where.join(' AND ')} ORDER BY r."sentAt", r."reqNo"`, rep);
  const ids = [...new Set(rows.map((r) => r.jobId).filter(Boolean))];
  const cards = ids.length ? await q(`SELECT ji."jobId", sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn", SUM(ji.meters)::float AS meters FROM job_items ji JOIN so_cards sc ON sc.id = ji."soCardId" WHERE ji."jobId" IN (:ids) GROUP BY ji."jobId", sc.id, sc."cardNo", sc."isGreyReturn"`, { ids }) : [];
  return rows.map((r) => {
    const mine = cards.filter((c) => c.jobId === r.jobId && (!r.soCardId || c.soCardId === r.soCardId));
    const total = mine.reduce((t, c) => t + c.meters, 0);
    const net = r.value - r.returnedValue;
    return { ...r, short: round(Math.max(0, r.requested - r.issued), 3), netQty: round(r.issued - r.returned, 3), net,
      soNos: mine.map((c) => c.cardNo).sort((a, b) => a - b).join(', '), shares: mine.map((c) => ({ cardNo: c.cardNo, f: total ? c.meters / total : 0 })) };
  });
}

async function issues(req, store, f) {
  const lines = await issueLines(req, f);
  const base = lines.map((r) => ({ date: r.sentAt, reqNo: r.reqNo, department: r.department, jobNo: r.jobNo, soNos: r.soNos, requestedBy: r.requestedBy, operator: r.operator, category: r.category, item: r.item, unit: r.unit,
    requested: r.requested, issued: r.issued, short: r.short, returned: r.returned, netQty: r.netQty, rate: r.issued ? round(r.value / r.issued, 4) : 0, cost: round(r.net), stockBefore: r.stockBefore, stockAfter: r.stockAfter }));
  const g = f.groupBy || 'none';
  const detailCols = [col('date', 'Sent', 'datetime'), col('reqNo', 'Req#', 'number'), col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('soNos', 'SO#'), col('requestedBy', 'Requested by'), col('operator', 'Operator'),
    col('category', 'Category'), col('item', 'Chemical'), col('unit', 'Unit'), col('requested', 'Requested', 'number'), col('issued', 'Issued', 'number'), col('short', 'Short', 'number'), col('returned', 'Returned', 'number'),
    col('netQty', 'Used', 'number'), col('rate', 'Rate', 'money'), col('cost', 'Cost', 'money'), col('stockBefore', 'Stock before', 'number'), col('stockAfter', 'Stock after', 'number')];
  if (g === 'none') return respond('Chemicals issued to departments', f, [section('issues', 'Issues', detailCols, base, ['requested', 'issued', 'short', 'returned', 'netQty', 'cost'])], f);
  // grouped: a job without its own SO card is split between its SO cards by meters
  const out = new Map();
  const add = (key, make, qty, cost) => { const x = out.get(key) || { ...make, netQty: 0, cost: 0, lines: 0 }; x.netQty = round(x.netQty + qty, 3); x.cost = round(x.cost + cost); x.lines += 1; out.set(key, x); };
  for (const r of lines) {
    if (g === 'so_card') {
      const parts = r.shares.length ? r.shares : [{ cardNo: null, f: 1 }];
      for (const p of parts) add(`${p.cardNo}|${r.itemId}`, { soNo: p.cardNo, category: r.category, item: r.item, unit: r.unit }, r.netQty * p.f, r.net * p.f);
    } else if (g === 'job') add(`${r.jobId}|${r.itemId}|${r.requestId}`, { department: r.department, jobNo: r.jobNo, soNos: r.soNos, category: r.category, item: r.item, unit: r.unit }, r.netQty, r.net);
    else if (g === 'department') add(`${r.department}|${r.itemId}`, { department: r.department, category: r.category, item: r.item, unit: r.unit }, r.netQty, r.net);
    else add(r.itemId, { category: r.category, item: r.item, unit: r.unit, departments: '' }, r.netQty, r.net);
  }
  const rows = [...out.values()].sort((a, b) => b.cost - a.cost);
  const cols = { so_card: [col('soNo', 'SO#', 'number')], job: [col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('soNos', 'SO#')], department: [col('department', 'Department')], chemical: [] }[g];
  const columns = [...cols, col('category', 'Category'), col('item', 'Chemical'), col('unit', 'Unit'), col('netQty', 'Used', 'number'), col('cost', 'Cost', 'money')];
  return respond(`Chemicals used by ${g.replace('_', ' ')}`, f, [section('usage', 'Usage', columns, rows, ['cost'])], f);
}

async function operators(req, store, f) {
  const lines = await issueLines(req, f);
  const key = (r) => r.requestedBy || '(unknown)';
  const per = new Map();
  for (const r of lines) {
    const x = per.get(key(r)) || { operator: key(r), requests: new Set(), requested: 0, issued: 0, short: 0, returned: 0, cost: 0 };
    x.requests.add(r.requestId); x.requested += r.requested; x.issued += r.issued; x.short += r.short; x.returned += r.returned; x.cost += r.net; per.set(key(r), x);
  }
  const summary = [...per.values()].map((x) => ({ ...x, requests: x.requests.size, requested: round(x.requested, 3), issued: round(x.issued, 3), short: round(x.short, 3), returned: round(x.returned, 3), used: round(x.issued - x.returned, 3), cost: round(x.cost) })).sort((a, b) => b.cost - a.cost);
  const detail = [...groupBy(lines, (r) => `${key(r)}|${r.itemId}`).values()].map((l) => ({ operator: key(l[0]), category: l[0].category, item: l[0].item, unit: l[0].unit,
    requested: round(l.reduce((t, r) => t + r.requested, 0), 3), issued: round(l.reduce((t, r) => t + r.issued, 0), 3), short: round(l.reduce((t, r) => t + r.short, 0), 3), returned: round(l.reduce((t, r) => t + r.returned, 0), 3),
    used: round(l.reduce((t, r) => t + r.issued - r.returned, 0), 3), cost: round(l.reduce((t, r) => t + r.net, 0)) })).sort((a, b) => a.operator.localeCompare(b.operator) || a.item.localeCompare(b.item));
  const nums = [col('requested', 'Requested', 'number'), col('issued', 'Issued', 'number'), col('short', 'Short', 'number'), col('returned', 'Returned', 'number'), col('used', 'Used', 'number'), col('cost', 'Cost', 'money')];
  return respond('Chemical requests by operator', f, [
    section('operators', 'By operator', [col('operator', 'Operator'), col('requests', 'Requests', 'number'), ...nums], summary, ['cost']),
    section('detail', 'Operator x chemical', [col('operator', 'Operator'), col('category', 'Category'), col('item', 'Chemical'), col('unit', 'Unit'), ...nums], detail, ['cost']),
  ], { ...f, page: 1, limit: 100000, export: true });
}

async function returns(req, store, f) {
  const rep = { companyId: req.user.companyId };
  const where = ['x."companyId" = :companyId'];
  if (f.dateFrom) { where.push(`(x."createdAt" AT TIME ZONE 'Asia/Karachi')::date >= :dateFrom`); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push(`(x."createdAt" AT TIME ZONE 'Asia/Karachi')::date <= :dateTo`); rep.dateTo = f.dateTo; }
  if (f.departmentId) { where.push('x."departmentId" = :departmentId'); rep.departmentId = f.departmentId; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  const rows = (await q(`SELECT x."createdAt" AS date, x."returnNo", x.status, dep.name AS department, r."reqNo", j."jobNo", u.name AS "returnedBy", it.name AS item, it.unit, l.qty::float AS qty, l.rate::float AS rate, l.value::float AS value
    FROM chemical_return_lines l JOIN chemical_returns x ON x.id = l."returnId" JOIN chemical_requests r ON r.id = x."requestId" JOIN jobs j ON j.id = r."jobId" JOIN services dep ON dep.id = x."departmentId"
    JOIN store_items it ON it.id = l."itemId" LEFT JOIN users u ON u.id = x."createdById" WHERE ${where.join(' AND ')} ORDER BY x."createdAt", x."returnNo"`, rep)).map((r) => ({ ...r, status: STATUS_TEXT[r.status] || r.status }));
  const columns = [col('date', 'Date', 'datetime'), col('returnNo', 'Return#', 'number'), col('department', 'Department'), col('reqNo', 'Req#', 'number'), col('jobNo', 'Job#', 'number'), col('returnedBy', 'Returned by'),
    col('item', 'Chemical'), col('unit', 'Unit'), col('qty', 'Qty', 'number'), col('rate', 'Rate', 'money'), col('value', 'Value', 'money'), col('status', 'Status')];
  return respond('Chemicals returned by departments', f, [section('returns', 'Returns', columns, rows, ['value'])], f);
}

/* ---- returns to vendors, ageing, monthly, adjustments and the audit check ---- */

const PACK = { DRUM: 'drum', BAG: 'bag', CAN: 'can', CARTON: 'carton', BOX: 'box', BARREL: 'barrel', OTHER: 'pack' };
const REASON_TEXT = { DAMAGED: 'Damaged / bad', WRONG_ITEM: 'Wrong item', EXPIRED: 'Expired', QUALITY: 'Quality not accepted', EXCESS: 'Extra / not needed', OTHER: 'Other' };

async function vendorReturns(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['x."companyId" = :companyId', 'x.store = :store'];
  if (f.dateFrom) { where.push('x."returnDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('x."returnDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.vendorId) { where.push('x."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  const rows = (await q(`SELECT x."returnDate" AS date, x."returnNo", x.reason, x.status, x.notes, v.name AS vendor, i."ipNo", i."dcNo", i."inwardDate" AS "boughtOn", it.name AS item, it.unit, c.name AS category,
      l.qty::float AS qty, l.rate::float AS rate, l.value::float AS value, l."packType", l."packCount", u.name AS "doneBy"
    FROM store_vendor_return_lines l JOIN store_vendor_returns x ON x.id = l."returnId" JOIN vendors v ON v.id = x."vendorId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    JOIN store_inwards i ON i.id = l."inwardId" LEFT JOIN users u ON u.id = x."createdById" WHERE ${where.join(' AND ')} ORDER BY x."returnDate", x."returnNo"`, rep))
    .map((r) => ({ ...r, returnText: `VR-${String(r.returnNo).padStart(5, '0')}`, reasonText: REASON_TEXT[r.reason], packs: r.packCount ? `${r.packCount} ${PACK[r.packType] || 'pack'}` : '', status: r.status === 'POSTED' ? 'Posted' : 'Cancelled', value: r.status === 'POSTED' ? r.value : 0 }));
  const columns = [col('date', 'Date', 'date'), col('returnText', 'Return#'), col('vendor', 'Vendor'), col('ipNo', 'Purchase IP#', 'number'), col('dcNo', 'DC#'), col('boughtOn', 'Bought on', 'date'), col('category', 'Category'), col('item', NAME(store)),
    col('unit', 'Unit'), col('packs', 'Packs'), col('qty', 'Qty', 'number'), col('rate', 'Rate', 'money'), col('value', 'Value', 'money'), col('reasonText', 'Reason'), col('status', 'Status'), col('doneBy', 'Done by')];
  return respond(`${NAME(store)} returned to vendors`, f, [section('returns', 'Returns to vendors', columns, rows, ['value'])], f);
}

/** How old the stock in the store is, batch by batch (by purchase date), per item. */
async function stockAgeing(req, store, f) {
  const asOf = f.date || today();
  const rep = { companyId: req.user.companyId, store, asOf };
  let more = '';
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  if (f.itemId) { more += ' AND it.id = :itemId'; rep.itemId = f.itemId; }
  const rows = await q(`
    SELECT c.name AS category, it.name AS item, it.unit, SUM(b."qtyLeft")::float AS qty, SUM(b."valueLeft")::float AS value, MIN(b."inDate") AS "oldestBatch",
      (SELECT MAX(mv."moveDate") FROM store_moves mv WHERE mv."itemId" = it.id AND mv.kind = 'ISSUE') AS "lastIssued",
      COALESCE(SUM(b."valueLeft") FILTER (WHERE :asOf::date - b."inDate" <= 30), 0)::float AS "d30", COALESCE(SUM(b."valueLeft") FILTER (WHERE :asOf::date - b."inDate" BETWEEN 31 AND 60), 0)::float AS "d60",
      COALESCE(SUM(b."valueLeft") FILTER (WHERE :asOf::date - b."inDate" BETWEEN 61 AND 90), 0)::float AS "d90", COALESCE(SUM(b."valueLeft") FILTER (WHERE :asOf::date - b."inDate" BETWEEN 91 AND 180), 0)::float AS "d180",
      COALESCE(SUM(b."valueLeft") FILTER (WHERE :asOf::date - b."inDate" > 180), 0)::float AS "d180p"
    FROM store_batches b JOIN store_items it ON it.id = b."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    WHERE b."companyId" = :companyId AND b.store = :store AND b."qtyLeft" > 0 AND b."inDate" <= :asOf::date ${more}
    GROUP BY c.name, it.id, it.name, it.unit ORDER BY c.name NULLS LAST, it.name`, rep);
  const data = rows.map((r) => ({ ...r, qty: round(r.qty, 3), value: round(r.value), d30: round(r.d30), d60: round(r.d60), d90: round(r.d90), d180: round(r.d180), d180p: round(r.d180p) }));
  const columns = [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('qty', 'Stock', 'number'), col('value', 'Value', 'money'), col('oldestBatch', 'Oldest batch', 'date'), col('lastIssued', 'Last issued', 'date'),
    col('d30', '0-30 days', 'money'), col('d60', '31-60 days', 'money'), col('d90', '61-90 days', 'money'), col('d180', '91-180 days', 'money'), col('d180p', 'Over 180 days', 'money')];
  return respond(`${NAME(store)} stock ageing on ${asOf}`, { ...f, date: asOf }, [section('ageing', 'Ageing (value by age of purchase)', columns, data, ['value', 'd30', 'd60', 'd90', 'd180', 'd180p'])], f);
}

/** Month by month: purchased, issued, returned to vendors, adjusted (qty and value). */
async function monthlySummary(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  let more = '';
  if (f.dateFrom) { more += ' AND mv."moveDate" >= :dateFrom'; rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { more += ' AND mv."moveDate" <= :dateTo'; rep.dateTo = f.dateTo; }
  if (f.itemId) { more += ' AND mv."itemId" = :itemId'; rep.itemId = f.itemId; }
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  const rows = await q(`
    SELECT to_char(mv."moveDate", 'YYYY-MM') AS month, c.name AS category, it.name AS item, it.unit,
      COALESCE(SUM(mv.qty) FILTER (WHERE mv.kind IN ('INWARD','INWARD_UNDO','INWARD_EDIT')), 0)::float AS "purchasedQty", COALESCE(SUM(mv.value) FILTER (WHERE mv.kind IN ('INWARD','INWARD_UNDO','INWARD_EDIT')), 0)::float AS "purchasedValue",
      COALESCE(-SUM(mv.qty) FILTER (WHERE mv.kind = 'ISSUE'), 0)::float AS "issuedQty", COALESCE(-SUM(mv.value) FILTER (WHERE mv.kind = 'ISSUE'), 0)::float AS "issuedValue",
      COALESCE(SUM(mv.qty) FILTER (WHERE mv.kind = 'RETURN'), 0)::float AS "returnedQty", COALESCE(SUM(mv.value) FILTER (WHERE mv.kind = 'RETURN'), 0)::float AS "returnedValue",
      COALESCE(-SUM(mv.qty) FILTER (WHERE mv.kind IN ('VENDOR_RETURN','VENDOR_RETURN_UNDO')), 0)::float AS "vendorReturnedQty", COALESCE(-SUM(mv.value) FILTER (WHERE mv.kind IN ('VENDOR_RETURN','VENDOR_RETURN_UNDO')), 0)::float AS "vendorReturnedValue",
      COALESCE(SUM(mv.qty) FILTER (WHERE mv.kind = 'ADJUST'), 0)::float AS "adjustedQty", COALESCE(SUM(mv.value) FILTER (WHERE mv.kind = 'ADJUST'), 0)::float AS "adjustedValue"
    FROM store_moves mv JOIN store_items it ON it.id = mv."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    WHERE mv."companyId" = :companyId AND mv.store = :store ${more}
    GROUP BY 1, c.name, it.name, it.unit ORDER BY 1, c.name NULLS LAST, it.name`, rep);
  const data = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round(v, 3) : v])));
  const months = [...groupBy(data, (r) => r.month).entries()].map(([month, l]) => ({ month, ...Object.fromEntries(['purchasedValue', 'issuedValue', 'returnedValue', 'vendorReturnedValue', 'adjustedValue'].map((k) => [k, round(l.reduce((t, r) => t + r[k], 0))])) }));
  const money = (k, label) => col(k, label, 'money');
  return respond(`${NAME(store)} month by month`, f, [
    section('months', 'By month', [col('month', 'Month'), money('purchasedValue', 'Purchased'), money('issuedValue', 'Issued to departments'), money('returnedValue', 'Returned by departments'), money('vendorReturnedValue', 'Returned to vendors'), money('adjustedValue', 'Adjusted')], months, ['purchasedValue', 'issuedValue', 'returnedValue', 'vendorReturnedValue', 'adjustedValue']),
    section('items', `By month and ${NAME(store).toLowerCase()}`, [col('month', 'Month'), col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('purchasedQty', 'Purchased', 'number'), money('purchasedValue', 'Purchased value'), col('issuedQty', 'Issued', 'number'),
      money('issuedValue', 'Issued value'), col('returnedQty', 'Returned by dept', 'number'), col('vendorReturnedQty', 'Returned to vendor', 'number'), col('adjustedQty', 'Adjusted', 'number'), money('adjustedValue', 'Adjusted value')], data, ['purchasedValue', 'issuedValue', 'adjustedValue']),
  ], { ...f, page: 1, limit: 100000, export: true });
}

async function adjustments(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['a."companyId" = :companyId', 'a.store = :store'];
  if (f.dateFrom) { where.push('a."adjDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('a."adjDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.itemId) { where.push('l."itemId" = :itemId'); rep.itemId = f.itemId; }
  const rows = await q(`SELECT a."adjDate" AS date, a."adjNo", a.reason, a.notes, it.name AS item, it.unit, c.name AS category, l."stockBefore"::float AS "stockBefore", l.qty::float AS qty, (l."stockBefore" + l.qty)::float AS "stockAfter", l.rate::float AS rate, l.value::float AS value, u.name AS "doneBy"
    FROM store_adjustment_lines l JOIN store_adjustments a ON a.id = l."adjustmentId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId" LEFT JOIN users u ON u.id = a."createdById"
    WHERE ${where.join(' AND ')} ORDER BY a."adjDate", a."adjNo"`, rep);
  const columns = [col('date', 'Date', 'date'), col('adjNo', 'Adjust#', 'number'), col('reason', 'Reason'), col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('stockBefore', 'Stock before', 'number'),
    col('qty', 'Change', 'number'), col('stockAfter', 'Stock after', 'number'), col('rate', 'Rate', 'money'), col('value', 'Value', 'money'), col('notes', 'Notes'), col('doneBy', 'Done by')];
  return respond(`${NAME(store)} stock adjustments`, f, [section('adjustments', 'Adjustments', columns, rows, ['value'])], f);
}

/**
 * The audit check: do the books agree with each other? Item stock = sum of movements = sum of batches,
 * every issue costed from batches, request totals = lines, vendor returns = movements.
 * Anything not OK is listed in the second section.
 */
async function stockAudit(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const items = await q(`
    SELECT it.id, it.name AS item, it.unit, it."stockQty"::float AS "stockQty", it."stockValue"::float AS "stockValue",
      COALESCE((SELECT SUM(mv.qty) FROM store_moves mv WHERE mv."itemId" = it.id), 0)::float AS "movesQty", COALESCE((SELECT SUM(mv.value) FROM store_moves mv WHERE mv."itemId" = it.id), 0)::float AS "movesValue",
      COALESCE((SELECT SUM(b."qtyLeft") FROM store_batches b WHERE b."itemId" = it.id), 0)::float AS "batchesQty", COALESCE((SELECT SUM(b."valueLeft") FROM store_batches b WHERE b."itemId" = it.id), 0)::float AS "batchesValue"
    FROM store_items it WHERE it."companyId" = :companyId AND it.store = :store`, rep);
  const tol = 0.011;
  const bad = items.map((r) => ({ ...r, diffMoves: round(r.stockQty - r.movesQty, 3), diffBatches: round(r.stockQty - r.batchesQty, 3), diffValueMoves: round(r.stockValue - r.movesValue), diffValueBatches: round(r.stockValue - r.batchesValue) }))
    .filter((r) => Math.abs(r.diffMoves) > 0.0005 || Math.abs(r.diffBatches) > 0.0005 || Math.abs(r.diffValueMoves) > tol * 100 || Math.abs(r.diffValueBatches) > tol * 100 || r.stockQty < 0);
  const one = async (sql) => (await q(sql, rep))[0].n;
  const checks = [
    ['Stock of each item = total of its movements (qty and value)', bad.filter((r) => Math.abs(r.diffMoves) > 0.0005 || Math.abs(r.diffValueMoves) > 1).length],
    ['Stock of each item = total of its batches (qty and value)', bad.filter((r) => Math.abs(r.diffBatches) > 0.0005 || Math.abs(r.diffValueBatches) > 1).length],
    ['No item with negative stock', items.filter((r) => r.stockQty < 0).length],
    ['No batch with more left than bought', await one(`SELECT count(*)::int AS n FROM store_batches WHERE "companyId" = :companyId AND store = :store AND "qtyLeft" > "qtyIn" + 0.0005`)],
    ['Every sent chemical line is costed from batches (line value = batch values)', store !== 'CHEMICAL' ? 0 : await one(`SELECT count(*)::int AS n FROM chemical_request_lines l JOIN chemical_requests r ON r.id = l."requestId"
      WHERE r."companyId" = :companyId AND l."sentQty" > 0 AND EXISTS (SELECT 1 FROM chemical_issue_batches x WHERE x."requestLineId" = l.id)
      AND ABS(l.value - (SELECT SUM(x.value) FROM chemical_issue_batches x WHERE x."requestLineId" = l.id)) > 0.011`)],
    ['Request total = total of its lines', store !== 'CHEMICAL' ? 0 : await one(`SELECT count(*)::int AS n FROM chemical_requests r WHERE r."companyId" = :companyId AND r."sentAt" IS NOT NULL
      AND ABS(r."totalValue" - COALESCE((SELECT SUM(l.value) FROM chemical_request_lines l WHERE l."requestId" = r.id), 0)) > 0.011 * GREATEST(1, (SELECT count(*) FROM chemical_request_lines l WHERE l."requestId" = r.id))`)],
    ['Department returns never more than issued', store !== 'CHEMICAL' ? 0 : await one(`SELECT count(*)::int AS n FROM chemical_request_lines l JOIN chemical_requests r ON r.id = l."requestId" WHERE r."companyId" = :companyId AND l."returnedQty" > COALESCE(l."sentQty", 0) + 0.0005`)],
    ['Issued movements = sent request lines (qty)', store !== 'CHEMICAL' ? 0 : await one(`SELECT count(*)::int AS n FROM (
      SELECT r.id FROM chemical_requests r JOIN chemical_request_lines l ON l."requestId" = r.id WHERE r."companyId" = :companyId AND r."sentAt" IS NOT NULL GROUP BY r.id
      HAVING ABS(COALESCE(SUM(l."sentQty"), 0) - COALESCE((SELECT -SUM(mv.qty) FROM store_moves mv WHERE mv."requestId" = r.id AND mv.kind = 'ISSUE'), 0)) > 0.0005) t`)],
    ['Vendor returns (posted) = their movements (value)', await one(`SELECT count(*)::int AS n FROM store_vendor_returns x WHERE x."companyId" = :companyId AND x.store = :store AND x.status = 'POSTED'
      AND ABS(x."totalValue" + COALESCE((SELECT SUM(mv.value) FROM store_moves mv WHERE mv."vendorReturnId" = x.id), 0)) > 0.011`)],
    ['Approved purchases: lines total = entry amount', await one(`SELECT count(*)::int AS n FROM store_inwards i WHERE i."companyId" = :companyId AND i.store = :store AND i."isApproved"
      AND ABS(i.amount - COALESCE((SELECT SUM(l.amount) FROM store_inward_lines l WHERE l."inwardId" = i.id), 0)) > 0.011`)],
  ].map(([check, problems]) => ({ check, problems, status: problems ? 'CHECK' : 'OK' }));
  const itemRows = bad.map((r) => ({ item: r.item, unit: r.unit, stockQty: r.stockQty, movesQty: round(r.movesQty, 3), batchesQty: round(r.batchesQty, 3), diffMoves: r.diffMoves, diffBatches: r.diffBatches, stockValue: r.stockValue, movesValue: round(r.movesValue), batchesValue: round(r.batchesValue) }));
  return respond(`${NAME(store)} stock audit check`, f, [
    section('checks', 'Checks', [col('check', 'Check'), col('problems', 'Problems found', 'number'), col('status', 'Result', 'tag')], checks),
    section('items', 'Items that do not agree', [col('item', NAME(store)), col('unit', 'Unit'), col('stockQty', 'Stock shown', 'number'), col('movesQty', 'By movements', 'number'), col('batchesQty', 'By batches', 'number'), col('diffMoves', 'Difference (movements)', 'number'),
      col('diffBatches', 'Difference (batches)', 'number'), col('stockValue', 'Value shown', 'money'), col('movesValue', 'Value by movements', 'money'), col('batchesValue', 'Value by batches', 'money')], itemRows),
  ], { ...f, page: 1, limit: 100000, export: true });
}

/** Items at or below their minimum stock (the minimum is set on the chemical). */
async function lowStock(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  let more = '';
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  const rows = (await q(`SELECT c.name AS category, it.name AS item, it.unit, it."stockQty"::float AS stock, it."reorderLevel"::float AS minimum, (it."reorderLevel" - it."stockQty")::float AS "toBuy",
      (SELECT MAX(i."inwardDate") FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved" WHERE l."itemId" = it.id) AS "lastPurchase",
      (SELECT v.name FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved" JOIN vendors v ON v.id = i."vendorId" WHERE l."itemId" = it.id ORDER BY i."inwardDate" DESC, i."approvedAt" DESC LIMIT 1) AS "lastVendor"
    FROM store_items it LEFT JOIN store_categories c ON c.id = it."categoryId"
    WHERE it."companyId" = :companyId AND it.store = :store AND it."isActive" AND it."reorderLevel" IS NOT NULL AND it."stockQty" <= it."reorderLevel" ${more} ORDER BY c.name NULLS LAST, it.name`, rep));
  const columns = [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('stock', 'Stock', 'number'), col('minimum', 'Minimum', 'number'), col('toBuy', 'Short of minimum', 'number'), col('lastPurchase', 'Last purchase', 'date'), col('lastVendor', 'Last vendor')];
  return respond(`${NAME(store)} below minimum stock`, f, [section('low', 'Low stock', columns, rows)], f);
}

/** The stock in the store batch by batch: purchase date, vendor, IP#, rate, qty left, value, age. */
async function batchStock(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  let more = '';
  if (f.categoryId) { more += ' AND it."categoryId" = :categoryId'; rep.categoryId = f.categoryId; }
  if (f.itemId) { more += ' AND it.id = :itemId'; rep.itemId = f.itemId; }
  if (f.vendorId) { more += ' AND b."vendorId" = :vendorId'; rep.vendorId = f.vendorId; }
  const rows = await q(`SELECT c.name AS category, it.name AS item, it.unit, b."inDate" AS date, CURRENT_DATE - b."inDate" AS age, b.source, v.name AS vendor, i."ipNo", i."dcNo", b.rate::float AS rate, b."qtyIn"::float AS "qtyIn", b."qtyLeft"::float AS "qtyLeft", b."valueLeft"::float AS value
    FROM store_batches b JOIN store_items it ON it.id = b."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId" LEFT JOIN vendors v ON v.id = b."vendorId" LEFT JOIN store_inwards i ON i.id = b."inwardId"
    WHERE b."companyId" = :companyId AND b.store = :store AND b."qtyLeft" > 0 ${more} ORDER BY c.name NULLS LAST, it.name, b."inDate", b."createdAt"`, rep);
  const SRC = { OPENING: 'Old stock', INWARD: 'Purchase', RETURN: 'Returned by department', ADJUST: 'Stock adjustment' };
  const data = rows.map((r) => ({ ...r, source: SRC[r.source] || r.source }));
  const columns = [col('category', 'Category'), col('item', NAME(store)), col('unit', 'Unit'), col('date', 'Batch date', 'date'), col('age', 'Age (days)', 'number'), col('source', 'Source'), col('vendor', 'Vendor'), col('ipNo', 'IP#', 'number'), col('dcNo', 'DC#'),
    col('rate', 'Rate', 'money'), col('qtyIn', 'Bought', 'number'), col('qtyLeft', 'In store', 'number'), col('value', 'Value', 'money')];
  return respond(`${NAME(store)} stock by batch`, f, [section('batches', 'Batches in store', columns, data, ['value'])], f);
}

const REPORTS = { 'day-book': dayBook, 'item-ledger': itemLedger, 'stock-on-date': stockOnDate, 'stock-summary': stockSummary, purchases, 'vendor-ledger': vendorLedger, inwards, issues, operators, returns, 'vendor-returns': vendorReturns, 'stock-ageing': stockAgeing, 'monthly-summary': monthlySummary, adjustments, 'stock-audit': stockAudit, 'low-stock': lowStock, 'batch-stock': batchStock };
const CHEMICAL_ONLY = new Set(['issues', 'operators', 'returns']);

module.exports = { REPORTS, CHEMICAL_ONLY };
