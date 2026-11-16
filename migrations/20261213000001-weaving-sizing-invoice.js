'use strict';
// Weaving step 11 (owner 2026-11-21): the sizing charge in the ACCOUNTS. What the sizing party (our vendor) charges for the sizing (lbs used x rate, on every sizing receipt) is billed on a
// PURCHASE invoice made in the accounts from the vendor's sizing receipts (like the yarn purchase invoice):
//   purchase_invoices.kind                'STORE', 'YARN' or now 'SIZING'
//   purchase_invoice_sizing_inwards       invoiceId, inwardId (UNIQUE: a receipt is on one invoice only), amount, salesTax
//   accounts                              new default account role SIZING_CHARGES (expense, "Sizing Charges", in Cost of Sales): the account a sizing invoice debits.
//                                         It is made on the first sizing invoice if the company has none (Chart of Accounts, trial balance and ledgers show it like the other defaults).
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS',
  'SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS', 'EOBI_EMPLOYER_EXPENSE', 'EMPLOYEE_ADVANCES'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'SIZING_CHARGES', 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list([...SINGLE, 'SIZING_CHARGES'])})`);

      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING'))");
      await q(`CREATE TABLE purchase_invoice_sizing_inwards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "inwardId" uuid NOT NULL UNIQUE REFERENCES yarn_sizing_inwards(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_invoice_sizing_inwards_invoice ON purchase_invoice_sizing_inwards ("invoiceId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM purchase_invoices WHERE kind = 'SIZING'");
      await q('DROP TABLE purchase_invoice_sizing_inwards');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN'))");
      await q(`UPDATE accounts SET "controlType" = NULL, "systemKey" = NULL WHERE "controlType" = 'SIZING_CHARGES'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
};
