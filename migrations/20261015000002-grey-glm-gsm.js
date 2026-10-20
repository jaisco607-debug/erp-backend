// Grey lot cloth weight: GLM (grams per linear meter) and GSM (grams per square meter). Both optional.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE grey_lots ADD COLUMN glm numeric(10,2), ADD COLUMN gsm numeric(10,2);');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE grey_lots DROP COLUMN glm, DROP COLUMN gsm;');
  },
};
