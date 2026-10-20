const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

async function setup(codes = ['CHEMICAL_STORE', 'GENERAL_STORE']) {
  const company = await makeCompany({ name: 'Waqas Textile' });
  for (const code of codes) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  return { company, auth: { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` } };
}

test('chemical store: vendor, items, draft without rate, approve adds stock with average rate, unapprove', async () => {
  const { auth } = await setup();
  const api = (method, url, body) => request(app)[method](`/api/v1${url}`).set(auth).send(body);
  const vendor = (await api('post', '/vendors', { name: 'NEXUS CHEMICAL', phone: '0300' })).body;
  expect(vendor).toMatchObject({ code: 1, label: 'NEXUS CHEMICAL (1)' });
  const cat = (await api('post', '/stores/chemical/categories', { name: 'Dyes' })).body;
  const soda = (await api('post', '/stores/chemical/items', { name: 'Caustic Soda', unit: 'KG', categoryId: cat.id })).body;
  expect(soda).toMatchObject({ stockQty: 0, avgRate: 0, category: { name: 'Dyes' } });
  expect((await api('post', '/stores/chemical/items', { name: 'caustic soda', unit: 'KG', categoryId: cat.id })).body.error.code).toBe('NAME_TAKEN');
  // a general category is not visible in the chemical store
  const gcat = (await api('post', '/stores/general/categories', { name: 'Spare Parts' })).body;
  expect((await api('post', '/stores/chemical/items', { name: 'X', unit: 'KG', categoryId: gcat.id })).body.error.code).toBe('UNKNOWN_CATEGORY');

  const fd = (await api('get', '/stores/chemical/inwards/form-data')).body;
  expect(fd).toMatchObject({ nextIdNo: 1, nextIdText: '00001', billTypes: ['GST', 'OTHER'] });
  expect(fd.items).toHaveLength(1);

  // draft: rate not known yet
  const draft = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-14', billType: 'GST', vendorId: vendor.id, dcNo: '8939', lines: [{ itemId: soda.id, qty: 25.5 }] })).body;
  expect(draft).toMatchObject({ idText: '00001', ipNo: null, statusText: 'UN-APPROVED', hasMissingRates: true, totalQty: 25.5, amount: 0 });
  expect((await api('post', `/stores/chemical/inwards/${draft.id}/approve`)).body.error.code).toBe('RATE_MISSING');
  let list = (await api('get', '/stores/chemical/inwards?tab=draft')).body;
  expect(list).toMatchObject({ total: 1, draftCount: 1 });

  // rate known now: enter it and approve in one save
  const ok = (await api('patch', `/stores/chemical/inwards/${draft.id}`, { lines: [{ itemId: soda.id, qty: 25.5, rate: 100 }], salesTax: 459, approve: true })).body;
  expect(ok).toMatchObject({ ipNo: 1, isApproved: true, amount: 2550, salesTax: 459, billed: 3009, balance: 3009 });
  expect((await api('patch', `/stores/chemical/inwards/${draft.id}`, { notes: 'x' })).body.error.code).toBe('ENTRY_APPROVED');

  // second purchase at another rate -> average
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-14', vendorId: vendor.id, lines: [{ itemId: soda.id, qty: 24.5, rate: 120 }], approve: true });
  let st = (await api('get', '/stores/chemical/stock')).body;
  expect(st.data[0]).toMatchObject({ name: 'Caustic Soda', stockQty: 50, stockValue: 5490, avgRate: 109.8 });
  expect((await api('get', '/stores/chemical/stock?groupBy=category')).body.data[0]).toMatchObject({ name: 'Dyes', byUnit: { KG: 50 } });
  expect((await api('get', `/stores/chemical/items/${soda.id}/moves`)).body.data).toHaveLength(2);
  expect((await api('get', '/stores/chemical/inwards?tab=gst')).body.total).toBe(1);
  expect((await api('get', '/stores/chemical/inwards?vendor=nexus')).body.total).toBe(2);
  expect((await api('get', '/stores/chemical/inwards?description=caustic')).body.total).toBe(2);
  expect(st.data[0].stock).toMatchObject({ main: 50, sub: 0, text: '50 KG' });
  // GST % from the dropdown, kg and grams in two boxes
  const g = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', billType: 'GST', gstPercent: 18, lines: [{ itemId: soda.id, qtyMain: 3, qtySub: 500, rate: 1000 }] })).body;
  expect(g).toMatchObject({ totalQty: 3.5, totalQtyText: '3 KG 500 G', amount: 3500, gstPercent: 18, salesTax: 630, billed: 4130 });
  expect(g.lines[0].qtySplit).toMatchObject({ main: 3, mainUnit: 'KG', sub: 500, subUnit: 'G' });
  expect((await api('patch', `/stores/chemical/inwards/${g.id}`, { lines: [{ itemId: soda.id, qtyMain: 1, qtySub: 1000, rate: 1 }] })).body.error.code).toBe('SUB_TOO_BIG');
  expect((await api('patch', `/stores/chemical/inwards/${g.id}`, { billType: 'OTHER' })).body).toMatchObject({ gstPercent: null });
  await api('delete', `/stores/chemical/inwards/${g.id}`);
  // vendor typed: a new name is added, an existing name (any case) is reused
  const t2 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', vendorName: 'munaf lunda', lines: [{ itemId: soda.id, qty: 1 }] })).body;
  const t3 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', vendorName: 'MUNAF LUNDA', lines: [{ itemId: soda.id, qty: 1 }] })).body;
  expect(t2.vendor).toMatchObject({ name: 'munaf lunda' });
  expect(t2.vendor.id).toBe(t3.vendor.id);
  expect(t2.vendor.code).toBeGreaterThan(0);
  await api('delete', `/stores/chemical/inwards/${t2.id}`);
  await api('delete', `/stores/chemical/inwards/${t3.id}`);
  // item typed: a new name is added to the store (in the dropdown next time), the same name is reused
  const n1 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', lines: [{ itemName: 'Lemon Acid', categoryId: cat.id, qtyMain: 1, qtySub: 250 }] })).body;
  expect(n1.lines[0]).toMatchObject({ item: { name: 'Lemon Acid', unit: 'KG', category: 'Dyes' }, qty: 1.25 });
  const n2 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', lines: [{ itemName: 'LEMON ACID', qty: 2 }] })).body;
  expect(n2.lines[0].item.id).toBe(n1.lines[0].item.id);
  expect((await api('get', '/stores/chemical/inwards/form-data')).body.items.map((i) => i.label)).toContain('Dyes / Lemon Acid');
  await api('delete', `/stores/chemical/inwards/${n1.id}`);
  await api('delete', `/stores/chemical/inwards/${n2.id}`);
  // the same chemical typed again (no category, empty itemId) is NOT added twice
  const n3 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', vendorId: '', lines: [{ itemId: '', itemName: 'caustic soda', categoryId: null, qty: 1 }] })).body;
  expect(n3.lines[0].item.id).toBe(soda.id);
  await api('delete', `/stores/chemical/inwards/${n3.id}`);
  expect((await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', lines: [{ itemId: '', qty: 1 }] })).body.error.code).toBe('ITEM_REQUIRED');
  // one stock for the chemical, bought from two vendors; every purchase listed
  const v2 = (await api('post', '/vendors', { name: 'USMAN TRADERS' })).body;
  const u = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', vendorId: v2.id, lines: [{ itemId: soda.id, qtyMain: 10, qtySub: 0, rate: 100 }], approve: true })).body;
  const sd = (await api('get', `/stores/chemical/items/${soda.id}/stock`)).body;
  expect(sd.stock.qty).toBe(60);
  expect(sd.byVendor).toEqual([expect.objectContaining({ purchases: 2, qty: 50 }), expect.objectContaining({ purchases: 1, qty: 10, avgRate: 100 })]);
  expect(sd.purchases).toHaveLength(3);
  expect((await api('get', '/stores/chemical/stock')).body.data.find((i) => i.id === soda.id)).toMatchObject({ purchaseCount: 3, vendorCount: 2 });
  await api('post', `/stores/chemical/inwards/${u.id}/unapprove`);
  await api('patch', `/stores/chemical/inwards/${u.id}`, { lines: [{ itemId: soda.id, qty: 1 }] });

  // the general store does not see chemical entries
  expect((await api('get', '/stores/general/inwards')).body.total).toBe(0);

  // used items and vendors cannot be deleted
  expect((await api('delete', `/stores/chemical/items/${soda.id}`)).body.error.code).toBe('IN_USE');
  expect((await api('delete', `/vendors/${vendor.id}`)).body.error.code).toBe('IN_USE');

  // admin takes the first approval back: stock goes down again
  await api('post', `/stores/chemical/inwards/${ok.id}/unapprove`);
  st = (await api('get', '/stores/chemical/stock')).body;
  expect(st.data[0]).toMatchObject({ stockQty: 24.5, stockValue: 2940, avgRate: 120 });
  expect((await api('delete', `/stores/chemical/inwards/${ok.id}`)).body.error.code).toBe('ENTRY_HAS_IP');
  const d2 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-14', lines: [{ itemId: soda.id, qty: 1 }] })).body;
  expect((await api('delete', `/stores/chemical/inwards/${d2.id}`)).status).toBe(204);
});

test('store access follows the services', async () => {
  const { auth } = await setup(['GENERAL_STORE']);
  expect((await request(app).get('/api/v1/stores/chemical/items').set(auth)).status).toBe(403);
  expect((await request(app).get('/api/v1/stores/general/items').set(auth)).status).toBe(200);
  expect((await request(app).get('/api/v1/vendors').set(auth)).status).toBe(200);
  expect((await request(app).get('/api/v1/stores/paint/items').set(auth)).status).toBe(404);
  const fd = (await request(app).get('/api/v1/stores/general/inwards/form-data').set(auth)).body;
  expect(fd.billTypes).toEqual(['OTHER']);
});

test('default chemical catalog is put into a company once', async () => {
  const { sequelize } = require('../src/models');
  const catalog = require('../src/services/chemicalCatalogService');
  const { auth, company } = await setup();
  const api = (method, url) => request(app)[method](`/api/v1${url}`).set(auth);
  const me = (await api('get', '/stores/chemical/inwards/form-data')).body;
  const companyId = company.id;
  const first = await sequelize.transaction((t) => catalog.seed(sequelize, companyId, t));
  expect(first.items).toBeGreaterThan(200);
  expect((await sequelize.transaction((t) => catalog.seed(sequelize, companyId, t))).items).toBe(0);
  const fd = (await api('get', '/stores/chemical/inwards/form-data')).body;
  expect(fd.items.length).toBe(me.items.length + first.items);
  expect(fd.items.map((i) => i.label)).toContain('COTTON COLOUR (REACTIVE DYES) / RED');
  expect(fd.categories.map((c) => c.name)).toContain('VAT DYES / AMBIFIX');
});
