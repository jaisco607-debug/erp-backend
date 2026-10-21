// Edit locks (frontend request, 2026-10-21): while one person has a record open for editing, nobody else can edit it.
// One live row per (company, resource). A lock lives 90 seconds and the browser renews it every 30 s, so a closed
// browser frees the record on its own; an expired row counts as free and is overwritten by the next person.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE edit_locks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
          "resourceType" varchar(40) NOT NULL,
          "resourceId" varchar(100) NOT NULL,
          "userId" uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
          "tabId" varchar(100) NOT NULL,
          "acquiredAt" timestamptz NOT NULL DEFAULT now(),
          "expiresAt" timestamptz NOT NULL
        )`);
      await q('CREATE UNIQUE INDEX edit_locks_resource_unique ON edit_locks ("companyId", "resourceType", "resourceId")');
      await q('CREATE INDEX edit_locks_user ON edit_locks ("userId")');
      await q('CREATE INDEX edit_locks_expires ON edit_locks ("expiresAt")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE edit_locks');
  },
};
