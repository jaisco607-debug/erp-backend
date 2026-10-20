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
