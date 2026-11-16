'use strict';
// Weaving step 6 (owner 2026-11-16): Yarn Outward > Sale. Purchased yarn is sold as it is (no process): a delivery challan + gate pass, and a SALES INVOICE in the accounts.
//   yarn_outwards (type SALE)   the challan: customerId = who buys; each line has the selling rate per lb and its amount (yarn_outward_lines.ratePerLb / amount).
//   sales_invoices.kind         'CLOTH' (every invoice that exists: made of gate passes) or 'YARN' (made by a yarn sale). The cloth Sales Invoice screen shows CLOTH only;
//                               receipts, contra, party ledger, aging, trial balance and the accounting overview use ALL invoices, so a yarn invoice is paid and reported like any other.
//   sales_invoices.yarnOutwardId  the sale challan of a YARN invoice (one invoice per sale).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("ALTER TABLE sales_invoices ADD COLUMN kind varchar(8) NOT NULL DEFAULT 'CLOTH' CHECK (kind IN ('CLOTH', 'YARN'))");
      await q('ALTER TABLE sales_invoices ADD COLUMN "yarnOutwardId" uuid REFERENCES yarn_outwards(id)');
      await q('CREATE UNIQUE INDEX sales_invoices_yarn_outward ON sales_invoices ("yarnOutwardId") WHERE "yarnOutwardId" IS NOT NULL');
      await q('ALTER TABLE yarn_outward_lines ADD COLUMN "ratePerLb" numeric(14,4)');
      await q('ALTER TABLE yarn_outward_lines ADD COLUMN amount numeric(16,2)');
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_return_party');
      await q(`ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_party_rule CHECK (
        (type <> 'RETURN' OR (("customerId" IS NULL) <> ("vendorId" IS NULL)))
        AND (type <> 'SALE' OR ("customerId" IS NOT NULL AND "vendorId" IS NULL)))`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`DELETE FROM sales_invoices WHERE kind = 'YARN'`);
      await q("DELETE FROM yarn_outwards WHERE type = 'SALE'");
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_party_rule');
      await q(`ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_return_party CHECK (type <> 'RETURN' OR (("customerId" IS NULL) <> ("vendorId" IS NULL)))`);
      await q('ALTER TABLE yarn_outward_lines DROP COLUMN amount');
      await q('ALTER TABLE yarn_outward_lines DROP COLUMN "ratePerLb"');
      await q('DROP INDEX sales_invoices_yarn_outward');
      await q('ALTER TABLE sales_invoices DROP COLUMN "yarnOutwardId"');
      await q('ALTER TABLE sales_invoices DROP COLUMN kind');
    });
  },
};
