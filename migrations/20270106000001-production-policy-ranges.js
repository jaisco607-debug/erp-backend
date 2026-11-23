'use strict';
// "Loom policy and rates" (owner 2026-11-21): looms per weaver by loom number (ranges + "all other looms") and the bill rates with the date they apply from.
//   production_policies   defaultLooms (all other looms, default 6) and ranges [{ from, to, loomsPerWeaver }] replace the first idea (bigLoomMin, rates)
//   production_rates      the rate per day (shift) and the rate per unit of each loom type, from a date on: a period keeps the rates that were in force on its days
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE production_rates (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES weaving_departments(id),
        "effectiveFrom" date NOT NULL,
        "ratePerDay" numeric(14,4) CHECK ("ratePerDay" IS NULL OR "ratePerDay" >= 0),
        rates jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updatedById" uuid,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "departmentId", "effectiveFrom")
      )`);
      await q(`INSERT INTO production_rates (id, "companyId", "departmentId", "effectiveFrom", rates)
        SELECT gen_random_uuid(), "companyId", "departmentId", DATE '2000-01-01', rates FROM production_policies WHERE rates <> '{}'::jsonb`);
      await q('ALTER TABLE production_policies ADD COLUMN "defaultLooms" smallint NOT NULL DEFAULT 6 CHECK ("defaultLooms" BETWEEN 1 AND 50), ADD COLUMN ranges jsonb NOT NULL DEFAULT \'[]\'::jsonb');
      await q('ALTER TABLE production_policies DROP COLUMN "bigLoomMin", DROP COLUMN rates');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE production_policies ADD COLUMN "bigLoomMin" smallint NOT NULL DEFAULT 6, ADD COLUMN rates jsonb NOT NULL DEFAULT \'{}\'::jsonb');
      await q('ALTER TABLE production_policies DROP COLUMN "defaultLooms", DROP COLUMN ranges');
      await q('DROP TABLE production_rates');
    });
  },
};
