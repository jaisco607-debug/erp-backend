// AUDIT: security. (1) a second company must never read or change the first company's data, through ANY route and
// ANY id; (2) no token / bad token / wrong role; (3) employees stay inside their services; (4) mass assignment.
const { world, clean, expectClean, request, app, sequelize, makeUser, loginAs } = require('./world');
const { allRoutes, seedEverything } = require('./seed');

beforeEach(clean);
jest.setTimeout(900000);

const TABLES = [
  'grey_lots', 'grey_lot_thaans', 'grey_returns', 'so_cards', 'so_card_lots', 'so_card_lot_thaans', 'so_card_moves', 'jobs', 'job_items', 'colours', 'customers', 'qualities',
  'vendors', 'store_items', 'store_categories', 'store_brands', 'store_inwards', 'store_inward_lines', 'store_batches', 'store_moves', 'chemical_requests', 'chemical_request_lines',
  'chemical_issue_batches', 'chemical_returns', 'chemical_return_lines', 'store_adjustments', 'store_adjustment_lines', 'packing_lists', 'packing_list_lines', 'gate_passes',
  'folding_lines', 'folding_entries', 'folding_thaans', 'user_services', 'department_chemicals', 'company_services', 'company_counters', 'users', 'companies',
];

/** md5 of every table: a refused call must not change a single row (not even updatedAt) */
async function snapshot() {
  const out = {};
  for (const t of TABLES) {
    const [r] = await sequelize.query(`SELECT md5(COALESCE(string_agg(x::text, ',' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM "${t}" x`, { type: sequelize.QueryTypes.SELECT });
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}
const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);

async function twoCompanies() {
  const A = await world();
  const ids = await seedEverything(A);
  const B = await world();
  return { A, B, ids };
}

