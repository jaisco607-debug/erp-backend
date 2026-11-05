'use strict';
// When HR sets a day by hand the code the machine had worked out is kept, so the screen can show "was L, HR made it P".
// "Recalculate" gives such days back to the machine; hand-set days are otherwise kept through every automatic recalculation.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE payroll_attendance_days ADD COLUMN "originalCode" varchar(2) CHECK ("originalCode" IS NULL OR "originalCode" IN ('P', 'L', 'HD', 'A', 'R', 'AL'))`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE payroll_attendance_days DROP COLUMN IF EXISTS "originalCode"');
  },
};
