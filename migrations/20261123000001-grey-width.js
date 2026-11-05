'use strict';
// Width of the grey cloth (owner 2026-11-12). Typed at Grey Inward, per thaan (or one width for the whole lot), and carried on the cloth to the SO card, the departments, Folding and Packing.
//   grey_lots.width          the width of the lot (the default of its thaans); optional
//   grey_lot_thaans.width    the width of one thaan; optional (a thaan without one has the lot's width)
// Nothing is copied to the later tables: SO cards, jobs, folding and packing lines all point at the thaan, so the width follows the thaan.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE grey_lots ADD COLUMN width numeric(6,2) CHECK (width IS NULL OR width > 0);
      ALTER TABLE grey_lot_thaans ADD COLUMN width numeric(6,2) CHECK (width IS NULL OR width > 0);`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE grey_lot_thaans DROP COLUMN width; ALTER TABLE grey_lots DROP COLUMN width;');
  },
};
