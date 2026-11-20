'use strict';
// Weaving > Masters > Quality (owner 2026-12-05): a Quality master (the fabric quality, e.g. 60X60/90X82=136"CTN), added once in Masters and picked on the Sizing Batch.
//   weaving_qualities       like weaving_departments / yarn_brands: a unique name per company (any letter case = the same), a running code, soft delete, an active switch
//   sizing_batches.qualityId  the quality of the batch (optional); the old free-text sizing_batches.quality stays only for batches made before this change
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE weaving_qualities (
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
      await q('CREATE UNIQUE INDEX weaving_qualities_company_name ON weaving_qualities ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX weaving_qualities_company_code ON weaving_qualities ("companyId", code)');
      await q('ALTER TABLE sizing_batches ADD COLUMN "qualityId" uuid REFERENCES weaving_qualities(id)');
      await q('CREATE INDEX sizing_batches_quality ON sizing_batches ("qualityId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE sizing_batches DROP COLUMN "qualityId"');
      await q('DROP TABLE IF EXISTS weaving_qualities');
    });
  },
};
