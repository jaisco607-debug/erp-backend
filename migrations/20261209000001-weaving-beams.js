'use strict';
// Weaving step 7 (owner 2026-11-18): the Beam master. Every loom takes 2 beams; a beam is sized (outsourced for now) and put on a loom.
//   yarn_beams: one row per beam: beamNo (given by the user, or the next free number), name (typed), beamDate (default today).
//   The beam stock (empty / full / at loom) and the sizing come in the next steps on top of this master.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE yarn_beams (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "beamNo" integer NOT NULL CHECK ("beamNo" > 0),
        name varchar(80) NOT NULL,
        "beamDate" date NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_beams_company_no ON yarn_beams ("companyId", "beamNo") WHERE "deletedAt" IS NULL');
      await q('CREATE INDEX yarn_beams_company_date ON yarn_beams ("companyId", "beamDate")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_beams');
  },
};
