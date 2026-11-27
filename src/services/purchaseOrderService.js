// Purchase orders of the STORE (owner plan N-D1): chemical, general, yarn and fabric. Nowhere else in the project.
//   DRAFT -> (client admin approves) APPROVED -> goods are received against its lines (the store inward screens) -> "Partly received" / "Received"
//   CLOSED by hand (nothing more is expected) or CANCELLED (only while nothing was received). A draft can be changed or deleted.
// What is received is the sum of the inwards (poReceiptService): "received" counts the approved inwards, "waiting" the inwards not approved yet.
// A PO books nothing: no stock, no accounts. Those happen at the inward, as before.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const receipts = require('./poReceiptService');
const { companyServices, userServices } = require('./accessService');
const { today } = require('../utils/dates');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: 'SELECT', transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const r3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;
const money = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const iso = (v) => (v ? new Date(v).toISOString() : null);
const { label } = receipts;

const SERVICE_OF = { CHEMICAL: 'CHEMICAL_STORE', GENERAL: 'GENERAL_STORE', YARN: 'YARN_STORE', FABRIC: 'FABRIC_STORE' };
const STORE_TEXT = { CHEMICAL: 'Chemical Store', GENERAL: 'General Store', YARN: 'Yarn Store', FABRIC: 'Fabric Store' };
const STATUS_TEXT = { DRAFT: 'Draft', APPROVED: 'Approved', PARTLY_RECEIVED: 'Partly received', RECEIVED: 'Received', CLOSED: 'Closed', CANCELLED: 'Cancelled' };

/* ---------------- who may see which store ---------------- */

/** The stores this person may use at this level: the client admin the stores of the company, a user the stores he was given. */
async function storesOf(req, level = 'VIEW') {
  const { user } = req;
  if (!user || !user.companyId) throw AppError.forbidden();
  const have = user.userType === 'CLIENT_ADMIN'
    ? (await companyServices(user.companyId)).map((s) => ({ code: s.code, access: 'FULL' }))
    : (await userServices(user)).map((g) => ({ code: g.service.code, access: g.access }));
  return Object.entries(SERVICE_OF).filter(([, code]) => have.some((h) => h.code === code && (level === 'VIEW' || h.access === 'FULL'))).map(([store]) => store);
}
async function needStore(req, store, level = 'VIEW') {
  if (!(await storesOf(req, level)).includes(store)) throw AppError.forbidden(level === 'FULL' ? `You cannot change the ${STORE_TEXT[store]}` : `You do not have the ${STORE_TEXT[store]}`);
}
async function needAnyStore(req) {
  const mine = await storesOf(req);
  if (!mine.length) throw AppError.forbidden('You do not have a store service');
  return mine;
}

/* ---------------- settings ---------------- */

async function getSettings(req) {
  await needAnyStore(req);
  return { tolerancePercent: await receipts.toleranceOf(req.user.companyId), standard: 5, note: 'How much more than the ordered quantity may be received on an order line.' };
}
async function saveSettings(req, { tolerancePercent }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const before = await receipts.toleranceOf(companyId, transaction);
    await exec(`INSERT INTO po_settings ("companyId", "tolerancePercent", "updatedById") VALUES (:companyId, :tolerancePercent, :userId)
      ON CONFLICT ("companyId") DO UPDATE SET "tolerancePercent" = EXCLUDED."tolerancePercent", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`, { companyId, tolerancePercent, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PO_SETTINGS_CHANGED', entityType: 'PoSettings', entityId: companyId, before: { tolerancePercent: before }, after: { tolerancePercent } }, { transaction });
  });
  return getSettings(req);
}

/* ---------------- reading ---------------- */

const HEAD_SQL = `SELECT o.id, o.store, o."poNo", to_char(o."poDate", 'YYYY-MM-DD') AS "poDate", to_char(o."expectedDate", 'YYYY-MM-DD') AS "expectedDate", o."vendorId", v.name AS "vendorName", v.code AS "vendorCode", v.phone AS "vendorPhone", v.address AS "vendorAddress",
    o.notes, o.status, o."approvedAt", ab.name AS "approvedByName", o."closedAt", cb.name AS "closedByName", o."closeReason", o."cancelledAt", xb.name AS "cancelledByName", o."cancelReason", o."createdAt", mk.name AS "createdByName"
  FROM purchase_orders o JOIN vendors v ON v.id = o."vendorId" LEFT JOIN users ab ON ab.id = o."approvedById" LEFT JOIN users cb ON cb.id = o."closedById" LEFT JOIN users xb ON xb.id = o."cancelledById" LEFT JOIN users mk ON mk.id = o."createdById"`;

