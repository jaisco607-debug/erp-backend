// The list of services the platform offers. Super admins can add new ones (e.g. a new department)
// and switch one off: a switched-off service disappears from every company's menu at once.
const { Op } = require('sequelize');
const { Service, Company, CompanyService, User, UserService, sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const json = (s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind, menuGroup: s.menuGroup, isBuiltIn: CORE_MODULES.includes(s.code), tracksColour: s.tracksColour, isActive: s.isActive, sortOrder: s.sortOrder });

async function list({ isActive, kind }) {
  const where = isActive === undefined ? {} : { isActive };
  if (kind) where.kind = kind;
  return { data: (await Service.findAll({ where, order: [['sortOrder', 'ASC'], ['name', 'ASC']] })).map(json) };
}

async function create(req, data) {
  return sequelize.transaction(async (transaction) => {
    if (await Service.findOne({ where: { code: data.code }, transaction })) {
      throw AppError.rule('SERVICE_CODE_TAKEN', `Service code "${data.code}" already exists`);
    }
    if (data.menuGroup === undefined && ['PROCESS', 'FOLDING', 'PACKING'].includes(data.kind)) data.menuGroup = 'PROCESS';
    if (data.sortOrder === undefined) data.sortOrder = ((await Service.max('sortOrder', { transaction })) || 0) + 10;
    const service = await Service.create(data, { transaction });
    await audit.log(req, { action: 'SERVICE_CREATED', entityType: 'Service', entityId: service.id, after: json(service) }, { transaction });
    return json(service);
  });
}

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const service = await Service.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!service) throw AppError.notFound('Service');
    const before = json(service);
    for (const field of ['name', 'tracksColour', 'isActive', 'sortOrder', 'menuGroup']) {
      if (changes[field] !== undefined) service[field] = changes[field];
    }
    await service.save({ transaction });
    await audit.log(req, { action: 'SERVICE_UPDATED', entityType: 'Service', entityId: id, before, after: json(service) }, { transaction });
    return json(service);
  });
}

const companyJSON = (c) => ({ id: c.id, name: c.name, code: c.code, isActive: c.isActive });

async function findOr404(id, transaction) {
  const service = await Service.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!service) throw AppError.notFound('Service');
  return service;
}

/** The companies that have this service. */
async function companies(id, transaction) {
  const service = await Service.findByPk(id, {
    include: [{ model: Company, as: 'companies', through: { attributes: [] } }],
    order: [[{ model: Company, as: 'companies' }, 'name', 'ASC']],
    transaction,
  });
  if (!service) throw AppError.notFound('Service');
  return { service: json(service), companies: service.companies.map(companyJSON) };
}

/** Gives this service to exactly these companies (and takes it away from every other company). */
async function setCompanies(req, id, companyIds) {
  return sequelize.transaction(async (transaction) => {
    const service = await findOr404(id, transaction);
    const wanted = [...new Set(companyIds)];
    const found = await Company.findAll({ where: { id: wanted }, transaction });
    if (found.length !== wanted.length) {
      const have = new Set(found.map((c) => c.id));
      throw AppError.rule('UNKNOWN_COMPANY', 'Some companies do not exist', { companyIds: wanted.filter((c) => !have.has(c)) });
    }
    const current = await CompanyService.findAll({ where: { serviceId: id }, transaction });
    const already = new Set(current.map((r) => r.companyId));
    const adding = wanted.filter((c) => !already.has(c));
    if (adding.length && !service.isActive) {
      throw AppError.rule('SERVICE_INACTIVE', 'Switch the service on before giving it to companies');
    }

    await CompanyService.destroy({ where: { serviceId: id, companyId: { [Op.notIn]: wanted } }, transaction });
    await CompanyService.bulkCreate(adding.map((companyId) => ({ companyId, serviceId: id, givenById: req.user.id })), { transaction });

    const removed = [...already].filter((c) => !wanted.includes(c));
    if (removed.length) {
      // Users of those companies lose the service too.
      const userIds = (await User.findAll({ attributes: ['id'], where: { companyId: removed }, transaction })).map((u) => u.id);
      await UserService.destroy({ where: { serviceId: id, userId: userIds }, transaction });
    }
    await audit.log(req, {
      action: 'SERVICE_COMPANIES_CHANGED', entityType: 'Service', entityId: id, companyId: null,
      before: { companies: [...already].sort() },
      after: { companies: [...wanted].sort(), added: adding, removed },
    }, { transaction });
    return companies(id, transaction);
  });
}

