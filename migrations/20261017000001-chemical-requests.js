// Department chemical requests (Step 8).
//   chemical_requests        one request from a department for one Job (optionally one SO card of it)
//       status: PENDING (store: Queue) -> ACCEPTED (store: Process) -> IN_WAY -> DELIVERED (department: Received)
//               PENDING -> CANCELLED (by the department) / REJECTED (by the store)
//   chemical_request_lines   the chemicals: qty asked, qty sent, rate (store average at send) and value
//   store_moves.requestId    an ISSUE move points at its request (stock goes out when the store sends)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE chemical_requests (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "reqNo" integer NOT NULL,
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "soCardId" uuid REFERENCES so_cards(id),
        status varchar(12) NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'ACCEPTED', 'IN_WAY', 'DELIVERED', 'CANCELLED', 'REJECTED')),
        notes varchar(500),
        "rejectReason" varchar(300),
        "sentThrough" varchar(120),
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        "requestedById" uuid, "requestedAt" timestamptz NOT NULL DEFAULT now(),
        "acceptedById" uuid, "acceptedAt" timestamptz,
        "sentById" uuid, "sentAt" timestamptz,
        "receivedById" uuid, "receivedAt" timestamptz,
        "closedById" uuid, "closedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "reqNo")
      );
      CREATE INDEX chemical_requests_job ON chemical_requests ("jobId");
      CREATE INDEX chemical_requests_status ON chemical_requests ("companyId", status);
      CREATE TABLE chemical_request_lines (
        id uuid PRIMARY KEY,
        "requestId" uuid NOT NULL REFERENCES chemical_requests(id) ON DELETE CASCADE,
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        qty numeric(16,3) NOT NULL CHECK (qty > 0),
        "sentQty" numeric(16,3) CHECK ("sentQty" >= 0),
        rate numeric(16,4),
        value numeric(16,2) NOT NULL DEFAULT 0,
        "sortOrder" integer NOT NULL DEFAULT 0
      );
      ALTER TABLE store_moves ADD COLUMN "requestId" uuid REFERENCES chemical_requests(id);`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE store_moves DROP COLUMN "requestId";
      DROP TABLE chemical_request_lines, chemical_requests;`);
  },
};
