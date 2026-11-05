'use strict';
// Employee card and joining application (owner 2026-11-11): income tax is a fixed monthly amount, not a percent; the EOBI percent is gone (EOBI comes from the EOBI module);
// two optional numbers, the EOBI number and the SESSI / SCSSI number.
//   monthlyIncomeTax   the amount taken from the salary every month (0 = none). The percent that was there is turned into an amount of the basic (rounded to the rupee, as the payroll did).
//   eobiNo, scssiNo    optional, up to 30 characters, no format.
const TABLES = ['payroll_employees', 'payroll_joining_applications'];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of TABLES) {
        await q(`ALTER TABLE ${t}
          ADD COLUMN "monthlyIncomeTax" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("monthlyIncomeTax" >= 0),
          ADD COLUMN "eobiNo" varchar(30),
          ADD COLUMN "scssiNo" varchar(30)`);
        await q(`UPDATE ${t} SET "monthlyIncomeTax" = round("basicSalary" * "yearlyIncomeTaxPercent" / 100) WHERE "yearlyIncomeTaxPercent" IS NOT NULL AND "yearlyIncomeTaxPercent" > 0`);
        await q(`ALTER TABLE ${t} DROP COLUMN "yearlyIncomeTaxPercent", DROP COLUMN "monthlyEobiPercent"`);
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of TABLES) {
        await q(`ALTER TABLE ${t}
          ADD COLUMN "yearlyIncomeTaxPercent" numeric(5,2) CHECK ("yearlyIncomeTaxPercent" IS NULL OR ("yearlyIncomeTaxPercent" >= 0 AND "yearlyIncomeTaxPercent" <= 100)),
          ADD COLUMN "monthlyEobiPercent" numeric(5,2) CHECK ("monthlyEobiPercent" IS NULL OR ("monthlyEobiPercent" >= 0 AND "monthlyEobiPercent" <= 100))`);
        await q(`UPDATE ${t} SET "yearlyIncomeTaxPercent" = LEAST(100, round("monthlyIncomeTax" * 100 / "basicSalary", 2)) WHERE "monthlyIncomeTax" > 0 AND "basicSalary" > 0`);
        await q(`ALTER TABLE ${t} DROP COLUMN "monthlyIncomeTax", DROP COLUMN "eobiNo", DROP COLUMN "scssiNo"`);
      }
    });
  },
};
