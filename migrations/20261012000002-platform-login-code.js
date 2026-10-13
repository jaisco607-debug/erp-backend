// Super admins get a login code too, one code shared by all of them (e.g. "R4TW-9KXE").
// Now everyone types company code + email + password on the same login screen.
// The code is kept in the one-row table "platform". It never equals a company's code.
const { generate } = require('../src/utils/companyCode');

const FORMAT = `'^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'`;

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, opts = {}) => queryInterface.sequelize.query(sql, { ...opts, transaction });
      await queryInterface.createTable('platform', {
        id: { type: Sequelize.INTEGER, primaryKey: true, defaultValue: 1 },
        superAdminCode: { type: Sequelize.STRING(20), allowNull: false, unique: true },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }, { transaction });
      await q('ALTER TABLE platform ADD CONSTRAINT platform_one_row CHECK (id = 1)');
      await q(`ALTER TABLE platform ADD CONSTRAINT platform_code_format CHECK ("superAdminCode" ~ ${FORMAT})`);

      let code;
      for (;;) {
        code = generate();
        const [taken] = await q('SELECT 1 FROM companies WHERE code = $1', { bind: [code] });
        if (!taken.length) break;
      }
      await q('INSERT INTO platform (id, "superAdminCode") VALUES (1, $1)', { bind: [code] });
      await q(
        `INSERT INTO audit_logs ("actorType", action, "entityType", "entityId", after, ip, "userAgent")
         VALUES ('SYSTEM', 'SUPER_ADMIN_CODE_CHANGED', 'Platform', '1', $1, 'command-line', 'migration 20261012000002')`,
        { bind: [JSON.stringify({ code })] },
      );
    });
    // Shown once here; later: "npm run superadmin:code" or GET /api/v1/super-admins/login-code
    console.log('\n  Super admin login code:', (await queryInterface.sequelize.query('SELECT "superAdminCode" FROM platform'))[0][0].superAdminCode, '\n');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('platform');
  },
};
