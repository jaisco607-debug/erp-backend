'use strict';
// Bug fix (frontend report 2026-11-22): an SO card returned from a department back to the SO card desk could not be sent again ("A record with the same value already exists").
// Cause: sending a card writes a so_card_moves row that stays OPEN (acceptedAt empty); the unique index so_card_moves_one_open allows ONE open row per card, and returning the card to
// the SO card desk did not close it, so the next send made a second open row.
//   so_card_moves."cancelledAt"  a move that never completed because the card came back to the SO card desk (kept for the history, never "waiting" again)
//   so_card_moves_one_open       now ignores cancelled moves
//   Cards already stuck this way are healed: the open move of a card that is NEW (not sent) is cancelled.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE so_card_moves ADD COLUMN "cancelledAt" timestamptz');
      await q('DROP INDEX so_card_moves_one_open');
      await q('CREATE UNIQUE INDEX so_card_moves_one_open ON so_card_moves ("soCardId") WHERE "acceptedAt" IS NULL AND "cancelledAt" IS NULL');
      await q(`UPDATE so_card_moves m SET "cancelledAt" = now() FROM so_cards c WHERE c.id = m."soCardId" AND c.status = 'NEW' AND m."acceptedAt" IS NULL AND m."cancelledAt" IS NULL`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DELETE FROM so_card_moves WHERE "cancelledAt" IS NOT NULL');
      await q('DROP INDEX so_card_moves_one_open');
      await q('CREATE UNIQUE INDEX so_card_moves_one_open ON so_card_moves ("soCardId") WHERE "acceptedAt" IS NULL');
      await q('ALTER TABLE so_card_moves DROP COLUMN "cancelledAt"');
    });
  },
};
