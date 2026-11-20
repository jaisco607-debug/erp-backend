'use strict';
// Looms: HALF CUT. A beam taken off the loom before it is finished goes back to the beam stock as FULL with the estimated length left.
//   yarn_beams.halfCutM            the estimated meters left on a FULL beam that came back half cut (badge "Half cut"); NULL otherwise
//   loom_entries.status            + HALF_CUT (the entry ended by a half cut: the loom is free)
//   loom_entry_beams.leftM         the meters left that were entered for the beam at the half cut
//   loom_entry_beams.prevHalfCutM  halfCutM the beam had when it went on the loom (to undo)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_beams ADD COLUMN "halfCutM" numeric(12,2)');
      await q('ALTER TABLE loom_entry_beams ADD COLUMN "leftM" numeric(12,2), ADD COLUMN "prevHalfCutM" numeric(12,2)');
      await q('ALTER TABLE loom_entries DROP CONSTRAINT IF EXISTS loom_entries_status_check');
      await q("ALTER TABLE loom_entries ALTER COLUMN status TYPE varchar(8), ADD CONSTRAINT loom_entries_status_check CHECK (status IN ('ACTIVE', 'CUT_OFF', 'HALF_CUT'))");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("UPDATE loom_entries SET status = 'CUT_OFF' WHERE status = 'HALF_CUT'");
      await q('ALTER TABLE loom_entries DROP CONSTRAINT IF EXISTS loom_entries_status_check');
      await q("ALTER TABLE loom_entries ADD CONSTRAINT loom_entries_status_check CHECK (status IN ('ACTIVE', 'CUT_OFF'))");
      await q('ALTER TABLE loom_entry_beams DROP COLUMN "leftM", DROP COLUMN "prevHalfCutM"');
      await q('ALTER TABLE yarn_beams DROP COLUMN "halfCutM"');
    });
  },
};
