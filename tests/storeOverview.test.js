const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, StoreItem } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');
const { monthsBack } = require('../src/services/storeOverviewService');
const { today } = require('../src/utils/dates');

beforeEach(clean);

const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const MONEY = /^-?\d+\.\d{2}$/;

test('months back: oldest to newest, over a year end, the current month last', () => {
  expect(monthsBack('2026-10-29', 6)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  expect(monthsBack('2026-02-01', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  expect(monthsBack('2026-12-31', 1)).toEqual(['2026-12']);
  expect(monthsBack('2026-03-15', 12)).toHaveLength(12);
});

test('store overview: months of inwards and outwards, stock, top vendors, drafts; only the stores the person may see; money as strings', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['CHEMICAL_STORE', 'GENERAL_STORE', 'DYEING', 'SO_CARD', 'GREY_STORE']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const day = today();
  const month = day.slice(0, 7);

  // chemical store: two approved inwards (one with GST), one draft; two vendors
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  const blue = (await api('post', '/stores/chemical/items', { name: 'BLUE DYE', unit: 'KG' })).body;
  const nexus = (await api('post', '/vendors', { name: 'NEXUS CHEMICAL' })).body;
  const dyes = (await api('post', '/vendors', { name: 'DYES CO' })).body;
  const inward = (body) => api('post', '/stores/chemical/inwards', body);
  const i1 = await inward({ inwardDate: day, vendorId: nexus.id, lines: [{ itemId: red.id, qty: 10, rate: 100 }, { itemId: blue.id, qty: 5, rate: 20 }], approve: true });
  expect(i1.status).toBe(201);
  const i2 = await inward({ inwardDate: day, vendorId: dyes.id, lines: [{ itemId: red.id, qty: 2, rate: 50 }], approve: true });
  expect(i2.status).toBe(201);
  await inward({ inwardDate: day, vendorId: dyes.id, lines: [{ itemId: red.id, qty: 1, rate: 10 }] }); // a draft
  // an old inward (outside a 3 month window, inside 12)
  await sequelize.query('UPDATE store_inwards SET "inwardDate" = (now() - interval \'8 months\')::date WHERE id = :id', { replacements: { id: i2.body.id } });
  await sequelize.query('UPDATE store_moves SET "moveDate" = (now() - interval \'8 months\')::date WHERE "inwardId" = :id', { replacements: { id: i2.body.id } });
  // an issue to a department: 3 kg of red at the stock rate
  await sequelize.query(`INSERT INTO store_moves (id, "companyId", store, "itemId", "moveDate", kind, qty, value, "departmentId") VALUES (gen_random_uuid(), :c, 'CHEMICAL', :item, :day, 'ISSUE', -3, -300, :dept)`,
    { replacements: { c: company.id, item: red.id, day, dept: s.DYEING.id } });
  await sequelize.query('UPDATE store_items SET "stockQty" = 3, "stockValue" = 300, "reorderLevel" = 5 WHERE id = :id', { replacements: { id: red.id } }); // low stock
  await sequelize.query('UPDATE store_items SET "stockQty" = 0, "stockValue" = 0 WHERE id = :id', { replacements: { id: blue.id } }); // out of stock
  // general store: one approved inward
  const bolt = (await api('post', '/stores/general/items', { name: 'Bolts', unit: 'PCS' })).body;
  expect((await api('post', '/stores/general/inwards', { inwardDate: day, vendorId: nexus.id, lines: [{ itemId: bolt.id, qty: 50, rate: 10 }], approve: true })).status).toBe(201);

  const res = await api('get', '/stores/overview?months=3');
  expect(res.status).toBe(200);
  expect(res.body.asOf).toBe(day);
  expect(res.body.stores.map((x) => [x.store, x.name])).toEqual([['CHEMICAL', 'Chemical Store'], ['GENERAL', 'General Store']]);
  const chem = res.body.stores[0];
  // exactly 3 months, oldest first, the current month last; the 8 month old inward is outside
  expect(chem.series).toHaveLength(3);
  expect(chem.series.map((x) => x.month)).toEqual(monthsBack(day, 3));
  expect(chem.series[2]).toEqual({ month, inwardsAmount: '1100.00', inwardsCount: 1, outwardsAmount: '300.00', outwardsCount: 1 });
  expect(chem.series[0]).toEqual({ month: chem.series[0].month, inwardsAmount: '0.00', inwardsCount: 0, outwardsAmount: '0.00', outwardsCount: 0 });
  expect(chem.stock).toMatchObject({ value: expect.stringMatching(MONEY), itemCount: 1, lowCount: 1 });
  expect(chem.stock.outCount).toBeGreaterThanOrEqual(1);
  expect(chem.stock.byCategory.every((c) => MONEY.test(c.value) && Number(c.value) > 0)).toBe(true);
  expect(chem.stock.byCategory.reduce((t, c) => t + c.items, 0)).toBe(1);
  expect(chem.topVendors).toEqual([{ vendorId: nexus.id, name: 'NEXUS CHEMICAL', amount: '1100.00', count: 1 }]);
  expect(chem.drafts).toEqual({ inwards: 1, outwards: 0 });
  // 12 months reaches the old inward: DYES CO appears with its 100
  const wide = (await api('get', '/stores/overview?months=12')).body.stores[0];
  expect(wide.series).toHaveLength(12);
  expect(wide.topVendors.map((v) => [v.name, v.amount, v.count])).toEqual([['NEXUS CHEMICAL', '1100.00', 1], ['DYES CO', '100.00', 1]]);
  const gen = res.body.stores[1];
  expect(gen.series[2]).toEqual({ month, inwardsAmount: '500.00', inwardsCount: 1, outwardsAmount: '0.00', outwardsCount: 0 });
  expect(gen.stock).toMatchObject({ value: '500.00', itemCount: 1, lowCount: 0, outCount: 0 });
  expect(gen.drafts).toEqual({ inwards: 0, outwards: 0 });
  // the default is 6 months; wrong values are refused
  expect((await api('get', '/stores/overview')).body.stores[0].series).toHaveLength(6);
  for (const bad of ['0', '13', 'abc', '1.5']) expect((await api('get', `/stores/overview?months=${bad}`)).status).toBe(400);
  expect((await request(app).get('/api/v1/stores/overview')).status).toBe(401);

  // a user sees only the store given to them; none given = an empty list, not an error
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  const mine = asUser(user);
  expect((await mine('get', '/stores/overview')).body).toEqual({ asOf: day, stores: [] });
  await UserService.create({ userId: user.id, serviceId: s.GENERAL_STORE.id, access: 'VIEW' });
  expect((await mine('get', '/stores/overview')).body.stores.map((x) => x.store)).toEqual(['GENERAL']);
  await UserService.create({ userId: user.id, serviceId: s.CHEMICAL_STORE.id, access: 'VIEW' });
  expect((await mine('get', '/stores/overview')).body.stores.map((x) => x.store)).toEqual(['CHEMICAL', 'GENERAL']);

  // another company sees nothing of this one, a company without the store services gets an empty list
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: s.CHEMICAL_STORE.id });
  const stranger = asUser(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  const theirs = (await stranger('get', '/stores/overview')).body;
  expect(theirs.stores.map((x) => x.store)).toEqual(['CHEMICAL']);
  expect(theirs.stores[0].stock).toMatchObject({ value: '0.00', itemCount: 0, byCategory: [] });
  expect(theirs.stores[0].topVendors).toEqual([]);
  expect(theirs.stores[0].series.every((x) => x.inwardsCount === 0 && x.outwardsAmount === '0.00')).toBe(true);
});
