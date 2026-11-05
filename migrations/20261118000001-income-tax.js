'use strict';
// Salary income tax (owner 2026-11-07), chunk 12 of the Payroll module.
//   payroll_income_tax                 the tax of an employee from a month on (a fixed monthly amount, or a percent of the basic): the government changes it every year and for every salary,
//                                      so it is kept as a history; a payslip uses the latest row not later than its month, and the percent of the employee card when there is none.
//   salary_tax_vouchers (+ lines)      the tax withheld from the salaries and paid to the government (Debit Salary Tax Payable, Credit Bank / Cash) against approved payslips.
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;
const stamps = '"createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_income_tax (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id) ON DELETE CASCADE,
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        "monthlyAmount" numeric(12,2) CHECK ("monthlyAmount" IS NULL OR "monthlyAmount" >= 0),
        percent numeric(5,2) CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
        source varchar(10) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'EXCEL')),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ${stamps},
        UNIQUE ("employeeId", month))`);
      await q('CREATE INDEX payroll_income_tax_company_month ON payroll_income_tax ("companyId", month)');
      await q(`CREATE TABLE salary_tax_vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherNo" integer NOT NULL,
        "voucherDate" date NOT NULL,
        month date NOT NULL,
        "payFromAccountId" uuid NOT NULL REFERENCES accounts (id),
        "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
        "chequeDate" date,
        "chequeNo" varchar(40),
        "refNo" varchar(40),
        notes varchar(300),
        employees integer NOT NULL DEFAULT 0,
        amount numeric(14,2) NOT NULL DEFAULT 0,
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "confirmedAt" timestamptz,
        "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ${stamps},
        UNIQUE ("companyId", "voucherNo"))`);
      await q(`CREATE TABLE salary_tax_voucher_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherId" uuid NOT NULL REFERENCES salary_tax_vouchers (id) ON DELETE CASCADE,
        "slipId" uuid NOT NULL REFERENCES payroll_slips (id),
        amount numeric(12,2) NOT NULL CHECK (amount > 0),
        UNIQUE ("slipId"))`);
      await q('CREATE INDEX salary_tax_voucher_lines_voucher ON salary_tax_voucher_lines ("voucherId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS salary_tax_voucher_lines, salary_tax_vouchers, payroll_income_tax');
  },
};
