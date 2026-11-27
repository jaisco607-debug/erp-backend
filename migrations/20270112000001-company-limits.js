'use strict';
// Owner 2026-11-25 (A2.1, A1.1): every company sets its own limits on the numbers that come in (meters, quantities, bags ...) and its date rules.
// One row per company; no row = the standard values of src/config/limits.js. Rates have no limit and are not here.
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE company_limits (
        "companyId" uuid PRIMARY KEY REFERENCES companies (id) ON DELETE CASCADE,
        "allQuantities" numeric(16,0) NULL CHECK ("allQuantities" IS NULL OR "allQuantities" > 0),
        "limits" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "openingDate" date NULL,
        "maxFutureDaysStock" integer NOT NULL DEFAULT 0 CHECK ("maxFutureDaysStock" BETWEEN 0 AND 365),
        "maxFutureDaysVouchers" integer NOT NULL DEFAULT 31 CHECK ("maxFutureDaysVouchers" BETWEEN 0 AND 365),
        "updatedById" uuid NULL REFERENCES users (id) ON DELETE SET NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS company_limits');
  },
};
