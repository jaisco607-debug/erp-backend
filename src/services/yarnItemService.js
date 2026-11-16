// Weaving > Masters > Item Card: yarn count + brand + packing + bags. The count and the brand come from their masters (active ones only, of the same company).
// The same combination cannot be made twice in a company.
const { Op } = require('sequelize');
const { sequelize, YarnItem, YarnCount, YarnBrand, YarnInward } = require('../models');
const { PACKINGS, DEFAULT_PACKING, BAGS, DEFAULT_BAGS } = require('../models/YarnItem');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const INCLUDE = [
  { model: YarnCount, as: 'yarnCount', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: YarnBrand, as: 'brand', paranoid: false, attributes: ['id', 'code', 'name'] },
];
const json = (y) => ({
  id: y.id, code: y.code,
  name: `${y.yarnCount.name} - ${y.brand.name} - ${y.packing} - ${y.bags}`,
  yarnCount: { id: y.yarnCount.id, code: y.yarnCount.code, name: y.yarnCount.name },
  brand: { id: y.brand.id, code: y.brand.code, name: y.brand.name },
  packing: y.packing, bags: y.bags, isActive: y.isActive, createdAt: y.createdAt,
});
const dup = () => AppError.rule('DUPLICATE_ENTRY', 'Duplicate entry: an item card with this yarn count, brand, packing and bags already exists', { field: 'combination' });

/** The dropdown values of the form. */
const options = () => ({ packings: PACKINGS, defaultPacking: DEFAULT_PACKING, bags: BAGS, defaultBags: DEFAULT_BAGS });

async function load(companyId, id, transaction) {
  return YarnItem.findOne({ where: { id, companyId }, include: INCLUDE, transaction });
}

async function findOr404(req, id, transaction) {
  const row = await load(req.user.companyId, id, transaction);
  if (!row) throw AppError.notFound('Item card');
  return row;
}

/** The count / brand picked must be of this company and switched on (an unchanged one on an edit may be off). */
async function assertMaster(Model, label, companyId, id, keepId, transaction) {
  const KEY = label.toUpperCase().replace(' ', '_');
  const row = await Model.findOne({ where: { id, companyId }, transaction });
  if (!row) throw AppError.rule(`UNKNOWN_${KEY}`, `This ${label} does not exist`, { field: label === 'brand' ? 'brandId' : 'yarnCountId' });
  if (!row.isActive && id !== keepId) throw AppError.rule(`${KEY}_INACTIVE`, `This ${label} is switched off`, { field: label === 'brand' ? 'brandId' : 'yarnCountId' });
}

async function list(req, { page, limit, search, isActive, yarnCountId, brandId }) {
  const where = { companyId: req.user.companyId };
  if (isActive !== undefined) where.isActive = isActive;
  if (yarnCountId) where.yarnCountId = yarnCountId;
  if (brandId) where.brandId = brandId;
  if (search) {
    const like = { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` };
    where[Op.or] = [{ '$yarnCount.name$': like }, { '$brand.name$': like }];
  }
  const { rows, count } = await YarnItem.findAndCountAll({ where, include: INCLUDE, order: [['code', 'ASC']], limit, offset: (page - 1) * limit, distinct: true });
  return { data: rows.map(json), page, limit, total: count };
}

const get = async (req, id) => json(await findOr404(req, id));

async function create(req, { yarnCountId, brandId, packing = DEFAULT_PACKING, bags = DEFAULT_BAGS, isActive = true }) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-item:${companyId}`], transaction });
      await assertMaster(YarnCount, 'yarn count', companyId, yarnCountId, null, transaction);
      await assertMaster(YarnBrand, 'brand', companyId, brandId, null, transaction);
      if (await YarnItem.findOne({ where: { companyId, yarnCountId, brandId, packing, bags }, transaction })) throw dup();
      const code = ((await YarnItem.max('code', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;
      const row = await YarnItem.create({ companyId, code, yarnCountId, brandId, packing, bags, isActive, createdById: req.user.id }, { transaction });
      const out = json(await load(companyId, row.id, transaction));
      await audit.log(req, { action: 'YARN_ITEM_CREATED', entityType: 'YarnItem', entityId: row.id, after: out }, { transaction });
      return out;
    });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') throw dup();
    throw e;
  }
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      const row = await findOr404(req, id, transaction);
      const before = json(row);
      const next = { yarnCountId: row.yarnCountId, brandId: row.brandId, packing: row.packing, bags: row.bags };
      for (const f of Object.keys(next)) if (changes[f] !== undefined) next[f] = changes[f];
      if (changes.yarnCountId !== undefined) await assertMaster(YarnCount, 'yarn count', companyId, next.yarnCountId, row.yarnCountId, transaction);
      if (changes.brandId !== undefined) await assertMaster(YarnBrand, 'brand', companyId, next.brandId, row.brandId, transaction);
      if (await YarnItem.findOne({ where: { companyId, ...next, id: { [Op.ne]: id } }, transaction })) throw dup();
      await YarnItem.update({ ...next, ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}) }, { where: { id, companyId }, transaction });
      const out = json(await load(companyId, id, transaction));
      await audit.log(req, { action: 'YARN_ITEM_UPDATED', entityType: 'YarnItem', entityId: id, before, after: out }, { transaction });
      return out;
    });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') throw dup();
    throw e;
  }
}

/** Hidden from the lists and dropdowns (yarn inward will later refuse to delete a card that has stock). */
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(req, id, transaction);
    const used = await YarnInward.count({ where: { itemId: id }, transaction });
    if (used) throw AppError.rule('IN_USE', `This item card has ${used} yarn inward entr${used === 1 ? 'y' : 'ies'}. Switch it off instead of deleting it`, { yarnInwards: used });
    const before = json(row);
    await YarnItem.destroy({ where: { id, companyId: req.user.companyId }, transaction });
    await audit.log(req, { action: 'YARN_ITEM_DELETED', entityType: 'YarnItem', entityId: id, before }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove, options };
