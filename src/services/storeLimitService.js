// Low-stock limits of the store (owner 2026-11-25): in Store > Settings the client sees the chemicals (items) that are IN STOCK and gives each one a limit.
// When the stock of an item is at or below its limit, the stock screen shows that row in red with a message ("stock is low, inward it") and when it was inwarded last.
// The limit is the item's "reorderLevel" (the same minimum the item form, the low-stock report and the store overview already use), so everything agrees.
//   list     GET /stores/:store/stock-limits?scope=inStock|withLimit&search=&categoryId=&low=true&page=&limit=
//   save     PUT /stores/:store/stock-limits  { items: [{ itemId, limit }] }     limit null clears it
//   warnings used by the stock screen: warningFor(item, lastInward)
const { Op } = require('sequelize');
const { sequelize, StoreItem } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const m = require('./storeMasterService');

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: 'SELECT' });
const idText = (n) => String(n).padStart(5, '0');

/** The last approved purchase of each item: when, how much, from whom. Map itemId -> { inwardId, idText, date, qty, qtyText, vendor, daysAgo }. */
async function lastInwards(itemIds, unitOf) {
  const out = new Map();
  if (!itemIds.length) return out;
  const rows = await q(`SELECT DISTINCT ON (l."itemId") l."itemId", i.id AS "inwardId", i."idNo", i."inwardDate"::text AS date, l.qty::float AS qty, v.name AS vendor, i."vendorId", l.rate::float AS rate
    FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved" LEFT JOIN vendors v ON v.id = i."vendorId"
    WHERE l."itemId" IN (:ids) ORDER BY l."itemId", i."inwardDate" DESC, i."idNo" DESC`, { ids: itemIds });
  const today = Date.parse(`${require('../utils/dates').today()}T00:00:00Z`);
  for (const r of rows) {
    out.set(r.itemId, {
      inwardId: r.inwardId, idText: idText(r.idNo), date: r.date, qty: r.qty, qtyText: m.splitQty(r.qty, unitOf(r.itemId)).text, vendor: r.vendor || null, vendorId: r.vendorId || null, rate: r.rate,
      daysAgo: Math.max(0, Math.round((today - Date.parse(`${r.date}T00:00:00Z`)) / 86400000)),
    });
  }
  return out;
}

/** null while the stock is above the limit (or there is no limit); else the red warning with a plain message. */
function warningFor(item, last) {
  if (item.reorderLevel == null || !(item.stockQty <= item.reorderLevel)) return null;
  const stockText = m.splitQty(item.stockQty, item.unit).text;
  const limitText = m.splitQty(item.reorderLevel, item.unit).text;
  const out = item.stockQty <= 0;
  const lastText = last ? ` Last inward: ${last.date}${last.qtyText ? ` (${last.qtyText}${last.vendor ? `, ${last.vendor}` : ''})` : ''}.` : ' It has never been inwarded.';
  return {
    level: 'RED', code: out ? 'OUT_OF_STOCK' : 'LOW_STOCK', limit: item.reorderLevel, limitText, stockText,
    message: out
      ? `${item.name} is out of stock (limit ${limitText}). Please inward this chemical.${lastText}`
      : `${item.name} stock is low: only ${stockText} left (limit ${limitText}). Please inward this chemical.${lastText}`,
    lastInward: last || null,
  };
}

/** What is on the way on APPROVED purchase orders, per item: ordered less what has been received (approved inwards). Map itemId -> { onOrder, orders: [labels] }. */
async function onOrderOf(itemIds) {
  const out = new Map();
  if (!itemIds.length) return out;
  const rows = await q(`SELECT pl."itemId", o."poNo", GREATEST(pl.qty - COALESCE((SELECT SUM(l.qty) FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved" WHERE l."poLineId" = pl.id), 0), 0)::float AS open
    FROM purchase_order_lines pl JOIN purchase_orders o ON o.id = pl."orderId" AND o.status = 'APPROVED' AND o."deletedAt" IS NULL WHERE pl."itemId" IN (:ids)`, { ids: itemIds });
  for (const r of rows) {
    if (r.open <= 0) continue;
    const x = out.get(r.itemId) || { onOrder: 0, orders: [] };
    x.onOrder = m.round(x.onOrder + r.open, 3);
    x.orders.push(`PO-${String(r.poNo).padStart(5, '0')}`);
    out.set(r.itemId, x);
  }
  return out;
}

