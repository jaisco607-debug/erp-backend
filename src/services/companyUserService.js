// A client admin manages the employees (users) of their own company: adds them with an email and a
// password, switches them off, resets passwords and gives each one some or all of the company's services
// with VIEW or FULL access. The employee logs in with the company's code + their own email + password and
// sees only what was given. Only the super admin makes client admins; a client admin cannot make another.
// Everything here is limited to the client admin's own company: another company's users are "not found".
const { Op } = require('sequelize');
const { sequelize, User, UserService } = require('../models');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');
const audit = require('./auditService');
const { endAllSessions } = require('./authService');
const { companyServices, userServices, servicesOfUsers } = require('./accessService');
const { assertEmailFree } = require('./userEmail');

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

const withServices = (user, services) => ({ ...user.toSafeJSON(), serviceCount: services.length, services });

async function details(user, transaction) {
  return withServices(user, (await servicesOfUsers([user], transaction)).get(user.id));
}

/**
 * Every requested service must be one the company has now. Report services are read-only, so they are
 * always stored as VIEW. Returns the rows ready to save.
 */
async function prepare(req, wanted, transaction) {
  const have = new Map((await companyServices(req.user.companyId, transaction)).map((s) => [s.id, s]));
  const missing = wanted.filter((w) => !have.has(w.serviceId)).map((w) => w.serviceId);
  if (missing.length) {
    throw AppError.rule('SERVICE_NOT_IN_COMPANY', 'You can only give services your company has', { serviceIds: missing });
  }
  return wanted.map((w) => ({ serviceId: w.serviceId, access: have.get(w.serviceId).kind === 'REPORT' ? 'VIEW' : w.access }));
}

async function codesOf(user, transaction) {
  return (await userServices(user, transaction)).map((g) => `${g.service.code}:${g.access}`).sort();
}

async function replaceGrants(req, user, grants, transaction) {
  await UserService.destroy({ where: { userId: user.id }, transaction });
  await UserService.bulkCreate(
    grants.map((g) => ({ userId: user.id, serviceId: g.serviceId, access: g.access, givenById: req.user.id })),
    { transaction },
  );
}

/** The services the client admin can give: all the company has, grouped by tab (menuGroup). */
async function serviceOptions(req) {
  const services = await companyServices(req.user.companyId);
  return {
    data: services.map((s) => ({
      id: s.id, code: s.code, name: s.name, kind: s.kind, menuGroup: s.menuGroup,
      // report services are read-only: only VIEW can be given
      accessLevels: s.kind === 'REPORT' ? ['VIEW'] : ['VIEW', 'FULL'],
    })),
  };
}

async function list(req, { page, limit, search, isActive }) {
  const where = { userType: TYPE, companyId: req.user.companyId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }, { phone: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await User.findAndCountAll({ where, order: [['createdAt', 'ASC']], limit, offset: (page - 1) * limit });
  const services = await servicesOfUsers(rows);
  return { data: rows.map((u) => withServices(u, services.get(u.id))), page, limit, total: count };
}

async function get(req, id) {
  return details(await findOr404(req, id));
}

async function create(req, { name, email, phone, password, services }) {
  return sequelize.transaction(async (transaction) => {
    const grants = await prepare(req, services, transaction);
    await assertEmailFree(req.user.companyId, email, null, transaction);
    const user = await User.create(
      { name, email, phone: phone || null, passwordHash: await hashPassword(password), userType: TYPE, companyId: req.user.companyId, createdById: req.user.id },
      { transaction },
    );
    await replaceGrants(req, user, grants, transaction);
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
    if (changes.email !== undefined && changes.email.toLowerCase() !== user.email) {
      await assertEmailFree(req.user.companyId, changes.email, user.id, transaction);
      user.email = changes.email;
    }
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.phone !== undefined) user.phone = changes.phone || null;
    if (changes.isActive !== undefined) user.isActive = changes.isActive;
    await user.save({ transaction });
    // a new email changes who they are at login: end their sessions like a switch-off does
    if ((before.isActive && changes.isActive === false) || before.email !== user.email) await endAllSessions(user, transaction);
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

/**
 * Replaces the user's whole list; send [] to take everything away. The employee sees the change at their
 * next /auth/me (or login). Their open session keeps working with the new list: the API checks it on every call.
 */
async function setServices(req, id, services) {
  return sequelize.transaction(async (transaction) => {
    const user = await findOr404(req, id, transaction, true);
    const grants = await prepare(req, services, transaction);
    const before = await codesOf(user, transaction);
    await replaceGrants(req, user, grants, transaction);
    await audit.log(req, {
      action: 'USER_SERVICES_CHANGED', entityType: 'User', entityId: user.id, companyId: user.companyId,
      before: { services: before }, after: { services: await codesOf(user, transaction) },
    }, { transaction });
    return details(user, transaction);
  });
}

module.exports = { serviceOptions, list, get, create, update, resetPassword, setServices };
