'use strict';
// Cloth sent back to the SO card desk (owner 2026-11-13). A department that received cloth straight from an SO card can return it (all of a job, or only some of its SO cards).
// A returned job keeps status REJECTED (every list and calculation already leaves a rejected job out, so the meters are free at the SO card desk again) and these marks:
//   jobs."returnedToSoCard"   true for a job that was returned to the SO card
//   jobs."returnReason"       why (optional)
//   jobs."returnedAt/ById"    when and by whom
//   jobs."returnedFromJobId"  when only some of a job's SO cards were returned, they move to a new job of their own; this is the job they were cut from
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE jobs
        ADD COLUMN "returnedToSoCard" boolean NOT NULL DEFAULT false,
        ADD COLUMN "returnReason" varchar(300),
        ADD COLUMN "returnedAt" timestamptz,
        ADD COLUMN "returnedById" uuid REFERENCES users (id) ON DELETE SET NULL,
        ADD COLUMN "returnedFromJobId" uuid REFERENCES jobs (id) ON DELETE SET NULL;`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE jobs DROP COLUMN "returnedFromJobId", DROP COLUMN "returnedById", DROP COLUMN "returnedAt", DROP COLUMN "returnReason", DROP COLUMN "returnedToSoCard";`);
  },
};