test('SWEEP: company B reads or deletes nothing of company A, through any GET / DELETE route and any id', async () => {
  const { A, B, ids } = await twoCompanies();
  const routes = allRoutes().filter((r) => ['get', 'delete'].includes(r.method) && !/\/auth\//.test(r.path) && r.path !== '/api/health');
  const pool = [...new Set(Object.values(ids))];
  const aIds = new Set(pool);
  expect((await B.api('get', '/customers')).status).toBe(200); // the url form is right
  expect((await A.api('get', `/grey-lots/${ids.lot}`)).status).toBe(200);
  expect((await B.api('get', `/grey-lots/${ids.lot}`)).status).toBe(404);
  const before = await snapshot();
  const leaks = [];
  const crashes = [];
  let calls = 0;
  for (const r of routes) {
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const idParams = params.filter((p) => !['code', 'store'].includes(p));
    const fill = (id) => r.path.replace(/:(\w+)/g, (_, p) => (p === 'code' ? 'DYEING' : p === 'store' ? 'chemical' : id));
    const candidates = idParams.length ? pool : [null];
    for (const id of candidates) {
      const url = fill(id).replace(/^\/api\/v1/, '');
      const res = await B.api(r.method, url);
      calls += 1;
      if (res.status >= 500) crashes.push(`${r.method.toUpperCase()} ${url} -> ${res.status}`);
      const text = JSON.stringify(res.body || {});
      const leaked = [...aIds].find((x) => text.includes(x));
      if (res.status < 300 && idParams.length && !(r.method === 'delete' && r.path.includes('/locks/'))) leaks.push(`${r.method.toUpperCase()} ${url} -> ${res.status} (B got an answer for A's id)`);
      else if (leaked) leaks.push(`${r.method.toUpperCase()} ${url} -> ${res.status} body contains A's id ${leaked}`);
    }
  }
  console.log(`sweep: ${routes.length} routes, ${calls} calls`);
  expect(crashes).toEqual([]);
  expect(leaks).toEqual([]);
  expect(diff(before, await snapshot())).toEqual([]);
});

/** valid bodies for every kind of change, against company A's ids; `d` is a Dyeing service id */
function buildCases(ids, soCardLot, d, B) {
  return [
    ['post', `/grey-lots/${ids.lot}/approve`], ['post', `/grey-lots/${ids.lot}/unapprove`], ['post', `/grey-lots/${ids.lot2}/give-back`, { meters: 1, pieces: 1 }],
    ['delete', `/grey-lots/${ids.lot2}/give-back/${ids.giveBack}`], ['patch', `/grey-lots/${ids.lot2}`, { remarks: 'hacked' }], ['put', `/grey-lots/${ids.lot}/active`, { isActive: false }],
    ['delete', `/grey-lots/${ids.lot2}`], ['post', '/grey-lots/fabric-return', { lots: [{ greyLotId: ids.lot, meters: 1 }] }],
    ['patch', `/customers/${ids.customer}`, { name: 'HACKED' }], ['patch', `/qualities/${ids.quality}`, { name: 'HACKED' }], ['patch', `/colours/${ids.colour}`, { name: 'HACKED' }],
    ['patch', `/vendors/${ids.vendor}`, { name: 'HACKED' }], ['delete', `/colours/${ids.colour}`],
    ['patch', `/so-cards/${ids.card2}`, { remarks: 'hacked' }], ['delete', `/so-cards/${ids.card2}`], ['put', `/so-cards/${ids.card2}/confirm`, { isConfirmed: true }],
    ['post', `/so-cards/${ids.card2}/send`, { departmentId: d }], ['post', `/so-cards/${ids.card2}/accept`], ['post', '/so-cards/send-many', { soCardIds: [ids.card2], departmentId: d }],
    ['post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: ids.lot, thaanNos: [3] }] }], ['post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: ids.lot2, meters: 5 }] }],
    ['post', '/jobs', { departmentId: d, items: [{ soCardLotId: soCardLot }] }], ['put', `/jobs/${ids.job}/status`, { status: 'COMPLETE' }], ['put', `/jobs/${ids.job}/operator`, { operatorName: 'X' }], ['patch', `/jobs/${ids.job}`, { remarks: 'x' }],
    ['post', `/departments/DYEING/jobs/${ids.job}/receive`], ['post', `/departments/DYEING/jobs/${ids.job}/accept`], ['post', `/departments/DYEING/jobs/${ids.job}/reject`, { reason: 'x' }],
    ['put', `/departments/DYEING/jobs/${ids.job}/colour`, { colourId: ids.colour }], ['put', `/departments/DYEING/jobs/${ids.job}/operator`, { operatorName: 'X' }], ['put', `/departments/DYEING/jobs/${ids.job}/status`, { status: 'COMPLETE' }],
    ['post', `/departments/DYEING/jobs/${ids.job}/reject-answer`, { decision: 'ACCEPT' }],
    ['put', `/departments/FOLDING/folding/${ids.foldingJob}/${ids.card}`, { pageNo: '1' }], ['post', `/departments/FOLDING/folding/${ids.foldingJob}/${ids.card}/send-packing`, {}],
    ['put', `/departments/FOLDING/folding/${ids.foldingJob}/${ids.card}/close`, { isClosed: true }], ['put', `/departments/FOLDING/folding/${ids.foldingJob}/${ids.card}/confirm`, { isConfirmed: true }],
    ['put', `/departments/FOLDING/folding/${ids.foldingJob}/${ids.card}/grades`, { lines: [{ greyLotId: ids.lot, a: 1 }] }],
    ['post', '/departments/DYEING/chemical-requests', { jobId: ids.job, lines: [{ itemId: ids.item, qty: 1 }] }], ['patch', `/departments/DYEING/chemical-requests/${ids.pendingRequest}`, { notes: 'x' }],
    ['post', `/departments/DYEING/chemical-requests/${ids.pendingRequest}/cancel`], ['post', `/departments/DYEING/chemical-requests/${ids.request}/receive`],
    ['post', '/departments/DYEING/chemical-returns', { requestId: ids.request, lines: [{ requestLineId: ids.requestLine, qty: 1 }] }], ['post', `/departments/DYEING/chemical-returns/${ids.return}/cancel`],
    ['post', `/stores/chemical/requests/${ids.pendingRequest}/accept`], ['post', `/stores/chemical/requests/${ids.pendingRequest}/reject`, { reason: 'x' }], ['post', `/stores/chemical/requests/${ids.pendingRequest}/send`, {}],
    ['post', `/stores/chemical/returns/${ids.return}/receive`], ['post', `/stores/chemical/returns/${ids.return}/reject`, { reason: 'x' }],
    ['patch', `/stores/chemical/items/${ids.item}`, { name: 'HACKED' }], ['delete', `/stores/chemical/items/${ids.item}`], ['patch', `/stores/chemical/categories/${ids.category}`, { name: 'H' }],
    ['patch', `/stores/chemical/inwards/${ids.draftInward}`, { notes: 'x' }], ['post', `/stores/chemical/inwards/${ids.draftInward}/approve`], ['post', `/stores/chemical/inwards/${ids.inward}/unapprove`], ['delete', `/stores/chemical/inwards/${ids.draftInward}`],
    ['post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorId: ids.vendor, lines: [{ itemId: ids.item, qty: 1, rate: 5 }], approve: true }],
    ['post', '/stores/chemical/adjustments', { reason: 'LOST', lines: [{ itemId: ids.item, mode: 'OUT', qty: 1 }] }],
    ['put', '/stores/chemical/department-access/DYEING', { add: [ids.item] }],
    ['put', `/departments/PACKING/packing-lists/${ids.packingList}`, { rateA: 1 }], ['post', `/departments/PACKING/packing-lists/${ids.packingList}/reopen`], ['delete', `/departments/PACKING/packing-lists/${ids.packingList}`],
    ['put', `/departments/PACKING/packing-lists/${ids.packingList}/gate-pass`, { driverName: 'H' }],
    ['post', '/departments/PACKING/packing-lists', { soCardId: ids.card, rateA: 1, lines: [{ greyLotId: ids.lot, grade: 'A', meters: 5 }] }],
    ['patch', `/users/${ids.employee}`, { isActive: false }], ['put', `/users/${ids.employee}/services`, { services: [] }], ['post', `/users/${ids.employee}/reset-password`, { newPassword: 'Hacked-Pass-123' }],
  ];
}

