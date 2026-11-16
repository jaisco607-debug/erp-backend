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
  const api = call(admin);
  const count = (await api('post', '/weaving/yarn-counts', { name: '22|s Cotton' })).body;
  const brand = (await api('post', '/weaving/brands', { name: 'Crescent' })).body;
  const item = (await api('post', '/weaving/item-cards', { yarnCountId: count.id, brandId: brand.id })).body;
  const vendor = (await api('post', '/weaving/vendors', { name: 'Yarn Mills' })).body;
  const customer = (await api('post', '/weaving/customers', { name: 'Ali Traders' })).body;
  const inward = async (b) => (await api('post', '/weaving/yarn-inwards', { itemId: item.id, ...b })).body;
  const v1 = await inward({ vendorId: vendor.id, bags: 10, lbsPerBag: 100, ratePerLb: 10, inwardDate: '2026-11-01' });
  const c1 = await inward({ customerId: customer.id, bags: 20, lbsPerBag: 50, inwardDate: '2026-11-02' });
  const c2 = await inward({ customerId: customer.id, bags: 6, lbsPerBag: 100, inwardDate: '2026-11-03' });
  return { company, svc, api, viewer: call(viewer), item, vendor, customer, v1, c1, c2 };
}

test('yarn return: a party takes back some of its yarn; challan and gate pass; stock goes down; only its own yarn', async () => {
  const w = await setup();
  // the customer has 26 bags in 2 entries: the picker for this party
  const pick = (await w.api('get', `/weaving/yarn-returns/stock-entries?customerId=${w.customer.id}`)).body;
  expect(pick.data.map((e) => [e.code, e.balanceBags])).toEqual([[2, 20], [3, 6]]);

  // the customer will process 8 bags of entry 2 only: the rest (12) and all 6 of entry 3 go back
  const r = await w.api('post', '/weaving/yarn-returns', { customerId: w.customer.id, outwardDate: '2026-11-08', description: 'customer will not process',
    lines: [{ inwardId: w.c1.id, bags: 12 }, { inwardId: w.c2.id, bags: 6 }] });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ type: 'RETURN', challanNo: 1, challanText: '00001', party: { kind: 'CUSTOMER', name: 'Ali Traders' }, outwardDate: '2026-11-08', description: 'customer will not process', totalBags: 18, totalLbs: 1200 });
  expect(r.body.lines.map((l) => [l.inwardCode, l.bags, l.lbs, l.lbsPerBag])).toEqual([[2, 12, 600, 50], [3, 6, 600, 100]]);
  expect(r.body.lines[0]).toMatchObject({ party: { name: 'Ali Traders' }, brand: { name: 'Crescent' }, yarnCount: { name: '22|s Cotton' }, packing: 24 });

  // the stock: 8 bags of entry 2 stay for processing; the vendor's yarn is untouched
  const st = (await w.api('get', '/weaving/yarn-stock')).body;
  expect(st.data.find((x) => x.lbsPerBag === 50)).toMatchObject({ inwardBags: 20, outwardBags: 12, balanceBags: 8 });
  expect(st.data.find((x) => x.lbsPerBag === 100)).toMatchObject({ inwardBags: 16, outwardBags: 6, balanceBags: 10 });
  expect((await w.api('get', `/weaving/yarn-returns/stock-entries?customerId=${w.customer.id}`)).body.data.map((e) => [e.code, e.balanceBags])).toEqual([[2, 8]]);
  // the same yarn can now go to the weft (the remaining 8)
  expect((await w.api('post', '/weaving/yarn-weft', { outwardDate: '2026-11-09', lines: [{ inwardId: w.c1.id, bags: 8 }] })).body.challanNo).toBe(2);

  // gate pass: only date, party, delivery challan number (and 3 copies, signature drawn by the frontend)
  const gp = await w.api('get', `/weaving/yarn-returns/${r.body.id}/gate-pass`);
  expect(gp.body).toEqual({ challanId: r.body.id, type: 'RETURN', date: '2026-11-08', party: { kind: 'CUSTOMER', id: w.customer.id, name: 'Ali Traders' }, partyName: 'Ali Traders', challanNo: 1, challanText: '00001', copies: 3 });
  expect((await w.viewer('get', `/weaving/yarn-returns/${r.body.id}/gate-pass`)).status).toBe(200);

  // rules: another party's yarn, more than is left, no party / both, date before the yarn, VIEW
  err(await w.api('post', '/weaving/yarn-returns', { customerId: w.customer.id, lines: [{ inwardId: w.v1.id, bags: 1 }] }), 422, 'WRONG_PARTY');
  err(await w.api('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, lines: [{ inwardId: w.c1.id, bags: 1 }] }), 422, 'WRONG_PARTY');
  err(await w.api('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, lines: [{ inwardId: w.v1.id, bags: 11 }] }), 422, 'NOT_ENOUGH_STOCK');
  expect((await w.api('post', '/weaving/yarn-returns', { lines: [{ inwardId: w.v1.id, bags: 1 }] })).status).toBe(400);
  expect((await w.api('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, customerId: w.customer.id, lines: [{ inwardId: w.v1.id, bags: 1 }] })).status).toBe(400);
  err(await w.api('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, outwardDate: '2026-10-30', lines: [{ inwardId: w.v1.id, bags: 1 }] }), 422, 'BEFORE_INWARD');
  err(await w.api('post', '/weaving/yarn-returns', { vendorId: w.customer.id, lines: [{ inwardId: w.v1.id, bags: 1 }] }), 422, 'UNKNOWN_VENDOR');
  expect((await w.viewer('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, lines: [{ inwardId: w.v1.id, bags: 1 }] })).status).toBe(403);

  // a vendor gets all its yarn back: challan 3
  const rv = await w.api('post', '/weaving/yarn-returns', { vendorId: w.vendor.id, outwardDate: '2026-11-10', lines: [{ inwardId: w.v1.id, bags: 10 }] });
  expect([rv.status, rv.body.challanNo, rv.body.party.kind, rv.body.totalLbs]).toEqual([201, 3, 'VENDOR', 1000]);
  expect((await w.api('get', `/weaving/yarn-returns/${rv.body.id}/gate-pass`)).body).toMatchObject({ partyName: 'Yarn Mills', challanNo: 3 });

  // list: only returns, with the party; filters and totals
  const l = (await w.api('get', '/weaving/yarn-returns')).body;
  expect(l.data.map((x) => [x.challanNo, x.partyName])).toEqual([[3, 'Yarn Mills'], [1, 'Ali Traders']]);
  expect(l.totals).toEqual({ entries: 2, bags: 28, lbs: 2200 });
  expect((await w.api('get', `/weaving/yarn-returns?customerId=${w.customer.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-returns?search=yarn mills')).body.total).toBe(1);
  expect((await w.api('get', '/weaving/yarn-weft')).body.data.map((x) => x.challanNo)).toEqual([2]); // the weft list does not show returns
  err(await w.api('get', `/weaving/yarn-weft/${r.body.id}`), 404, 'NOT_FOUND');
  err(await w.api('get', `/weaving/yarn-returns/${rv.body.id.replace(/.$/, '0')}`), 404, 'NOT_FOUND');

  // the vendor with a return cannot be deleted; deleting the return puts the yarn back
  err(await w.api('delete', `/weaving/vendors/${w.vendor.id}`), 422, 'IN_USE');
  expect((await w.api('delete', `/weaving/yarn-returns/${rv.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('get', `/weaving/yarn-returns/stock-entries?vendorId=${w.vendor.id}`)).body.data.map((e) => e.balanceBags)).toEqual([10]);
});

test('yarn return: change the lines of a return (party stays); another company sees nothing', async () => {
  const w = await setup();
  const r = (await w.api('post', '/weaving/yarn-returns', { customerId: w.customer.id, outwardDate: '2026-11-08', lines: [{ inwardId: w.c1.id, bags: 20 }] })).body;
  expect((await w.api('patch', `/weaving/yarn-returns/${r.id}`, { lines: [{ inwardId: w.c1.id, bags: 5 }, { inwardId: w.c2.id, bags: 6 }], description: 'changed' })).body).toMatchObject({ totalBags: 11, description: 'changed', challanNo: 1, party: { name: 'Ali Traders' } });
  err(await w.api('patch', `/weaving/yarn-returns/${r.id}`, { lines: [{ inwardId: w.v1.id, bags: 1 }] }), 422, 'WRONG_PARTY');
  expect((await w.api('patch', `/weaving/yarn-returns/${r.id}`, { vendorId: w.vendor.id })).status).toBe(400);
  expect((await w.api('get', '/weaving/yarn-stock')).body.totals).toMatchObject({ outwardBags: 11, balanceBags: 25 });

  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/yarn-returns')).body.total).toBe(0);
  err(await oa('get', `/weaving/yarn-returns/${r.id}`), 404, 'NOT_FOUND');
  err(await oa('get', `/weaving/yarn-returns/${r.id}/gate-pass`), 404, 'NOT_FOUND');
  err(await oa('post', '/weaving/yarn-returns', { customerId: w.customer.id, lines: [{ inwardId: w.c1.id, bags: 1 }] }), 422, 'UNKNOWN_CUSTOMER');
});
