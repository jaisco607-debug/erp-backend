'use strict';
// Contra voucher (owner 2026-10-28): a customer's money applied straight to a supplier's bill, no cash or bank account involved.
//   contra_vouchers        one voucher: a customer, a vendor, one amount
//   contra_voucher_lines   the invoices of the customer (side INVOICE) and the bills of the vendor (side BILL) the amount is applied to;
//                          each side adds up to the voucher amount (checked by the service and by the Trial Balance)
// Service ACC_CONTRA (module, ACCOUNTS tab).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE contra_vouchers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "voucherDate" date NOT NULL,
          "customerId" uuid NOT NULL REFERENCES customers (id),
          "vendorId" uuid NOT NULL REFERENCES vendors (id),
          amount numeric(18,2) NOT NULL CHECK (amount > 0),
          reference varchar(60),
          narration varchar(300),
          status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
          "confirmedAt" timestamptz,
          "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "voucherNo")
        )`);
      await q('CREATE INDEX contra_vouchers_customer ON contra_vouchers ("companyId", "customerId")');
      await q('CREATE INDEX contra_vouchers_vendor ON contra_vouchers ("companyId", "vendorId")');
      await q('CREATE INDEX contra_vouchers_date ON contra_vouchers ("companyId", "voucherDate")');
      await q(`
        CREATE TABLE contra_voucher_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "voucherId" uuid NOT NULL REFERENCES contra_vouchers (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          side varchar(7) NOT NULL CHECK (side IN ('INVOICE', 'BILL')),
          "salesInvoiceId" uuid REFERENCES sales_invoices (id),
          "purchaseInvoiceId" uuid REFERENCES purchase_invoices (id),
          amount numeric(18,2) NOT NULL CHECK (amount > 0),
          CONSTRAINT contra_voucher_lines_side_has_document CHECK (
            (side = 'INVOICE' AND "salesInvoiceId" IS NOT NULL AND "purchaseInvoiceId" IS NULL)
            OR (side = 'BILL' AND "purchaseInvoiceId" IS NOT NULL AND "salesInvoiceId" IS NULL)),
          UNIQUE ("voucherId", "lineNo")
        )`);
      await q('CREATE UNIQUE INDEX contra_voucher_lines_one_per_invoice ON contra_voucher_lines ("voucherId", "salesInvoiceId") WHERE "salesInvoiceId" IS NOT NULL');
      await q('CREATE UNIQUE INDEX contra_voucher_lines_one_per_bill ON contra_voucher_lines ("voucherId", "purchaseInvoiceId") WHERE "purchaseInvoiceId" IS NOT NULL');
      await q('CREATE INDEX contra_voucher_lines_sales ON contra_voucher_lines ("salesInvoiceId")');
      await q('CREATE INDEX contra_voucher_lines_purchase ON contra_voucher_lines ("purchaseInvoiceId")');
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'ACC_CONTRA', 'Contra (Direct Settlement)', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_CONTRA')`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_CONTRA')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_CONTRA'`);
      await q('DROP TABLE IF EXISTS contra_voucher_lines');
      await q('DROP TABLE IF EXISTS contra_vouchers');
    });
  },
};
