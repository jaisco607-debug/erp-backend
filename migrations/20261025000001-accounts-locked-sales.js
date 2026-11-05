'use strict';
// Chart of Accounts: default accounts (owner 2026-10-24).
//   - accounts."isLocked": an account made by the system (Sales, Sales Tax - Output, Accounts Receivable ...). It cannot be deleted
//     or switched off, and its type / group flag / control type cannot change; its name and code can.
//   - control type SALES (the income account sales invoices post to). One per company.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES'];
const ALL = [...SINGLE, 'CASH', 'BANK'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts ADD COLUMN "isLocked" boolean NOT NULL DEFAULT false');
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list(ALL)}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const old = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING'];
      await q(`UPDATE accounts SET "controlType" = NULL WHERE "controlType" = 'SALES'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...old, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(old)})`);
      await q('ALTER TABLE accounts DROP COLUMN "isLocked"');
    });
  },
};
