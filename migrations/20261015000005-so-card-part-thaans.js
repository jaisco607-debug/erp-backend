// Part of a thaan on an SO card (e.g. 1000 m out of a 2000 m thaan).
//   so_card_lot_thaans       which thaan, and how many meters of it, each SO card line took
//   grey_lot_thaans.takenMeters  meters of the thaan already on SO cards; the thaan is SO_CARD only
//                            when all of it is taken, otherwise IN_STOCK with the rest still free
// Cards made before this keep working: their whole thaans are copied into the new table.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE so_card_lot_thaans (
          id uuid PRIMARY KEY,
          "soCardLotId" uuid NOT NULL REFERENCES so_card_lots(id),
          "thaanId" uuid NOT NULL REFERENCES grey_lot_thaans(id),
          meters numeric(14,2) NOT NULL CHECK (meters > 0),
          UNIQUE ("soCardLotId", "thaanId")
        );
        CREATE INDEX so_card_lot_thaans_thaan ON so_card_lot_thaans ("thaanId");
        ALTER TABLE grey_lot_thaans ADD COLUMN "takenMeters" numeric(14,2) NOT NULL DEFAULT 0;
        INSERT INTO so_card_lot_thaans (id, "soCardLotId", "thaanId", meters)
          SELECT gen_random_uuid(), "soCardLotId", id, meters FROM grey_lot_thaans WHERE "soCardLotId" IS NOT NULL;
        UPDATE grey_lot_thaans SET "takenMeters" = meters WHERE "soCardLotId" IS NOT NULL;`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE so_card_lot_thaans; ALTER TABLE grey_lot_thaans DROP COLUMN "takenMeters";');
  },
};
