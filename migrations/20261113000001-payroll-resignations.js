'use strict';
// Resignation applications (owner 2026-11-02), chunk 7 of the Payroll module.
//   payroll_resignations  an employee leaving: DRAFT -> IN_REVIEW -> APPROVED (posted: the employee card is closed with the last working day) or REJECTED.
//                         The reviewer is a client admin or a chosen approver (payroll_approvers), like the joining application.
//                         An employee has at most one open (DRAFT / IN_REVIEW) resignation at a time.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_resignations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED')),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id),
        "applicationDate" date NOT NULL,
        "lastWorkingDay" date NOT NULL,
        reason varchar(500) NOT NULL,
        "refNo" varchar(40),
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
      await q(`CREATE UNIQUE INDEX payroll_resignations_one_open ON payroll_resignations ("employeeId") WHERE status IN ('DRAFT', 'IN_REVIEW')`);
      await q('CREATE INDEX payroll_resignations_status ON payroll_resignations ("companyId", status)');
      await q('CREATE INDEX payroll_resignations_employee ON payroll_resignations ("employeeId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_resignations');
  },
};
