// Step 7: store inward (purchase) entries and stock, for the Chemical Store and the General Items Store.
// - An entry starts UN-APPROVED (a draft). A draft can be saved even when a rate is not known yet
//   (rate left empty); it adds nothing to stock and can be edited or deleted.
// - Approve: every line needs a rate. The entry gets its IP#, is locked, and its items go into stock
//   (stock qty up, stock value up by the line amount; average rate = value / qty).
// - Only the client admin can take an approval back, and only while that stock is still in the store.
// - ID# is given at create (shows as 00909); IP# at approval. Both run separately per store.
const { Op } = require('sequelize');
const { sequelize, Vendor, StoreItem, StoreInward, StoreInwardLine, StoreMove, StoreCategory, StoreBrand, UNITS, Service } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const counters = require('./counterService');
const m = require('./storeMasterService');
const batches = require('./batchService');

const ID = (store) => `store_inward_id:${store}`;
const IP = (store) => `store_ip_no:${store}`;
const idText = (n) => String(n).padStart(5, '0');
const blank = (v) => (v === '' ? null : v);

const include = [
  { model: Vendor, as: 'vendor' },
  { model: StoreInwardLine, as: 'lines', include: [{ model: StoreItem, as: 'item', include: m.itemInclude }] },
];

/** "25 KG 500 G" when all lines share one unit, else null (the list then shows totalQty). */
function lineUnits(e) {
  const units = new Set((e.lines || []).map((l) => l.item && l.item.unit));
  return units.size === 1 ? m.splitQty(e.totalQty, [...units][0]).text : null;
}

/** What went back to the vendor (posted returns only; cancelled ones are not counted), per entry and per line. */
async function returnedOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sequelize.query(`SELECT l."inwardId", l."inwardLineId", SUM(l.qty)::float AS qty, SUM(l.value)::float AS value
    FROM store_vendor_return_lines l JOIN store_vendor_returns x ON x.id = l."returnId" AND x.status = 'POSTED'
    WHERE l."inwardId" IN (:ids) GROUP BY l."inwardId", l."inwardLineId"`, { replacements: { ids }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const r of rows) {
    const x = map.get(r.inwardId) || { value: 0, lines: new Map() };
    x.value = m.round(x.value + r.value, 2);
    x.lines.set(r.inwardLineId, { qty: r.qty, value: r.value });
    map.set(r.inwardId, x);
  }
  return map;
}

function json(e, withLines = true, ret = { value: 0, lines: new Map() }) {
  const billedGross = m.round(e.amount + e.salesTax, 2);
  // GST on the returned goods follows the entry's GST %; the bill balance falls by the returned value and its tax
  const returnedTax = e.gstPercent ? m.round((ret.value * e.gstPercent) / 100, 2) : 0;
  const balance = m.round(billedGross - ret.value - returnedTax, 2);
  const out = {
    id: e.id,
    store: e.store,
    idNo: e.idNo,
    idText: idText(e.idNo),
    ipNo: e.ipNo,
    inwardDate: e.inwardDate,
    billType: e.billType,
    vendor: e.vendor ? m.vendorJSON(e.vendor) : null,
    acntNo: e.acntNo,
    dcNo: e.dcNo,
    grnNo: e.grnNo,
    notes: e.notes,
    totalQty: e.totalQty,
    amount: e.amount,
    gstPercent: e.gstPercent,
    salesTax: e.salesTax,
    returnedValue: ret.value,
    returnedTax,
    netAmount: m.round(e.amount - ret.value, 2),
    hasReturns: ret.value > 0,
    totalQtyText: lineUnits(e),
    billed: billedGross,
    paid: 0, // filled by the accounts module later
    balance, // bill less returned goods (and their GST)
    isApproved: e.isApproved,
    statusText: e.isApproved ? 'APPROVED' : 'UN-APPROVED',
    approvedAt: e.approvedAt,
    hasMissingRates: (e.lines || []).some((l) => l.rate === null),
    createdAt: e.createdAt,
  };
  if (withLines) {
    out.lines = [...(e.lines || [])].sort((a, b) => a.sortOrder - b.sortOrder).map((l) => ({
      id: l.id,
      item: { id: l.item.id, name: l.item.name, unit: l.item.unit, category: l.item.category ? l.item.category.name : null, brand: l.item.brand ? l.item.brand.name : null },
      qty: l.qty,
      qtySplit: m.splitQty(l.qty, l.item.unit),
      unit: l.item.unit,
      rate: l.rate,
      amount: l.amount,
      returnedQty: (ret.lines.get(l.id) || {}).qty || 0,
      netQty: m.round(l.qty - ((ret.lines.get(l.id) || {}).qty || 0), 3),
      returnedValue: (ret.lines.get(l.id) || {}).value || 0,
      packType: l.packType, packCount: l.packCount, qtyPerPack: l.qtyPerPack,
    }));
  }
  return out;
}

