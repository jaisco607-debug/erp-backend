'use strict';
// The weaving module keeps its OWN customers and vendors (owner 2026-11-13): the same tables, but a separate list.
//   customers.module / vendors.module   'MAIN' (every row that exists: Grey Store, stores, accounts) or 'WEAVING'
//   The code (1, 2, 3 ...) and the name are unique inside the company AND the module list, so the weaving list starts at 1 and may hold a name the main list also has.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of ['customers', 'vendors']) {
        await q(`ALTER TABLE ${t} ADD COLUMN module varchar(12) NOT NULL DEFAULT 'MAIN' CHECK (module IN ('MAIN', 'WEAVING'))`);
      }
      await q('DROP INDEX customers_company_code');
      await q('DROP INDEX customers_company_name');
      await q('CREATE UNIQUE INDEX customers_company_code ON customers ("companyId", module, code) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX customers_company_name ON customers ("companyId", module, lower(name)) WHERE "deletedAt" IS NULL');
      await q('ALTER TABLE vendors DROP CONSTRAINT "vendors_companyId_code_key"');
      await q('DROP INDEX vendors_name');
      await q('CREATE UNIQUE INDEX vendors_company_code ON vendors ("companyId", module, code)');
      await q('CREATE UNIQUE INDEX vendors_name ON vendors ("companyId", module, lower(name))');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM yarn_inwards WHERE \"customerId\" IN (SELECT id FROM customers WHERE module = 'WEAVING') OR \"vendorId\" IN (SELECT id FROM vendors WHERE module = 'WEAVING')");
      await q("DELETE FROM customers WHERE module = 'WEAVING'");
      await q("DELETE FROM vendors WHERE module = 'WEAVING'");
      await q('DROP INDEX customers_company_code');
      await q('DROP INDEX customers_company_name');
      await q('CREATE UNIQUE INDEX customers_company_code ON customers ("companyId", code) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX customers_company_name ON customers ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
      await q('DROP INDEX vendors_company_code');
      await q('DROP INDEX vendors_name');
      await q('ALTER TABLE vendors ADD CONSTRAINT "vendors_companyId_code_key" UNIQUE ("companyId", code)');
      await q('CREATE UNIQUE INDEX vendors_name ON vendors ("companyId", lower(name))');
      for (const t of ['customers', 'vendors']) await q(`ALTER TABLE ${t} DROP COLUMN module`);
    });
  },
};
