// Customers can be deleted from the screen but stay in the database (deletedAt is set), so old lots
// still show their party. A deleted customer's name and code can be used again for a new one.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE customers ADD COLUMN "deletedAt" timestamptz');
      await q('ALTER TABLE customers DROP CONSTRAINT "customers_companyId_code_key"');
      await q('DROP INDEX customers_company_name');
      await q('CREATE UNIQUE INDEX customers_company_code ON customers ("companyId", code) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX customers_company_name ON customers ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX customers_company_code');
      await q('DROP INDEX customers_company_name');
      await q('DELETE FROM customers WHERE "deletedAt" IS NOT NULL AND id NOT IN (SELECT "customerId" FROM grey_lots)');
      await q('ALTER TABLE customers ADD CONSTRAINT "customers_companyId_code_key" UNIQUE ("companyId", code)');
      await q('CREATE UNIQUE INDEX customers_company_name ON customers ("companyId", lower(name))');
      await q('ALTER TABLE customers DROP COLUMN "deletedAt"');
    });
  },
};
