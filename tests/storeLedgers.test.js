const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

test('inward correction and store ledgers / reports', async () => {
  const company = await makeCompany();
  const s = {};
  await Service.findOrCreate({ where: { code: 'STORE_REPORTS' }, defaults: { name: 'Store Reports', kind: 'MODULE', tracksColour: false, sortOrder: 99 } });
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING', 'STORE_REPORTS']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [600, 400] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  await api('put', `/jobs/${job.id}/status`, { status: 'PROCESSING' });

  const in1 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI CHEM', lines: [{ itemName: 'SULPHUR SPECIAL', qty: 20, rate: 40 }], approve: true })).body;
  const sulphur = await StoreItem.findOne({ where: { companyId: company.id, name: 'SULPHUR SPECIAL' } });
  const in2 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-15', vendorName: 'NEW CHEM', lines: [{ itemId: sulphur.id, qty: 100, rate: 45 }], approve: true })).body;

  // wrong quantity typed (100 instead of 90): fix it
  const fixed = await api('post', `/stores/chemical/inwards/${in2.id}/correct`, { reason: 'typing mistake', lines: [{ lineId: in2.lines[0].id, itemId: sulphur.id, qty: 90, rate: 45 }] });
  expect(fixed.status).toBe(200);
  expect(fixed.body.amount).toBe(4050);
  expect((await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body).toMatchObject({ totalQty: 110, totalValue: 4850 });
  expect((await api('post', `/stores/chemical/inwards/${in2.id}/correct`, { lines: [{ lineId: in2.lines[0].id, itemId: sulphur.id, qty: 90, rate: 45 }] })).status).toBe(400); // reason needed

  // department takes 55 (20 old + 35 new); then the corrections that touch issued stock are limited
  await api('put', '/stores/chemical/department-access/DYEING', { add: [sulphur.id] });
  const r = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: sulphur.id, qty: 55 }] })).body;
  const acc = (await api('post', `/stores/chemical/requests/${r.id}/accept`)).body;
  const batches = (await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body.batches;
  await api('post', `/stores/chemical/requests/${r.id}/send`, { lines: [{ lineId: acc.lines[0].id, batches: [{ batchId: batches[0].batchId, qty: 20 }, { batchId: batches[1].batchId, qty: 35 }] }] });
  const line = fixed.body.lines[0];
  const low = await api('post', `/stores/chemical/inwards/${in2.id}/correct`, { reason: 'again', lines: [{ lineId: line.id, itemId: sulphur.id, qty: 30, rate: 45 }] });
  expect(low.body.error.code).toBe('QTY_BELOW_ISSUED');
  expect((await api('post', `/stores/chemical/inwards/${in2.id}/correct`, { reason: 'rate', lines: [{ lineId: line.id, itemId: sulphur.id, qty: 90, rate: 50 }] })).body.error.code).toBe('LINE_USED');
  expect((await api('post', `/stores/chemical/inwards/${in1.id}/correct`, { reason: 'remove', lines: [{ itemId: sulphur.id, qty: 5, rate: 40 }] })).body.error.code).toBe('LINE_USED');
  const ok = await api('post', `/stores/chemical/inwards/${in2.id}/correct`, { reason: 'more came', dcNo: 'DC-9', lines: [{ lineId: line.id, itemId: sulphur.id, qty: 95, rate: 45 }] });
  expect(ok.body).toMatchObject({ amount: 4275, dcNo: 'DC-9' });
  expect((await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body).toMatchObject({ totalQty: 60, totalValue: 2700 });

  const rep = (name, qs = '') => api('get', `/stores/chemical/reports/${name}?export=true${qs}`);
  const book = (await rep('day-book')).body;
  expect(book.sections[0].rows.map((x) => x.kindText)).toEqual(['Purchase', 'Purchase', 'Purchase corrected', 'Purchase corrected', 'Issued to department']);
  const led = (await rep('item-ledger', `&itemId=${sulphur.id}`)).body;
  expect(led.sections[0].rows.at(-1)).toMatchObject({ balQty: 60 });
  expect(led.sections[1].rows[0]).toMatchObject({ closingQty: 60, purchased: 115, issued: 55 });
  const on = (d) => rep('stock-on-date', `&date=${d}&itemId=${sulphur.id}`).then((x) => x.body.sections[0].rows[0]);
  expect(await on('2026-10-12')).toMatchObject({ qty: 20, value: 800 });
  expect((await on('2026-10-14')).qty).toBe(20);
  expect((await on('2026-10-15')).qty).toBeGreaterThanOrEqual(115 - 55 + 0);
  const sum = (await rep('stock-summary', `&dateFrom=2026-10-13&dateTo=2026-10-31&itemId=${sulphur.id}`)).body.sections[0].rows[0];
  expect(sum).toMatchObject({ openingQty: 20, purchased: 95, closingQty: 60 });
  const pur = (await rep('purchases')).body;
  expect(pur.sections[1].rows[0]).toMatchObject({ item: 'SULPHUR SPECIAL', vendors: 2, differentRates: 'Yes', minRate: 40, maxRate: 45 });
  expect(pur.sections[0].rows.map((x) => x.vendor).sort()).toEqual(['ALI CHEM', 'NEW CHEM']);
  const vl = (await rep('vendor-ledger', `&vendorId=${in2.vendor.id}`)).body;
  expect(vl.sections[0].totals.amount).toBe(4275);
  const iss = (await rep('issues')).body.sections[0].rows[0];
  expect(iss).toMatchObject({ department: 'Dyeing', jobNo: job.jobNo, item: 'SULPHUR SPECIAL', requested: 55, issued: 55, short: 0, cost: 2375, stockBefore: 115, stockAfter: 60 });
  expect((await rep('issues', '&groupBy=so_card')).body.sections[0].rows[0]).toMatchObject({ cost: 2375, netQty: 55 });
  expect((await rep('operators')).body.sections[0].rows[0]).toMatchObject({ issued: 55, cost: 2375 });
  expect((await rep('returns')).status).toBe(200);
  expect((await rep('inwards')).body.sections[0].rows).toHaveLength(2);
  expect((await api('get', '/stores/chemical/reports/nothing')).status).toBe(404);
});
