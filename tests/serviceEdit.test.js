const { app, request, clean, makeUser, loginAs } = require('./helpers');
const { Service } = require('../src/models');

beforeEach(clean);
afterEach(() => Service.destroy({ where: { code: ['WASHING', 'PACK2'] } })); // the services this file made

const idOf = async (code) => (await Service.findOne({ where: { code } })).id;

async function setup() {
  const sa = await makeUser();
  const saAuth = { Authorization: `Bearer ${(await loginAs(sa)).accessToken}` };
  const sup = (m, url, body) => request(app)[m](`/api/v1${url}`).set(saAuth).send(body);
  const company = (await sup('post', '/companies', { name: 'Mills', processManagement: true, processLimit: 2, admin: { name: 'Boss', email: 'boss@test.com', password: 'Boss-Pass-123' } })).body;
  return { sup, company };
}
const codesOf = async (sup, company) => (await sup('get', `/companies/${company.id}`)).body.services.map((s) => s.code).sort();

test('edit a service: name, kind, menu group, colour tracking; the code never changes; built-in modules keep their kind and group', async () => {
  const { sup } = await setup();
  const made = (await sup('post', '/services', { code: 'WASHING', name: 'Washing', kind: 'PROCESS' })).body;
  const edited = await sup('patch', `/services/${made.id}`, { name: 'Wash Dept', kind: 'MODULE', menuGroup: 'STORE', tracksColour: false });
  expect(edited.status).toBe(200);
  expect(edited.body).toMatchObject({ code: 'WASHING', name: 'Wash Dept', kind: 'MODULE', menuGroup: 'STORE', tracksColour: false, isBuiltIn: false });
  const code = await sup('patch', `/services/${made.id}`, { code: 'OTHER' });
  expect(code.status).toBe(400);
  expect(code.body.error.code).toBe('VALIDATION_FAILED');
  expect((await sup('patch', `/services/${made.id}`, {})).status).toBe(400);
  expect((await sup('patch', `/services/${made.id}`, { kind: 'NOPE' })).status).toBe(400);
  expect((await sup('patch', '/services/8f3c1a2e-1111-4222-8333-444455556666', { name: 'X' })).status).toBe(404);
  // a service made packing moves to Production Management, whatever group was sent
  const packing = await sup('patch', `/services/${made.id}`, { kind: 'PACKING', menuGroup: 'STORE' });
  expect(packing.body).toMatchObject({ kind: 'PACKING', menuGroup: 'PRODUCTION' });
  expect((await sup('post', '/services', { code: 'PACK2', name: 'Packing two', kind: 'PACKING', menuGroup: 'STORE' })).body.menuGroup).toBe('PRODUCTION');

  // built-in: kind, group and colour tracking are locked (403 CORE_MODULE); a rename is allowed
  const grey = await idOf('GREY_STORE');
  for (const body of [{ kind: 'PROCESS' }, { menuGroup: 'STORE' }, { tracksColour: false }]) {
    const r = await sup('patch', `/services/${grey}`, body);
    expect([r.status, r.body.error.code]).toEqual([403, 'CORE_MODULE']);
  }
  expect((await sup('patch', `/services/${grey}`, { name: 'Grey Fabric Store' })).body.name).toBe('Grey Fabric Store');
  expect((await sup('patch', `/services/${grey}`, { kind: 'MODULE', menuGroup: 'PRODUCTION' })).status).toBe(200); // unchanged values are fine
});

test('the packing service lives in Production Management', async () => {
  const { sup } = await setup();
  const list = (await sup('get', '/services?kind=PACKING')).body.data;
  expect(list.length).toBeGreaterThan(0);
  expect(list.every((s) => s.menuGroup === 'PRODUCTION')).toBe(true);
  expect((await sup('get', '/services')).body.data.find((s) => s.code === 'REPORT_PACKING').menuGroup).toBe('REPORTS');
});

test('a process brings folding and packing: for a company, for the companies a service is given to, and for a user (VIEW, never a downgrade)', async () => {
  const { sup, company } = await setup();
  // the company toggle
  await sup('put', `/companies/${company.id}/services/${await idOf('DYEING')}`, { enabled: true });
  expect(await codesOf(sup, company)).toEqual(['DYEING', 'FOLDING', 'PACKING']);
  // switching the process off is not coupled
  await sup('put', `/companies/${company.id}/services/${await idOf('DYEING')}`, { enabled: false });
  expect(await codesOf(sup, company)).toEqual(['FOLDING', 'PACKING']);
  // a whole list
  await sup('put', `/companies/${company.id}/services`, { serviceIds: [await idOf('GREY_STORE'), await idOf('DYEING')] });
  expect(await codesOf(sup, company)).toEqual(['DYEING', 'FOLDING', 'GREY_STORE', 'PACKING']);
  // a list without a process does not bring them
  await sup('put', `/companies/${company.id}/services`, { serviceIds: [await idOf('GREY_STORE')] });
  expect(await codesOf(sup, company)).toEqual(['GREY_STORE']);
  // from the service side
  const other = (await sup('post', '/companies', { name: 'Looms', processManagement: true, processLimit: 2, admin: { name: 'Boss2', email: 'b2@test.com', password: 'Boss-Pass-123' } })).body;
  expect((await sup('post', `/services/${await idOf('DYEING')}/companies`, { companyIds: [other.id] })).status).toBeLessThan(300);
  expect(await codesOf(sup, other)).toEqual(['DYEING', 'FOLDING', 'PACKING']);

  // a user: the client admin gives a process, the user gets folding and packing as VIEW
  const login = await request(app).post('/api/v1/auth/login').send({ companyCode: other.code, email: 'b2@test.com', password: 'Boss-Pass-123' });
  const boss = (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${login.body.accessToken}` }).send(body);
  const user = (await boss('post', '/users', { name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345' })).body;
  const dyeing = await idOf('DYEING');
  const folding = await idOf('FOLDING');
  const granted = await boss('put', `/users/${user.id}/services`, { services: [{ serviceId: dyeing, access: 'FULL' }] });
  expect(granted.status).toBe(200);
  const got = (await boss('get', `/users/${user.id}`)).body.services.map((s) => [s.code, s.access]).sort();
  expect(got).toEqual([['DYEING', 'FULL'], ['FOLDING', 'VIEW'], ['PACKING', 'VIEW']]);
  // an access level given on purpose is not downgraded
  await boss('put', `/users/${user.id}/services`, { services: [{ serviceId: dyeing, access: 'VIEW' }, { serviceId: folding, access: 'FULL' }] });
  const kept = (await boss('get', `/users/${user.id}`)).body.services.map((s) => [s.code, s.access]).sort();
  expect(kept).toEqual([['DYEING', 'VIEW'], ['FOLDING', 'FULL'], ['PACKING', 'VIEW']]);
});
