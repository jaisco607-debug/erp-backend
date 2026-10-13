'use strict';
// Step 2a tables:
//   users           everyone who can log in (super admins, client admins, company users) - one login window
//   refresh_tokens  login sessions (one row per device / browser)
//   audit_logs      who changed what, when, before and after; can never be edited or deleted

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`CREATE TYPE "enum_users_userType" AS ENUM ('SUPER_ADMIN', 'CLIENT_ADMIN', 'USER')`);

    await queryInterface.createTable('users', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      name: { type: Sequelize.STRING(120), allowNull: false },
      email: { type: Sequelize.STRING(200), allowNull: false },
      passwordHash: { type: Sequelize.STRING(100), allowNull: false },
      userType: { type: '"enum_users_userType"', allowNull: false },
      // Empty for super admins; the company for everyone else (link to companies table comes in step 2b).
      companyId: { type: Sequelize.UUID, allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      // Raised to end every session of this user at once (password change, deactivation).
      tokenVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failedLoginCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      lockedUntil: { type: Sequelize.DATE, allowNull: true },
      lastLoginAt: { type: Sequelize.DATE, allowNull: true },
      passwordChangedAt: { type: Sequelize.DATE, allowNull: true },
      createdById: { type: Sequelize.UUID, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    // One email = one person in the whole system, whatever its capital letters.
    await queryInterface.sequelize.query(`CREATE UNIQUE INDEX users_email_unique ON users (lower(email))`);
    await queryInterface.addIndex('users', ['companyId']);
    // A super admin never belongs to a company; everyone else always does.
    await queryInterface.sequelize.query(`
      ALTER TABLE users ADD CONSTRAINT users_company_by_type CHECK (
        ("userType" = 'SUPER_ADMIN' AND "companyId" IS NULL) OR ("userType" <> 'SUPER_ADMIN' AND "companyId" IS NOT NULL)
      )`);

    await queryInterface.createTable('refresh_tokens', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      userId: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      // Only a hash is stored: a stolen database copy cannot be used to log in.
      tokenHash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      expiresAt: { type: Sequelize.DATE, allowNull: false },
      revokedAt: { type: Sequelize.DATE, allowNull: true },
      replacedById: { type: Sequelize.UUID, allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      userAgent: { type: Sequelize.STRING(300), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await queryInterface.addIndex('refresh_tokens', ['userId']);

    await queryInterface.createTable('audit_logs', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      actorId: { type: Sequelize.UUID, allowNull: true },
      actorType: { type: Sequelize.STRING(20), allowNull: true },
      actorEmail: { type: Sequelize.STRING(200), allowNull: true },
      companyId: { type: Sequelize.UUID, allowNull: true },
      action: { type: Sequelize.STRING(60), allowNull: false },
      entityType: { type: Sequelize.STRING(60), allowNull: true },
      entityId: { type: Sequelize.STRING(64), allowNull: true },
      before: { type: Sequelize.JSONB, allowNull: true },
      after: { type: Sequelize.JSONB, allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      userAgent: { type: Sequelize.STRING(300), allowNull: true },
      requestId: { type: Sequelize.STRING(64), allowNull: true },
    });
    await queryInterface.addIndex('audit_logs', ['companyId', 'at']);
    await queryInterface.addIndex('audit_logs', ['entityType', 'entityId']);
    await queryInterface.addIndex('audit_logs', ['actorId', 'at']);

    // The audit log is append-only: the database itself refuses any edit or delete, even from SQL.
    await queryInterface.sequelize.query(`
      CREATE FUNCTION audit_logs_block_change() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_block_change();
      CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_change();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS audit_logs;
      DROP FUNCTION IF EXISTS audit_logs_block_change();
      DROP TABLE IF EXISTS refresh_tokens;
      DROP TABLE IF EXISTS users;
      DROP TYPE IF EXISTS "enum_users_userType";
    `);
  },
};
