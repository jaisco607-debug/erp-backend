'use strict';
// Weaving step 4 (owner 2026-11-14): Yarn Outward. First kind: WEFT (yarn sent to the weft). Later kinds on the same tables: SALE (direct yarn sale), SIZING.
//   yarn_outwards       one delivery challan: challanNo (running number of the company, the DC#), date, department (Sulzer, Air jet ...), description.
//   yarn_outward_lines  what goes out on it: a line takes `bags` from ONE yarn inward entry (stock entry); lbs = bags x that entry's lbs per bag.
//   The stock of an inward entry = its bags - the bags of the lines of outwards that are not deleted.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE yarn_outwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        type varchar(12) NOT NULL CHECK (type IN ('WEFT', 'SALE', 'SIZING')),
        "challanNo" integer NOT NULL,
        "outwardDate" date NOT NULL,
        department varchar(50),
        description varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_outwards_company_challan ON yarn_outwards ("companyId", "challanNo")');
      await q('CREATE INDEX yarn_outwards_company_date ON yarn_outwards ("companyId", type, "outwardDate")');
      await q(`CREATE TABLE yarn_outward_lines (
        id uuid PRIMARY KEY,
        "outwardId" uuid NOT NULL REFERENCES yarn_outwards(id) ON DELETE CASCADE,
        "inwardId" uuid NOT NULL REFERENCES yarn_inwards(id),
        bags integer NOT NULL CHECK (bags > 0),
        lbs numeric(16,2) NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("outwardId", "inwardId")
      )`);
      await q('CREATE INDEX yarn_outward_lines_inward ON yarn_outward_lines ("inwardId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_outward_lines');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_outwards');
  },
};
