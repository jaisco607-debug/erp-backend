'use strict';
// Accounting settings of a company: the month its fiscal year starts (1 = January ... 12 = December). Pakistan's usual fiscal year is
// July to June, so 7 is the default. It decides whether income and expense accounts may have an opening balance:
// only when the books start in the middle of a fiscal year (see openingBalanceService).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE companies ADD COLUMN "fiscalYearStartMonth" smallint NOT NULL DEFAULT 7 CHECK ("fiscalYearStartMonth" BETWEEN 1 AND 12)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE companies DROP COLUMN "fiscalYearStartMonth"');
  },
};
