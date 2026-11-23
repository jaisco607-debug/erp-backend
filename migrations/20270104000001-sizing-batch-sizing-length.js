'use strict';
// Sizing batches list: "Sizing length" = the length the sizing party says it sized for the set (optional). Left empty it is the length received (the beams that came in).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE sizing_batches ADD COLUMN "sizingLengthM" numeric(16,2) CHECK ("sizingLengthM" IS NULL OR "sizingLengthM" >= 0)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE sizing_batches DROP COLUMN "sizingLengthM"');
  },
};
