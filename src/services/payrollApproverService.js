// Who may review joining applications (approve, reject, correct the salary and work details).
// A client admin always may; besides them the people chosen here (they also need any payroll service to open the screen).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const { userServices } = require('./accessService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const PAYROLL = (code) => /^PAYROLL_/.test(code);

async function isApprover(req) {
  if (req.user.userType === 'CLIENT_ADMIN') return true;
  const rows = await q('SELECT 1 FROM payroll_approvers WHERE "companyId" = :companyId AND "userId" = :userId', { companyId: req.user.companyId, userId: req.user.id });
  return rows.length > 0;
}

async function list(req) {
  const rows = await q(`SELECT u.id, u.name, u.email, u."userType" FROM payroll_approvers a JOIN users u ON u.id = a."userId"
    WHERE a."companyId" = :companyId ORDER BY lower(u.name)`, { companyId: req.user.companyId });
  return { data: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, userType: u.userType })), clientAdminAlways: true };
}

/** Replaces the list. Every person must be an active user of this company with some payroll service. */
async function set(req, userIds) {
  const { companyId } = req.user;
  const ids = [...new Set(userIds)];
  await sequelize.transaction(async (transaction) => {
    for (const id of ids) {
      const [u] = await q('SELECT id, name, "userType", "companyId", "isActive" FROM users WHERE id = :id AND "companyId" = :companyId', { id, companyId }, transaction);
      if (!u) throw AppError.notFound('User');
      if (!u.isActive) throw AppError.rule('USER_INACTIVE', `${u.name} is switched off`);
      if (u.userType === 'USER' && !(await userServices(u, transaction)).some((g) => PAYROLL(g.service.code))) {
        throw AppError.rule('NO_PAYROLL_ACCESS', `${u.name} has no payroll service: give one first`, { userId: u.id });
      }
    }
    const before = (await q('SELECT "userId" FROM payroll_approvers WHERE "companyId" = :companyId', { companyId }, transaction)).map((r) => r.userId);
    await sequelize.query('DELETE FROM payroll_approvers WHERE "companyId" = :companyId', { replacements: { companyId }, transaction });
    for (const id of ids) {
      await sequelize.query('INSERT INTO payroll_approvers ("companyId", "userId", "createdById") VALUES (:companyId, :id, :by)', { replacements: { companyId, id, by: req.user.id }, transaction });
    }
    await audit.log(req, { action: 'PAYROLL_APPROVERS_SET', entityType: 'PayrollApprovers', before: { userIds: before }, after: { userIds: ids } }, { transaction });
  });
  return list(req);
}

module.exports = { isApprover, list, set };
