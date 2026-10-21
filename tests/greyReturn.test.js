const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

// owner 2026-10-19: 50 thaan came, 20 go back unprocessed (Grey Store -> Folding -> Packing -> gate pass)
test('fabric return grey: thaans go straight to Folding, only to Packing, tagged, packing list and gate pass', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [100, 100, 100, 100, 100] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  // the party wants thaans 1-3 processed
  await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3] }] });

  // thaans 4 and 5 go back: fabric return
  const bad = await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [3, 4] }] });
  expect(bad.body.error.code).toBe('THAAN_NOT_IN_STOCK');
  const card = (await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [4, 5] }], sentThrough: 'Akram' })).body;
  expect(card).toMatchObject({ isGreyReturn: true, tagText: 'Fabric return grey (not processed)', status: 'SENT', totalMeters: 200 });
  expect((await api('get', `/grey-lots/${lot.id}`)).body.balanceMeters).toBe(0);

  const inc = (await api('get', '/departments/FOLDING/incoming')).body;
  const job = inc.data.find((j) => j.soNos.includes(card.cardNo));
  expect(job).toMatchObject({ isGreyReturn: true, totalMeters: 200 });
  await api('post', `/departments/FOLDING/jobs/${job.id}/accept`);
  const url = `/departments/FOLDING/folding/${job.id}/${card.id}`;
  let row = (await api('get', url)).body;
  expect(row).toMatchObject({ isGreyReturn: true, canGrade: false, canSendPacking: true, leftInFolding: 200 });
  expect((await api('put', `${url}/grades`, { lines: [{ greyLotId: lot.id, thaanId: row.lots[0].lines[0].thaanId, a: 100 }] })).body.error.code).toBe('GREY_RETURN_NO_GRADING');

  // Folding cannot send it to a department
  await api('put', `/departments/FOLDING/jobs/${job.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/FOLDING/jobs/${job.id}/operator`, { operatorName: 'Bilal', processDate: '2026-10-19' });
  const form = (await api('get', '/departments/FOLDING/send-form')).body;
  const rows = form.rows.filter((r) => r.soCard.id === card.id);
  expect(rows[0].soCard.isGreyReturn).toBe(true);
  expect((await api('post', '/departments/FOLDING/send', { toDepartmentCode: 'DYEING', items: rows.map((r) => ({ jobItemId: r.jobItemId })) })).body.error.code).toBe('GREY_RETURN_ONLY_PACKING');

  // only Packing
  const sent = (await api('post', `${url}/send-packing`, {})).body;
  expect(sent.packingJob.totalMeters).toBe(200);
  expect(sent.row).toMatchObject({ leftInFolding: 0, canSendPacking: false });
  const pinc = (await api('get', '/departments/PACKING/incoming')).body;
  expect(pinc.data[0].isGreyReturn).toBe(true);
  await api('post', `/departments/PACKING/jobs/${sent.packingJob.id}/accept`);
  const ps = (await api('get', '/departments/PACKING/packing/so-cards')).body;
  expect(ps.data[0]).toMatchObject({ isGreyReturn: true, tagText: 'Fabric return grey (not processed)' });
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.isGreyReturn).toBe(true);
  const lines = f.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters }));
  let pl = (await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines })).body;
  expect(pl).toMatchObject({ isGreyReturn: true, summary: { total: { thaans: 2, meters: 200 } } });
  await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  const gp = (await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'Akram', vehicleNo: 'LEA-1', destination: 'Faisalabad' })).body;
  expect(gp).toMatchObject({ isGreyReturn: true, tagText: 'Fabric return grey (not processed)', totalThaans: 2, customer: { name: 'AZ' } });
  expect(gp.lots).toEqual([{ lotNo: lot.lotNo, thaanNos: [4, 5], thaanCount: 2 }]);
});

