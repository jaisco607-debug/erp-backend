// Folding pieces (owner, 2026-10-17): an SO card whose lot was entered in meters only has no thaans.
// Folding then makes its own pieces (thaans) there: meters + grade per piece. Such rows have no
// thaanId but a pieceNo.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE folding_thaans ALTER COLUMN "thaanId" DROP NOT NULL, ADD COLUMN "pieceNo" integer,
        ADD CONSTRAINT folding_thaans_piece CHECK (("thaanId" IS NULL) <> ("pieceNo" IS NULL));
      CREATE UNIQUE INDEX folding_thaans_job_piece ON folding_thaans ("jobId", "soCardId", "pieceNo") WHERE "pieceNo" IS NOT NULL`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DELETE FROM folding_thaans WHERE "pieceNo" IS NOT NULL;
      DROP INDEX folding_thaans_job_piece; ALTER TABLE folding_thaans DROP CONSTRAINT folding_thaans_piece, DROP COLUMN "pieceNo", ALTER COLUMN "thaanId" SET NOT NULL`);
  },
};