async function linesOf(orderIds, transaction) {
  if (!orderIds.length) return [];
  return q(`SELECT l.id, l."orderId", l."lineNo", l."itemId", it.name AS "itemName", l."yarnName", l.brand, l."qualityId", qu.name AS "qualityName", l.unit, l.qty::float AS qty, l.rate::float AS rate, l.note
    FROM purchase_order_lines l LEFT JOIN store_items it ON it.id = l."itemId" LEFT JOIN qualities qu ON qu.id = l."qualityId" WHERE l."orderId" IN (:orderIds) ORDER BY l."orderId", l."lineNo"`, { orderIds }, transaction);
}

const describe = (l) => l.itemName || [l.yarnName, l.brand].filter(Boolean).join(' - ') || l.qualityName || '';

/** The lines with what was ordered, received, waiting for approval and still open. */
async function withReceived(lines, tolerance, transaction) {
  const got = await receipts.receivedOf(lines.map((l) => l.id), { transaction });
  return lines.map((l) => {
    const g = got.get(l.id);
    return {
      id: l.id, lineNo: l.lineNo, itemId: l.itemId, yarnName: l.yarnName, brand: l.brand, qualityId: l.qualityId, description: describe(l), unit: l.unit, qty: l.qty, rate: l.rate, amount: money(l.qty * l.rate), note: l.note,
      received: g.approved, waiting: r3(g.all - g.approved), balance: r3(Math.max(0, l.qty - g.all)), canReceive: r3(Math.max(0, l.qty * (1 + tolerance / 100) - g.all)),
    };
  });
}

/** APPROVED orders show how far the goods are: nothing yet, partly, or all received. */
function shownStatus(status, lines) {
  if (status !== 'APPROVED') return status;
  if (lines.length && lines.every((l) => l.received >= l.qty - 1e-6)) return 'RECEIVED';
  return lines.some((l) => l.received > 0) ? 'PARTLY_RECEIVED' : 'APPROVED';
}

function orderJson(o, lines) {
  const status = shownStatus(o.status, lines);
  const ordered = lines.reduce((t, l) => t + l.amount, 0);
  const anyReceipt = lines.some((l) => l.received > 0 || l.waiting > 0);
  return {
    id: o.id, poNo: o.poNo, label: label(o.poNo), store: o.store, storeText: STORE_TEXT[o.store], poDate: o.poDate, expectedDate: o.expectedDate,
    vendor: { id: o.vendorId, name: o.vendorName, code: o.vendorCode, phone: o.vendorPhone, address: o.vendorAddress }, notes: o.notes,
    status, statusText: STATUS_TEXT[status], amount: money(ordered), lineCount: lines.length,
    receivedPercent: lines.length ? Math.round((lines.reduce((t, l) => t + Math.min(1, l.received / l.qty), 0) / lines.length) * 100) : 0,
    overdue: o.status === 'APPROVED' && status !== 'RECEIVED' && Boolean(o.expectedDate) && o.expectedDate < today(),
    createdBy: { name: o.createdByName }, createdAt: iso(o.createdAt),
    approvedAt: iso(o.approvedAt), approvedBy: o.approvedAt ? { name: o.approvedByName } : null,
    closed: o.closedAt ? { at: iso(o.closedAt), by: o.closedByName, reason: o.closeReason } : null,
    cancelled: o.cancelledAt ? { at: iso(o.cancelledAt), by: o.cancelledByName, reason: o.cancelReason } : null,
    canEdit: o.status === 'DRAFT', canDelete: o.status === 'DRAFT', canApprove: o.status === 'DRAFT',
    canClose: o.status === 'APPROVED', canCancel: ['DRAFT', 'APPROVED'].includes(o.status) && !anyReceipt, canReceive: o.status === 'APPROVED' && status !== 'RECEIVED',
  };
}

async function headOr404(companyId, id, transaction, lock = false) {
  const [o] = await q(`${HEAD_SQL} WHERE o.id = :id AND o."companyId" = :companyId AND o."deletedAt" IS NULL${lock ? ' FOR UPDATE OF o' : ''}`, { id, companyId }, transaction);
  if (!o) throw AppError.notFound('Purchase order');
  return o;
}

