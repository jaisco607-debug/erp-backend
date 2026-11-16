'use strict';
// Fabric issue (owner 2026-11-24): a cancelled issue is DELETED (no CANCELLED rows any more), and an issue can be edited and issued again.
//   fabric_issues.thaanNos   the thaan numbers of the entry the issue holds; kept after a return so the edit form can tick them again
//   old CANCELLED rows are deleted (their thaans were already back in the stock, their lots removed)
//   endKind can only be RETURNED now
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE fabric_issues ADD COLUMN "thaanNos" integer[]');
      await q(`UPDATE fabric_issues fi SET "thaanNos" = COALESCE((SELECT array_agg(t."thaanNo" ORDER BY t."thaanNo") FROM fabric_inward_thaans t WHERE t."issueId" = fi.id), '{}')`);
      await q(`DELETE FROM fabric_issues WHERE "endKind" = 'CANCELLED'`);
      await q('ALTER TABLE fabric_issues DROP CONSTRAINT IF EXISTS "fabric_issues_endKind_check"');
      await q(`ALTER TABLE fabric_issues ADD CONSTRAINT "fabric_issues_endKind_check" CHECK ("endKind" = 'RETURNED')`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE fabric_issues DROP CONSTRAINT IF EXISTS "fabric_issues_endKind_check"');
      await q(`ALTER TABLE fabric_issues ADD CONSTRAINT "fabric_issues_endKind_check" CHECK ("endKind" IN ('CANCELLED', 'RETURNED'))`);
      await q('ALTER TABLE fabric_issues DROP COLUMN "thaanNos"');
    });
  },
};