test('ATTACK: company B tries to change company A data with valid bodies; and to use A ids inside its own requests', async () => {
  const { A, B, ids } = await twoCompanies();
  const card = await A.ok('get', `/so-cards/${ids.card2}`);
  const soCardLot = card.lots[0].id;
  const d = B.s.DYEING.id;
  const cases = buildCases(ids, soCardLot, d, B);
  const before = await snapshot();
  const bad = [];
  for (const [method, url, body] of cases) {
    const res = await B.api(method, url, body);
    // 201 is allowed only for B's own records that do not touch A: none of these should be created
    if (res.status < 400 || res.status >= 500) bad.push(`${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  }
  expect(bad).toEqual([]);
  expect(diff(before, await snapshot())).toEqual([]);
  await expectClean();
});

test('NO TOKEN or a bad token: every protected route answers 401', async () => {
  const { A } = await twoCompanies();
  const routes = allRoutes().filter((r) => !['/api/health', '/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/auth/logout'].includes(r.path));
  const tokens = [undefined, 'Bearer', 'Bearer abc', 'Bearer a.b.c', 'Basic dGVzdDp0ZXN0', 'Bearer ' + 'x'.repeat(2000),
    // alg none token for the admin
    `Bearer ${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: A.admin.id, ver: 0 })).toString('base64url')}.`];
  const bad = [];
  for (const r of routes) {
    const url = r.path.replace(/^\/api/, '').replace(/:(\w+)/g, (_, p) => (p === 'code' ? 'DYEING' : p === 'store' ? 'chemical' : '00000000-0000-4000-8000-000000000000'));
    for (const h of tokens) {
      const res = await request(app)[r.method](`/api/${url.replace(/^\//, '')}`).set(h === undefined ? {} : { Authorization: h }).send({});
      if (res.status !== 401) bad.push(`${r.method.toUpperCase()} ${url} with ${String(h).slice(0, 14)} -> ${res.status}`);
    }
  }
  expect(bad).toEqual([]);
});

