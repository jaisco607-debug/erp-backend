// The two reports of the purchase orders (owner plan N-D1): what is still open, and where the rate paid differs from the rate ordered. Read only.
const AppError = require('../utils/AppError');
const orders = require('./purchaseOrderService');
const { _x } = require('./reportService');
const { today } = require('../utils/dates');

const { q, round, col, section, respond } = _x;
const ROW_CAP = 5000;

async function scope(req, f) {
  const mine = await orders.needAnyStore(req);
  const store = f.poStore ? f.poStore.toUpperCase() : null;
  if (store && !mine.includes(store)) throw AppError.forbidden('You do not have this store');
  const where = ['o."companyId" = :companyId', 'o."deletedAt" IS NULL', 'o.store IN (:stores)'];
  const rep = { companyId: req.user.companyId, stores: store ? [store] : mine };
  if (f.vendorId) { where.push('o."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  return { where, rep };
}

/** One row per order line: ordered, received, waiting, balance and the status. tab=open (default): only approved orders that still expect goods. */
async function status(req, f) {
  const { where, rep } = await scope(req, f);
  if (f.dateFrom) { where.push('o."poDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('o."poDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  const tab = f.tab === 'all' ? 'all' : 'open';
  if (tab === 'open') where.push('o.status = \'APPROVED\'');
  const heads = await q(`SELECT o.id, o.store, o."poNo", to_char(o."poDate", 'YYYY-MM-DD') AS "poDate", to_char(o."expectedDate", 'YYYY-MM-DD') AS "expectedDate", v.name AS vendor, o.status FROM purchase_orders o JOIN vendors v ON v.id = o."vendorId" WHERE ${where.join(' AND ')} ORDER BY o."poNo" DESC LIMIT 2001`, rep);
  const raw = await orders.linesOf(heads.map((h) => h.id));
  const tolerance = await require('./poReceiptService').toleranceOf(req.user.companyId);
  const lines = await orders.withReceived(raw, tolerance);
  const orderOf = new Map(raw.map((l) => [l.id, l.orderId]));
  const rows = [];
  for (const h of heads) {
    const mine = lines.filter((l) => orderOf.get(l.id) === h.id);
    const shown = orders.shownStatus(h.status, mine);
    for (const l of mine) {
      if (tab === 'open' && (shown === 'RECEIVED' || l.balance <= 0)) continue;
      rows.push({ orderId: h.id, poLineId: l.id, poLabel: require('./poReceiptService').label(h.poNo), poDate: h.poDate, expectedDate: h.expectedDate, store: orders.STORE_TEXT[h.store], vendor: h.vendor, item: l.description, unit: l.unit,
        ordered: l.qty, received: l.received, waiting: l.waiting, balance: l.balance, rate: l.rate, balanceValue: round(l.balance * l.rate), statusText: orders.STATUS_TEXT[shown],
        overdue: h.status === 'APPROVED' && shown !== 'RECEIVED' && Boolean(h.expectedDate) && h.expectedDate < today() ? 'Overdue' : '' });
    }
  }
  if (rows.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', `More than ${ROW_CAP} lines: choose a store, a vendor or a shorter period`, { cap: ROW_CAP });
  const columns = [col('poLabel', 'PO#'), col('poDate', 'Date', 'date'), col('expectedDate', 'Expected', 'date'), col('store', 'Store'), col('vendor', 'Vendor'), col('item', 'Item'), col('unit', 'Unit'), col('ordered', 'Ordered', 'number'), col('received', 'Received', 'number'),
    col('waiting', 'Waiting for approval', 'number'), col('balance', 'Balance', 'number'), col('rate', 'Rate', 'money'), col('balanceValue', 'Balance value', 'money'), col('statusText', 'Status', 'tag'), col('overdue', '', 'tag')];
  return respond(tab === 'open' ? 'Open purchase orders' : 'Purchase orders', f, [section('po-status', 'Purchase orders', columns, rows, ['balanceValue'])], f);
}

/** Every receipt whose rate is not the order's: the difference per unit and in money (more than ordered is positive), with the note. */
async function priceDifference(req, f) {
  const { where, rep } = await scope(req, f);
  const dates = [];
  if (f.dateFrom) { dates.push('x.date >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { dates.push('x.date <= :dateTo'); rep.dateTo = f.dateTo; }
  const rows = await q(`
    WITH x AS (
      SELECT l."poLineId", 'Store' AS type, lpad(i."idNo"::text, 5, '0') AS ref, i."inwardDate" AS date, l.qty::numeric AS qty, l.rate::numeric AS rate, l."poRateNote" AS note, i."isApproved" AS approved
        FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" WHERE l."poLineId" IS NOT NULL AND i."companyId" = :companyId AND l."poRateNote" IS NOT NULL
      UNION ALL
      SELECT y."poLineId", 'Yarn', lpad(y."inwardNo"::text, 5, '0'), y."inwardDate", y."totalLbs", y."ratePerLb", y."poRateNote", y."isApproved"
        FROM store_yarn_inwards y WHERE y."poLineId" IS NOT NULL AND y."companyId" = :companyId AND y."deletedAt" IS NULL AND y."poRateNote" IS NOT NULL
      UNION ALL
      SELECT f."poLineId", 'Fabric', lpad(f."inwardNo"::text, 5, '0'), f."inwardDate", CASE WHEN pl.unit = 'YARD' THEN f."inwardYards" ELSE f."inwardMeters" END,
             CASE WHEN COALESCE(f."rateUnit", f.unit) = pl.unit THEN f.rate WHEN pl.unit = 'YARD' THEN f.rate * 0.9144 ELSE f.rate / 0.9144 END, f."poRateNote", f."isApproved"
        FROM fabric_inwards f JOIN purchase_order_lines pl ON pl.id = f."poLineId" WHERE f."companyId" = :companyId AND f."deletedAt" IS NULL AND f."poRateNote" IS NOT NULL
    )
    SELECT x.type, x.ref, to_char(x.date, 'YYYY-MM-DD') AS date, x.qty::float AS qty, x.rate::float AS "paidRate", x.note, x.approved, o.id AS "orderId", o."poNo", v.name AS vendor, o.store,
           pl.unit, pl.rate::float AS "orderRate", COALESCE(it.name, concat_ws(' - ', pl."yarnName", pl.brand), qu.name) AS item, qu.name AS "qualityName"
    FROM x JOIN purchase_order_lines pl ON pl.id = x."poLineId" JOIN purchase_orders o ON o.id = pl."orderId" JOIN vendors v ON v.id = o."vendorId"
    LEFT JOIN store_items it ON it.id = pl."itemId" LEFT JOIN qualities qu ON qu.id = pl."qualityId"
    WHERE ${where.join(' AND ')}${dates.length ? ` AND ${dates.join(' AND ')}` : ''} ORDER BY x.date DESC, o."poNo" DESC LIMIT ${ROW_CAP + 1}`, rep);
  if (rows.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', `More than ${ROW_CAP} lines: choose a shorter period or a vendor`, { cap: ROW_CAP });
  const data = rows.map((r) => ({ orderId: r.orderId, poLabel: require('./poReceiptService').label(r.poNo), date: r.date, inward: `${r.type} ${r.ref}`, approved: r.approved ? 'Approved' : 'Waiting', store: orders.STORE_TEXT[r.store], vendor: r.vendor,
    item: r.item || r.qualityName, unit: r.unit, qty: round(r.qty, 3), orderRate: round(r.orderRate, 4), paidRate: round(r.paidRate, 4), difference: round(r.paidRate - r.orderRate, 4), differenceAmount: round((r.paidRate - r.orderRate) * r.qty), note: r.note }));
  const columns = [col('date', 'Date', 'date'), col('poLabel', 'PO#'), col('inward', 'Inward'), col('approved', '', 'tag'), col('store', 'Store'), col('vendor', 'Vendor'), col('item', 'Item'), col('unit', 'Unit'), col('qty', 'Qty', 'number'),
    col('orderRate', 'Ordered rate', 'money'), col('paidRate', 'Rate paid', 'money'), col('difference', 'Difference / unit', 'money'), col('differenceAmount', 'Difference', 'money'), col('note', 'Why')];
  return respond('Purchase price difference', f, [section('price-difference', 'Price difference', columns, data, ['differenceAmount'])], f);
}

module.exports = { status, priceDifference };
