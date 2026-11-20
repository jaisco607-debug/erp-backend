const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

const { withContract } = require('./contractHelper');
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
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const vendor = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const customer = (await api('post', '/weaving/customers', { name: 'Ali Traders' })).body;
  const inward = async (b) => (await api('post', '/weaving/yarn-inwards', await withContract(api, item, { itemId: item.id, ...b }))).body;
  const e1 = await inward({ vendorId: vendor.id, bags: 10, lbsPerBag: 100, ratePerLb: 10, inwardDate: '2026-11-01' });
  const e2 = await inward({ customerId: customer.id, bags: 4, lbsPerBag: 50.5, inwardDate: '2026-11-03' });
  return { company, svc, api, viewer: call(viewer), item, vendor, customer, e1, e2 };
}

test('yarn weft: a challan takes any bags of any stock entries; challan numbers run; stock and inward balances follow; delete puts the yarn back', async () => {
  const w = await setup();
  const pick = (await w.api('get', '/weaving/yarn-weft/stock-entries')).body;
  expect(pick.total).toBe(2);
  expect(pick.data[0]).toMatchObject({ id: w.e1.id, code: 1, party: { name: 'Yarn Mills', kind: 'VENDOR' }, lbsPerBag: 100, bags: 10, balanceBags: 10, balanceLbs: 1000, item: { yarnCount: { name: '22|s Cotton' }, brand: { name: 'Crescent' }, packing: 24 } });

  const c1 = await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-05', department: 'Sulzer', description: 'weft issue',
    lines: [{ inwardId: w.e1.id, bags: 3 }, { inwardId: w.e2.id, bags: 4 }] });
  expect(c1.status).toBe(201);
  expect(c1.body).toMatchObject({ type: 'WEFT', challanNo: 1, challanText: '00001', outwardDate: '2026-11-05', department: 'Sulzer', description: 'weft issue', totalBags: 7, totalLbs: 502 });
  expect(c1.body.lines).toHaveLength(2);
  expect(c1.body.lines[0]).toMatchObject({ inwardId: w.e1.id, party: { name: 'Yarn Mills' }, brand: { name: 'Crescent' }, yarnCount: { name: '22|s Cotton' }, packing: 24, lbsPerBag: 100, bags: 3, lbs: 300 });
  expect(c1.body.lines[1]).toMatchObject({ party: { kind: 'CUSTOMER', name: 'Ali Traders' }, bags: 4, lbs: 202 });

  // stock: entry balances and the stock screen
  const pick2 = (await w.api('get', '/weaving/yarn-weft/stock-entries')).body;
  expect(pick2.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 7]]);
  const ent = (await w.api('get', `/weaving/yarn-inwards/${w.e1.id}`)).body;
  expect([ent.bags, ent.outwardBags, ent.balanceBags]).toEqual([10, 3, 7]);
  const st = (await w.api('get', '/weaving/yarn-stock')).body;
  expect(st.data.find((r) => r.lbsPerBag === 100)).toMatchObject({ inwardBags: 10, inwardLbs: 1000, outwardBags: 3, outwardLbs: 300, balanceBags: 7, balanceLbs: 700 });
  expect(st.data.find((r) => r.lbsPerBag === 50.5)).toBeUndefined(); // all 4 bags went out: hidden
  expect((await w.api('get', '/weaving/yarn-stock?showZero=true')).body.data.find((r) => r.lbsPerBag === 50.5)).toMatchObject({ balanceBags: 0, outwardBags: 4 });
  expect(st.totals).toMatchObject({ inwardBags: 10, outwardBags: 3, balanceBags: 7, balanceLbs: 700 });
  // as on a date before the challan the stock was whole
  expect((await w.api('get', '/weaving/yarn-stock?dateTo=2026-11-04')).body.totals.balanceBags).toBe(14);

  // more than what is left; unknown entry; date before the yarn came; same entry twice; empty
  const over = await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-06', lines: [{ inwardId: w.e1.id, bags: 8 }] });
  err(over, 422, 'NOT_ENOUGH_STOCK');
  expect(over.body.error.details).toMatchObject({ inwardCode: 1, balanceBags: 7, askedBags: 8 });
  err(await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e2.id, bags: 1 }] }), 422, 'NOT_ENOUGH_STOCK');
  err(await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: '11111111-1111-4111-8111-111111111111', bags: 1 }] }), 422, 'UNKNOWN_STOCK_ENTRY');
  err(await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-10-30', lines: [{ inwardId: w.e1.id, bags: 1 }] }), 422, 'BEFORE_INWARD');
  expect((await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e1.id, bags: 1 }, { inwardId: w.e1.id, bags: 1 }] })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-weft', { lines: [] })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e1.id, bags: 0 }] })).status).toBe(400);
  expect((await w.viewer('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e1.id, bags: 1 }] })).status).toBe(403);

  // second challan: number 2, takes the rest
  const c2 = await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-06', department: 'Air jet', lines: [{ inwardId: w.e1.id, bags: 7 }] });
  expect([c2.status, c2.body.challanNo, c2.body.totalLbs]).toEqual([201, 2, 700]);
  expect((await w.api('get', '/weaving/yarn-weft/stock-entries')).body.total).toBe(0);

  // list, filters, totals, one
  const l = (await w.api('get', '/weaving/yarn-weft')).body;
  expect(l.data.map((r) => r.challanNo)).toEqual([2, 1]);
  expect(l.data[1]).toMatchObject({ challanText: '00001', department: 'Sulzer', lineCount: 2, totalBags: 7, totalLbs: 502, parties: 'Ali Traders, Yarn Mills', brands: 'Crescent' });
  expect(l.totals).toEqual({ entries: 2, bags: 14, lbs: 1202 });
  expect((await w.api('get', '/weaving/yarn-weft?department=air jet')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-weft?search=ali')).body.data.map((r) => r.challanNo)).toEqual([1]);
  expect((await w.api('get', '/weaving/yarn-weft?search=00002')).body.data.map((r) => r.challanNo)).toEqual([2]);
  expect((await w.api('get', '/weaving/yarn-weft?dateFrom=2026-11-06')).body.data.map((r) => r.challanNo)).toEqual([2]);
  expect((await w.viewer('get', `/weaving/yarn-weft/${c1.body.id}`)).body.lines).toHaveLength(2);

  // the inward entries are held by the challans
  err(await w.api('delete', `/weaving/yarn-inwards/${w.e1.id}`), 422, 'IN_USE');
  err(await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { bags: 9 }), 422, 'BELOW_OUTWARD');
  err(await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { lbsPerBag: 90 }), 422, 'USED_IN_OUTWARD');
  expect((await w.api('patch', `/weaving/yarn-inwards/${w.e1.id}`, { bags: 12, remarks: 'more' })).body).toMatchObject({ bags: 12, totalLbs: 1200, outwardBags: 10, balanceBags: 2 });

  // delete a challan: the yarn is back, the number is not used again
  expect((await w.api('delete', `/weaving/yarn-weft/${c2.body.id}`)).body.deleted).toBe(true);
  err(await w.api('get', `/weaving/yarn-weft/${c2.body.id}`), 404, 'NOT_FOUND');
  expect((await w.api('get', '/weaving/yarn-weft/stock-entries')).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[1, 9]]);
  expect((await w.api('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e1.id, bags: 1 }] })).body.challanNo).toBe(3);
});

test('yarn weft: change a challan (its lines are re-checked as if the old ones were not taken); another company sees nothing', async () => {
  const w = await setup();
  const c = (await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-05', department: 'Sulzer', lines: [{ inwardId: w.e1.id, bags: 10 }] })).body;
  // all 10 bags are on this challan: changing it to 10 again is fine, 11 is not
  expect((await w.api('patch', `/weaving/yarn-weft/${c.id}`, { lines: [{ inwardId: w.e1.id, bags: 10 }], description: 'again' })).body).toMatchObject({ totalBags: 10, description: 'again', challanNo: 1 });
  err(await w.api('patch', `/weaving/yarn-weft/${c.id}`, { lines: [{ inwardId: w.e1.id, bags: 11 }] }), 422, 'NOT_ENOUGH_STOCK');
  // fewer bags and another entry
  const u = await w.api('patch', `/weaving/yarn-weft/${c.id}`, { lines: [{ inwardId: w.e1.id, bags: 4 }, { inwardId: w.e2.id, bags: 2 }], department: 'Air jet' });
  expect(u.body).toMatchObject({ totalBags: 6, totalLbs: 501, department: 'Air jet' });
  expect((await w.api('get', '/weaving/yarn-stock')).body.totals).toMatchObject({ outwardBags: 6, balanceBags: 8 });
  // moving the date before the yarn came is refused
  err(await w.api('patch', `/weaving/yarn-weft/${c.id}`, { outwardDate: '2026-11-02' }), 422, 'BEFORE_INWARD');
  // two challans at the same moment cannot take the same yarn twice
  const rs = await Promise.all([1, 2, 3].map(() => w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-06', lines: [{ inwardId: w.e1.id, bags: 6 }] })));
  expect(rs.map((r) => r.status).sort()).toEqual([201, 422, 422]);
  // another company
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-weft')).body.total).toBe(0);
  expect((await oa('get', '/weaving/yarn-weft/stock-entries')).body.total).toBe(0);
  err(await oa('get', `/weaving/yarn-weft/${c.id}`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/yarn-weft', { lines: [{ inwardId: w.e1.id, bags: 1 }] }), 422, 'UNKNOWN_STOCK_ENTRY');
});
