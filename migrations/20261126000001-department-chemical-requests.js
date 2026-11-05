'use strict';
// Chemical requests per department (owner 2026-11-15). The client admin decides which departments (Dyeing, Stitching ... ) may ask the Chemical Store for chemicals.
//   company_services."chemicalRequests"  true = the department can request chemicals (the default, so nothing changes for departments that already do); false = it cannot: no chemical request or return screens,
//                                        and no chemical field on its jobs, SO cards or Folding. It only matters while the company has the Chemical Store (given by the super admin).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE company_services ADD COLUMN "chemicalRequests" boolean NOT NULL DEFAULT true');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE company_services DROP COLUMN "chemicalRequests"');
  },
};
