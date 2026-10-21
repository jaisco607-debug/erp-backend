// Granular services (owner 2026-10-20). The super admin now decides EVERY service of a company;
// nothing is given automatically any more (see companyService.create). So that the client's menu
// can match what was given, tabs and items map to services:
//   - services.menuGroup  PRODUCTION | PROCESS | STORE | REPORTS: the tab a service belongs to
//                         (for the super admin screen; the client menu uses the service codes).
//   - services.kind       gets REPORT (one service per report group).
//   - new services        STORE_REPORTS (Store tab > Reports) and nine report services replacing
//                         the single REPORTS service of migration 20261020000001.
// Nobody loses access: every company / user that had REPORTS gets all nine report services (same
// VIEW / FULL), and every company / user that had CHEMICAL_STORE gets STORE_REPORTS.
const REPORTS = [
  ['REPORT_OVERVIEW', 'Overview Report'],
  ['REPORT_GREY', 'Grey / Inward Reports'],
  ['REPORT_SO_CARDS', 'SO Card Reports'],
  ['REPORT_DEPARTMENTS', 'Department Reports'],
  ['REPORT_CHEMICAL_COST', 'Chemical Costing Report'],
  ['REPORT_FOLDING', 'Folding Report'],
  ['REPORT_ACTIVE_FABRIC', 'Active Fabric Report'],
  ['REPORT_PACKING', 'Packing Reports'],
  ['REPORT_GATE_PASSES', 'Gate Pass Report'],
];
const CODES = REPORTS.map(([code]) => code);

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, bind) => queryInterface.sequelize.query(sql, { transaction, bind });
      await q(`ALTER TABLE services ADD COLUMN "menuGroup" varchar(12)
               CHECK ("menuGroup" IN ('PRODUCTION', 'PROCESS', 'STORE', 'REPORTS'))`);
      await q(`ALTER TABLE services DROP CONSTRAINT IF EXISTS services_kind_check`);
      await q(`ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('MODULE', 'PROCESS', 'FOLDING', 'PACKING', 'REPORT'))`);

      const all = [['STORE_REPORTS', 'Store Reports'], ...REPORTS];
      for (const [code, name] of all) {
        await q(`INSERT INTO services (id, code, name, kind, "tracksColour", "sortOrder")
                 SELECT gen_random_uuid(), $1::varchar, $2::varchar, 'REPORT', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
                 WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = $1)`, [code, name]);
      }

      await q(`UPDATE services SET "menuGroup" = 'PRODUCTION' WHERE code IN ('GREY_STORE', 'SO_CARD', 'GATE_PASS')`);
      await q(`UPDATE services SET "menuGroup" = 'PROCESS' WHERE kind IN ('PROCESS', 'FOLDING', 'PACKING')`);
      await q(`UPDATE services SET "menuGroup" = 'STORE' WHERE code IN ('CHEMICAL_STORE', 'GENERAL_STORE', 'STORE_REPORTS')`);
      await q(`UPDATE services SET "menuGroup" = 'REPORTS' WHERE code = ANY($1)`, [CODES]);

      // REPORTS (one service) -> the nine report services
      for (const table of ['company_services', 'user_services']) {
        const who = table === 'company_services' ? '"companyId"' : '"userId", access';
        await q(`INSERT INTO ${table} (${who}, "serviceId")
                 SELECT ${who.split(', ').map((c) => `old.${c}`).join(', ')}, n.id
                   FROM ${table} old JOIN services o ON o.id = old."serviceId" AND o.code = 'REPORTS'
                   CROSS JOIN services n WHERE n.code = ANY($1)
                 ON CONFLICT DO NOTHING`, [CODES]);
        // CHEMICAL_STORE -> STORE_REPORTS (they could read the cost reports before)
        await q(`INSERT INTO ${table} (${who}, "serviceId")
                 SELECT ${who.split(', ').map((c) => `old.${c}`).join(', ')}, n.id
                   FROM ${table} old JOIN services o ON o.id = old."serviceId" AND o.code = 'CHEMICAL_STORE'
                   CROSS JOIN services n WHERE n.code = 'STORE_REPORTS'
                 ON CONFLICT DO NOTHING`);
      }
      await q(`DELETE FROM user_services WHERE "serviceId" IN (SELECT id FROM services WHERE code = 'REPORTS')`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN (SELECT id FROM services WHERE code = 'REPORTS')`);
      await q(`DELETE FROM services WHERE code = 'REPORTS'`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, bind) => queryInterface.sequelize.query(sql, { transaction, bind });
      await q(`INSERT INTO services (id, code, name, kind, "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'REPORTS', 'Reports', 'MODULE', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'REPORTS')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
               SELECT DISTINCT cs."companyId", (SELECT id FROM services WHERE code = 'REPORTS')
                 FROM company_services cs JOIN services s ON s.id = cs."serviceId" WHERE s.code = ANY($1)
               ON CONFLICT DO NOTHING`, [CODES]);
      await q(`INSERT INTO user_services ("userId", access, "serviceId")
               SELECT us."userId", CASE WHEN bool_or(us.access = 'FULL') THEN 'FULL' ELSE 'VIEW' END, (SELECT id FROM services WHERE code = 'REPORTS')
                 FROM user_services us JOIN services s ON s.id = us."serviceId" WHERE s.code = ANY($1) GROUP BY us."userId"
               ON CONFLICT DO NOTHING`, [CODES]);
      const gone = `(SELECT id FROM services WHERE code = 'STORE_REPORTS' OR code = ANY($1))`;
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`, [CODES]);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`, [CODES]);
      await q(`DELETE FROM services WHERE code = 'STORE_REPORTS' OR code = ANY($1)`, [CODES]);
      await q(`ALTER TABLE services DROP CONSTRAINT IF EXISTS services_kind_check`);
      await q(`ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('MODULE', 'PROCESS', 'FOLDING', 'PACKING'))`);
      await q(`ALTER TABLE services DROP COLUMN "menuGroup"`);
    });
  },
};
