'use strict';
// Store Management > Yarn Outward (owner 2026-11-27): the Yarn Store gives yarn to a DEPARTMENT; the department sees what it has and USES it on a Job (optionally one SO card of
// the job); the value of the yarn used is the yarn cost of that Job / SO card, next to its chemical cost.
//   store_yarn_outwards         one outward to a department (outwardNo, date, department, DC no, sent through, totals)
//   store_yarn_outward_lines    the yarn of an inward entry given in it: bags, lbs per bag, the rate per lb of the inward, the value; usedBags = what the department has used
//   store_yarn_usages           one use by the department on a Job (soCardId set = charged to that SO card only; empty = shared between the job's SO cards by meters)
//   store_yarn_usage_lines      which outward line the yarn came from, bags, lbs, value (the cost)
// The department's yarn = outward bags - used bags. The inward's outwardBags goes up with every outward.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE store_yarn_outwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "outwardNo" integer NOT NULL,
        "outwardDate" date NOT NULL,
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "dcNo" varchar(50),
        "sentThrough" varchar(120),
        remarks varchar(300),
        "totalBags" integer NOT NULL,
        "totalLbs" numeric(16,2) NOT NULL,
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX store_yarn_outwards_company_no ON store_yarn_outwards ("companyId", "outwardNo")');
      await q('CREATE INDEX store_yarn_outwards_department ON store_yarn_outwards ("companyId", "departmentId")');
      await q(`CREATE TABLE store_yarn_outward_lines (
        id uuid PRIMARY KEY,
        "outwardId" uuid NOT NULL REFERENCES store_yarn_outwards(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "inwardId" uuid NOT NULL REFERENCES store_yarn_inwards(id),
        bags integer NOT NULL CHECK (bags > 0),
        "lbsPerBag" numeric(12,2) NOT NULL,
        "ratePerLb" numeric(14,4),
        value numeric(16,2) NOT NULL DEFAULT 0,
        "usedBags" integer NOT NULL DEFAULT 0 CHECK ("usedBags" >= 0),
        CHECK ("usedBags" <= bags),
        UNIQUE ("outwardId", "lineNo")
      )`);
      await q('CREATE INDEX store_yarn_outward_lines_inward ON store_yarn_outward_lines ("inwardId")');
      await q(`CREATE TABLE store_yarn_usages (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "usageNo" integer NOT NULL,
        "usageDate" date NOT NULL,
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "soCardId" uuid REFERENCES so_cards(id),
        "totalBags" integer NOT NULL,
        "totalLbs" numeric(16,2) NOT NULL,
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        remarks varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX store_yarn_usages_company_no ON store_yarn_usages ("companyId", "usageNo")');
      await q('CREATE INDEX store_yarn_usages_job ON store_yarn_usages ("jobId")');
      await q('CREATE INDEX store_yarn_usages_card ON store_yarn_usages ("soCardId")');
      await q('CREATE INDEX store_yarn_usages_department ON store_yarn_usages ("companyId", "departmentId")');
      await q(`CREATE TABLE store_yarn_usage_lines (
        id uuid PRIMARY KEY,
        "usageId" uuid NOT NULL REFERENCES store_yarn_usages(id) ON DELETE CASCADE,
        "outwardLineId" uuid NOT NULL REFERENCES store_yarn_outward_lines(id),
        bags integer NOT NULL CHECK (bags > 0),
        lbs numeric(16,2) NOT NULL,
        value numeric(16,2) NOT NULL DEFAULT 0
      )`);
      await q('CREATE INDEX store_yarn_usage_lines_usage ON store_yarn_usage_lines ("usageId")');
      await q('CREATE INDEX store_yarn_usage_lines_outward_line ON store_yarn_usage_lines ("outwardLineId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS store_yarn_usage_lines');
      await q('DROP TABLE IF EXISTS store_yarn_usages');
      await q('DROP TABLE IF EXISTS store_yarn_outward_lines');
      await q('DROP TABLE IF EXISTS store_yarn_outwards');
    });
  },
};
