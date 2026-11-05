'use strict';
// The sales tax of a purchase is chosen on the PURCHASE INVOICE (accounting), not on the store inward (owner 2026-10-28).
// taxRate = the tax % of the invoice; it is applied to the purchases on the invoice that carry no tax of their own (every new store inward has none).
// Older store inwards that still carry their own GST keep it.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE purchase_invoices ADD COLUMN "taxRate" numeric(5,2) NOT NULL DEFAULT 0 CHECK ("taxRate" >= 0 AND "taxRate" <= 100)`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE purchase_invoices DROP COLUMN "taxRate"');
  },
};
