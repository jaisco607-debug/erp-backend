// Grey lots can be deleted from the screen but stay in the database (deletedAt is set).
// The lot number is never given to another lot.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE grey_lots ADD COLUMN "deletedAt" timestamptz');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE grey_lots DROP COLUMN "deletedAt"');
  },
};
