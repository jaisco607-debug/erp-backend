const { app, request, clean, makeUser, loginAs } = require('./helpers');
const { Service } = require('../src/models');

beforeEach(clean);

const idsOf = async (...codes) => (await Service.findAll({ where: { code: codes } })).map((s) => s.id);

async function setup() {
  const sa = await makeUser();
  const saAuth = { Authorization: `Bearer ${(await loginAs(sa)).accessToken}` };
  const sup = (m, url, body) => request(app)[m](`/api/v1${url}`).set(saAuth).send(body);
  const company = (await sup('post', '/companies', { name: 'Mills', admin: { name: 'Boss', email: 'boss@test.com', password: 'Boss-Pass-123' } })).body;
  return { sup, company };
}

const login = async (company, email, password) => (await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email, password })).body;

test('a new company gets nothing; the super admin gives modules, reports and departments one by one', async () => {
  const { sup, company } = await setup();
  expect(company.services).toEqual([]);
  expect((await sup('get', '/companies')).body.data[0].serviceCount).toBe(0);
  const first = await login(company, 'boss@test.com', 'Boss-Pass-123');
  expect(first.services).toEqual([]);

  // every kind can be given: module, report, process, folding, packing
  const codes = ['GREY_STORE', 'CHEMICAL_STORE', 'STORE_REPORTS', 'REPORT_GREY', 'DYEING', 'FOLDING', 'PACKING'];
  const given = await sup('put', `/companies/${company.id}/services`, { serviceIds: await idsOf(...codes) });
  expect(given.status).toBe(200);
  expect(given.body.services.map((s) => s.code).sort()).toEqual([...codes].sort());
  expect(given.body.services.find((s) => s.code === 'REPORT_GREY')).toMatchObject({ kind: 'REPORT', menuGroup: 'REPORTS' });
  expect((await sup('get', '/companies')).body.data[0].serviceCount).toBe(codes.length);

  // the client admin's menu = exactly these services, each with the tab it belongs to
  const me = await login(company, 'boss@test.com', 'Boss-Pass-123');
  expect(me.services.map((s) => [s.code, s.menuGroup]).sort()).toEqual([
    ['CHEMICAL_STORE', 'STORE'], ['DYEING', 'PROCESS'], ['FOLDING', 'PROCESS'], ['GREY_STORE', 'PRODUCTION'],
    ['PACKING', 'PROCESS'], ['REPORT_GREY', 'REPORTS'], ['STORE_REPORTS', 'STORE'],
  ]);

  // take one away (toggle): it disappears from the menu
  await sup('put', `/companies/${company.id}/services/${(await idsOf('CHEMICAL_STORE'))[0]}`, { enabled: false });
  const after = await login(company, 'boss@test.com', 'Boss-Pass-123');
  expect(after.services.map((s) => s.code)).not.toContain('CHEMICAL_STORE');
});

test('services list: kinds, menu groups, a module can be given to companies from the service side', async () => {
  const { sup, company } = await setup();
  const all = (await sup('get', '/services')).body.data;
  const by = (g) => all.filter((s) => s.menuGroup === g).map((s) => s.code);
  expect(by('PRODUCTION').sort()).toEqual(['GATE_PASS', 'GREY_STORE', 'SO_CARD']);
  expect(by('STORE').sort()).toEqual(['CHEMICAL_STORE', 'GENERAL_STORE', 'STORE_REPORTS']);
  expect(by('REPORTS')).toHaveLength(9);
  expect(by('PROCESS')).toEqual(expect.arrayContaining(['DYEING', 'FOLDING', 'PACKING']));
  expect((await sup('get', '/services?kind=REPORT')).body.data).toHaveLength(10);
  expect(all.find((s) => s.code === 'REPORTS')).toBeUndefined();
  // built-in services cannot be deleted (the screen hides their delete button)
  expect(all.filter((s) => s.isBuiltIn)).toHaveLength(16);
  expect(all.find((s) => s.code === 'DYEING').isBuiltIn).toBe(false);

  // modules used to be refused here ("given automatically")
  const grey = all.find((s) => s.code === 'GREY_STORE');
  const res = await sup('post', `/services/${grey.id}/companies`, { companyIds: [company.id] });
  expect(res.status).toBe(200);
  expect(res.body.added).toEqual([company.id]);
  expect((await sup('delete', `/services/${grey.id}`)).body.error.code).toBe('CORE_MODULE');

  // a new service of kind PROCESS lands in the PROCESS tab; menuGroup can be changed
  const wash = (await sup('post', '/services', { code: 'TEST_WASHING', name: 'Washing' })).body;
  expect(wash).toMatchObject({ kind: 'PROCESS', menuGroup: 'PROCESS' });
  expect((await sup('patch', `/services/${wash.id}`, { menuGroup: 'STORE' })).body.menuGroup).toBe('STORE');
  expect((await sup('patch', `/services/${wash.id}`, { menuGroup: 'NOPE' })).status).toBe(400);
});

