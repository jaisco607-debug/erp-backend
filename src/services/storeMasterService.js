// Step 7 store lists: vendors (shared by both stores), and per store (CHEMICAL / GENERAL):
// categories, brands and items. Each company has its own lists; another company's rows are "not found".
// A row that is already used (e.g. an item on an inward entry) cannot be deleted: switch it off instead.
const { Op } = require('sequelize');
const { sequelize, Vendor, StoreCategory, StoreBrand, StoreItem, StoreInward, StoreInwardLine, StoreMove } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const { round } = require('../utils/money');
const avgRate = (i) => (i.stockQty > 0 ? round(i.stockValue / i.stockQty, 4) : 0);

const vendorJSON = (v) => ({ id: v.id, code: v.code, name: v.name, phone: v.phone, address: v.address, isActive: v.isActive, label: `${v.name} (${v.code})` });
const namedJSON = (r) => ({ id: r.id, name: r.name, isActive: r.isActive });
/**
 * Kg and grams (litres and ml) are shown apart, never as 3.5 kg:
 *   splitQty(3.5, 'KG') -> { main: 3, mainUnit: 'KG', sub: 500, subUnit: 'G', text: '3 KG 500 G' }
 * Other units have no small unit: { main: 12, mainUnit: 'PCS', sub: null, subUnit: null, text: '12 PCS' }.
 */
const SUB_UNITS = { KG: 'G', LTR: 'ML' };
function splitQty(qty, unit) {
  const subUnit = SUB_UNITS[unit] || null;
  if (!subUnit || qty == null) return { main: qty, mainUnit: unit, sub: null, subUnit: null, text: `${qty} ${unit}` };
  const sign = qty < 0 ? -1 : 1;
  const small = Math.round(Math.abs(qty) * 1000);
  const main = Math.floor(small / 1000) * sign;
  const sub = (small % 1000) * sign;
  const text = [main && `${main} ${unit}`, sub && `${sub} ${subUnit}`].filter(Boolean).join(' ') || `0 ${unit}`;
  return { main, mainUnit: unit, sub, subUnit, text };
}

const itemJSON = (i) => ({
  id: i.id,
  store: i.store,
  name: i.name,
  // ready to show in a dropdown: "COTTON COLOUR (REACTIVE DYES) / RED"
  label: i.category ? `${i.category.name} / ${i.name}` : i.name,
  unit: i.unit,
  category: i.category ? namedJSON(i.category) : null,
  brand: i.brand ? namedJSON(i.brand) : null,
  stockQty: i.stockQty,
  stock: splitQty(i.stockQty, i.unit),
  hasSubUnit: Boolean(SUB_UNITS[i.unit]),
  subUnit: SUB_UNITS[i.unit] || null,
  avgRate: avgRate(i),
  stockValue: i.stockValue,
  isActive: i.isActive,
});
const itemInclude = [{ model: StoreCategory, as: 'category' }, { model: StoreBrand, as: 'brand' }];

const KINDS = {
  vendor: { Model: Vendor, json: vendorJSON, entity: 'Vendor', fields: ['name', 'phone', 'address', 'isActive'], shared: true },
  category: { Model: StoreCategory, json: namedJSON, entity: 'StoreCategory', fields: ['name', 'isActive'] },
  brand: { Model: StoreBrand, json: namedJSON, entity: 'StoreBrand', fields: ['name', 'isActive'] },
  item: { Model: StoreItem, json: itemJSON, entity: 'StoreItem', fields: ['name', 'unit', 'categoryId', 'brandId', 'isActive'], include: itemInclude },
};

const scope = (kind, req, store) => (KINDS[kind].shared ? { companyId: req.user.companyId } : { companyId: req.user.companyId, store });

async function findOr404(kind, req, store, id, transaction) {
  const { Model, include, entity } = KINDS[kind];
  const row = await Model.findOne({ where: { id, ...scope(kind, req, store) }, include, transaction });
  if (!row) throw AppError.notFound(entity.replace('Store', ''));
  return row;
}

/** Items: the same name may be in two categories, so the check is inside the category. */
async function nameTaken(kind, req, store, name, exceptId, transaction, categoryId) {
  const where = { ...scope(kind, req, store), [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] };
  if (kind === 'item') where.categoryId = categoryId || null;
  if (exceptId) where.id = { [Op.ne]: exceptId };
  return Boolean(await KINDS[kind].Model.findOne({ where, transaction }));
}

/** An item's category and brand must be of the same company and store. */
async function checkLinks(req, store, data, transaction) {
  for (const [field, Model, label] of [['categoryId', StoreCategory, 'CATEGORY'], ['brandId', StoreBrand, 'BRAND']]) {
    if (!data[field]) continue;
    if (!(await Model.findOne({ where: { id: data[field], companyId: req.user.companyId, store }, transaction }))) {
      throw AppError.rule(`UNKNOWN_${label}`, `${label.toLowerCase()} not found in this store`);
    }
  }
}

