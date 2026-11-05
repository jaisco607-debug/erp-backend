'use strict';
// Vouchers (owner 2026-10-29), accounting module chunk 4.
//   Payment Voucher  (service ACC_PAYMENTS)  pays a vendor: bills and / or an advance, from a bank or cash account, with income tax withheld
//   Receipt Voucher  (service ACC_RECEIPTS)  receives money from a customer: invoices and / or an advance, into a bank or cash account, income tax withheld by the customer
//   Journal Voucher  (service ACC_JOURNAL)   the general journal: any debit and credit lines that balance
// Every voucher is a DRAFT (no effect on the books) until it is CONFIRMED (one journal entry is posted). Un-confirming reverses the entry.
// New control types: CUSTOMER_ADVANCES (liability) and SUPPLIER_ADVANCES (asset) for money paid / received before an invoice.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES'];
const ALL = [...SINGLE, 'CASH', 'BANK'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list(ALL)}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);

      // ---- payment vouchers (to a vendor)
      await q(`
        CREATE TABLE payment_vouchers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "voucherDate" date NOT NULL,
          "vendorId" uuid NOT NULL REFERENCES vendors (id),
          "payFromAccountId" uuid NOT NULL REFERENCES accounts (id),
          "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
          "chequeDate" date,
          "chequeNo" varchar(40),
          notes varchar(300),
          "taxSection" varchar(120),
          "incomeTaxRate" numeric(5,2) NOT NULL DEFAULT 0 CHECK ("incomeTaxRate" >= 0 AND "incomeTaxRate" < 100),
          "billsTotal" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("billsTotal" >= 0),
          "incomeTaxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("incomeTaxAmount" >= 0),
          "netAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("netAmount" >= 0),
          status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
          "confirmedAt" timestamptz,
          "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT payment_vouchers_net_is_bills_minus_tax CHECK ("netAmount" = "billsTotal" - "incomeTaxAmount"),
          UNIQUE ("companyId", "voucherNo")
        )`);
      await q('CREATE INDEX payment_vouchers_vendor ON payment_vouchers ("companyId", "vendorId")');
      await q('CREATE INDEX payment_vouchers_date ON payment_vouchers ("companyId", "voucherDate")');
      await q(`
        CREATE TABLE payment_voucher_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "voucherId" uuid NOT NULL REFERENCES payment_vouchers (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          kind varchar(7) NOT NULL CHECK (kind IN ('BILL', 'ADVANCE')),
          "purchaseInvoiceId" uuid REFERENCES purchase_invoices (id),
          amount numeric(18,2) NOT NULL CHECK (amount > 0),
          notes varchar(200),
          CONSTRAINT payment_voucher_lines_bill_has_invoice CHECK ((kind = 'BILL') = ("purchaseInvoiceId" IS NOT NULL)),
          UNIQUE ("voucherId", "lineNo")
        )`);
      await q('CREATE UNIQUE INDEX payment_voucher_lines_one_per_bill ON payment_voucher_lines ("voucherId", "purchaseInvoiceId") WHERE "purchaseInvoiceId" IS NOT NULL');
      await q('CREATE INDEX payment_voucher_lines_invoice ON payment_voucher_lines ("purchaseInvoiceId")');

      // ---- receipt vouchers (from a customer)
      await q(`
        CREATE TABLE receipt_vouchers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "voucherDate" date NOT NULL,
          "customerId" uuid NOT NULL REFERENCES customers (id),
          "depositAccountId" uuid NOT NULL REFERENCES accounts (id),
          "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
          "chequeDate" date,
          "chequeNo" varchar(40),
          notes varchar(300),
          "grandTotal" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("grandTotal" >= 0),
          "incomeTaxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("incomeTaxAmount" >= 0),
          "netAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("netAmount" >= 0),
          status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
          "confirmedAt" timestamptz,
          "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT receipt_vouchers_total_is_cheque_plus_tax CHECK ("grandTotal" = "netAmount" + "incomeTaxAmount"),
          UNIQUE ("companyId", "voucherNo")
        )`);
      await q('CREATE INDEX receipt_vouchers_customer ON receipt_vouchers ("companyId", "customerId")');
      await q('CREATE INDEX receipt_vouchers_date ON receipt_vouchers ("companyId", "voucherDate")');
      await q(`
        CREATE TABLE receipt_voucher_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "voucherId" uuid NOT NULL REFERENCES receipt_vouchers (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          kind varchar(7) NOT NULL CHECK (kind IN ('BILL', 'ADVANCE')),
          "salesInvoiceId" uuid REFERENCES sales_invoices (id),
          "chequeAmount" numeric(18,2) NOT NULL CHECK ("chequeAmount" > 0),
          "incomeTaxRate" numeric(5,2) NOT NULL DEFAULT 0 CHECK ("incomeTaxRate" >= 0 AND "incomeTaxRate" < 100),
          "incomeTaxAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("incomeTaxAmount" >= 0),
          "billAmount" numeric(18,2) NOT NULL CHECK ("billAmount" > 0),
          notes varchar(200),
          CONSTRAINT receipt_voucher_lines_bill_is_cheque_plus_tax CHECK ("billAmount" = "chequeAmount" + "incomeTaxAmount"),
          CONSTRAINT receipt_voucher_lines_bill_has_invoice CHECK ((kind = 'BILL') = ("salesInvoiceId" IS NOT NULL)),
          UNIQUE ("voucherId", "lineNo")
        )`);
      await q('CREATE UNIQUE INDEX receipt_voucher_lines_one_per_invoice ON receipt_voucher_lines ("voucherId", "salesInvoiceId") WHERE "salesInvoiceId" IS NOT NULL');
      await q('CREATE INDEX receipt_voucher_lines_invoice ON receipt_voucher_lines ("salesInvoiceId")');

      // ---- journal vouchers (general)
      await q(`
        CREATE TABLE journal_vouchers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "voucherNo" integer NOT NULL,
          "voucherDate" date NOT NULL,
          reference varchar(60),
          narration varchar(300),
          "totalAmount" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("totalAmount" >= 0),
          status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
          "confirmedAt" timestamptz,
          "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "voucherNo")
        )`);
      await q('CREATE INDEX journal_vouchers_date ON journal_vouchers ("companyId", "voucherDate")');
      await q(`
        CREATE TABLE journal_voucher_lines (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "voucherId" uuid NOT NULL REFERENCES journal_vouchers (id) ON DELETE CASCADE,
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "lineNo" integer NOT NULL,
          "accountId" uuid NOT NULL REFERENCES accounts (id),
          debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
          credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
          narration varchar(200),
          "partyType" varchar(10) CHECK ("partyType" IN ('CUSTOMER', 'VENDOR')),
          "partyId" uuid,
          CONSTRAINT journal_voucher_lines_one_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
          CONSTRAINT journal_voucher_lines_party_pair CHECK (("partyType" IS NULL) = ("partyId" IS NULL)),
          UNIQUE ("voucherId", "lineNo")
        )`);
      await q('CREATE INDEX journal_voucher_lines_account ON journal_voucher_lines ("accountId")');

      for (const [code, name] of [['ACC_PAYMENTS', 'Payment Voucher'], ['ACC_RECEIPTS', 'Receipt Voucher'], ['ACC_JOURNAL', 'Journal Voucher']]) {
        await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
                 SELECT gen_random_uuid(), '${code}', '${name}', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
                 WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = '${code}')`);
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code IN ('ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_JOURNAL'))`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code IN ('ACC_PAYMENTS', 'ACC_RECEIPTS', 'ACC_JOURNAL')`);
      for (const t of ['journal_voucher_lines', 'journal_vouchers', 'receipt_voucher_lines', 'receipt_vouchers', 'payment_voucher_lines', 'payment_vouchers']) await q(`DROP TABLE ${t}`);
      const old = SINGLE.filter((c) => !['CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES'].includes(c));
      await q(`UPDATE accounts SET "controlType" = NULL WHERE "controlType" IN ('CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES')`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...old, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(old)})`);
    });
  },
};
