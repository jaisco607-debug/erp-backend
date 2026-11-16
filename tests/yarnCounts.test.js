const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  const blind = await makeUser({ userType: 'USER', companyId: company.id });
  return { company, admin: call(admin), viewer: call(viewer), blind: call(blind) };
}

test('yarn counts: unique ids and running codes; the same name in any letter case or spacing is a duplicate; update / delete / reuse of the name', async () => {
  const w = await setup();
  const names = ['22|s', '22|1', '22|s cotton', '22|s Polister cotton'];
  const made = [];
  for (const name of names) {
    const r = await w.admin('post', '/weaving/yarn-counts', { name });
    expect(r.status).toBe(201);
    made.push(r.body);
  }
  expect(made.map((m) => m.code)).toEqual([1, 2, 3, 4]);
  expect(new Set(made.map((m) => m.id)).size).toBe(4);
  expect(made[2]).toMatchObject({ name: '22|s cotton', isActive: true });

  // duplicates: other letter case, extra / outer spaces
  for (const dupName of ['22|s Cotton', '22|S COTTON', '  22|s   cotton ', '22|S']) {
    const r = await w.admin('post', '/weaving/yarn-counts', { name: dupName });
    err(r, 422, 'DUPLICATE_ENTRY');
    expect(r.body.error.message).toMatch(/Duplicate entry/);
  }
  expect((await w.admin('get', '/weaving/yarn-counts')).body.total).toBe(4);

  // spaces are squeezed in what is saved
  const sq = await w.admin('post', '/weaving/yarn-counts', { name: '  30|s   Combed  ' });
  expect(sq.body.name).toBe('30|s Combed');

  // update: own name again is fine, a clash with another count is not
  expect((await w.admin('patch', `/weaving/yarn-counts/${made[2].id}`, { name: '22|S Cotton' })).body.name).toBe('22|S Cotton');
  err(await w.admin('patch', `/weaving/yarn-counts/${made[2].id}`, { name: '22|1' }), 422, 'DUPLICATE_ENTRY');
  expect((await w.admin('patch', `/weaving/yarn-counts/${made[2].id}`, { isActive: false })).body.isActive).toBe(false);
  // after the change the old spelling is the same count
  err(await w.admin('post', '/weaving/yarn-counts', { name: '22|s cotton' }), 422, 'DUPLICATE_ENTRY');

  // search and filters
  expect((await w.admin('get', '/weaving/yarn-counts?search=polister')).body.data.map((x) => x.name)).toEqual(['22|s Polister cotton']);
  expect((await w.admin('get', '/weaving/yarn-counts?isActive=false')).body.data.map((x) => x.code)).toEqual([3]);

  // delete hides the count and frees its name; the code is never given again
  expect((await w.admin('delete', `/weaving/yarn-counts/${made[1].id}`)).body).toMatchObject({ deleted: true });
  err(await w.admin('get', `/weaving/yarn-counts/${made[1].id}`), 404, 'NOT_FOUND');
  const again = await w.admin('post', '/weaving/yarn-counts', { name: '22|1' });
  expect(again.status).toBe(201);
  expect(again.body.code).toBe(6);

  // validation
  expect((await w.admin('post', '/weaving/yarn-counts', { name: '   ' })).status).toBe(400);
  expect((await w.admin('post', '/weaving/yarn-counts', { name: 'x'.repeat(81) })).status).toBe(400);
  expect((await w.admin('post', '/weaving/yarn-counts', {})).status).toBe(400);
});

test('yarn counts: two companies keep separate lists; VIEW reads but cannot change; no service = no access', async () => {
  const w = await setup();
  const a = await w.admin('post', '/weaving/yarn-counts', { name: '22|s' });
  expect(a.status).toBe(201);
  // the other company can use the same name and does not see this one
  const other = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: other.id, serviceId: svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-counts')).body.total).toBe(0);
  const b = await oa('post', '/weaving/yarn-counts', { name: '22|S' });
  expect(b.status).toBe(201);
  expect(b.body.code).toBe(1);
  err(await oa('get', `/weaving/yarn-counts/${a.body.id}`), 404, 'NOT_FOUND');
  err(await oa('patch', `/weaving/yarn-counts/${a.body.id}`, { name: 'zz' }), 404, 'NOT_FOUND');
  // access levels
  expect((await w.viewer('get', '/weaving/yarn-counts')).status).toBe(200);
  expect((await w.viewer('post', '/weaving/yarn-counts', { name: '40|s' })).status).toBe(403);
  expect((await w.viewer('delete', `/weaving/yarn-counts/${a.body.id}`)).status).toBe(403);
  expect((await w.blind('get', '/weaving/yarn-counts')).status).toBe(403);
});

test('two people adding the same count at the same moment: only one is saved', async () => {
  const w = await setup();
  const results = await Promise.all(['22|s Cotton', '22|S cotton', '22|s COTTON'].map((name) => w.admin('post', '/weaving/yarn-counts', { name })));
  expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
  expect((await w.admin('get', '/weaving/yarn-counts')).body.total).toBe(1);
});
