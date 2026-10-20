const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

// owner 2026-10-19: sulphur 20 kg @ 40 + 100 kg @ 45; department asks 55 kg; store gives from both
test('chemical batches: last purchases, stock rate by rate, pick batches on issue, cost by rate, usage, returns', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING']) {
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
  const so = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  await api('put', `/jobs/${job.id}/status`, { status: 'PROCESSING' });

  // a special chemical never bought before: typed by name, no history
  const in1 = (await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI CHEM', lines: [{ itemName: 'SULPHUR BLACK SPECIAL', qty: 20, rate: 40 }], approve: true })).body;
  const sulphur = await StoreItem.findOne({ where: { companyId: company.id, name: 'SULPHUR BLACK SPECIAL' } });
  expect(in1.isApproved).toBe(true);
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-15', vendorName: 'NEW CHEM', lines: [{ itemId: sulphur.id, qty: 100, rate: 45 }], approve: true });

  const last = (await api('get', `/stores/chemical/items/${sulphur.id}/last-inwards`)).body;
  expect(last.isNew).toBe(false);
  expect(last.data.map((x) => [x.rate, x.qty, x.vendor.name])).toEqual([[45, 100, 'NEW CHEM'], [40, 20, 'ALI CHEM']]);
  const st = (await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body;
  expect(st).toMatchObject({ totalQty: 120, totalValue: 5300, avgRate: 44.1667, batchCount: 2 });
  expect(st.batches.map((b) => [b.qtyLeft, b.rate])).toEqual([[20, 40], [100, 45]]);
  const [old, neu] = st.batches;

  // department asks 55 kg; store gives 20 old + 35 new
  await api('put', '/stores/chemical/department-access/DYEING', { add: [sulphur.id] });
  const r = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: sulphur.id, qty: 55 }] })).body;
  const acc = (await api('post', `/stores/chemical/requests/${r.id}/accept`)).body;
  expect(acc.lines[0].stockBatches.map((b) => b.qtyLeft)).toEqual([20, 100]);
  expect((await api('post', `/stores/chemical/requests/${r.id}/send`, { lines: [{ lineId: acc.lines[0].id, batches: [{ batchId: old.batchId, qty: 25 }] }] })).body.error.code).toBe('BATCH_SHORT');
  const sent = (await api('post', `/stores/chemical/requests/${r.id}/send`, { lines: [{ lineId: acc.lines[0].id, batches: [{ batchId: old.batchId, qty: 20 }, { batchId: neu.batchId, qty: 35 }] }] })).body;
  expect(sent.totalValue).toBe(2375);
  expect(sent.lines[0]).toMatchObject({ sentQty: 55, value: 2375, mixedRates: true });
  expect(sent.lines[0].issuedBatches.map((b) => [b.qty, b.rate, b.value])).toEqual([[20, 40, 800], [35, 45, 1575]]);
  const after = (await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body;
  expect(after).toMatchObject({ totalQty: 65, totalValue: 2925, batchCount: 1 });

  // job cost split by rate
  const jc = (await api('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`)).body;
  expect(jc.chemicals[0]).toMatchObject({ qty: 55, value: 2375, mixedRates: true });
  expect(jc.chemicals[0].byRate.map((x) => [x.rate, x.qty, x.value])).toEqual([[40, 20, 800], [45, 35, 1575]]);

  // where the 100 kg batch went
  const use = (await api('get', `/stores/chemical/batches/${neu.batchId}/usage`)).body;
  expect(use.batch).toMatchObject({ qtyIn: 100, qtyLeft: 65, rate: 45, vendor: { name: 'NEW CHEM' } });
  expect(use.data[0]).toMatchObject({ department: { name: 'Dyeing' }, jobNo: job.jobNo, soNos: [so.cardNo], lotNos: [lot.lotNo], thaans: 2, meters: 1000, qty: 35, value: 1575 });
  expect((await api('get', `/stores/chemical/items/${sulphur.id}/usage`)).body.totals).toMatchObject({ issues: 2, qty: 55, value: 2375 });

  // second request without picking: oldest first (only the 45 batch is left)
  const r2 = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: sulphur.id, qty: 5 }] })).body;
  await api('post', `/stores/chemical/requests/${r2.id}/accept`);
  expect((await api('post', `/stores/chemical/requests/${r2.id}/send`)).body.lines[0]).toMatchObject({ value: 225, rate: 45 });

  // return 25 kg of the first request: goes back to the batches it came from, newest first (35 @ 45 -> 25 @ 45)
  await api('post', `/departments/DYEING/chemical-requests/${r.id}/receive`);
  const ret = (await api('post', `/departments/DYEING/chemical-returns`, { requestId: r.id, lines: [{ requestLineId: sent.lines[0].id, qty: 25 }] })).body;
  const rec = (await api('post', `/stores/chemical/returns/${ret.id}/receive`)).body;
  expect(rec.totalValue).toBe(1125);
  const b3 = (await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body;
  expect(b3).toMatchObject({ totalQty: 85, batchCount: 1 });
  expect(b3.batches[0]).toMatchObject({ qtyLeft: 85, rate: 45 });
  const jc2 = (await api('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`)).body;
  expect(jc2.chemicals[0].byRate.map((x) => [x.rate, x.qty])).toEqual([[40, 20], [45, 15]]);

  // a used purchase cannot be un-approved
  expect((await api('post', `/stores/chemical/inwards/${in1.id}/unapprove`)).body.error.code).toBe('STOCK_USED');
  // adjustment out takes from the batches
  const adj = (await api('post', '/stores/chemical/adjustments', { reason: 'DAMAGED', lines: [{ itemId: sulphur.id, mode: 'OUT', qty: 5 }] })).body;
  expect(adj.lines[0]).toMatchObject({ value: -225 });
  expect((await api('get', `/stores/chemical/items/${sulphur.id}/batches`)).body.totalQty).toBe(80);
});
