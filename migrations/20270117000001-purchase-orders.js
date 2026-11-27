'use strict';
// Owner plan N-D1 (2026-11-26): purchase orders of the STORE only (chemical, general, yarn, fabric) and the goods received against them.
//   purchase_orders / purchase_order_lines   the order. Stored status: DRAFT, APPROVED, CLOSED, CANCELLED. "Partly received" and "Received" are worked out from the inwards.
//   po_settings                              how much over the ordered quantity may be received (percent, standard 5)
//   store_inward_lines, store_yarn_inwards, fabric_inwards   "poLineId" (EMPTY for a purchase without an order) and "poRateNote" (why the rate differs)
//   store_items."orderQty"                   the usual order quantity of an item (used by the low-stock "Create PO")
// Everything added to the existing tables is optional and empty: a purchase without an order works exactly as before.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE purchase_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        store varchar(10) NOT NULL CHECK (store IN ('CHEMICAL', 'GENERAL', 'YARN', 'FABRIC')),
        "poNo" integer NOT NULL,
        "poDate" date NOT NULL,
        "expectedDate" date NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors (id),
        notes varchar(500),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'CLOSED', 'CANCELLED')),
        "approvedById" uuid, "approvedAt" timestamptz,
        "closedById" uuid, "closedAt" timestamptz, "closeReason" varchar(300),
        "cancelledById" uuid, "cancelledAt" timestamptz, "cancelReason" varchar(300),
        "createdById" uuid, "updatedById" uuid,
        "deletedAt" timestamptz, "deletedById" uuid, "deleteReason" varchar(300),
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "poNo")
      )`);
      await q('CREATE INDEX purchase_orders_company ON purchase_orders ("companyId", store, status, "poDate" DESC)');
      await q('CREATE INDEX purchase_orders_vendor ON purchase_orders ("companyId", "vendorId")');
      await q(`CREATE TABLE purchase_order_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "orderId" uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "lineNo" integer NOT NULL,
        "itemId" uuid NULL REFERENCES store_items (id),
        "yarnName" varchar(120), brand varchar(80),
        "qualityId" uuid NULL REFERENCES qualities (id),
        unit varchar(8) NOT NULL,
        qty numeric(16,3) NOT NULL CHECK (qty > 0),
        rate numeric(14,4) NOT NULL CHECK (rate > 0),
        note varchar(200),
        UNIQUE ("orderId", "lineNo")
      )`);
      await q('CREATE INDEX purchase_order_lines_order ON purchase_order_lines ("orderId")');
      await q('CREATE INDEX purchase_order_lines_item ON purchase_order_lines ("companyId", "itemId") WHERE "itemId" IS NOT NULL');
      await q(`CREATE TABLE po_settings (
        "companyId" uuid PRIMARY KEY REFERENCES companies (id),
        "tolerancePercent" numeric(5,2) NOT NULL DEFAULT 5 CHECK ("tolerancePercent" >= 0 AND "tolerancePercent" <= 100),
        "updatedById" uuid, "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      for (const table of ['store_inward_lines', 'store_yarn_inwards', 'fabric_inwards']) {
        await q(`ALTER TABLE ${table} ADD COLUMN "poLineId" uuid NULL REFERENCES purchase_order_lines (id), ADD COLUMN "poRateNote" varchar(300) NULL`);
        await q(`CREATE INDEX ${table}_po ON ${table} ("poLineId") WHERE "poLineId" IS NOT NULL`);
      }
      await q('ALTER TABLE store_items ADD COLUMN "orderQty" numeric(16,3) NULL CHECK ("orderQty" IS NULL OR "orderQty" > 0)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE store_items DROP COLUMN "orderQty"');
      for (const table of ['store_inward_lines', 'store_yarn_inwards', 'fabric_inwards']) await q(`ALTER TABLE ${table} DROP COLUMN "poLineId", DROP COLUMN "poRateNote"`);
      await q('DROP TABLE po_settings; DROP TABLE purchase_order_lines; DROP TABLE purchase_orders');
    });
  },
};
