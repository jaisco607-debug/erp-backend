// Step 3 masters: customers (parties who send cloth) and qualities. Each company has its own lists;
// another company's records are "not found".
const { Op } = require('sequelize');
const { sequelize, Customer, Quality, Colour } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const CUSTOMER_FIELDS = ['legalName', 'status', 'type', 'payment', 'cnic', 'ntn', 'gstNo', 'email', 'city', 'province', 'bankName', 'bankBranch', 'accountTitle', 'accountNo', 'iban'];
const CREDIT_FIELDS = ['creditLimit', 'creditDays']; // credit terms: a limit (empty = none) and days
const customerJSON = (c) => ({
  id: c.id, code: c.code, module: c.module, moduleText: c.module === 'WEAVING' ? 'Weaving' : 'Processing', name: c.name, phone: c.phone, address: c.address, isActive: c.isActive, creditLimit: c.creditLimit == null ? null : Number(c.creditLimit), creditDays: c.creditDays ?? 0,
  ...Object.fromEntries(CUSTOMER_FIELDS.map((f) => [f, c[f] ?? null])),
});
const qualityJSON = (q) => ({ id: q.id, name: q.name, isActive: q.isActive });

// Customers (and vendors) belong to a module list: the main modules (Grey Store, stores, accounts) use MAIN, the Weaving module keeps its own WEAVING list in the same tables.
// The weaving routes set req.partyModule = 'WEAVING'; everything else is MAIN. Quality and Colour have no such split.
// A read of the old route may ask for ?module=ALL (both lists: the accounts screens) or ?module=WEAVING; the default is MAIN. Only a read: nothing is written to a list it did not choose.
const moduleOf = (kind, req) => {
  if (kind !== 'customer') return {};
  const m = req.partyModule || (req.method === 'GET' && req.query && ['ALL', 'WEAVING'].includes(String(req.query.module).toUpperCase()) ? String(req.query.module).toUpperCase() : 'MAIN');
  return m === 'ALL' ? {} : { module: m };
};

// A deleted customer / quality only hides: old lots and SO cards keep showing its name (owner's rule). What must NOT lose its customer is the money side: invoices and vouchers
// would return 404 and the balance could never be collected. Only those tables stop the delete ("switch it off instead").
const Model_TABLE = { customer: 'customers' };
const BLOCKING = new Set(['sales_invoices', 'receipt_vouchers', 'contra_vouchers']);
const KINDS = {
  customer: { Model: Customer, json: customerJSON, entity: 'Customer', label: 'Customer', fields: ['name', 'phone', 'address', 'isActive', ...CUSTOMER_FIELDS, ...CREDIT_FIELDS] },
  quality: { Model: Quality, json: qualityJSON, entity: 'Quality', label: 'Quality', fields: ['name', 'isActive'] },
  colour: { Model: Colour, json: qualityJSON, entity: 'Colour', label: 'Colour', fields: ['name', 'isActive'] },
};

async function findOr404(kind, req, id, transaction) {
  const { Model, label } = KINDS[kind];
  const row = await Model.findOne({ where: { id, companyId: req.user.companyId, ...moduleOf(kind, req) }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!row) throw AppError.notFound(label);
  return row;
}

async function nameTaken(kind, req, name, exceptId, transaction) {
  const { Model } = KINDS[kind];
  const where = { companyId: req.user.companyId, ...moduleOf(kind, req), [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('name')), name.toLowerCase())] };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  return Boolean(await Model.findOne({ where, transaction }));
}

async function list(kind, req, { page, limit, search, isActive }) {
  const { Model, json } = KINDS[kind];
  const where = { companyId: req.user.companyId, ...moduleOf(kind, req) };
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
    const fields = { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === '' ? null : v])), companyId: req.user.companyId, ...moduleOf(kind, req), createdById: req.user.id };
    if (kind === 'customer') {
      // Code: typed (to keep the numbers of the old system) or the next free one.
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`customer-code:${req.user.companyId}`], transaction });
      if (fields.code) {
        if (await Customer.findOne({ where: { companyId: req.user.companyId, ...moduleOf(kind, req), code: fields.code }, transaction })) {
          throw AppError.rule('CODE_TAKEN', `Customer code ${fields.code} already exists`);
        }
      } else {
        fields.code = ((await Customer.max('code', { where: { companyId: req.user.companyId, ...moduleOf(kind, req) }, paranoid: false, transaction })) || 0) + 1;
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

/** Is the record used by anything (a table with a foreign key to it holds a live row that points at it)? Returns the first table found, else null. */
async function usedBy(table, id, transaction) {
  const fks = await sequelize.query(`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = :table::regclass`, { replacements: { table }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const f of fks.filter((x) => BLOCKING.has(x.tbl.replace(/"/g, '')))) {
    const [soft] = await sequelize.query("SELECT 1 AS x FROM information_schema.columns WHERE table_name = :t AND column_name = 'deletedAt'", { replacements: { t: f.tbl.replace(/"/g, '') }, type: sequelize.QueryTypes.SELECT, transaction });
    const [hit] = await sequelize.query(`SELECT 1 AS x FROM ${f.tbl} WHERE "${f.col}" = :id${soft ? ' AND "deletedAt" IS NULL' : ''} LIMIT 1`, { replacements: { id }, type: sequelize.QueryTypes.SELECT, transaction });
    if (hit) return f.tbl.replace(/"/g, '');
  }
  return null;
}

/** Delete: hidden from lists and dropdowns, kept in the database. Not while lots, invoices, vouchers ... use it (switch it off instead). */
async function remove(kind, req, id) {
  const { json, entity, label } = KINDS[kind];
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(kind, req, id, transaction);
    const used = Model_TABLE[kind] ? await usedBy(Model_TABLE[kind], id, transaction) : null;
    if (used) throw AppError.rule('IN_USE', `This ${label.toLowerCase()} is used (${used.replace(/_/g, ' ')}): switch it off instead of deleting it`, { usedIn: used });
    const before = json(row);
    await row.destroy({ transaction });
    await audit.log(req, { action: `${entity.toUpperCase()}_DELETED`, entityType: entity, entityId: id, before }, { transaction });
  });
}

module.exports = { list, get, create, update, remove, customerJSON, qualityJSON };
