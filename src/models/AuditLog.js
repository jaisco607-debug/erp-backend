// The audit log: who did what, when, from where, and what the record looked like before and after.
// Rows are only ever added. The database refuses updates and deletes (see the migration).
const { DataTypes, Model } = require('sequelize');

class AuditLog extends Model {}

function init(sequelize) {
  AuditLog.init(
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      actorId: DataTypes.UUID,
      actorType: DataTypes.STRING(20),
      actorEmail: DataTypes.STRING(200),
      companyId: DataTypes.UUID,
      action: { type: DataTypes.STRING(60), allowNull: false },
      entityType: DataTypes.STRING(60),
      entityId: DataTypes.STRING(64),
      before: DataTypes.JSONB,
      after: DataTypes.JSONB,
      ip: DataTypes.STRING(64),
      userAgent: DataTypes.STRING(300),
      requestId: DataTypes.STRING(64),
    },
    { sequelize, modelName: 'AuditLog', tableName: 'audit_logs', timestamps: false },
  );
  return AuditLog;
}

module.exports = { AuditLog, init };