async function list(kind, req, store, { page, limit, search, isActive, categoryId, brandId }) {
  const { Model, json, include } = KINDS[kind];
  const where = scope(kind, req, store);
  if (isActive !== undefined) where.isActive = isActive;
  if (categoryId) where.categoryId = categoryId;
  if (brandId) where.brandId = brandId;
  if (search) {
    const or = [{ name: { [Op.iLike]: `%${search}%` } }];
    if (kind === 'vendor' && /^\d+$/.test(search)) or.push({ code: Number(search) });
    where[Op.or] = or;
  }
  const { rows, count } = await Model.findAndCountAll({ where, include, order: [[kind === 'vendor' ? 'code' : 'name', 'ASC']], limit, offset: (page - 1) * limit, distinct: true });
  return { data: rows.map(json), page, limit, total: count };
}

async function get(kind, req, store, id) {
  return KINDS[kind].json(await findOr404(kind, req, store, id));
}

async function create(kind, req, store, data) {
  const { Model, entity } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    if (await nameTaken(kind, req, store, data.name, null, transaction, data.categoryId)) throw AppError.rule('NAME_TAKEN', `"${data.name}" already exists`);
    const fields = { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === '' ? null : v])), ...scope(kind, req, store), createdById: req.user.id };
    if (kind === 'item') await checkLinks(req, store, fields, transaction);
    if (kind === 'vendor') {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`vendor-code:${req.user.companyId}`], transaction });
      if (fields.code) {
        if (await Vendor.findOne({ where: { companyId: req.user.companyId, code: fields.code }, transaction })) throw AppError.rule('CODE_TAKEN', `Vendor code ${fields.code} already exists`);
      } else {
        fields.code = ((await Vendor.max('code', { where: { companyId: req.user.companyId }, transaction })) || 0) + 1;
      }
    }
    const row = await Model.create(fields, { transaction });
    const after = KINDS[kind].json(await findOr404(kind, req, store, row.id, transaction));
    await audit.log(req, { action: `${entity.toUpperCase()}_CREATED`, entityType: entity, entityId: row.id, after }, { transaction });
    return after;
  });
}

async function update(kind, req, store, id, changes) {
  const { entity, fields, json } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(kind, req, store, id, transaction);
    const newCategory = changes.categoryId !== undefined ? changes.categoryId : row.categoryId;
    if ((changes.name || changes.categoryId !== undefined) && (await nameTaken(kind, req, store, changes.name || row.name, id, transaction, newCategory))) throw AppError.rule('NAME_TAKEN', `"${changes.name}" already exists`);
    if (kind === 'item') {
      await checkLinks(req, store, changes, transaction);
      // stock is counted in this unit, so it cannot change once stock exists
      if (changes.unit && changes.unit !== row.unit && (row.stockQty !== 0 || (await StoreInwardLine.count({ where: { itemId: id }, transaction })))) {
        throw AppError.rule('UNIT_LOCKED', 'This item is already used; its unit cannot change');
      }
    }
    const before = json(row);
    for (const f of fields) if (changes[f] !== undefined) row[f] = changes[f] === '' ? null : changes[f];
    await row.save({ transaction });
    const after = json(await findOr404(kind, req, store, id, transaction));
    await audit.log(req, { action: `${entity.toUpperCase()}_UPDATED`, entityType: entity, entityId: id, before, after }, { transaction });
    return after;
  });
}

async function inUse(kind, id, transaction) {
  if (kind === 'vendor') return StoreInward.count({ where: { vendorId: id }, transaction });
  if (kind === 'category') return StoreItem.count({ where: { categoryId: id }, transaction });
  if (kind === 'brand') return StoreItem.count({ where: { brandId: id }, transaction });
  return (await StoreInwardLine.count({ where: { itemId: id }, transaction })) + (await StoreMove.count({ where: { itemId: id }, transaction }));
}

async function remove(kind, req, store, id) {
  const { entity, json } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(kind, req, store, id, transaction);
    if (await inUse(kind, id, transaction)) throw AppError.rule('IN_USE', 'Already used; switch it off (isActive false) instead of deleting');
    const before = json(row);
    await row.destroy({ transaction });
    await audit.log(req, { action: `${entity.toUpperCase()}_DELETED`, entityType: entity, entityId: id, before }, { transaction });
  });
}

module.exports = { splitQty, SUB_UNITS, list, get, create, update, remove, vendorJSON, namedJSON, itemJSON, itemInclude, avgRate, round };
