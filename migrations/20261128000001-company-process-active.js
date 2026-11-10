'use strict';
// The client admin chooses which processes stay ACTIVE (owner 2026-11-17). The limit now counts every process the company can use: its own + the ones the super admin gave.
//   company_services."isActive"  the company's own switch for a service it has (used for processes): false = hidden from the client admin's menus and users, nothing deleted.
//                                It is per company, never on the shared platform service row. Existing rows stay true.
//   companies."processLimit"     a company that already has processes was given a limit of 0 by the earlier migration: it now starts with the number of processes it has
//                                (so it is not "over the limit" on the first day); the super admin changes it any time.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE company_services ADD COLUMN "isActive" boolean NOT NULL DEFAULT true');
      await q(`UPDATE companies c SET "processLimit" = LEAST(1000, (SELECT count(*) FROM company_services cs JOIN services s ON s.id = cs."serviceId"
        WHERE cs."companyId" = c.id AND s.kind = 'PROCESS' AND s."isActive" AND s."companyId" IS NULL)) WHERE c."processLimit" = 0 AND c."processManagement"`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE company_services DROP COLUMN "isActive"');
  },
};
