// Return of bought stock to the vendor (owner 2026-10-22): 3 drums bought, 1 drum bad, the party takes it back.
// - A return names the purchase line it comes from, so it leaves the stock at THAT purchase's rate (its batch).
// - Only what is still in the store can go back (what a department already took cannot).
// - It lowers the item stock and the batch, makes a "Returned to vendor" movement, and is audited.
// - A wrong return can be cancelled (stock comes back). The vendor ledger and purchase reports show it.
const { QueryTypes } = require('sequelize');
const { sequelize, StoreItem, StoreMove } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const m = require('./storeMasterService');
let today;
try { ({ today } = require('../utils/dates')); } catch { today = () => new Date().toISOString().slice(0, 10); } // Pakistan day once utils/dates exists

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const NO = (store) => `store_vendor_return_no:${store}`;
const REASON_TEXT = { DAMAGED: 'Damaged / bad', WRONG_ITEM: 'Wrong item', EXPIRED: 'Expired', QUALITY: 'Quality not accepted', EXCESS: 'Extra / not needed', OTHER: 'Other' };
const text = (n) => `VR-${String(n).padStart(5, '0')}`;

async function load(id, companyId, store, transaction) {
  const [r] = await q(`SELECT x.*, v.name AS "vendorName", v.code AS "vendorCode", u.name AS "byName", cu.name AS "cancelledByName" FROM store_vendor_returns x JOIN vendors v ON v.id = x."vendorId" LEFT JOIN users u ON u.id = x."createdById" LEFT JOIN users cu ON cu.id = x."cancelledById"
    WHERE x.id = :id AND x."companyId" = :companyId AND x.store = :store`, { id, companyId, store }, transaction);
  if (!r) throw AppError.notFound('Return');
  const lines = await q(`SELECT l.id, l."itemId", it.name AS item, it.unit, c.name AS category, l."inwardId", i."ipNo", i."dcNo", i."inwardDate", l."inwardLineId", l.qty::float AS qty, l.rate::float AS rate, l.value::float AS value,
      l."packType", l."packCount", l."qtyPerPack"::float AS "qtyPerPack"
    FROM store_vendor_return_lines l JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId" JOIN store_inwards i ON i.id = l."inwardId"
    WHERE l."returnId" = :id ORDER BY it.name`, { id }, transaction);
  return {
    id: r.id, store: r.store, returnNo: r.returnNo, returnText: text(r.returnNo), returnDate: r.returnDate, status: r.status,
    vendor: { id: r.vendorId, name: r.vendorName, code: r.vendorCode }, reason: r.reason, reasonText: REASON_TEXT[r.reason], notes: r.notes, totalValue: Number(r.totalValue), createdBy: r.byName, createdAt: r.createdAt,
    cancelReason: r.cancelReason, cancelledAt: r.cancelledAt, cancelledBy: r.cancelledByName,
    lines: lines.map((l) => ({ ...l, itemName: l.item, qtySplit: m.splitQty(l.qty, l.unit) })),
  };
}

/** Purchase lines of a vendor that still have stock in the store: the choices of the return form. */
async function returnable(req, store, { vendorId, itemId, dateTo }) {
  const rep = { companyId: req.user.companyId, store, vendorId };
  let more = '';
  if (itemId) { more += ' AND l."itemId" = :itemId'; rep.itemId = itemId; }
  if (dateTo) { more += ' AND i."inwardDate" <= :dateTo'; rep.dateTo = dateTo; }
  const rows = await q(`SELECT l.id AS "inwardLineId", i.id AS "inwardId", i."ipNo", i."dcNo", i."inwardDate", it.id AS "itemId", it.name AS item, it.unit, c.name AS category,
      l.qty::float AS bought, l.rate::float AS rate, b."qtyLeft"::float AS "inStore", b."vendorReturnedQty"::float AS returned, l."packType", l."packCount", l."qtyPerPack"::float AS "qtyPerPack"
    FROM store_batches b JOIN store_inward_lines l ON l.id = b."inwardLineId" JOIN store_inwards i ON i.id = l."inwardId" JOIN store_items it ON it.id = l."itemId" LEFT JOIN store_categories c ON c.id = it."categoryId"
    WHERE i."companyId" = :companyId AND i.store = :store AND i."vendorId" = :vendorId AND i."isApproved" AND b."qtyLeft" > 0 ${more}
    ORDER BY i."inwardDate" DESC, i."ipNo" DESC`, rep);
  return { data: rows.map((r) => ({ ...r, inStoreSplit: m.splitQty(r.inStore, r.unit), issuedOrUsed: m.round(r.bought - r.inStore - r.returned, 3) })) };
}

