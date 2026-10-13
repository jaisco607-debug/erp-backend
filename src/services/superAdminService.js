// Super admins manage the platform. Only a super admin can add, change or switch off another super admin.
const { Op } = require('sequelize');
const { sequelize, User } = require('../models');
const AppError = require('../utils/AppError');
const { hashPassword } = require('../utils/password');
const audit = require('./auditService');
const { endAllSessions } = require('./authService');

const TYPE = 'SUPER_ADMIN';

async function list({ page, limit, search, isActive }) {
  const where = { userType: TYPE };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { email: { [Op.iLike]: `%${search}%` } }];
  const { rows, count } = await User.findAndCountAll({ where, order: [['createdAt', 'ASC']], limit, offset: (page - 1) * limit });
  return { data: rows.map((u) => u.toSafeJSON()), page, limit, total: count };
}

async function findOr404(id, transaction) {
  const user = await User.findOne({ where: { id, userType: TYPE }, lock: transaction ? transaction.LOCK.UPDATE : undefined, transaction });
  if (!user) throw AppError.notFound('Super admin');
  return user;
}

async function create(req, { name, email, password }) {
  return sequelize.transaction(async (transaction) => {
    const user = await User.create(
      { name, email, passwordHash: await hashPassword(password), userType: TYPE, companyId: null, createdById: req.user?.id ?? null },
      { transaction },
    );
    await audit.log(req, { action: 'SUPER_ADMIN_CREATED', entityType: 'User', entityId: user.id, after: user.toSafeJSON() }, { transaction });
    return user.toSafeJSON();
  });
}

async function update(req, id, changes) {
  return sequelize.transaction(async (transaction) => {
    const user = await findOr404(id, transaction);
    if (changes.isActive === false && user.id === req.user.id) {
      throw AppError.rule('CANNOT_DEACTIVATE_SELF', 'You cannot switch off your own account');
    }
    const before = user.toSafeJSON();
    if (changes.name !== undefined) user.name = changes.name;
    if (changes.isActive !== undefined) user.isActive = changes.isActive;
    await user.save({ transaction });
    if (changes.isActive === false) await endAllSessions(user, transaction);
    await audit.log(req, { action: 'SUPER_ADMIN_UPDATED', entityType: 'User', entityId: user.id, before, after: user.toSafeJSON() }, { transaction });
    return user.toSafeJSON();
  });
}

async function resetPassword(req, id, { newPassword }) {
  await sequelize.transaction(async (transaction) => {
    const user = await findOr404(id, transaction);
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await endAllSessions(user, transaction);
    await audit.log(req, { action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id }, { transaction });
  });
}

module.exports = { list, create, update, resetPassword };
