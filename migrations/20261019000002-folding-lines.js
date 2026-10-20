// Folding v3 (owner, 2026-10-19): each thaan's meters are split into A, B and CP (cut piece), lot by
// lot. Lots without thaans get one line for the whole lot. Folding sends the graded meters to
// Packing (sentA / sentB / sentCP); what is not graded or not sent stays in Folding, unless the
// folder closes the row ("all sent, keep nothing").
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE folding_lines (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "soCardId" uuid NOT NULL REFERENCES so_cards(id),
        "greyLotId" uuid NOT NULL REFERENCES grey_lots(id),
        "thaanId" uuid REFERENCES grey_lot_thaans(id),
        "aMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("aMeters" >= 0),
        "bMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("bMeters" >= 0),
        "cpMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("cpMeters" >= 0),
        "sentA" numeric(14,2) NOT NULL DEFAULT 0, "sentB" numeric(14,2) NOT NULL DEFAULT 0, "sentCP" numeric(14,2) NOT NULL DEFAULT 0,
        "updatedById" uuid REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CHECK ("sentA" <= "aMeters" AND "sentB" <= "bMeters" AND "sentCP" <= "cpMeters")
      );
      CREATE UNIQUE INDEX folding_lines_thaan ON folding_lines ("jobId", "soCardId", "greyLotId", COALESCE("thaanId", '00000000-0000-0000-0000-000000000000'));
      ALTER TABLE folding_entries ADD COLUMN "isClosed" boolean NOT NULL DEFAULT false, ADD COLUMN "closeNote" varchar(300),
        ADD COLUMN "closedById" uuid REFERENCES users(id), ADD COLUMN "closedAt" timestamptz`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE folding_lines;
      ALTER TABLE folding_entries DROP COLUMN "isClosed", DROP COLUMN "closeNote", DROP COLUMN "closedById", DROP COLUMN "closedAt"`);
  },
};
