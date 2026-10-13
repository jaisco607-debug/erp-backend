// Companies registered before modules were given automatically (2026-10-12) have no Grey Store,
// SO card, etc., so their people get "You do not have this service". This gives the 5 built-in
// modules to every company that is missing them, and writes an audit row per company.
const CORE = ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'PACKING', 'GATE_PASS'];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, bind) => queryInterface.sequelize.query(sql, { bind, transaction, type: queryInterface.sequelize.QueryTypes.SELECT });
      const added = await q(
        `INSERT INTO company_services ("companyId", "serviceId")
         SELECT c.id, s.id
           FROM companies c CROSS JOIN services s
          WHERE c."deletedAt" IS NULL AND s.code = ANY($1) AND s."isActive"
            AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)
         RETURNING "companyId", "serviceId"`,
        [CORE],
      );
      const byCompany = {};
      for (const row of added) (byCompany[row.companyId] ||= []).push(row.serviceId);
      for (const [companyId, serviceIds] of Object.entries(byCompany)) {
        await q(
          `INSERT INTO audit_logs ("actorType", "companyId", action, "entityType", "entityId", after)
           VALUES ('SYSTEM', $1, 'COMPANY_SERVICES_CHANGED', 'Company', $2, $3::jsonb)
           RETURNING id`,
          [companyId, companyId, JSON.stringify({ added: serviceIds, reason: 'built-in modules for older companies' })],
        );
      }
      if (added.length) console.log(`Gave built-in modules to ${Object.keys(byCompany).length} companies.`);
    });
  },

  async down() {
    // Nothing to undo safely: companies may have used these services since.
  },
};
