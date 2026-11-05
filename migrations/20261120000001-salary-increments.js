'use strict';
// Salary increment during the year (owner 2026-11-09), chunk 13 of the Payroll module (Salary > Salary Increment).
//   payroll_increments   one increment of ONE employee: the salary and the three allowances (food, mobile, maintenance) as they are (cur*) and as they will be (new*), the date and the month
//                        it applies from, the remarks and the approval trail. Status DRAFT 0 -> REVIEW 1 -> FINAL_REVIEW 2 -> APPROVED 3 (posted: the employee master is updated, basic AND allowances).
//                        An employee has ONE open increment (draft, review or final review) at a time. A rejection sends it back to draft with the reason.
const stamps = '"createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()';
const money = (name) => `"${name}" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_increments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW', 'APPROVED')),
        "applicationDate" date NOT NULL,
        "effectiveMonth" date CHECK ("effectiveMonth" IS NULL OR EXTRACT(DAY FROM "effectiveMonth") = 1),
        ${money('curSalary')}, ${money('curFood')}, ${money('curMobile')}, ${money('curMaintenance')},
        ${money('newSalary')}, ${money('newFood')}, ${money('newMobile')}, ${money('newMaintenance')},
        remarks varchar(300),
        "rejectReason" varchar(300),
        "rejectedAt" timestamptz,
        "rejectedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "submittedAt" timestamptz,
        "submittedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "reviewedAt" timestamptz,
        "reviewedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "approvedAt" timestamptz,
        "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        source varchar(10) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'CSV')),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ${stamps},
        UNIQUE ("companyId", code))`);
      await q(`CREATE UNIQUE INDEX payroll_increments_one_open ON payroll_increments ("employeeId") WHERE status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW')`);
      await q('CREATE INDEX payroll_increments_company_status ON payroll_increments ("companyId", status)');
      await q('CREATE INDEX payroll_increments_employee ON payroll_increments ("employeeId", status)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_increments');
  },
};