function lineQty(l) {
  if (l.packCount) return m.round(l.packCount * l.qtyPerPack, 3);
  return l.qty;
}

async function create(req, store, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const [vendor] = await q('SELECT id, "isActive" FROM vendors WHERE id = :id AND "companyId" = :companyId', { id: data.vendorId, companyId }, transaction);
    if (!vendor) throw AppError.rule('UNKNOWN_VENDOR', 'Vendor not found');
    const date = data.returnDate || today();
    const ids = data.lines.map((l) => l.inwardLineId);
    if (new Set(ids).size !== ids.length) throw AppError.rule('DUPLICATE_LINE', 'Each purchase line can be returned once in a return; make the qty bigger instead');
    const found = await q(`SELECT l.id AS "inwardLineId", l."itemId", l."inwardId", i."inwardDate", i."vendorId", b.id AS "batchId", b."qtyLeft"::float AS "qtyLeft", b."valueLeft"::float AS "valueLeft", b.rate::float AS rate
      FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" JOIN store_batches b ON b."inwardLineId" = l.id
      WHERE l.id IN (:ids) AND i."companyId" = :companyId AND i.store = :store AND i."isApproved" FOR UPDATE OF b`, { ids, companyId, store }, transaction);
    const byLine = new Map(found.map((f) => [f.inwardLineId, f]));
    const items = Object.fromEntries((await StoreItem.findAll({ where: { id: [...new Set(found.map((f) => f.itemId))] }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction })).map((i) => [i.id, i]));
    const prepared = [];
    for (const l of data.lines) {
      const f = byLine.get(l.inwardLineId);
      if (!f) throw AppError.rule('UNKNOWN_LINE', 'A purchase line was not found (it must belong to an approved inward of this store)');
      if (f.vendorId !== data.vendorId) throw AppError.rule('OTHER_VENDOR', 'That purchase is from another vendor');
      if (String(f.inwardDate) > date) throw AppError.rule('RETURN_BEFORE_PURCHASE', 'The return cannot be dated before the purchase');
      const item = items[f.itemId];
      const qty = lineQty(l);
      if (qty > f.qtyLeft + 1e-9) throw AppError.rule('NOT_IN_STORE', `${item.name}: only ${m.splitQty(f.qtyLeft, item.unit).text} of this purchase is still in the store (the rest was issued or already returned)`);
      const value = Math.abs(qty - f.qtyLeft) < 1e-9 ? f.valueLeft : m.round(qty * f.rate, 2);
      prepared.push({ ...f, item, qty, value, l });
    }
    const returnNo = await counters.take(companyId, NO(store), async () => ((await q('SELECT COALESCE(MAX("returnNo"), 0) AS n FROM store_vendor_returns WHERE "companyId" = :companyId AND store = :store', { companyId, store }, transaction))[0].n) + 1, transaction);
    const total = m.round(prepared.reduce((t, p) => t + p.value, 0), 2);
    const [row] = await q(`INSERT INTO store_vendor_returns ("companyId", store, "returnNo", "returnDate", "vendorId", reason, notes, "totalValue", "createdById") VALUES (:companyId, :store, :returnNo, :date, :vendorId, :reason, :notes, :total, :by) RETURNING id`,
      { companyId, store, returnNo, date, vendorId: data.vendorId, reason: data.reason, notes: data.notes || null, total, by: req.user.id }, transaction);
    for (const p of prepared) {
      await sequelize.query(`INSERT INTO store_vendor_return_lines ("returnId", "itemId", "inwardId", "inwardLineId", "batchId", qty, rate, value, "packType", "packCount", "qtyPerPack")
        VALUES (:rid, :itemId, :inwardId, :inwardLineId, :batchId, :qty, :rate, :value, :packType, :packCount, :qtyPerPack)`,
      { replacements: { rid: row.id, itemId: p.itemId, inwardId: p.inwardId, inwardLineId: p.inwardLineId, batchId: p.batchId, qty: p.qty, rate: p.rate, value: p.value, packType: p.l.packCount ? p.l.packType || null : null, packCount: p.l.packCount || null, qtyPerPack: p.l.packCount ? p.l.qtyPerPack : null }, transaction });
      await sequelize.query('UPDATE store_batches SET "qtyLeft" = "qtyLeft" - :qty, "valueLeft" = GREATEST(0, "valueLeft" - :value), "vendorReturnedQty" = "vendorReturnedQty" + :qty WHERE id = :id', { replacements: { qty: p.qty, value: p.value, id: p.batchId }, transaction });
      const i = p.item;
      i.stockQty = m.round(i.stockQty - p.qty, 3);
      i.stockValue = i.stockQty === 0 ? 0 : Math.max(0, m.round(i.stockValue - p.value, 2));
      await i.save({ transaction });
      await StoreMove.create({ companyId, store, itemId: i.id, moveDate: date, kind: 'VENDOR_RETURN', qty: -p.qty, value: -p.value, inwardId: p.inwardId, vendorReturnId: row.id, createdById: req.user.id }, { transaction });
    }
    const after = await load(row.id, companyId, store, transaction);
    await audit.log(req, { action: 'STORE_VENDOR_RETURN_CREATED', entityType: 'StoreVendorReturn', entityId: row.id, after }, { transaction });
    return after;
  });
}

