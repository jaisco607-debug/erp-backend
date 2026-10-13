// Step 4: SO card (travel card).
//   so_cards         one card per batch of cloth taken out of grey for processing
//   so_card_lots     which grey lots the card's cloth came from and how many meters of each
//                    (one card can take from one lot or several lots of the same party)
//   so_card_moves    every time the card is sent to a department (Singeing, Dyeing ...):
//                    to which department, through whom, when, and when that department accepted it
// Taking meters for a card raises grey_lots."outwardMeters", so the lot's balance goes down;
// the existing check (outward <= inward) makes it impossible to take more than the lot has.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE so_cards (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "cardNo" integer NOT NULL CHECK ("cardNo" > 0),
          "cardDate" date NOT NULL,
          "customerId" uuid NOT NULL REFERENCES customers(id),
          "totalMeters" numeric(14,2) NOT NULL CHECK ("totalMeters" > 0),
          "totalPieces" integer NOT NULL DEFAULT 0 CHECK ("totalPieces" >= 0),
          "isReprocess" boolean NOT NULL DEFAULT false,
          status varchar(20) NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'SENT', 'IN_DEPARTMENT')),
          "currentDepartmentId" uuid REFERENCES services(id),
          remarks varchar(500),
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          "deletedAt" timestamptz,
          UNIQUE ("companyId", "cardNo")
        )`);
      await q(`CREATE INDEX so_cards_company_date ON so_cards ("companyId", "cardDate" DESC)`);

      await q(`
        CREATE TABLE so_card_lots (
          id uuid PRIMARY KEY,
          "soCardId" uuid NOT NULL REFERENCES so_cards(id),
          "greyLotId" uuid NOT NULL REFERENCES grey_lots(id),
          meters numeric(14,2) NOT NULL CHECK (meters > 0),
          pieces integer NOT NULL DEFAULT 0 CHECK (pieces >= 0),
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("soCardId", "greyLotId")
        )`);
      await q(`CREATE INDEX so_card_lots_lot ON so_card_lots ("greyLotId")`);

      await q(`
        CREATE TABLE so_card_moves (
          id uuid PRIMARY KEY,
          "soCardId" uuid NOT NULL REFERENCES so_cards(id),
          "fromDepartmentId" uuid REFERENCES services(id),
          "toDepartmentId" uuid NOT NULL REFERENCES services(id),
          "sentThrough" varchar(120),
          remarks varchar(500),
          "sentById" uuid,
          "sentAt" timestamptz NOT NULL DEFAULT now(),
          "acceptedById" uuid,
          "acceptedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )`);
      await q(`CREATE INDEX so_card_moves_card ON so_card_moves ("soCardId", "sentAt")`);
      // only one open (not yet accepted) move per card
      await q(`CREATE UNIQUE INDEX so_card_moves_one_open ON so_card_moves ("soCardId") WHERE "acceptedAt" IS NULL`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const t of ['so_card_moves', 'so_card_lots', 'so_cards']) {
        await queryInterface.sequelize.query(`DROP TABLE ${t}`, { transaction });
      }
    });
  },
};
