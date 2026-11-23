'use strict';
// Folding and Packing work per thaan. A thaan can now be one that a DEPARTMENT made (job_item_thaans, see 20270108000001), not only a grey lot thaan:
//   folding_lines.deptThaanId        the department thaan that was graded (A / B / CP); thaanId stays for grey lot thaans
//   packing_list_lines.deptThaanId   the department thaan on a packing list line
// One folding line is one thaan of one lot of one SO card in one job: the unique index now looks at both columns.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE folding_lines ADD COLUMN "deptThaanId" uuid REFERENCES job_item_thaans(id)');
      await q('DROP INDEX folding_lines_thaan');
      await q(`CREATE UNIQUE INDEX folding_lines_thaan ON folding_lines ("jobId", "soCardId", "greyLotId", COALESCE("thaanId", '00000000-0000-0000-0000-000000000000'), COALESCE("deptThaanId", '00000000-0000-0000-0000-000000000000'))`);
      await q('ALTER TABLE packing_list_lines ADD COLUMN "deptThaanId" uuid REFERENCES job_item_thaans(id)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE packing_list_lines DROP COLUMN "deptThaanId"');
      await q('DROP INDEX folding_lines_thaan');
      await q(`CREATE UNIQUE INDEX folding_lines_thaan ON folding_lines ("jobId", "soCardId", "greyLotId", COALESCE("thaanId", '00000000-0000-0000-0000-000000000000'))`);
      await q('ALTER TABLE folding_lines DROP COLUMN "deptThaanId"');
    });
  },
};
