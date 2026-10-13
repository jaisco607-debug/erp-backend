// Step 2c: which services a client admin gave to each of the company's users, and how much:
//   VIEW  see and print reports only
//   FULL  add and edit too
// A user only ever gets services their company has. When the company loses a service, its users lose it too.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable('user_services', {
        userId: {
          type: Sequelize.UUID, allowNull: false, primaryKey: true,
          references: { model: 'users', key: 'id' }, onDelete: 'CASCADE',
        },
        serviceId: {
          type: Sequelize.UUID, allowNull: false, primaryKey: true,
          references: { model: 'services', key: 'id' }, onDelete: 'CASCADE',
        },
        access: { type: Sequelize.STRING(10), allowNull: false },
        givenById: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE user_services ADD CONSTRAINT user_services_access CHECK (access IN ('VIEW', 'FULL'))`,
        { transaction },
      );
      await queryInterface.addIndex('user_services', ['serviceId'], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_services');
  },
};
