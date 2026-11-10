'use strict';
// Sub-categories of an SO card (owner 2026-11-18). One SO card can hold several GROUPS ("parts"): e.g. a lot of 6 thaans gives 2 thaans to group A (tagged RED) and 2 to group B (tagged BLUE),
// the other 2 stay in the grey store; one thaan of 1000 m can be cut into parts for different groups. Each group is sent on by itself, or all together with the card.
//   so_card_groups        one group of a card: a letter code (A, B ...), an optional label, the COLOUR TAG (it goes to the department with the cloth: Dyeing sees it and may change it), remarks.
//   so_card_lots.groupId  the group a card line belongs to (empty = a card made the old way, without groups). A lot can have one line per group.
// Cards made before this have no groups and work exactly as before.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE so_card_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "soCardId" uuid NOT NULL REFERENCES so_cards (id),
        code varchar(3) NOT NULL,
        label varchar(80),
        "colourId" uuid REFERENCES colours (id),
        remarks varchar(300),
        "sortOrder" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("soCardId", code))`);
      await q('ALTER TABLE so_card_lots ADD COLUMN "groupId" uuid REFERENCES so_card_groups (id)');
      await q('ALTER TABLE so_card_lots DROP CONSTRAINT IF EXISTS "so_card_lots_soCardId_greyLotId_key"');
      await q('CREATE UNIQUE INDEX so_card_lots_card_lot ON so_card_lots ("soCardId", "greyLotId") WHERE "groupId" IS NULL');
      await q('CREATE UNIQUE INDEX so_card_lots_card_lot_group ON so_card_lots ("soCardId", "greyLotId", "groupId") WHERE "groupId" IS NOT NULL');
      await q('CREATE INDEX so_card_lots_group ON so_card_lots ("groupId") WHERE "groupId" IS NOT NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS so_card_lots_group');
      await q('DROP INDEX IF EXISTS so_card_lots_card_lot_group');
      await q('DROP INDEX IF EXISTS so_card_lots_card_lot');
      await q('ALTER TABLE so_card_lots DROP COLUMN "groupId"');
      await q('DROP TABLE so_card_groups');
      await q('ALTER TABLE so_card_lots ADD CONSTRAINT "so_card_lots_soCardId_greyLotId_key" UNIQUE ("soCardId", "greyLotId")');
    });
  },
};
