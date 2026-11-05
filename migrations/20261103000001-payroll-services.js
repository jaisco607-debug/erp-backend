'use strict';
// Payroll module (owner 2026-10-30): a new tab PAYROLL in services.menuGroup and four services the super admin can give to companies and the
// client admin to employees, like Accounting / Store. Only the switches for now: the payroll screens and their endpoints come later.
const GROUPS = "'PRODUCTION', 'PROCESS', 'STORE', 'REPORTS', 'ACCOUNTS'";
const SERVICES = [
  ['PAYROLL_SALARY', 'Payroll Salary'], // Payroll Summary, Overtime, Attendance Summary
  ['PAYROLL_REPORTS', 'Payroll Reports'], // Annual Leaves, Employees Contribution, Salary Tax Report
  ['PAYROLL_APPLICATIONS', 'Payroll Applications'], // Leave, Resignation, Joining, Employee Loan applications
  ['PAYROLL_EMPLOYEES', 'Payroll Employees'], // Employees Profile (master card)
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN (${GROUPS}, 'PAYROLL'))`);
      for (const [code, name] of SERVICES) {
        await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
          SELECT gen_random_uuid(), :code, :name, 'MODULE', 'PAYROLL', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
          WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = :code)`, { code, name });
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const codes = SERVICES.map(([code]) => code);
      const gone = '(SELECT id FROM services WHERE code IN (:codes))';
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`, { codes });
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`, { codes });
      await q('DELETE FROM services WHERE code IN (:codes)', { codes });
      await q('ALTER TABLE services DROP CONSTRAINT IF EXISTS "services_menuGroup_check"');
      await q(`ALTER TABLE services ADD CONSTRAINT "services_menuGroup_check" CHECK ("menuGroup" IN (${GROUPS}))`);
    });
  },
};
