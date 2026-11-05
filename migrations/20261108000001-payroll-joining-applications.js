'use strict';
// Employee Joining Application (owner 2026-10-31), chunk 4 of the Payroll module.
//   payroll_employees         "monthlyIncomeTax" becomes "yearlyIncomeTax" (the tax is paid once a year); new "monthlyEobi" (the EOBI amount paid every month). Both are
//                             "for office use only" on the printed form and sit with the bank details.
//   payroll_joining_applications  the same form as the employee card, filled from the paper form by HR. DRAFT -> IN_REVIEW; the approval (and the creation of the
//                             employee card from it) comes later. Its documents live in payroll_files (ownerType 'JOINING': photo, CNIC front and back, the scanned form).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE payroll_employees RENAME COLUMN "monthlyIncomeTax" TO "yearlyIncomeTax"');
      await q('ALTER TABLE payroll_employees ADD COLUMN "monthlyEobi" numeric(12,2) CHECK ("monthlyEobi" IS NULL OR "monthlyEobi" >= 0)');

      await q(`CREATE TABLE payroll_joining_applications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW')),
        "submittedAt" timestamptz,
        "submittedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        name varchar(150) NOT NULL,
        "fatherName" varchar(150),
        "motherName" varchar(150),
        cnic varchar(15),
        ntn varchar(20),
        "dateOfBirth" date,
        gender varchar(10) CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
        "maritalStatus" varchar(10) CHECK ("maritalStatus" IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED')),
        religion varchar(40),
        language varchar(40),
        phone varchar(30),
        email varchar(150),
        address varchar(300),
        "groupId" uuid NOT NULL REFERENCES payroll_groups (id),
        "departmentId" uuid REFERENCES payroll_departments (id),
        "designationId" uuid REFERENCES payroll_designations (id),
        "shiftId" uuid REFERENCES payroll_shifts (id),
        "joiningDate" date NOT NULL,
        "salaryType" varchar(10) NOT NULL DEFAULT 'MONTHLY' CHECK ("salaryType" IN ('MONTHLY', 'FIXED', 'DAILY')),
        "basicSalary" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("basicSalary" >= 0),
        "foodAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("foodAllowance" >= 0),
        "maintenanceAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("maintenanceAllowance" >= 0),
        "mobileAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("mobileAllowance" >= 0),
        "yearlyIncomeTax" numeric(12,2) CHECK ("yearlyIncomeTax" IS NULL OR "yearlyIncomeTax" >= 0),
        "monthlyEobi" numeric(12,2) CHECK ("monthlyEobi" IS NULL OR "monthlyEobi" >= 0),
        "paymentMethod" varchar(6) NOT NULL DEFAULT 'CASH' CHECK ("paymentMethod" IN ('BANK', 'CASH')),
        "bankId" uuid REFERENCES payroll_banks (id),
        "accountNo" varchar(40),
        "accountTitle" varchar(120),
        remarks varchar(500),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_joining_applications_bank_has_details CHECK ("paymentMethod" <> 'BANK' OR ("bankId" IS NOT NULL AND "accountNo" IS NOT NULL)),
        UNIQUE ("companyId", code))`);
      await q('CREATE INDEX payroll_joining_applications_status ON payroll_joining_applications ("companyId", status)');
      await q('CREATE INDEX payroll_joining_applications_department ON payroll_joining_applications ("departmentId", status)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DELETE FROM payroll_files WHERE "ownerType" = \'JOINING\'');
      await q('DROP TABLE IF EXISTS payroll_joining_applications');
      await q('ALTER TABLE payroll_employees DROP COLUMN IF EXISTS "monthlyEobi"');
      await q('ALTER TABLE payroll_employees RENAME COLUMN "yearlyIncomeTax" TO "monthlyIncomeTax"');
    });
  },
};
