// Step 5: cloth moving through departments.
//   colours     each company's colour list (BLACK, C BLUE, LIGHT PINK ...), picked from a dropdown
//   jobs        one dispatch of cloth to a department = one entry with its own Job#.
//               It can carry parts of several SO cards (e.g. 1500 m of card 4740 + 3000 m of card 4739, both BLACK).
//               status in the receiving department: PENDING -> PROCESSING -> COMPLETE, or REJECTED
//               (cloth did not arrive there; it goes back to the sender)
//   job_items   which SO card (and which of its grey lots) the job's meters belong to, so each
//               party always gets back exactly its own cloth. sourceJobItemId = the item this one
//               came from in the previous department (null when it came straight from the SO card).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        CREATE TABLE colours (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          name varchar(100) NOT NULL,
          "isActive" boolean NOT NULL DEFAULT true,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          "deletedAt" timestamptz
        )`);
      await q(`CREATE UNIQUE INDEX colours_company_name ON colours ("companyId", lower(name)) WHERE "deletedAt" IS NULL`);
      await q(`
        CREATE TABLE jobs (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          "jobNo" integer NOT NULL CHECK ("jobNo" > 0),
          "jobDate" date NOT NULL,
          "departmentId" uuid NOT NULL REFERENCES services(id),
          "fromDepartmentId" uuid REFERENCES services(id),
          "colourId" uuid REFERENCES colours(id),
          status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED')),
          "totalMeters" numeric(14,2) NOT NULL CHECK ("totalMeters" > 0),
          "isReprocess" boolean NOT NULL DEFAULT false,
          "sentThrough" varchar(120),
          remarks varchar(500),
          "statusById" uuid,
          "statusAt" timestamptz,
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          UNIQUE ("companyId", "jobNo")
        )`);
      await q(`CREATE INDEX jobs_department ON jobs ("companyId", "departmentId", status)`);
      await q(`CREATE INDEX jobs_from ON jobs ("companyId", "fromDepartmentId")`);
      await q(`
        CREATE TABLE job_items (
          id uuid PRIMARY KEY,
          "jobId" uuid NOT NULL REFERENCES jobs(id),
          "soCardId" uuid NOT NULL REFERENCES so_cards(id),
          "soCardLotId" uuid NOT NULL REFERENCES so_card_lots(id),
          "sourceJobItemId" uuid REFERENCES job_items(id),
          meters numeric(14,2) NOT NULL CHECK (meters > 0),
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()
        )`);
      await q(`CREATE INDEX job_items_job ON job_items ("jobId")`);
      await q(`CREATE INDEX job_items_card_lot ON job_items ("soCardLotId")`);
      await q(`CREATE INDEX job_items_source ON job_items ("sourceJobItemId")`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE job_items; DROP TABLE jobs; DROP TABLE colours;');
  },
};