async function findOr404(req, store, id, transaction) {
  const e = await StoreInward.findOne({ where: { id, companyId: req.user.companyId, store }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!e) throw AppError.notFound('Inward entry');
  return e;
}
const load = async (id, transaction) => json(await StoreInward.findByPk(id, { include, transaction }), true, (await returnedOf([id], transaction)).get(id));

/** Next numbers and every dropdown the entry screen needs, in one call. */
async function formData(req, store) {
  const companyId = req.user.companyId;
  const startId = async () => ((await StoreInward.max('idNo', { where: { companyId, store } })) || 0) + 1;
  const where = { companyId, isActive: true };
  const [nextId, vendors, items, categories, brands] = await Promise.all([
    counters.peek(companyId, ID(store), startId),
    Vendor.findAll({ where, order: [['name', 'ASC']] }),
    StoreItem.findAll({ where: { ...where, store }, include: m.itemInclude, order: [[{ model: StoreCategory, as: 'category' }, 'name', 'ASC'], ['name', 'ASC']] }),
    StoreCategory.findAll({ where: { ...where, store }, order: [['name', 'ASC']] }),
    StoreBrand.findAll({ where: { ...where, store }, order: [['name', 'ASC']] }),
  ]);
  return {
    store,
    nextIdNo: nextId,
    nextIdText: idText(nextId),
    today: today(),
    billTypes: store === 'CHEMICAL' ? ['GST', 'OTHER'] : ['OTHER'],
    gstRates: [0, 17, 18],
    subUnits: m.SUB_UNITS,
    units: UNITS,
    vendors: vendors.map(m.vendorJSON),
    items: items.map(m.itemJSON),
    categories: categories.map(m.namedJSON),
    brands: brands.map(m.namedJSON),
  };
}

/**
 * Vendor typed on the entry screen: an existing vendor with that name (any case) is used,
 * otherwise a new vendor is added with the next code.
 */
async function vendorByName(req, name, transaction) {
  const companyId = req.user.companyId;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`vendor-code:${companyId}`], transaction });
  const found = await Vendor.findOne({ where: { companyId, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] }, transaction });
  if (found) return found.id;
  const code = ((await Vendor.max('code', { where: { companyId }, transaction })) || 0) + 1;
  const v = await Vendor.create({ companyId, code, name, createdById: req.user.id }, { transaction });
  await audit.log(req, { action: 'VENDOR_CREATED', entityType: 'Vendor', entityId: v.id, after: m.vendorJSON(v) }, { transaction });
  return v.id;
}

/**
 * Item typed on the entry screen instead of picked: the item with that name (any case) is used,
 * inside the given category, or the only one with that name; otherwise a new item is added
 * (unit as sent, default KG for chemicals and PCS for general items). Next time it is in the dropdown.
 */
async function itemByName(req, store, line, transaction) {
  const companyId = req.user.companyId;
  const name = line.itemName.trim();
  if (line.categoryId && !(await StoreCategory.findOne({ where: { id: line.categoryId, companyId, store }, transaction }))) {
    throw AppError.rule('UNKNOWN_CATEGORY', 'category not found in this store');
  }
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`store-item:${companyId}:${store}`], transaction });
  const where = { companyId, store, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] };
  // with a category: that category's item; without: the item of that name in any category
  if (line.categoryId) where.categoryId = line.categoryId;
  const found = await StoreItem.findAll({ where, transaction });
  if (found.length === 1) return found[0].id;
  if (found.length > 1) throw AppError.rule('PICK_CATEGORY', `"${name}" is in more than one category; pick the category`);
  const unit = line.unit || (store === 'CHEMICAL' ? 'KG' : 'PCS');
  const item = await StoreItem.create({ companyId, store, name, unit, categoryId: line.categoryId || null, createdById: req.user.id }, { transaction });
  await audit.log(req, { action: 'STOREITEM_CREATED', entityType: 'StoreItem', entityId: item.id, after: { name, unit, store, categoryId: item.categoryId } }, { transaction });
  return item.id;
}

/** A line gives qty (3.5) or the two boxes qtyMain + qtySub (3 KG + 500 G). */
function lineQty(l, unit) {
  if (l.packCount) return m.round(l.packCount * l.qtyPerPack, 3); // 3 drums x 200 kg
  if (l.qty !== undefined) return l.qty;
  const sub = l.qtySub || 0;
  if (sub && !m.SUB_UNITS[unit]) throw AppError.rule('NO_SUB_UNIT', `${unit} has no small unit; enter the quantity in ${unit}`);
  if (sub >= 1000) throw AppError.rule('SUB_TOO_BIG', `Enter less than 1000 ${m.SUB_UNITS[unit]}; 1000 ${m.SUB_UNITS[unit]} = 1 ${unit}`);
  const qty = m.round((l.qtyMain || 0) + sub / 1000, 3);
  if (qty <= 0) throw AppError.rule('QTY_REQUIRED', 'Enter the quantity');
  return qty;
}

