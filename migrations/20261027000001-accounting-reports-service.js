'use strict';
// Accounting reports (owner 2026-10-27): the Trial Balance and the account ledger. A report service is read only (kind REPORT: VIEW only),
// in the ACCOUNTS tab of the menu.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
      SELECT gen_random_uuid(), 'ACC_REPORTS', 'Accounting Reports', 'REPORT', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
      WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_REPORTS')`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_REPORTS')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_REPORTS'`);
    });
  },
};
