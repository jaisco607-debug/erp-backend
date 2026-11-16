const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, StoreYarnInward } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code: 'YARN_STORE' } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const svc = (await Service.findOne({ where: { code: 'YARN_STORE' } })).id;
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc, access: 'VIEW' });
  const staff = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: staff.id, serviceId: svc, access: 'FULL' });
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Yarn Mills' })).body;
  return { company, api, viewer: call(viewer), staff: call(staff), vendor };
}
const body = (w, extra = {}) => ({ inwardDate: '2026-11-10', vendorId: w.vendor.id, yarnName: '22/s Cotton', brand: 'Crescent', bags: 10, lbsPerBag: 50, ratePerLb: 300, dcNo: 'Y-1', ...extra });

test('yarn inward typed on the form (no masters): bags x lbs per bag, rate per lb, amount, numbers, suggestions', async () => {
  const w = await setup();
  const fd = await w.api('get', '/store-yarn-inwards/form-data');
  expect([fd.status, fd.body.nextInwardNo, fd.body.nextInwardText, fd.body.yarnNames]).toEqual([200, 1, '00001', []]);
  expect(fd.body.vendors.map((v) => v.name)).toEqual(['Yarn Mills']);
  const r = await w.api('post', '/store-yarn-inwards', body(w, { yarnName: '  22/s   Cotton ' }));
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ inwardNo: 1, inwardText: '00001', yarnName: '22/s Cotton', brand: 'Crescent', title: '22/s Cotton - Crescent', bags: 10, lbsPerBag: 50, totalLbs: 500,
    ratePerLb: 300, hasRate: true, amount: 150000, outwardBags: 0, balanceBags: 10, balanceLbs: 500, balanceValue: 150000, isApproved: false, statusText: 'UN-APPROVED', dcNo: 'Y-1' });
  expect(r.body.vendor).toMatchObject({ name: 'Yarn Mills', label: 'Yarn Mills (1)' });
  // no brand, no rate; a bag weight with decimals
  const n = await w.api('post', '/store-yarn-inwards', body(w, { brand: undefined, ratePerLb: undefined, bags: 3, lbsPerBag: 45.5 }));
  expect(n.body).toMatchObject({ inwardNo: 2, brand: null, title: '22/s Cotton', totalLbs: 136.5, ratePerLb: null, hasRate: false, amount: null, balanceValue: null });
  // suggestions from what was typed before
  const fd2 = (await w.api('get', '/store-yarn-inwards/form-data')).body;
  expect([fd2.nextInwardNo, fd2.yarnNames, fd2.brands, fd2.lbsPerBagValues.sort((a, b) => a - b)]).toEqual([3, ['22/s Cotton'], ['Crescent'], [45.5, 50]]);
  // required fields and limits
  for (const bad of [{ yarnName: '' }, { bags: 0 }, { lbsPerBag: 0 }, { bags: 2.5 }, { ratePerLb: 0 }, { vendorId: undefined }, { inwardDate: undefined }]) {
    expect((await w.api('post', '/store-yarn-inwards', body(w, bad))).status).toBe(400);
  }
  err(await w.api('post', '/store-yarn-inwards', body(w, { vendorId: '11111111-1111-4111-8111-111111111111' })), 422, 'UNKNOWN_VENDOR');
  // list, search, filters
  const list = await w.api('get', '/store-yarn-inwards');
  expect([list.body.total, list.body.data.map((x) => x.inwardNo)]).toEqual([2, [2, 1]]);
  expect(list.body.totals).toMatchObject({ entries: 2, allBags: 13, allLbs: 636.5, allAmount: 150000 });
  expect((await w.api('get', '/store-yarn-inwards?search=crescent')).body.total).toBe(1);
  expect((await w.api('get', '/store-yarn-inwards?search=yarn mills')).body.total).toBe(2);
  expect((await w.api('get', '/store-yarn-inwards?search=Y-1')).body.total).toBe(2);
  expect((await w.api('get', '/store-yarn-inwards?dateFrom=2026-11-11')).body.total).toBe(0);
});

