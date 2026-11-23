'use strict';
// Weaving Production Control > Weaver wise & attendance billing (owner 2026-11-21).
//   looms.loomType            the make / model of the loom (PU, P7100 ...): the units of the weaver sheet are split by it (and the stoppage rate is per type)
//   production_policies       the "Loom policy" of a department: how many looms in a shift make a "6-loom" shift, when a loom counts as stopped, the rate per unit of each loom type
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE looms ADD COLUMN "loomType" varchar(20)');
      await q(`CREATE TABLE production_policies (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES weaving_departments(id),
        "bigLoomMin" smallint NOT NULL DEFAULT 6 CHECK ("bigLoomMin" BETWEEN 1 AND 50),
        "stopBelowUnits" numeric(10,2) NOT NULL DEFAULT 1 CHECK ("stopBelowUnits" >= 0),
        rates jsonb NOT NULL DEFAULT '{}'::jsonb,
        "updatedById" uuid,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "departmentId")
      )`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP TABLE production_policies', { transaction });
      await queryInterface.sequelize.query('ALTER TABLE looms DROP COLUMN "loomType"', { transaction });
    });
  },
};
