'use strict';
// EOBI contribution lists (owner 2026-11-06), chunk 11 of the Payroll module (Reports > Employees Contribution) and the EOBI Contribution Voucher of the accounting module.
//   eobi_providers   the EOBI registrations the company pays through (a name and a code); eobi_locations their offices / branch codes: a voucher is made per location.
//   eobi_rates       the fixed EOBI amounts: the wage, the employer % and the employee % of it, from a month until the next rate. Every listed employee pays the same amounts.
//   eobi_lists       one list per provider and month: the employees the government asked the company to pay EOBI for (not necessarily all of them).
//   eobi_list_rows   an employee on a list with his location and the amounts (employer share, employee share); an employee is on ONE list a month.
//   eobi_vouchers    the money paid to EOBI for one location of a list (Debit EOBI Payable = the employee shares withheld, Debit EOBI Employer Contribution, Credit Bank / Cash).
//   accounts         new default account role EOBI_EMPLOYER_EXPENSE.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS',
  'SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;
const stamps = '"createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'EOBI_EMPLOYER_EXPENSE', 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list([...SINGLE, 'EOBI_EMPLOYER_EXPENSE'])})`);

      await q(`CREATE TABLE eobi_providers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        name varchar(120) NOT NULL,
        code varchar(30),
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX eobi_providers_name ON eobi_providers ("companyId", lower(name))');
      await q(`CREATE TABLE eobi_locations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "providerId" uuid NOT NULL REFERENCES eobi_providers (id),
        name varchar(120) NOT NULL,
        code varchar(30),
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX eobi_locations_name ON eobi_locations ("providerId", lower(name))');
      await q(`CREATE TABLE eobi_rates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        wage numeric(12,2) NOT NULL CHECK (wage > 0),
        "employerPercent" numeric(6,3) NOT NULL CHECK ("employerPercent" >= 0 AND "employerPercent" <= 100),
        "employeePercent" numeric(6,3) NOT NULL CHECK ("employeePercent" >= 0 AND "employeePercent" <= 100),
        ${stamps},
        UNIQUE ("companyId", month))`);
      await q(`CREATE TABLE eobi_lists (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "providerId" uuid NOT NULL REFERENCES eobi_providers (id),
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ${stamps},
        UNIQUE ("providerId", month))`);
      await q(`CREATE TABLE eobi_list_rows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "listId" uuid NOT NULL REFERENCES eobi_lists (id) ON DELETE CASCADE,
        month date NOT NULL,
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "locationId" uuid REFERENCES eobi_locations (id),
        wage numeric(12,2) NOT NULL DEFAULT 0,
        "employerAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("employerAmount" >= 0),
        "employeeAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("employeeAmount" >= 0),
        source varchar(8) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'COPY', 'EXCEL')),
        ${stamps},
        UNIQUE ("listId", "employeeId"),
        UNIQUE ("companyId", "employeeId", month))`);
      await q('CREATE INDEX eobi_list_rows_location ON eobi_list_rows ("listId", "locationId")');
      await q(`CREATE TABLE eobi_vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherNo" integer NOT NULL,
        "voucherDate" date NOT NULL,
        "providerId" uuid NOT NULL REFERENCES eobi_providers (id),
        "locationId" uuid NOT NULL REFERENCES eobi_locations (id),
        month date NOT NULL,
        "payFromAccountId" uuid NOT NULL REFERENCES accounts (id),
        "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
        "chequeDate" date,
        "chequeNo" varchar(40),
        "refNo" varchar(40),
        notes varchar(300),
        employees integer NOT NULL DEFAULT 0,
        "employerAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "employeeAmount" numeric(14,2) NOT NULL DEFAULT 0,
        amount numeric(14,2) NOT NULL DEFAULT 0,
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "confirmedAt" timestamptz,
        "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ${stamps},
        UNIQUE ("companyId", "voucherNo"),
        UNIQUE ("providerId", "locationId", month))`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS eobi_vouchers, eobi_list_rows, eobi_lists, eobi_rates, eobi_locations, eobi_providers');
      await q(`UPDATE accounts SET "controlType" = NULL, "systemKey" = NULL WHERE "controlType" = 'EOBI_EMPLOYER_EXPENSE'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
};
