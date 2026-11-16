'use strict';
// Store Yarn Inward in the ACCOUNTS (owner 2026-11-30): the yarn bought from a vendor (Store > Yarn Inward) is billed on a PURCHASE invoice made in the accounts from the vendor's
// approved yarn inwards, exactly like the chemical / fabric purchase invoice (Debit Purchases + Input Sales Tax, Credit Accounts Payable with the vendor named).
//   purchase_invoices.kind                    'STORE', 'YARN' (weaving), 'SIZING', 'FABRIC' or now 'STORE_YARN'
//   purchase_invoice_store_yarn_inwards       invoiceId, inwardId (UNIQUE: an entry is on one invoice only), amount, salesTax
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_kind_check');
      await q('ALTER TABLE purchase_invoices ALTER COLUMN kind TYPE varchar(12)');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING', 'FABRIC', 'STORE_YARN'))");
      await q(`CREATE TABLE purchase_invoice_store_yarn_inwards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "inwardId" uuid NOT NULL UNIQUE REFERENCES store_yarn_inwards(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_invoice_store_yarn_inwards_invoice ON purchase_invoice_store_yarn_inwards ("invoiceId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM purchase_invoices WHERE kind = 'STORE_YARN'");
      await q('DROP TABLE purchase_invoice_store_yarn_inwards');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING', 'FABRIC'))");
    });
  },
};
