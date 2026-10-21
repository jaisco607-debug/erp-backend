const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

const row = (rep, where) => rep.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));

test('reports: grey to gate pass, departments, chemical cost, folding, active fabric, packing, access', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING', 'FOLDING', 'PACKING', 'REPORT_OVERVIEW', 'REPORT_GREY', 'REPORT_SO_CARDS', 'REPORT_DEPARTMENTS', 'REPORT_CHEMICAL_COST', 'REPORT_FOLDING', 'REPORT_ACTIVE_FABRIC', 'REPORT_PACKING', 'REPORT_GATE_PASSES']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  // grey: AZ lot 1 (3 thaans, 300 m) + lot 2 (500 m, 100 m given back); BB lot 3 (2 thaans, 100 m)
  const az = (await api('post', '/customers', { name: 'AZ' })).body;
  const bb = (await api('post', '/customers', { name: 'BB' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot1 = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: az.id, qualityId: q.id, thaans: [100, 120, 80] })).body;
  const lot2 = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: az.id, qualityId: q.id, inwardMeters: 500, pieces: 5 })).body;
  const lot3 = (await api('post', '/grey-lots', { inwardDate: '2026-10-16', customerId: bb.id, qualityId: q.id, thaans: [50, 50] })).body;
  for (const l of [lot1, lot2, lot3]) await api('post', `/grey-lots/${l.id}/approve`);
  await api('post', `/grey-lots/${lot2.id}/give-back`, { meters: 100, pieces: 1 });

  // SO cards: A (lot 1, all thaans), B (lot 2, 200 m), C (BB lot 3 thaan 1, not sent)
  const cardA = (await api('post', '/so-cards', { cardDate: '2026-10-16', lots: [{ greyLotId: lot1.id, thaanNos: [1, 2, 3] }] })).body;
  const cardB = (await api('post', '/so-cards', { cardDate: '2026-10-16', lots: [{ greyLotId: lot2.id, meters: 200 }] })).body;
  const cardC = (await api('post', '/so-cards', { cardDate: '2026-10-17', lots: [{ greyLotId: lot3.id, thaanNos: [1] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const rowOf = (card) => fd.rows.find((r) => r.soCard.id === card.id).soCardLotId;
  const job1 = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: rowOf(cardA) }] })).body;
  const job2 = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: rowOf(cardB) }] })).body;
  await api('put', `/jobs/${job2.id}/status`, { status: 'PROCESSING' });

  // chemical: RED 2 kg at 100 for the whole job 1 = 200
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-16', vendorName: 'ALI CHEM', lines: [{ itemId: red.id, qty: 10, rate: 100 }], approve: true });
  await api('put', `/jobs/${job1.id}/status`, { status: 'PROCESSING' });
  await api('put', '/stores/chemical/department-access/DYEING', { add: [red.id] });
  const cr = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job1.id, lines: [{ itemId: red.id, qty: 2 }] })).body;
  await api('post', `/stores/chemical/requests/${cr.id}/accept`);
  expect((await api('post', `/stores/chemical/requests/${cr.id}/send`)).body.status).toBe('IN_WAY');

  // job 1: Dyeing -> Folding (grade) -> Packing -> packing list -> gate pass
  await api('put', `/departments/DYEING/jobs/${job1.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/DYEING/jobs/${job1.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-17' });
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows.find((r) => r.soCard.id === cardA.id).jobItemId }] })).body;
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const ls = (await api('get', `/departments/FOLDING/folding/${fold.id}/${cardA.id}`)).body.lots[0].lines;
  await api('put', `/departments/FOLDING/folding/${fold.id}/${cardA.id}/grades`, { lines: [
    { greyLotId: lot1.id, thaanId: ls[0].thaanId, a: 100 }, { greyLotId: lot1.id, thaanId: ls[1].thaanId, b: 120 }, { greyLotId: lot1.id, thaanId: ls[2].thaanId, a: 80 },
  ] });
  const pack = (await api('post', `/departments/FOLDING/folding/${fold.id}/${cardA.id}/send-packing`, { keepRemaining: false })).body.packingJob;
  await api('post', `/departments/PACKING/jobs/${pack.id}/accept`);

  // before the gate pass, the cloth is still in packing
  let active = (await api('get', '/reports/active-fabric?by=party')).body;
  expect(row(active, { party: `AZ (${az.code})` })).toMatchObject({ inProcessMeters: 200, inFoldingMeters: 0, inPackingMeters: 300, activeMeters: 500 });

  const pf = (await api('get', `/departments/PACKING/packing/so-cards/${cardA.id}/form`)).body;
  const pl = (await api('post', '/departments/PACKING/packing-lists', {
    soCardId: cardA.id, rateA: 50, rateB: 20,
    lines: pf.lots[0].thaans.map((t) => ({ greyLotId: lot1.id, thaanId: t.thaanId, grade: t.suggestedLines[0].grade, meters: t.suggestedLines[0].meters })),
  })).body;
  await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'Akram', vehicleNo: 'LEA-1', passDate: '2030-01-01' });

  // ---- catalog ----
  const cat = (await api('get', '/reports')).body;
  expect(cat.reports.length).toBeGreaterThan(10);
  expect(cat.departments.map((d) => d.code)).toEqual(expect.arrayContaining(['DYEING', 'FOLDING', 'PACKING']));

  // ---- grey ----
  const parties = (await api('get', '/reports/grey/parties')).body;
  expect(parties.columns.find((c) => c.key === 'inwardMeters')).toMatchObject({ type: 'meters', total: true });
  expect(row(parties, { customer: 'AZ' })).toMatchObject({
    lots: 2, inwardMeters: 800, returnedMeters: 100, soCardMeters: 500, greyStockMeters: 200,
    soDeskMeters: 0, inProcessMeters: 200, inPackingMeters: 0, activeMeters: 200, packedMeters: 300, dispatchedMeters: 300,
  });
  expect(row(parties, { customer: 'BB' })).toMatchObject({ inwardMeters: 100, soCardMeters: 50, greyStockMeters: 50, greyStockThaans: 1, soDeskMeters: 50 });
  expect(parties.totals).toMatchObject({ inwardMeters: 900, greyStockMeters: 250 });
  expect((await api('get', `/reports/grey/parties?customerId=${bb.id}`)).body.total).toBe(1);
  expect((await api('get', '/reports/grey/parties?dateFrom=2026-10-16')).body.rows.map((r) => r.customer)).toEqual(['BB']);

  const lots = (await api('get', '/reports/grey/lots')).body;
  expect(row(lots, { lotNo: lot1.lotNo })).toMatchObject({ thaans: 3, inwardMeters: 300, balanceMeters: 0, freeThaans: 0, dispatchedMeters: 300, soCards: String(cardA.cardNo) });
  expect(row(lots, { lotNo: lot2.lotNo })).toMatchObject({ returnedMeters: 100, balanceMeters: 200, activeMeters: 200 });
  expect((await api('get', '/reports/grey/lots?stock=in-stock')).body.total).toBe(2);
  expect((await api('get', '/reports/grey/returns')).body).toMatchObject({ total: 1, totals: { meters: 100 } });

  // ---- SO cards ----
  const cards = (await api('get', '/reports/so-cards')).body;
  expect(row(cards, { cardNo: cardA.cardNo })).toMatchObject({ lots: 1, thaans: 3, meters: 300, departments: 'Dyeing > Folding > Packing', chemicalCost: 200, dispatchedMeters: 300, packingLists: 1, gatePasses: 1 });
  expect(row(cards, { cardNo: cardB.cardNo })).toMatchObject({ inProcessMeters: 200, departments: 'Dyeing' });
  expect(row(cards, { cardNo: cardC.cardNo })).toMatchObject({ soDeskMeters: 50, sentMeters: 0, departments: '' });
  expect((await api('get', `/reports/so-cards?departmentId=${s.FOLDING.id}`)).body.total).toBe(1);
  const cl = (await api('get', `/reports/so-cards/lots?soCardId=${cardA.id}`)).body;
  expect(cl.rows[0]).toMatchObject({ lotNo: lot1.lotNo, thaans: 3, thaanNos: '1 (100), 2 (120), 3 (80)', meters: 300 });

  const detail = (await api('get', `/reports/so-cards/${cardA.id}`)).body;
  expect(detail.header).toMatchObject({ cardNo: cardA.cardNo, chemicalCost: 200, cloth: { dispatchedMeters: 300 } });
  const t = (k) => detail.tables.find((x) => x.key === k);
  expect(t('journey').rows.map((r) => r.department)).toEqual(['Dyeing', 'Folding', 'Packing']);
  expect(t('journey').rows[0]).toMatchObject({ operatorName: 'Aslam', chemicalCost: 200, thaans: 3 });
  expect(t('chemicals').rows).toEqual([expect.objectContaining({ department: 'Dyeing', chemical: 'RED', qty: 2, value: 200 })]);
  expect(t('thaans').rows.map((r) => r.chemicalCost)).toEqual([66.67, 80, 53.33]);
  expect(t('folding').totals).toMatchObject({ a: 180, b: 120, sent: 300 });
  expect(t('packing').rows[0]).toMatchObject({ thaans: 3, meters: 300, amount: 11400, gatePassNo: 1, vehicleNo: 'LEA-1' });
  expect((await api('get', '/reports/so-cards/00000000-0000-4000-8000-000000000000')).status).toBe(404);

  // ---- departments ----
  const deps = (await api('get', '/reports/departments')).body;
  expect(row(deps, { department: 'Dyeing' })).toMatchObject({ jobs: 2, soCards: 2, thaans: 3, meters: 500, processingMeters: 200, completeMeters: 300, chemicalCost: 200, costPerMeter: 0.4, activeNowMeters: 200 });
  expect(row(deps, { department: 'Folding' })).toMatchObject({ jobs: 1, meters: 300, activeNowMeters: 0 });
  expect(row(deps, { department: 'Packing' })).toMatchObject({ jobs: 1, activeNowMeters: 0 });

  const jobs = (await api('get', `/reports/departments/jobs?departmentId=${s.DYEING.id}`)).body;
  expect(jobs.total).toBe(2);
  expect(row(jobs, { jobNo: job1.jobNo })).toMatchObject({ fromDepartment: 'SO Card', cardNo: cardA.cardNo, thaans: 3, meters: 300, status: 'Complete', operatorName: 'Aslam', chemicalCost: 200 });
  expect((await api('get', '/reports/departments/jobs?operatorName=asl')).body.total).toBe(1);

  const ops = (await api('get', `/reports/departments/operators?departmentId=${s.DYEING.id}`)).body;
  expect(row(ops, { operatorName: 'Aslam' })).toMatchObject({ jobs: 1, completeJobs: 1, soCards: 1, thaans: 3, meters: 300, chemicalCost: 200 });
  expect(row(ops, { operatorName: '(not entered)' })).toMatchObject({ meters: 200 });

  // ---- chemical cost ----
  const byCard = (await api('get', '/reports/chemical-cost')).body;
  expect(byCard).toMatchObject({ total: 1, totalCost: 200, totals: { value: 200 } });
  expect(byCard.rows[0]).toMatchObject({ department: 'Dyeing', cardNo: cardA.cardNo, meters: 300, value: 200, chemicalNames: 'RED' });
  const byThaan = (await api('get', '/reports/chemical-cost?by=thaan')).body;
  expect(byThaan.rows.map((r) => [r.thaanNo, r.meters, r.value])).toEqual([[1, 100, 66.67], [2, 120, 80], [3, 80, 53.33]]);
  expect((await api('get', '/reports/chemical-cost?by=chemical')).body.rows[0]).toMatchObject({ lotNo: lot1.lotNo, chemical: 'RED', qty: 2, value: 200 });
  expect((await api('get', '/reports/chemical-cost?by=item')).body.rows[0]).toMatchObject({ chemical: 'RED', qty: 2, avgRate: 100, soCards: 1 });
  expect((await api('get', '/reports/chemical-cost?dateTo=2000-01-01')).body.total).toBe(0);

  // ---- folding ----
  const f = (await api('get', '/reports/folding')).body;
  expect(f.rows[0]).toMatchObject({ fromDepartment: 'Dyeing', cardNo: cardA.cardNo, thaans: 3, receivedMeters: 300, aMeters: 180, bMeters: 120, sentToPackingMeters: 300, leftInFoldingMeters: 0, chemicalCost: 200 });
  expect((await api('get', '/reports/folding?by=party')).body.rows[0]).toMatchObject({ name: `AZ (${az.code})`, receivedMeters: 300 });
  expect((await api('get', '/reports/folding?by=from-department')).body.rows[0]).toMatchObject({ name: 'Dyeing', jobs: 1 });
  expect((await api('get', '/reports/folding?tab=open')).body.total).toBe(0);

  // ---- active fabric (after the gate pass) ----
  active = (await api('get', '/reports/active-fabric?by=party')).body;
  expect(row(active, { party: `AZ (${az.code})` })).toMatchObject({ inProcessMeters: 200, inPackingMeters: 0, activeMeters: 200 });
  expect(row(active, { party: `BB (${bb.code})` })).toMatchObject({ soDeskMeters: 50, activeMeters: 0 });
  const byDept = (await api('get', '/reports/active-fabric?by=department')).body;
  expect(row(byDept, { department: 'SO Card (not sent)' })).toMatchObject({ meters: 50 });
  expect(row(byDept, { department: 'Dyeing' })).toMatchObject({ processingMeters: 200, meters: 200, soCards: 1 });
  expect(row(byDept, { department: 'Packing' })).toMatchObject({ meters: 0 });
  const detailRows = (await api('get', '/reports/active-fabric?by=detail')).body;
  expect(detailRows.rows).toEqual([expect.objectContaining({ department: 'Dyeing', status: 'Processing', cardNo: cardB.cardNo, meters: 200 })]);
  expect((await api('get', `/reports/active-fabric?by=party&departmentId=${s.DYEING.id}`)).body.error.code).toBe('BAD_FILTER');

  // ---- packing, gate passes ----
  const lists = (await api('get', '/reports/packing-lists')).body;
  expect(lists.rows[0]).toMatchObject({ status: 'Final', cardNo: cardA.cardNo, thaans: 3, aMeters: 180, bMeters: 120, meters: 300, amount: 11400, gatePassNo: 1 });
  expect((await api('get', '/reports/packing-lists?gatePass=no')).body.total).toBe(0);
  const lines = (await api('get', '/reports/packing-lists/lines?grade=B')).body;
  expect(lines.rows).toEqual([expect.objectContaining({ thaanNo: 2, grade: 'B', meters: 120, rate: 20, amount: 2400 })]);
  const gp = (await api('get', '/reports/gate-passes?search=lea')).body;
  expect(gp.rows[0]).toMatchObject({ gatePassNo: 1, thaans: 3, meters: 300, driverName: 'Akram', party: `AZ (${az.code})` });

  // ---- overview, paging, download ----
  const ov = (await api('get', '/reports/overview')).body;
  expect(ov.summary).toMatchObject({ grey: { lots: 3, inward: 900 }, chemicalCost: 200, gatePasses: { passes: 1, meters: 300 }, now: { activeMeters: 200, soDeskMeters: 50 } });
  const p1 = (await api('get', '/reports/grey/lots?limit=1')).body;
  expect(p1).toMatchObject({ total: 3, page: 1, limit: 1, totals: { inwardMeters: 900 } });
  expect(p1.rows).toHaveLength(1);
  expect((await api('get', '/reports/grey/lots?limit=1&all=true')).body.rows).toHaveLength(3);
  expect((await api('get', '/reports/grey/lots?dateFrom=16-10-2026')).status).toBe(400);

  // ---- access: every report group is its own service ----
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  const uauth = { Authorization: `Bearer ${(await loginAs(user)).accessToken}` };
  const asUser = (url) => request(app).get(`/api/v1${url}`).set(uauth);
  expect((await asUser('/reports/grey/parties')).status).toBe(403);
  expect((await asUser('/reports')).status).toBe(403);
  await api('put', `/users/${user.id}/services`, { services: [{ serviceId: s.REPORT_GREY.id, access: 'VIEW' }] });
  expect((await asUser('/reports/grey/parties')).status).toBe(200);
  expect((await asUser('/reports/so-cards')).status).toBe(403);
  expect((await asUser('/reports/overview')).status).toBe(403);
  expect((await asUser('/reports/gate-passes')).status).toBe(403);
  const mine = (await asUser('/reports')).body;
  expect(mine.reports.map((r) => r.key)).toEqual(['grey-parties', 'grey-lots', 'grey-returns']);
  expect(mine.reports[0].service).toBe('REPORT_GREY');
  expect((await api('get', '/reports')).body.reports).toHaveLength(16);
});
