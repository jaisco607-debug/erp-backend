// Lists the documents of a company whose date is outside the allowed days (A1.1: "existing wrong data is not changed: list it with a query and let the accountant correct it").
// Read only: nothing is changed.
//   node scripts/listWrongDates.js <companyId>
require('dotenv').config();
const { sequelize } = require('../src/models');
const limitsService = require('../src/services/limitsService');

const KINDS = [['stock', limitsService.STOCK_DATES], ['voucher', limitsService.VOUCHER_DATES], ['other', limitsService.OTHER_DATES], ['old', limitsService.OLD_DATES]];

(async () => {
  const companyId = process.argv[2];
  if (!companyId) { console.error('Usage: node scripts/listWrongDates.js <companyId>'); process.exit(1); }
  const { windows } = await limitsService.forCompany(companyId);
  let total = 0;
  for (const [kind, columns] of KINDS) {
    const w = windows[kind];
    const cols = await sequelize.query(
      `SELECT c.table_name AS t, c.column_name AS col FROM information_schema.columns c
        JOIN information_schema.columns k ON k.table_name = c.table_name AND k.column_name = 'companyId' AND k.table_schema = c.table_schema
        JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema AND tb.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.data_type = 'date' AND c.column_name IN (:columns) ORDER BY 1, 2`, { replacements: { columns }, type: 'SELECT' });
    for (const { t, col } of cols) {
      const rows = await sequelize.query(`SELECT id::text AS id, "${col}"::text AS d FROM "${t}" WHERE "companyId" = :companyId AND "${col}" IS NOT NULL AND ("${col}" < :min OR "${col}" > :max) ORDER BY "${col}" LIMIT 200`,
        { replacements: { companyId, min: w.min, max: w.max }, type: 'SELECT' });
      for (const r of rows) { total += 1; console.log(`${t}.${col}\t${r.id}\t${r.d}\t(allowed ${w.min} .. ${w.max})`); }
    }
  }
  console.log(total ? `\n${total} date(s) outside the allowed days (at most 200 per column listed).` : 'No date outside the allowed days.');
  await sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
