const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);

async function setup() {
  const company = await makeCompany();
  for (const code of ['FABRIC_STORE', 'CHEMICAL_STORE', 'GREY_STORE', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const only = async (code) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    await UserService.create({ userId: u.id, serviceId: (await Service.findOne({ where: { code } })).id, access: 'VIEW' });
    return call(u);
  };
  const api = call(admin);
  const vendor = (await api('post', '/vendors', { name: 'Waqas Enterprises' })).body;
  const q = (await api('post', '/qualities', { name: '30x30(cotton)' })).body;
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  return { api, fabricOnly: await only('FABRIC_STORE'), chemOnly: await only('CHEMICAL_STORE'), vendor, q, cu };
}
const fabric = async (call2) => ((await call2('get', '/stores/overview')).body.stores || []).find((s) => s.store === 'FABRIC');

test('the Fabric store in the Store overview: who sees it, inwards, stock, outwards, returns, no rate, drafts', async () => {
  const w = await setup();
  const month = today().slice(0, 7);
  // who sees it
  expect((await w.fabricOnly('get', '/stores/overview')).body.stores.map((s) => s.store)).toEqual(['FABRIC']);
  expect((await w.chemOnly('get', '/stores/overview')).body.stores.map((s) => s.store)).toEqual(['CHEMICAL']);
  expect((await w.api('get', '/stores/overview')).body.stores.map((s) => s.store)).toEqual(['CHEMICAL', 'FABRIC']);
  const empty = await fabric(w.api);
  expect(empty).toMatchObject({ store: 'FABRIC', name: 'Fabric Store', stock: { value: '0.00', itemCount: 0, lowCount: 0, outCount: 0, byCategory: [] }, topVendors: [], drafts: { inwards: 0, outwards: 0 } });
  expect(empty.series).toHaveLength(6);
  expect((await w.api('get', '/stores/overview?months=12')).body.stores.find((s) => s.store === 'FABRIC').series).toHaveLength(12);

  // 5,300 m at 20 per meter, approved this month
  const base = { inwardDate: today(), vendorId: w.vendor.id, qualityId: w.q.id };
  const a = (await w.api('post', '/fabric-inwards', { ...base, inwardMeters: 5300, pieces: 1, rate: 20, rateUnit: 'METER' })).body;
  const draft = (await w.api('post', '/fabric-inwards', { ...base, inwardMeters: 100, pieces: 1, rate: 5 })).body;
  let f = await fabric(w.api);
  expect(f.drafts.inwards).toBe(2); // not approved yet: nothing else counts
  expect(f.series[5]).toMatchObject({ month, inwardsAmount: '0.00', inwardsCount: 0 });
  await w.api('post', `/fabric-inwards/${a.id}/approve`);
  f = await fabric(w.api);
  expect(f.series[5]).toEqual({ month, inwardsAmount: '106000.00', inwardsCount: 1, outwardsAmount: '0.00', outwardsCount: 0 });
  expect(f.series.slice(0, 5).every((s) => s.inwardsAmount === '0.00' && s.inwardsCount === 0)).toBe(true);
  expect(f.stock).toEqual({ value: '106000.00', itemCount: 1, lowCount: 0, outCount: 0, byCategory: [{ category: '30x30(cotton)', value: '106000.00', items: 1 }] });
  expect(f.topVendors).toEqual([{ vendorId: w.vendor.id, name: 'Waqas Enterprises', amount: '106000.00', count: 1 }]);
  expect(f.drafts).toEqual({ inwards: 1, outwards: 0 }); // only the draft entry
  expect((await w.api('get', '/fabric-inwards/stock')).body.totals.balanceValue).toBe(106000);

  // an entry without a rate counts as an entry with 0.00; a switched-off entry counts nothing
  const nr = (await w.api('post', '/fabric-inwards', { ...base, inwardMeters: 50, pieces: 1 })).body;
  await w.api('post', `/fabric-inwards/${nr.id}/approve`);
  f = await fabric(w.api);
  expect(f.series[5]).toMatchObject({ inwardsAmount: '106000.00', inwardsCount: 2 });
  expect(f.stock).toMatchObject({ value: '106000.00', itemCount: 2 });
  expect(f.topVendors[0]).toMatchObject({ amount: '106000.00', count: 2 });
  await w.api('put', `/fabric-inwards/${nr.id}/active`, { isActive: false });
  f = await fabric(w.api);
  expect(f.series[5]).toMatchObject({ inwardsCount: 1 });
  expect(f.stock.itemCount).toBe(1);

  // issue 200 m (by meters) to an SO card: outwards 200 x 20 = 4,000, stock 102,000
  const is = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: a.id, meters: 200, pieces: 1, customerId: w.cu.id })).body;
  f = await fabric(w.api);
  expect(f.series[5]).toMatchObject({ outwardsAmount: '4000.00', outwardsCount: 1, inwardsAmount: '106000.00' });
  expect(f.stock).toMatchObject({ value: '102000.00', byCategory: [{ category: '30x30(cotton)', value: '102000.00', items: 1 }] });
  // the SO card is cancelled with RETURN: the issue is returned, outwards back to 0.00 and the stock is whole again
  const card = (await w.api('post', '/so-cards', { cardDate: today(), lots: [{ greyLotId: is.greyLotId, meters: 200, pieces: 1 }] })).body;
  expect(card.id).toBeTruthy();
  expect((await w.api('delete', `/so-cards/${card.id}`)).status).toBe(204);
  f = await fabric(w.api);
  expect(f.series[5]).toMatchObject({ outwardsAmount: '0.00', outwardsCount: 0 });
  expect(f.stock.value).toBe('106000.00');

  // thaan-wise entry: the issue is worth the amounts of its thaans (per yard here)
  const t = (await w.api('post', '/fabric-inwards', { ...base, thaans: [100, 50], rate: 10, rateUnit: 'YARD' })).body; // 109.36 yd x 10 + 54.68 yd x 10
  await w.api('post', `/fabric-inwards/${t.id}/approve`);
  await w.api('post', '/fabric-inwards/issues', { fabricInwardId: t.id, thaanNos: [2], customerId: w.cu.id });
  f = await fabric(w.api);
  expect(f.series[5]).toMatchObject({ outwardsAmount: '546.80', outwardsCount: 1 });
  expect(f.topVendors[0].count).toBe(2);
  expect(f.stock.byCategory[0].items).toBe(2);
  // another company sees nothing of it
  const o = await setup();
  expect((await fabric(o.api)).series.every((s) => s.inwardsCount === 0)).toBe(true);
});