/** Checks the vendor and items and works out line amounts and totals. */
async function prepare(req, store, data, transaction) {
  const companyId = req.user.companyId;
  if (data.vendorId === '') data.vendorId = null;
  if (data.vendorName && !data.vendorId) data.vendorId = await vendorByName(req, data.vendorName, transaction);
  if (data.vendorId) {
    const v = await Vendor.findOne({ where: { id: data.vendorId, companyId }, transaction });
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'Vendor not found');
    if (!v.isActive) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off');
  }
  if (!data.lines) return null;
  for (const l of data.lines) {
    if (!l.itemId && !l.itemName) throw AppError.rule('ITEM_REQUIRED', 'Select or type the item of every line');
    if (!l.itemId) l.itemId = await itemByName(req, store, l, transaction);
  }
  const ids = [...new Set(data.lines.map((l) => l.itemId))];
  const items = await StoreItem.findAll({ where: { id: ids, companyId, store }, transaction });
  if (items.length !== ids.length) throw AppError.rule('UNKNOWN_ITEM', 'Some items are not in this store');
  const off = items.find((i) => !i.isActive);
  if (off) throw AppError.rule('ITEM_INACTIVE', `${off.name} is switched off`);
  const unitOf = Object.fromEntries(items.map((i) => [i.id, i.unit]));
  return data.lines.map((l, i) => {
    const qty = lineQty(l, unitOf[l.itemId]);
    return {
      itemId: l.itemId, qty, rate: l.rate ?? null, amount: l.rate == null ? 0 : m.round(qty * l.rate, 2), sortOrder: i,
      packType: l.packCount ? l.packType || null : null, packCount: l.packCount || null, qtyPerPack: l.packCount ? l.qtyPerPack : null,
    };
  });
}

const totals = (lines) => ({
  totalQty: m.round(lines.reduce((s, l) => s + l.qty, 0), 3),
  amount: m.round(lines.reduce((s, l) => s + l.amount, 0), 2),
});

const headerFields = ['inwardDate', 'billType', 'vendorId', 'acntNo', 'dcNo', 'grnNo', 'notes', 'salesTax', 'gstPercent'];

/** With a GST % picked, the sales tax = amount x % (OTHER bills have no GST). */
function applyGst(e) {
  if (e.billType !== 'GST') { e.gstPercent = null; if (e.store === 'GENERAL') e.salesTax = 0; return; }
  if (e.gstPercent != null) e.salesTax = m.round((e.amount * e.gstPercent) / 100, 2);
}

async function create(req, store, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const lines = await prepare(req, store, data, transaction);
    const idNo = await counters.take(companyId, ID(store), async () => ((await StoreInward.max('idNo', { where: { companyId, store }, transaction })) || 0) + 1, transaction);
    const header = Object.fromEntries(headerFields.filter((f) => data[f] !== undefined).map((f) => [f, blank(data[f])]));
    if (store === 'GENERAL') header.billType = 'OTHER';
    const e = StoreInward.build({ ...header, companyId, store, idNo, ...totals(lines), createdById: req.user.id });
    applyGst(e);
    await e.save({ transaction });
    await StoreInwardLine.bulkCreate(lines.map((l) => ({ ...l, inwardId: e.id })), { transaction });
    const after = await load(e.id, transaction);
    await audit.log(req, { action: 'STORE_INWARD_CREATED', entityType: 'StoreInward', entityId: e.id, after }, { transaction });
    const result = data.approve ? await approveIn(req, store, e.id, transaction) : after;
    return result;
  });
}

async function update(req, store, id, data) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, store, id, transaction);
    if (e.isApproved) throw AppError.rule('ENTRY_APPROVED', 'Approved entries cannot be changed');
    const before = await load(id, transaction);
    const lines = await prepare(req, store, data, transaction);
    for (const f of headerFields) if (data[f] !== undefined) e[f] = blank(data[f]);
    if (store === 'GENERAL') e.billType = 'OTHER';
    if (lines) {
      await StoreInwardLine.destroy({ where: { inwardId: id }, transaction });
      await StoreInwardLine.bulkCreate(lines.map((l) => ({ ...l, inwardId: id })), { transaction });
      Object.assign(e, totals(lines));
    }
    applyGst(e);
    await e.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'STORE_INWARD_UPDATED', entityType: 'StoreInward', entityId: id, before, after }, { transaction });
    return data.approve ? approveIn(req, store, id, transaction) : after;
  });
}

async function remove(req, store, id) {
  return sequelize.transaction(async (transaction) => {
    const e = await findOr404(req, store, id, transaction);
    if (e.isApproved) throw AppError.rule('ENTRY_APPROVED', 'Approved entries cannot be deleted');
    // once it had an IP# it stays in the books (and in the stock history); edit it instead
    if (e.ipNo) throw AppError.rule('ENTRY_HAS_IP', 'This entry was approved before; edit it instead of deleting');
    const before = await load(id, transaction);
    await StoreInwardLine.destroy({ where: { inwardId: id }, transaction });
    await e.destroy({ transaction });
    await audit.log(req, { action: 'STORE_INWARD_DELETED', entityType: 'StoreInward', entityId: id, before }, { transaction });
  });
}

