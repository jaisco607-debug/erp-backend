'use strict';
// Purchase Invoice (owner 2026-10-28), accounting module chunk 3: the mirror of the Sales Invoice.
//   - one invoice is for one vendor and is made of that vendor's APPROVED store inwards (chemical / general store purchases): every line is one
//     inward, with its amount and sales tax. An inward can be on one purchase invoice only.
//   - UNAPPROVED = saved, no accounting entry; APPROVED = posted: Debit Purchases, Debit Input Sales Tax, Credit Accounts Payable (service ACC_PURCHASES).
//   - a new control type PURCHASES: the expense account purchase invoices post to (the system account DEFAULT_PURCHASES).
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES'];
const ALL = [...SINGLE, 'CASH', 'BANK'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      // the control type PURCHASES; the Purchases / Cost of Goods Sold system accounts made by the templates get it
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list(ALL)}))`);
      await q(`UPDATE accounts SET "controlType" = 'PURCHASES' WHERE "systemKey" = 'DEFAULT_PURCHASES' AND "controlType" IS NULL AND NOT "isGroup"`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);

      await q(`
        CREATE TABLE purchase_invoices (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "invoiceDate" date NOT NULL,
          "dueDate" date,
          "vendorId" uuid NOT NULL REFERENCES vendors (id),
          "billNo" varchar(50),
          notes varchar(300),
          "billDetails" varchar(300),
          "grossAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("grossAmount" >= 0),
          "taxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("taxAmount" >= 0),
          "netAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("netAmount" >= 0),
          "paidAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("paidAmount" >= 0),
          status varchar(12) NOT NULL DEFAULT 'UNAPPROVED' CHECK (status IN ('UNAPPROVED', 'APPROVED')),
          "approvedAt" timestamptz,
          "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT purchase_invoices_net_is_gross_plus_tax CHECK ("netAmount" = "grossAmount" + "taxAmount"),
          CONSTRAINT purchase_invoices_paid_not_more_than_net CHECK ("paidAmount" <= "netAmount"),
          CONSTRAINT purchase_invoices_due_after_date CHECK ("dueDate" IS NULL OR "dueDate" >= "invoiceDate"),
          UNIQUE ("companyId", "voucherNo")
        )`);
      // the same bill of a vendor cannot be entered twice
      await q(`CREATE UNIQUE INDEX purchase_invoices_vendor_bill ON purchase_invoices ("companyId", "vendorId", lower("billNo")) WHERE "billNo" IS NOT NULL`);
      await q('CREATE INDEX purchase_invoices_vendor ON purchase_invoices ("companyId", "vendorId")');
      await q('CREATE INDEX purchase_invoices_date ON purchase_invoices ("companyId", "invoiceDate")');
      await q(`
        CREATE TABLE purchase_invoice_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "invoiceId" uuid NOT NULL REFERENCES purchase_invoices (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          "inwardId" uuid NOT NULL UNIQUE REFERENCES store_inwards (id),
          store varchar(10) NOT NULL,
          amount numeric(18,2) NOT NULL CHECK (amount >= 0),
          "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
          UNIQUE ("invoiceId", "lineNo")
        )`);
      await q('CREATE INDEX purchase_invoice_lines_invoice ON purchase_invoice_lines ("invoiceId")');

      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'ACC_PURCHASES', 'Purchase Invoice', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_PURCHASES')`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_PURCHASES')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_PURCHASES'`);
      await q('DROP TABLE purchase_invoice_lines');
      await q('DROP TABLE purchase_invoices');
      const old = SINGLE.filter((c) => c !== 'PURCHASES');
      await q(`UPDATE accounts SET "controlType" = NULL WHERE "controlType" = 'PURCHASES'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...old, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(old)})`);
    });
  },
};
