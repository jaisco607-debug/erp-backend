'use strict';
// A client admin may rename a process the super admin gave his company (owner 2026-11-18). The new name is per company only:
//   company_services."displayName"  the company's own name for the service (null = the original name). The shared services row is never changed.
//   svc_name(service, company, original)  the name a company sees: its displayName, else the original (used by the SQL reports).
// The override goes away with the assignment row when the super admin removes the process from the company.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE company_services ADD COLUMN "displayName" varchar(120)');
      await q(`CREATE OR REPLACE FUNCTION svc_name(sid uuid, cid uuid, orig text) RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT COALESCE((SELECT cs."displayName" FROM company_services cs WHERE cs."serviceId" = sid AND cs."companyId" = cid), orig) $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS svc_name(uuid, uuid, text)');
    await queryInterface.sequelize.query('ALTER TABLE company_services DROP COLUMN "displayName"');
  },
};