// Checkbox list for the service screen: every company, with hasService = true for the ones that
// already have this service (the UI shows those ticked and disabled).
async function companyOptions(id) {
  const service = await findOr404(id);
  const given = new Set((await CompanyService.findAll({ attributes: ['companyId'], where: { serviceId: id } })).map((r) => r.companyId));
  const all = await Company.findAll({ order: [['name', 'ASC']] });
  return {
    service: json(service),
    companies: all.map((c) => ({ ...companyJSON(c), hasService: given.has(c.id) })),
  };
}

// Gives the service to the ticked companies only; nobody loses it. Companies that already
// have it are skipped and reported in alreadyGiven.
async function addCompanies(req, id, companyIds) {
  return sequelize.transaction(async (transaction) => {
    const service = await findOr404(id, transaction);
    const wanted = [...new Set(companyIds)];
    const found = await Company.findAll({ where: { id: wanted }, transaction });
    if (found.length !== wanted.length) {
      const have = new Set(found.map((c) => c.id));
      throw AppError.rule('UNKNOWN_COMPANY', 'Some companies do not exist', { companyIds: wanted.filter((c) => !have.has(c)) });
    }
    const current = await CompanyService.findAll({ where: { serviceId: id, companyId: wanted }, transaction });
    const already = new Set(current.map((r) => r.companyId));
    const adding = wanted.filter((c) => !already.has(c));
    if (adding.length && !service.isActive) {
      throw AppError.rule('SERVICE_INACTIVE', 'Switch the service on before giving it to companies');
    }
    if (adding.length) {
      await CompanyService.bulkCreate(adding.map((companyId) => ({ companyId, serviceId: id, givenById: req.user.id })), { transaction });
      await audit.log(req, {
        action: 'SERVICE_COMPANIES_CHANGED', entityType: 'Service', entityId: id, companyId: null,
        before: null, after: { added: adding },
      }, { transaction });
    }
    return { added: adding, alreadyGiven: [...already], ...(await companies(id, transaction)) };
  });
}

// The built-in modules the system is built around; they can never be deleted.
const CORE_MODULES = ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'GENERAL_STORE', 'STORE_REPORTS', 'PACKING', 'GATE_PASS',
  'REPORT_OVERVIEW', 'REPORT_GREY', 'REPORT_SO_CARDS', 'REPORT_DEPARTMENTS', 'REPORT_CHEMICAL_COST', 'REPORT_FOLDING', 'REPORT_ACTIVE_FABRIC', 'REPORT_PACKING', 'REPORT_GATE_PASSES'];

// Deletes a service. Every company and user that had it loses it. Built-in modules cannot be deleted.
async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const service = await findOr404(id, transaction);
    if (CORE_MODULES.includes(service.code)) {
      throw AppError.rule('CORE_MODULE', 'Built-in modules cannot be deleted');
    }
    const had = (await CompanyService.findAll({ attributes: ['companyId'], where: { serviceId: id }, transaction })).map((r) => r.companyId);
    await UserService.destroy({ where: { serviceId: id }, transaction });
    await CompanyService.destroy({ where: { serviceId: id }, transaction });
    const before = json(service);
    await service.destroy({ transaction });
    await audit.log(req, {
      action: 'SERVICE_DELETED', entityType: 'Service', entityId: id, companyId: null,
      before: { ...before, companies: had.sort() }, after: null,
    }, { transaction });
    return { deleted: true, id, removedFromCompanies: had.length };
  });
}

module.exports = { list, create, update, companies, setCompanies, companyOptions, addCompanies, remove };
