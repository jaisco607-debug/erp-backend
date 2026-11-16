'use strict';
// Store Management > Fabric Inward (owner 2026-11-22): cloth BOUGHT from a vendor (the customer's own cloth was spoilt in processing, so we buy new cloth
// from a vendor, process it and give it to the customer). It is the grey inward form with a VENDOR in place of the customer.
//   services          new service FABRIC_STORE (Fabric Store, tab STORE), given to every company like the other stores
//   fabric_inwards    one arrival of cloth from a vendor (number inwardNo, Type# typeNo, quality, unit, totals, width, glm, gsm, approve / active flags)
//   fabric_inward_thaans   the thaans (pieces) of the arrival, each with its length (meters and yards), width and what was taken out (takenMeters, for the outward step)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'FABRIC_STORE', 'Fabric Store', 'MODULE', 'STORE', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'FABRIC_STORE')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
        SELECT c.id, s.id FROM companies c CROSS JOIN services s
        WHERE s.code = 'FABRIC_STORE' AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)`);
      await q(`CREATE TABLE fabric_inwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "inwardNo" integer NOT NULL,
        "typeNo" varchar(20) NOT NULL,
        "dcNo" varchar(50),
        "inwardDate" date NOT NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        "qualityId" uuid NOT NULL REFERENCES qualities(id),
        unit varchar(5) NOT NULL DEFAULT 'METER' CHECK (unit IN ('METER', 'YARD')),
        "inwardMeters" numeric(14,2) NOT NULL,
        "inwardYards" numeric(14,2) NOT NULL,
        pieces integer NOT NULL,
        "outwardMeters" numeric(14,2) NOT NULL DEFAULT 0,
        glm numeric(14,2),
        gsm numeric(14,2),
        width numeric(14,2),
        "partyRef" varchar(80),
        "vehicleNo" varchar(30),
        remarks varchar(500),
        "isApproved" boolean NOT NULL DEFAULT false,
        "approvedById" uuid,
        "approvedAt" timestamptz,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX fabric_inwards_company_no ON fabric_inwards ("companyId", "inwardNo")');
      await q('CREATE INDEX fabric_inwards_company_date ON fabric_inwards ("companyId", "inwardDate")');
      await q('CREATE INDEX fabric_inwards_vendor ON fabric_inwards ("vendorId")');
      await q(`CREATE TABLE fabric_inward_thaans (
        id uuid PRIMARY KEY,
        "inwardId" uuid NOT NULL REFERENCES fabric_inwards(id) ON DELETE CASCADE,
        "thaanNo" integer NOT NULL,
        meters numeric(14,2) NOT NULL,
        yards numeric(14,2) NOT NULL,
        width numeric(14,2),
        status varchar(12) NOT NULL DEFAULT 'IN_STOCK',
        "takenMeters" numeric(14,2) NOT NULL DEFAULT 0
      )`);
      await q('CREATE UNIQUE INDEX fabric_inward_thaans_no ON fabric_inward_thaans ("inwardId", "thaanNo")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS fabric_inward_thaans');
      await q('DROP TABLE IF EXISTS fabric_inwards');
      const gone = "(SELECT id FROM services WHERE code = 'FABRIC_STORE')";
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q("DELETE FROM services WHERE code = 'FABRIC_STORE'");
    });
  },
};
