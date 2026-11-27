const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner 2026-11-25: Store > Settings: a low-stock limit for each chemical in stock; the stock screen shows a red warning with the last inward
const SERVICES = ['CHEMICAL_STORE', 'GENERAL_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_REPORTS'];
async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'CHEMICAL_STORE' } })).id, access: 'VIEW' });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, api: as(admin), viewerApi: as(viewer) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

test('limits in Store settings: only chemicals in stock are listed; the stock screen warns in red at or below the limit with the last inward', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'NEXUS' }), 201);
  const acid = await ok(w.api('post', '/stores/chemical/items', { name: 'Acetic Acid', unit: 'KG' }), 201);
  const soda = await ok(w.api('post', '/stores/chemical/items', { name: 'Caustic Soda', unit: 'KG' }), 201);
  const never = await ok(w.api('post', '/stores/chemical/items', { name: 'Never Bought', unit: 'KG' }), 201);
  const inw = await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, inwardDate: today(), lines: [{ itemId: acid.id, qty: 200, rate: 100 }] }), 201);
  await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, inwardDate: today(), lines: [{ itemId: soda.id, qty: 30, rate: 10 }] }), 201);

  // only the chemicals in stock are in the settings list
  const list = await ok(w.api('get', '/stores/chemical/stock-limits'));
  expect(list.data.map((x) => x.name)).toEqual(['Acetic Acid', 'Caustic Soda']);
  expect(list.counts).toEqual({ inStock: 2, withLimit: 0, low: 0 });
  expect(list.data[0]).toMatchObject({ itemId: acid.id, unit: 'KG', stockQty: 200, limit: null, isLow: false, warning: null, lastInward: { date: today(), qty: 200, qtyText: '200 KG', vendor: 'NEXUS', daysAgo: 0 } });
  expect((await ok(w.api('get', '/stores/chemical/stock-limits?search=acetic'))).data).toHaveLength(1);

  // a limit of 50 KG for the acid: 200 KG is fine, no warning on the stock screen
  expect(await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 50 }, { itemId: soda.id, limit: 40 }] }))).toEqual({ saved: 2 });
  const stock1 = await ok(w.api('get', '/stores/chemical/stock'));
  expect(stock1.data.find((i) => i.name === 'Acetic Acid')).toMatchObject({ stockQty: 200, limit: 50, warning: null });
  // Caustic Soda 30 KG is under its limit of 40: red with the message and the last inward
  const soda1 = stock1.data.find((i) => i.name === 'Caustic Soda');
  expect(soda1.warning).toMatchObject({ level: 'RED', code: 'LOW_STOCK', limit: 40, stockText: '30 KG', limitText: '40 KG', lastInward: { date: today(), qtyText: '30 KG', vendor: 'NEXUS' } });
  expect(soda1.warning.message).toBe(`Caustic Soda stock is low: only 30 KG left (limit 40 KG). Please inward this chemical. Last inward: ${today()} (30 KG, NEXUS).`);
  expect(stock1.lowCount).toBe(1);

  // the acid falls to 40 KG (160 KG go back to the vendor): at or below 50 -> red
  await ok(w.api('post', '/stores/chemical/vendor-returns', { returnDate: today(), vendorId: vendor.id, reason: 'DAMAGED', lines: [{ inwardLineId: inw.lines[0].id, qty: 160 }] }), 201);
  const acid2 = (await ok(w.api('get', '/stores/chemical/stock'))).data.find((i) => i.name === 'Acetic Acid');
  expect(acid2).toMatchObject({ stockQty: 40, isLow: true });
  expect(acid2.warning).toMatchObject({ code: 'LOW_STOCK', stockText: '40 KG', limitText: '50 KG' });
  expect(acid2.warning.message).toContain('Acetic Acid stock is low');
  expect(acid2.warning.message).toContain('Please inward this chemical');
  expect(acid2.warning.message).toContain(`Last inward: ${today()}`);
  // the limit equals the stock: still a warning (at or below)
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 40 }] }));
  expect((await ok(w.api('get', '/stores/chemical/stock'))).data.find((i) => i.name === 'Acetic Acid').warning).not.toBeNull();
  expect((await ok(w.api('get', '/stores/chemical/stock-limits?low=true'))).data.map((x) => x.name).sort()).toEqual(['Acetic Acid', 'Caustic Soda']);
  // clear the limit: the warning goes
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: null }] }));
  expect((await ok(w.api('get', '/stores/chemical/stock'))).data.find((i) => i.name === 'Acetic Acid')).toMatchObject({ limit: null, warning: null });

  // a chemical never bought is not in the list; a limit can still be seen with scope=withLimit
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: never.id, limit: 10 }] }));
  expect((await ok(w.api('get', '/stores/chemical/stock-limits'))).data.map((x) => x.name)).not.toContain('Never Bought');
  const withLimit = await ok(w.api('get', '/stores/chemical/stock-limits?scope=withLimit'));
  expect(withLimit.data.map((x) => x.name)).toEqual(expect.arrayContaining(['Never Bought', 'Caustic Soda']));
  expect(withLimit.data.find((x) => x.name === 'Never Bought').warning.code).toBe('OUT_OF_STOCK');
  expect(withLimit.data.find((x) => x.name === 'Never Bought').warning.message).toContain('never been inwarded');
});

