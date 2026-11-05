'use strict';
// Employee master (owner 2026-10-30), chunk 2 of the Payroll module.
//   payroll_employees  the employee card: personal data, work (group, department, designation, shift, joining / leaving), salary and payment details.
//                      status DRAFT (can be edited) / CONFIRMED (locked; "Edit" takes it back to draft); isClosed = left the company.
//   payroll_files      photo, CNIC front and back (later also the joining documents), kept IN the database (bytea, up to 2 MB each) so they deploy,
//                      back up and move with the data: one file per owner and kind. The bytes are read only by the download call, never in lists.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_employees (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
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
        "leavingDate" date,
        "isClosed" boolean NOT NULL DEFAULT false,
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "confirmedAt" timestamptz,
        "confirmedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "salaryType" varchar(10) NOT NULL DEFAULT 'MONTHLY' CHECK ("salaryType" IN ('MONTHLY', 'FIXED', 'DAILY')),
        "basicSalary" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("basicSalary" >= 0),
        "foodAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("foodAllowance" >= 0),
        "maintenanceAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("maintenanceAllowance" >= 0),
        "mobileAllowance" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("mobileAllowance" >= 0),
        "monthlyIncomeTax" numeric(12,2) CHECK ("monthlyIncomeTax" IS NULL OR "monthlyIncomeTax" >= 0),
        "paymentMethod" varchar(6) NOT NULL DEFAULT 'CASH' CHECK ("paymentMethod" IN ('BANK', 'CASH')),
        "bankId" uuid REFERENCES payroll_banks (id),
        "accountNo" varchar(40),
        "accountTitle" varchar(120),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_employees_leaving_after_joining CHECK ("leavingDate" IS NULL OR "leavingDate" >= "joiningDate"),
        CONSTRAINT payroll_employees_closed_has_leaving CHECK (NOT "isClosed" OR "leavingDate" IS NOT NULL),
        CONSTRAINT payroll_employees_bank_has_details CHECK ("paymentMethod" <> 'BANK' OR ("bankId" IS NOT NULL AND "accountNo" IS NOT NULL)),
        UNIQUE ("companyId", code))`);
      await q('CREATE UNIQUE INDEX payroll_employees_cnic ON payroll_employees ("companyId", cnic) WHERE cnic IS NOT NULL');
      await q('CREATE INDEX payroll_employees_group ON payroll_employees ("companyId", "groupId", "isClosed")');
      await q('CREATE INDEX payroll_employees_department ON payroll_employees ("departmentId")');
      await q('CREATE INDEX payroll_employees_designation ON payroll_employees ("designationId")');
      await q('CREATE INDEX payroll_employees_shift ON payroll_employees ("shiftId")');
      await q('CREATE INDEX payroll_employees_bank ON payroll_employees ("bankId")');

      await q(`CREATE TABLE payroll_files (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "ownerType" varchar(20) NOT NULL,
        "ownerId" uuid NOT NULL,
        kind varchar(20) NOT NULL,
        "fileName" varchar(200) NOT NULL,
        "mimeType" varchar(40) NOT NULL,
        size integer NOT NULL CHECK (size > 0 AND size <= 2097152),
        sha256 char(64) NOT NULL,
        data bytea NOT NULL,
        "uploadedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("ownerType", "ownerId", kind))`);
      await q('CREATE INDEX payroll_files_company ON payroll_files ("companyId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_files, payroll_employees');
  },
};
