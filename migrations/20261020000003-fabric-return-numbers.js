// Fabric return grey gets its own numbers (owner 2026-10-20): FR-1, FR-2 ... The SO card numbers stay
// continuous, because fabric returns no longer take an SO# (and an ID#).
// A fabric return is an so_cards row with isGreyReturn = true, so the two numberings are told apart by
// that flag: the same number may exist once as an SO card (5) and once as a fabric return (FR-5).
// Fabric returns made before this keep the number they have (shown as FR-<number>); new ones continue
// from the highest of them. The counters are fabric_return_card_no / fabric_return_id_no (company_counters).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE so_cards DROP CONSTRAINT IF EXISTS "so_cards_companyId_cardNo_key"');
      await q('ALTER TABLE so_cards DROP CONSTRAINT IF EXISTS so_cards_id_no');
      await q('CREATE UNIQUE INDEX so_cards_card_no ON so_cards ("companyId", "isGreyReturn", "cardNo")');
      await q('CREATE UNIQUE INDEX so_cards_id_no_series ON so_cards ("companyId", "isGreyReturn", "idNo")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX so_cards_card_no');
      await q('DROP INDEX so_cards_id_no_series');
      // fails when a fabric return and an SO card now share a number: renumber the fabric returns first
      await q('ALTER TABLE so_cards ADD CONSTRAINT "so_cards_companyId_cardNo_key" UNIQUE ("companyId", "cardNo")');
      await q('ALTER TABLE so_cards ADD CONSTRAINT so_cards_id_no UNIQUE ("companyId", "idNo")');
    });
  },
};
