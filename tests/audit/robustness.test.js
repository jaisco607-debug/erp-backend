// AUDIT: robustness. Every route gets empty, wrong-type, oversized, hostile and impossible input (body and query).
// The server must answer 2xx or 4xx, never 5xx, never leak a stack / SQL text, and the accounting rules must still hold.
const { world, clean, expectClean, sequelize } = require('./world');
const { allRoutes, seedEverything } = require('./seed');

beforeEach(clean);
jest.setTimeout(1800000);

const BODIES = [
  {}, { x: 1 }, [], 'null', { name: null }, { name: 'x'.repeat(10000) }, { qty: -1, meters: -1, rate: -1 }, { qty: 1e308, meters: 1e308 }, { qty: 'abc', meters: 'abc' },
  { lines: [] }, { lines: [null] }, { lines: 'x' }, { items: [{}] }, { thaanNos: [0, -1, 1.5] }, { name: "'; DROP TABLE users; --" }, { name: '<script>alert(1)</script>' },
  { date: '2026-02-30', dateFrom: '2026-13-45' }, { id: '00000000-0000-4000-8000-000000000000' }, { password: '1', newPassword: '2', email: 'not-an-email' },
];
const QUERIES = [
  '', '?page=-1', '?page=0&limit=0', '?page=abc&limit=xyz', '?limit=100000', '?page=999999999999', "?search=%27%3B%20DROP%20TABLE%20users%3B--", '?search=%25%25%25', '?search=' + encodeURIComponent('\u0000‮😀'),
  '?search=' + 'a'.repeat(5000), '?dateFrom=2026-02-30', '?dateTo=garbage', '?isActive=maybe', '?all=true&limit=500', '?by=nope', '?status=NOPE', '?customerId=not-a-uuid', '?tab=x&sort=y',
];

const SKIP = [/\/auth\/(logout|logout-all|change-password)/, /\/health$/];

test('ROBUSTNESS: no route crashes (5xx) on bad body or bad query, and nothing is leaked or broken', async () => {
  const w = await world();
  const ids = await seedEverything(w);
  const byPrefix = [
    [/\/customers/, [ids.customer]], [/\/qualities/, [ids.quality]], [/\/grey-lots/, [ids.lot, ids.lot2, ids.draftInward]], [/\/so-cards/, [ids.card, ids.card2, ids.fabricReturn]],
    [/\/colours/, [ids.colour]], [/\/jobs/, [ids.job]], [/\/vendors/, [ids.vendor]], [/\/categories/, [ids.category]], [/\/brands/, [ids.brand]],
    [/\/items/, [ids.item]], [/\/inwards/, [ids.inward, ids.draftInward]], [/\/requests/, [ids.request, ids.pendingRequest]], [/\/returns/, [ids.return]],
    [/\/adjustments/, [ids.adjustment]], [/\/batches/, [ids.batch]], [/\/packing-lists/, [ids.packingList]], [/\/users/, [ids.employee]], [/\/companies/, [ids.company]],
    [/\/chemical-(requests|returns)/, [ids.request, ids.return, ids.pendingRequest]],
  ];
  const routes = allRoutes().filter((r) => !SKIP.some((s) => s.test(r.path)));
  const crashes = [];
  const leaks = [];
  let calls = 0;
  for (const r of routes) {
    const hasId = /:(?!code\b|store\b)\w+/.test(r.path);
    const typed = (byPrefix.find(([re]) => re.test(r.path)) || [null, []])[1];
    const idSets = hasId ? [...typed.slice(0, 2), '00000000-0000-4000-8000-000000000000', 'not-a-uuid'] : [null];
    for (const id of idSets) {
      const url = r.path.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, (_, p) => {
        if (p === 'code') return 'DYEING';
        if (p === 'store') return 'chemical';
        if (p === 'jobId') return id && id.length === 36 && typed.includes(id) ? ids.job : id;
        if (p === 'soCardId') return id && typed.includes(id) ? ids.card : id;
        return id;
      });
      const attempts = r.method === 'get' || r.method === 'delete' ? QUERIES.map((q) => [url + q, undefined]) : BODIES.map((b) => [url, b]);
      for (const [u, body] of attempts) {
        const res = await w.api(r.method, u, body);
        calls += 1;
        const text = JSON.stringify(res.body || {});
        if (res.status >= 500) crashes.push(`${r.method.toUpperCase()} ${u.slice(0, 90)} body=${String(JSON.stringify(body)).slice(0, 60)} -> ${res.status}`);
        if (/\bat \S+ \(.*\.js:\d+/.test(text) || /SELECT .* FROM|INSERT INTO|"public"\./i.test(text) || /passwordHash|\$2[aby]\$/.test(text)) leaks.push(`${r.method.toUpperCase()} ${u.slice(0, 80)} leaks internals`);
      }
    }
  }
  console.log(`robustness: ${routes.length} routes, ${calls} calls, ${crashes.length} crashes`);
  // group crashes by route to keep the report readable
  const grouped = {};
  for (const c of crashes) { const k = c.split(' body=')[0].replace(/[0-9a-f-]{36}/g, ':id').replace(/\?.*$/, ''); grouped[k] = (grouped[k] || 0) + 1; }
  if (crashes.length) console.log('CRASHES BY ROUTE:\n' + Object.entries(grouped).map(([k, n]) => `  ${n}x ${k}`).join('\n') + '\nEXAMPLES:\n  ' + crashes.slice(0, 12).join('\n  '));
  const unknown = crashes;
  expect(leaks).toEqual([]);
  expect(unknown).toEqual([]);
  await expectClean(['JOB-04', 'JOB-05']);
  const [{ n }] = await sequelize.query('SELECT count(*)::int AS n FROM grey_lots', { type: sequelize.QueryTypes.SELECT });
  expect(n).toBeGreaterThan(0);
});

// Was bug AUD-07 (fixed): an impossible date in a filter (dateFrom=2026-02-30) crashes ~25 list and report endpoints with a 500.
test('a date filter with an impossible date answers 400, not 500', async () => {
  const w = await world();
  expect((await w.api('get', '/grey-lots?dateFrom=2026-02-30')).status).toBe(400);
  expect((await w.api('get', '/reports/overview?dateFrom=2026-02-30')).status).toBe(400);
});

test('a search with a NUL character or emoji answers 200 or 400, not 500', async () => {
  const w = await world();
  expect((await w.api('get', '/customers?search=%00')).status).toBeLessThan(500);
  expect((await w.api('get', '/grey-lots?search=%00')).status).toBeLessThan(500);
});
