'use strict';
// Sales Invoice (owner 2026-10-24), accounting module chunk 2.
//   - one invoice is for one customer (billed to) and is made of GATE PASSES: every line is one gate pass, whose packing list
//     gives the quantities of A / B / CP, the rates and the amount. A gate pass can be on one invoice only.
//   - UNAPPROVED = saved but no accounting entry; APPROVED = the journal entry is posted (service ACC_SALES).
//   - net = gross + tax is also checked by the database.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, bind) => queryInterface.sequelize.query(sql, { transaction, bind });
      await q(`
        CREATE TABLE sales_invoices (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "invoiceNo" integer NOT NULL,
          "invoiceDate" date NOT NULL,
          "customerId" uuid NOT NULL REFERENCES customers (id),
          notes varchar(300),
          "invoiceDetails" varchar(300),
          "hsCode" varchar(20),
          "taxRate" numeric(5,2) NOT NULL DEFAULT 18 CHECK ("taxRate" >= 0 AND "taxRate" <= 100),
          "grossAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("grossAmount" >= 0),
          "taxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("taxAmount" >= 0),
          "netAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("netAmount" >= 0),
          "receivedAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("receivedAmount" >= 0),
          status varchar(12) NOT NULL DEFAULT 'UNAPPROVED' CHECK (status IN ('UNAPPROVED', 'APPROVED')),
          "approvedAt" timestamptz,
          "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT sales_invoices_net_is_gross_plus_tax CHECK ("netAmount" = "grossAmount" + "taxAmount"),
          CONSTRAINT sales_invoices_received_not_more_than_net CHECK ("receivedAmount" <= "netAmount"),
          UNIQUE ("companyId", "voucherNo"),
          UNIQUE ("companyId", "invoiceNo")
        )`);
      await q('CREATE INDEX sales_invoices_customer ON sales_invoices ("companyId", "customerId")');
      await q('CREATE INDEX sales_invoices_date ON sales_invoices ("companyId", "invoiceDate")');
      await q(`
        CREATE TABLE sales_invoice_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "invoiceId" uuid NOT NULL REFERENCES sales_invoices (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          "gatePassId" uuid NOT NULL UNIQUE REFERENCES gate_passes (id),
          "packingListId" uuid NOT NULL REFERENCES packing_lists (id),
          "qtyA" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("qtyA" >= 0),
          "qtyB" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("qtyB" >= 0),
          "qtyCP" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("qtyCP" >= 0),
          "rateA" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateA" >= 0),
          "rateB" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateB" >= 0),
          "rateCP" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateCP" >= 0),
          "billedQty" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("billedQty" >= 0),
          amount numeric(18,2) NOT NULL CHECK (amount >= 0),
          UNIQUE ("invoiceId", "lineNo")
        )`);
      await q('CREATE INDEX sales_invoice_lines_invoice ON sales_invoice_lines ("invoiceId")');

      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'ACC_SALES', 'Sales Invoice', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_SALES')`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_SALES')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_SALES'`);
      await q('DROP TABLE sales_invoice_lines');
      await q('DROP TABLE sales_invoices');
    });
  },
};
