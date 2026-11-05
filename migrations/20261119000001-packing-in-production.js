'use strict';
// Packing belongs to Production Management: every service of kind PACKING moves to the PRODUCTION menu group.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`UPDATE services SET "menuGroup" = 'PRODUCTION' WHERE kind = 'PACKING'`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`UPDATE services SET "menuGroup" = 'PROCESS' WHERE kind = 'PACKING'`);
  },
};
