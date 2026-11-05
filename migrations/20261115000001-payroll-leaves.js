'use strict';
// Leave applications and annual leave (owner 2026-11-04), chunk 9 of the Payroll module.
//   payroll_leaves      the application: DRAFT -> IN_REVIEW -> APPROVED / REJECTED (reviewer = client admin or a chosen approver); an approved leave can be CANCELLED
//                       (the days go back to the balance). Annual leave is the only type: it is paid and comes out of the balance.
//   payroll_leave_days  the working days the leave covers (the weekly off day and the holidays inside it are not counted): what is taken from the balance, and what the
//                       attendance shows as AL on the days nobody punched. Written when the application is saved, sent and approved.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_leaves (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED')),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "leaveType" varchar(10) NOT NULL DEFAULT 'ANNUAL' CHECK ("leaveType" IN ('ANNUAL')),
        "applicationDate" date NOT NULL,
        "fromDate" date NOT NULL,
        "toDate" date NOT NULL,
        days integer NOT NULL DEFAULT 0 CHECK (days >= 0),
        reason varchar(500) NOT NULL,
        "submittedAt" timestamptz,
        "submittedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "approvedAt" timestamptz,
        "approvedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "rejectedAt" timestamptz,
        "rejectedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "rejectReason" varchar(500),
        "cancelledAt" timestamptz,
        "cancelledById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "cancelReason" varchar(500),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_leaves_dates CHECK ("toDate" >= "fromDate"),
        UNIQUE ("companyId", code))`);
      await q('CREATE INDEX payroll_leaves_status ON payroll_leaves ("companyId", status)');
      await q('CREATE INDEX payroll_leaves_employee ON payroll_leaves ("employeeId", "fromDate")');
      await q(`CREATE TABLE payroll_leave_days (
        "leaveId" uuid NOT NULL REFERENCES payroll_leaves (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "leaveDate" date NOT NULL,
        PRIMARY KEY ("leaveId", "leaveDate"))`);
      await q('CREATE INDEX payroll_leave_days_employee ON payroll_leave_days ("employeeId", "leaveDate")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_leave_days, payroll_leaves');
  },
};
