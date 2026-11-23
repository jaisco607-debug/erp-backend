'use strict';
// Process Management > Machines (owner 2026-11-23): every process department (Dyeing, Stitching ...) can have machines.
//   company_services.machines / machinePrefix   the client admin switches the machines of a department ON / OFF (Settings > Machines); the prefix (letters of the department) makes the machine names unique
//   machines                                    one machine of a department: name = PREFIX-NN (unique in the company), switched on / off, soft delete
//   machine_runs                                one job (all of its cloth, or a part of it in meters) running on a machine: operator, meters came (in) and meters made (out), RUNNING / DONE
//   job_item_thaans                             the thaans a department made from the cloth of a job item (a department cuts / joins thaans): the next department receives these thaans
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE company_services ADD COLUMN machines boolean NOT NULL DEFAULT false, ADD COLUMN "machinePrefix" varchar(8)');
      await q(`CREATE TABLE machines (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES services(id),
        number integer NOT NULL,
        name varchar(20) NOT NULL,
        notes varchar(200),
        "isActive" boolean NOT NULL DEFAULT true,
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
      await q('CREATE UNIQUE INDEX machines_company_name ON machines ("companyId", lower(name))');
      await q('CREATE UNIQUE INDEX machines_department_number ON machines ("companyId", "departmentId", number)');
      await q(`CREATE TABLE machine_runs (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "machineId" uuid NOT NULL REFERENCES machines(id),
        "operatorName" varchar(80) NOT NULL,
        "inMeters" numeric(14,2) NOT NULL CHECK ("inMeters" > 0),
        "outMeters" numeric(14,2) CHECK ("outMeters" IS NULL OR "outMeters" >= 0),
        status varchar(7) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'DONE')),
        "runDate" date NOT NULL,
        "startedAt" timestamptz NOT NULL DEFAULT now(),
        "finishedAt" timestamptz,
        notes varchar(200),
        "startedById" uuid,
        "finishedById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
      // a machine runs one job at a time
      await q(`CREATE UNIQUE INDEX machine_runs_one_running ON machine_runs ("machineId") WHERE status = 'RUNNING'`);
      await q('CREATE INDEX machine_runs_job ON machine_runs ("jobId")');
      await q('CREATE INDEX machine_runs_report ON machine_runs ("companyId", "departmentId", "runDate")');
      await q(`CREATE TABLE job_item_thaans (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "jobId" uuid NOT NULL REFERENCES jobs(id),
        "jobItemId" uuid NOT NULL REFERENCES job_items(id) ON DELETE CASCADE,
        "thaanNo" integer NOT NULL,
        meters numeric(14,2) NOT NULL CHECK (meters > 0),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("jobItemId", "thaanNo")
      )`);
      await q('CREATE INDEX job_item_thaans_job ON job_item_thaans ("jobId")');
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('DROP TABLE job_item_thaans');
      await q('DROP TABLE machine_runs');
      await q('DROP TABLE machines');
      await q('ALTER TABLE company_services DROP COLUMN machines, DROP COLUMN "machinePrefix"');
    });
  },
};
