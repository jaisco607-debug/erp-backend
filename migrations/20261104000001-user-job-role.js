'use strict';
// Job roles of employees (owner 2026-10-30): users.jobRole is a label (Employee, Manager, Accountant, Store Manager ...) chosen by the client admin,
// used to show who the person is and to filter the employee list. It gives no permissions. The list of roles lives in src/utils/jobRoles.js
// (no database check, so a role can be added without a migration). Existing employees become EMPLOYEE; admins have none.
module.exports = {
  async up(queryInterface) {
    const run = (sql) => queryInterface.sequelize.query(sql);
    await run('ALTER TABLE users ADD COLUMN IF NOT EXISTS "jobRole" varchar(30)');
    await run(`UPDATE users SET "jobRole" = 'EMPLOYEE' WHERE "userType" = 'USER' AND "jobRole" IS NULL`);
    await run('CREATE INDEX IF NOT EXISTS users_company_job_role ON users ("companyId", "jobRole")');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_company_job_role');
    await queryInterface.sequelize.query('ALTER TABLE users DROP COLUMN IF EXISTS "jobRole"');
  },
};
