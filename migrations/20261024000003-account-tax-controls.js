'use strict';
// Chart of Accounts: control types for the Pakistani tax accounts of the existing chart
// (income tax withheld by customers, income tax withheld from vendors, SRB withholding). Each is one account per company.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING'];
const ALL = [...SINGLE, 'CASH', 'BANK'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q('ALTER TABLE accounts ALTER COLUMN "controlType" TYPE varchar(24)'); // the new names are longer than 12
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list(ALL)}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const added = "('INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING')";
      await q(`UPDATE accounts SET "controlType" = NULL WHERE "controlType" IN ${added}`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q('ALTER TABLE accounts ALTER COLUMN "controlType" TYPE varchar(12)');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN ('CUSTOMERS', 'SUPPLIERS', 'CASH', 'BANK', 'INPUT_TAX', 'OUTPUT_TAX'))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN ('CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX')`);
    });
  },
};
