'use strict';
// Employee loans (owner 2026-11-03), chunk 8 of the Payroll module and the Employee Loan Voucher of the accounting module.
//   accounts                 new control type EMPLOYEE_LOANS (asset, one per company): what employees owe the company for loans paid to them. A default account.
//   payroll_loans            the loan application: DRAFT -> IN_REVIEW -> APPROVED / REJECTED (reviewer = client admin or a chosen approver), the amount, the number of
//                            monthly instalments (1 to 12) and the month the deduction starts. The instalment schedule is worked out from these three.
//   payroll_loan_deductions  what the payroll took from the salaries against the loan (written by the payroll run, which is not built yet).
//   employee_loan_vouchers   the money paid out to the employee (Debit Employee Loans, Credit Bank / Cash). DRAFT -> CONFIRMED posts a journal entry; a loan can be paid by
//                            more than one voucher. The loan's balance = confirmed vouchers less the deductions.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS'];
const OLD_SINGLE = SINGLE.filter((c) => c !== 'EMPLOYEE_LOANS');
const list = (a) => a.map((c) => `'${c}'`).join(', ');
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);

      await q(`CREATE TABLE payroll_loans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "applicationDate" date NOT NULL,
        "appliedAmount" numeric(14,2) NOT NULL CHECK ("appliedAmount" > 0),
        "approvedAmount" numeric(14,2) CHECK ("approvedAmount" IS NULL OR "approvedAmount" > 0),
        months smallint NOT NULL CHECK (months BETWEEN 1 AND 12),
        "deductFrom" date NOT NULL CHECK (EXTRACT(DAY FROM "deductFrom") = 1),
        remarks varchar(500),
        "salaryAtApproval" numeric(12,2),
        "submittedAt" timestamptz,
        "submittedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "approvedAt" timestamptz,
        "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "rejectedAt" timestamptz,
        "rejectedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "rejectReason" varchar(500),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", code))`);
      await q(`CREATE UNIQUE INDEX payroll_loans_one_open ON payroll_loans ("employeeId") WHERE status IN ('DRAFT', 'IN_REVIEW')`);
      await q('CREATE INDEX payroll_loans_status ON payroll_loans ("companyId", status)');
      await q('CREATE INDEX payroll_loans_employee ON payroll_loans ("employeeId")');

      await q(`CREATE TABLE payroll_loan_deductions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "loanId" uuid NOT NULL REFERENCES payroll_loans (id),
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        source varchar(10) NOT NULL DEFAULT 'PAYROLL' CHECK (source IN ('PAYROLL', 'MANUAL')),
        "payrollId" uuid,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now())`);
      await q('CREATE INDEX payroll_loan_deductions_loan ON payroll_loan_deductions ("loanId", month)');

      await q(`CREATE TABLE employee_loan_vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherNo" integer NOT NULL,
        "voucherDate" date NOT NULL,
        "loanId" uuid NOT NULL REFERENCES payroll_loans (id),
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
      await q('CREATE INDEX employee_loan_vouchers_loan ON employee_loan_vouchers ("loanId")');
      await q('CREATE INDEX employee_loan_vouchers_date ON employee_loan_vouchers ("companyId", "voucherDate")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS employee_loan_vouchers, payroll_loan_deductions');
      await q(`DELETE FROM payroll_files WHERE "ownerType" = 'LOAN'`);
      await q('DROP TABLE IF EXISTS payroll_loans');
      await q(`UPDATE accounts SET "controlType" = NULL, "systemKey" = NULL WHERE "controlType" = 'EMPLOYEE_LOANS'`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...OLD_SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(OLD_SINGLE)})`);
    });
  },
};
