// A client admin manages the users of their own company: adds them, switches them off, resets passwords
// and gives each one some of the company's services with VIEW or FULL access.
// Everything here is limited to the client admin's own company: another company's users are "not found".
const { Op } = require('sequelize');
const { sequelize, User, UserService } = require('../models');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');
const audit = require('./auditService');
const { endAllSessions } = require('./authService');
const { companyServices, userServices } = require('./accessService');

const TYPE = 'USER';

async function findOr404(req, id, transaction, lock = false) {
  const user = await User.findOne({
    where: { id, userType: TYPE, companyId: req.user.companyId },
    lock: lock ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  if (!user) throw AppError.notFound('User');
  return user;
}

const grantsJSON = (grants) => grants.map((g) => ({ id: g.service.id, code: g.service.code, name: g.service.name, kind: g.service.kind, access: g.access }));

async function details(user, transaction) {
  return { ...user.toSafeJSON(), services: grantsJSON(await userServices(user, transaction)) };
}

/** Every requested service must be one the company has now. */
async function checkServices(req, wanted, transaction) {
  const have = new Set((await companyServices(req.user.companyId, transaction)).map((s) => s.id));
  const missing = wanted.filter((w) => !have.has(w.serviceId)).map((w) => w.serviceId);
  if (missing.length) {
    throw AppError.rule('SERVICE_NOT_IN_COMPANY', 'You can only give services your company has', { serviceIds: missing });
  }
}

async function codesOf(user, transaction) {
  return grantsJSON(await userServices(user, transaction)).map((s) => `${s.code}:${s.access}`).sort();
}

async function replaceGrants(req, user, wanted, transaction) {
  await UserService.destroy({ where: { userId: user.id }, transaction });
  await UserService.bulkCreate(
    wanted.map((w) => ({ userId: user.id, serviceId: w.serviceId, access: w.access, givenById: req.user.id })),
    { transaction },
  );
}

async function list(req, { page, limit, search, isActive }) {
  const where = { userType: TYPE, companyId: req.user.companyId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await User.findAndCountAll({ where, order: [['createdAt', 'ASC']], limit, offset: (page - 1) * limit });
  return { data: await Promise.all(rows.map((u) => details(u))), page, limit, total: count };
}

async function get(req, id) {
  return details(await findOr404(req, id));
}

async function create(req, { name, email, password, services }) {
  return sequelize.transaction(async (transaction) => {
    await checkServices(req, services, transaction);
    const user = await User.create(
      { name, email, passwordHash: await hashPassword(password), userType: TYPE, companyId: req.user.companyId, createdById: req.user.id },
      { transaction },
    );
    await replaceGrants(req, user, services, transaction);
    await audit.log(req, {
      action: 'COMPANY_USER_CREATED', entityType: 'User', entityId: user.id, companyId: user.companyId,
      after: { ...user.toSafeJSON(), services: await codesOf(user, transaction) },
    }, { transaction });
    return details(user, transaction);
  });
}

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const user = await findOr404(req, id, transaction, true);
    const before = user.toSafeJSON();
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.isActive !== undefined) user.isActive = changes.isActive;
    await user.save({ transaction });
    if (before.isActive && changes.isActive === false) await endAllSessions(user, transaction);
    await audit.log(req, {
      action: 'COMPANY_USER_UPDATED', entityType: 'User', entityId: user.id, companyId: user.companyId,
      before, after: user.toSafeJSON(),
    }, { transaction });
    return details(user, transaction);
  });
}

async function resetPassword(req, id, { newPassword }) {
  await sequelize.transaction(async (transaction) => {
    const user = await findOr404(req, id, transaction, true);
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await endAllSessions(user, transaction);
    await audit.log(req, { action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id, companyId: user.companyId }, { transaction });
  });
}

/** Replaces the user's whole list; send [] to take everything away. Takes effect at their next /me. */
async function setServices(req, id, services) {
  return sequelize.transaction(async (transaction) => {
    const user = await findOr404(req, id, transaction, true);
    await checkServices(req, services, transaction);
    const before = await codesOf(user, transaction);
    await replaceGrants(req, user, services, transaction);
    await audit.log(req, {
      action: 'USER_SERVICES_CHANGED', entityType: 'User', entityId: user.id, companyId: user.companyId,
      before: { services: before }, after: { services: await codesOf(user, transaction) },
    }, { transaction });
    return details(user, transaction);
  });
}

module.exports = { list, get, create, update, resetPassword, setServices };
