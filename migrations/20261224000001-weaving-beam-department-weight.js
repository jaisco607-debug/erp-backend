'use strict';
// Weaving > Masters (owner 2026-12-01): a Department master and, on every beam, its WEIGHT (kg) and its DEPARTMENT.
//   weaving_departments   like yarn_brands: a unique name per company (any letter case = the same), a running code, soft delete. Added once in Masters > Department.
//   yarn_beams.weightKg   the weight of the beam in kg (optional)
//   yarn_beams.departmentId  the department the beam belongs to (optional; picked from the Department master when the beam is added)
// The Beam Stock then also says how many beams each department has (empty / full / at loom / at sizing).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE weaving_departments (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        name varchar(80) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX weaving_departments_company_name ON weaving_departments ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX weaving_departments_company_code ON weaving_departments ("companyId", code)');
      await q('ALTER TABLE yarn_beams ADD COLUMN "weightKg" numeric(10,2) CHECK ("weightKg" IS NULL OR "weightKg" > 0)');
      await q('ALTER TABLE yarn_beams ADD COLUMN "departmentId" uuid REFERENCES weaving_departments(id)');
      await q('CREATE INDEX yarn_beams_department ON yarn_beams ("departmentId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_beams DROP COLUMN "departmentId"');
      await q('ALTER TABLE yarn_beams DROP COLUMN "weightKg"');
      await q('DROP TABLE IF EXISTS weaving_departments');
    });
  },
};
