'use strict';
// Deleted / cancelled lots report (Production > Reports > Grey): a deleted grey lot is already kept (soft delete, "deletedAt").
// This adds who deleted it, why, and what kind of removal it was; old deletions get their "who" from the audit log.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE grey_lots ADD COLUMN "deletedById" uuid, ADD COLUMN "deleteKind" varchar(12), ADD COLUMN "deleteReason" varchar(300)');
      await q(`UPDATE grey_lots gl SET "deletedById" = a."actorId"
        FROM audit_logs a WHERE gl."deletedAt" IS NOT NULL AND a.action = 'GREY_LOT_DELETED' AND a."entityId" = gl.id::text AND a."actorId" IS NOT NULL`);
      await q(`UPDATE grey_lots SET "deleteKind" = CASE WHEN source = 'STORE' THEN 'CANCELLED' ELSE 'DELETED' END WHERE "deletedAt" IS NOT NULL`);
      await q('CREATE INDEX grey_lots_deleted ON grey_lots ("companyId", "deletedAt") WHERE "deletedAt" IS NOT NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS grey_lots_deleted');
    await queryInterface.sequelize.query('ALTER TABLE grey_lots DROP COLUMN "deletedById", DROP COLUMN "deleteKind", DROP COLUMN "deleteReason"');
  },
};