/** Locks the items in a fixed order so two approvals at once cannot lose a stock change. */
const lockItems = (ids, transaction) => StoreItem.findAll({ where: { id: [...new Set(ids)] }, order: [['id', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });

async function approveIn(req, store, id, transaction) {
  const companyId = req.user.companyId;
  const e = await findOr404(req, store, id, transaction);
  if (e.isApproved) throw AppError.rule('ENTRY_APPROVED', 'Already approved');
  const lines = await StoreInwardLine.findAll({ where: { inwardId: id }, transaction });
  if (!lines.length) throw AppError.rule('NO_LINES', 'Add at least one item');
  if (lines.some((l) => l.rate === null)) throw AppError.rule('RATE_MISSING', 'Enter the rate of every item before approving');
  if (!e.vendorId) throw AppError.rule('VENDOR_MISSING', 'Select the vendor before approving');
  const items = Object.fromEntries((await lockItems(lines.map((l) => l.itemId), transaction)).map((i) => [i.id, i]));
  for (const l of lines) {
    const i = items[l.itemId];
    i.stockQty = m.round(i.stockQty + l.qty, 3);
    i.stockValue = m.round(i.stockValue + l.amount, 2);
    await StoreMove.create({ companyId, store, itemId: i.id, moveDate: e.inwardDate, kind: 'INWARD', qty: l.qty, value: l.amount, inwardId: id, createdById: req.user.id }, { transaction });
    // every line is its own batch with its own rate (owner 2026-10-19)
    await batches.add(transaction, { companyId, store, itemId: i.id, source: 'INWARD', qty: l.qty, rate: l.qty ? l.amount / l.qty : l.rate, value: l.amount, inDate: e.inwardDate, inwardId: id, inwardLineId: l.id, vendorId: e.vendorId });
  }
  for (const i of Object.values(items)) await i.save({ transaction });
  if (!e.ipNo) e.ipNo = await counters.take(companyId, IP(store), async () => ((await StoreInward.max('ipNo', { where: { companyId, store }, transaction })) || 0) + 1, transaction);
  Object.assign(e, { isApproved: true, approvedById: req.user.id, approvedAt: new Date() });
  await e.save({ transaction });
  const after = await load(id, transaction);
  await audit.log(req, { action: 'STORE_INWARD_APPROVED', entityType: 'StoreInward', entityId: id, after }, { transaction });
  return after;
}


/**
 * Fix an APPROVED entry (owner 2026-10-22): wrong quantity, rate, item, vendor, date, bill details.
 * The whole entry is sent again; lines that already exist carry their lineId. The stock follows the change:
 *  - header (vendor, date, DC#, GRN#, notes, GST) can always change;
 *  - a line nothing was issued from can change in everything or be removed;
 *  - a line that was already (partly) issued keeps its item and rate; its quantity can change but not below what was issued.
 * Every change is a store movement ("Purchase corrected", dated on the purchase date) and is audited with the reason.
 */
async function correct(req, store, id, data) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const e = await findOr404(req, store, id, transaction);
    if (!e.isApproved) throw AppError.rule('NOT_APPROVED', 'This entry is not approved yet; edit it normally');
    const before = await load(id, transaction);
    const reason = data.reason;
    const fresh = await prepare(req, store, { ...data, lines: data.lines.map((l) => ({ ...l })) }, transaction);
    fresh.forEach((l, i) => { l.lineId = data.lines[i].lineId || null; });
    if (fresh.some((l) => l.rate === null)) throw AppError.rule('RATE_MISSING', 'Enter the rate of every item');
    if (!(data.vendorId ?? e.vendorId)) throw AppError.rule('VENDOR_MISSING', 'Select the vendor');
    const oldLines = await StoreInwardLine.findAll({ where: { inwardId: id }, transaction });
    const oldById = new Map(oldLines.map((l) => [l.id, l]));
    for (const l of fresh) if (l.lineId && !oldById.has(l.lineId)) throw AppError.rule('UNKNOWN_LINE', 'A line of this entry was not found');
    if (new Set(fresh.map((l) => l.lineId).filter(Boolean)).size !== fresh.filter((l) => l.lineId).length) throw AppError.rule('DUPLICATE_LINE', 'A line was sent twice');
    const batchRows = await sequelize.query('SELECT id, "inwardLineId", "qtyIn"::float AS "qtyIn", "qtyLeft"::float AS "qtyLeft", rate::float AS rate FROM store_batches WHERE "inwardId" = :id FOR UPDATE',
      { replacements: { id }, type: sequelize.QueryTypes.SELECT, transaction });
    const batchOf = new Map(batchRows.map((b) => [b.inwardLineId, b]));
    const itemIds = [...oldLines.map((l) => l.itemId), ...fresh.map((l) => l.itemId)];
    const items = Object.fromEntries((await lockItems(itemIds, transaction)).map((i) => [i.id, i]));
    const date = data.inwardDate || e.inwardDate;
    const vendorId = data.vendorId === undefined ? e.vendorId : data.vendorId;
    const move = (itemId, qty, value) => StoreMove.create({ companyId, store, itemId, moveDate: date, kind: 'INWARD_EDIT', qty, value, inwardId: id, createdById: req.user.id }, { transaction });
    const change = (itemId, dq, dv) => {
      const i = items[itemId];
      i.stockQty = m.round(i.stockQty + dq, 3);
      i.stockValue = i.stockQty === 0 ? 0 : m.round(i.stockValue + dv, 2);
      if (i.stockQty < 0 || i.stockValue < 0) throw AppError.rule('STOCK_USED', `${i.name}: this stock has already been issued`);
    };
    const isUsed = (l) => { const b = batchOf.get(l.id); return !b || b.qtyLeft < b.qtyIn - 1e-9; };
    const keptIds = new Set(fresh.map((l) => l.lineId).filter(Boolean));
    // removed lines
    for (const l of oldLines.filter((x) => !keptIds.has(x.id))) {
      if (isUsed(l)) throw AppError.rule('LINE_USED', `${items[l.itemId].name}: this stock has already been issued, the line cannot be removed`);
      change(l.itemId, -l.qty, -l.amount); await move(l.itemId, -l.qty, -l.amount);
      await sequelize.query('DELETE FROM store_batches WHERE "inwardLineId" = :lid', { replacements: { lid: l.id }, transaction });
      await l.destroy({ transaction });
    }
    const added = [];
    for (const n of fresh) {
      const o = n.lineId && oldById.get(n.lineId);
      if (!o) { added.push(n); continue; }
      const b = batchOf.get(o.id);
      const same = o.itemId === n.itemId && Math.abs((o.rate ?? 0) - n.rate) < 1e-9;
      if (!same && !isUsed(o)) {
        // another item or rate and nothing issued: take the old line out and put the new one in
        change(o.itemId, -o.qty, -o.amount); await move(o.itemId, -o.qty, -o.amount);
        await sequelize.query('DELETE FROM store_batches WHERE "inwardLineId" = :lid', { replacements: { lid: o.id }, transaction });
        await o.destroy({ transaction });
        added.push(n);
        continue;
      }
      // same item and rate (or part already issued): only the quantity changes
      if (!same) throw AppError.rule('LINE_USED', `${items[o.itemId].name}: part of this stock was already issued, so its item and rate cannot change`);
      const issued = m.round(b.qtyIn - b.qtyLeft, 3);
      if (n.qty < issued - 1e-9) throw AppError.rule('QTY_BELOW_ISSUED', `${items[o.itemId].name}: ${issued} was already issued or returned to the vendor, the quantity cannot be less`);
      const dq = m.round(n.qty - o.qty, 3);
      if (dq !== 0) {
        const dv = m.round(dq * b.rate, 2);
        change(o.itemId, dq, dv); await move(o.itemId, dq, dv);
        await sequelize.query('UPDATE store_batches SET "qtyIn" = "qtyIn" + :dq, "qtyLeft" = "qtyLeft" + :dq, "valueLeft" = "valueLeft" + :dv WHERE id = :bid', { replacements: { dq, dv, bid: b.id }, transaction });
        o.qty = n.qty; o.amount = m.round(n.qty * b.rate, 2);
      }
      o.sortOrder = n.sortOrder; Object.assign(o, { packType: n.packType, packCount: n.packCount, qtyPerPack: n.qtyPerPack }); await o.save({ transaction });
    }
    for (const n of added) {
      change(n.itemId, n.qty, n.amount); await move(n.itemId, n.qty, n.amount);
      const row = await StoreInwardLine.create({ inwardId: id, itemId: n.itemId, qty: n.qty, rate: n.rate, amount: n.amount, sortOrder: n.sortOrder, packType: n.packType, packCount: n.packCount, qtyPerPack: n.qtyPerPack }, { transaction });
      await batches.add(transaction, { companyId, store, itemId: n.itemId, source: 'INWARD', qty: n.qty, rate: n.qty ? n.amount / n.qty : n.rate, value: n.amount, inDate: date, inwardId: id, inwardLineId: row.id, vendorId });
    }
    for (const i of Object.values(items)) await i.save({ transaction });
    // header; vendor and date follow into the batches and the old movements of this entry
    for (const f of headerFields) if (data[f] !== undefined) e[f] = blank(data[f]);
    if (store === 'GENERAL') e.billType = 'OTHER';
    const all = await StoreInwardLine.findAll({ where: { inwardId: id }, transaction });
    Object.assign(e, totals(all.map((l) => ({ qty: l.qty, amount: l.amount }))));
    applyGst(e);
    await e.save({ transaction });
    await sequelize.query('UPDATE store_batches SET "vendorId" = :vendorId, "inDate" = :date WHERE "inwardId" = :id', { replacements: { vendorId, date, id }, transaction });
    await sequelize.query(`UPDATE store_moves SET "moveDate" = :date WHERE "inwardId" = :id AND kind IN ('INWARD', 'INWARD_UNDO', 'INWARD_EDIT')`, { replacements: { date, id }, transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'STORE_INWARD_CORRECTED', entityType: 'StoreInward', entityId: id, before, after: { ...after, correctionReason: reason } }, { transaction });
    return after;
  });
}

