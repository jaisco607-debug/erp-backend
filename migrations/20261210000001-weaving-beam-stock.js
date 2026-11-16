'use strict';
// Weaving step 8 (owner 2026-11-19): the Beam stock. Every beam is in ONE of four places:
//   EMPTY       empty beam (no yarn on it)
//   FULL        full beam (the sized yarn is wound on it)
//   AT_LOOM     put on a loom
//   AT_SIZING   sent out for sizing (outsourced)
//   yarn_beams.status       where the beam is now (a new beam is EMPTY)
//   yarn_beams.statusDate   since when (for a beam sent to sizing: the day it went)
// The next steps (send to sizing, receive from sizing, put on a loom ...) move the beams between the four places; for now the user can set the place on the beam form
// (the opening position of the beams the unit already has).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("ALTER TABLE yarn_beams ADD COLUMN status varchar(10) NOT NULL DEFAULT 'EMPTY' CHECK (status IN ('EMPTY', 'FULL', 'AT_LOOM', 'AT_SIZING'))");
      await q('ALTER TABLE yarn_beams ADD COLUMN "statusDate" date');
      await q('UPDATE yarn_beams SET "statusDate" = "beamDate"');
      await q('ALTER TABLE yarn_beams ALTER COLUMN "statusDate" SET NOT NULL');
      await q('CREATE INDEX yarn_beams_company_status ON yarn_beams ("companyId", status)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX yarn_beams_company_status');
      await q('ALTER TABLE yarn_beams DROP COLUMN "statusDate"');
      await q('ALTER TABLE yarn_beams DROP COLUMN status');
    });
  },
};
