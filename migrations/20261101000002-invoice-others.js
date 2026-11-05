'use strict';
// "Others" on the invoices (owner 2026-10-28): an extra amount with a note, entered on the invoice.
//   purchase invoice  others REDUCES the bill (goods damaged / short: the vendor takes less)   net = gross + tax - others
//   sales invoice     others INCREASES the bill (an extra charge for the customer)             net = gross + tax + others
// The tax is worked out on the gross only (not on others). The accounts: others is booked on the Purchases account (credit) / the Sales account (credit).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE sales_invoices ADD COLUMN "othersAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("othersAmount" >= 0), ADD COLUMN "othersNote" varchar(300)`);
      await q(`ALTER TABLE purchase_invoices ADD COLUMN "othersAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("othersAmount" >= 0), ADD COLUMN "othersNote" varchar(300)`);
      await q('ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_net_is_gross_plus_tax');
      await q(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_net_is_gross_tax_others CHECK ("netAmount" = "grossAmount" + "taxAmount" + "othersAmount")`);
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_net_is_gross_plus_tax');
      await q(`ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_net_is_gross_tax_less_others CHECK ("netAmount" = "grossAmount" + "taxAmount" - "othersAmount")`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE sales_invoices DROP CONSTRAINT sales_invoices_net_is_gross_tax_others');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_net_is_gross_tax_less_others');
      await q('ALTER TABLE sales_invoices DROP COLUMN "othersAmount", DROP COLUMN "othersNote"');
      await q('ALTER TABLE purchase_invoices DROP COLUMN "othersAmount", DROP COLUMN "othersNote"');
      await q(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_net_is_gross_plus_tax CHECK ("netAmount" = "grossAmount" + "taxAmount")`);
      await q(`ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_net_is_gross_plus_tax CHECK ("netAmount" = "grossAmount" + "taxAmount")`);
    });
  },
};
