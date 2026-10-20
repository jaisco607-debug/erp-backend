// Why a department rejected a job ("Kapra nahi mila"), shown to the sender on the Rejected tab.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE jobs ADD COLUMN "rejectReason" varchar(300)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE jobs DROP COLUMN "rejectReason"');
  },
};