/**
 * How much to order for an item at or below its limit. 0 when what is already on order lifts the stock above the limit.
 * Else the item's usual order quantity, or (without one) up to twice the limit counting what is already on order.
 */
function suggestionOf({ stockQty, limit, onOrder, orderQty }) {
  if (limit == null || !(stockQty <= limit)) return 0;
  if (stockQty + onOrder > limit) return 0;
  return orderQty || m.round(Math.max(limit * 2 - stockQty - onOrder, 0), 3);
}

/** Puts `limit`, `isLow`, `warning` and `lastInward` on the items of the stock screen (the items are the itemJSON of the master service). */
async function addWarnings(items) {
  const units = new Map(items.map((i) => [i.id, i.unit]));
  const ids = items.map((i) => i.id);
  const last = await lastInwards(ids, (id) => units.get(id));
  const coming = await onOrderOf(ids);
  const usual = new Map(ids.length ? (await q('SELECT id, "orderQty"::float AS "orderQty" FROM store_items WHERE id IN (:ids)', { ids })).map((r) => [r.id, r.orderQty]) : []);
  return items.map((i) => {
    const l = last.get(i.id) || null;
    const c = coming.get(i.id) || { onOrder: 0, orders: [] };
    const orderQty = usual.get(i.id) ?? null;
    const warning = warningFor({ name: i.name, unit: i.unit, stockQty: i.stockQty, reorderLevel: i.reorderLevel }, l);
    const suggestedOrderQty = suggestionOf({ stockQty: i.stockQty, limit: i.reorderLevel, onOrder: c.onOrder, orderQty });
    // the warning also says whether something is already on the way, and offers "Create PO" only when more is needed
    if (warning) Object.assign(warning, { onOrder: c.onOrder, openOrders: c.orders, suggestedOrderQty, canCreatePo: suggestedOrderQty > 0 });
    return { ...i, limit: i.reorderLevel, lastInward: l, orderQty, onOrder: c.onOrder, openOrders: c.orders, suggestedOrderQty, warning };
  });
}

/** Settings tab: the items in stock (or, with scope=withLimit, the items that have a limit even if the stock is finished) and their limits. */
async function list(req, store, { scope = 'inStock', search, categoryId, low, page = 1, limit = 50 }) {
  const where = { companyId: req.user.companyId, store, isActive: true };
  if (scope === 'withLimit') where.reorderLevel = { [Op.ne]: null };
  else where.stockQty = { [Op.gt]: 0 };
  if (categoryId) where.categoryId = categoryId;
  if (search) where.name = { [Op.iLike]: `%${String(search).trim()}%` };
  if (low) { where.reorderLevel = { [Op.ne]: null }; where[Op.and] = [sequelize.where(sequelize.col('StoreItem.stockQty'), Op.lte, sequelize.col('StoreItem.reorderLevel'))]; }
  const { rows, count } = await StoreItem.findAndCountAll({ where, include: m.itemInclude, order: [['name', 'ASC']], limit, offset: (page - 1) * limit });
  const items = await addWarnings(rows.map((r) => m.itemJSON(r)));
  const [c] = await q(`SELECT count(*) FILTER (WHERE "stockQty" > 0)::int AS "inStock", count(*) FILTER (WHERE "stockQty" > 0 AND "reorderLevel" IS NOT NULL)::int AS "withLimit",
      count(*) FILTER (WHERE "reorderLevel" IS NOT NULL AND "stockQty" <= "reorderLevel")::int AS low
    FROM store_items WHERE "companyId" = :companyId AND store = :store AND "isActive"`, { companyId: req.user.companyId, store });
  return {
    data: items.map((i) => ({
      itemId: i.id, name: i.name, label: i.label, category: i.category, brand: i.brand, unit: i.unit, stockQty: i.stockQty, stock: i.stock, limit: i.reorderLevel, isLow: i.isLow,
      warning: i.warning, lastInward: i.lastInward, orderQty: i.orderQty, onOrder: i.onOrder, openOrders: i.openOrders, suggestedOrderQty: i.suggestedOrderQty,
    })),
    page, limit, total: count, counts: c,
  };
}

