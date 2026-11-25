'use strict';
// Purchase Return Invoice (debit note) for goods sent back to a vendor.
//   store_vendor_returns        + gatePassNo, challanNo (numbers we give when the goods leave), vehicleNo, driverName
//   purchase_returns / _lines   the return invoice: ONE vendor, ONE original purchase invoice, made of the vendor returns (stock sent back)
//                               UNAPPROVED = saved, no entry; APPROVED = posted: Debit Accounts Payable, Credit Purchases, Credit Input Sales Tax
//   purchase_invoices.returnedAmount  how much of the bill was cancelled by approved return invoices. It is part of "paidAmount" (the settled
//                               part of the bill), so every balance that works with net - paid (payment / contra vouchers, ageing, reports)
//                               already shows the smaller amount; the money really paid is paidAmount - returnedAmount.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE store_vendor_returns ADD COLUMN "gatePassNo" integer, ADD COLUMN "challanNo" integer, ADD COLUMN "vehicleNo" varchar(30), ADD COLUMN "driverName" varchar(60)`);
      await q(`CREATE UNIQUE INDEX store_vendor_returns_gate_pass ON store_vendor_returns ("companyId", store, "gatePassNo") WHERE "gatePassNo" IS NOT NULL`);
      await q(`CREATE UNIQUE INDEX store_vendor_returns_challan ON store_vendor_returns ("companyId", store, "challanNo") WHERE "challanNo" IS NOT NULL`);

      await q(`ALTER TABLE purchase_invoices ADD COLUMN "returnedAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("returnedAmount" >= 0)`);
      await q(`ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_returned_within_paid CHECK ("returnedAmount" <= "paidAmount")`);

      await q(`
        CREATE TABLE purchase_returns (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "returnDate" date NOT NULL,
          "vendorId" uuid NOT NULL REFERENCES vendors (id),
          "purchaseInvoiceId" uuid NOT NULL REFERENCES purchase_invoices (id),
          notes varchar(300),
          "grossAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("grossAmount" >= 0),
          "taxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("taxAmount" >= 0),
          "netAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("netAmount" >= 0),
          "appliedAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("appliedAmount" >= 0),
          status varchar(12) NOT NULL DEFAULT 'UNAPPROVED' CHECK (status IN ('UNAPPROVED', 'APPROVED')),
          "approvedAt" timestamptz,
          "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT purchase_returns_net_is_gross_plus_tax CHECK ("netAmount" = "grossAmount" + "taxAmount"),
          CONSTRAINT purchase_returns_applied_within_net CHECK ("appliedAmount" <= "netAmount"),
          UNIQUE ("companyId", "voucherNo")
        )`);
      await q('CREATE INDEX purchase_returns_vendor ON purchase_returns ("companyId", "vendorId")');
      await q('CREATE INDEX purchase_returns_invoice ON purchase_returns ("purchaseInvoiceId")');
      await q(`
        CREATE TABLE purchase_return_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "returnInvoiceId" uuid NOT NULL REFERENCES purchase_returns (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          "vendorReturnId" uuid NOT NULL REFERENCES store_vendor_returns (id),
          "vendorReturnLineId" uuid NOT NULL UNIQUE REFERENCES store_vendor_return_lines (id),
          amount numeric(18,2) NOT NULL CHECK (amount >= 0),
          "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
          UNIQUE ("returnInvoiceId", "lineNo")
        )`);
      await q('CREATE INDEX purchase_return_lines_invoice ON purchase_return_lines ("returnInvoiceId")');
      await q('CREATE INDEX purchase_return_lines_vendor_return ON purchase_return_lines ("vendorReturnId")');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE purchase_return_lines');
      await q('DROP TABLE purchase_returns');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_returned_within_paid');
      await q('ALTER TABLE purchase_invoices DROP COLUMN "returnedAmount"');
      await q('DROP INDEX store_vendor_returns_challan');
      await q('DROP INDEX store_vendor_returns_gate_pass');
      await q('ALTER TABLE store_vendor_returns DROP COLUMN "driverName", DROP COLUMN "vehicleNo", DROP COLUMN "challanNo", DROP COLUMN "gatePassNo"');
    });
  },
};
