'use strict';
// Store Management > Fabric Inward, rates and accounts (owner 2026-11-25): the cloth bought from a vendor has a RATE per meter or per yard, typed on the entry;
// every thaan gets its own amount (its length x the rate) and the entry the total. The vendor's bill is made in the Accounts as a PURCHASE invoice of a new kind FABRIC.
//   fabric_inwards.rateUnit / rate / amount   the rate and what it is per (METER or YARD); amount = the sum of the thaan amounts (empty until a rate is given)
//   fabric_inward_thaans.amount               length (meters or yards, as the rate is) x rate
//   purchase_invoices.kind                    'STORE', 'YARN', 'SIZING' or now 'FABRIC'
//   purchase_invoice_fabric_inwards           invoiceId, inwardId (UNIQUE: an entry is on one invoice only), amount, salesTax
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE fabric_inwards ADD COLUMN "rateUnit" varchar(5) CHECK ("rateUnit" IN ('METER', 'YARD'))`);
      await q('ALTER TABLE fabric_inwards ADD COLUMN rate numeric(14,4)');
      await q('ALTER TABLE fabric_inwards ADD COLUMN amount numeric(16,2)');
      await q('ALTER TABLE fabric_inward_thaans ADD COLUMN amount numeric(16,2)');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING', 'FABRIC'))");
      await q(`CREATE TABLE purchase_invoice_fabric_inwards (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "inwardId" uuid NOT NULL UNIQUE REFERENCES fabric_inwards(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_invoice_fabric_inwards_invoice ON purchase_invoice_fabric_inwards ("invoiceId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM purchase_invoices WHERE kind = 'FABRIC'");
      await q('DROP TABLE purchase_invoice_fabric_inwards');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING'))");
      await q('ALTER TABLE fabric_inward_thaans DROP COLUMN amount');
      await q('ALTER TABLE fabric_inwards DROP COLUMN amount');
      await q('ALTER TABLE fabric_inwards DROP COLUMN rate');
      await q('ALTER TABLE fabric_inwards DROP COLUMN "rateUnit"');
    });
  },
};
