// Users (owner 2026-10-20):
//   phone      optional contact number of an employee / client admin.
//   deletedAt  a client admin can be deleted by the super admin (soft delete: the row stays for the audit
//              log and old records, but the person can never log in again). The email of a deleted
//              person can be used again, so the unique email indexes only count people not deleted.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE users ADD COLUMN phone varchar(30), ADD COLUMN "deletedAt" timestamptz');
      await q('DROP INDEX users_super_admin_email_unique');
      await q('DROP INDEX users_company_email_unique');
      await q('CREATE UNIQUE INDEX users_super_admin_email_unique ON users (lower(email)) WHERE "companyId" IS NULL AND "deletedAt" IS NULL');
      await q('CREATE UNIQUE INDEX users_company_email_unique ON users ("companyId", lower(email)) WHERE "companyId" IS NOT NULL AND "deletedAt" IS NULL');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP INDEX users_super_admin_email_unique');
      await q('DROP INDEX users_company_email_unique');
      await q('CREATE UNIQUE INDEX users_super_admin_email_unique ON users (lower(email)) WHERE "companyId" IS NULL');
      await q('CREATE UNIQUE INDEX users_company_email_unique ON users ("companyId", lower(email)) WHERE "companyId" IS NOT NULL');
      await q('ALTER TABLE users DROP COLUMN phone, DROP COLUMN "deletedAt"');
    });
  },
};
