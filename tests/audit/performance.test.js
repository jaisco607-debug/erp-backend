// AUDIT: speed with a big mill (about 1,500 lots, SO cards and jobs, 700 in Folding, chemicals, packing lists).
// Prints the time and the number of SQL queries of every important screen; fails if a screen is very slow
// or if the number of queries grows with the number of rows on the page (N+1).
const { world, clean, sequelize } = require('./world');

beforeEach(clean);
jest.setTimeout(3600000);

const N = Number(process.env.AUDIT_PERF_N || 1000);

async function inBatches(n, size, fn) {
  for (let i = 0; i < n; i += size) await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, k) => fn(i + k)));
}

/** counts every SQL query while fn runs */
async function measure(fn) {
  const original = sequelize.query.bind(sequelize);
  let queries = 0;
  sequelize.query = (...args) => { queries += 1; return original(...args); };
  const t0 = process.hrtime.bigint();
  let res;
  try { res = await fn(); } finally { sequelize.query = original; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, queries, res };
}

// heavy: run with AUDIT_PERF=1 npx jest tests/audit/performance.test.js
(process.env.AUDIT_PERF ? test : test.skip)('PERFORMANCE: a big mill', async () => {
  const w = await world();
  const cus = [];
  for (let i = 0; i < 20; i += 1) cus.push(await w.customer(`PARTY ${i + 1}`));
  const q = await w.quality();
  const red = await w.chem('RED');
  await w.buy(red, 100000, 10, '2026-10-01');
  await w.give('DYEING', [red]);
  const started = Date.now();

  // lots and SO cards
  const lots = [];
  await inBatches(N, 10, async (i) => {
    const l = await w.api('post', '/grey-lots', { inwardDate: '2026-10-05', customerId: cus[i % 20].id, qualityId: q.id, thaans: [100, 120, 80, 90, 110] });
    lots[i] = l.body;
  });
  await inBatches(N, 10, (i) => w.api('post', `/grey-lots/${lots[i].id}/approve`));
  const cards = [];
  await inBatches(N, 10, async (i) => {
    const c = await w.api('post', '/so-cards', { cardDate: '2026-10-06', lots: [{ greyLotId: lots[i].id, thaanNos: [1, 2, 3, 4, 5] }] });
    cards[i] = c.body;
  });
  // all cards to Dyeing as jobs (one job per card)
  const rows = await w.deskRows();
  const jobs = [];
  await inBatches(rows.length, 10, async (i) => {
    const j = await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: rows[i].soCardLotId }] });
    jobs[i] = j.body;
  });
  // receive and accept everything, chemicals on the first 150, complete and forward 700 to Folding
  await inBatches(jobs.length, 10, async (i) => {
    await w.api('post', `/departments/DYEING/jobs/${jobs[i].id}/receive`);
    await w.api('post', `/departments/DYEING/jobs/${jobs[i].id}/accept`);
    await w.api('put', `/departments/DYEING/jobs/${jobs[i].id}/status`, { status: 'PROCESSING' });
  });
  await inBatches(150, 5, async (i) => {
    const r = await w.api('post', '/departments/DYEING/chemical-requests', { jobId: jobs[i].id, lines: [{ itemId: red.id, qty: 1 + (i % 5) }] });
    await w.api('post', `/stores/chemical/requests/${r.body.id}/accept`);
    await w.api('post', `/stores/chemical/requests/${r.body.id}/send`, {});
    await w.api('post', `/departments/DYEING/chemical-requests/${r.body.id}/receive`);
  });
  const toFold = Math.min(700, jobs.length);
  await inBatches(toFold, 10, async (i) => {
    await w.api('put', `/departments/DYEING/jobs/${jobs[i].id}/operator`, { operatorName: 'Op', processDate: '2026-10-18' });
    await w.api('put', `/departments/DYEING/jobs/${jobs[i].id}/status`, { status: 'COMPLETE' });
  });
  const form = await w.ok('get', '/departments/DYEING/send-form');
  const foldRows = form.rows.slice(0, toFold);
  await inBatches(foldRows.length, 10, async (i) => {
    const f = await w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: foldRows[i].jobItemId }] });
    if (f.status === 201) await w.api('post', `/departments/FOLDING/jobs/${f.body.id}/receive`);
  });
  console.log(`seeded ${lots.length} lots, ${cards.length} cards, ${jobs.length} jobs in ${Math.round((Date.now() - started) / 1000)} s`);

  const screens = [
    ['Grey lots list (25)', '/grey-lots?limit=25', '/grey-lots?limit=100'],
    ['SO cards list (25)', '/so-cards?limit=25', '/so-cards?limit=100'],
    ['Dyeing incoming (job view)', '/departments/DYEING/incoming?limit=5', '/departments/DYEING/incoming?limit=50'],
    ['Dyeing incoming (SO view)', '/departments/DYEING/incoming?view=so&limit=5', '/departments/DYEING/incoming?view=so&limit=50'],
    ['Folding incoming', '/departments/FOLDING/incoming?limit=5', '/departments/FOLDING/incoming?limit=50'],
    ['Folding list', '/departments/FOLDING/folding?limit=5', '/departments/FOLDING/folding?limit=50'],
    ['Packing so-cards', '/departments/PACKING/packing/so-cards?limit=5', '/departments/PACKING/packing/so-cards?limit=50'],
    ['Dyeing send form', '/departments/DYEING/send-form', '/departments/DYEING/send-form'],
    ['Desk form data (jobs)', '/jobs/form-data', '/jobs/form-data'],
    ['SO card form data', '/so-cards/form-data', '/so-cards/form-data'],
    ['Stock (chemical)', '/stores/chemical/stock', '/stores/chemical/stock'],
    ['Chemical requests', '/stores/chemical/requests?limit=5', '/stores/chemical/requests?limit=50'],
    ['Report: overview', '/reports/overview', '/reports/overview'],
    ['Report: grey parties', '/reports/grey/parties', '/reports/grey/parties'],
    ['Report: grey lots (all)', '/reports/grey/lots?limit=5', '/reports/grey/lots?all=true'],
    ['Report: SO cards (all)', '/reports/so-cards?limit=5', '/reports/so-cards?all=true'],
    ['Report: departments', '/reports/departments', '/reports/departments'],
    ['Report: department jobs', '/reports/departments/jobs?limit=5', '/reports/departments/jobs?limit=50'],
    ['Report: folding', '/reports/folding?limit=5', '/reports/folding?limit=50'],
    ['Report: active fabric (party)', '/reports/active-fabric?by=party', '/reports/active-fabric?by=party'],
    ['Report: active fabric (detail)', '/reports/active-fabric?by=detail&limit=5', '/reports/active-fabric?by=detail&limit=50'],
    ['Report: chemical cost (thaan)', '/reports/chemical-cost?by=thaan&limit=5', '/reports/chemical-cost?by=thaan&limit=50'],
    ['Report: operators', '/reports/departments/operators', '/reports/departments/operators'],
  ];
  const table = [];
  const slow = [];
  const nPlus1 = [];
  for (const [name, small, big] of screens) {
    const a = await measure(() => w.api('get', small));
    const b = await measure(() => w.api('get', big));
    if (a.res.status !== 200 || b.res.status !== 200) { table.push(`${name.padEnd(34)} ERROR ${a.res.status}/${b.res.status}`); continue; }
    table.push(`${name.padEnd(34)} small: ${String(Math.round(a.ms)).padStart(6)} ms ${String(a.queries).padStart(5)} q | big: ${String(Math.round(b.ms)).padStart(6)} ms ${String(b.queries).padStart(5)} q`);
    if (b.ms > 3000) slow.push(`${name}: ${Math.round(b.ms)} ms`);
    if (b.queries > a.queries + 20) nPlus1.push(`${name}: ${a.queries} queries for the small page, ${b.queries} for the big one`);
  }
  console.log('\n' + table.join('\n'));
  console.log(`\nSLOW (> 3 s): ${JSON.stringify(slow)}\nN+1 (queries grow with rows): ${JSON.stringify(nPlus1)}`);
  expect(slow).toEqual([]);
  expect(nPlus1).toEqual([]);
});
