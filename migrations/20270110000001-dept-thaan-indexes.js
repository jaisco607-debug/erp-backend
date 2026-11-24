'use strict';
// Folding and Packing look up their lines by the department thaan: an index for each.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS folding_lines_dept_thaan ON folding_lines ("deptThaanId") WHERE "deptThaanId" IS NOT NULL');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS packing_list_lines_dept_thaan ON packing_list_lines ("deptThaanId") WHERE "deptThaanId" IS NOT NULL');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS packing_list_lines_dept_thaan');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS folding_lines_dept_thaan');
  },
};
