'use strict';
// Weaving step 3 (owner 2026-11-12): Yarn Inward.
//   The customers and vendors are the SAME tables as everywhere else (customers, vendors): the weaving screens only open them under the weaving service.
//   yarn_inwards: one entry = one item card received from a vendor (PURCHASE yarn) or from a customer (OVERHEAD yarn: the customer's own yarn).
//     exactly one of customerId / vendorId is set (the party decides the type)
//     bags x lbsPerBag = totalLbs;  totalLbs x ratePerLb = amount  (rate is required for a purchase, optional for overhead yarn)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE yarn_inwards (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        "inwardDate" date NOT NULL,
        "customerId" uuid REFERENCES customers(id),
        "vendorId" uuid REFERENCES vendors(id),
        "itemId" uuid NOT NULL REFERENCES yarn_items(id),
        bags integer NOT NULL CHECK (bags > 0),
        "lbsPerBag" numeric(12,2) NOT NULL CHECK ("lbsPerBag" > 0),
        "totalLbs" numeric(16,2) NOT NULL,
        "ratePerLb" numeric(14,4),
        amount numeric(16,2),
        "dcNo" varchar(50),
        remarks varchar(300),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CHECK (("customerId" IS NULL) <> ("vendorId" IS NULL)),
        CHECK ("vendorId" IS NULL OR "ratePerLb" IS NOT NULL)
      )`);
      await q('CREATE UNIQUE INDEX yarn_inwards_company_code ON yarn_inwards ("companyId", code)');
      await q('CREATE INDEX yarn_inwards_company_date ON yarn_inwards ("companyId", "inwardDate")');
      await q('CREATE INDEX yarn_inwards_item ON yarn_inwards ("itemId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_inwards');
  },
};
