'use strict';
// Weaving Production Control (owner 2026-12-08): the production register of the looms (service WEAVING_PRODUCTION).
//   production_weavers        the weaver attendance of the LOOMS (not the payroll attendance): who works which shift (A / B / C) of a department on a day. The employees come from Payroll (department Weaving).
//   production_weaver_looms   the looms given to a weaver for a shift of a day (a loom has one weaver per shift)
//   production_units          the units of a loom for a shift of a day (1 unit = 1,000 picks of the loom counter) and the K-ID (loom entry) that was running on it
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'WEAVING_PRODUCTION', 'Weaving Production', 'MODULE', 'WEAVING', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'WEAVING_PRODUCTION')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
        SELECT cs."companyId", s.id FROM company_services cs JOIN services w ON w.id = cs."serviceId" AND w.code = 'WEAVING_MASTERS' CROSS JOIN services s
        WHERE s.code = 'WEAVING_PRODUCTION' AND NOT EXISTS (SELECT 1 FROM company_services x WHERE x."companyId" = cs."companyId" AND x."serviceId" = s.id)`);
      await q(`CREATE TABLE production_weavers (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES weaving_departments(id),
        "workDate" date NOT NULL,
        shift char(1) NOT NULL CHECK (shift IN ('A', 'B', 'C')),
        "employeeId" uuid NOT NULL REFERENCES payroll_employees(id),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "departmentId", "workDate", shift, "employeeId")
      )`);
      await q('CREATE INDEX production_weavers_day ON production_weavers ("companyId", "workDate", "departmentId")');
      await q(`CREATE TABLE production_weaver_looms (
        id uuid PRIMARY KEY,
        "weaverId" uuid NOT NULL REFERENCES production_weavers(id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "workDate" date NOT NULL,
        shift char(1) NOT NULL,
        "loomId" uuid NOT NULL REFERENCES looms(id),
        UNIQUE ("companyId", "workDate", shift, "loomId")
      )`);
      await q('CREATE INDEX production_weaver_looms_weaver ON production_weaver_looms ("weaverId")');
      await q(`CREATE TABLE production_units (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES weaving_departments(id),
        "workDate" date NOT NULL,
        shift char(1) NOT NULL CHECK (shift IN ('A', 'B', 'C')),
        "loomId" uuid NOT NULL REFERENCES looms(id),
        units numeric(10,2) NOT NULL CHECK (units >= 0),
        "entryId" uuid REFERENCES loom_entries(id),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "workDate", shift, "loomId")
      )`);
      await q('CREATE INDEX production_units_day ON production_units ("companyId", "departmentId", "workDate")');
      await q('CREATE INDEX production_units_entry ON production_units ("entryId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE production_units');
      await q('DROP TABLE production_weaver_looms');
      await q('DROP TABLE production_weavers');
      await q("DELETE FROM user_services WHERE \"serviceId\" IN (SELECT id FROM services WHERE code = 'WEAVING_PRODUCTION')");
      await q("DELETE FROM company_services WHERE \"serviceId\" IN (SELECT id FROM services WHERE code = 'WEAVING_PRODUCTION')");
      await q("DELETE FROM services WHERE code = 'WEAVING_PRODUCTION'");
    });
  },
};
