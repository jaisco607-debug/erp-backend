// Stock by batch (owner 2026-10-19). The same chemical can come at different rates (40 Rs/kg, then 45),
// from the same or another vendor. Every approved inward line is now its own batch with its own rate.
// The store picks which batch(es) to give a department (or takes the oldest first), so the cost of
// each Job / SO card uses the real rate of each batch.
//   store_batches            one batch per inward line (or opening stock / return / adjustment):
//                            qtyIn, qtyLeft, rate, valueLeft
//   chemical_issue_batches   which batch each sent request line came from: qty, rate, value, returnedQty
// Stock already in the store becomes one OPENING batch per item at its average rate.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE store_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies(id),
        store varchar(10) NOT NULL CHECK (store IN ('CHEMICAL','GENERAL')),
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        source varchar(10) NOT NULL CHECK (source IN ('OPENING','INWARD','RETURN','ADJUST')),
        "inwardId" uuid REFERENCES store_inwards(id),
        "inwardLineId" uuid REFERENCES store_inward_lines(id),
        "vendorId" uuid REFERENCES vendors(id),
        "returnId" uuid REFERENCES chemical_returns(id),
        "adjustmentId" uuid REFERENCES store_adjustments(id),
        "inDate" date NOT NULL,
        rate numeric(16,4) NOT NULL DEFAULT 0,
        "qtyIn" numeric(16,3) NOT NULL,
        "qtyLeft" numeric(16,3) NOT NULL CHECK ("qtyLeft" >= 0),
        "valueLeft" numeric(16,2) NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX store_batches_item ON store_batches ("itemId", "inDate", "createdAt");
      CREATE TABLE chemical_issue_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "requestId" uuid NOT NULL REFERENCES chemical_requests(id),
        "requestLineId" uuid NOT NULL REFERENCES chemical_request_lines(id),
        "batchId" uuid NOT NULL REFERENCES store_batches(id),
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        qty numeric(16,3) NOT NULL CHECK (qty > 0),
        rate numeric(16,4) NOT NULL,
        value numeric(16,2) NOT NULL,
        "returnedQty" numeric(16,3) NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX chemical_issue_batches_batch ON chemical_issue_batches ("batchId");
      CREATE INDEX chemical_issue_batches_line ON chemical_issue_batches ("requestLineId");
      INSERT INTO store_batches ("companyId", store, "itemId", source, "inDate", rate, "qtyIn", "qtyLeft", "valueLeft")
        SELECT "companyId", store, id, 'OPENING', CURRENT_DATE, ROUND("stockValue" / "stockQty", 4), "stockQty", "stockQty", "stockValue"
        FROM store_items WHERE "stockQty" > 0;
    `);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE chemical_issue_batches; DROP TABLE store_batches;');
  },
};
