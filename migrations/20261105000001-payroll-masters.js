'use strict';
// Payroll masters (owner 2026-10-30), chunk 1 of the Payroll module. Every table belongs to one company.
//   payroll_groups        employee groups (Factory, Outlet, Head Office, Admin are made for every company: systemKey; a company may add its own)
//   payroll_departments   a department of a group with its approved head-count (fte)
//   payroll_designations  job titles (Worker, Auditor, Floor Manager ...)
//   payroll_shifts        duty shifts: start, end, duty hours, night shift
//   payroll_holidays      company holidays, for all groups or for chosen groups (payroll_holiday_groups)
//   payroll_banks         banks for the bank upload file
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const stamps = `"createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()`;
      await q(`CREATE TABLE payroll_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        name varchar(80) NOT NULL,
        "systemKey" varchar(20),
        "isActive" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX payroll_groups_name ON payroll_groups ("companyId", lower(name))');
      await q('CREATE UNIQUE INDEX payroll_groups_system_key ON payroll_groups ("companyId", "systemKey") WHERE "systemKey" IS NOT NULL');

      await q(`CREATE TABLE payroll_departments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "groupId" uuid NOT NULL REFERENCES payroll_groups (id),
        name varchar(120) NOT NULL,
        fte integer NOT NULL DEFAULT 0 CHECK (fte >= 0),
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX payroll_departments_name ON payroll_departments ("companyId", "groupId", lower(name))');
      await q('CREATE INDEX payroll_departments_group ON payroll_departments ("groupId")');

      await q(`CREATE TABLE payroll_designations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        name varchar(120) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX payroll_designations_name ON payroll_designations ("companyId", lower(name))');

      await q(`CREATE TABLE payroll_shifts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code varchar(30) NOT NULL,
        name varchar(80),
        "startTime" time NOT NULL,
        "endTime" time NOT NULL,
        "dutyHours" numeric(4,2) NOT NULL CHECK ("dutyHours" > 0 AND "dutyHours" <= 24),
        "isNight" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps},
        CONSTRAINT payroll_shifts_start_not_end CHECK ("startTime" <> "endTime"))`);
      await q('CREATE UNIQUE INDEX payroll_shifts_code ON payroll_shifts ("companyId", lower(code))');

      await q(`CREATE TABLE payroll_holidays (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "holidayDate" date NOT NULL,
        name varchar(120) NOT NULL,
        "appliesToAll" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX payroll_holidays_day_name ON payroll_holidays ("companyId", "holidayDate", lower(name))');
      await q('CREATE INDEX payroll_holidays_date ON payroll_holidays ("companyId", "holidayDate")');
      await q(`CREATE TABLE payroll_holiday_groups (
        "holidayId" uuid NOT NULL REFERENCES payroll_holidays (id) ON DELETE CASCADE,
        "groupId" uuid NOT NULL REFERENCES payroll_groups (id),
        PRIMARY KEY ("holidayId", "groupId"))`);
      await q('CREATE INDEX payroll_holiday_groups_group ON payroll_holiday_groups ("groupId")');

      await q(`CREATE TABLE payroll_banks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        name varchar(120) NOT NULL,
        "shortName" varchar(20),
        "bankCode" varchar(20),
        "isActive" boolean NOT NULL DEFAULT true,
        ${stamps})`);
      await q('CREATE UNIQUE INDEX payroll_banks_name ON payroll_banks ("companyId", lower(name))');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS payroll_holiday_groups, payroll_holidays, payroll_banks, payroll_shifts, payroll_designations, payroll_departments, payroll_groups`);
  },
};
