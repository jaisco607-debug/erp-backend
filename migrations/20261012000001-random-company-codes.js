// Company codes are no longer made from the name ("waqas-textile") but at random ("K7QM-4XPA").
// Every existing company gets a new random code here (written to the audit log); its people must log in with the new code.
const { generate } = require('../src/utils/companyCode');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => queryInterface.sequelize.query(sql, { ...opts, transaction });
      await q('ALTER TABLE companies DROP CONSTRAINT companies_code_format');
      const [rows] = await q('SELECT id, code FROM companies');
      const used = new Set();
      for (const { id, code: oldCode } of rows) {
        let code;
        do code = generate(); while (used.has(code));
        used.add(code);
        await q('UPDATE companies SET code = $1 WHERE id = $2', { bind: [code, id] });
        await q(
          `INSERT INTO audit_logs ("actorType", "companyId", action, "entityType", "entityId", before, after, ip, "userAgent")
           VALUES ('SYSTEM', $1, 'COMPANY_CODE_CHANGED', 'Company', $4, $2, $3, 'command-line', 'migration 20261012000001')`,
          { bind: [id, JSON.stringify({ code: oldCode }), JSON.stringify({ code }), id] },
        );
      }
      await q(`ALTER TABLE companies ADD CONSTRAINT companies_code_format CHECK (code ~ '^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$')`);
    });
  },

  async down(queryInterface) {
    // The old name-based codes cannot be brought back; the random ones are kept in small letters.
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE companies DROP CONSTRAINT companies_code_format');
      await q('UPDATE companies SET code = lower(code)');
      await q(`ALTER TABLE companies ADD CONSTRAINT companies_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`);
    });
  },
};