async function cancel(req, store, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const before = await load(id, companyId, store, transaction);
    if (before.status !== 'POSTED') throw AppError.rule('ALREADY_CANCELLED', 'This return is already cancelled');
    const lines = await q('SELECT "itemId", "inwardId", "batchId", qty::float AS qty, value::float AS value FROM store_vendor_return_lines WHERE "returnId" = :id', { id }, transaction);
    const items = Object.fromEntries((await StoreItem.findAll({ where: { id: [...new Set(lines.map((l) => l.itemId))] }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction })).map((i) => [i.id, i]));
    for (const l of lines) {
      await sequelize.query('UPDATE store_batches SET "qtyLeft" = "qtyLeft" + :qty, "valueLeft" = "valueLeft" + :value, "vendorReturnedQty" = GREATEST(0, "vendorReturnedQty" - :qty) WHERE id = :id', { replacements: { qty: l.qty, value: l.value, id: l.batchId }, transaction });
      const i = items[l.itemId];
      i.stockQty = m.round(i.stockQty + l.qty, 3);
      i.stockValue = m.round(i.stockValue + l.value, 2);
      await i.save({ transaction });
      await StoreMove.create({ companyId, store, itemId: i.id, moveDate: before.returnDate, kind: 'VENDOR_RETURN_UNDO', qty: l.qty, value: l.value, inwardId: l.inwardId, vendorReturnId: id, createdById: req.user.id }, { transaction });
    }
    await sequelize.query(`UPDATE store_vendor_returns SET status = 'CANCELLED', "cancelledById" = :by, "cancelledAt" = now(), "cancelReason" = :reason, "updatedAt" = now() WHERE id = :id`, { replacements: { by: req.user.id, reason, id }, transaction });
    const after = await load(id, companyId, store, transaction);
    await audit.log(req, { action: 'STORE_VENDOR_RETURN_CANCELLED', entityType: 'StoreVendorReturn', entityId: id, before, after }, { transaction });
    return after;
  });
}

async function list(req, store, f) {
  const rep = { companyId: req.user.companyId, store };
  const where = ['x."companyId" = :companyId', 'x.store = :store'];
  if (f.dateFrom) { where.push('x."returnDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('x."returnDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.vendorId) { where.push('x."vendorId" = :vendorId'); rep.vendorId = f.vendorId; }
  if (f.status) { where.push('x.status = :status'); rep.status = f.status; }
  if (f.itemId) { where.push('EXISTS (SELECT 1 FROM store_vendor_return_lines l WHERE l."returnId" = x.id AND l."itemId" = :itemId)'); rep.itemId = f.itemId; }
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM store_vendor_returns x WHERE ${where.join(' AND ')}`, rep);
  const rows = await q(`SELECT x.id, x."returnNo", x."returnDate", x.reason, x.status, x."totalValue"::float AS "totalValue", v.name AS vendor, v.id AS "vendorId",
      (SELECT string_agg(it.name, ', ' ORDER BY it.name) FROM store_vendor_return_lines l JOIN store_items it ON it.id = l."itemId" WHERE l."returnId" = x.id) AS items
    FROM store_vendor_returns x JOIN vendors v ON v.id = x."vendorId" WHERE ${where.join(' AND ')} ORDER BY x."returnDate" DESC, x."returnNo" DESC LIMIT :limit OFFSET :offset`, { ...rep, limit: f.limit, offset: (f.page - 1) * f.limit });
  return { data: rows.map((r) => ({ ...r, returnText: text(r.returnNo), reasonText: REASON_TEXT[r.reason] })), page: f.page, limit: f.limit, total: n };
}

const get = (req, store, id) => load(id, req.user.companyId, store);

module.exports = { create, cancel, list, get, returnable, REASON_TEXT, text };
