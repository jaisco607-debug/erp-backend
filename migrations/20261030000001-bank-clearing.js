'use strict';
// Bank Summary (owner 2026-10-26): the date a cheque / transfer was cleared by the bank, kept OUTSIDE the journal (posted lines never change).
// One row per bank journal line; removing the row = "not cleared". Service ACC_BANK (VIEW reads, FULL sets or removes a clearing date).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE bank_clearings (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "companyId" uuid NOT NULL REFERENCES companies (id),
          "journalLineId" uuid NOT NULL UNIQUE REFERENCES journal_lines (id),
          "clearedDate" date NOT NULL,
          "clearedById" uuid REFERENCES users (id) ON DELETE SET NULL,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )`);
      await q('CREATE INDEX bank_clearings_company ON bank_clearings ("companyId")');
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'ACC_BANK', 'Bank Summary', 'MODULE', 'ACCOUNTS', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'ACC_BANK')`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const gone = `(SELECT id FROM services WHERE code = 'ACC_BANK')`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM services WHERE code = 'ACC_BANK'`);
      await q('DROP TABLE IF EXISTS bank_clearings');
    });
  },
};