const approve = (req, store, id) => sequelize.transaction((t) => approveIn(req, store, id, t));

async function unapprove(req, store, id) {
  return sequelize.transaction(async (transaction) => {
    const companyId = req.user.companyId;
    const e = await findOr404(req, store, id, transaction);
    if (!e.isApproved) throw AppError.rule('NOT_APPROVED', 'This entry is not approved');
    const lines = await StoreInwardLine.findAll({ where: { inwardId: id }, transaction });
    const items = Object.fromEntries((await lockItems(lines.map((l) => l.itemId), transaction)).map((i) => [i.id, i]));
    const used = await sequelize.query(`SELECT b.id, it.name FROM store_batches b JOIN store_items it ON it.id = b."itemId"
      WHERE b."inwardId" = :id AND b."qtyLeft" < b."qtyIn" FOR UPDATE OF b`, { replacements: { id }, type: sequelize.QueryTypes.SELECT, transaction });
    if (used.length) throw AppError.rule('STOCK_USED', `${used[0].name}: this stock has already been issued`);
    await sequelize.query('DELETE FROM store_batches WHERE "inwardId" = :id', { replacements: { id }, transaction });
    for (const l of lines) {
      const i = items[l.itemId];
      if (i.stockQty < l.qty) throw AppError.rule('STOCK_USED', `${i.name}: this stock has already been issued`);
      i.stockQty = m.round(i.stockQty - l.qty, 3);
      i.stockValue = i.stockQty === 0 ? 0 : Math.max(0, m.round(i.stockValue - l.amount, 2));
      await StoreMove.create({ companyId, store, itemId: i.id, moveDate: e.inwardDate, kind: 'INWARD_UNDO', qty: -l.qty, value: -l.amount, inwardId: id, createdById: req.user.id }, { transaction });
    }
    for (const i of Object.values(items)) await i.save({ transaction });
    Object.assign(e, { isApproved: false, approvedById: null, approvedAt: null });
    await e.save({ transaction });
    const after = await load(id, transaction);
    await audit.log(req, { action: 'STORE_INWARD_UNAPPROVED', entityType: 'StoreInward', entityId: id, after }, { transaction });
    return after;
  });
}

