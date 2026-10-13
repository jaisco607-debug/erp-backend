// Step 3 masters: customers (parties who send cloth) and qualities. Each company has its own lists;
// another company's records are "not found".
const { Op } = require('sequelize');
const { sequelize, Customer, Quality, Colour } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const customerJSON = (c) => ({ id: c.id, code: c.code, name: c.name, phone: c.phone, address: c.address, isActive: c.isActive });
const qualityJSON = (q) => ({ id: q.id, name: q.name, isActive: q.isActive });

const KINDS = {
  customer: { Model: Customer, json: customerJSON, entity: 'Customer', label: 'Customer', fields: ['name', 'phone', 'address', 'isActive'] },
  quality: { Model: Quality, json: qualityJSON, entity: 'Quality', label: 'Quality', fields: ['name', 'isActive'] },
  colour: { Model: Colour, json: qualityJSON, entity: 'Colour', label: 'Colour', fields: ['name', 'isActive'] },
};

async function findOr404(kind, req, id, transaction) {
  const { Model, label } = KINDS[kind];
  const row = await Model.findOne({ where: { id, companyId: req.user.companyId }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!row) throw AppError.notFound(label);
  return row;
}

async function nameTaken(kind, req, name, exceptId, transaction) {
  const { Model } = KINDS[kind];
  const where = { companyId: req.user.companyId, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  return Boolean(await Model.findOne({ where, transaction }));
}

async function list(kind, req, { page, limit, search, isActive }) {
  const { Model, json } = KINDS[kind];
  const where = { companyId: req.user.companyId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    const or = [{ name: { [Op.iLike]: `%${search}%` } }];
    if (kind === 'customer' && /^\d+$/.test(search)) or.push({ code: Number(search) });
    where[Op.or] = or;
  }
  const order = kind === 'customer' ? [['code', 'ASC']] : [['name', 'ASC']];
  const { rows, count } = await Model.findAndCountAll({ where, order, limit, offset: (page - 1) * limit });
  return { data: rows.map(json), page, limit, total: count };
}

async function get(kind, req, id) {
  return KINDS[kind].json(await findOr404(kind, req, id));
}

async function create(kind, req, data) {
  const { Model, json, entity } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    if (await nameTaken(kind, req, data.name, null, transaction)) {
      throw AppError.rule('NAME_TAKEN', `"${data.name}" already exists`);
    }
    const fields = { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === '' ? null : v])), companyId: req.user.companyId, createdById: req.user.id };
    if (kind === 'customer') {
      // Code: typed (to keep the numbers of the old system) or the next free one.
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`customer-code:${req.user.companyId}`], transaction });
      if (fields.code) {
        if (await Customer.findOne({ where: { companyId: req.user.companyId, code: fields.code }, transaction })) {
          throw AppError.rule('CODE_TAKEN', `Customer code ${fields.code} already exists`);
        }
      } else {
        fields.code = ((await Customer.max('code', { where: { companyId: req.user.companyId }, paranoid: false, transaction })) || 0) + 1;
      }
    }
    const row = await Model.create(fields, { transaction });
    await audit.log(req, { action: `${entity.toUpperCase()}_CREATED`, entityType: entity, entityId: row.id, after: json(row) }, { transaction });
    return json(row);
  });
}

async function update(kind, req, id, changes) {
  const { json, entity, fields } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(kind, req, id, transaction);
    if (changes.name && (await nameTaken(kind, req, changes.name, id, transaction))) {
      throw AppError.rule('NAME_TAKEN', `"${changes.name}" already exists`);
    }
    const before = json(row);
    for (const f of fields) if (changes[f] !== undefined) row[f] = changes[f] === '' ? null : changes[f];
    await row.save({ transaction });
    await audit.log(req, { action: `${entity.toUpperCase()}_UPDATED`, entityType: entity, entityId: id, before, after: json(row) }, { transaction });
    return json(row);
  });
}

/** Delete: hidden from lists and dropdowns, kept in the database (old lots still show it). */
async function remove(kind, req, id) {
  const { json, entity } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(kind, req, id, transaction);
    const before = json(row);
    await row.destroy({ transaction });
    await audit.log(req, { action: `${entity.toUpperCase()}_DELETED`, entityType: entity, entityId: id, before }, { transaction });
  });
}

module.exports = { list, get, create, update, remove, customerJSON, qualityJSON };
