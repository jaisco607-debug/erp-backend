'use strict';
// Bank upload file of a payroll (owner 2026-11-10), chunk 14 of the Payroll module (Salary > Payroll > Bank file).
//   payroll_bank_files   every bank file made for a payroll: the format (MEEZAN for now), the file itself (kept as made, so it can be downloaded again exactly), how many employees and how much.
//   payroll_slips."bankFileId"  the latest bank file a payslip is in: the "bank file made" tick. It is cleared when the payslip is sent back to Draft (the file no longer matches).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_bank_files (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code integer NOT NULL CHECK (code > 0),
        "runId" uuid NOT NULL REFERENCES payroll_runs (id) ON DELETE CASCADE,
        format varchar(20) NOT NULL,
        scope varchar(10) NOT NULL CHECK (scope IN ('UNPAID', 'ALL')),
        "fileName" varchar(160) NOT NULL,
        content text NOT NULL,
        employees integer NOT NULL CHECK (employees > 0),
        total numeric(14,2) NOT NULL CHECK (total > 0),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", code))`);
      await q('CREATE INDEX payroll_bank_files_run ON payroll_bank_files ("runId", "createdAt")');
      await q('ALTER TABLE payroll_slips ADD COLUMN "bankFileId" uuid REFERENCES payroll_bank_files (id) ON DELETE SET NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('ALTER TABLE payroll_slips DROP COLUMN IF EXISTS "bankFileId"', { transaction });
      await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_bank_files', { transaction });
    });
  },
};
