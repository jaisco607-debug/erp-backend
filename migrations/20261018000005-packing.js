// Packing (owner, 2026-10-17): Packing becomes a department (kind PACKING). It only gets cloth from
// Folding and only presses Receive / Accept. On each SO card it makes packing lists: every thaan of
// every lot of the card with its meters and category (A, B, CP), rates per category, amounts.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE services DROP CONSTRAINT IF EXISTS services_kind_check`);
      await q(`ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('MODULE', 'PROCESS', 'FOLDING', 'PACKING'))`);
      await q(`UPDATE services SET kind = 'PACKING', name = 'Packing' WHERE code = 'PACKING'`);
      await q(`
        CREATE TABLE packing_lists (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "listNo" integer NOT NULL,
          "soCardId" uuid NOT NULL REFERENCES so_cards(id),
          "listDate" date NOT NULL,
          status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINAL')),
          description varchar(300), "madeFor" varchar(120), "ctnQty" integer, "netWeight" numeric(12,2), "grossWeight" numeric(12,2), remarks varchar(500),
          "rateA" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateA" >= 0),
          "rateB" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateB" >= 0),
          "rateCP" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("rateCP" >= 0),
          "createdById" uuid REFERENCES users(id), "updatedById" uuid REFERENCES users(id),
          "finalizedById" uuid REFERENCES users(id), "finalizedAt" timestamptz,
          "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "listNo")
        )`);
      await q(`
        CREATE TABLE packing_list_lines (
          id uuid PRIMARY KEY,
          "packingListId" uuid NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
          "lineNo" integer NOT NULL,
          "greyLotId" uuid NOT NULL REFERENCES grey_lots(id),
          "thaanId" uuid REFERENCES grey_lot_thaans(id),
          "thaanNo" integer NOT NULL,
          grade varchar(2) NOT NULL CHECK (grade IN ('A', 'B', 'CP')),
          meters numeric(14,2) NOT NULL CHECK (meters > 0)
        )`);
      await q(`CREATE INDEX packing_lists_so ON packing_lists ("soCardId")`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TABLE packing_list_lines; DROP TABLE packing_lists;
      UPDATE services SET kind = 'MODULE', name = 'Packing List' WHERE code = 'PACKING';
      ALTER TABLE services DROP CONSTRAINT services_kind_check;
      ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('MODULE', 'PROCESS', 'FOLDING'))`);
  },
};
