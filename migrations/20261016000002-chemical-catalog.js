// Chemical Store: the same item name may be in two categories (e.g. "RED" under two dye groups),
// so item names are unique per category, not per store. Then the client's default chemical
// catalog (categories + items) is copied into every company. Re-running adds only what is missing.
const { seed } = require('../src/services/chemicalCatalogService');

module.exports = {
  async up(queryInterface) {
    const s = queryInterface.sequelize;
    await s.transaction(async (transaction) => {
      await s.query(`DROP INDEX IF EXISTS store_items_name;
        CREATE UNIQUE INDEX store_items_name ON store_items ("companyId", store, COALESCE("categoryId", '00000000-0000-0000-0000-000000000000'::uuid), lower(name));`, { transaction });
      const [companies] = await s.query('SELECT id FROM companies WHERE "deletedAt" IS NULL', { transaction });
      for (const c of companies) await seed(s, c.id, transaction);
    });
  },
  async down(queryInterface) {
    // the catalog rows stay (they may be in use); only the old unique rule comes back
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS store_items_name;
      CREATE UNIQUE INDEX store_items_name ON store_items ("companyId", store, lower(name));`);
  },
};
