// Fabric return grey (owner 2026-10-19): the party takes back cloth that was NOT processed.
// The Grey Store sends those thaans straight to Folding on a special SO card (isGreyReturn).
// Folding can only pass that cloth on to Packing; Packing makes the packing list and the gate pass.
// The flag travels with the SO card, so every screen can show the tag "Fabric return grey".
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE so_cards ADD COLUMN "isGreyReturn" boolean NOT NULL DEFAULT false;`);
  },
  async down(queryInterface) { await queryInterface.sequelize.query(`ALTER TABLE so_cards DROP COLUMN "isGreyReturn";`); },
};
