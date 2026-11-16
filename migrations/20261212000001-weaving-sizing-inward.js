'use strict';
// Weaving step 10 (owner 2026-11-20): Sizing Inward. The sized beams come back from the sizing party (our vendor):
//   yarn_sizing_inwards       one receipt of a SIZING challan (yarn_outwards): inwardNo (running), inwardDate, the party, and
//                             lbsUsed     the lbs of yarn that went into the sizing (the party charges only these)
//                             cutConeKg   the leftover yarn (cut cone) the party gave back, weighed in kg (cutConeLbs = the same in lbs)
//                             ratePerLb / amount   the sizing charge: lbsUsed x rate
//   yarn_sizing_inward_beams  the beams received on it, each with the METERS of sized yarn on it; the beam goes AT_SIZING -> FULL
//   yarn_beams.meters         the meters of sized yarn on a FULL beam
// A challan may be received in parts (some beams now, the rest later).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_beams ADD COLUMN meters numeric(12,2)');
      await q(`CREATE TABLE yarn_sizing_inwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "inwardNo" integer NOT NULL,
        "inwardDate" date NOT NULL,
        "outwardId" uuid NOT NULL REFERENCES yarn_outwards(id),
        "vendorId" uuid NOT NULL REFERENCES vendors(id),
        "lbsUsed" numeric(14,2) NOT NULL CHECK ("lbsUsed" >= 0),
        "cutConeKg" numeric(12,2) NOT NULL DEFAULT 0 CHECK ("cutConeKg" >= 0),
        "cutConeLbs" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("cutConeLbs" >= 0),
        "ratePerLb" numeric(14,4) NOT NULL CHECK ("ratePerLb" >= 0),
        amount numeric(16,2) NOT NULL CHECK (amount >= 0),
        "dcNo" varchar(50),
        description varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_sizing_inwards_company_no ON yarn_sizing_inwards ("companyId", "inwardNo")');
      await q('CREATE INDEX yarn_sizing_inwards_outward ON yarn_sizing_inwards ("outwardId")');
      await q(`CREATE TABLE yarn_sizing_inward_beams (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "inwardId" uuid NOT NULL REFERENCES yarn_sizing_inwards(id) ON DELETE CASCADE,
        "beamId" uuid NOT NULL REFERENCES yarn_beams(id),
        meters numeric(12,2) NOT NULL CHECK (meters > 0),
        "prevStatusDate" date NOT NULL,
        UNIQUE ("inwardId", "beamId")
      )`);
      await q('CREATE INDEX yarn_sizing_inward_beams_beam ON yarn_sizing_inward_beams ("beamId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`UPDATE yarn_beams b SET status = 'AT_SIZING', "statusDate" = x."prevStatusDate", meters = NULL FROM yarn_sizing_inward_beams x JOIN yarn_sizing_inwards i ON i.id = x."inwardId" AND i."deletedAt" IS NULL WHERE x."beamId" = b.id AND b.status = 'FULL'`);
      await q('DROP TABLE yarn_sizing_inward_beams');
      await q('DROP TABLE yarn_sizing_inwards');
      await q('ALTER TABLE yarn_beams DROP COLUMN meters');
    });
  },
};
