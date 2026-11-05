'use strict';
// Chart of Accounts (owner 2026-10-24), accounting module chunk 1. Only the list of accounts: no journal, no ledger, no default accounts yet.
//   - table accounts: one tree per company (parentId), group accounts (headers) and posting accounts.
//   - new service ACC_COA (tab ACCOUNTS); the super admin gives it to a company, the client admin to employees.
// Money columns are numeric (never float).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, bind) => queryInterface.sequelize.query(sql, { transaction, bind });

      await q(`
        CREATE TABLE accounts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
          code varchar(20) NOT NULL,
          name varchar(150) NOT NULL,
          "parentId" uuid REFERENCES accounts (id),
          "isGroup" boolean NOT NULL DEFAULT false,
          "accountType" varchar(10) NOT NULL CHECK ("accountType" IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
          "normalBalance" varchar(6) NOT NULL CHECK ("normalBalance" IN ('DEBIT', 'CREDIT')),
          "subType" varchar(30),
          "controlType" varchar(12) CHECK ("controlType" IN ('CUSTOMERS', 'SUPPLIERS', 'CASH', 'BANK', 'INPUT_TAX', 'OUTPUT_TAX')),
          "isActive" boolean NOT NULL DEFAULT true,
          "openingBalance" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("openingBalance" >= 0),
          "openingSide" varchar(6) NOT NULL CHECK ("openingSide" IN ('DEBIT', 'CREDIT')),
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT accounts_not_self_parent CHECK ("parentId" IS NULL OR "parentId" <> id),
          CONSTRAINT accounts_group_is_empty CHECK (NOT "isGroup" OR ("openingBalance" = 0 AND "controlType" IS NULL))
        )`);
      await q('CREATE UNIQUE INDEX accounts_company_code_unique ON accounts ("companyId", code)');
      await q('CREATE INDEX accounts_parent ON accounts ("parentId")');
      // one account only for these (later the engine posts invoices to it); several cash and bank accounts are normal
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType")
               WHERE "controlType" IN ('CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX')`);

      // new tab ACCOUNTS in services.menuGroup (the check was created without a name by an older migration)
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN ('PRODUCTION', 'PROCESS', 'STORE', 'REPORTS', 'ACCOUNTS'))`);
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'ACC_COA', 'Chart of Accounts', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_COA')`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_COA')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_COA'`);
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN ('PRODUCTION', 'PROCESS', 'STORE', 'REPORTS'))`);
      await q('DROP TABLE accounts');
    });
  },
};