/** Every inward that came against the order (the goods received notes). */
async function receiptsOf(orderId, transaction) {
  return q(`
    SELECT 'STORE' AS type, i.id AS "inwardId", lpad(i."idNo"::text, 5, '0') AS ref, to_char(i."inwardDate", 'YYYY-MM-DD') AS date, l."poLineId", l.qty::float AS qty, l.rate::float AS rate, l."poRateNote" AS note, i."isApproved" AS approved
      FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" JOIN purchase_order_lines pl ON pl.id = l."poLineId" WHERE pl."orderId" = :orderId
    UNION ALL
    SELECT 'YARN', y.id, lpad(y."inwardNo"::text, 5, '0'), to_char(y."inwardDate", 'YYYY-MM-DD'), y."poLineId", y."totalLbs"::float, y."ratePerLb"::float, y."poRateNote", y."isApproved"
      FROM store_yarn_inwards y JOIN purchase_order_lines pl ON pl.id = y."poLineId" WHERE pl."orderId" = :orderId AND y."deletedAt" IS NULL
    UNION ALL
    SELECT 'FABRIC', f.id, lpad(f."inwardNo"::text, 5, '0'), to_char(f."inwardDate", 'YYYY-MM-DD'), f."poLineId", (CASE WHEN pl.unit = 'YARD' THEN f."inwardYards" ELSE f."inwardMeters" END)::float, f.rate::float, f."poRateNote", f."isApproved"
      FROM fabric_inwards f JOIN purchase_order_lines pl ON pl.id = f."poLineId" WHERE pl."orderId" = :orderId AND f."deletedAt" IS NULL
    ORDER BY date, ref`, { orderId }, transaction);
}

async function view(companyId, o, transaction, full = true) {
  const tolerance = await receipts.toleranceOf(companyId, transaction);
  const lines = await withReceived(await linesOf([o.id], transaction), tolerance, transaction);
  const out = { ...orderJson(o, lines), tolerancePercent: tolerance, lines };
  if (full) out.receipts = await receiptsOf(o.id, transaction);
  return out;
}

async function get(req, id) {
  const o = await headOr404(req.user.companyId, id);
  await needStore(req, o.store);
  return view(req.user.companyId, o);
}