/**
 * The inwards list (screen "CHEMICAL - INWARDS"). tab: all | gst | other | draft.
 * Filters: date range, IP#, DC#, GRN#, vendor name, description (notes or item name).
 */
async function list(req, store, q) {
  const where = { companyId: req.user.companyId, store };
  if (q.tab === 'gst') where.billType = 'GST';
  if (q.tab === 'other') where.billType = 'OTHER';
  if (q.tab === 'draft') where.isApproved = false;
  if (q.dateFrom || q.dateTo) where.inwardDate = { ...(q.dateFrom && { [Op.gte]: q.dateFrom }), ...(q.dateTo && { [Op.lte]: q.dateTo }) };
  if (q.ipNo) where.ipNo = q.ipNo;
  if (q.dcNo) where.dcNo = { [Op.iLike]: `%${q.dcNo}%` };
  if (q.grnNo) where.grnNo = { [Op.iLike]: `%${q.grnNo}%` };
  const and = [];
  if (q.vendor) and.push({ vendorId: { [Op.in]: sequelize.literal(`(SELECT id FROM vendors WHERE "companyId" = ${sequelize.escape(req.user.companyId)} AND name ILIKE ${sequelize.escape(`%${q.vendor}%`)})`) } });
  if (q.description) {
    const like = sequelize.escape(`%${q.description}%`);
    and.push({ [Op.or]: [{ notes: { [Op.iLike]: `%${q.description}%` } }, { id: { [Op.in]: sequelize.literal(`(SELECT l."inwardId" FROM store_inward_lines l JOIN store_items i ON i.id = l."itemId" WHERE i.name ILIKE ${like})`) } }] });
  }
  if (and.length) where[Op.and] = and;
  const { rows, count } = await StoreInward.findAndCountAll({
    where, include: [{ model: Vendor, as: 'vendor' }], order: [['inwardDate', 'DESC'], ['idNo', 'DESC']], limit: q.limit, offset: (q.page - 1) * q.limit,
  });
  const draftCount = await StoreInward.count({ where: { companyId: req.user.companyId, store, isApproved: false } });
  const rets = await returnedOf(rows.map((e) => e.id));
  const data = rows.map((e) => json(e, false, rets.get(e.id)));
  return { data, page: q.page, limit: q.limit, total: count, draftCount };
}

