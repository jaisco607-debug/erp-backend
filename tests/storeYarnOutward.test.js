const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, StoreItem, StoreYarnInward, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

jest.setTimeout(400000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['YARN_STORE', 'GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'STORE_REPORTS', 'DYEING', 'FOLDING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const person = async (code, access) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    await UserService.create({ userId: u.id, serviceId: s[code].id, access });
    return call(u);
  };
  // two SO cards in one dyeing job: 6000 m + 4000 m
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ TEXTILES' })).body;
  const q = (await api('post', '/qualities', { name: '16X10 PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 10000, pieces: 10 })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const so1 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 6000 }] })).body;
  const so2 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 4000 }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  const vendor = (await api('post', '/vendors', { name: 'Yarn Mills' })).body;
  // yarn in the store: A = 10 bags x 50 lbs at 300 (150,000), B = 5 bags x 100 lbs, no rate
  const mk = async (extra, approve = true) => {
    const e = (await api('post', '/store-yarn-inwards', { inwardDate: '2026-10-12', vendorId: vendor.id, yarnName: '22/s Cotton', brand: 'Crescent', bags: 10, lbsPerBag: 50, ratePerLb: 300, ...extra })).body;
    if (approve) await api('post', `/store-yarn-inwards/${e.id}/approve`);
    return e;
  };
  return { company, s, api, person, so1, so2, job, vendor, mk, red: await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } }) };
}