async function list(req, { page, limit, store, status, vendorId, search, dateFrom, dateTo }) {
  const mine = await needAnyStore(req);
  if (store) await needStore(req, store);
  const { companyId } = req.user;
  const where = ['o."companyId" = :companyId', 'o."deletedAt" IS NULL', 'o.store IN (:stores)'];
  const rep = { companyId, stores: store ? [store] : mine };
  if (vendorId) { where.push('o."vendorId" = :vendorId'); rep.vendorId = vendorId; }
  if (dateFrom) { where.push('o."poDate" >= :dateFrom'); rep.dateFrom = dateFrom; }
  if (dateTo) { where.push('o."poDate" <= :dateTo'); rep.dateTo = dateTo; }
  if (search) {
    rep.like = `%${search.trim()}%`;
    const digits = /^(?:po-?)?0*(\d+)$/i.exec(search.trim());
    if (digits) rep.n = Number(digits[1]);
    where.push(`(v.name ILIKE :like OR o.notes ILIKE :like${digits ? ' OR o."poNo" = :n' : ''} OR EXISTS (SELECT 1 FROM purchase_order_lines l LEFT JOIN store_items it ON it.id = l."itemId" LEFT JOIN qualities qu ON qu.id = l."qualityId" WHERE l."orderId" = o.id AND (it.name ILIKE :like OR l."yarnName" ILIKE :like OR qu.name ILIKE :like)))`);
  }
  // "partly received" and "received" are worked out from the goods, so those two (and "approved" = nothing yet) are filtered after reading
  const derived = ['APPROVED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status);
  if (status) { where.push('o.status = :status'); rep.status = derived ? 'APPROVED' : status; }
  const heads = await q(`${HEAD_SQL} WHERE ${where.join(' AND ')} ORDER BY o."poNo" DESC LIMIT 2000`, rep);
  const tolerance = await receipts.toleranceOf(companyId);
  const raw = await linesOf(heads.map((h) => h.id));
  const all = await withReceived(raw, tolerance);
  const orderOf = new Map(raw.map((l) => [l.id, l.orderId]));
  let rows = heads.map((h) => orderJson(h, all.filter((l) => orderOf.get(l.id) === h.id)));
  if (derived) rows = rows.filter((r) => r.status === status);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { data: rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length, counts, stores: mine.map((s) => ({ code: s, text: STORE_TEXT[s] })) };
}

/** Everything the PO form needs for one store. */
async function formData(req, { store }) {
  await needStore(req, store);
  const { companyId } = req.user;
  const vendors = await q('SELECT id, code, name FROM vendors WHERE "companyId" = :companyId AND "isActive" AND module = \'MAIN\' ORDER BY name', { companyId });
  const out = { store, storeText: STORE_TEXT[store], today: today(), tolerancePercent: await receipts.toleranceOf(companyId), vendors };
  if (store === 'CHEMICAL' || store === 'GENERAL') {
    out.items = await q('SELECT id, name, unit, "stockQty"::float AS "stockQty", "reorderLevel"::float AS "limit", "orderQty"::float AS "orderQty" FROM store_items WHERE "companyId" = :companyId AND store = :store AND "isActive" ORDER BY name', { companyId, store });
  } else if (store === 'YARN') {
    out.yarns = await q('SELECT DISTINCT "yarnName", brand FROM store_yarn_inwards WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY 1, 2 LIMIT 500', { companyId });
    out.unit = 'LBS';
  } else {
    out.qualities = await q('SELECT id, name FROM qualities WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY name', { companyId });
    out.units = ['METER', 'YARD'];
  }
  out.nextPoNo = await counters.peek(companyId, 'po_no', async () => Number((await q('SELECT COALESCE(MAX("poNo"), 0) + 1 AS n FROM purchase_orders WHERE "companyId" = :companyId', { companyId }))[0].n));
  out.nextLabel = label(out.nextPoNo);
  return out;
}

/** GET open-lines: what the inward screen can pick ("Pick from open PO"): the lines of approved orders that still have something to receive. */
async function openLines(req, { store, vendorId, itemId, qualityId }) {
  await needStore(req, store);
  const { companyId } = req.user;
  const where = ['o."companyId" = :companyId', 'o."deletedAt" IS NULL', 'o.store = :store', 'o.status = \'APPROVED\''];
  const rep = { companyId, store };
  if (vendorId) { where.push('o."vendorId" = :vendorId'); rep.vendorId = vendorId; }
  const heads = await q(`${HEAD_SQL} WHERE ${where.join(' AND ')} ORDER BY o."poNo"`, rep);
  const tolerance = await receipts.toleranceOf(companyId);
  const raw = await linesOf(heads.map((h) => h.id));
  const lines = await withReceived(raw, tolerance);
  const orderOf = new Map(raw.map((l) => [l.id, l.orderId]));
  const data = lines
    .filter((l) => l.balance > 0 && (!itemId || l.itemId === itemId) && (!qualityId || l.qualityId === qualityId))
    .map((l) => {
      const o = heads.find((h) => h.id === orderOf.get(l.id));
      return { poLineId: l.id, orderId: o.id, poNo: o.poNo, label: label(o.poNo), poDate: o.poDate, expectedDate: o.expectedDate, vendor: { id: o.vendorId, name: o.vendorName }, itemId: l.itemId, yarnName: l.yarnName, brand: l.brand, qualityId: l.qualityId, description: l.description, unit: l.unit, ordered: l.qty, received: l.received, waiting: l.waiting, balance: l.balance, canReceive: l.canReceive, rate: l.rate };
    });
  return { store, tolerancePercent: tolerance, data };
}

/* ---------------- writing ---------------- */

/** Checks the vendor and the lines of an order and returns the rows to insert. */
async function prepare(companyId, store, { vendorId, lines }, transaction) {
  if (vendorId) {
    const [v] = await q('SELECT name, "isActive" FROM vendors WHERE id = :vendorId AND "companyId" = :companyId', { vendorId, companyId }, transaction);
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'Vendor not found', { field: 'vendorId' });
    if (!v.isActive) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off', { field: 'vendorId' });
  }
  if (!lines) return null;
  const seen = new Set();
  const out = [];
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    const row = { lineNo: n, itemId: null, yarnName: null, brand: null, qualityId: null, unit: null, qty: l.qty, rate: l.rate, note: l.note || null };
    let key;
    if (store === 'CHEMICAL' || store === 'GENERAL') {
      if (!l.itemId) throw AppError.rule('ITEM_REQUIRED', `Line ${n}: select the item`, { line: n });
      const [it] = await q('SELECT id, name, unit, "isActive" FROM store_items WHERE id = :id AND "companyId" = :companyId AND store = :store', { id: l.itemId, companyId, store }, transaction);
      if (!it) throw AppError.rule('UNKNOWN_ITEM', `Line ${n}: the item is not in this store`, { line: n });
      if (!it.isActive) throw AppError.rule('ITEM_INACTIVE', `${it.name} is switched off`, { line: n });
      Object.assign(row, { itemId: it.id, unit: it.unit });
      key = it.id;
    } else if (store === 'YARN') {
      const name = String(l.yarnName || '').replace(/\s+/g, ' ').trim();
      if (!name) throw AppError.rule('YARN_REQUIRED', `Line ${n}: type the yarn`, { line: n });
      Object.assign(row, { yarnName: name, brand: String(l.brand || '').replace(/\s+/g, ' ').trim() || null, unit: 'LBS' });
      key = `${name}|${row.brand || ''}`.toLowerCase();
    } else {
      if (!l.qualityId) throw AppError.rule('QUALITY_REQUIRED', `Line ${n}: select the quality`, { line: n });
      const [qu] = await q('SELECT id FROM qualities WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id: l.qualityId, companyId }, transaction);
      if (!qu) throw AppError.rule('UNKNOWN_QUALITY', `Line ${n}: quality not found`, { line: n });
      Object.assign(row, { qualityId: qu.id, unit: l.unit || 'METER' });
      key = `${qu.id}|${row.unit}`;
    }
    if (seen.has(key)) throw AppError.rule('DUPLICATE_LINE', `Line ${n}: the same item is on the order twice; put it on one line`, { line: n });
    seen.add(key);
    out.push(row);
  }
  return out;
}

