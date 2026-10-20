// 1) Chemical returns: a department sends unused chemical of a Received request back to the store.
//      chemical_returns        PENDING (sent by department) -> RECEIVED (store took it: stock goes up) / REJECTED / CANCELLED
//      chemical_return_lines   which request line, qty, rate (= the rate it went out at) and value
//      chemical_request_lines.returnedQty / returnedValue and chemical_requests.returnedValue: what came back,
//      so Job / SO card cost = sent value - returned value.
// 2) Stock adjustments: store fixes stock after a count, damage, expiry ... (plus or minus), with a reason.
//      store_adjustments, store_adjustment_lines; store_moves.returnId / adjustmentId.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE chemical_returns (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "returnNo" integer NOT NULL,
        "requestId" uuid NOT NULL REFERENCES chemical_requests(id),
        "departmentId" uuid NOT NULL REFERENCES services(id),
        status varchar(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RECEIVED','REJECTED','CANCELLED')),
        notes varchar(500),
        "rejectReason" varchar(300),
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        "createdById" uuid REFERENCES users(id),
        "receivedById" uuid REFERENCES users(id), "receivedAt" timestamptz,
        "closedById" uuid REFERENCES users(id), "closedAt" timestamptz,
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        UNIQUE ("companyId", "returnNo")
      );
      CREATE TABLE chemical_return_lines (
        id uuid PRIMARY KEY,
        "returnId" uuid NOT NULL REFERENCES chemical_returns(id) ON DELETE CASCADE,
        "requestLineId" uuid NOT NULL REFERENCES chemical_request_lines(id),
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        qty numeric(16,3) NOT NULL CHECK (qty > 0),
        rate numeric(16,4) NOT NULL DEFAULT 0,
        value numeric(16,2) NOT NULL DEFAULT 0
      );
      ALTER TABLE chemical_request_lines
        ADD COLUMN "returnedQty" numeric(16,3) NOT NULL DEFAULT 0,
        ADD COLUMN "returnedValue" numeric(16,2) NOT NULL DEFAULT 0;
      ALTER TABLE chemical_requests ADD COLUMN "returnedValue" numeric(16,2) NOT NULL DEFAULT 0;

      CREATE TABLE store_adjustments (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        store varchar(10) NOT NULL CHECK (store IN ('CHEMICAL','GENERAL')),
        "adjNo" integer NOT NULL,
        "adjDate" date NOT NULL,
        reason varchar(12) NOT NULL CHECK (reason IN ('COUNT','DAMAGED','EXPIRED','LOST','OTHER')),
        notes varchar(500),
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        "createdById" uuid REFERENCES users(id),
        "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        UNIQUE ("companyId", store, "adjNo")
      );
      CREATE TABLE store_adjustment_lines (
        id uuid PRIMARY KEY,
        "adjustmentId" uuid NOT NULL REFERENCES store_adjustments(id) ON DELETE CASCADE,
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        "stockBefore" numeric(16,3) NOT NULL,
        qty numeric(16,3) NOT NULL CHECK (qty <> 0),
        rate numeric(16,4) NOT NULL DEFAULT 0,
        value numeric(16,2) NOT NULL DEFAULT 0
      );
      ALTER TABLE store_moves
        ADD COLUMN "returnId" uuid REFERENCES chemical_returns(id),
        ADD COLUMN "adjustmentId" uuid REFERENCES store_adjustments(id);`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE store_moves DROP COLUMN "returnId", DROP COLUMN "adjustmentId";
      ALTER TABLE chemical_requests DROP COLUMN "returnedValue";
      ALTER TABLE chemical_request_lines DROP COLUMN "returnedQty", DROP COLUMN "returnedValue";
      DROP TABLE store_adjustment_lines, store_adjustments, chemical_return_lines, chemical_returns;`);
  },
};
