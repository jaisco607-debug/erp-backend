'use strict';
// Weaving > Contracts (owner 2026-12-02): two yarn contracts.
//   PURCHASE  "Contract Yarn Purchase"            with a VENDOR   (we buy yarn; the contract on a yarn inward is optional)
//   OVERHEAD  "Weaving Overhead Sell Contract"    with a CUSTOMER (the customer sends us his yarn to weave; a yarn inward of a customer needs a contract)
//   yarn_contracts        the header (running code per company and kind, party, dates, terms, sales tax %, OPEN / CLOSED)
//   yarn_contract_lines   one line per yarn quality (= yarn count): bags, bag weight, lbs, rate, amount, closed or active
//   yarn_inwards.contractLineId   the contract line an inward entry counts against (balance = ordered lbs - inward lbs)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE yarn_contracts (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        kind varchar(8) NOT NULL CHECK (kind IN ('PURCHASE', 'OVERHEAD')),
        code integer NOT NULL,
        "vendorId" uuid REFERENCES vendors(id),
        "customerId" uuid REFERENCES customers(id),
        "contractDate" date NOT NULL,
        "deliveryDate" date,
        "termsDays" integer NOT NULL DEFAULT 0,
        notes varchar(300),
        "taxPercent" numeric(5,2) NOT NULL DEFAULT 0 CHECK ("taxPercent" >= 0),
        status varchar(6) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CHECK ((kind = 'PURCHASE' AND "vendorId" IS NOT NULL AND "customerId" IS NULL) OR (kind = 'OVERHEAD' AND "customerId" IS NOT NULL AND "vendorId" IS NULL))
      )`);
      await q('CREATE UNIQUE INDEX yarn_contracts_company_kind_code ON yarn_contracts ("companyId", kind, code)');
      await q('CREATE INDEX yarn_contracts_vendor ON yarn_contracts ("vendorId")');
      await q('CREATE INDEX yarn_contracts_customer ON yarn_contracts ("customerId")');
      await q(`CREATE TABLE yarn_contract_lines (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "contractId" uuid NOT NULL REFERENCES yarn_contracts(id),
        "lineNo" integer NOT NULL,
        "yarnCountId" uuid NOT NULL REFERENCES yarn_counts(id),
        bags integer CHECK (bags IS NULL OR bags > 0),
        "bagWeight" numeric(12,2) CHECK ("bagWeight" IS NULL OR "bagWeight" > 0),
        lbs numeric(16,2) NOT NULL CHECK (lbs > 0),
        "ratePerLb" numeric(14,4) CHECK ("ratePerLb" IS NULL OR "ratePerLb" >= 0),
        amount numeric(16,2),
        "isClosed" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX yarn_contract_lines_no ON yarn_contract_lines ("contractId", "lineNo")');
      await q('ALTER TABLE yarn_inwards ADD COLUMN "contractLineId" uuid REFERENCES yarn_contract_lines(id)');
      await q('CREATE INDEX yarn_inwards_contract_line ON yarn_inwards ("contractLineId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE yarn_inwards DROP COLUMN "contractLineId"');
      await q('DROP TABLE IF EXISTS yarn_contract_lines');
      await q('DROP TABLE IF EXISTS yarn_contracts');
    });
  },
};
