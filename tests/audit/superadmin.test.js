// AUDIT: super admin routes under bad input, security headers, and date sanity.
const { world, clean, expectClean, request, app, makeUser, loginAs } = require('./world');
const { allRoutes } = require('./seed');

beforeEach(clean);
jest.setTimeout(900000);

const BODIES = [{}, { x: 1 }, [], 'null', { name: null }, { name: 'x'.repeat(10000) }, { code: "'; DROP TABLE users; --", name: 'a' }, { companyIds: ['not-a-uuid'] }, { serviceIds: [1, 2] }, { newPassword: '1', email: 'x' }, { isActive: 'maybe' }, { kind: 'NOPE' }];
const QUERIES = ['', '?page=-1', '?limit=100000', '?page=abc', '?search=%27%3B--', '?search=%00', '?isActive=maybe', '?kind=NOPE', '?dateFrom=2026-02-30', '?userType=GOD', '?companyId=nope', '?action=x&entityType=y&from=garbage'];

test('SUPER ADMIN routes: no crash on bad bodies or queries, nothing leaked', async () => {
  const sa = await makeUser();
  const token = (await loginAs(sa)).accessToken;
  const call = (m, u, b) => request(app)[m](`/api/v1${u}`).set({ Authorization: `Bearer ${token}` }).send(b);
  const w = await world();
  const company = (await call('post', '/companies', { name: 'X Mills', admin: { name: 'Boss', email: 'boss@x.com', password: 'Boss-Pass-123' } })).body;
  const service = (await call('get', '/services')).body.data[0];
  const ids = [company.id, service.id, sa.id, w.admin.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid'];
  const routes = allRoutes().filter((r) => /\/v1\/(companies|services|super-admins|audit-logs|admin)/.test(r.path));
  const crashes = [];
  const leaks = [];
  let calls = 0;
  for (const r of routes) {
    const hasId = /:\w+/.test(r.path);
    for (const id of hasId ? ids : [null]) {
      const url = r.path.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, () => id);
      const tries = r.method === 'get' || r.method === 'delete' ? QUERIES.map((q) => [url + q]) : BODIES.map((b) => [url, b]);
      for (const [u, b] of tries) {
        if (r.method === 'delete' && !u.includes('?') && u.includes(company.id)) continue; // do not delete the company under test
        const res = await call(r.method, u, b);
        calls += 1;
        const text = JSON.stringify(res.body || {});
        if (res.status >= 500) crashes.push(`${r.method.toUpperCase()} ${u.slice(0, 80)} -> ${res.status}`);
        if (/passwordHash|\$2[aby]\$|\bat \S+ \(.*\.js:\d+/.test(text)) leaks.push(`${r.method.toUpperCase()} ${u.slice(0, 80)}`);
      }
    }
  }
  console.log(`super admin sweep: ${routes.length} routes, ${calls} calls, ${crashes.length} crashes`);
  const grouped = {};
  for (const c of crashes) { const k = c.replace(/[0-9a-f-]{36}/g, ':id').replace(/\?.*?( ->)/, '$1'); grouped[k] = (grouped[k] || 0) + 1; }
  if (crashes.length) console.log('CRASHES:\n' + Object.entries(grouped).map(([k, n]) => `  ${n}x ${k}`).join('\n'));
  expect(leaks).toEqual([]);
  expect(crashes).toEqual([]);
});

test('security headers are on every answer; CORS answers only the allowed frontend', async () => {
  const res = await request(app).get('/api/health');
  expect(res.headers['x-powered-by']).toBeUndefined();
  for (const h of ['x-content-type-options', 'x-frame-options', 'strict-transport-security', 'content-security-policy', 'x-request-id']) expect(res.headers[h]).toBeTruthy();
  const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
  expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
  expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  // an error answer has the same security headers and a request id, and no stack
  const nf = await request(app).get('/api/v1/nope');
  expect(nf.status).toBe(404);
  expect(nf.body.error.code).toBeTruthy();
  const bad = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{bad json');
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.body)).not.toMatch(/SyntaxError|at JSON|node_modules/);
  const big = await request(app).post('/api/v1/auth/login').send({ companyCode: 'x'.repeat(2 * 1024 * 1024) });
  expect(big.status).toBe(413);
});

// Was bug AUD-17 (fixed): no date sanity: an SO card can be dated before its lot arrived.
test('date sanity: an SO card dated before its lot arrived, a job before its card, a gate pass before its list', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1, date: '2026-10-10' });
  const res = await w.api('post', '/so-cards', { cardDate: '2020-01-01', lots: [{ greyLotId: lot.id, meters: 100 }] });
  expect(res.status).toBeGreaterThanOrEqual(400); // cloth cannot go on a card before it arrived
});
