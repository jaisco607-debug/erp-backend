'use strict';
// Weaving step 5 (owner 2026-11-15): Yarn Return. A vendor or customer does not want their yarn processed (all of it or some bags): we give it back.
//   It is a yarn outward of type RETURN (same challan table, same stock effect) for ONE party:
//   yarn_outwards.customerId / vendorId  the party the yarn goes back to (RETURN only); every line must come from that party's own inward entries.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT IF EXISTS yarn_outwards_type_check');
      await q("ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_type_check CHECK (type IN ('WEFT', 'SALE', 'SIZING', 'RETURN'))");
      await q('ALTER TABLE yarn_outwards ADD COLUMN "customerId" uuid REFERENCES customers(id)');
      await q('ALTER TABLE yarn_outwards ADD COLUMN "vendorId" uuid REFERENCES vendors(id)');
      await q(`ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_return_party CHECK (type <> 'RETURN' OR (("customerId" IS NULL) <> ("vendorId" IS NULL)))`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM yarn_outwards WHERE type = 'RETURN'");
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_return_party');
      await q('ALTER TABLE yarn_outwards DROP COLUMN "vendorId"');
      await q('ALTER TABLE yarn_outwards DROP COLUMN "customerId"');
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_type_check');
      await q("ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_type_check CHECK (type IN ('WEFT', 'SALE', 'SIZING'))");
    });
  },
};
