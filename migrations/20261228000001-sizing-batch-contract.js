'use strict';
// Sizing Batch (owner 2026-12-04): a batch can be tagged to an OVERHEAD contract (Weaving > Contracts, "Weaving Overhead Sell Contract"): the customer whose yarn is sized "on account".
//   sizing_batches.contractId   optional; the customer is the one of the contract
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE sizing_batches ADD COLUMN "contractId" uuid REFERENCES yarn_contracts(id)');
    await queryInterface.sequelize.query('CREATE INDEX sizing_batches_contract ON sizing_batches ("contractId")');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE sizing_batches DROP COLUMN "contractId"');
  },
};
