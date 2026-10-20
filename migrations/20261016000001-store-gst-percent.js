// Store inward: GST is picked from a dropdown (0%, 17%, 18%) and the sales tax is worked out from it.
//   store_inwards."gstPercent"   the picked rate; null = sales tax typed by hand (old entries)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE store_inwards ADD COLUMN "gstPercent" numeric(5,2) CHECK ("gstPercent" >= 0 AND "gstPercent" <= 100)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE store_inwards DROP COLUMN "gstPercent"');
  },
};
