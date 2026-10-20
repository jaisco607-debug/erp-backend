// Step 6: Folding.
//   folding_entries  one row per SO card inside a job that reached a FOLDING department:
//                    page no of the folding register, meters graded A, B and CP (cut piece),
//                    and the Conf. toggle. Unconfirmed rows are the "Draft" tab.
//   jobs.isRework    cloth sent back from Folding to a department for re-processing.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE folding_entries (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "jobId" uuid NOT NULL REFERENCES jobs(id),
          "soCardId" uuid NOT NULL REFERENCES so_cards(id),
          "pageNo" varchar(30),
          "aMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("aMeters" >= 0),
          "bMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("bMeters" >= 0),
          "cpMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("cpMeters" >= 0),
          "isConfirmed" boolean NOT NULL DEFAULT false,
          "confirmedById" uuid,
          "confirmedAt" timestamptz,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("jobId", "soCardId")
        )`);
      await q('ALTER TABLE jobs ADD COLUMN "isRework" boolean NOT NULL DEFAULT false');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE folding_entries; ALTER TABLE jobs DROP COLUMN "isRework";');
  },
};
