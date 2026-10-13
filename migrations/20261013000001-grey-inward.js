// Step 3: grey (fabric) inward.
//   customers         the parties who send cloth, numbered per company (e.g. AZ TEXTILES (130))
//   qualities         cloth qualities, e.g. CANVAS 10X7/72X30=65.50"
//   grey_lots         one row per arrival of cloth; each arrival gets its own lot number,
//                     even when the party thinks it sent everything at once
//   company_counters  the next lot / type number of each company (locked while a lot is saved,
//                     so two people saving at the same moment never get the same number)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE customers (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          code integer NOT NULL CHECK (code > 0),
          name varchar(150) NOT NULL,
          phone varchar(30),
          address varchar(300),
          "isActive" boolean NOT NULL DEFAULT true,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", code)
        )`);
      await q(`CREATE UNIQUE INDEX customers_company_name ON customers ("companyId", lower(name))`);

      await q(`
        CREATE TABLE qualities (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          name varchar(150) NOT NULL,
          "isActive" boolean NOT NULL DEFAULT true,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )`);
      await q(`CREATE UNIQUE INDEX qualities_company_name ON qualities ("companyId", lower(name))`);

      await q(`
        CREATE TABLE company_counters (
          "companyId" uuid NOT NULL REFERENCES companies(id),
          name varchar(40) NOT NULL,
          "nextValue" integer NOT NULL CHECK ("nextValue" > 0),
          PRIMARY KEY ("companyId", name)
        )`);

      await q(`
        CREATE TABLE grey_lots (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "lotNo" integer NOT NULL CHECK ("lotNo" > 0),
          "typeNo" varchar(20) NOT NULL,
          "dcNo" varchar(50),
          "inwardDate" date NOT NULL,
          "customerId" uuid NOT NULL REFERENCES customers(id),
          "qualityId" uuid NOT NULL REFERENCES qualities(id),
          "inwardMeters" numeric(14,2) NOT NULL CHECK ("inwardMeters" > 0),
          pieces integer NOT NULL CHECK (pieces >= 0),
          "outwardMeters" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("outwardMeters" >= 0 AND "outwardMeters" <= "inwardMeters"),
          "partyRef" varchar(80),
          "vehicleNo" varchar(30),
          remarks varchar(500),
          "isReprocess" boolean NOT NULL DEFAULT false,
          "reprocessOfLotId" uuid REFERENCES grey_lots(id),
          "isApproved" boolean NOT NULL DEFAULT false,
          "approvedById" uuid,
          "approvedAt" timestamptz,
          "isActive" boolean NOT NULL DEFAULT true,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "lotNo"),
          UNIQUE ("companyId", "typeNo"),
          CHECK ("reprocessOfLotId" IS NULL OR "isReprocess")
        )`);
      await q(`CREATE INDEX grey_lots_company_date ON grey_lots ("companyId", "inwardDate" DESC)`);
      await q(`CREATE INDEX grey_lots_customer ON grey_lots ("customerId")`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const t of ['grey_lots', 'company_counters', 'qualities', 'customers']) {
        await queryInterface.sequelize.query(`DROP TABLE ${t}`, { transaction });
      }
    });
  },
};
