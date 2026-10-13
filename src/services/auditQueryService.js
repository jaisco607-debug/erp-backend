// Reading the audit log (newest first). Nothing in the app can change or delete audit rows.
const { Op } = require('sequelize');
const { AuditLog } = require('../models');

async function list({ page, limit, action, actorId, companyId, entityType, entityId, from, to }) {
  const where = {};
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (companyId) where.companyId = companyId;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (from || to) where.at = { ...(from && { [Op.gte]: from }), ...(to && { [Op.lte]: to }) };
  const { rows, count } = await AuditLog.findAndCountAll({ where, order: [['at', 'DESC'], ['id', 'DESC']], limit, offset: (page - 1) * limit });
  return { data: rows, page, limit, total: count };
}

module.exports = { list };
