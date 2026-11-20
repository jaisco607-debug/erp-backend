'use strict';
// Weaving > Looms (owner 2026-12-07): the Loom master and the beams put on a loom.
//   looms              Masters > Loom: a loom no (unique per company), the DEPARTMENT it belongs to (Masters > Department: e.g. Sulzer, Airjet), a running code, active switch, soft delete
//   loom_entries       one "beam entry" on a loom = one K-ID (a running number, a new one every time beams are put on a loom): factor (1 / 2 / 3 panna), loom RPM, loom pick,
//                      reed space (in), start date, end date (loom cut-off), ACTIVE / CUT_OFF, confirmed or not. A loom takes at most 2 beams at a time (checked by the service).
//   loom_entry_beams   the 1 or 2 beams of an entry (FULL -> AT_LOOM; a cut-off makes them EMPTY); lengthM = the beam's meters when it went on, prevStatusDate = since when it was FULL (to undo)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE looms (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        "loomNo" varchar(20) NOT NULL,
        "departmentId" uuid NOT NULL REFERENCES weaving_departments(id),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX looms_company_no ON looms ("companyId", lower("loomNo")) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX looms_company_code ON looms ("companyId", code)');
      await q('CREATE INDEX looms_department ON looms ("departmentId")');
      await q(`CREATE TABLE loom_entries (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "kId" integer NOT NULL,
        "loomId" uuid NOT NULL REFERENCES looms(id),
        factor smallint NOT NULL DEFAULT 1 CHECK (factor IN (1, 2, 3)),
        "loomRpm" integer CHECK ("loomRpm" IS NULL OR "loomRpm" > 0),
        "loomPick" integer CHECK ("loomPick" IS NULL OR "loomPick" > 0),
        "reedSpace" numeric(8,2) CHECK ("reedSpace" IS NULL OR "reedSpace" > 0),
        "startDate" date NOT NULL,
        "endDate" date,
        status varchar(7) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CUT_OFF')),
        "isConfirmed" boolean NOT NULL DEFAULT false,
        "confirmedAt" timestamptz,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX loom_entries_company_kid ON loom_entries ("companyId", "kId")');
      await q('CREATE INDEX loom_entries_loom ON loom_entries ("loomId", status)');
      await q(`CREATE TABLE loom_entry_beams (
        id uuid PRIMARY KEY,
        "entryId" uuid NOT NULL REFERENCES loom_entries(id) ON DELETE CASCADE,
        "beamId" uuid NOT NULL REFERENCES yarn_beams(id),
        "lengthM" numeric(12,2) NOT NULL DEFAULT 0,
        "prevStatusDate" date NOT NULL,
        UNIQUE ("entryId", "beamId")
      )`);
      await q('CREATE INDEX loom_entry_beams_beam ON loom_entry_beams ("beamId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE loom_entry_beams');
      await q('DROP TABLE loom_entries');
      await q('DROP TABLE looms');
    });
  },
};
