'use strict';
// The payroll (owner 2026-11-05), chunk 10 of the Payroll module: the engine's runs, the payslips and their payment.
//   payroll_runs                  one payroll = one class (group) for one month ("Payroll ID 107"): the policy it was made with (a copy, so a later policy never changes it), the days of the month.
//   payroll_slips                 one employee's payslip in it: a snapshot of the employee and his salary, the inputs HR may change (additions, deductions, overtime), the result of the engine
//                                 and the status DRAFT -> REVIEW -> FINAL_REVIEW -> APPROVED (SUSPENDED = left out of this payroll for now, with a note).
//   payroll_slip_days             the month's attendance as the slip holds it: the attendance of the attendance module copied in, which HR may change on the slip ("Get attendance" copies it in again).
//   payroll_slip_loans            the loan instalments the slip takes (what was due, what is taken, the loan balance before).
//   salary_payment_vouchers (+ lines)  the money paid to the employees (Debit Salaries Payable, Credit Bank / Cash) against approved slips.
//   accounts                      new default account roles: SALARY_EXPENSE, SALARIES_PAYABLE, EOBI_PAYABLE, SALARY_TAX_PAYABLE, EMPLOYEE_DEDUCTIONS.
const SINGLE = ['CUSTOMERS', 'SUPPLIERS', 'INPUT_TAX', 'OUTPUT_TAX', 'INCOME_TAX_CUSTOMERS', 'INCOME_TAX_VENDORS', 'SRB_WITHHOLDING', 'SALES', 'PURCHASES', 'CUSTOMER_ADVANCES', 'SUPPLIER_ADVANCES', 'EMPLOYEE_LOANS'];
const NEW = ['SALARY_EXPENSE', 'SALARIES_PAYABLE', 'EOBI_PAYABLE', 'SALARY_TAX_PAYABLE', 'EMPLOYEE_DEDUCTIONS'];
const list = (a) => a.map((c) => `'${c}'`).join(', ');
const MODES = `('CASH', 'CHEQUE', 'ONLINE', 'PAY_ORDER')`;
const money = (name, extra = '') => `"${name}" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)${extra}`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, ...NEW, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list([...SINGLE, ...NEW])})`);

      await q(`CREATE TABLE payroll_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        "groupId" uuid NOT NULL REFERENCES payroll_groups (id),
        month date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
        category varchar(10) NOT NULL DEFAULT 'CAT-B',
        "daysInMonth" smallint NOT NULL CHECK ("daysInMonth" BETWEEN 28 AND 31),
        "lateLimitMinutes" integer NOT NULL CHECK ("lateLimitMinutes" >= 0 AND "lateLimitMinutes" <= 600),
        "halfDayLimitMinutes" integer NOT NULL CHECK ("halfDayLimitMinutes" >= 1 AND "halfDayLimitMinutes" <= 1440),
        "latesPerHalfDay" integer NOT NULL CHECK ("latesPerHalfDay" >= 0 AND "latesPerHalfDay" <= 31),
        "weeklyOffDay" varchar(9) CHECK ("weeklyOffDay" IN ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY')),
        "overtimeFactor" numeric(4,2) NOT NULL CHECK ("overtimeFactor" >= 0 AND "overtimeFactor" <= 10),
        "leaveEarnedPerMonth" numeric(4,2) NOT NULL CHECK ("leaveEarnedPerMonth" >= 0 AND "leaveEarnedPerMonth" <= 31),
        "maxLeavePerYear" numeric(5,2) NOT NULL CHECK ("maxLeavePerYear" >= 0 AND "maxLeavePerYear" <= 366),
        "monthsBeforeLeave" integer NOT NULL CHECK ("monthsBeforeLeave" >= 0 AND "monthsBeforeLeave" <= 120),
        "policySource" varchar(10) NOT NULL DEFAULT 'DEFAULT' CHECK ("policySource" IN ('DEFAULT', 'POLICY', 'EDITED')),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_runs_half_day_more_than_late CHECK ("halfDayLimitMinutes" > "lateLimitMinutes"),
        UNIQUE ("companyId", code),
        UNIQUE ("companyId", "groupId", month))`);

      await q(`CREATE TABLE payroll_slips (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "runId" uuid NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
        code integer NOT NULL CHECK (code > 0),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW', 'APPROVED', 'SUSPENDED')),
        "empCode" integer NOT NULL,
        "empName" varchar(150) NOT NULL,
        "departmentName" varchar(120),
        "designationName" varchar(120),
        "shiftLabel" varchar(80),
        "dutyHours" numeric(4,2) NOT NULL DEFAULT 0 CHECK ("dutyHours" >= 0 AND "dutyHours" <= 24),
        "joiningDate" date NOT NULL,
        "leavingDate" date,
        "bankName" varchar(120),
        "accountNo" varchar(40),
        "accountTitle" varchar(120),
        "paymentMethod" varchar(6) NOT NULL DEFAULT 'CASH' CHECK ("paymentMethod" IN ('BANK', 'CASH')),
        "isCash" boolean NOT NULL DEFAULT false,
        "salaryType" varchar(10) NOT NULL CHECK ("salaryType" IN ('MONTHLY', 'FIXED', 'DAILY')),
        "basicSalary" numeric(12,2) NOT NULL CHECK ("basicSalary" >= 0),
        ${money('foodAmount')}, ${money('maintenanceAmount')}, ${money('mobileAmount')}, ${money('othersAddAmount')},
        ${money('eobiAmount')}, ${money('taxAmount')}, ${money('othersDeductAmount')}, ${money('loanAmount')},
        "overtimeMinutesManual" integer CHECK ("overtimeMinutesManual" IS NULL OR "overtimeMinutesManual" >= 0),
        notes varchar(500),
        "suspendNote" varchar(500),
        "cntP" smallint NOT NULL DEFAULT 0, "cntL" smallint NOT NULL DEFAULT 0, "cntHD" smallint NOT NULL DEFAULT 0,
        "cntA" smallint NOT NULL DEFAULT 0, "cntR" smallint NOT NULL DEFAULT 0, "cntAL" smallint NOT NULL DEFAULT 0,
        "payableDays" numeric(5,1) NOT NULL DEFAULT 0,
        "lateDeductionDays" numeric(5,1) NOT NULL DEFAULT 0,
        "alPaid" numeric(5,1) NOT NULL DEFAULT 0,
        "alBalance" numeric(6,2) NOT NULL DEFAULT 0,
        "overtimeMinutes" integer NOT NULL DEFAULT 0,
        "grossAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "additionsAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "deductionsAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "contributionAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "netAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "paidAmount" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("paidAmount" >= 0),
        calc jsonb,
        "daysEdited" boolean NOT NULL DEFAULT false,
        "calculatedAt" timestamptz,
        "approvedAt" timestamptz,
        "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "suspendedAt" timestamptz,
        "suspendedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", code),
        UNIQUE ("runId", "employeeId"))`);
      await q('CREATE INDEX payroll_slips_run_status ON payroll_slips ("runId", status)');
      await q('CREATE INDEX payroll_slips_employee ON payroll_slips ("employeeId")');

      await q(`CREATE TABLE payroll_slip_days (
        "slipId" uuid NOT NULL REFERENCES payroll_slips (id) ON DELETE CASCADE,
        "dayDate" date NOT NULL,
        code varchar(2) NOT NULL CHECK (code IN ('P', 'L', 'HD', 'A', 'R', 'AL', '-')),
        "originalCode" varchar(2) CHECK ("originalCode" IS NULL OR "originalCode" IN ('P', 'L', 'HD', 'A', 'R', 'AL', '-')),
        "firstIn" timestamptz,
        "lastOut" timestamptz,
        "workedMinutes" integer NOT NULL DEFAULT 0,
        "overtimeMinutes" integer NOT NULL DEFAULT 0,
        "lateMinutes" integer NOT NULL DEFAULT 0,
        "restDay" boolean NOT NULL DEFAULT false,
        edited boolean NOT NULL DEFAULT false,
        PRIMARY KEY ("slipId", "dayDate"))`);

      await q(`CREATE TABLE payroll_slip_loans (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "slipId" uuid NOT NULL REFERENCES payroll_slips (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "loanId" uuid NOT NULL REFERENCES payroll_loans (id),
        due numeric(14,2) NOT NULL DEFAULT 0 CHECK (due >= 0),
        amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
        "balanceBefore" numeric(14,2) NOT NULL DEFAULT 0,
        UNIQUE ("slipId", "loanId"))`);

      await q(`CREATE TABLE salary_payment_vouchers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "voucherNo" integer NOT NULL,
        "voucherDate" date NOT NULL,
        "payFromAccountId" uuid NOT NULL REFERENCES accounts (id),
        "paymentMode" varchar(10) NOT NULL CHECK ("paymentMode" IN ${MODES}),
        "chequeDate" date,
        "chequeNo" varchar(40),
        "refNo" varchar(40),
        notes varchar(300),
        amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "confirmedAt" timestamptz,
        "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "voucherNo"))`);
      await q('CREATE INDEX salary_payment_vouchers_date ON salary_payment_vouchers ("companyId", "voucherDate")');
      await q(`CREATE TABLE salary_payment_voucher_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "voucherId" uuid NOT NULL REFERENCES salary_payment_vouchers (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "slipId" uuid NOT NULL REFERENCES payroll_slips (id),
        amount numeric(14,2) NOT NULL CHECK (amount > 0),
        UNIQUE ("voucherId", "slipId"))`);
      await q('CREATE INDEX salary_payment_voucher_lines_slip ON salary_payment_voucher_lines ("slipId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS salary_payment_voucher_lines, salary_payment_vouchers, payroll_slip_loans, payroll_slip_days, payroll_slips, payroll_runs');
      await q(`UPDATE accounts SET "controlType" = NULL, "systemKey" = NULL WHERE "controlType" IN (${list(NEW)})`);
      await q('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "accounts_controlType_check"');
      await q(`ALTER TABLE accounts ADD CONSTRAINT "accounts_controlType_check" CHECK ("controlType" IN (${list([...SINGLE, 'CASH', 'BANK'])}))`);
      await q('DROP INDEX IF EXISTS accounts_company_single_control');
      await q(`CREATE UNIQUE INDEX accounts_company_single_control ON accounts ("companyId", "controlType") WHERE "controlType" IN (${list(SINGLE)})`);
    });
  },
};