test('A tampered or expired access token is refused; a token dies after password change and logout-all', async () => {
  const { A } = await twoCompanies();
  const login = async () => (await request(app).post('/api/v1/auth/login').send({ companyCode: A.company.code, email: A.admin.email, password: 'Strong-Pass-123' })).body;
  const t = await login();
  const [h, p, s] = t.accessToken.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), userType: 'SUPER_ADMIN' })).toString('base64url')}.${s}`;
  expect((await request(app).get('/api/v1/super-admins').set({ Authorization: `Bearer ${forged}` })).status).toBe(401);
  expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${t.accessToken}` })).status).toBe(200);
  await request(app).post('/api/v1/auth/logout-all').set({ Authorization: `Bearer ${t.accessToken}` });
  expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${t.accessToken}` })).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
});

test('ROLES: a Dyeing-only employee reaches nothing outside Dyeing; the client-admin-only and super-admin-only routes are closed to him', async () => {
  const { A, ids } = await twoCompanies();
  const emp = await A.employee([['DYEING', 'FULL']]);
  const routes = allRoutes().filter((r) => r.method === 'get' && !/\/auth\//.test(r.path) && r.path !== '/api/health');
  const open = [];
  for (const r of routes) {
    const url = r.path.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, (_, p) => (p === 'code' ? 'DYEING' : p === 'store' ? 'chemical' : ids.job));
    const res = await emp('get', url);
    if (res.status < 300) open.push(url.replace(ids.job, ':id'));
  }
  console.log('GET routes open to a Dyeing-only employee:\n  ' + open.join('\n  '));
  // allowed: Dyeing screens, the colour list and the SO card road of a job. Everything else must be closed.
  const allowed = [/^\/so-cards\/departments$/, /^\/colours/, /^\/departments$/, /^\/departments\/DYEING/, /^\/jobs/];
  const surprise = open.filter((u) => !allowed.some((a) => a.test(u)));
  expect(surprise).toEqual([]);
  // he cannot look at another department
  expect((await emp('get', '/departments/FOLDING/incoming')).status).toBe(403);
  expect((await emp('get', '/departments/PACKING/gate-passes')).status).toBe(403);
});

// Was bug AUD-09 (fixed): GET /jobs/so-card/:id has no department check: any employee reads any SO card road.
test('INSIDE a company: a Dyeing employee reads the full road of an SO card that never was in Dyeing (jobs/so-card/:id)', async () => {
  const { A, ids } = await twoCompanies();
  const emp = await A.employee([['DYEING', 'VIEW']]);
  // the fabric return card went Grey Store -> Folding, never to Dyeing
  const res = await emp('get', `/jobs/so-card/${ids.fabricReturn}`);
  expect(res.status).toBe(403);
});

test('MASS ASSIGNMENT: sending extra fields (role, company, flags, ids) is refused', async () => {
  const { A, B, ids } = await twoCompanies();
  const attempts = [
    ['patch', `/users/${ids.employee}`, { userType: 'SUPER_ADMIN' }], ['patch', `/users/${ids.employee}`, { companyId: B.company.id }], ['patch', `/users/${ids.employee}`, { passwordHash: 'x' }],
    ['post', '/users', { name: 'X', email: 'x@x.com', password: 'Strong-Pass-123', userType: 'CLIENT_ADMIN' }], ['post', '/users', { name: 'X', email: 'x2@x.com', password: 'Strong-Pass-123', companyId: B.company.id }],
    ['patch', `/grey-lots/${ids.lot2}`, { isApproved: true, outwardMeters: 0, companyId: B.company.id }], ['patch', `/grey-lots/${ids.lot2}`, { outwardMeters: 0 }], ['patch', `/grey-lots/${ids.lot2}`, { returnedMeters: 0 }],
    ['patch', `/so-cards/${ids.card2}`, { status: 'IN_DEPARTMENT', totalMeters: 1 }], ['patch', `/jobs/${ids.job}`, { status: 'COMPLETE', totalMeters: 1 }],
    ['patch', `/stores/chemical/items/${ids.item}`, { stockQty: 99999, stockValue: 99999 }], ['patch', `/stores/chemical/inwards/${ids.draftInward}`, { isApproved: true, ipNo: 99 }],
    ['put', `/departments/PACKING/packing-lists/${ids.packingList}`, { status: 'DRAFT', listNo: 1 }], ['post', '/customers', { name: 'Y', companyId: B.company.id, code: 5 }],
    ['post', '/auth/login', { companyCode: A.company.code, email: A.admin.email, password: 'Strong-Pass-123', userType: 'SUPER_ADMIN' }],
  ];
  const bad = [];
  for (const [m, u, b] of attempts) {
    const res = await A.api(m, u, b);
    if (res.status < 400 || res.status >= 500) bad.push(`${m.toUpperCase()} ${u} ${JSON.stringify(b)} -> ${res.status}`);
  }
  expect(bad).toEqual([]);
  await expectClean();
});

test('VIEW ONLY: an employee with View access on every service cannot change anything (60+ valid changing calls)', async () => {
  const { A, ids } = await twoCompanies();
  const card = await A.ok('get', `/so-cards/${ids.card2}`);
  const emp = await A.employee(Object.keys(A.s).map((code) => [code, 'VIEW']));
  const before = await snapshot();
  const cases = buildCases(ids, card.lots[0].id, A.s.DYEING.id, A);
  const done = [];
  for (const [method, url, body] of cases) {
    const res = await emp(method, url, body);
    if (res.status < 400 || res.status >= 500) done.push(`${method.toUpperCase()} ${url.replace(/[0-9a-f-]{36}/g, ':id')} -> ${res.status}`);
  }
  expect(done).toEqual([]);
  expect(diff(before, await snapshot())).toEqual([]);
});
