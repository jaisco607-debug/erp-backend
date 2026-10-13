// Qualities can be deleted from the screen but stay in the database (deletedAt is set), so old lots
// still show their quality. A deleted quality's name can be used again.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE qualities ADD COLUMN "deletedAt" timestamptz');
      await q('DROP INDEX qualities_company_name');
      await q('CREATE UNIQUE INDEX qualities_company_name ON qualities ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX qualities_company_name');
      await q('DELETE FROM qualities WHERE "deletedAt" IS NOT NULL AND id NOT IN (SELECT "qualityId" FROM grey_lots)');
      await q('CREATE UNIQUE INDEX qualities_company_name ON qualities ("companyId", lower(name))');
      await q('ALTER TABLE qualities DROP COLUMN "deletedAt"');
    });
  },
};
