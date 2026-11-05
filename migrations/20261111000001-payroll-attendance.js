'use strict';
// Attendance (owner 2026-11-01), chunk 6 of the Payroll module.
//   payroll_devices          the punch machines (a device is made by the first punch that names it)
//   payroll_punch_batches    one row per import (Excel file or the machine API): what came in, what was a duplicate, what was refused; an import can be undone
//   payroll_punches          every punch as it came: the employee ID of the machine (= the Employee ID of the Employee Master), the moment, the device.
//                            A punch is never tied to an employee row: it is matched on the ID when it is read, so a punch that came before its
//                            employee was created ("unmapped") is picked up as soon as the employee exists. A moment is stored once per ID: re-importing is safe.
//   payroll_attendance_days  the result for each employee and day (P, L, HD, A, R, AL) with the first in, last out, late and overtime minutes.
//                            "isManual" days were set by HR and are never overwritten by a recalculation.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const stamps = `"createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()`;
      await q(`CREATE TABLE payroll_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code varchar(60) NOT NULL,
        name varchar(120) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps},
        UNIQUE ("companyId", code))`);
      await q(`CREATE TABLE payroll_punch_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        source varchar(10) NOT NULL CHECK (source IN ('EXCEL', 'API', 'MANUAL')),
        "fileName" varchar(200),
        "totalRows" integer NOT NULL DEFAULT 0,
        inserted integer NOT NULL DEFAULT 0,
        duplicates integer NOT NULL DEFAULT 0,
        invalid integer NOT NULL DEFAULT 0,
        "fromDate" date,
        "toDate" date,
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "undoneAt" timestamptz,
        "undoneById" uuid REFERENCES users (id) ON DELETE SET NULL)`);
      await q('CREATE INDEX payroll_punch_batches_company ON payroll_punch_batches ("companyId", "createdAt" DESC)');
      await q(`CREATE TABLE payroll_punches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "empCode" integer NOT NULL CHECK ("empCode" > 0),
        "punchAt" timestamptz NOT NULL,
        "deviceId" uuid REFERENCES payroll_devices (id),
        mode smallint,
        source varchar(10) NOT NULL,
        "batchId" uuid REFERENCES payroll_punch_batches (id),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "empCode", "punchAt"))`);
      await q('CREATE INDEX payroll_punches_time ON payroll_punches ("companyId", "punchAt")');
      await q('CREATE INDEX payroll_punches_batch ON payroll_punches ("batchId")');
      await q('CREATE INDEX payroll_punches_device ON payroll_punches ("deviceId", "punchAt")');
      await q(`CREATE TABLE payroll_attendance_days (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees (id) ON DELETE CASCADE,
        "workDate" date NOT NULL,
        code varchar(2) NOT NULL CHECK (code IN ('P', 'L', 'HD', 'A', 'R', 'AL')),
        "firstIn" timestamptz,
        "lastOut" timestamptz,
        punches integer NOT NULL DEFAULT 0,
        "workedMinutes" integer NOT NULL DEFAULT 0 CHECK ("workedMinutes" >= 0),
        "lateMinutes" integer NOT NULL DEFAULT 0 CHECK ("lateMinutes" >= 0),
        "overtimeMinutes" integer NOT NULL DEFAULT 0 CHECK ("overtimeMinutes" >= 0),
        "dutyMinutes" integer CHECK ("dutyMinutes" IS NULL OR "dutyMinutes" > 0),
        incomplete boolean NOT NULL DEFAULT false,
        "restDay" boolean NOT NULL DEFAULT false,
        "isManual" boolean NOT NULL DEFAULT false,
        note varchar(300),
        "editedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "editedAt" timestamptz,
        ${stamps},
        UNIQUE ("employeeId", "workDate"))`);
      await q('CREATE INDEX payroll_attendance_days_date ON payroll_attendance_days ("companyId", "workDate")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_attendance_days, payroll_punches, payroll_punch_batches, payroll_devices');
  },
};
