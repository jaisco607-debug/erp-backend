'use strict';
// Store Management > Fabric Issue to an SO card (owner 2026-11-22): cloth bought from a vendor (Fabric Inward) goes on an SO card, for a customer,
// optionally LINKED to the earlier SO card whose cloth was spoilt (that cloth is being replaced).
//   fabric_issues         one issue = some thaans / meters of one fabric inward taken out of the Fabric Store for a customer
//                         (issueNo, date, customer, linkedSoCardId optional, the grey lot it made, meters, pieces; cancelledAt when undone)
//   grey_lots.source      'CUSTOMER' (cloth the customer gave: the normal grey inward) or 'STORE' (cloth from the Fabric Store). A STORE lot is a normal approved lot of the
//                         customer, so the whole SO card flow (thaans, jobs, folding, packing, reports) works unchanged. grey_lots.fabricIssueId says which issue made it.
//   fabric_inward_thaans.issueId   the issue that took the thaan
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE grey_lots ADD COLUMN source varchar(10) NOT NULL DEFAULT 'CUSTOMER' CHECK (source IN ('CUSTOMER', 'STORE'))`);
      await q('ALTER TABLE grey_lots ADD COLUMN "fabricIssueId" uuid');
      await q(`CREATE TABLE fabric_issues (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "issueNo" integer NOT NULL,
        "issueDate" date NOT NULL,
        "fabricInwardId" uuid NOT NULL REFERENCES fabric_inwards(id),
        "customerId" uuid NOT NULL REFERENCES customers(id),
        "linkedSoCardId" uuid REFERENCES so_cards(id),
        "greyLotId" uuid NOT NULL REFERENCES grey_lots(id),
        meters numeric(14,2) NOT NULL CHECK (meters > 0),
        pieces integer NOT NULL DEFAULT 0,
        remarks varchar(300),
        "createdById" uuid,
        "cancelledAt" timestamptz,
        "cancelledById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX fabric_issues_company_no ON fabric_issues ("companyId", "issueNo")');
      await q('CREATE INDEX fabric_issues_inward ON fabric_issues ("fabricInwardId")');
      await q('CREATE INDEX fabric_issues_customer ON fabric_issues ("customerId")');
      await q('CREATE INDEX fabric_issues_linked ON fabric_issues ("linkedSoCardId")');
      await q('ALTER TABLE fabric_inward_thaans ADD COLUMN "issueId" uuid');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE fabric_inward_thaans DROP COLUMN "issueId"');
      await q('DROP TABLE IF EXISTS fabric_issues');
      await q('ALTER TABLE grey_lots DROP COLUMN "fabricIssueId"');
      await q('ALTER TABLE grey_lots DROP COLUMN source');
    });
  },
};