test('yarn outward to a department: stock falls, the department sees it, uses it on a job / SO card; the cost lands on the job and SO card next to the chemical cost', async () => {
  const w = await setup();
  const a = await w.mk({});
  const b = await w.mk({ yarnName: '30/s Polyester', brand: undefined, bags: 5, lbsPerBag: 100, ratePerLb: undefined });
  const draft = await w.mk({}, false);

  // form data: the departments and the yarn in the store
  const fd = (await w.api('get', '/store-yarn-outwards/form-data')).body;
  expect([fd.nextOutwardNo, fd.nextOutwardText]).toEqual([1, '00001']);
  expect(fd.departments.map((d) => d.code).sort()).toEqual(['DYEING', 'FOLDING']);
  expect(fd.stock.map((x) => [x.inwardNo, x.balanceBags, x.balanceLbs])).toEqual([[1, 10, 500], [2, 5, 500]]);
  // rules
  err(await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: a.id, bags: 11 }] }), 422, 'NOT_ENOUGH_BAGS');
  err(await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: draft.id, bags: 1 }] }), 422, 'INWARD_NOT_APPROVED');
  err(await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, outwardDate: '2026-10-01', lines: [{ inwardId: a.id, bags: 1 }] }), 422, 'OUTWARD_BEFORE_INWARD');
  err(await w.api('post', '/store-yarn-outwards', { departmentId: '11111111-1111-4111-8111-111111111111', lines: [{ inwardId: a.id, bags: 1 }] }), 422, 'UNKNOWN_DEPARTMENT');
  err(await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: a.id, bags: 1 }, { inwardId: a.id, bags: 1 }] }), 400, 'VALIDATION_FAILED');
  err(await w.api('post', '/store-yarn-outwards', { departmentId: w.s.DYEING.id, lines: [{ inwardId: a.id, bags: 0 }] }), 400, 'VALIDATION_FAILED');

  // outward 1: 6 bags of A (6 x 50 x 300 = 90,000) and 2 bags of B (no rate: value 0) to Dyeing
  const o = await w.api('post', '/store-yarn-outwards', { outwardDate: '2026-10-13', departmentId: w.s.DYEING.id, dcNo: 'OUT-1', sentThrough: 'Akram', lines: [{ inwardId: a.id, bags: 6 }, { inwardId: b.id, bags: 2 }] });
  expect(o.status).toBe(201);
  expect(o.body).toMatchObject({ outwardNo: 1, outwardText: '00001', outwardDate: '2026-10-13', department: { code: 'DYEING' }, dcNo: 'OUT-1', sentThrough: 'Akram', totalBags: 8, totalLbs: 500, totalValue: 90000, usedBags: 0, balanceBags: 8, canCancel: true });
  expect(o.body.lines.map((l) => [l.title, l.bags, l.lbsPerBag, l.lbs, l.ratePerLb, l.value])).toEqual([['22/s Cotton - Crescent', 6, 50, 300, 300, 90000], ['30/s Polyester', 2, 100, 200, null, 0]]);
  // the Yarn Stock fell and says where it went
  expect((await StoreYarnInward.findByPk(a.id)).outwardBags).toBe(6);
  const st = (await w.api('get', '/store-yarn-inwards/stock')).body;
  expect(st.totals).toMatchObject({ balanceBags: 7, balanceLbs: 500, balanceValue: 60000 });
  expect(st.byDepartment).toEqual([{ department: { id: w.s.DYEING.id, name: 'Dyeing' }, outwards: 1, issuedBags: 8, issuedLbs: 500, issuedValue: 90000, usedBags: 0, balanceBags: 8, balanceValue: 90000 }]);
  const ent = (await w.api('get', `/store-yarn-inwards/${a.id}`)).body;
  expect(ent.outwards).toEqual([{ outwardId: o.body.id, outwardNo: 1, outwardText: '00001', outwardDate: '2026-10-13', department: { code: 'DYEING', name: 'Dyeing' }, bags: 6, usedBags: 0, balanceBags: 6, value: 90000 }]);
  err(await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`), 422, 'INWARD_IN_USE');
  // lists and the summary
  const list = (await w.api('get', '/store-yarn-outwards')).body;
  expect([list.total, list.totals]).toEqual([1, { outwards: 1, bags: 8, lbs: 500, value: 90000 }]);
  expect((await w.api('get', '/store-yarn-outwards?search=Polyester')).body.total).toBe(1);
  expect((await w.api('get', `/store-yarn-outwards?departmentId=${w.s.FOLDING.id}`)).body.total).toBe(0);
  expect((await w.api('get', `/store-yarn-outwards?inwardId=${b.id}`)).body.total).toBe(1);
  const sum = (await w.api('get', '/store-yarn-outwards/summary')).body;
  expect(sum.data.map((x) => [x.label, x.issuedBags, x.issuedValue, x.usedBags, x.balanceBags])).toEqual([['Dyeing', 8, 90000, 0, 8]]);
  expect((await w.api('get', '/store-yarn-outwards/summary?groupBy=yarn')).body.data.map((x) => [x.label, x.issuedBags, x.issuedValue])).toEqual([['22/s Cotton - Crescent', 6, 90000], ['30/s Polyester', 2, 0]]);

  // the department: what it has
  const ys = (await w.api('get', '/departments/DYEING/yarn')).body;
  expect(ys.totals).toEqual({ receivedBags: 8, usedBags: 0, balanceBags: 8, balanceLbs: 500, balanceValue: 90000 });
  expect(ys.data.map((x) => [x.title, x.outwardNo, x.receivedBags, x.balanceBags, x.balanceLbs, x.balanceValue])).toEqual([['22/s Cotton - Crescent', 1, 6, 6, 300, 90000], ['30/s Polyester', 1, 2, 2, 200, 0]]);
  expect((await w.api('get', '/departments/FOLDING/yarn')).body.totals.balanceBags).toBe(0);
  // using yarn needs a job that is accepted (Processing)
  const lineA = ys.data[0].outwardLineId;
  err(await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 1 }] }), 422, 'JOB_NOT_ACCEPTED');
  await w.api('put', `/jobs/${w.job.id}/status`, { status: 'PROCESSING' });
  const form = (await w.api('get', '/departments/DYEING/yarn/form-data')).body;
  expect(form.jobs.map((j) => [j.jobNo, j.soCards.map((c) => c.cardNo)])).toEqual([[w.job.jobNo, [w.so1.cardNo, w.so2.cardNo]]]);
  expect(form.stock).toHaveLength(2);
  err(await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 7 }] }), 422, 'NOT_ENOUGH_BAGS');
  err(await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, soCardId: '11111111-1111-4111-8111-111111111111', lines: [{ outwardLineId: lineA, bags: 1 }] }), 422, 'SO_NOT_IN_JOB');
  err(await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: '11111111-1111-4111-8111-111111111111', bags: 1 }] }), 422, 'UNKNOWN_YARN');
  err(await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, usageDate: '2026-10-01', lines: [{ outwardLineId: lineA, bags: 1 }] }), 422, 'USE_BEFORE_OUTWARD');
  err(await w.api('post', '/departments/FOLDING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 1 }] }), 422, 'UNKNOWN_JOB');

  // use 1: the whole job, 2 bags of A (30,000); use 2: SO card 2 only, 1 bag of A (15,000) and 1 bag of B (no rate)
  const u1 = await w.api('post', '/departments/DYEING/yarn-usages', { usageDate: '2026-10-14', jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 2 }] });
  expect(u1.status).toBe(201);
  expect(u1.body).toMatchObject({ usageNo: 1, usageText: '00001', job: { jobNo: w.job.jobNo }, soCard: null, totalBags: 2, totalLbs: 100, totalValue: 30000 });
  const u2 = await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, soCardId: w.so2.id, remarks: 'for SO 2', lines: [{ outwardLineId: lineA, bags: 1 }, { outwardLineId: ys.data[1].outwardLineId, bags: 1 }] });
  expect(u2.body).toMatchObject({ usageNo: 2, soCard: { id: w.so2.id, cardNo: w.so2.cardNo }, totalBags: 2, totalLbs: 150, totalValue: 15000, remarks: 'for SO 2' });
  // the department stock fell; the store side shows what was used
  const ys2 = (await w.api('get', '/departments/DYEING/yarn')).body;
  expect(ys2.totals).toEqual({ receivedBags: 8, usedBags: 4, balanceBags: 4, balanceLbs: 250, balanceValue: 45000 });
  expect(ys2.data.map((x) => [x.usedBags, x.balanceBags])).toEqual([[3, 3], [1, 1]]);
  expect((await w.api('get', '/store-yarn-outwards/summary')).body.data[0]).toMatchObject({ issuedBags: 8, usedBags: 4, usedValue: 45000, balanceBags: 4, balanceValue: 45000 });
  expect((await w.api('get', `/store-yarn-outwards/${o.body.id}`)).body).toMatchObject({ usedBags: 4, balanceBags: 4, canCancel: false });
  err(await w.api('post', `/store-yarn-outwards/${o.body.id}/cancel`), 422, 'OUTWARD_IN_USE');
  const us = (await w.api('get', '/departments/DYEING/yarn-usages')).body;
  expect([us.total, us.totals, us.data.map((x) => x.usageNo)]).toEqual([2, { usages: 2, bags: 4, lbs: 250, value: 45000 }, [2, 1]]);
  expect((await w.api('get', `/departments/DYEING/yarn-usages?soCardId=${w.so2.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/departments/DYEING/yarn-usages?search=polyester')).body.total).toBe(1);

  // the chemical cost of the same job: RED 2 kg at 100 = 200 (whole job)
  await w.api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI CHEM', lines: [{ itemId: w.red.id, qty: 10, rate: 100 }], approve: true });
  await w.api('put', '/stores/chemical/department-access/DYEING', { add: [w.red.id] });
  const rq = (await w.api('post', '/departments/DYEING/chemical-requests', { jobId: w.job.id, lines: [{ itemId: w.red.id, qty: 2 }] })).body;
  await w.api('post', `/stores/chemical/requests/${rq.id}/accept`);
  await w.api('post', `/stores/chemical/requests/${rq.id}/send`);

  // cost of the JOB: chemical 200 + yarn 45,000
  const jc = (await w.api('get', `/departments/DYEING/jobs/${w.job.id}/chemical-cost`)).body;
  expect(jc).toMatchObject({ totalValue: 200, chemicalValue: 200, yarnValue: 45000, grandTotal: 45200 });
  expect(jc.yarn.items).toEqual([{ title: '22/s Cotton - Crescent', bags: 3, lbs: 150, value: 45000 }, { title: '30/s Polyester', bags: 1, lbs: 100, value: 0 }]);
  expect(jc.yarn.usages.map((x) => [x.usageNo, x.value])).toEqual([[1, 30000], [2, 15000]]);
  const jy = (await w.api('get', `/departments/DYEING/jobs/${w.job.id}/yarn-cost`)).body;
  expect([jy.totalValue, jy.totalBags]).toEqual([45000, 4]);
  // cost of each SO card: SO 1 (60 %) = chemical 120 + yarn 18,000; SO 2 (40 %) = chemical 80 + yarn 12,000 + its own 15,000
  const c1 = (await w.api('get', `/stores/chemical/cost/so-cards/${w.so1.id}`)).body;
  const c2 = (await w.api('get', `/stores/chemical/cost/so-cards/${w.so2.id}`)).body;
  expect([c1.totalValue, c1.chemicalValue, c1.yarnValue, c1.grandTotal]).toEqual([120, 120, 18000, 18120]);
  expect([c2.totalValue, c2.yarnValue, c2.grandTotal]).toEqual([80, 27000, 27080]);
  expect(c2.yarn.items[0]).toMatchObject({ title: '22/s Cotton - Crescent', value: 27000 });
  expect(c2.byJob[0]).toMatchObject({ value: 80, yarnValue: 27000, grandValue: 27080 });
  expect((await w.api('get', `/departments/DYEING/so-cards/${w.so1.id}/chemical-cost`)).body.grandTotal).toBe(18120);
  expect((await w.api('get', `/departments/DYEING/so-cards/${w.so2.id}/yarn-cost`)).body.totalValue).toBe(27000);
  // the cost reports: value = chemical (as before), yarnValue, grandValue; totals
  const rj = (await w.api('get', '/departments/DYEING/chemical-cost/jobs')).body;
  expect(rj).toMatchObject({ total: 1, totalValue: 200, totalChemicalValue: 200, totalYarnValue: 45000, grandTotal: 45200 });
  expect(rj.data[0]).toMatchObject({ job: { jobNo: w.job.jobNo }, value: 200, chemicalValue: 200, yarnValue: 45000, grandValue: 45200, requests: 1, yarnUsages: 2 });
  const rs = (await w.api('get', '/stores/chemical/cost/so-cards?dateFrom=2000-01-01')).body;
  expect(rs.data.map((x) => [x.soCard.cardNo, x.value, x.yarnValue, x.grandValue])).toEqual([[w.so2.cardNo, 80, 27000, 27080], [w.so1.cardNo, 120, 18000, 18120]]);
  expect(rs).toMatchObject({ totalYarnValue: 45000, grandTotal: 45200 });
  expect((await w.api('get', '/stores/chemical/cost/jobs?dateTo=2000-01-01')).body.total).toBe(0);
  // the department's job list: the yarn amount and the cost of both
  const jobs = (await w.api('get', `/jobs?departmentId=${w.s.DYEING.id}&side=in`)).body.data;
  expect(jobs[0]).toMatchObject({ chemicalAmount: 200, yarnAmount: 45000, totalCostAmount: 45200 });
  expect(jobs[0].yarnPerMeter).toBe(4.5);
  const so = (await w.api('get', `/jobs?departmentId=${w.s.DYEING.id}&side=in&view=so`)).body.data;
  expect(so.map((r) => [r.soCard.cardNo, r.chemicalAmount, r.yarnAmount, r.totalCostAmount])).toEqual([[w.so1.cardNo, 120, 18000, 18120], [w.so2.cardNo, 80, 27000, 27080]]);

  // take a use back: the yarn is in the department stock again and leaves the cost
  const gone = await w.api('delete', `/departments/DYEING/yarn-usages/${u2.body.id}`);
  expect([gone.status, gone.body]).toEqual([200, { id: u2.body.id, usageNo: 2, deleted: true }]);
  expect((await w.api('get', '/departments/DYEING/yarn')).body.totals).toMatchObject({ usedBags: 2, balanceBags: 6 });
  expect((await w.api('get', `/departments/DYEING/jobs/${w.job.id}/chemical-cost`)).body.yarnValue).toBe(30000);
  expect((await w.api('delete', `/departments/DYEING/yarn-usages/${u2.body.id}`)).status).toBe(404);
  // the last bags of a line take what is left of its value, so the parts add up to the line (6 bags = 90,000): use 4 more, then the rest
  await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 3 }] }); // 45,000
  const last = (await w.api('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: lineA, bags: 1 }] })).body; // 15,000 (the last)
  expect(last.totalValue).toBe(15000);
  expect((await w.api('get', `/departments/DYEING/jobs/${w.job.id}/yarn-cost`)).body.totalValue).toBe(90000);
  // cancel an outward once nothing of it is used (use everything back first)
  for (const x of (await w.api('get', '/departments/DYEING/yarn-usages')).body.data) await w.api('delete', `/departments/DYEING/yarn-usages/${x.id}`);
  const back = await w.api('post', `/store-yarn-outwards/${o.body.id}/cancel`);
  expect([back.status, back.body.deleted]).toEqual([200, true]);
  expect((await StoreYarnInward.findByPk(a.id)).outwardBags).toBe(0);
  expect((await w.api('get', '/store-yarn-inwards/stock')).body.totals.balanceBags).toBe(15);
  expect((await w.api('get', '/departments/DYEING/yarn')).body.totals.balanceBags).toBe(0);
  expect((await w.api('get', `/store-yarn-outwards/${o.body.id}`)).status).toBe(404);
});

