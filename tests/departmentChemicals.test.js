const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

test('chemical store gives a department only some chemicals; the department sees only those', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['CHEMICAL_STORE', 'DYEING', 'PRINTING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  // nothing given yet: the department sees no chemical
  expect((await api('get', '/departments/DYEING/chemicals')).body.data).toEqual([]);
  let list = (await api('get', '/stores/chemical/department-access')).body.data;
  expect(list.find((d) => d.code === 'DYEING')).toMatchObject({ chemicalCount: 0 });

  const all = (await api('get', `/stores/chemical/department-access/${s.DYEING.id}`)).body;
  expect(all.totalCount).toBeGreaterThan(200);
  const vat = all.groups.find((g) => g.category && g.category.name === 'VAT DYES');
  const red = all.groups.find((g) => g.category && g.category.name === 'COTTON COLOUR (REACTIVE DYES)').items.find((i) => i.name === 'RED');

  // tick a whole category, then one more chemical, by department code too
  await api('put', `/stores/chemical/department-access/${s.DYEING.id}`, { add: vat.items.map((i) => i.id) });
  const r = (await api('put', '/stores/chemical/department-access/dyeing', { add: [red.id] })).body;
  expect(r).toMatchObject({ allowedCount: vat.items.length + 1, added: 1 });
  const mine = (await api('get', '/departments/DYEING/chemicals')).body.data;
  expect(mine).toHaveLength(vat.items.length + 1);
  expect(mine.find((i) => i.name === 'RED')).toMatchObject({ unit: 'KG', hasSubUnit: true, stock: { text: '0 KG' } });
  expect((await api('get', '/departments/PRINTING/chemicals')).body.data).toEqual([]);
  expect((await api('get', `/stores/chemical/department-access/${s.DYEING.id}`)).body.groups.find((g) => g.category && g.category.name === 'VAT DYES')).toMatchObject({ allowedCount: vat.items.length });

  // remove one, then replace the whole list
  await api('put', `/stores/chemical/department-access/${s.DYEING.id}`, { remove: [red.id] });
  expect((await api('get', '/departments/DYEING/chemicals?search=red')).body.data.map((i) => i.name)).not.toContain('RED');
  expect((await api('put', `/stores/chemical/department-access/${s.DYEING.id}`, { itemIds: [red.id] })).body.allowedCount).toBe(1);
  expect((await api('put', `/stores/chemical/department-access/${s.DYEING.id}`, { itemIds: [] })).body.allowedCount).toBe(0);
  expect((await api('get', '/stores/general/department-access')).status).toBe(404);

  // a user of another department cannot read Dyeing's chemicals
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: user.id, serviceId: s.PRINTING.id, access: 'FULL' });
  const uauth = { Authorization: `Bearer ${(await loginAs(user)).accessToken}` };
  expect((await request(app).get('/api/v1/departments/DYEING/chemicals').set(uauth)).status).toBe(403);
  expect((await request(app).get('/api/v1/departments/PRINTING/chemicals').set(uauth)).status).toBe(200);
  expect((await request(app).put(`/api/v1/stores/chemical/department-access/${s.DYEING.id}`).set(uauth).send({ itemIds: [] })).status).toBe(403);
});
