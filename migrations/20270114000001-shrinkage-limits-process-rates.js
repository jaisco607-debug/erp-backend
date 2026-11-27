'use strict';
// Owner plan N-B4 and N-C1 (2026-11-25), settings only; both reports read the data that is already there.
//   shrinkage_limits  the shrinkage the owner expects, in percent, per department and quality (quality empty = every quality of that department)
//   process_rates     what a department charges per meter, from a date (the "department charge" and the "packing cost" of the SO card margin)
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE shrinkage_limits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "departmentId" uuid NOT NULL REFERENCES services (id),
        "qualityId" uuid NULL REFERENCES qualities (id),
        "limitPercent" numeric(6,2) NOT NULL CHECK ("limitPercent" >= 0 AND "limitPercent" <= 100),
        "updatedById" uuid NULL REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await q(`CREATE UNIQUE INDEX shrinkage_limits_unique ON shrinkage_limits ("companyId", "departmentId", COALESCE("qualityId", '00000000-0000-0000-0000-000000000000'::uuid))`);
    await q('CREATE INDEX shrinkage_limits_company ON shrinkage_limits ("companyId")');
    await q(`
      CREATE TABLE process_rates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "departmentId" uuid NOT NULL REFERENCES services (id),
        "ratePerMeter" numeric(12,4) NOT NULL CHECK ("ratePerMeter" >= 0),
        "effectiveFrom" date NOT NULL,
        "createdById" uuid NULL REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "departmentId", "effectiveFrom")
      )`);
    await q('CREATE INDEX process_rates_company ON process_rates ("companyId", "departmentId", "effectiveFrom" DESC)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS process_rates; DROP TABLE IF EXISTS shrinkage_limits;');
  },
};
