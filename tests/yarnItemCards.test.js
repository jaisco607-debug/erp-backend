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
  return { company, svc, admin: call(admin), viewer: call(viewer) };
}

test('brands: unique name in any letter case, running code, update / delete', async () => {
  const w = await setup();
  const a = await w.admin('post', '/weaving/brands', { name: 'Crescent' });
  expect([a.status, a.body.code]).toEqual([201, 1]);
  expect((await w.admin('post', '/weaving/brands', { name: 'Reliance' })).body.code).toBe(2);
  for (const n of ['crescent', 'CRESCENT', ' Crescent  ']) {
    const r = await w.admin('post', '/weaving/brands', { name: n });
    err(r, 422, 'DUPLICATE_ENTRY');
    expect(r.body.error.message).toMatch(/Duplicate entry: brand/);
  }
  err(await w.admin('patch', `/weaving/brands/${a.body.id}`, { name: 'reliance' }), 422, 'DUPLICATE_ENTRY');
  expect((await w.admin('patch', `/weaving/brands/${a.body.id}`, { name: 'CRESCENT' })).body.name).toBe('CRESCENT');
  expect((await w.admin('get', '/weaving/brands?search=rel')).body.data.map((b) => b.name)).toEqual(['Reliance']);
  expect((await w.viewer('post', '/weaving/brands', { name: 'X' })).status).toBe(403);
  expect((await w.admin('delete', `/weaving/brands/${a.body.id}`)).body.deleted).toBe(true);
  expect((await w.admin('post', '/weaving/brands', { name: 'crescent' })).status).toBe(201);
});

test('item cards: count + brand + packing + bags with defaults 24 / 100; combination is unique; masters in use cannot be deleted; switched-off masters cannot be picked', async () => {
  const w = await setup();
  const count = (await w.admin('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const count2 = (await w.admin('post', '/weaving/yarn-counts', { name: '30|s' })).body;
  const brand = (await w.admin('post', '/weaving/brands', { name: 'Crescent' })).body;

  expect((await w.admin('get', '/weaving/item-cards/options')).body).toEqual({ packings: [8, 12, 24, 40], defaultPacking: 24, bags: [50, 100], defaultBags: 100 });

  // defaults
  const c1 = await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id });
  expect(c1.status).toBe(201);
  expect(c1.body).toMatchObject({ code: 1, packing: 24, bags: 100, isActive: true, name: '22|s Cotton - Crescent - 24 - 100',
    yarnCount: { id: count.id, name: '22|s Cotton' }, brand: { id: brand.id, name: 'Crescent' } });
  // other packing / bags make another card; the same combination does not
  const c2 = await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id, packing: 40, bags: 50 });
  expect([c2.status, c2.body.code, c2.body.packing, c2.body.bags]).toEqual([201, 2, 40, 50]);
  const d = await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id });
  err(d, 422, 'DUPLICATE_ENTRY');
  expect(d.body.error.message).toMatch(/Duplicate entry/);
  // only the listed values
  expect((await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id, packing: 10 })).status).toBe(400);
  expect((await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id, bags: 75 })).status).toBe(400);
  expect((await w.admin('post', '/weaving/item-cards', { brandId: brand.id })).status).toBe(400);
  err(await w.admin('post', '/weaving/item-cards', { yarnCountId: '11111111-1111-4111-8111-111111111111', brandId: brand.id }), 422, 'UNKNOWN_YARN_COUNT');

  // update: into an existing combination is refused, own values again are fine
  err(await w.admin('patch', `/weaving/item-cards/${c2.body.id}`, { packing: 24, bags: 100 }), 422, 'DUPLICATE_ENTRY');
  expect((await w.admin('patch', `/weaving/item-cards/${c2.body.id}`, { packing: 40, bags: 50, yarnCountId: count2.id })).body.name).toBe('30|s - Crescent - 40 - 50');

  // list, filters, search
  const all = (await w.admin('get', '/weaving/item-cards')).body;
  expect([all.total, all.data.map((x) => x.code)]).toEqual([2, [1, 2]]);
  expect((await w.admin('get', `/weaving/item-cards?yarnCountId=${count2.id}`)).body.data.map((x) => x.code)).toEqual([2]);
  expect((await w.admin('get', '/weaving/item-cards?search=cotton')).body.data.map((x) => x.code)).toEqual([1]);
  expect((await w.admin('get', '/weaving/item-cards?search=crescent')).body.total).toBe(2);
  expect((await w.viewer('get', `/weaving/item-cards/${c1.body.id}`)).body.code).toBe(1);

  // a count / brand an item card uses cannot be deleted
  const inUse = await w.admin('delete', `/weaving/yarn-counts/${count.id}`);
  err(inUse, 422, 'IN_USE');
  expect(inUse.body.error.details).toEqual({ itemCards: 1 });
  err(await w.admin('delete', `/weaving/brands/${brand.id}`), 422, 'IN_USE');

  // switched off: cannot be picked for a new card, the old cards keep showing it
  await w.admin('patch', `/weaving/brands/${brand.id}`, { isActive: false });
  err(await w.admin('post', '/weaving/item-cards', { yarnCountId: count2.id, brandId: brand.id, packing: 8 }), 422, 'BRAND_INACTIVE');
  expect((await w.admin('get', `/weaving/item-cards/${c1.body.id}`)).body.brand.name).toBe('Crescent');
  expect((await w.admin('patch', `/weaving/item-cards/${c1.body.id}`, { packing: 12 })).body.packing).toBe(12);
  await w.admin('patch', `/weaving/brands/${brand.id}`, { isActive: true });

  // delete an item card: hidden, the combination is free again; then the master can be deleted
  expect((await w.admin('delete', `/weaving/item-cards/${c1.body.id}`)).body.deleted).toBe(true);
  err(await w.admin('get', `/weaving/item-cards/${c1.body.id}`), 404, 'NOT_FOUND');
  expect((await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id, packing: 12 })).status).toBe(201);
  expect((await w.admin('delete', `/weaving/yarn-counts/${count2.id}`)).status).toBe(422); // c2 still uses it
});

test('item cards: another company cannot see or use them; two cards made at the same moment: one wins', async () => {
  const w = await setup();
  const count = (await w.admin('post', '/weaving/yarn-counts', { name: '22|s' })).body;
  const brand = (await w.admin('post', '/weaving/brands', { name: 'B1' })).body;
  const card = (await w.admin('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/item-cards')).body.total).toBe(0);
  err(await oa('get', `/weaving/item-cards/${card.id}`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id }), 422, 'UNKNOWN_YARN_COUNT');
  const count2 = (await w.admin('post', '/weaving/yarn-counts', { name: '40|s' })).body;
  const rs = await Promise.all([1, 2, 3].map(() => w.admin('post', '/weaving/item-cards', { yarnCountId: count2.id, brandId: brand.id })));
  expect(rs.map((r) => r.status).sort()).toEqual([201, 422, 422]);
});
