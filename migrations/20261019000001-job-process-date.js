// The receiving department's operator also gives the date the cloth was processed (owner, 2026-10-19).
// It can be changed until the cloth is sent on.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE jobs ADD COLUMN "processDate" date');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE jobs DROP COLUMN "processDate"');
  },
};
