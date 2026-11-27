'use strict';
// Owner plan N-B1 (2026-11-26): fabric inspection with the 4-point system. A new service INSPECTION (the inspector is his own person), and four tables:
//   defect_types           the defects of the company (Hole, Oil stain ...), some with fixed points
//   inspection_settings    the points of each size, the grade limits, per 100 linear meters or square yards, the most points one meter can get
//   inspections            one inspection of one thaan: of the grey lot, or of a thaan a department made
//   inspection_defects     the defects found
// An inspection keeps a COPY of the thaan (lot, number, meters, width, department, job) and NO foreign key to the thaan: departments rewrite their thaans, and
// nothing of the cloth flow may be blocked or changed by an inspection.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "menuGroup", "tracksColour", "sortOrder")
        SELECT gen_random_uuid(), 'INSPECTION', 'Fabric Inspection', 'MODULE', 'PRODUCTION', false, COALESCE((SELECT MAX("sortOrder") FROM services), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'INSPECTION')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
        SELECT c.id, s.id FROM companies c CROSS JOIN services s
        WHERE s.code = 'INSPECTION' AND c."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)`);
      await q(`CREATE TABLE defect_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        code varchar(10) NOT NULL,
        name varchar(80) NOT NULL,
        "fixedPoints" integer NULL CHECK ("fixedPoints" IS NULL OR ("fixedPoints" BETWEEN 1 AND 10)),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q('CREATE UNIQUE INDEX defect_types_name ON defect_types ("companyId", lower(name))');
      await q('CREATE UNIQUE INDEX defect_types_code ON defect_types ("companyId", lower(code))');
      await q(`CREATE TABLE inspection_settings (
        "companyId" uuid PRIMARY KEY REFERENCES companies (id),
        "pointTable" jsonb NOT NULL,
        "gradeLimits" jsonb NOT NULL,
        basis varchar(8) NOT NULL DEFAULT 'METER' CHECK (basis IN ('METER', 'SQ_YARD')),
        "maxPointsPerMeter" integer NULL CHECK ("maxPointsPerMeter" IS NULL OR "maxPointsPerMeter" BETWEEN 1 AND 100),
        "updatedById" uuid,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      await q(`CREATE TABLE inspections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "inspectionNo" integer NOT NULL,
        "inspectionDate" date NOT NULL,
        source varchar(10) NOT NULL CHECK (source IN ('GREY', 'DEPARTMENT')),
        "thaanId" uuid NOT NULL,
        "greyLotId" uuid NOT NULL,
        "lotNo" integer NOT NULL,
        "thaanNo" integer NOT NULL,
        meters numeric(14,2) NOT NULL CHECK (meters > 0),
        "widthInches" numeric(8,2) NULL CHECK ("widthInches" IS NULL OR "widthInches" > 0),
        "customerId" uuid, "customerName" varchar(150),
        "qualityId" uuid, "qualityName" varchar(150),
        "departmentId" uuid, "departmentName" varchar(120), "jobId" uuid, "jobNo" integer, "soNo" integer, "operatorName" varchar(120), machines varchar(300),
        "inspectorId" uuid REFERENCES users (id) ON DELETE SET NULL,
        remarks varchar(500),
        status varchar(10) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'FINISHED')),
        "totalPoints" integer, "rawPoints" integer, "pointsPer100" numeric(10,2), grade varchar(8), rules jsonb,
        "finishedAt" timestamptz, "finishedById" uuid,
        "reopenedAt" timestamptz, "reopenedById" uuid, "reopenReason" varchar(300),
        "deletedAt" timestamptz, "deletedById" uuid, "deleteReason" varchar(300),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "inspectionNo")
      )`);
      await q(`CREATE UNIQUE INDEX inspections_one_draft ON inspections ("companyId", "thaanId") WHERE status = 'DRAFT' AND "deletedAt" IS NULL`);
      await q('CREATE INDEX inspections_thaan ON inspections ("companyId", "thaanId", "finishedAt" DESC)');
      await q('CREATE INDEX inspections_date ON inspections ("companyId", "inspectionDate" DESC)');
      await q(`CREATE TABLE inspection_defects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "inspectionId" uuid NOT NULL REFERENCES inspections (id) ON DELETE CASCADE,
        "companyId" uuid NOT NULL REFERENCES companies (id),
        "lineNo" integer NOT NULL,
        "defectTypeId" uuid NOT NULL REFERENCES defect_types (id),
        "atMeter" numeric(10,2) NOT NULL CHECK ("atMeter" >= 0),
        "sizeClass" varchar(10) NOT NULL,
        points integer NOT NULL CHECK (points >= 0),
        note varchar(200),
        UNIQUE ("inspectionId", "lineNo")
      )`);
      await q('CREATE INDEX inspection_defects_type ON inspection_defects ("companyId", "defectTypeId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS inspection_defects; DROP TABLE IF EXISTS inspections; DROP TABLE IF EXISTS inspection_settings; DROP TABLE IF EXISTS defect_types');
      const gone = "(SELECT id FROM services WHERE code = 'INSPECTION')";
      await q(`DELETE FROM user_services WHERE "serviceId" IN ${gone}`);
      await q(`DELETE FROM company_services WHERE "serviceId" IN ${gone}`);
      await q("DELETE FROM services WHERE code = 'INSPECTION'");
    });
  },
};