test('limits in Store settings: rules, rights and the other company', async () => {
  const w = await setup();
  const other = await setup();
  const acid = await ok(w.api('post', '/stores/chemical/items', { name: 'Acetic Acid', unit: 'KG' }), 201);
  await fails(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 0 }] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 100001 }] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 5 }, { itemId: acid.id, limit: 6 }] }), 422, 'DUPLICATE_ITEM');
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 5 }] }));
  // reading needs VIEW, changing needs FULL
  expect((await w.viewerApi('get', '/stores/chemical/stock-limits?scope=withLimit')).status).toBe(200);
  expect((await w.viewerApi('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 9 }] })).status).toBe(403);
  // another company cannot touch the item
  await fails(other.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 9 }] }), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', '/stores/chemical/stock-limits?scope=withLimit'))).total).toBe(0);
  // the same item through the item form shows the same limit
  expect((await ok(w.api('get', `/stores/chemical/items/${acid.id}`))).reorderLevel).toBe(5);
});

test('the warning shows everywhere the chemical and its stock show in the store: items list and card, the inward form, the chemical page', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'NEXUS' }), 201);
  const acid = await ok(w.api('post', '/stores/chemical/items', { name: 'Acetic Acid', unit: 'KG' }), 201);
  await ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, inwardDate: today(), lines: [{ itemId: acid.id, qty: 30, rate: 100 }] }), 201);
  // no limit yet: nothing is red anywhere
  expect((await ok(w.api('get', '/stores/chemical/items'))).data[0]).toMatchObject({ limit: null, warning: null });
  // a limit of 50: 30 KG is low
  await ok(w.api('put', '/stores/chemical/stock-limits', { items: [{ itemId: acid.id, limit: 50 }] }));
  const red = (x) => expect(x).toMatchObject({ limit: 50, isLow: true, warning: { level: 'RED', code: 'LOW_STOCK', stockText: '30 KG', limitText: '50 KG' }, lastInward: { date: today(), qtyText: '30 KG', vendor: 'NEXUS' } });
  red((await ok(w.api('get', '/stores/chemical/items'))).data[0]); // the items list
  red(await ok(w.api('get', `/stores/chemical/items/${acid.id}`))); // the item card
  red((await ok(w.api('get', '/stores/chemical/inwards/form-data'))).items.find((i) => i.id === acid.id)); // the dropdown of the inward form
  red((await ok(w.api('get', `/stores/chemical/items/${acid.id}/stock`))).item); // the chemical page
  red(await ok(w.api('patch', `/stores/chemical/items/${acid.id}`, { name: 'Acetic Acid' }))); // after a change
  // the limit typed in the item form is the same limit
  await ok(w.api('patch', `/stores/chemical/items/${acid.id}`, { reorderLevel: 20 }));
  expect((await ok(w.api('get', '/stores/chemical/items'))).data[0]).toMatchObject({ limit: 20, warning: null });
});
