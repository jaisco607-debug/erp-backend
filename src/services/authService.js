// Login, refresh, logout and password change for EVERYONE (super admin, client admin, users):
// one login window, the answer tells the frontend who this is.
const { Op } = require('sequelize');
const { sequelize, User, RefreshToken, Company } = require('../models');
const { normalize: normalizeCode } = require('../utils/companyCode');
const AppError = require('../utils/AppError');
const locks = require('./lockService');
const { hashPassword, checkPassword } = require('../utils/password');
const { signAccessToken, newRefreshToken, hashToken } = require('../utils/tokens');
const audit = require('./auditService');
const { profile } = require('./accessService');
const { superAdminCode } = require('./loginCodeService');
const { hasActiveClientAdmin } = require('./companyAccessService');

// From .env (LOGIN_MAX_FAILED, LOGIN_LOCK_MINUTES); default 5 wrong passwords lock the account for 15 minutes.
const { maxFailed: MAX_FAILED_LOGINS, lockMinutes: LOCK_MINUTES } = require('../config/env').login;
// Same answer for unknown company code, unknown email, wrong password, locked or deactivated account
// or company: an attacker learns nothing about which companies or accounts exist.
const LOGIN_FAILED = () => AppError.unauthorized('Company code, email or password is incorrect');

/**
 * Finds who is logging in. Everyone types a code:
 *   the super admins' code -> only super admins
 *   a company's code       -> only that company's client admins and users
 */
async function findLoginUser(companyCode, email, transaction) {
  const byEmail = sequelize.where(sequelize.fn('lower', sequelize.col('User.email')), email.toLowerCase());
  const code = normalizeCode(companyCode);
  if (code === (await superAdminCode(transaction))) {
    const user = await User.findOne({ where: [byEmail, { companyId: null }], lock: transaction.LOCK.UPDATE, transaction });
    return { user };
  }
  const company = await Company.findOne({ where: { code }, transaction });
  if (!company) return { reason: 'UNKNOWN_COMPANY' };
  const user = await User.findOne({ where: [byEmail, { companyId: company.id }], lock: transaction.LOCK.UPDATE, transaction });
  if (user) user.company = company;
  return { user, company };
}

async function issueSession(user, req, transaction) {
  const refresh = newRefreshToken();
  const session = await RefreshToken.create(
    {
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 300),
    },
    { transaction },
  );
  return {
    session,
    tokens: { accessToken: signAccessToken(user), refreshToken: refresh.token, tokenType: 'Bearer' },
  };
}

async function login(req, { companyCode, email, password }) {
  return sequelize.transaction(async (transaction) => {
    // Row lock: two logins at the same moment cannot both slip past the failed-attempt counter.
    const { user, company, reason: lookupFailure } = await findLoginUser(companyCode, email, transaction);

    if (!user) {
      await checkPassword(password, null); // same time as a real check
      await audit.log(req, {
        action: 'LOGIN_FAILED', actor: null, actorEmail: email, companyId: company?.id ?? null,
        after: { reason: lookupFailure || 'UNKNOWN_EMAIL', companyCode },
      }, { transaction });
      return { error: LOGIN_FAILED() };
    }
    if (company && !company.isActive) {
      await audit.log(req, { action: 'LOGIN_FAILED', actor: user, entityType: 'User', entityId: user.id, after: { reason: 'COMPANY_INACTIVE' } }, { transaction });
      return { error: LOGIN_FAILED() };
    }
    // an employee cannot log in while the company has no active client admin (switched off or deleted)
    if (user.userType === 'USER' && !(await hasActiveClientAdmin(user.companyId, transaction))) {
      await audit.log(req, { action: 'LOGIN_FAILED', actor: user, entityType: 'User', entityId: user.id, after: { reason: 'NO_ACTIVE_CLIENT_ADMIN' } }, { transaction });
      return { error: LOGIN_FAILED() };
    }
    if (user.isLocked() || !user.isActive) {
      const reason = !user.isActive ? 'INACTIVE' : 'LOCKED';
      await audit.log(req, { action: 'LOGIN_FAILED', actor: user, entityType: 'User', entityId: user.id, after: { reason } }, { transaction });
      return { error: LOGIN_FAILED() };
    }

    const ok = await checkPassword(password, user.passwordHash);
    if (!ok) {
      user.failedLoginCount += 1;
      let reason = 'WRONG_PASSWORD';
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        user.failedLoginCount = 0;
        reason = 'LOCKED_NOW';
      }
      await user.save({ transaction });
      await audit.log(req, { action: 'LOGIN_FAILED', actor: user, entityType: 'User', entityId: user.id, after: { reason } }, { transaction });
      return { error: LOGIN_FAILED() };
    }

    user.failedLoginCount = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await user.save({ transaction });
    const { tokens } = await issueSession(user, req, transaction);
    await audit.log(req, { action: 'LOGIN', actor: user, entityType: 'User', entityId: user.id }, { transaction });
    return { result: { ...tokens, ...(await profile(user, { transaction })) } };
  }).then(({ error, result }) => {
    // Failed attempts are committed (counter + audit) before the error is sent.
    if (error) throw error;
    return result;
  });
}

