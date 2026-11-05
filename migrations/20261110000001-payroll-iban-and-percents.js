'use strict';
// IBAN and tax / EOBI as a percent of the basic salary (owner 2026-10-31), on the employee card and the joining application.
//   iban                    optional, kept apart from accountNo: PK + 22 characters (24 in all), capitals, no spaces.
//   yearlyIncomeTaxPercent  income tax as a percent of the basic salary; the payroll deducts it from the salary of each month.
//   monthlyEobiPercent      EOBI as a percent of the basic salary, deducted every month.
// The two amount columns of the previous chunk are turned into percents of the basic salary (0 when there was no basic) and dropped.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of ['payroll_employees', 'payroll_joining_applications']) {
        await q(`ALTER TABLE ${t}
          ADD COLUMN iban varchar(24) CHECK (iban IS NULL OR iban ~ '^PK[0-9]{2}[A-Z]{4}[A-Z0-9]{16}$'),
          ADD COLUMN "yearlyIncomeTaxPercent" numeric(5,2) CHECK ("yearlyIncomeTaxPercent" IS NULL OR ("yearlyIncomeTaxPercent" >= 0 AND "yearlyIncomeTaxPercent" <= 100)),
          ADD COLUMN "monthlyEobiPercent" numeric(5,2) CHECK ("monthlyEobiPercent" IS NULL OR ("monthlyEobiPercent" >= 0 AND "monthlyEobiPercent" <= 100))`);
        await q(`UPDATE ${t} SET
          "yearlyIncomeTaxPercent" = CASE WHEN "yearlyIncomeTax" IS NULL THEN NULL WHEN "basicSalary" > 0 THEN LEAST(100, round("yearlyIncomeTax" * 100 / "basicSalary", 2)) ELSE 0 END,
          "monthlyEobiPercent" = CASE WHEN "monthlyEobi" IS NULL THEN NULL WHEN "basicSalary" > 0 THEN LEAST(100, round("monthlyEobi" * 100 / "basicSalary", 2)) ELSE 0 END`);
        await q(`ALTER TABLE ${t} DROP COLUMN "yearlyIncomeTax", DROP COLUMN "monthlyEobi"`);
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const t of ['payroll_employees', 'payroll_joining_applications']) {
        await q(`ALTER TABLE ${t} ADD COLUMN "yearlyIncomeTax" numeric(12,2) CHECK ("yearlyIncomeTax" IS NULL OR "yearlyIncomeTax" >= 0),
          ADD COLUMN "monthlyEobi" numeric(12,2) CHECK ("monthlyEobi" IS NULL OR "monthlyEobi" >= 0)`);
        await q(`UPDATE ${t} SET "yearlyIncomeTax" = round("basicSalary" * "yearlyIncomeTaxPercent" / 100, 2), "monthlyEobi" = round("basicSalary" * "monthlyEobiPercent" / 100, 2)`);
        await q(`ALTER TABLE ${t} DROP COLUMN iban, DROP COLUMN "yearlyIncomeTaxPercent", DROP COLUMN "monthlyEobiPercent"`);
      }
    });
  },
};
