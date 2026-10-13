// SO card fields from the old system's list: ID# (second running number), quality, description,
// and the Conf. (confirmed) toggle.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE so_cards ADD COLUMN "idNo" integer');
      await q('UPDATE so_cards SET "idNo" = "cardNo"');
      await q('ALTER TABLE so_cards ALTER COLUMN "idNo" SET NOT NULL');
      await q('ALTER TABLE so_cards ADD CONSTRAINT so_cards_id_no UNIQUE ("companyId", "idNo")');
      await q('ALTER TABLE so_cards ADD COLUMN "qualityId" uuid REFERENCES qualities(id)');
      await q('ALTER TABLE so_cards ADD COLUMN description varchar(500)');
      await q('ALTER TABLE so_cards ADD COLUMN "isConfirmed" boolean NOT NULL DEFAULT false');
      await q('ALTER TABLE so_cards ADD COLUMN "confirmedById" uuid');
      await q('ALTER TABLE so_cards ADD COLUMN "confirmedAt" timestamptz');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const c of ['"confirmedAt"', '"confirmedById"', '"isConfirmed"', 'description', '"qualityId"', '"idNo"']) {
        await queryInterface.sequelize.query(`ALTER TABLE so_cards DROP COLUMN ${c}`, { transaction });
      }
    });
  },
};
