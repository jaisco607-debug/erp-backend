// Login codes: every company has one, and all super admins share one (kept in the "platform" row).
// A code is never used twice, not even between a company and the super admins.
const { sequelize, Company, Platform } = require('../models');
const audit = require('./auditService');
const { generate } = require('../utils/companyCode');

/** A random code that no company and not the super admins have, e.g. "K7QM-4XPA". */
async function freeCode(transaction) {
  for (;;) {
    const code = generate();
    const company = await Company.findOne({ where: { code }, attributes: ['id'], transaction });
    const platform = await Platform.findOne({ where: { superAdminCode: code }, attributes: ['id'], transaction });
    if (!company && !platform) return code;
  }
}

async function superAdminCode(transaction) {
  const platform = await Platform.findByPk(1, { transaction });
  return platform?.superAdminCode ?? null;
}

/** New code for all super admins; the old one stops working at once (people already logged in stay logged in). */
async function newSuperAdminCode(req) {
  return sequelize.transaction(async (transaction) => {
    const platform = await Platform.findByPk(1, { lock: transaction.LOCK.UPDATE, transaction });
    const before = { code: platform.superAdminCode };
    platform.superAdminCode = await freeCode(transaction);
    await platform.save({ transaction });
    await audit.log(req, {
      action: 'SUPER_ADMIN_CODE_CHANGED', entityType: 'Platform', entityId: '1',
      before, after: { code: platform.superAdminCode },
    }, { transaction });
    return { code: platform.superAdminCode };
  });
}

module.exports = { freeCode, superAdminCode, newSuperAdminCode };
