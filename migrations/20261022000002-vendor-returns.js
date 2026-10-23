'use strict';
// Return of bought stock to the vendor (owner 2026-10-22): 3 drums bought, 1 drum bad, the party takes it back.
//   store_vendor_returns / _lines   the return (vendor, reason, which purchase line / batch, qty, the batch's rate)
//   store_moves.vendorReturnId      the stock movement it makes (kind VENDOR_RETURN, negative)
//   store_batches.vendorReturnedQty how much of a batch went back to the vendor (qtyLeft goes down, qtyIn stays)
//   store_items.reorderLevel        minimum stock; below it the item shows in the low-stock report
//   store_inward_lines pack*        optional: 3 drums x 200 kg (the quantity is still kept in kg / litres)
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      ALTER TABLE store_inward_lines ADD COLUMN "packType" varchar(10), ADD COLUMN "packCount" integer, ADD COLUMN "qtyPerPack" numeric(16,3);
      ALTER TABLE store_items ADD COLUMN "reorderLevel" numeric(16,3) CHECK ("reorderLevel" >= 0);
      ALTER TABLE store_batches ADD COLUMN "vendorReturnedQty" numeric(16,3) NOT NULL DEFAULT 0;
      CREATE TABLE store_vendor_returns (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies(id),
        store varchar(10) NOT NULL CHECK (store IN ('CHEMICAL','GENERAL')),
        "returnNo" integer NOT NULL,
        "returnDate" date NOT NULL,
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        reason varchar(12) NOT NULL CHECK (reason IN ('DAMAGED','WRONG_ITEM','EXPIRED','QUALITY','EXCESS','OTHER')),
        notes varchar(500),
        "totalValue" numeric(16,2) NOT NULL DEFAULT 0,
        status varchar(10) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','CANCELLED')),
        "createdById" uuid REFERENCES users(id),
        "cancelledById" uuid REFERENCES users(id), "cancelledAt" timestamptz, "cancelReason" varchar(300),
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", store, "returnNo")
      );
      CREATE TABLE store_vendor_return_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "returnId" uuid NOT NULL REFERENCES store_vendor_returns(id) ON DELETE CASCADE,
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        "inwardId" uuid NOT NULL REFERENCES store_inwards(id),
        "inwardLineId" uuid NOT NULL REFERENCES store_inward_lines(id),
        "batchId" uuid NOT NULL REFERENCES store_batches(id),
        qty numeric(16,3) NOT NULL CHECK (qty > 0),
        rate numeric(16,4) NOT NULL DEFAULT 0,
        value numeric(16,2) NOT NULL DEFAULT 0,
        "packType" varchar(10), "packCount" integer, "qtyPerPack" numeric(16,3)
      );
      CREATE INDEX store_vendor_returns_vendor ON store_vendor_returns ("vendorId");
      CREATE INDEX store_vendor_return_lines_return ON store_vendor_return_lines ("returnId");
      ALTER TABLE store_moves ADD COLUMN "vendorReturnId" uuid REFERENCES store_vendor_returns(id);`);
  },
  async down(q) {
    await q.sequelize.query(`
      ALTER TABLE store_moves DROP COLUMN "vendorReturnId";
      DROP TABLE store_vendor_return_lines, store_vendor_returns;
      ALTER TABLE store_items DROP COLUMN "reorderLevel";
      ALTER TABLE store_batches DROP COLUMN "vendorReturnedQty";
      ALTER TABLE store_inward_lines DROP COLUMN "packType", DROP COLUMN "packCount", DROP COLUMN "qtyPerPack";`);
  },
};
