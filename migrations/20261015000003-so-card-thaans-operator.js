// SO card thaan-wise, lot balances on the card, and the operator name on a job.
//   grey_lot_thaans.status     + SO_CARD: the thaan went on an SO card (soCardLotId says which)
//   so_card_lots.outBefore / balanceBefore   the lot's figures just before this card took cloth,
//                              so the card can show "gone before / now going / left after"
//   jobs.operatorName          typed by the receiving department (the SO card desk does not know it)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        ALTER TABLE grey_lot_thaans DROP CONSTRAINT IF EXISTS grey_lot_thaans_status_check;
        ALTER TABLE grey_lot_thaans ADD CONSTRAINT grey_lot_thaans_status_check CHECK (status IN ('IN_STOCK', 'RETURNED', 'SO_CARD'));
        ALTER TABLE grey_lot_thaans ADD COLUMN "soCardLotId" uuid REFERENCES so_card_lots(id);
        CREATE INDEX grey_lot_thaans_so_card_lot ON grey_lot_thaans ("soCardLotId");
        ALTER TABLE so_card_lots ADD COLUMN "outBefore" numeric(14,2), ADD COLUMN "balanceBefore" numeric(14,2);
        ALTER TABLE jobs ADD COLUMN "operatorName" varchar(80), ADD COLUMN "operatorSetById" uuid, ADD COLUMN "operatorSetAt" timestamptz;`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE jobs DROP COLUMN "operatorName", DROP COLUMN "operatorSetById", DROP COLUMN "operatorSetAt";
      ALTER TABLE so_card_lots DROP COLUMN "outBefore", DROP COLUMN "balanceBefore";
      UPDATE grey_lot_thaans SET status = 'IN_STOCK' WHERE status = 'SO_CARD';
      ALTER TABLE grey_lot_thaans DROP COLUMN "soCardLotId";
      ALTER TABLE grey_lot_thaans DROP CONSTRAINT grey_lot_thaans_status_check;
      ALTER TABLE grey_lot_thaans ADD CONSTRAINT grey_lot_thaans_status_check CHECK (status IN ('IN_STOCK', 'RETURNED'));`);
  },
};
