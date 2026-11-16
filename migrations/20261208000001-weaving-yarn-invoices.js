'use strict';
// Weaving step 6b (owner 2026-11-17): the invoices of the yarn are made in the ACCOUNTS (Sales Invoice / Purchase Invoice), not in the weaving screens.
//   A YARN sales invoice is made of yarn SALE challans of one customer (like a cloth invoice is made of gate passes):
//     sales_invoice_yarn_sales      invoiceId, outwardId (UNIQUE: a sale is on one invoice only), amount (what the sale cost the customer when the invoice was saved)
//   A YARN purchase invoice is made of the purchase yarn inward entries of one vendor (like a store invoice is made of store inwards):
//     purchase_invoices.kind        'STORE' (every invoice that exists) or 'YARN'
//     purchase_invoice_yarn_inwards invoiceId, inwardId (UNIQUE), amount, salesTax
//   sales_invoices.yarnOutwardId (made in the first version of the yarn sale) is replaced by sales_invoice_yarn_sales.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE sales_invoice_yarn_sales (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "outwardId" uuid NOT NULL UNIQUE REFERENCES yarn_outwards(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX sales_invoice_yarn_sales_invoice ON sales_invoice_yarn_sales ("invoiceId")');
      await q(`INSERT INTO sales_invoice_yarn_sales ("invoiceId", "companyId", "lineNo", "outwardId", amount)
        SELECT i.id, i."companyId", 1, i."yarnOutwardId", i."grossAmount" FROM sales_invoices i WHERE i."yarnOutwardId" IS NOT NULL`);
      await q('DROP INDEX IF EXISTS sales_invoices_yarn_outward');
      await q('ALTER TABLE sales_invoices DROP COLUMN "yarnOutwardId"');

      await q("ALTER TABLE purchase_invoices ADD COLUMN kind varchar(8) NOT NULL DEFAULT 'STORE' CHECK (kind IN ('STORE', 'YARN'))");
      await q(`CREATE TABLE purchase_invoice_yarn_inwards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "inwardId" uuid NOT NULL UNIQUE REFERENCES yarn_inwards(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_invoice_yarn_inwards_invoice ON purchase_invoice_yarn_inwards ("invoiceId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM purchase_invoices WHERE kind = 'YARN'");
      await q('DROP TABLE purchase_invoice_yarn_inwards');
      await q('ALTER TABLE purchase_invoices DROP COLUMN kind');
      await q('ALTER TABLE sales_invoices ADD COLUMN "yarnOutwardId" uuid REFERENCES yarn_outwards(id)');
      await q('CREATE UNIQUE INDEX sales_invoices_yarn_outward ON sales_invoices ("yarnOutwardId") WHERE "yarnOutwardId" IS NOT NULL');
      await q(`DELETE FROM sales_invoices WHERE kind = 'YARN'`);
      await q('DROP TABLE sales_invoice_yarn_sales');
    });
  },
};
