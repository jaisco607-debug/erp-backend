// SO card order details (from the production manual): delivery date, article / style, instructions.
// Job: the work instructions given when cloth is sent to a department.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE so_cards ADD COLUMN "deliveryDate" date, ADD COLUMN article varchar(150), ADD COLUMN instructions varchar(1000);
      ALTER TABLE jobs ADD COLUMN instructions varchar(1000);`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE so_cards DROP COLUMN "deliveryDate", DROP COLUMN article, DROP COLUMN instructions;
      ALTER TABLE jobs DROP COLUMN instructions;`);
  },
};
