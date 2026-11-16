'use strict';
// Weaving step 2 (owner 2026-11-11): the Brand master and the yarn Item Card.
//   yarn_brands  like yarn_counts: a unique name per company (any letter case = the same), a running code, soft delete.
//   yarn_items   the item card: yarn count + brand + packing (8, 12, 24, 40; default 24) + bags (50, 100; default 100).
//                The same combination cannot be made twice in a company (deleted cards do not count).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`CREATE TABLE yarn_brands (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        name varchar(80) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_brands_company_name ON yarn_brands ("companyId", lower(name)) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX yarn_brands_company_code ON yarn_brands ("companyId", code)');
      await q(`CREATE TABLE yarn_items (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        code integer NOT NULL,
        "yarnCountId" uuid NOT NULL REFERENCES yarn_counts(id),
        "brandId" uuid NOT NULL REFERENCES yarn_brands(id),
        packing integer NOT NULL DEFAULT 24 CHECK (packing IN (8, 12, 24, 40)),
        bags integer NOT NULL DEFAULT 100 CHECK (bags IN (50, 100)),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX yarn_items_company_combo ON yarn_items ("companyId", "yarnCountId", "brandId", packing, bags) WHERE "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX yarn_items_company_code ON yarn_items ("companyId", code)');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_items');
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS yarn_brands');
  },
};