const get = async (req, store, id) => {
  await findOr404(req, store, id);
  return load(id);
};

/** Stock screen: every item with its stock and average rate, or totals per category / brand. */
async function stock(req, store, q) {
  const where = { companyId: req.user.companyId, store };
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.brandId) where.brandId = q.brandId;
  if (q.search) where.name = { [Op.iLike]: `%${q.search}%` };
  if (q.inStockOnly) where.stockQty = { [Op.gt]: 0 };
  const rows = await StoreItem.findAll({ where, include: m.itemInclude, order: [['name', 'ASC']] });
  // how many approved purchases and vendors each item has
  const counts = rows.length ? Object.fromEntries((await sequelize.query(
    `SELECT l."itemId", count(*)::int AS purchases, count(DISTINCT i."vendorId")::int AS vendors
       FROM store_inward_lines l JOIN store_inwards i ON i.id = l."inwardId" AND i."isApproved"
      WHERE l."itemId" IN (:ids) GROUP BY l."itemId"`,
    { replacements: { ids: rows.map((r) => r.id) }, type: sequelize.QueryTypes.SELECT },
  )).map((c) => [c.itemId, c])) : {};
  const items = rows.map((r) => ({ ...m.itemJSON(r), purchaseCount: counts[r.id]?.purchases || 0, vendorCount: counts[r.id]?.vendors || 0 }));
  const totalValue = m.round(items.reduce((s, i) => s + i.stockValue, 0), 2);
  if (!q.groupBy) return { data: items, totalValue };
  const groups = {};
  for (const i of items) {
    const g = i[q.groupBy];
    const key = g ? g.id : 'none';
    groups[key] ||= { id: g ? g.id : null, name: g ? g.name : '(none)', itemCount: 0, stockValue: 0, byUnit: {} };
    groups[key].itemCount += 1;
    groups[key].stockValue = m.round(groups[key].stockValue + i.stockValue, 2);
    groups[key].byUnit[i.unit] = m.round((groups[key].byUnit[i.unit] || 0) + i.stockQty, 3);
  }
  return { groupBy: q.groupBy, data: Object.values(groups).sort((a, b) => a.name.localeCompare(b.name)), totalValue };
}

/**
 * One chemical / item, all in one place: the total stock (all vendors together), what was bought
 * from each vendor, and every purchase on its own (approved entries only).
 */
async function itemStock(req, store, itemId) {
  const item = await StoreItem.findOne({ where: { id: itemId, companyId: req.user.companyId, store }, include: m.itemInclude });
  if (!item) throw AppError.notFound('Item');
  const lines = await StoreInwardLine.findAll({
    where: { itemId },
    include: [{ model: StoreInward, as: 'inward', where: { isApproved: true }, include: [{ model: Vendor, as: 'vendor' }] }],
    order: [[{ model: StoreInward, as: 'inward' }, 'inwardDate', 'DESC'], [{ model: StoreInward, as: 'inward' }, 'idNo', 'DESC']],
  });
  const split = (q) => m.splitQty(q, item.unit);
  const purchases = lines.map((l) => ({
    inwardId: l.inward.id, idText: idText(l.inward.idNo), ipNo: l.inward.ipNo, date: l.inward.inwardDate, dcNo: l.inward.dcNo,
    vendor: l.inward.vendor ? m.vendorJSON(l.inward.vendor) : null,
    qty: l.qty, qtySplit: split(l.qty), rate: l.rate, amount: l.amount,
  }));
  const byVendor = {};
  for (const p of purchases) {
    const key = p.vendor ? p.vendor.id : 'none';
    byVendor[key] ||= { vendor: p.vendor, purchases: 0, qty: 0, value: 0 };
    const v = byVendor[key];
    v.purchases += 1;
    v.qty = m.round(v.qty + p.qty, 3);
    v.value = m.round(v.value + p.amount, 2);
  }
  return {
    item: m.itemJSON(item),
    // one stock for the item, whichever vendor it came from
    stock: { qty: item.stockQty, qtySplit: split(item.stockQty), value: item.stockValue, avgRate: m.avgRate(item) },
    // stock batch by batch: 20 KG @ 40 (old) + 100 KG @ 45 (new)
    batches: (await batches.summary(item)).batches,
    byVendor: Object.values(byVendor).map((v) => ({ ...v, qtySplit: split(v.qty), avgRate: v.qty ? m.round(v.value / v.qty, 4) : 0 }))
      .sort((a, b) => b.qty - a.qty),
    purchases,
  };
}

const KIND_TEXT = { INWARD_EDIT: 'Purchase corrected', INWARD: 'Purchase', INWARD_UNDO: 'Purchase undone', ISSUE: 'Issued to department', RETURN: 'Returned by department', ADJUST: 'Stock adjustment' };

