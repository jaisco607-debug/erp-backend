'use strict';
// Vendor master form (owner 2026-10-22): legal name, status, type, payment, CNIC, NTN, GST#, email, city, province, bank details.
const COLS = {
  legalName: 'varchar(150)', status: 'varchar(20)', type: 'varchar(20)', payment: 'varchar(20)', cnic: 'varchar(20)', ntn: 'varchar(30)', gstNo: 'varchar(30)',
  email: 'varchar(150)', city: 'varchar(80)', province: 'varchar(80)', bankName: 'varchar(100)', bankBranch: 'varchar(100)', accountTitle: 'varchar(150)', accountNo: 'varchar(50)', iban: 'varchar(40)',
};
module.exports = {
  async up(q) {
    for (const [c, t] of Object.entries(COLS)) await q.sequelize.query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS "${c}" ${t}`);
    await q.sequelize.query(`UPDATE vendors SET status = 'INDIVIDUAL' WHERE status IS NULL`);
    await q.sequelize.query(`UPDATE vendors SET type = 'VENDORS' WHERE type IS NULL`);
    await q.sequelize.query(`UPDATE vendors SET payment = 'CHQ' WHERE payment IS NULL`);
  },
  async down(q) {
    for (const c of Object.keys(COLS)) await q.sequelize.query(`ALTER TABLE vendors DROP COLUMN IF EXISTS "${c}"`);
  },
};
