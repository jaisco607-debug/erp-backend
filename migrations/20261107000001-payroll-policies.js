'use strict';
// Payroll policy (owner 2026-10-30), chunk 3 of the Payroll module: the rules of a group, with the month they start from.
// A row is a VERSION: it holds from `effectiveFrom` (the first day of a month) until the next version of the same group. A month with no version
// before it uses the built-in defaults (see payrollPolicyService). A payroll copies the policy when it is created, so a later change never
// reaches an old month.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE payroll_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "groupId" uuid NOT NULL REFERENCES payroll_groups (id),
        "effectiveFrom" date NOT NULL CHECK (EXTRACT(DAY FROM "effectiveFrom") = 1),
        "lateLimitMinutes" integer NOT NULL CHECK ("lateLimitMinutes" >= 0 AND "lateLimitMinutes" <= 600),
        "halfDayLimitMinutes" integer NOT NULL CHECK ("halfDayLimitMinutes" >= 1 AND "halfDayLimitMinutes" <= 1440),
        "latesPerHalfDay" integer NOT NULL CHECK ("latesPerHalfDay" >= 0 AND "latesPerHalfDay" <= 31),
        "weeklyOffDay" varchar(9) CHECK ("weeklyOffDay" IN ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY')),
        "overtimeFactor" numeric(4,2) NOT NULL CHECK ("overtimeFactor" >= 0 AND "overtimeFactor" <= 10),
        "leaveEarnedPerMonth" numeric(4,2) NOT NULL CHECK ("leaveEarnedPerMonth" >= 0 AND "leaveEarnedPerMonth" <= 31),
        "maxLeavePerYear" numeric(5,2) NOT NULL CHECK ("maxLeavePerYear" >= 0 AND "maxLeavePerYear" <= 366),
        "monthsBeforeLeave" integer NOT NULL CHECK ("monthsBeforeLeave" >= 0 AND "monthsBeforeLeave" <= 120),
        "createdById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "updatedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payroll_policies_half_day_more_than_late CHECK ("halfDayLimitMinutes" > "lateLimitMinutes"),
        UNIQUE ("companyId", "groupId", "effectiveFrom"))`);
      await q('CREATE INDEX payroll_policies_group ON payroll_policies ("groupId", "effectiveFrom")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_policies');
  },
};