/** One item's stock history (ledger): inwards now, issues to departments later. */
async function itemMoves(req, store, itemId, q) {
  const item = await StoreItem.findOne({ where: { id: itemId, companyId: req.user.companyId, store }, include: m.itemInclude });
  if (!item) throw AppError.notFound('Item');
  const where = { itemId };
  if (q.dateFrom || q.dateTo) where.moveDate = { ...(q.dateFrom && { [Op.gte]: q.dateFrom }), ...(q.dateTo && { [Op.lte]: q.dateTo }) };
  const moves = await StoreMove.findAll({
    where, order: [['createdAt', 'ASC']],
    include: [{ model: StoreInward, as: 'inward', include: [{ model: Vendor, as: 'vendor' }] }, { model: Service, as: 'department' }],
  });
  return {
    item: m.itemJSON(item),
    data: moves.map((mv) => ({
      id: mv.id,
      date: mv.moveDate,
      kind: mv.kind,
      qty: mv.qty,
      value: mv.value,
      ipNo: mv.inward ? mv.inward.ipNo : null,
      vendor: mv.inward && mv.inward.vendor ? mv.inward.vendor.name : null,
      // ISSUE (to a department), RETURN (back from a department), ADJUST (stock fixed)
      kindText: KIND_TEXT[mv.kind] || mv.kind,
      qtySplit: m.splitQty(Math.abs(mv.qty), item.unit),
      department: mv.department ? mv.department.name : null,
      requestId: mv.requestId, returnId: mv.returnId, adjustmentId: mv.adjustmentId,
      createdAt: mv.createdAt,
    })),
  };
}

/** Stock of one item batch by batch, plus its last purchases (inward screen) and where it was used. */
async function itemBatches(req, store, itemId) {
  const item = await StoreItem.findOne({ where: { id: itemId, companyId: req.user.companyId, store }, include: m.itemInclude });
  if (!item) throw AppError.notFound('Item');
  return { item: m.itemJSON(item), ...(await batches.summary(item)) };
}

async function lastInwards(req, store, itemId, limit = 5) {
  const item = await StoreItem.findOne({ where: { id: itemId, companyId: req.user.companyId, store }, include: m.itemInclude });
  if (!item) throw AppError.notFound('Item');
  const data = await batches.lastInwards(itemId, limit);
  return { item: m.itemJSON(item), isNew: data.length === 0, data, stock: await batches.summary(item) };
}

async function itemUsage(req, store, itemId) {
  const item = await StoreItem.findOne({ where: { id: itemId, companyId: req.user.companyId, store }, include: m.itemInclude });
  if (!item) throw AppError.notFound('Item');
  const data = await batches.usage('x."itemId" = :itemId', { itemId });
  return { item: m.itemJSON(item), data, totals: usageTotals(data) };
}

async function batchUsage(req, store, batchId) {
  const [b] = await sequelize.query(`SELECT b.id, b."itemId" FROM store_batches b WHERE b.id = :batchId AND b."companyId" = :companyId AND b.store = :store`,
    { replacements: { batchId, companyId: req.user.companyId, store }, type: sequelize.QueryTypes.SELECT });
  if (!b) throw AppError.notFound('Batch');
  const item = await StoreItem.findByPk(b.itemId, { include: m.itemInclude });
  const [info] = await sequelize.query(`SELECT b.*, b.rate::float AS rate, b."qtyIn"::float AS "qtyIn", b."qtyLeft"::float AS "qtyLeft", b."valueLeft"::float AS "valueLeft",
      v.name AS "vendorName", i."ipNo", i."dcNo", it.unit FROM store_batches b JOIN store_items it ON it.id = b."itemId"
      LEFT JOIN vendors v ON v.id = b."vendorId" LEFT JOIN store_inwards i ON i.id = b."inwardId" WHERE b.id = :batchId`,
  { replacements: { batchId }, type: sequelize.QueryTypes.SELECT });
  const data = await batches.usage('x."batchId" = :batchId', { batchId });
  return {
    item: m.itemJSON(item),
    batch: { batchId: info.id, sourceText: batches.SOURCE_TEXT[info.source], inDate: info.inDate, vendor: info.vendorId ? { id: info.vendorId, name: info.vendorName } : null,
      ipNo: info.ipNo, dcNo: info.dcNo, rate: info.rate, qtyIn: info.qtyIn, qtyInSplit: m.splitQty(info.qtyIn, info.unit), qtyLeft: info.qtyLeft, qtyLeftSplit: m.splitQty(info.qtyLeft, info.unit), valueLeft: info.valueLeft },
    data, totals: usageTotals(data),
  };
}

function usageTotals(data) {
  const t = (f) => m.round(data.reduce((x, r) => x + f(r), 0), 3);
  return { issues: data.length, qty: t((r) => r.qty), returnedQty: t((r) => r.returnedQty), netQty: t((r) => r.netQty), value: m.round(t((r) => r.netValue), 2) };
}

module.exports = {
  itemBatches, lastInwards, itemUsage, batchUsage, itemStock, formData, list, get, create, update, correct, remove, approve, unapprove, stock, itemMoves };
