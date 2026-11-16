const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(400000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['YARN_STORE', 'CHEMICAL_STORE', 'FABRIC_STORE', 'GREY_STORE', 'SO_CARD', 'DYEING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const only = async (code) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    await UserService.create({ userId: u.id, serviceId: s[code].id, access: 'VIEW' });
    return call(u);
  };
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Yarn Mills' })).body;
  return { company, s, api, vendor, yarnOnly: await only('YARN_STORE'), chemOnly: await only('CHEMICAL_STORE') };
}
const yarn = async (c) => ((await c('get', '/stores/overview')).body.stores || []).find((x) => x.store === 'YARN');

test('the Yarn store in the Store overview: who sees it, inwards, stock, outwards, taking back, drafts and requests, vendors, months', async () => {
  const w = await setup();
  const month = today().slice(0, 7);
  // who sees it
  expect((await w.yarnOnly('get', '/stores/overview')).body.stores.map((x) => x.store)).toEqual(['YARN']);
  expect((await w.chemOnly('get', '/stores/overview')).body.stores.map((x) => x.store)).toEqual(['CHEMICAL']);
  expect((await w.api('get', '/stores/overview')).body.stores.map((x) => x.store)).toEqual(['CHEMICAL', 'FABRIC', 'YARN']);
  const none = await makeCompany();
  const noAdmin = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: none.id }));
  expect((await noAdmin('get', '/stores/overview')).body.stores).toEqual([]); // a company without the Yarn Store
  const empty = await yarn(w.api);
  expect(empty).toMatchObject({ store: 'YARN', name: 'Yarn Store', stock: { value: '0.00', itemCount: 0, lowCount: 0, outCount: 0, byCategory: [] }, topVendors: [], drafts: { inwards: 0, outwards: 0 } });
  expect(empty.series).toHaveLength(6);

  // 1. one approved entry: 10 bags x 50 lbs x 300 = 150,000
  const base = { inwardDate: today(), vendorId: w.vendor.id, yarnName: '22/s Cotton', brand: 'Crescent', lbsPerBag: 50, ratePerLb: 300 };
  const a = (await w.api('post', '/store-yarn-inwards', { ...base, bags: 10 })).body;
  const draft = (await w.api('post', '/store-yarn-inwards', { ...base, bags: 4 })).body;
  // 4. an un-approved entry counts only in drafts.inwards
  let y = await yarn(w.api);
  expect(y.drafts.inwards).toBe(2);
  expect(y.series[5]).toMatchObject({ month, inwardsAmount: '0.00', inwardsCount: 0 });
  expect(y.stock.value).toBe('0.00');
  await w.api('post', `/store-yarn-inwards/${a.id}/approve`);
  y = await yarn(w.api);
  expect(y.series[5]).toEqual({ month, inwardsAmount: '150000.00', inwardsCount: 1, outwardsAmount: '0.00', outwardsCount: 0 });
  expect(y.stock).toEqual({ value: '150000.00', itemCount: 1, lowCount: 0, outCount: 0, byCategory: [{ category: '22/s Cotton - Crescent', value: '150000.00', items: 1 }] });
  expect(y.topVendors).toEqual([{ vendorId: w.vendor.id, name: 'Yarn Mills', amount: '150000.00', count: 1 }]);
  expect(y.drafts).toEqual({ inwards: 1, outwards: 0 });

  // 2. 6 of the 10 bags to a department (direct outward): 6 x 50 x 300 = 90,000 out, 60,000 left
  const out = (await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: a.id, bags: 6 }] })).body;
  y = await yarn(w.api);
  expect(y.series[5]).toMatchObject({ outwardsAmount: '90000.00', outwardsCount: 1, inwardsAmount: '150000.00' });
  expect(y.stock.value).toBe('60000.00');
  const stock = (await w.api('get', '/store-yarn-inwards/stock')).body;
  expect(Number(y.stock.value)).toBe(stock.totals.balanceValue); // the same number as the Yarn Stock screen
  expect(y.stock.itemCount).toBe(stock.byYarn.length);
  expect(y.stock.byCategory.map((c) => [c.category, c.value, c.items])).toEqual(stock.byYarn.map((x) => [x.title, x.balanceValue.toFixed(2), x.entries]));
  // 3. take it back: outwards 0, stock whole again
  expect((await w.api('post', `/store-yarn-outwards/${out.id}/cancel`)).status).toBe(200);
  y = await yarn(w.api);
  expect(y.series[5]).toMatchObject({ outwardsAmount: '0.00', outwardsCount: 0 });
  expect(y.stock.value).toBe('150000.00');

  // an entry without a rate counts as an entry with 0.00; a used-up yarn drops out of the stock; the same yarn typed in another letter case is one yarn
  const nr = (await w.api('post', '/store-yarn-inwards', { ...base, yarnName: '22/S COTTON', brand: 'crescent', ratePerLb: undefined, bags: 2 })).body;
  await w.api('post', `/store-yarn-inwards/${nr.id}/approve`);
  y = await yarn(w.api);
  expect(y.series[5]).toMatchObject({ inwardsAmount: '150000.00', inwardsCount: 2 });
  expect(y.stock).toMatchObject({ value: '150000.00', itemCount: 1 });
  expect(y.stock.byCategory).toEqual([{ category: '22/S COTTON - crescent', value: '150000.00', items: 2 }]);
  const poly = (await w.api('post', '/store-yarn-inwards', { ...base, yarnName: '30/s Polyester', brand: undefined, bags: 1, lbsPerBag: 100, ratePerLb: 10 })).body;
  await w.api('post', `/store-yarn-inwards/${poly.id}/approve`);
  await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: poly.id, bags: 1 }] }); // all of it: 1000
  y = await yarn(w.api);
  expect(y.stock).toMatchObject({ value: '150000.00', itemCount: 1 });
  expect(y.series[5]).toMatchObject({ outwardsAmount: '1000.00', outwardsCount: 1 });
  // a switched-off entry counts nothing
  await w.api('put', `/store-yarn-inwards/${nr.id}/active`, { isActive: false });
  expect((await yarn(w.api)).series[5].inwardsCount).toBe(2); // a (150000) + poly (1000)
  expect(draft.isApproved).toBe(false);

  // 4. a yarn request waiting at the store counts in drafts.outwards (Queue and Process), not once it is sent
  await w.api('patch', '/department-settings/DYEING', { yarnRequests: true });
  const cu = (await w.api('post', '/customers', { code: 130, name: 'AZ TEXTILES' })).body;
  const q = (await w.api('post', '/qualities', { name: '16X10 PC TWILL' })).body;
  const lot = (await w.api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 1000, pieces: 2 })).body;
  await w.api('post', `/grey-lots/${lot.id}/approve`);
  await w.api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 1000 }] });
  const fd = (await w.api('get', '/jobs/form-data')).body;
  const job = (await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  await w.api('put', `/jobs/${job.id}/status`, { status: 'PROCESSING' });
  const mk = async () => (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: job.id, lines: [{ yarnName: '22/s Cotton', brand: 'Crescent', bags: 2 }] })).body;
  const r1 = await mk();
  const r2 = await mk();
  expect((await yarn(w.api)).drafts.outwards).toBe(2); // Queue
  await w.api('post', `/store-yarn-outwards/requests/${r1.id}/accept`);
  expect((await yarn(w.api)).drafts.outwards).toBe(2); // Queue + Process
  const sent = await w.api('post', `/store-yarn-outwards/requests/${r1.id}/send`, {});
  expect(sent.status).toBe(200);
  y = await yarn(w.api);
  expect(y.drafts.outwards).toBe(1); // r1 is sent, r2 still waits
  // the outward made by the request counts as an outward (2 bags x 50 x 300 = 30,000, plus the 1,000 before)
  expect(y.series[5]).toMatchObject({ outwardsAmount: '31000.00', outwardsCount: 2 });
  await w.api('post', `/departments/DYEING/yarn-requests/${r2.id}/cancel`);
  expect((await yarn(w.api)).drafts.outwards).toBe(0);

  // 6. the same months in every store; the same vendor has the same id in the yarn and the chemical store
  const ov = (await w.api('get', '/stores/overview')).body;
  const months = ov.stores.map((x) => x.series.map((s) => s.month));
  expect(months.every((m) => JSON.stringify(m) === JSON.stringify(months[0]))).toBe(true);
  const item = (await w.api('post', '/stores/chemical/items', { name: 'BLUE DYE', unit: 'KG' })).body;
  await w.api('post', '/stores/chemical/inwards', { inwardDate: today(), vendorId: w.vendor.id, lines: [{ itemId: item.id, qty: 10, rate: 100 }], approve: true });
  const ov2 = (await w.api('get', '/stores/overview')).body;
  expect(ov2.stores.find((x) => x.store === 'CHEMICAL').topVendors[0].vendorId).toBe(ov2.stores.find((x) => x.store === 'YARN').topVendors[0].vendorId);
  expect((await w.api('get', '/stores/overview?months=12')).body.stores.find((x) => x.store === 'YARN').series).toHaveLength(12);
  // top 10 vendors
  for (let i = 1; i <= 11; i += 1) {
    const v = (await w.api('post', '/vendors', { name: `V${String(i).padStart(2, '0')}` })).body;
    const e = (await w.api('post', '/store-yarn-inwards', { ...base, vendorId: v.id, bags: 1, ratePerLb: 10 + i })).body;
    await w.api('post', `/store-yarn-inwards/${e.id}/approve`);
  }
  const top = (await yarn(w.api)).topVendors;
  expect(top).toHaveLength(10);
  expect(top[0].name).toBe('Yarn Mills');
  // another company sees nothing of it
  const o = await setup();
  expect((await yarn(o.api)).series.every((s) => s.inwardsCount === 0)).toBe(true);
});
