'use strict';
// Chart of Accounts v2 (frontend spec, 2026-10-25):
//   - "isLocked" becomes "isSystem" (an account the software relies on) and gets a "systemKey" (AR_CONTROL, DEFAULT_SALES, RETAINED_EARNINGS ...),
//     unique per company
//   - "isContra": an account that runs against its type (accumulated depreciation, owner drawings, sales returns); its normal balance is the opposite one
//   - an account name is unique inside one parent (case does not matter), also checked by the database
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts RENAME COLUMN "isLocked" TO "isSystem"');
      await q('ALTER TABLE accounts ADD COLUMN "systemKey" varchar(40)');
      await q('ALTER TABLE accounts ADD COLUMN "isContra" boolean NOT NULL DEFAULT false');
      await q(`UPDATE accounts SET "systemKey" = CASE "controlType"
          WHEN 'CUSTOMERS' THEN 'AR_CONTROL' WHEN 'SUPPLIERS' THEN 'AP_CONTROL' WHEN 'SALES' THEN 'DEFAULT_SALES'
          WHEN 'OUTPUT_TAX' THEN 'OUTPUT_TAX' WHEN 'INPUT_TAX' THEN 'INPUT_TAX' END
        WHERE "isSystem"`);
      await q('ALTER TABLE accounts ADD CONSTRAINT accounts_system_key_needs_system CHECK ("systemKey" IS NULL OR "isSystem")');
      await q('CREATE UNIQUE INDEX accounts_company_system_key ON accounts ("companyId", "systemKey") WHERE "systemKey" IS NOT NULL');
      await q(`CREATE UNIQUE INDEX accounts_company_parent_name ON accounts ("companyId", COALESCE("parentId", '00000000-0000-0000-0000-000000000000'::uuid), lower(name))`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX accounts_company_parent_name');
      await q('DROP INDEX accounts_company_system_key');
      await q('ALTER TABLE accounts DROP CONSTRAINT accounts_system_key_needs_system');
      await q('ALTER TABLE accounts DROP COLUMN "isContra"');
      await q('ALTER TABLE accounts DROP COLUMN "systemKey"');
      await q('ALTER TABLE accounts RENAME COLUMN "isSystem" TO "isLocked"');
    });
  },
};
