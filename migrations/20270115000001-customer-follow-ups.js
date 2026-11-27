'use strict';
// Owner plan N-C2 (2026-11-25): the notes of the credit follow-up of a customer (who spoke to him, what he promised, until when). Text only: nothing is sent.
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE customer_follow_ups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "customerId" uuid NOT NULL REFERENCES customers (id),
        "date" date NOT NULL,
        note varchar(1000) NOT NULL,
        "promisedDate" date NULL,
        "promisedAmount" numeric(18,2) NULL CHECK ("promisedAmount" IS NULL OR "promisedAmount" >= 0),
        "createdById" uuid NULL REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await q('CREATE INDEX customer_follow_ups_customer ON customer_follow_ups ("companyId", "customerId", "date" DESC, "createdAt" DESC)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS customer_follow_ups');
  },
};