test('access: the store side needs YARN_STORE, the department side needs the department; another company sees nothing', async () => {
  const w = await setup();
  const a = await w.mk({});
  const storeFull = await w.person('YARN_STORE', 'FULL');
  const storeView = await w.person('YARN_STORE', 'VIEW');
  const deptFull = await w.person('DYEING', 'FULL');
  const deptView = await w.person('DYEING', 'VIEW');
  const body = { departmentId: w.s.DYEING.id, lines: [{ inwardId: a.id, bags: 4 }] };
  expect((await storeView('get', '/store-yarn-outwards')).status).toBe(200);
  expect((await storeView('post', '/store-yarn-outwards', body)).status).toBe(403);
  expect((await deptFull('post', '/store-yarn-outwards', body)).status).toBe(403);
  const o = await storeFull('post', '/store-yarn-outwards', body);
  expect(o.status).toBe(201);
  expect((await storeView('post', `/store-yarn-outwards/${o.body.id}/cancel`)).status).toBe(403);
  expect((await deptFull('get', '/departments/DYEING/yarn')).body.totals.balanceBags).toBe(4);
  expect((await deptView('get', '/departments/DYEING/yarn')).status).toBe(200);
  expect((await deptView('post', '/departments/DYEING/yarn-usages', { jobId: w.job.id, lines: [{ outwardLineId: (await deptView('get', '/departments/DYEING/yarn')).body.data[0].outwardLineId, bags: 1 }] })).status).toBe(403);
  expect((await deptFull('get', '/departments/FOLDING/yarn')).status).toBe(403); // not his department
  expect((await storeFull('get', '/departments/DYEING/yarn')).status).toBe(403);
  const other = await setup();
  expect((await other.api('get', `/store-yarn-outwards/${o.body.id}`)).status).toBe(404);
  expect((await other.api('post', `/store-yarn-outwards/${o.body.id}/cancel`)).status).toBe(404);
  expect((await other.api('get', '/store-yarn-outwards')).body.total).toBe(0);
  const lineId = (await w.api('get', '/departments/DYEING/yarn')).body.data[0].outwardLineId;
  err(await other.api('post', '/departments/DYEING/yarn-usages', { jobId: other.job.id, lines: [{ outwardLineId: lineId, bags: 1 }] }), 422, 'JOB_NOT_ACCEPTED');
});
