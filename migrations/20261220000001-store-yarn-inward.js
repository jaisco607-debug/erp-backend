'use strict';
// Store Management > Yarn Inward (owner 2026-11-26): yarn (dhaaga) BOUGHT from a vendor for processing, entered in the Store. Unlike the weaving yarn inward there is NO yarn count /
// item card master: the yarn name, brand, bags, lbs per bag and the rate per lb are typed on the form; only the vendor is picked.
//   services               new service YARN_STORE (Yarn Store, tab STORE), given to every company like the other stores
//   store_yarn_inwards     one arrival of yarn from a vendor: bags x lbsPerBag = totalLbs; totalLbs x ratePerLb = amount (empty until a rate is given);
//                          outwardBags is what has gone out (the outward step comes next), so the stock = bags - outwardBags
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'YARN_STORE', 'Yarn Store', 'MODULE', 'STORE', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'YARN_STORE')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
        SELECT c.id, s.id FROM companies c CROSS JOIN services s
        WHERE s.code = 'YARN_STORE' AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)`);
      await q(`CREATE TABLE store_yarn_inwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "inwardNo" integer NOT NULL,
        "inwardDate" date NOT NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        "yarnName" varchar(120) NOT NULL,
        brand varchar(80),
        bags integer NOT NULL CHECK (bags > 0),
        "lbsPerBag" numeric(12,2) NOT NULL CHECK ("lbsPerBag" > 0),
        "totalLbs" numeric(16,2) NOT NULL,
        "ratePerLb" numeric(14,4),
        amount numeric(16,2),
        "outwardBags" integer NOT NULL DEFAULT 0 CHECK ("outwardBags" >= 0),
        "dcNo" varchar(50),
        remarks varchar(300),
        "isApproved" boolean NOT NULL DEFAULT false,
        "approvedById" uuid,
        "approvedAt" timestamptz,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CHECK ("outwardBags" <= bags)
      )`);
      await q('CREATE UNIQUE INDEX store_yarn_inwards_company_no ON store_yarn_inwards ("companyId", "inwardNo")');
      await q('CREATE INDEX store_yarn_inwards_company_date ON store_yarn_inwards ("companyId", "inwardDate")');
      await q('CREATE INDEX store_yarn_inwards_vendor ON store_yarn_inwards ("vendorId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS store_yarn_inwards');
      const gone = "(SELECT id FROM services WHERE code = 'YARN_STORE')";
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q("DELETE FROM services WHERE code = 'YARN_STORE'");
    });
  },
};