// owner 2026-10-20: the Fabric Returns screen (Production > Outwards) needs only the Grey Store service.
// This company has no SO Card service: it must still pick lots, make the return and see it with its packing list and gate pass.
test('fabric return screen works with Grey Store only (no SO Card service), and shows packing list and gate pass', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'FOLDING', 'PACKING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [100, 100, 100] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);

  // the SO card service is really missing
  expect((await api('get', '/so-cards')).status).toBe(403);
  expect((await api('get', '/so-cards/available-lots')).status).toBe(403);

  // picker, with the Grey Store service only
  const picker = await api('get', `/grey-lots/fabric-return/lots?customerId=${cu.id}`);
  expect(picker.status).toBe(200);
  expect(picker.body.data[0]).toMatchObject({ lotNo: lot.lotNo, isThaanWise: true });
  expect(picker.body.data[0].thaans.map((t) => t.thaanNo)).toEqual([1, 2, 3]);
  expect((await api('get', '/grey-lots/fabric-returns')).body).toMatchObject({ total: 0, data: [] });

  const card = (await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [2, 3] }], sentThrough: 'Akram' })).body;
  expect(card).toMatchObject({ isGreyReturn: true, totalMeters: 200 });

  let list = (await api('get', '/grey-lots/fabric-returns')).body;
  expect(list).toMatchObject({ total: 1, page: 1 });
  expect(list.data[0]).toMatchObject({
    id: card.id, cardNo: card.cardNo, isGreyReturn: true, totalMeters: 200, customer: { name: 'AZ' },
    stage: 'IN_FOLDING', stageText: 'Folding (In-Way)', packingLists: [], gatePassCount: 0,
  });
  expect(list.data[0].lots[0]).toMatchObject({ lotNo: lot.lotNo, thaanNos: [2, 3] });
  expect((await api('get', `/grey-lots/fabric-returns/${card.id}`)).body).toMatchObject({ cardNo: card.cardNo, stage: 'IN_FOLDING' });
  expect((await api('get', '/grey-lots/fabric-returns/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  expect((await api('get', `/grey-lots/fabric-returns?search=${card.cardNo}`)).body.total).toBe(1);
  expect((await api('get', '/grey-lots/fabric-returns?search=999')).body.total).toBe(0);

  // Folding -> Packing -> packing list -> gate pass (done by the departments, seen here)
  const job = (await api('get', '/departments/FOLDING/incoming')).body.data[0];
  await api('post', `/departments/FOLDING/jobs/${job.id}/accept`);
  const sent = (await api('post', `/departments/FOLDING/folding/${job.id}/${card.id}/send-packing`, {})).body;
  expect((await api('get', `/grey-lots/fabric-returns/${card.id}`)).body).toMatchObject({ stage: 'IN_PACKING', stageText: 'Packing (In-Way)' });
  await api('post', `/departments/PACKING/jobs/${sent.packingJob.id}/accept`);
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  const pl = (await api('post', '/departments/PACKING/packing-lists', {
    soCardId: card.id, lines: f.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters })),
  })).body;
  list = (await api('get', '/grey-lots/fabric-returns')).body;
  expect(list.data[0]).toMatchObject({ stage: 'PACKING_LIST', packingLists: [{ listNo: pl.listNo, status: 'DRAFT', thaans: 2, meters: 200, gatePass: null }] });
  await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'Akram', vehicleNo: 'LEA-1', destination: 'Faisalabad', passDate: '2030-01-01' });
  list = (await api('get', '/grey-lots/fabric-returns')).body;
  expect(list.data[0]).toMatchObject({ stage: 'DISPATCHED', gatePassCount: 1 });
  expect(list.data[0].packingLists[0]).toMatchObject({ status: 'FINAL', gatePass: { gatePassNo: 1, vehicleNo: 'LEA-1', driverName: 'Akram', destination: 'Faisalabad' } });
  expect(list.data[0].stageText).toBe('Dispatched (gate pass 1)');

  // a user with VIEW on the Grey Store can see the screen; a user without it cannot
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  const vauth = { Authorization: `Bearer ${(await loginAs(viewer)).accessToken}` };
  expect((await request(app).get('/api/v1/grey-lots/fabric-returns').set(vauth)).status).toBe(403);
  await api('put', `/users/${viewer.id}/services`, { services: [{ serviceId: s.GREY_STORE.id, access: 'VIEW' }] });
  expect((await request(app).get('/api/v1/grey-lots/fabric-returns').set(vauth)).status).toBe(200);
  expect((await request(app).post('/api/v1/grey-lots/fabric-return').set(vauth).send({ lots: [{ greyLotId: lot.id, thaanNos: [1] }] })).status).toBe(403);
});