test('store: chemical and general are separate, and Store Reports is its own service', async () => {
  const { sup, company } = await setup();
  const asBoss = async () => {
    const t = (await login(company, 'boss@test.com', 'Boss-Pass-123')).accessToken;
    return (url) => request(app).get(`/api/v1${url}`).set({ Authorization: `Bearer ${t}` });
  };
  const give = (...codes) => sup('put', `/companies/${company.id}/services`, { serviceIds: [] }).then(async () => sup('put', `/companies/${company.id}/services`, { serviceIds: await idsOf(...codes) }));

  await give('GENERAL_STORE');
  let get = await asBoss();
  expect((await get('/stores/general/items')).status).toBe(200);
  expect((await get('/stores/chemical/items')).status).toBe(403);
  expect((await get('/stores/chemical/inwards')).status).toBe(403);

  // chemical store without Store Reports: everything but the cost reports
  await give('CHEMICAL_STORE');
  get = await asBoss();
  expect((await get('/stores/chemical/items')).status).toBe(200);
  expect((await get('/stores/chemical/stock')).status).toBe(200);
  expect((await get('/stores/chemical/cost/jobs')).status).toBe(403);
  expect((await get('/stores/chemical/cost/so-cards')).status).toBe(403);

  // with Store Reports the cost reports open
  await give('CHEMICAL_STORE', 'STORE_REPORTS');
  get = await asBoss();
  expect((await get('/stores/chemical/cost/jobs')).status).toBe(200);
  expect((await get('/stores/chemical/cost/so-cards')).status).toBe(200);

  // Store Reports alone (no chemical store): only the reports
  await give('STORE_REPORTS');
  get = await asBoss();
  expect((await get('/stores/chemical/cost/jobs')).status).toBe(200);
  expect((await get('/stores/chemical/items')).status).toBe(403);
});

test('client admin passes on only what the company has; losing a service removes it from users', async () => {
  const { sup, company } = await setup();
  await sup('put', `/companies/${company.id}/services`, { serviceIds: await idsOf('REPORT_GREY', 'REPORT_FOLDING') });
  const bossToken = (await login(company, 'boss@test.com', 'Boss-Pass-123')).accessToken;
  const boss = (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${bossToken}` }).send(body);
  const user = (await boss('post', '/users', { name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345' })).body;
  // by code: the database does not promise any order
  const byCode = Object.fromEntries((await Service.findAll({ where: { code: ['REPORT_GREY', 'REPORT_FOLDING', 'REPORT_GATE_PASSES'] } })).map((x) => [x.code, x.id]));
  const { REPORT_GREY: grey, REPORT_FOLDING: folding, REPORT_GATE_PASSES: gate } = byCode;

  // a service the company does not have cannot be given
  expect((await boss('put', `/users/${user.id}/services`, { services: [{ serviceId: gate, access: 'VIEW' }] })).status).toBe(422);
  expect((await boss('put', `/users/${user.id}/services`, { services: [{ serviceId: grey, access: 'VIEW' }, { serviceId: folding, access: 'VIEW' }] })).status).toBe(200);
  let ali = await login(company, 'ali@test.com', 'Ali-Pass-12345');
  expect(ali.services.map((s) => s.code).sort()).toEqual(['REPORT_FOLDING', 'REPORT_GREY']);

  // the super admin takes Folding report away from the company: the user loses it too
  await sup('put', `/companies/${company.id}/services`, { serviceIds: [grey] });
  ali = await login(company, 'ali@test.com', 'Ali-Pass-12345');
  expect(ali.services.map((s) => s.code)).toEqual(['REPORT_GREY']);
  const t = ali.accessToken;
  const get = (url) => request(app).get(`/api/v1${url}`).set({ Authorization: `Bearer ${t}` });
  expect((await get('/reports/folding')).status).toBe(403);
  expect((await get('/reports/grey/lots')).status).toBe(200);
});
