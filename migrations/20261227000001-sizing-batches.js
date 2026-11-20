'use strict';
// Sizing Management (owner 2026-12-03): a separate module (service SIZING) with the SIZING BATCH.
// Yarn and empty beams go to a sizing party on a yarn outward challan (Weaving); the sized beams (and the cut cones) come back and are linked to a batch:
//   sizing_batches        one batch (= one set): party, set no, ends per beam, yarn count, notes, the yarn tagged to it, the billing (rate, adjustment) and DRAFT / CONFIRMED.
//                         the sums (yarn, cut cones, length, beams, warp weight, net warp weight, amount, actual count) are kept on the row and recalculated on every change.
//   sizing_batch_yarns    the yarn tagged to the batch: a weaving yarn inward entry and the lbs of it
//   sizing_receipts       one "sized beam / cut cones inward" (GRN#) of a batch: its beams (length) and its cut cones (type, kg, cones, bags)
//   purchase_invoice_sizing_batches   a confirmed batch on a SIZING_BATCH purchase invoice (accounts)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'SIZING', 'Sizing Management', 'MODULE', 'WEAVING', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'SIZING')`);
      // every company that has the weaving module gets it
      await q(`INSERT INTO company_services ("companyId", "serviceId")
        SELECT cs."companyId", s.id FROM company_services cs JOIN services w ON w.id = cs."serviceId" AND w.code = 'WEAVING_MASTERS' CROSS JOIN services s
        WHERE s.code = 'SIZING' AND NOT EXISTS (SELECT 1 FROM company_services x WHERE x."companyId" = cs."companyId" AND x."serviceId" = s.id)`);
      await q(`CREATE TABLE sizing_batches (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "batchNo" integer NOT NULL,
        "batchDate" date NOT NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        "setNo" varchar(40) NOT NULL,
        ends integer NOT NULL CHECK (ends > 0),
        "yarnCountId" uuid NOT NULL REFERENCES yarn_counts(id),
        quality varchar(120),
        notes varchar(300),
        status varchar(9) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED')),
        "adjustmentLbs" numeric(10,2) NOT NULL DEFAULT 0 CHECK ("adjustmentLbs" BETWEEN -10 AND 10),
        "ratePerLb" numeric(14,4) CHECK ("ratePerLb" IS NULL OR "ratePerLb" >= 0),
        "yarnLbs" numeric(16,2) NOT NULL DEFAULT 0,
        "yarnLots" integer NOT NULL DEFAULT 0,
        "coneKg" numeric(14,2) NOT NULL DEFAULT 0,
        "coneLbs" numeric(14,2) NOT NULL DEFAULT 0,
        "lengthM" numeric(16,2) NOT NULL DEFAULT 0,
        "beamCount" integer NOT NULL DEFAULT 0,
        "warpWt" numeric(16,2) NOT NULL DEFAULT 0,
        "netWarpWt" numeric(16,2) NOT NULL DEFAULT 0,
        amount numeric(16,2) NOT NULL DEFAULT 0,
        "actualCount" numeric(10,1),
        "confirmedAt" timestamptz,
        "confirmedById" uuid,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX sizing_batches_company_no ON sizing_batches ("companyId", "batchNo")');
      await q('CREATE INDEX sizing_batches_vendor ON sizing_batches ("vendorId")');
      await q(`CREATE TABLE sizing_batch_yarns (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "batchId" uuid NOT NULL REFERENCES sizing_batches(id),
        "inwardId" uuid NOT NULL REFERENCES yarn_inwards(id),
        lbs numeric(16,2) NOT NULL CHECK (lbs > 0),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("batchId", "inwardId")
      )`);
      await q('CREATE INDEX sizing_batch_yarns_inward ON sizing_batch_yarns ("inwardId")');
      await q(`CREATE TABLE sizing_receipts (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "batchId" uuid NOT NULL REFERENCES sizing_batches(id),
        "receiptNo" integer NOT NULL,
        "receiptDate" date NOT NULL,
        "refNo" varchar(50),
        notes varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX sizing_receipts_company_no ON sizing_receipts ("companyId", "receiptNo")');
      await q('CREATE INDEX sizing_receipts_batch ON sizing_receipts ("batchId")');
      await q(`CREATE TABLE sizing_receipt_beams (
        id uuid PRIMARY KEY,
        "receiptId" uuid NOT NULL REFERENCES sizing_receipts(id) ON DELETE CASCADE,
        "beamId" uuid NOT NULL REFERENCES yarn_beams(id),
        "lengthM" numeric(12,2) NOT NULL CHECK ("lengthM" > 0),
        "weightKg" numeric(10,2) CHECK ("weightKg" IS NULL OR "weightKg" > 0),
        "prevStatusDate" date NOT NULL,
        UNIQUE ("receiptId", "beamId")
      )`);
      await q('CREATE INDEX sizing_receipt_beams_beam ON sizing_receipt_beams ("beamId")');
      await q(`CREATE TABLE sizing_receipt_cones (
        id uuid PRIMARY KEY,
        "receiptId" uuid NOT NULL REFERENCES sizing_receipts(id) ON DELETE CASCADE,
        type varchar(40) NOT NULL,
        kg numeric(12,2) NOT NULL CHECK (kg > 0),
        lbs numeric(14,2) NOT NULL,
        cones integer NOT NULL DEFAULT 0 CHECK (cones >= 0),
        bags integer NOT NULL DEFAULT 0 CHECK (bags >= 0)
      )`);
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_kind_check');
      await q('ALTER TABLE purchase_invoices ALTER COLUMN kind TYPE varchar(12)');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING', 'FABRIC', 'STORE_YARN', 'SIZING_BATCH'))");
      await q(`CREATE TABLE purchase_invoice_sizing_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoiceId" uuid NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "lineNo" integer NOT NULL,
        "batchId" uuid NOT NULL UNIQUE REFERENCES sizing_batches(id),
        amount numeric(18,2) NOT NULL CHECK (amount >= 0),
        "salesTax" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("salesTax" >= 0),
        UNIQUE ("invoiceId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_invoice_sizing_batches_invoice ON purchase_invoice_sizing_batches ("invoiceId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("DELETE FROM purchase_invoices WHERE kind = 'SIZING_BATCH'");
      await q('DROP TABLE purchase_invoice_sizing_batches');
      await q('ALTER TABLE purchase_invoices DROP CONSTRAINT purchase_invoices_kind_check');
      await q("ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_kind_check CHECK (kind IN ('STORE', 'YARN', 'SIZING', 'FABRIC', 'STORE_YARN'))");
      await q('DROP TABLE sizing_receipt_cones');
      await q('DROP TABLE sizing_receipt_beams');
      await q('DROP TABLE sizing_receipts');
      await q('DROP TABLE sizing_batch_yarns');
      await q('DROP TABLE sizing_batches');
      const gone = "(SELECT id FROM services WHERE code = 'SIZING')";
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q("DELETE FROM services WHERE code = 'SIZING'");
    });
  },
};
