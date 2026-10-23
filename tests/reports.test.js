const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

test('reports: every report answers with the right numbers', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING', 'FOLDING', 'PACKING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [100, 100, 100, 100] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const lot2 = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 500, pieces: 1 })).body;
  await api('post', `/grey-lots/${lot2.id}/approve`);
  // SO card: thaans 1-2 of lot 1; thaan 3 goes back as fabric return; thaan 4 and lot 2 stay in grey
  const so = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const ret = (await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [3] }] })).body;

  // grey parties: came 700, SO card 200, fabric return 100, in store 400 (thaan 4 + lot 2), SO card not sent 200 + return in Folding 100
  let r = (await api('get', '/reports/grey/parties')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ party: 'AZ', lots: 2, inwardMeters: 900, soCardMeters: 200, fabricReturnMeters: 100, inStoreMeters: 600, notSentMeters: 200, inProcessMeters: 100 });
  r = (await api('get', '/reports/cloth-now?groupBy=party_department')).body;
  expect(r.sections[0].totals.meters).toBe(900);

  // Dyeing with a chemical
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI', lines: [{ itemId: red.id, qty: 10, rate: 100 }], approve: true });
  await api('put', '/stores/chemical/department-access/DYEING', { add: [red.id] });
  const fd = (await api('get', '/jobs/form-data')).body;
  const dye = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.filter((x) => x.soCard.id === so.id).map((x) => ({ soCardLotId: x.soCardLotId })) })).body;
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'PROCESSING' });
  const cr = (await api('post', '/departments/DYEING/chemical-requests', { jobId: dye.id, lines: [{ itemId: red.id, qty: 2 }] })).body;
  await api('post', `/stores/chemical/requests/${cr.id}/accept`);
  await api('post', `/stores/chemical/requests/${cr.id}/send`);
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });

  r = (await api('get', '/reports/chemicals/usage')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ department: 'Dyeing', jobNo: dye.jobNo, soNo: so.cardNo, chemical: 'RED', qty: 2, amount: 200, meters: 200, thaans: 2 });
  expect((await api('get', '/reports/chemicals/usage?groupBy=chemical')).body.sections[0].totals.amount).toBe(200);
  expect((await api('get', '/reports/chemicals/stock')).body.sections[0].totals).toMatchObject({ qty: 8, value: 800 });
  expect((await api('get', '/reports/chemicals/purchases')).body.sections[0].totals.amount).toBe(1000);

  r = (await api('get', '/reports/departments/summary')).body;
  expect(r.sections[0].rows.find((x) => x.department === 'Dyeing')).toMatchObject({ jobs: 1, soCards: 1, lots: 1, thaans: 2, meters: 200, doneMeters: 200, chemicalCost: 200 });
  r = (await api('get', '/reports/departments/DYEING/jobs')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ operatorName: 'Aslam', lots: String(lot.lotNo), meters: 200, chemicalCost: 200, costPerMeter: 1 });
  r = (await api('get', '/reports/operators')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ department: 'Dyeing', operator: 'Aslam', jobs: 1, meters: 200, chemicalCost: 200 });

  // to Folding, graded, to Packing
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: form.rows.map((x) => ({ jobItemId: x.jobItemId })) })).body;
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const url = `/departments/FOLDING/folding/${fold.id}/${so.id}`;
  const row = (await api('get', url)).body;
  await api('put', `${url}/grades`, { lines: row.lots[0].lines.map((l) => ({ greyLotId: lot.id, thaanId: l.thaanId, a: 90, b: 5 })) });
  await api('post', `${url}/send-packing`, { keepRemaining: false });
  r = (await api('get', '/reports/folding')).body;
  const fr = r.sections[0].rows.find((x) => x.soNo === so.cardNo);
  expect(fr).toMatchObject({ fromDepartment: 'Dyeing', receivedMeters: 200, aMeters: 180, bMeters: 10, diff: -10, sentToPacking: 190, leftInFolding: 0, thaans: 2, chemicalCost: 200 });

  // fabric return goes Folding -> Packing as it is
  const fi = (await api('get', '/departments/FOLDING/incoming')).body.data.find((j) => j.soNos.includes(ret.cardNo));
  await api('post', `/departments/FOLDING/jobs/${fi.id}/accept`);
  await api('post', `/departments/FOLDING/folding/${fi.id}/${ret.id}/send-packing`, {});
  for (const j of (await api('get', '/departments/PACKING/incoming')).body.data) await api('post', `/departments/PACKING/jobs/${j.id}/accept`);
  const pf = (await api('get', `/departments/PACKING/packing/so-cards/${so.id}/form`)).body;
  const pl = (await api('post', '/departments/PACKING/packing-lists', { soCardId: so.id, rateA: 10, lines: pf.lots[0].thaans.flatMap((t) => [{ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: 90 }, { greyLotId: lot.id, thaanId: t.thaanId, grade: 'B', meters: 5 }]) })).body;
  await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'Akram', vehicleNo: 'LEA-1', destination: 'Lahore' });

  r = (await api('get', '/reports/packing-lists')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ listNo: 1, thaans: 2, aMeters: 180, bMeters: 10, meters: 190, amount: 1800, gatePassNo: 1 });
  expect((await api('get', '/reports/packing-lists?view=lines')).body.sections[0].totals.meters).toBe(190);
  r = (await api('get', '/reports/gate-passes')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ gatePassNo: 1, driverName: 'Akram', vehicleNo: 'LEA-1', thaans: 2 });

  // parties now: 200 + 100 reached Packing, 190 on lists, 190 gone with a gate pass
  r = (await api('get', '/reports/grey/parties')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ inStoreMeters: 600, atPackingMeters: 290, packedMeters: 190, dispatchedMeters: 190, inProcessMeters: 0, notSentMeters: 0 });
  r = (await api('get', '/reports/grey/lots?status=in_store')).body;
  expect(r.sections[0].rows.map((x) => x.inStoreMeters).sort()).toEqual([100, 500]);

  // SO card reports
  r = (await api('get', '/reports/so-cards')).body;
  expect(r.sections[0].rows.find((x) => x.soNo === so.cardNo)).toMatchObject({ lotCount: 1, thaans: 2, meters: 200, atPackingMeters: 190, chemicalCost: 200, wentTo: 'Dyeing, Folding, Packing' });
  expect((await api('get', '/reports/so-cards?isGreyReturn=true')).body.total).toBe(1);
  r = (await api('get', '/reports/so-cards/movement')).body;
  expect(r.sections[0].rows.map((x) => x.department).sort()).toEqual(['Dyeing', 'Folding', 'Folding', 'Packing', 'Packing']);
  r = (await api('get', `/reports/so-cards/${so.id}`)).body;
  expect(r.header).toMatchObject({ soNo: so.cardNo, party: 'AZ', chemicalCost: 200 });
  expect(r.sections.map((x) => x.key)).toEqual(['lots', 'path', 'chemicals', 'now', 'packing']);
  expect(r.sections[1].rows.map((x) => x.department)).toEqual(['Dyeing', 'Folding', 'Packing']);
  expect(r.sections[0].rows[0].thaanNos).toBe('1, 2');
  expect(r.sections[4].rows[0]).toMatchObject({ listNo: 1, gatePassNo: 1, vehicleNo: 'LEA-1' });

  // export returns every row; a department person only sees his departments
  expect((await api('get', '/reports/so-cards?export=true&limit=1')).body.export).toBe(true);
  const clerk = await makeUser({ userType: 'USER', companyId: company.id });
  const cauth = { Authorization: `Bearer ${(await loginAs(clerk)).accessToken}` };
  expect((await request(app).get('/api/v1/reports/grey/parties').set(cauth)).status).toBe(403);
});
