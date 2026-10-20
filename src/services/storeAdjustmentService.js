// Stock adjustments (both stores): the store fixes stock after a count, damage, expiry ... with a reason.
// Each line is one of:
//   COUNT  "we counted X"   -> the stock becomes X (plus or minus the difference)
//   IN     "add X"          -> stock up (at the given rate, else the average rate)
//   OUT    "remove X"       -> stock down at the average rate
// It applies at once and cannot be edited; a wrong one is fixed with another adjustment.
const { Op } = require('sequelize');
const { sequelize, StoreAdjustment, StoreAdjustmentLine, StoreItem, StoreMove, User } = require('../models');
const batches = require('./batchService');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const m = require('./storeMasterService');
const { lineQty } = require('./chemicalRequestService');

const REASON_TEXT = { COUNT: 'Stock count', DAMAGED: 'Damaged', EXPIRED: 'Expired', LOST: 'Lost / missing', OTHER: 'Other' };
const include = () => [
  { model: StoreAdjustmentLine, as: 'lines', include: [{ model: StoreItem, as: 'item', include: m.itemInclude.map((x) => ({ ...x })) }] },
  { model: User, as: 'createdBy', attributes: ['id', 'name'] },
];

function json(a) {
  return {
    id: a.id,
    store: a.store,
    adjNo: a.adjNo,
    adjDate: a.adjDate,
    reason: a.reason,
    reasonText: REASON_TEXT[a.reason],
    notes: a.notes,
    totalValue: a.totalValue,
    lines: (a.lines || []).map((l) => ({
      id: l.id,
      item: { id: l.item.id, name: l.item.name, label: m.itemJSON(l.item).label, unit: l.item.unit },
      direction: l.qty > 0 ? 'IN' : 'OUT',
      stockBefore: l.stockBefore, stockBeforeSplit: m.splitQty(l.stockBefore, l.item.unit),
      qty: l.qty, qtySplit: m.splitQty(Math.abs(l.qty), l.item.unit),
      stockAfter: m.round(l.stockBefore + l.qty, 3), stockAfterSplit: m.splitQty(m.round(l.stockBefore + l.qty, 3), l.item.unit),
      rate: l.rate, value: l.value,
    })),
    createdBy: a.createdBy ? { id: a.createdBy.id, name: a.createdBy.name } : null,
    createdAt: a.createdAt,
  };
}

async function list(req, store, q) {
  const where = { companyId: req.user.companyId, store };
  if (q.reason) where.reason = q.reason;
  if (q.dateFrom || q.dateTo) where.adjDate = { ...(q.dateFrom && { [Op.gte]: q.dateFrom }), ...(q.dateTo && { [Op.lte]: q.dateTo }) };
  if (q.itemId) where.id = { [Op.in]: sequelize.literal(`(SELECT "adjustmentId" FROM store_adjustment_lines WHERE "itemId" = ${sequelize.escape(q.itemId)})`) };
  const { rows, count } = await StoreAdjustment.findAndCountAll({ where, include: include(), distinct: true, order: [['adjNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit });
  return { data: rows.map(json), total: count, page: q.page, limit: q.limit };
}

async function get(req, store, id) {
  const a = await StoreAdjustment.findOne({ where: { id, companyId: req.user.companyId, store }, include: include() });
  if (!a) throw AppError.notFound('Stock adjustment');
  return json(a);
}

async function create(req, store, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const ids = data.lines.map((l) => l.itemId);
    if (new Set(ids).size !== ids.length) throw AppError.rule('DUPLICATE_ITEM', 'An item is twice in the list; put it once');
    const items = new Map((await StoreItem.findAll({ where: { id: ids, companyId, store }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction })).map((i) => [i.id, i]));
    const out = [];
    for (const l of data.lines) {
      const item = items.get(l.itemId);
      if (!item) throw AppError.rule('UNKNOWN_ITEM', 'An item is not in this store');
      const n = lineQty(l, item.unit);
      const before = item.stockQty;
      let qty;
      if (l.mode === 'COUNT') qty = m.round(n - before, 3);
      else qty = l.mode === 'IN' ? n : -n;
      if (l.mode !== 'COUNT' && !(n > 0)) throw AppError.rule('QTY_REQUIRED', `Enter the quantity of ${item.name}`);
      if (qty === 0) throw AppError.rule('NO_CHANGE', `${item.name}: the count is the same as the stock`);
      if (before + qty < 0) throw AppError.rule('NOT_ENOUGH_STOCK', `${item.name}: only ${m.splitQty(before, item.unit).text} in stock`);
      const avg = before > 0 ? m.round(item.stockValue / before, 4) : 0;
      let rate = qty > 0 && l.rate !== undefined && l.rate !== null ? l.rate : avg;
      let value = m.round(qty * rate, 2);
      // stock out comes from the batches (the one picked, else oldest first); stock in is a new batch
      if (qty < 0) {
        const got = await batches.take(transaction, item, -qty, l.batchId ? [{ batchId: l.batchId, qty: -qty }] : null);
        value = -m.round(got.reduce((t, p) => t + p.value, 0), 2);
        rate = m.round(-value / -qty, 4);
      }
      item.stockQty = m.round(before + qty, 3);
      item.stockValue = item.stockQty === 0 ? 0 : Math.max(0, m.round(item.stockValue + value, 2));
      await item.save({ transaction });
      out.push({ itemId: item.id, stockBefore: before, qty, rate, value });
    }
    const adjNo = await counters.take(companyId, `store_adjustment_no_${store}`, async () => ((await StoreAdjustment.max('adjNo', { where: { companyId, store }, transaction })) || 0) + 1, transaction);
    const a = await StoreAdjustment.create({
      companyId, store, adjNo, adjDate: data.adjDate || new Date().toISOString().slice(0, 10), reason: data.reason, notes: data.notes || null,
      totalValue: m.round(out.reduce((t, l) => t + l.value, 0), 2), createdById: req.user.id,
    }, { transaction });
    await StoreAdjustmentLine.bulkCreate(out.map((l) => ({ ...l, adjustmentId: a.id })), { transaction });
    for (const l of out) {
      if (l.qty > 0) await batches.add(transaction, { companyId, store, itemId: l.itemId, source: 'ADJUST', qty: l.qty, rate: l.rate, value: l.value, inDate: a.adjDate, adjustmentId: a.id });
      await StoreMove.create({ companyId, store, itemId: l.itemId, moveDate: a.adjDate, kind: 'ADJUST', qty: l.qty, value: l.value, adjustmentId: a.id, createdById: req.user.id }, { transaction });
    }
    const after = json(await StoreAdjustment.findByPk(a.id, { include: include(), transaction }));
    await audit.log(req, { action: 'STOCK_ADJUSTED', entityType: 'StoreAdjustment', entityId: a.id, after }, { transaction });
    return after;
  });
}

module.exports = { list, get, create, REASON_TEXT };
