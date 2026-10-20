// Department flow changes (owner, 2026-10-17):
//  - New first statuses: IN_WAY (sent, on its way) -> QUEUE (department pressed Receive)
//    -> PENDING (pressed Accept) -> PROCESSING -> COMPLETE; REJECTED from In-Way / Queue / Pending
//    sends it back to the sender. receivedById/At and acceptedById/At = who pressed which button.
//    Jobs still PENDING (never accepted) move to QUEUE.
//  - Colour per SO card inside a job: job_items.colourId (+ who / when). Dyeing gives the colour,
//    every later department shows it (new items copy it from the item they came from).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check`);
      await q(`ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'))`);
      await q(`ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'IN_WAY'`);
      await q(`ALTER TABLE jobs ADD COLUMN "receivedById" uuid REFERENCES users(id), ADD COLUMN "receivedAt" timestamptz, ADD COLUMN "acceptedById" uuid REFERENCES users(id), ADD COLUMN "acceptedAt" timestamptz`);
      await q(`UPDATE jobs SET status = 'QUEUE' WHERE status = 'PENDING'`);
      await q(`ALTER TABLE job_items ADD COLUMN "colourId" uuid REFERENCES colours(id), ADD COLUMN "colourSetById" uuid REFERENCES users(id), ADD COLUMN "colourSetAt" timestamptz`);
      await q(`UPDATE job_items ji SET "colourId" = j."colourId" FROM jobs j WHERE j.id = ji."jobId" AND j."colourId" IS NOT NULL`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`ALTER TABLE job_items DROP COLUMN "colourId", DROP COLUMN "colourSetById", DROP COLUMN "colourSetAt"`);
      await q(`UPDATE jobs SET status = 'PENDING' WHERE status IN ('IN_WAY', 'QUEUE')`);
      await q(`ALTER TABLE jobs DROP COLUMN "receivedById", DROP COLUMN "receivedAt", DROP COLUMN "acceptedById", DROP COLUMN "acceptedAt"`);
      await q(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check`);
      await q(`ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'))`);
      await q(`ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'PENDING'`);
    });
  },
};