/** PUT: set or clear the limits of several items at once. */
async function save(req, store, { items }) {
  const { companyId } = req.user;
  const ids = [...new Set(items.map((x) => x.itemId))];
  if (ids.length !== items.length) throw AppError.rule('DUPLICATE_ITEM', 'An item is in the list twice');
  await sequelize.transaction(async (transaction) => {
    const rows = await StoreItem.findAll({ where: { id: ids, companyId, store }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
    if (rows.length !== ids.length) throw AppError.notFound('Item');
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const { itemId, limit, orderQty } of items) {
      const it = byId.get(itemId);
      const before = it.reorderLevel == null ? null : Number(it.reorderLevel);
      const after = limit == null ? null : Number(limit);
      const usualBefore = it.orderQty == null ? null : Number(it.orderQty);
      const usualAfter = orderQty === undefined ? usualBefore : orderQty; // not sent: unchanged
      if (before === after && usualBefore === usualAfter) continue;
      await it.update({ reorderLevel: after, orderQty: usualAfter }, { transaction });
      await audit.log(req, { action: 'STORE_ITEM_LIMIT_SET', entityType: 'StoreItem', entityId: itemId, before: { name: it.name, limit: before, orderQty: usualBefore }, after: { name: it.name, limit: after, orderQty: usualAfter, unit: it.unit } }, { transaction });
    }
  });
  return { saved: items.length };
}

/** One item (a StoreItem row with its category and brand) as the master service shows it, plus its limit, warning and last inward. */
async function itemWithWarning(item) {
  return (await addWarnings([m.itemJSON(item)]))[0];
}

/**
 * "Create PO" of the low-stock list: the items at or below their limit (all, or the chosen ones) that need more, grouped by the vendor of their last purchase,
 * with the quantity to order and the last rate. The screen opens the PO form with these lines; nothing is created here.
 */
async function poSuggestion(req, store, { itemIds }) {
  const where = { companyId: req.user.companyId, store, isActive: true, reorderLevel: { [Op.ne]: null } };
  if (itemIds && itemIds.length) where.id = itemIds;
  const rows = await StoreItem.findAll({ where, include: m.itemInclude, order: [['name', 'ASC']] });
  const low = (await addWarnings(rows.map((r) => m.itemJSON(r)))).filter((i) => i.warning);
  const groups = new Map();
  const covered = [];
  for (const i of low) {
    if (!(i.suggestedOrderQty > 0)) { covered.push({ itemId: i.id, name: i.name, onOrder: i.onOrder, openOrders: i.openOrders }); continue; }
    const vendorId = (i.lastInward && i.lastInward.vendorId) || null;
    if (!groups.has(vendorId)) groups.set(vendorId, { vendor: vendorId ? { id: vendorId, name: i.lastInward.vendor } : null, lines: [] });
    groups.get(vendorId).lines.push({ itemId: i.id, name: i.name, unit: i.unit, qty: i.suggestedOrderQty, rate: (i.lastInward && i.lastInward.rate) ?? null, stockQty: i.stockQty, limit: i.limit, onOrder: i.onOrder });
  }
  return { store, groups: [...groups.values()], covered, note: 'One purchase order is for one vendor: make one order for each group. A group without a vendor was never bought: pick the vendor.' };
}

module.exports = { poSuggestion, suggestionOf, list, save, addWarnings, warningFor, lastInwards, itemWithWarning };
