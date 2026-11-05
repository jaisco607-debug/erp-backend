'use strict';
// Approval of the joining application (owner 2026-10-31), chunk 5 of the Payroll module.
//   payroll_approvers   the people who may review joining applications (a client admin always may).
//   payroll_joining_applications  new statuses APPROVED / REJECTED; who approved or rejected and when, the rejection reason, and the employee card made from it.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_approvers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "userId" uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "userId"))`);
      await q('ALTER TABLE payroll_joining_applications DROP CONSTRAINT IF EXISTS payroll_joining_applications_status_check');
      await q(`ALTER TABLE payroll_joining_applications ADD CONSTRAINT payroll_joining_applications_status_check CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'))`);
      await q('ALTER TABLE payroll_joining_applications ALTER COLUMN status TYPE varchar(10)');
      await q(`ALTER TABLE payroll_joining_applications
        ADD COLUMN "employeeId" uuid REFERENCES payroll_employees (id) ON DELETE SET NULL,
        ADD COLUMN "approvedAt" timestamptz,
        ADD COLUMN "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD COLUMN "rejectedAt" timestamptz,
        ADD COLUMN "rejectedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD COLUMN "rejectReason" varchar(500)`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`UPDATE payroll_joining_applications SET status = 'DRAFT' WHERE status IN ('APPROVED', 'REJECTED')`);
      await q(`ALTER TABLE payroll_joining_applications DROP COLUMN "employeeId", DROP COLUMN "approvedAt", DROP COLUMN "approvedById",
        DROP COLUMN "rejectedAt", DROP COLUMN "rejectedById", DROP COLUMN "rejectReason"`);
      await q('ALTER TABLE payroll_joining_applications DROP CONSTRAINT payroll_joining_applications_status_check');
      await q(`ALTER TABLE payroll_joining_applications ADD CONSTRAINT payroll_joining_applications_status_check CHECK (status IN ('DRAFT', 'IN_REVIEW'))`);
      await q('DROP TABLE IF EXISTS payroll_approvers');
    });
  },
};