// owner 2026-10-20: one lot of 10 thaans. The party wants 7 processed and 3 back.
// The 3 go straight to Folding from the Grey Store; the 7 stay in the Grey Store and get a normal SO card.
test('10 thaans: 3 go back as a fabric return, the other 7 get a normal SO card that goes through the departments', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING', 'REPORT_SO_CARDS', 'REPORT_GREY', 'REPORT_OVERVIEW']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: Array(10).fill(100) })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);

  // the fabric return has its own numbers: the first one will be FR-1 (the SO cards still start at 1)
  expect((await api('get', '/grey-lots/fabric-return/lots')).body).toMatchObject({ nextCardNo: 1, nextCardLabel: 'FR-1' });

  // 3 thaans back: Grey Store -> Folding
  const ret = (await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [8, 9, 10] }] })).body;
  expect(ret).toMatchObject({ isGreyReturn: true, totalMeters: 300, status: 'SENT', cardNo: 1, cardLabel: 'FR-1' });
  expect((await api('get', `/grey-lots/${lot.id}`)).body).toMatchObject({ balanceMeters: 700 });

  // the SO card desk offers exactly the 7 that are left
  const avail = (await api('get', '/so-cards/available-lots')).body.data.find((l) => l.id === lot.id);
  expect(avail.thaans.map((t) => t.thaanNo)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(avail.balanceMeters).toBe(700);
  expect((await api('post', '/so-cards', { cardDate: '2026-10-20', lots: [{ greyLotId: lot.id, thaanNos: [7, 8] }] })).body.error.code).toBe('THAAN_NOT_IN_STOCK');

  // a normal SO card for the 7, sent to Dyeing as usual
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-20', lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4, 5, 6, 7] }], departmentId: s.DYEING.id })).body;
  // the first real SO card is SO# 1: the fabric return did not take a number
  expect(card).toMatchObject({ isGreyReturn: false, tagText: null, totalMeters: 700, status: 'SENT', cardNo: 1, cardLabel: '1' });
  expect((await api('get', `/grey-lots/${lot.id}`)).body.balanceMeters).toBe(0);
  const dyeing = (await api('get', '/departments/DYEING/incoming')).body.data;
  expect(dyeing).toHaveLength(1);
  expect(dyeing[0]).toMatchObject({ isGreyReturn: false, totalMeters: 700, soNos: [1], soLabels: ['1'] });
  expect(dyeing[0].items[0].soCard).toMatchObject({ cardNo: 1, cardLabel: '1' });

  // Folding received only the fabric return, never the Dyeing cloth
  const folding = (await api('get', '/departments/FOLDING/incoming')).body.data;
  expect(folding).toHaveLength(1);
  expect(folding[0]).toMatchObject({ isGreyReturn: true, totalMeters: 300, soNos: [1], soLabels: ['FR-1'] });
  expect(folding[0].items[0].soCard).toMatchObject({ cardNo: 1, cardLabel: 'FR-1', isGreyReturn: true });

  // the SO Card section never shows the fabric return, without any filter from the frontend
  expect((await api('get', '/so-cards')).body.data.map((c) => c.cardLabel)).toEqual(['1']);
  expect((await api('get', '/so-cards?isGreyReturn=false')).body.data.map((c) => c.cardLabel)).toEqual(['1']);
  expect((await api('get', `/so-cards/incoming?departmentId=${s.FOLDING.id}`)).body.data).toEqual([]);
  expect((await api('get', `/so-cards/incoming?departmentId=${s.DYEING.id}`)).body.data.map((c) => c.cardLabel)).toEqual(['1']);
  // the SO card desk's sent jobs: only the Dyeing job
  const sentJobs = (await api('get', '/jobs?side=out')).body.data;
  expect(sentJobs).toHaveLength(1);
  expect(sentJobs[0]).toMatchObject({ isGreyReturn: false, totalMeters: 700 });
  // only the Grey Store screen lists it
  expect((await api('get', '/grey-lots/fabric-returns')).body.data.map((c) => c.cardLabel)).toEqual(['FR-1']);
  expect((await api('get', '/so-cards?isGreyReturn=true')).body.data.map((c) => c.cardLabel)).toEqual(['FR-1']);

  // the lot: 700 m on SO cards, 300 m fabric return (not on SO cards), nothing given back the other way
  const lotNow = (await api('get', `/grey-lots/${lot.id}`)).body;
  expect(lotNow).toMatchObject({ soCardMeters: 700, fabricReturnMeters: 300, returnedMeters: 0, balanceMeters: 0 });
  const lotList = (await api('get', '/grey-lots')).body.data.find((l) => l.id === lot.id);
  expect(lotList).toMatchObject({ soCardMeters: 700, fabricReturnMeters: 300 });

  // reports: SO card reports count only the SO card; the fabric return is shown separately
  const rep = await api('get', '/reports/so-cards');
  expect(rep.status).toBe(200);
  expect(rep.body.rows.map((r) => r.cardLabel)).toEqual(['1']);
  expect((await api('get', '/reports/so-cards?isGreyReturn=true')).body.rows.map((r) => r.cardLabel)).toEqual(['FR-1']);
  expect((await api('get', '/reports/so-cards/lots')).body.rows.map((r) => r.cardLabel)).toEqual(['1']);
  const parties = (await api('get', '/reports/grey/parties')).body.rows[0];
  expect(parties).toMatchObject({ inwardMeters: 1000, soCardMeters: 700, greyReturnCardMeters: 300 });
  const lots = (await api('get', '/reports/grey/lots')).body.rows[0];
  expect(lots).toMatchObject({ soCardMeters: 700, fabricReturnMeters: 300, soCards: String(card.cardNo) });
  const ov = (await api('get', '/reports/overview')).body.summary;
  expect(ov.soCards.cards).toBe(1);
  expect(ov.grey).toMatchObject({ onCards: 700, fabricReturn: 300 });
  // the SO # column of the reports shows the label
  expect(rep.body.columns.find((c) => c.label === 'SO #')).toMatchObject({ key: 'cardLabel' });

  // a second lot: fabric return FR-2, and the next SO card is SO# 2 (two separate, gap-free series)
  const lot2 = (await api('post', '/grey-lots', { inwardDate: '2026-10-11', customerId: cu.id, qualityId: q.id, thaans: [50, 50] })).body;
  await api('post', `/grey-lots/${lot2.id}/approve`);
  const ret2 = (await api('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot2.id, thaanNos: [2] }] })).body;
  expect(ret2).toMatchObject({ cardNo: 2, cardLabel: 'FR-2' });
  const card2 = (await api('post', '/so-cards', { cardDate: '2026-10-20', lots: [{ greyLotId: lot2.id, thaanNos: [1] }] })).body;
  expect(card2).toMatchObject({ cardNo: 2, cardLabel: '2' });
  expect((await api('get', '/so-cards/form-data')).body).toMatchObject({ nextCardNo: 3 });
  expect((await api('get', '/so-cards')).body.data.map((c) => c.cardLabel)).toEqual(['2', '1']);
  expect((await api('get', '/grey-lots/fabric-returns')).body.data.map((c) => c.cardLabel)).toEqual(['FR-2', 'FR-1']);

  // search: "FR-1" / "fr1" finds only the fabric return, a bare number finds that number of the fabric returns
  expect((await api('get', '/grey-lots/fabric-returns?search=FR-1')).body.data.map((c) => c.cardLabel)).toEqual(['FR-1']);
  expect((await api('get', '/grey-lots/fabric-returns?search=fr2')).body.data.map((c) => c.cardLabel)).toEqual(['FR-2']);
  expect((await api('get', '/grey-lots/fabric-returns?search=2')).body.data.map((c) => c.cardLabel)).toEqual(['FR-2']);
  const fjobs = (await api('get', '/departments/FOLDING/incoming?search=FR-1')).body.data;
  expect(fjobs.map((j) => j.soLabels)).toEqual([['FR-1']]);
  expect((await api('get', '/departments/DYEING/incoming?search=FR-1')).body.data).toEqual([]);
  expect((await api('get', '/departments/DYEING/incoming?search=1')).body.data.map((j) => j.soLabels)).toEqual([['1']]);
});
