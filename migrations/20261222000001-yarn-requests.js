'use strict';
// Yarn requests (owner 2026-11-28): a department asks the Yarn Store for yarn for one of its Jobs (optionally one SO card), exactly like a chemical request:
//   PENDING (Queue) -> ACCEPTED (Process) -> IN_WAY (the store sent it) -> DELIVERED (the department received it);  CANCELLED by the department / REJECTED by the store.
//   company_services.yarnRequests   the client admin decides which departments may request yarn (like chemicalRequests); OFF until the client admin switches a department on
//   yarn_requests / yarn_request_lines      the request: the yarn asked for is typed (yarn name, brand, bags)
//   yarn_request_allocations                what the store assigned to a line: bags of an approved yarn inward, with the weight and rate of a bag (so the value is fixed)
//   store_yarn_outwards.requestId / store_yarn_usages.requestId   sending a request makes a Yarn Outward to the department AND a use on the request's Job / SO card in one go,
//                                                                 so the stock, the ledger and the Job / SO card yarn cost follow from it like every outward
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE company_services ADD COLUMN "yarnRequests" boolean NOT NULL DEFAULT false');
      await q(`CREATE TABLE yarn_requests (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "reqNo" integer NOT NULL,
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "soCardId" uuid REFERENCES so_cards(id),
        status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'IN_WAY', 'DELIVERED', 'CANCELLED', 'REJECTED')),
        notes varchar(500),
        "rejectReason" varchar(300),
        "sentThrough" varchar(120),
        "totalBags" integer NOT NULL DEFAULT 0,
        "sentBags" integer NOT NULL DEFAULT 0,
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        "outwardId" uuid,
        "usageId" uuid,
        "requestedById" uuid, "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "acceptedById" uuid, "acceptedAt" timestamptz,
        "sentById" uuid, "sentAt" timestamptz,
        "receivedById" uuid, "receivedAt" timestamptz,
        "closedById" uuid, "closedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX yarn_requests_company_no ON yarn_requests ("companyId", "reqNo")');
      await q('CREATE INDEX yarn_requests_department ON yarn_requests ("companyId", "departmentId", status)');
      await q('CREATE INDEX yarn_requests_job ON yarn_requests ("jobId")');
      await q(`CREATE TABLE yarn_request_lines (
        id uuid PRIMARY KEY,
        "requestId" uuid NOT NULL REFERENCES yarn_requests(id) ON DELETE CASCADE,
        "lineNo" integer NOT NULL,
        "yarnName" varchar(120) NOT NULL,
        brand varchar(80),
        bags integer NOT NULL CHECK (bags > 0),
        "sentBags" integer,
        value numeric(16,2) NOT NULL DEFAULT 0,
        UNIQUE ("requestId", "lineNo")
      )`);
      await q(`CREATE TABLE yarn_request_allocations (
        id uuid PRIMARY KEY,
        "lineId" uuid NOT NULL REFERENCES yarn_request_lines(id) ON DELETE CASCADE,
        "inwardId" uuid NOT NULL REFERENCES store_yarn_inwards(id),
        bags integer NOT NULL CHECK (bags > 0),
        "lbsPerBag" numeric(12,2) NOT NULL,
        "ratePerLb" numeric(14,4),
        value numeric(16,2) NOT NULL DEFAULT 0
      )`);
      await q('CREATE INDEX yarn_request_allocations_line ON yarn_request_allocations ("lineId")');
      await q('ALTER TABLE store_yarn_outwards ADD COLUMN "requestId" uuid REFERENCES yarn_requests(id)');
      await q('ALTER TABLE store_yarn_usages ADD COLUMN "requestId" uuid REFERENCES yarn_requests(id)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE store_yarn_usages DROP COLUMN "requestId"');
      await q('ALTER TABLE store_yarn_outwards DROP COLUMN "requestId"');
      await q('DROP TABLE IF EXISTS yarn_request_allocations');
      await q('DROP TABLE IF EXISTS yarn_request_lines');
      await q('DROP TABLE IF EXISTS yarn_requests');
      await q('ALTER TABLE company_services DROP COLUMN "yarnRequests"');
    });
  },
};
