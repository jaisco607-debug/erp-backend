'use strict';
// Weaving module (owner 2026-11-11), step 1: the Yarn Count master.
//   services.menuGroup gets a new tab WEAVING and one service WEAVING_MASTERS (the weaving masters: yarn counts now; item card and beams later).
//   yarn_counts: one row per count of a company, e.g. "22|s", "22|1", "22|s Cotton", "22|s Polister Cotton".
//     id    unique (uuid)         code  1, 2, 3 ... running number of the company (shown as the ID on screen)
//     The name is unique inside the company WITHOUT looking at capital / small letters: "22|s cotton" and "22|S Cotton" are the same count
//     (extra spaces are squeezed by the service before saving). A deleted count (deletedAt) frees its name.
const GROUPS = "'PRODUCTION', 'PROCESS', 'STORE', 'REPORTS', 'ACCOUNTS', 'PAYROLL'";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN (${GROUPS}, 'WEAVING'))`);
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'WEAVING_MASTERS', 'Weaving Masters', 'MODULE', 'WEAVING', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'WEAVING_MASTERS')`);
      await q(`CREATE TABLE yarn_counts (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        name varchar(80) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_counts_company_name ON yarn_counts ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX yarn_counts_company_code ON yarn_counts ("companyId", code)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      await q('DROP TABLE IF EXISTS yarn_counts');
      const gone = "(SELECT id FROM services WHERE code = 'WEAVING_MASTERS')";
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q("DELETE FROM services WHERE code = 'WEAVING_MASTERS'");
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN (${GROUPS}))`);
    });
  },
};
