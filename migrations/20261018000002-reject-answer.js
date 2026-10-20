// The sender answers a rejection (owner, 2026-10-17): ACCEPTED = reason is valid, cloth stays with
// the sender; DISPUTED = reason not valid, the job goes back to the rejecting department (Queue)
// with the sender's reason, and that department cannot reject it again.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE jobs
      ADD COLUMN "rejectAnswer" varchar(10) CHECK ("rejectAnswer" IN ('ACCEPTED', 'DISPUTED')),
      ADD COLUMN "rejectAnswerReason" varchar(300),
      ADD COLUMN "disputedRejectReason" varchar(300),
      ADD COLUMN "rejectAnswerById" uuid REFERENCES users(id),
      ADD COLUMN "rejectAnswerAt" timestamptz`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE jobs DROP COLUMN "rejectAnswer", DROP COLUMN "rejectAnswerReason",
      DROP COLUMN "disputedRejectReason", DROP COLUMN "rejectAnswerById", DROP COLUMN "rejectAnswerAt"`);
  },
};
