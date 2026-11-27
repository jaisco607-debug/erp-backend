'use strict';
// Deleted items (owner 2026-11-25, N-A1): a deleted grey lot waits in "Deleted items" where it can be reverted or deleted for good.
// Deleted for good = the lot, its thaans and its returns leave the database tables (so the lot number is free again) and ONE record of it is kept here, as a copy.
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE deleted_items_archive (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        kind varchar(20) NOT NULL,
        "originalId" uuid NOT NULL,
        "itemNo" integer NULL,
        title varchar(250) NOT NULL,
        snapshot jsonb NOT NULL,
        "deletedById" uuid NULL,
        "deletedAt" timestamptz NULL,
        "deleteReason" varchar(300) NULL,
        "purgedById" uuid NULL,
        "purgedAt" timestamptz NOT NULL DEFAULT now(),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await q('CREATE INDEX deleted_items_archive_company ON deleted_items_archive ("companyId", kind, "purgedAt" DESC)');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS deleted_items_archive');
  },
};
