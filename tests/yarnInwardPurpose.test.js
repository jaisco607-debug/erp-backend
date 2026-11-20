const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

const { withContract } = require('./contractHelper');
jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const vendor = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  return { api, viewer: call(viewer), item, vendor };
}

test('yarn inward: for weft, for warp or for both; saved on the entry, shown, filtered, changeable', async () => {
  const w = await setup();
  const fd = (await w.api('get', '/weaving/yarn-inwards/form-data')).body;
  expect(fd.purposes).toEqual([{ value: 'WEFT', text: 'For weft' }, { value: 'WARP', text: 'For warp' }, { value: 'BOTH', text: 'For both' }]);
  expect(fd.defaultPurpose).toBe('BOTH');
  const base = { vendorId: w.vendor.id, itemId: w.item.id, bags: 10, lbsPerBag: 100, ratePerLb: 300 };
  const weft = await w.api('post', '/weaving/yarn-inwards', { ...base, purpose: 'WEFT' });
  const warp = await w.api('post', '/weaving/yarn-inwards', { ...base, purpose: 'warp' }); // letter case does not matter
  const both = await w.api('post', '/weaving/yarn-inwards', { ...base, purpose: 'BOTH' });
  const none = await w.api('post', '/weaving/yarn-inwards', base); // not sent: for both
  expect([weft.status, weft.body.purpose, weft.body.purposeText]).toEqual([201, 'WEFT', 'For weft']);
  expect([warp.body.purpose, warp.body.purposeText]).toEqual(['WARP', 'For warp']);
  expect([both.body.purpose, none.body.purpose, none.body.purposeText]).toEqual(['BOTH', 'BOTH', 'For both']);
  expect((await w.api('post', '/weaving/yarn-inwards', { ...base, purpose: 'LOOM' })).status).toBe(400);
  // an overhead (customer) entry has it too
  const customer = (await w.api('post', '/weaving/customers', { name: 'Ali Traders' })).body;
  expect((await w.api('post', '/weaving/yarn-inwards', await withContract(w.api, w.item, { customerId: customer.id, itemId: w.item.id, bags: 2, lbsPerBag: 50, purpose: 'WARP' }))).body.purpose).toBe('WARP');
  // one entry and the list show it
  expect((await w.api('get', `/weaving/yarn-inwards/${weft.body.id}`)).body).toMatchObject({ purpose: 'WEFT', purposeText: 'For weft' });
  const list = (await w.api('get', '/weaving/yarn-inwards')).body;
  expect(list.data.map((x) => [x.code, x.purpose]).sort()).toEqual([[1, 'WEFT'], [2, 'WARP'], [3, 'BOTH'], [4, 'BOTH'], [5, 'WARP']]);
  // filters: exactly one kind, or what can be used for weft / warp (its own and the ones for both)
  expect((await w.api('get', '/weaving/yarn-inwards?purpose=WEFT')).body.data.map((x) => x.code)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-inwards?purpose=BOTH')).body.total).toBe(2);
  expect((await w.api('get', '/weaving/yarn-inwards?usableFor=WEFT')).body.data.map((x) => x.code).sort()).toEqual([1, 3, 4]);
  expect((await w.api('get', '/weaving/yarn-inwards?usableFor=WARP')).body.data.map((x) => x.code).sort()).toEqual([2, 3, 4, 5]);
  expect((await w.api('get', '/weaving/yarn-inwards?usableFor=BOTH')).status).toBe(400);
  // change it
  const e = await w.api('patch', `/weaving/yarn-inwards/${weft.body.id}`, { purpose: 'BOTH' });
  expect([e.status, e.body.purpose, e.body.purposeText]).toEqual([200, 'BOTH', 'For both']);
  expect((await w.api('patch', `/weaving/yarn-inwards/${weft.body.id}`, { purpose: 'X' })).status).toBe(400);
  // the viewer reads, cannot write
  expect((await w.viewer('get', '/weaving/yarn-inwards?purpose=WARP')).body.total).toBe(2);
  expect((await w.viewer('post', '/weaving/yarn-inwards', { ...base, purpose: 'WEFT' })).status).toBe(403);
});
