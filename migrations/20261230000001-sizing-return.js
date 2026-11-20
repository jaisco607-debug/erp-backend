'use strict';
// Sizing Management > Sizing Return (owner 2026-12-06): yarn and / or empty beams sent to a sizing party on a sizing challan can be called BACK without sizing:
// some beams or all, some bags of yarn or all, only yarn, only beams. Every return is an IN PASS (the same running In Pass number as the sized beam receipts).
//   sizing_returns          the return: In Pass no, date, the sizing party, ref no, notes
//   sizing_return_beams     the beams that came back (AT_SIZING -> EMPTY); prevStatusDate = the day they went to sizing (to undo)
//   sizing_return_yarns     the yarn that came back: a weaving yarn inward entry, bags and lbs (back in the yarn stock)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE sizing_returns (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "inPassNo" integer NOT NULL,
        "returnDate" date NOT NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        "refNo" varchar(50),
        notes varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX sizing_returns_company_no ON sizing_returns ("companyId", "inPassNo")');
      await q('CREATE INDEX sizing_returns_vendor ON sizing_returns ("vendorId")');
      await q(`CREATE TABLE sizing_return_beams (
        id uuid PRIMARY KEY,
        "returnId" uuid NOT NULL REFERENCES sizing_returns(id) ON DELETE CASCADE,
        "beamId" uuid NOT NULL REFERENCES yarn_beams(id),
        "prevStatusDate" date NOT NULL,
        UNIQUE ("returnId", "beamId")
      )`);
      await q('CREATE INDEX sizing_return_beams_beam ON sizing_return_beams ("beamId")');
      await q(`CREATE TABLE sizing_return_yarns (
        id uuid PRIMARY KEY,
        "returnId" uuid NOT NULL REFERENCES sizing_returns(id) ON DELETE CASCADE,
        "inwardId" uuid NOT NULL REFERENCES yarn_inwards(id),
        bags integer NOT NULL CHECK (bags > 0),
        lbs numeric(16,2) NOT NULL CHECK (lbs > 0),
        UNIQUE ("returnId", "inwardId")
      )`);
      await q('CREATE INDEX sizing_return_yarns_inward ON sizing_return_yarns ("inwardId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE sizing_return_yarns');
      await q('DROP TABLE sizing_return_beams');
      await q('DROP TABLE sizing_returns');
    });
  },
};
