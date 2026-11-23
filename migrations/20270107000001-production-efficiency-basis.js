'use strict';
// Depart wise & efficiency report (owner 2026-11-21): the basis of the efficiency kept per department:
//   blocks         the loom blocks ("departs") of the report, e.g. 1 to 8, 9 to 18 ... [{ from, to }]
//   minRunUnits    a loom is "running" on a day when it gave at least this many units (default 1)
//   defaultRpm     the RPM taken for a loom that has no RPM on its beam entry (default 239)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE production_policies ADD COLUMN blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN "minRunUnits" numeric(10,2) NOT NULL DEFAULT 1 CHECK ("minRunUnits" >= 0), ADD COLUMN "defaultRpm" integer NOT NULL DEFAULT 239 CHECK ("defaultRpm" > 0)`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE production_policies DROP COLUMN blocks, DROP COLUMN "minRunUnits", DROP COLUMN "defaultRpm"');
  },
};
