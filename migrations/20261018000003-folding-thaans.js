// Folding per thaan (owner, 2026-10-17): every thaan of an SO card that reached Folding is put in
// one grade, A, B or CP (cut piece), with the meters folded (default = the thaan's meters).
// folding_entries.aMeters / bMeters / cpMeters become the sums of these thaans.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE folding_thaans (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "soCardId" uuid NOT NULL REFERENCES so_cards(id),
        "thaanId" uuid NOT NULL REFERENCES grey_lot_thaans(id),
        grade varchar(2) NOT NULL CHECK (grade IN ('A', 'B', 'CP')),
        meters numeric(14,2) NOT NULL CHECK (meters >= 0),
        "createdById" uuid REFERENCES users(id),
        "updatedById" uuid REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("jobId", "thaanId")
      )`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE folding_thaans');
  },
};
