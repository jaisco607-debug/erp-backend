// Companies are registered by the super admin. Registering one also creates its first client admin,
// both in one go: either both are saved or nothing is. A new company has no services yet;
// the super admin gives them afterwards, from the company (setServices) or from a service (serviceCatalogService.setCompanies).
const { Op } = require('sequelize');
const { sequelize, Company, Service, CompanyService, User, RefreshToken, UserService } = require('../models');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');
const audit = require('./auditService');
const { endAllSessions } = require('./authService');
const { freeCode } = require('./loginCodeService');

/** Every id must be an existing, active service. */
async function loadServices(serviceIds, transaction) {
  const unique = [...new Set(serviceIds)];
  const services = await Service.findAll({ where: { id: unique, isActive: true }, order: [['sortOrder', 'ASC']], transaction });
  if (services.length !== unique.length) {
    const found = new Set(services.map((s) => s.id));
    throw AppError.rule('UNKNOWN_SERVICE', 'Some services do not exist or are switched off', { serviceIds: unique.filter((id) => !found.has(id)) });
  }
  return services;
}

const serviceJSON = (s) => ({ id: s.id, code: s.code, name: s.name, kind: s.kind });

async function findOr404(id, transaction, lock = false) {
  const company = await Company.findByPk(id, { transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
  if (!company) throw AppError.notFound('Company');
  return company;
}

async function details(id, transaction) {
  const company = await Company.findByPk(id, {
    include: [{ model: Service, as: 'services', through: { attributes: [] } }],
    order: [[{ model: Service, as: 'services' }, 'sortOrder', 'ASC']],
    transaction,
  });
  if (!company) throw AppError.notFound('Company');
  const admins = await User.findAll({ where: { companyId: id, userType: 'CLIENT_ADMIN' }, order: [['createdAt', 'ASC']], transaction });
  const userCount = await User.count({ where: { companyId: id }, transaction });
  return {
    ...company.toSafeJSON(),
    services: company.services.map(serviceJSON),
    clientAdmins: admins.map((u) => u.toSafeJSON()),
    userCount,
  };
}

async function list({ page, limit, search, isActive }) {
  const where = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { code: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await Company.findAndCountAll({
    where,
    // serviceCount: only the services the super admin gave (modules are given to everyone, so not counted)
    attributes: {
      include: [
        [sequelize.literal(`(SELECT count(*)::int FROM company_services cs JOIN services s ON s.id = cs."serviceId"
          WHERE cs."companyId" = "Company"."id" AND s.kind <> 'MODULE')`), 'serviceCount'],
        [sequelize.literal('(SELECT count(*)::int FROM users u WHERE u."companyId" = "Company"."id")'), 'userCount'],
      ],
    },
    order: [['name', 'ASC']],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    data: rows.map((c) => ({ ...c.toSafeJSON(), serviceCount: c.get('serviceCount'), userCount: c.get('userCount') })),
    page,
    limit,
    total: count,
  };
}

async function create(req, { name, contactPerson, phone, address, admin }) {
  return sequelize.transaction(async (transaction) => {
    const company = await Company.create(
      { name, code: await freeCode(transaction), contactPerson, phone, address, createdById: req.user.id },
      { transaction },
    );
    // Every active MODULE service (Grey Store, SO card, Gate Pass ...) is given at once; the rest the super admin switches on.
    const modules = await Service.findAll({ where: { kind: 'MODULE', isActive: true }, order: [['sortOrder', 'ASC']], transaction });
    await CompanyService.bulkCreate(modules.map((s) => ({ companyId: company.id, serviceId: s.id, givenById: req.user.id })), { transaction });
    const clientAdmin = await User.create(
      {
        name: admin.name,
        email: admin.email,
        passwordHash: await hashPassword(admin.password),
        userType: 'CLIENT_ADMIN',
        companyId: company.id,
        createdById: req.user.id,
      },
      { transaction },
    );

    await audit.log(req, {
      action: 'COMPANY_CREATED', entityType: 'Company', entityId: company.id, companyId: company.id,
      after: company.toSafeJSON(),
    }, { transaction });
    await audit.log(req, {
      action: 'CLIENT_ADMIN_CREATED', entityType: 'User', entityId: clientAdmin.id, companyId: company.id,
      after: clientAdmin.toSafeJSON(),
    }, { transaction });

    await audit.log(req, {
      action: 'COMPANY_SERVICES_CHANGED', entityType: 'Company', entityId: company.id, companyId: company.id,
      before: { services: [] }, after: { services: modules.map((s) => s.code).sort() },
    }, { transaction });

    return details(company.id, transaction);
  });
}

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const company = await findOr404(id, transaction, true);
    const before = company.toSafeJSON();
    for (const field of ['name', 'contactPerson', 'phone', 'address', 'isActive']) {
      if (changes[field] !== undefined) company[field] = changes[field];
    }
    await company.save({ transaction });

    if (before.isActive && changes.isActive === false) {
      // Everyone in the company is logged out: their refresh tokens stop working now,
      // and every request with an old access token is refused because the company is switched off.
      const userIds = (await User.findAll({ attributes: ['id'], where: { companyId: company.id }, transaction })).map((u) => u.id);
      await RefreshToken.update({ revokedAt: new Date() }, { where: { revokedAt: null, userId: userIds }, transaction });
    }
    await audit.log(req, {
      action: 'COMPANY_UPDATED', entityType: 'Company', entityId: company.id, companyId: company.id,
      before, after: company.toSafeJSON(),
    }, { transaction });
    return details(company.id, transaction);
  });
}

/** Replaces the company's services with exactly this list. */
/** A new random code, e.g. when the old one was given to the wrong person. The old code stops working at once. */
async function newCode(req, id) {
  return sequelize.transaction(async (transaction) => {
    const company = await findOr404(id, transaction, true);
    const before = { code: company.code };
    company.code = await freeCode(transaction);
    await company.save({ transaction });
    await audit.log(req, {
      action: 'COMPANY_CODE_CHANGED', entityType: 'Company', entityId: company.id, companyId: company.id,
      before, after: { code: company.code },
    }, { transaction });
    return details(company.id, transaction);
  });
}

async function setServices(req, id, serviceIds) {
  return sequelize.transaction(async (transaction) => {
    const company = await findOr404(id, transaction, true);
    const services = await loadServices(serviceIds, transaction);
    const current = await company.getServices({ transaction, joinTableAttributes: [] });

    const keep = services.map((s) => s.id);
    await CompanyService.destroy({ where: { companyId: id, serviceId: { [Op.notIn]: keep } }, transaction });
    // The company's users lose what the company lost.
    const userIds = (await User.findAll({ attributes: ['id'], where: { companyId: id }, transaction })).map((u) => u.id);
    await UserService.destroy({ where: { userId: userIds, serviceId: { [Op.notIn]: keep } }, transaction });
    const have = new Set(current.map((s) => s.id));
    await CompanyService.bulkCreate(
      services.filter((s) => !have.has(s.id)).map((s) => ({ companyId: id, serviceId: s.id, givenById: req.user.id })),
      { transaction },
    );

    await audit.log(req, {
      action: 'COMPANY_SERVICES_CHANGED', entityType: 'Company', entityId: id, companyId: id,
      before: { services: current.map((s) => s.code).sort() },
      after: { services: services.map((s) => s.code).sort() },
    }, { transaction });
    return details(id, transaction);
  });
}

/** The toggle on the company screen: one service on (enabled: true) or off (false). */
async function toggleService(req, id, serviceId, enabled) {
  const company = await findOr404(id);
  const current = (await company.getServices({ joinTableAttributes: [] })).map((s) => s.id);
  const wanted = enabled ? [...new Set([...current, serviceId])] : current.filter((s) => s !== serviceId);
  return setServices(req, id, wanted);
}

/**
 * Deletes a company: it disappears from lists and nobody of it can log in any more.
 * Nothing is wiped (soft delete), so its records and the audit log stay.
 */
async function remove(req, id) {
  await sequelize.transaction(async (transaction) => {
    const company = await findOr404(id, transaction, true);
    const userIds = (await User.findAll({ attributes: ['id'], where: { companyId: id }, transaction })).map((u) => u.id);
    await User.update({ isActive: false }, { where: { id: userIds }, transaction });
    await User.increment('tokenVersion', { where: { id: userIds }, transaction });
    await RefreshToken.update({ revokedAt: new Date() }, { where: { revokedAt: null, userId: userIds }, transaction });
    const before = company.toSafeJSON();
    await company.destroy({ transaction });
    await audit.log(req, {
      action: 'COMPANY_DELETED', entityType: 'Company', entityId: id, companyId: id, before, after: { usersSwitchedOff: userIds.length },
    }, { transaction });
  });
}

/** A client admin of this company, for the super admin to edit. */
async function findAdmin(companyId, userId, transaction) {
  await findOr404(companyId, transaction);
  const user = await User.findOne({ where: { id: userId, companyId, userType: 'CLIENT_ADMIN' }, lock: transaction.LOCK.UPDATE, transaction });
  if (!user) throw AppError.notFound('Client admin');
  return user;
}

async function updateAdmin(req, companyId, userId, changes) {
  return sequelize.transaction(async (transaction) => {
    const user = await findAdmin(companyId, userId, transaction);
    const before = user.toSafeJSON();
    for (const f of ['name', 'email', 'isActive']) if (changes[f] !== undefined) user[f] = changes[f];
    await user.save({ transaction });
    if (before.isActive && changes.isActive === false) await endAllSessions(user, transaction);
    await audit.log(req, { action: 'CLIENT_ADMIN_UPDATED', entityType: 'User', entityId: user.id, companyId, before, after: user.toSafeJSON() }, { transaction });
    return user.toSafeJSON();
  });
}

async function resetAdminPassword(req, companyId, userId, newPassword) {
  await sequelize.transaction(async (transaction) => {
    const user = await findAdmin(companyId, userId, transaction);
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await endAllSessions(user, transaction);
    await audit.log(req, { action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id, companyId }, { transaction });
  });
}

module.exports = { list, details, create, update, newCode, setServices, toggleService, remove, updateAdmin, resetAdminPassword };
