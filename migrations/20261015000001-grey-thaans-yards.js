// Grey inward per thaan (piece), yards, and cloth given back to the party unprocessed.
//   grey_lots.unit            METER or YARD: the unit the grey store typed in (the party's unit)
//   grey_lots.inwardYards     the same quantity in yards (always kept, so screens can show both)
//   grey_lots.returnedMeters/returnedPieces  cloth given back to the party without processing
//   grey_lot_thaans           one row per thaan of a lot: thaan no, meters, yards, IN_STOCK / RETURNED
//   grey_returns              one "given back" entry (return no, date, which thaans)
// Old lots get yards worked out from their meters (1 yard = 0.9144 m); they have no thaan rows.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        ALTER TABLE grey_lots
          ADD COLUMN unit varchar(5) NOT NULL DEFAULT 'METER' CHECK (unit IN ('METER', 'YARD')),
          ADD COLUMN "inwardYards" numeric(14,2),
          ADD COLUMN "returnedMeters" numeric(14,2) NOT NULL DEFAULT 0,
          ADD COLUMN "returnedPieces" integer NOT NULL DEFAULT 0;
        UPDATE grey_lots SET "inwardYards" = round("inwardMeters" / 0.9144, 2);
        ALTER TABLE grey_lots ALTER COLUMN "inwardYards" SET NOT NULL;`);
      await q(`
        CREATE TABLE grey_returns (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "lotId" uuid NOT NULL REFERENCES grey_lots(id),
          "returnNo" integer NOT NULL,
          "returnDate" date NOT NULL,
          pieces integer NOT NULL,
          meters numeric(14,2) NOT NULL,
          yards numeric(14,2) NOT NULL,
          "vehicleNo" varchar(30),
          remarks varchar(500),
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "returnNo")
        );
        CREATE TABLE grey_lot_thaans (
          id uuid PRIMARY KEY,
          "lotId" uuid NOT NULL REFERENCES grey_lots(id),
          "thaanNo" integer NOT NULL,
          meters numeric(14,2) NOT NULL CHECK (meters > 0),
          yards numeric(14,2) NOT NULL CHECK (yards > 0),
          status varchar(12) NOT NULL DEFAULT 'IN_STOCK' CHECK (status IN ('IN_STOCK', 'RETURNED')),
          "returnId" uuid REFERENCES grey_returns(id),
          UNIQUE ("lotId", "thaanNo")
        );`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE grey_lot_thaans, grey_returns;
      ALTER TABLE grey_lots DROP COLUMN unit, DROP COLUMN "inwardYards", DROP COLUMN "returnedMeters", DROP COLUMN "returnedPieces";`);
  },
};
