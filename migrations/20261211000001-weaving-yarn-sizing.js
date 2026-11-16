'use strict';
// Weaving step 9 (owner 2026-11-19): Yarn Outward > Sizing. Yarn bags AND empty beams go out to a sizing party (outsourced: our VENDOR, we pay it for the work) on ONE challan.
//   yarn_outwards (type SIZING)  vendorId = the sizing party; its lines take bags from yarn inward entries (like every outward); its beams are in yarn_outward_beams.
//   yarn_outward_beams           the beams on the challan: each goes EMPTY -> AT_SIZING (yarn_beams.status); prevStatus / prevStatusDate put it back if the challan is changed or deleted.
//   yarn_inwards.directVendorId  YARN THAT NEVER CAME TO OUR FACTORY: the supplier delivered it straight to the sizing party. It is entered as an inward (so it is in the stock and
//                                paid for as any purchase) but marked with the sizing party. It can only go out on a SIZING challan of that party, and its bags are on the challan
//                                but NOT on the gate pass (the yarn did not leave our factory).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_inwards ADD COLUMN "directVendorId" uuid REFERENCES vendors(id)');
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_party_rule');
      await q(`ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_party_rule CHECK (
        (type <> 'RETURN' OR (("customerId" IS NULL) <> ("vendorId" IS NULL)))
        AND (type <> 'SALE' OR ("customerId" IS NOT NULL AND "vendorId" IS NULL))
        AND (type <> 'SIZING' OR ("vendorId" IS NOT NULL AND "customerId" IS NULL)))`);
      await q(`CREATE TABLE yarn_outward_beams (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "outwardId" uuid NOT NULL REFERENCES yarn_outwards(id) ON DELETE CASCADE,
        "beamId" uuid NOT NULL REFERENCES yarn_beams(id),
        "prevStatus" varchar(10) NOT NULL,
        "prevStatusDate" date NOT NULL,
        UNIQUE ("outwardId", "beamId")
      )`);
      await q('CREATE INDEX yarn_outward_beams_beam ON yarn_outward_beams ("beamId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q("UPDATE yarn_beams b SET status = x.\"prevStatus\", \"statusDate\" = x.\"prevStatusDate\" FROM yarn_outward_beams x JOIN yarn_outwards o ON o.id = x.\"outwardId\" AND o.\"deletedAt\" IS NULL WHERE x.\"beamId\" = b.id");
      await q('DROP TABLE yarn_outward_beams');
      await q("DELETE FROM yarn_outward_lines WHERE \"outwardId\" IN (SELECT id FROM yarn_outwards WHERE type = 'SIZING')");
      await q("DELETE FROM yarn_outwards WHERE type = 'SIZING'");
      await q('ALTER TABLE yarn_outwards DROP CONSTRAINT yarn_outwards_party_rule');
      await q(`ALTER TABLE yarn_outwards ADD CONSTRAINT yarn_outwards_party_rule CHECK (
        (type <> 'RETURN' OR (("customerId" IS NULL) <> ("vendorId" IS NULL)))
        AND (type <> 'SALE' OR ("customerId" IS NOT NULL AND "vendorId" IS NULL)))`);
      await q('ALTER TABLE yarn_inwards DROP COLUMN "directVendorId"');
    });
  },
};
