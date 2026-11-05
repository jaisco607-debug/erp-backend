'use strict';
// Employee advance (owner 2026-11-14), chunk 15 of the Payroll module (Applications > Advance). No approval: HR writes down what the employee asked for (5,000 ...), the accountant pays it with an
// Advance voucher, and the next payroll takes the whole amount from the salary.
//   payroll_advances          one advance of an employee: the date, the amount, the remarks. It is "paid out" when a confirmed voucher exists and "recovered" when the payroll took it.
//   employee_advance_vouchers the money paid out for an advance (Debit Employee Advances, Credit Bank / Cash). DRAFT -> CONFIRMED posts a journal entry.
//   payroll_slip_advances     the advances a payslip takes (what was due, what is taken).
//   payroll_advance_deductions what the payroll took (written when the payslip is approved).
//   payroll_slips."advanceAmount"  the advance deduction of a payslip (part of its deductions).
//   accounts                  new default account role EMPLOYEE_ADVANCES (asset): what employees owe us for advances.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS',
  'SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS', 'EOBI_EMPLOYER_EXPENSE'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'EMPLOYEE_ADVANCES', 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list([...SINGLE, 'EMPLOYEE_ADVANCES'])})`);

      await q(`CREATE TABLE payroll_advances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "advanceDate" date NOT NULL,
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        remarks varchar(300),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", code))`);
      await q('CREATE INDEX payroll_advances_employee ON payroll_advances ("employeeId", "advanceDate")');

      await q(`CREATE TABLE employee_advance_vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherNo" integer NOT NULL,
        "voucherDate" date NOT NULL,
        "advanceId" uuid NOT NULL REFERENCES payroll_advances (id),
        "payFromAccountId" uuid NOT NULL REFERENCES accounts (id),
        "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
        "chequeDate" date,
        "chequeNo" varchar(40),
        "refNo" varchar(40),
        notes varchar(300),
        amount numeric(18,2) NOT NULL CHECK (amount > 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "confirmedAt" timestamptz,
        "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "voucherNo"))`);
      await q('CREATE INDEX employee_advance_vouchers_advance ON employee_advance_vouchers ("advanceId")');
      await q('CREATE INDEX employee_advance_vouchers_date ON employee_advance_vouchers ("companyId", "voucherDate")');

      await q(`CREATE TABLE payroll_advance_deductions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "advanceId" uuid NOT NULL REFERENCES payroll_advances (id),
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        "payrollId" uuid,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now())`);
      await q('CREATE INDEX payroll_advance_deductions_advance ON payroll_advance_deductions ("advanceId")');
      await q('CREATE INDEX payroll_advance_deductions_slip ON payroll_advance_deductions ("payrollId")');

      await q(`CREATE TABLE payroll_slip_advances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slipId" uuid NOT NULL REFERENCES payroll_slips (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "advanceId" uuid NOT NULL REFERENCES payroll_advances (id),
        due numeric(14,2) NOT NULL DEFAULT 0 CHECK (due >= 0),
        amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
        UNIQUE ("slipId", "advanceId"))`);
      await q('ALTER TABLE payroll_slips ADD COLUMN "advanceAmount" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("advanceAmount" >= 0)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE payroll_slips DROP COLUMN IF EXISTS "advanceAmount"');
      await q('DROP TABLE IF EXISTS payroll_slip_advances, payroll_advance_deductions, employee_advance_vouchers, payroll_advances');
      await q(`UPDATE accounts SET "controlType" = NULL, "systemKey" = NULL WHERE "controlType" = 'EMPLOYEE_ADVANCES'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
};
