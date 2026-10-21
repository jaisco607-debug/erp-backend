// Reports (owner 2026-10-20): one REPORTS module for every report of the system (grey, SO cards,
// departments, chemical cost, folding, active fabric, packing lists, gate passes). Like every MODULE
// it is given to every company; the client admin gives it to users (VIEW is enough to read reports).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'REPORTS', 'Reports', 'MODULE', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'REPORTS')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
               SELECT c.id, s.id FROM companies c CROSS JOIN services s
               WHERE s.code = 'REPORTS' AND c."deletedAt" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM user_services WHERE "serviceId" IN (SELECT id FROM services WHERE code = 'REPORTS');
      DELETE FROM company_services WHERE "serviceId" IN (SELECT id FROM services WHERE code = 'REPORTS');
      DELETE FROM services WHERE code = 'REPORTS';`);
  },
};