const writeLines = async (companyId, orderId, rows, transaction) => {
  await exec('DELETE FROM purchase_order_lines WHERE "orderId" = :orderId', { orderId }, transaction);
  for (const r of rows) {
    await exec('INSERT INTO purchase_order_lines ("orderId", "companyId", "lineNo", "itemId", "yarnName", brand, "qualityId", unit, qty, rate, note) VALUES (:orderId, :companyId, :lineNo, :itemId, :yarnName, :brand, :qualityId, :unit, :qty, :rate, :note)', { orderId, companyId, ...r }, transaction);
  }
};

const checkDates = (poDate, expectedDate) => { if (expectedDate && expectedDate < poDate) throw AppError.rule('EXPECTED_BEFORE_PO', 'The expected day cannot be before the day of the order', { field: 'expectedDate' }); };

async function create(req, data) {
  await needStore(req, data.store, 'FULL');
  const { companyId } = req.user;
  const id = await sequelize.transaction(async (transaction) => {
    const lines = await prepare(companyId, data.store, data, transaction);
    const poDate = data.poDate || today();
    checkDates(poDate, data.expectedDate);
    const poNo = await counters.take(companyId, 'po_no', async () => Number((await q('SELECT COALESCE(MAX("poNo"), 0) + 1 AS n FROM purchase_orders WHERE "companyId" = :companyId', { companyId }, transaction))[0].n), transaction);
    const [row] = await q(`INSERT INTO purchase_orders ("companyId", store, "poNo", "poDate", "expectedDate", "vendorId", notes, "createdById", "updatedById")
      VALUES (:companyId, :store, :poNo, :poDate, :expectedDate, :vendorId, :notes, :userId, :userId) RETURNING id`,
    { companyId, store: data.store, poNo, poDate, expectedDate: data.expectedDate || null, vendorId: data.vendorId, notes: data.notes || null, userId: req.user.id }, transaction);
    await writeLines(companyId, row.id, lines, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: row.id, after: { poNo, store: data.store, lines: lines.length } }, { transaction });
    return row.id;
  });
  return get(req, id);
}

/** Locks the order and checks the person may change its store. */
async function lockedOrder(req, id, transaction) {
  const o = await headOr404(req.user.companyId, id, transaction, true);
  await needStore(req, o.store, 'FULL');
  return o;
}