test('edit, approve, delete rules, numbering, access', async () => {
  const w = await setup();
  const a = (await w.api('post', '/store-yarn-inwards', body(w))).body;
  const e = await w.api('patch', `/store-yarn-inwards/${a.id}`, { bags: 20, lbsPerBag: 40, ratePerLb: 250, brand: '' });
  expect([e.status, e.body.totalLbs, e.body.amount, e.body.brand, e.body.balanceBags]).toEqual([200, 800, 200000, null, 20]);
  expect((await w.api('patch', `/store-yarn-inwards/${a.id}`, { ratePerLb: null })).body.amount).toBeNull();
  expect((await w.api('patch', `/store-yarn-inwards/${a.id}`, {})).status).toBe(400);
  // approve: locked; the admin alone takes it back, and only while no bag has gone out
  expect((await w.viewer('post', `/store-yarn-inwards/${a.id}/approve`)).status).toBe(403);
  expect((await w.staff('post', `/store-yarn-inwards/${a.id}/approve`)).body).toMatchObject({ isApproved: true, statusText: 'APPROVED' });
  err(await w.api('patch', `/store-yarn-inwards/${a.id}`, { bags: 1 }), 422, 'INWARD_APPROVED');
  err(await w.api('delete', `/store-yarn-inwards/${a.id}`), 422, 'INWARD_APPROVED');
  expect((await w.staff('post', `/store-yarn-inwards/${a.id}/unapprove`)).status).toBe(403);
  await StoreYarnInward.update({ outwardBags: 5 }, { where: { id: a.id } });
  err(await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`), 422, 'INWARD_IN_USE');
  await StoreYarnInward.update({ outwardBags: 0 }, { where: { id: a.id } });
  expect((await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`)).body.isApproved).toBe(false);
  // switched off: cannot approve; delete a draft; numbers are not reused
  await w.api('put', `/store-yarn-inwards/${a.id}/active`, { isActive: false });
  err(await w.api('post', `/store-yarn-inwards/${a.id}/approve`), 422, 'INWARD_INACTIVE');
  expect((await w.api('delete', `/store-yarn-inwards/${a.id}`)).status).toBe(204);
  expect((await w.api('get', `/store-yarn-inwards/${a.id}`)).status).toBe(404);
  expect((await w.api('post', '/store-yarn-inwards', body(w))).body.inwardNo).toBe(2);
  // numbering
  expect((await w.api('post', '/store-yarn-inwards', body(w, { inwardNo: 50 }))).body.inwardNo).toBe(50);
  expect((await w.api('get', '/store-yarn-inwards/numbering')).body.nextInwardNo).toBe(51);
  err(await w.api('post', '/store-yarn-inwards', body(w, { inwardNo: 50 })), 422, 'INWARD_NO_TAKEN');
  err(await w.api('put', '/store-yarn-inwards/numbering', { nextInwardNo: 10 }), 422, 'NUMBER_USED');
  expect((await w.api('put', '/store-yarn-inwards/numbering', { nextInwardNo: 100 })).body).toEqual({ nextInwardNo: 100 });
  expect((await w.api('post', '/store-yarn-inwards', body(w))).body.inwardNo).toBe(100);
  expect((await w.staff('put', '/store-yarn-inwards/numbering', { nextInwardNo: 200 })).status).toBe(403);
  // a vendor used by an entry cannot be deleted; a switched-off vendor is refused; the yarn store people see the vendor list
  err(await w.api('delete', `/vendors/${w.vendor.id}`), 422, 'IN_USE');
  const v2 = (await w.api('post', '/vendors', { name: 'Second' })).body;
  await w.api('patch', `/vendors/${v2.id}`, { isActive: false });
  err(await w.api('post', '/store-yarn-inwards', body(w, { vendorId: v2.id })), 422, 'VENDOR_INACTIVE');
  expect((await w.viewer('get', '/vendors')).status).toBe(200);
  expect((await w.viewer('post', '/store-yarn-inwards', body(w))).status).toBe(403);
});

test('yarn stock: approved entries with bags left; the same yarn added up; value; another company sees nothing', async () => {
  const w = await setup();
  const mk = async (extra, approve = true) => {
    const e = (await w.api('post', '/store-yarn-inwards', body(w, extra))).body;
    if (approve) await w.api('post', `/store-yarn-inwards/${e.id}/approve`);
    return e;
  };
  const a = await mk({}); // 22/s Cotton - Crescent: 10 bags x 50 = 500 lbs, 150,000
  await mk({ yarnName: '22/S COTTON', brand: 'crescent', bags: 4, lbsPerBag: 100, ratePerLb: 310, inwardDate: '2026-11-11' }); // the same yarn (letter case does not matter): 400 lbs, 124,000
  const c = await mk({ yarnName: '30/s Polyester', brand: undefined, bags: 2, lbsPerBag: 60, ratePerLb: undefined }); // no rate
  await mk({ yarnName: 'Draft yarn' }, false);
  const st = await w.api('get', '/store-yarn-inwards/stock');
  expect(st.status).toBe(200);
  expect(st.body.totals).toEqual({ entries: 3, inwardBags: 16, balanceBags: 16, balanceLbs: 1020, balanceValue: 274000 });
  expect(st.body.byYarn.map((y) => [y.title, y.entries, y.balanceBags, y.balanceLbs, y.balanceValue])).toEqual([['22/S COTTON - crescent', 2, 14, 900, 274000], ['30/s Polyester', 1, 2, 120, 0]]);
  expect(st.body.data.map((x) => x.inwardNo)).toEqual([2, 3, 1]); // newest date first (entry 2 is dated 11-11), drafts not in stock
  // bags that went out (the outward step comes next) reduce the stock; used-up entries are hidden unless showZero
  await StoreYarnInward.update({ outwardBags: 4 }, { where: { id: a.id } });
  const s2 = (await w.api('get', '/store-yarn-inwards/stock')).body;
  expect(s2.totals).toMatchObject({ balanceBags: 12, balanceLbs: 820, balanceValue: 214000 });
  expect(s2.data.find((x) => x.id === a.id)).toMatchObject({ balanceBags: 6, balanceLbs: 300, balanceValue: 90000 });
  await StoreYarnInward.update({ outwardBags: 2 }, { where: { id: c.id } });
  expect((await w.api('get', '/store-yarn-inwards/stock')).body.total).toBe(2);
  expect((await w.api('get', '/store-yarn-inwards/stock?showZero=true')).body.total).toBe(3);
  expect((await w.api('get', '/store-yarn-inwards/stock?search=polyester&showZero=true')).body.total).toBe(1);
  // a switched-off entry is not stock
  await w.api('put', `/store-yarn-inwards/${a.id}/active`, { isActive: false });
  expect((await w.api('get', '/store-yarn-inwards/stock')).body.byYarn.map((y) => y.balanceBags)).toEqual([4]);
  expect((await w.viewer('get', '/store-yarn-inwards/stock')).status).toBe(200);
  const o = await setup();
  expect((await o.api('get', '/store-yarn-inwards/stock')).body.total).toBe(0);
  expect((await o.api('get', `/store-yarn-inwards/${a.id}`)).status).toBe(404);
  // a company without the service is refused
  const none = await makeCompany();
  expect((await call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: none.id }))('get', '/store-yarn-inwards')).status).toBe(403);
});
