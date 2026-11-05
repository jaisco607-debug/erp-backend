'use strict';
// Customer master form (owner 2026-10-24): same fields as the vendor form (legal name, status, type, payment, CNIC, NTN, GST#, email, city, province, bank details).
// No required-field checks yet (NTN / CNIC rules by company status come later). Accounting will use this information.
const COLS = {
  legalName: 'varchar(150)', status: 'varchar(20)', type: 'varchar(20)', payment: 'varchar(20)', cnic: 'varchar(20)', ntn: 'varchar(30)', gstNo: 'varchar(30)',
  email: 'varchar(150)', city: 'varchar(80)', province: 'varchar(80)', bankName: 'varchar(100)', bankBranch: 'varchar(100)', accountTitle: 'varchar(150)', accountNo: 'varchar(50)', iban: 'varchar(40)',
};
module.exports = {
  async up(q) {
    for (const [c, t] of Object.entries(COLS)) await q.sequelize.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS "${c}" ${t}`);
    await q.sequelize.query(`UPDATE customers SET status = 'INDIVIDUAL' WHERE status IS NULL`);
    await q.sequelize.query(`UPDATE customers SET type = 'CUSTOMERS' WHERE type IS NULL`);
    await q.sequelize.query(`UPDATE customers SET payment = 'CHQ' WHERE payment IS NULL`);
  },
  async down(q) {
    for (const c of Object.keys(COLS)) await q.sequelize.query(`ALTER TABLE customers DROP COLUMN IF EXISTS "${c}"`);
  },
};
