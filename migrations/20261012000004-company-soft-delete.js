// A deleted company is hidden, not wiped: its records and audit trail stay in the database.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('companies', 'deletedAt', { type: Sequelize.DATE, allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('companies', 'deletedAt');
  },
};
