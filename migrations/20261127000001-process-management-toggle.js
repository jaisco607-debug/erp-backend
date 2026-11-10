'use strict';
// Process Management is switched on per company by the super admin, and the client admin adds his own processes (owner 2026-11-16).
//   companies."processManagement"  true = the client admin has Process Management: the processes he was given and the ones he adds himself. false = he has none of it (no tab, no processes).
//                                  Every company that exists today keeps it (true) so nothing changes; a company the super admin registers from now on starts with it OFF.
//   companies."processLimit"       how many processes the client admin may add himself (0 = none); the processes the super admin gave before do not count.
//   services."companyId"           the company that made the process; empty = a service of the platform (the super admin's list). The code only has to be unique inside its owner.
//                                  (No foreign key on purpose: the test clean-up truncates companies with CASCADE and must not wipe the platform's services.)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE companies
        ADD COLUMN "processManagement" boolean NOT NULL DEFAULT true,
        ADD COLUMN "processLimit" integer NOT NULL DEFAULT 0 CHECK ("processLimit" >= 0 AND "processLimit" <= 1000)`);
      await q('ALTER TABLE services ADD COLUMN "companyId" uuid');
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS services_code_key');
      await q('DROP INDEX IF EXISTS services_code_key');
      await q(`CREATE UNIQUE INDEX services_code_owner ON services (code, COALESCE("companyId", '00000000-0000-0000-0000-000000000000'))`);
      await q('CREATE INDEX services_company ON services ("companyId") WHERE "companyId" IS NOT NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`DELETE FROM user_services WHERE "serviceId" IN (SELECT id FROM services WHERE "companyId" IS NOT NULL)`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN (SELECT id FROM services WHERE "companyId" IS NOT NULL)`);
      await q('DELETE FROM services WHERE "companyId" IS NOT NULL');
      await q('DROP INDEX IF EXISTS services_company');
      await q('DROP INDEX IF EXISTS services_code_owner');
      await q('ALTER TABLE services ADD CONSTRAINT services_code_key UNIQUE (code)');
      await q('ALTER TABLE services DROP COLUMN "companyId"');
      await q('ALTER TABLE companies DROP COLUMN "processLimit", DROP COLUMN "processManagement"');
    });
  },
};