async function update(req, id, data) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const o = await lockedOrder(req, id, transaction);
    if (o.status !== 'DRAFT') throw AppError.rule('PO_NOT_DRAFT', 'Only a draft order can be changed. Cancel it and make a new one.');
    const before = await view(companyId, o, transaction, false);
    const lines = await prepare(companyId, o.store, data, transaction);
    const poDate = data.poDate || o.poDate;
    const expectedDate = data.expectedDate === undefined ? o.expectedDate : data.expectedDate || null;
    checkDates(poDate, expectedDate);
    await exec('UPDATE purchase_orders SET "poDate" = :poDate, "expectedDate" = :expectedDate, "vendorId" = :vendorId, notes = :notes, "updatedById" = :userId, "updatedAt" = now() WHERE id = :id',
      { id, poDate, expectedDate, vendorId: data.vendorId || o.vendorId, notes: data.notes === undefined ? o.notes : data.notes || null, userId: req.user.id }, transaction);
    if (lines) await writeLines(companyId, id, lines, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_UPDATED', entityType: 'PurchaseOrder', entityId: id, before, after: await view(companyId, await headOr404(companyId, id, transaction), transaction, false) }, { transaction });
  });
  return get(req, id);
}

/** The client admin approves (checked in the route): from now goods can be received against it. */
async function approve(req, id) {
  await sequelize.transaction(async (transaction) => {
    const o = await lockedOrder(req, id, transaction);
    if (o.status !== 'DRAFT') throw AppError.rule('PO_NOT_DRAFT', o.status === 'APPROVED' ? 'This order is already approved' : `This order is ${o.status.toLowerCase()}`);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM purchase_order_lines WHERE "orderId" = :id', { id }, transaction);
    if (!n) throw AppError.rule('NO_LINES', 'Add at least one line');
    await exec('UPDATE purchase_orders SET status = \'APPROVED\', "approvedById" = :userId, "approvedAt" = now(), "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_APPROVED', entityType: 'PurchaseOrder', entityId: id, after: { poNo: o.poNo, vendor: o.vendorName } }, { transaction });
  });
  return get(req, id);
}

/** Close by hand: what is left of the order is not expected any more. */
async function close(req, id, { reason } = {}) {
  await sequelize.transaction(async (transaction) => {
    const o = await lockedOrder(req, id, transaction);
    if (o.status !== 'APPROVED') throw AppError.rule('PO_NOT_APPROVED', 'Only an approved order can be closed');
    await exec('UPDATE purchase_orders SET status = \'CLOSED\', "closedById" = :userId, "closedAt" = now(), "closeReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason: reason || null }, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_CLOSED', entityType: 'PurchaseOrder', entityId: id, after: { poNo: o.poNo, reason: reason || null } }, { transaction });
  });
  return get(req, id);
}

/** Cancel: only while nothing was received (not even an inward waiting for approval). */
async function cancel(req, id, { reason }) {
  await sequelize.transaction(async (transaction) => {
    const o = await lockedOrder(req, id, transaction);
    if (!['DRAFT', 'APPROVED'].includes(o.status)) throw AppError.rule('PO_NOT_OPEN', `This order is already ${o.status.toLowerCase()}`);
    const got = await receiptsOf(id, transaction);
    if (got.length) throw AppError.rule('PO_HAS_RECEIPTS', 'Goods were received against this order: close it instead of cancelling', { receipts: got.map((g) => ({ type: g.type, ref: g.ref })) });
    await exec('UPDATE purchase_orders SET status = \'CANCELLED\', "cancelledById" = :userId, "cancelledAt" = now(), "cancelReason" = :reason, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_CANCELLED', entityType: 'PurchaseOrder', entityId: id, after: { poNo: o.poNo, reason } }, { transaction });
  });
  return get(req, id);
}

/** A draft is deleted (it stays in the database; its number is not used again). */
async function remove(req, id, reason) {
  await sequelize.transaction(async (transaction) => {
    const o = await lockedOrder(req, id, transaction);
    if (o.status !== 'DRAFT') throw AppError.rule('PO_NOT_DRAFT', 'Only a draft order can be deleted');
    await exec('UPDATE purchase_orders SET "deletedAt" = now(), "deletedById" = :userId, "deleteReason" = :reason WHERE id = :id', { id, userId: req.user.id, reason: reason || null }, transaction);
    await audit.log(req, { action: 'PURCHASE_ORDER_DELETED', entityType: 'PurchaseOrder', entityId: id, before: { poNo: o.poNo, vendor: o.vendorName } }, { transaction });
  });
}

module.exports = {
  getSettings, saveSettings, list, get, formData, openLines, create, update, approve, close, cancel, remove, storesOf, needStore, needAnyStore, withReceived, linesOf, shownStatus, SERVICE_OF, STORE_TEXT, STATUS_TEXT,
};