test('top 10 vendors per store, the same vendorId in every store, the same months in every store, stock.value = byCategory = stock totals', async () => {
  const w = await setup();
  const base = { inwardDate: today(), qualityId: w.q.id };
  // a vendor that sold chemicals AND cloth: one vendor row, one id
  const item = (await w.api('post', '/stores/chemical/items', { name: 'BLUE DYE', unit: 'KG' })).body;
  const both = (await w.api('post', '/vendors', { name: 'Both Ltd' })).body;
  expect((await w.api('post', '/stores/chemical/inwards', { inwardDate: today(), vendorId: both.id, lines: [{ itemId: item.id, qty: 10, rate: 100 }], approve: true })).status).toBe(201);
  const fa = (await w.api('post', '/fabric-inwards', { ...base, vendorId: both.id, inwardMeters: 100, pieces: 1, rate: 3 })).body;
  await w.api('post', `/fabric-inwards/${fa.id}/approve`);
  // eleven more cloth vendors: only the biggest ten are listed, biggest first
  for (let i = 1; i <= 11; i += 1) {
    const v = (await w.api('post', '/vendors', { name: `Vendor ${String(i).padStart(2, '0')}` })).body;
    const e = (await w.api('post', '/fabric-inwards', { ...base, vendorId: v.id, inwardMeters: 100, pieces: 1, rate: 10 + i })).body;
    await w.api('post', `/fabric-inwards/${e.id}/approve`);
  }
  const ov = (await w.api('get', '/stores/overview')).body;
  const fabric = ov.stores.find((s) => s.store === 'FABRIC');
  const chem = ov.stores.find((s) => s.store === 'CHEMICAL');
  expect(fabric.topVendors).toHaveLength(10);
  expect(fabric.topVendors.map((v) => v.name)).toEqual(['Vendor 11', 'Vendor 10', 'Vendor 09', 'Vendor 08', 'Vendor 07', 'Vendor 06', 'Vendor 05', 'Vendor 04', 'Vendor 03', 'Vendor 02']);
  expect(fabric.topVendors[0]).toEqual({ vendorId: expect.any(String), name: 'Vendor 11', amount: '2100.00', count: 1 });
  expect(chem.topVendors).toEqual([{ vendorId: both.id, name: 'Both Ltd', amount: '1000.00', count: 1 }]);
  // the same vendor has the same id in both stores
  const fab2 = (await w.api('get', '/stores/overview?months=12')).body.stores.find((s) => s.store === 'FABRIC');
  expect(fab2.topVendors.find((v) => v.name === 'Both Ltd')).toBeUndefined(); // 300 is below the top 10 here
  await w.api('post', `/fabric-inwards/${fa.id}/unapprove`);
  await w.api('patch', `/fabric-inwards/${fa.id}`, { rate: 100 });
  await w.api('post', `/fabric-inwards/${fa.id}/approve`);
  const again = (await w.api('get', '/stores/overview')).body.stores.find((s) => s.store === 'FABRIC');
  expect(again.topVendors[0]).toEqual({ vendorId: both.id, name: 'Both Ltd', amount: '10000.00', count: 1 });
  expect(again.topVendors[0].vendorId).toBe(chem.topVendors[0].vendorId);
  // all stores return the same months
  expect(fabric.series.map((s) => s.month)).toEqual(chem.series.map((s) => s.month));
  // stock.value is the sum of the categories and the stock screen's total
  const total = (await w.api('get', '/fabric-inwards/stock')).body.totals.balanceValue;
  expect(Number(again.stock.value)).toBe(total);
  expect(again.stock.byCategory.reduce((t, c) => t + Number(c.value), 0)).toBeCloseTo(total, 2);
});
