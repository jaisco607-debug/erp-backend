// Audit of a database: runs every rule of scripts/audit/invariants.js and prints which hold and which are broken.
// READ ONLY (one read-only transaction; nothing is written). Uses DATABASE_URL like the server.
//   node scripts/audit-db.js            summary + first rows of every broken rule
//   node scripts/audit-db.js --all      every broken row
require('dotenv').config();
const { sequelize } = require('../src/config/database');
const rules = require('./audit/invariants');

(async () => {
  const showAll = process.argv.includes('--all');
  const results = [];
  await sequelize.transaction({ readOnly: true }, async (transaction) => {
    for (const r of rules) {
      try {
        const rows = (await sequelize.query(r.sql, { type: sequelize.QueryTypes.SELECT, transaction }));
        results.push({ ...r, rows });
      } catch (e) {
        results.push({ ...r, error: e.message, rows: [] });
      }
    }
  });
  let broken = 0;
  for (const r of results) {
    const state = r.error ? 'ERROR' : r.rows.length ? 'BROKEN' : 'ok';
    if (state !== 'ok') broken += 1;
    console.log(`${state.padEnd(6)} ${r.id.padEnd(9)} [${r.severity}] ${r.title}${r.rows.length ? `  -> ${r.rows.length} row(s)` : ''}${r.error ? `  ERROR: ${r.error}` : ''}`);
    if (r.rows.length) for (const row of showAll ? r.rows : r.rows.slice(0, 5)) console.log('         ', JSON.stringify(row));
  }
  console.log(`\n${results.length} rules, ${results.length - broken} hold, ${broken} broken.`);
  await sequelize.close();
  process.exit(broken ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
