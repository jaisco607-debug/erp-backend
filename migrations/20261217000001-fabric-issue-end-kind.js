'use strict';
// Fabric issue: how an issue ended (owner 2026-11-23). Cancelling an SO card that holds store cloth sends the cloth BACK TO THE STORE
// (endKind RETURNED, "Returned to store"); an issue undone on its own, e.g. entered by mistake, is CANCELLED. Both put the thaans back in the stock.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE fabric_issues ADD COLUMN "endKind" varchar(10) CHECK ("endKind" IN ('CANCELLED', 'RETURNED'))`);
      await q(`UPDATE fabric_issues SET "endKind" = 'CANCELLED' WHERE "cancelledAt" IS NOT NULL`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE fabric_issues DROP COLUMN "endKind"');
  },
};
