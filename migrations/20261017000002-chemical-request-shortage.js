// Chemical not in stock: the store answers per line.
//   offer an ALTERNATE chemical (department says yes -> the line changes to it, no -> stays)
//   or tell WHEN it will come (etaDate + note)
//   originalItemId  the chemical the department first asked (kept when an alternate is taken)
//   altStatus       OFFERED -> ACCEPTED / DECLINED
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE chemical_request_lines
        ADD COLUMN "originalItemId" uuid REFERENCES store_items(id),
        ADD COLUMN "altItemId" uuid REFERENCES store_items(id),
        ADD COLUMN "altQty" numeric(16,3),
        ADD COLUMN "altStatus" varchar(10) CHECK ("altStatus" IN ('OFFERED','ACCEPTED','DECLINED')),
        ADD COLUMN "altNote" varchar(300),
        ADD COLUMN "altOfferedById" uuid REFERENCES users(id),
        ADD COLUMN "altOfferedAt" timestamptz,
        ADD COLUMN "altDecidedById" uuid REFERENCES users(id),
        ADD COLUMN "altDecidedAt" timestamptz,
        ADD COLUMN "etaDate" date,
        ADD COLUMN "etaNote" varchar(300),
        ADD COLUMN "etaById" uuid REFERENCES users(id),
        ADD COLUMN "etaAt" timestamptz;`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE chemical_request_lines
        DROP COLUMN "originalItemId", DROP COLUMN "altItemId", DROP COLUMN "altQty", DROP COLUMN "altStatus", DROP COLUMN "altNote",
        DROP COLUMN "altOfferedById", DROP COLUMN "altOfferedAt", DROP COLUMN "altDecidedById", DROP COLUMN "altDecidedAt",
        DROP COLUMN "etaDate", DROP COLUMN "etaNote", DROP COLUMN "etaById", DROP COLUMN "etaAt";`);
  },
};