/**
 * Swaps a refresh token for a new pair. The old token stops working.
 * If an already-used token shows up again, someone copied it: every session of that user is ended.
 */
async function refresh(req, refreshToken) {
  return sequelize.transaction(async (transaction) => {
    const session = await RefreshToken.findOne({ where: { tokenHash: hashToken(refreshToken) }, lock: transaction.LOCK.UPDATE, transaction });
    if (!session) return { error: AppError.unauthorized('Session expired, please log in again') };

    const user = await User.findByPk(session.userId, {
      include: [{ model: Company, as: 'company' }],
      lock: { level: transaction.LOCK.UPDATE, of: User },
      transaction,
    });
    if (!user) return { error: AppError.unauthorized('Session expired, please log in again') };
    if (session.revokedAt && session.replacedById) {
      // This token was already swapped for a new one, so two people hold copies of it.
      await endAllSessions(user, transaction);
      await audit.log(req, { action: 'SESSION_REUSE_DETECTED', actor: user, entityType: 'User', entityId: user.id }, { transaction });
      return { error: AppError.unauthorized('Session expired, please log in again') };
    }
    if (session.revokedAt || session.expiresAt <= new Date() || !user.isActive || (user.company && !user.company.isActive)) {
      return { error: AppError.unauthorized('Session expired, please log in again') };
    }

    if (user.userType === 'USER' && !(await hasActiveClientAdmin(user.companyId, transaction))) {
      return { error: AppError.unauthorized('Session expired, please log in again') };
    }
    const { session: next, tokens } = await issueSession(user, req, transaction);
    session.revokedAt = new Date();
    session.replacedById = next.id;
    await session.save({ transaction });
    return { result: tokens };
  }).then(({ error, result }) => {
    if (error) throw error;
    return result;
  });
}

async function logout(req, refreshToken) {
  await sequelize.transaction(async (transaction) => {
    const session = await RefreshToken.findOne({ where: { tokenHash: hashToken(refreshToken), revokedAt: null }, transaction });
    if (!session) return;
    session.revokedAt = new Date();
    await session.save({ transaction });
    await locks.releaseAllForUsers(session.userId, transaction);
    await audit.log(req, { action: 'LOGOUT', actor: await User.findByPk(session.userId, { transaction }), entityType: 'User', entityId: session.userId }, { transaction });
  });
}

/** Ends every session: old access tokens stop working (tokenVersion) and refresh tokens are revoked. */
async function endAllSessions(user, transaction) {
  user.tokenVersion += 1;
  await user.save({ transaction });
  await locks.releaseAllForUsers(user.id, transaction); // logout everywhere / switched off / deleted: their edit locks end
  await RefreshToken.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null }, transaction });
}

async function logoutAll(req) {
  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(req.user.id, { lock: transaction.LOCK.UPDATE, transaction });
    await endAllSessions(user, transaction);
    await audit.log(req, { action: 'LOGOUT_ALL', entityType: 'User', entityId: user.id }, { transaction });
  });
}

async function changePassword(req, { currentPassword, newPassword }) {
  await sequelize.transaction(async (transaction) => {
    const user = await User.findByPk(req.user.id, { lock: transaction.LOCK.UPDATE, transaction });
    if (!(await checkPassword(currentPassword, user.passwordHash))) {
      throw AppError.rule('WRONG_PASSWORD', 'Current password is incorrect');
    }
    if (await checkPassword(newPassword, user.passwordHash)) {
      throw AppError.rule('SAME_PASSWORD', 'New password must be different from the current one');
    }
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    await endAllSessions(user, transaction);
    await audit.log(req, { action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id }, { transaction });
  });
}

/** Removes sessions that expired more than 30 days ago (keeps the table small). */
async function purgeOldSessions() {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  return RefreshToken.destroy({ where: { expiresAt: { [Op.lt]: cutoff } } });
}

module.exports = { login, refresh, logout, logoutAll, changePassword, endAllSessions, purgeOldSessions };
