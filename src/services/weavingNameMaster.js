// A weaving master that is just a unique NAME per company (Yarn Count, Brand ...). One implementation, used by yarnCountService and yarnBrandService.
// Each company has its own list. The name is a duplicate when it matches another row of the company ignoring capital / small letters and extra spaces
// ("22|s cotton" = "22|S  Cotton"). Deleted rows are hidden and free their name; a row that an item card uses cannot be deleted.
const { Op } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const clean = (s) => String(s).trim().replace(/\s+/g, ' ');

/**
 * @param Model    the Sequelize model (id, companyId, code, name, isActive, createdById; paranoid)
 * @param entity   audit entity name, e.g. 'YarnCount'
 * @param label    lower case name for messages, e.g. 'yarn count'
 * @param action   audit action prefix, e.g. 'YARN_COUNT'
 * @param inUse    async (companyId, id, transaction) => number of records using it (0 = free to delete)
 * @param usedBy   what uses it, for the message (default 'item card'); usedKey = the key of the count in the error details (default 'itemCards')
 */
function nameMaster({ Model, entity, label, action, inUse, usedBy = 'item card', usedKey = 'itemCards' }) {
  const json = (y) => ({ id: y.id, code: y.code, name: y.name, isActive: y.isActive, createdAt: y.createdAt });
  const dup = (name) => AppError.rule('DUPLICATE_ENTRY', `Duplicate entry: ${label} "${name}" already exists`, { field: 'name' });
  const isDuplicate = (e) => e.name === 'SequelizeUniqueConstraintError';

  async function nameTaken(companyId, name, exceptId, transaction) {
    const where = { companyId, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), clean(name).toLowerCase())] };
    if (exceptId) where.id = { [Op.ne]: exceptId };
    return Boolean(await Model.findOne({ where, transaction }));
  }

  async function findOr404(req, id, transaction) {
    const row = await Model.findOne({ where: { id, companyId: req.user.companyId }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
    if (!row) throw AppError.notFound(label.charAt(0).toUpperCase() + label.slice(1));
    return row;
  }

  async function list(req, { page, limit, search, isActive }) {
    const where = { companyId: req.user.companyId };
    if (isActive !== undefined) where.isActive = isActive;
    if (search) where.name = { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` };
    const { rows, count } = await Model.findAndCountAll({ where, order: [['code', 'ASC']], limit, offset: (page - 1) * limit });
    return { data: rows.map(json), page, limit, total: count };
  }

  const get = async (req, id) => json(await findOr404(req, id));

  async function create(req, { name, isActive = true }) {
    const { companyId } = req.user;
    try {
      return await sequelize.transaction(async (transaction) => {
        // one at a time per company: the running number and the duplicate check cannot clash
        await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`${action}:${companyId}`], transaction });
        if (await nameTaken(companyId, name, null, transaction)) throw dup(clean(name));
        const code = ((await Model.max('code', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;
        const row = await Model.create({ companyId, code, name: clean(name), isActive, createdById: req.user.id }, { transaction });
        await audit.log(req, { action: `${action}_CREATED`, entityType: entity, entityId: row.id, after: json(row) }, { transaction });
        return json(row);
      });
    } catch (e) {
      if (isDuplicate(e)) throw dup(clean(name)); // the unique index is the last guard
      throw e;
    }
  }

  async function update(req, id, changes) {
    try {
      return await sequelize.transaction(async (transaction) => {
        const row = await findOr404(req, id, transaction);
        if (changes.name !== undefined && (await nameTaken(req.user.companyId, changes.name, id, transaction))) throw dup(clean(changes.name));
        const before = json(row);
        if (changes.name !== undefined) row.name = clean(changes.name);
        if (changes.isActive !== undefined) row.isActive = changes.isActive;
        await row.save({ transaction });
        await audit.log(req, { action: `${action}_UPDATED`, entityType: entity, entityId: id, before, after: json(row) }, { transaction });
        return json(row);
      });
    } catch (e) {
      if (isDuplicate(e)) throw dup(clean(changes.name));
      throw e;
    }
  }

  /** Hidden from the lists and dropdowns. Refused while an item card uses it (switch it off instead). */
  async function remove(req, id) {
    return sequelize.transaction(async (transaction) => {
      const row = await findOr404(req, id, transaction);
      const used = inUse ? await inUse(req.user.companyId, id, transaction) : 0;
      if (used) throw AppError.rule('IN_USE', `This ${label} is used by ${used} ${usedBy}${used === 1 ? '' : 's'}. Switch it off instead of deleting it`, { [usedKey]: used });
      const before = json(row);
      await row.destroy({ transaction });
      await audit.log(req, { action: `${action}_DELETED`, entityType: entity, entityId: id, before }, { transaction });
      return { deleted: true, id };
    });
  }

  return { list, get, create, update, remove, json };
}

module.exports = { nameMaster, clean };
