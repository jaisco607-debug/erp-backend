const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

test('packing: only from folding, only accept; packing list per SO card thaan-wise with rates', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [100, 120, 80] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  expect((await api('post', '/jobs', { departmentId: s.PACKING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body.error.code).toBe('PACKING_ONLY_FROM_FOLDING');
  const dye = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' });
  let form = (await api('get', '/departments/DYEING/send-form')).body;
  expect((await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body.error.code).toBe('OPERATOR_REQUIRED');
  await api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  expect((await api('post', '/departments/DYEING/send', { toDepartmentCode: 'PACKING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body.error.code).toBe('PACKING_ONLY_FROM_FOLDING');
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  // folding sees where the cloth came from
  const inc = (await api('get', '/departments/FOLDING/incoming')).body.data[0];
  expect(inc).toMatchObject({ fromOperatorName: 'Aslam', fromProcessDate: '2026-10-18' });
  expect(inc.trail.map((t) => t.department)).toEqual(['Dyeing', 'Folding']);
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  const frow = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  const ls = frow.lots[0].lines;
  await api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [
    { greyLotId: lot.id, thaanId: ls[0].thaanId, a: 100 }, { greyLotId: lot.id, thaanId: ls[1].thaanId, b: 120 }, { greyLotId: lot.id, thaanId: ls[2].thaanId, a: 80 },
  ] });
  const pack = (await api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false })).body.packingJob;
  const packJob = (await api('get', `/departments/PACKING/jobs/${pack.id}`)).body;
  expect(packJob.canReject).toBe(false);

  // nothing accepted yet
  let cards = (await api('get', '/departments/PACKING/packing/so-cards')).body;
  expect(cards.data[0]).toMatchObject({ soCard: { cardNo: card.cardNo }, quality: 'PC TWILL', cloth: { soCardMeters: 300, fromFoldingMeters: 300, receivedMeters: 0 }, folding: { a: 180, b: 120, total: 300 } });
  expect((await api('post', `/departments/PACKING/jobs/${pack.id}/reject`, { reason: 'x' })).body.error.code).toBe('PACKING_ACCEPT_ONLY');
  await api('post', `/departments/PACKING/jobs/${pack.id}/accept`);
  expect((await api('put', `/departments/PACKING/jobs/${pack.id}/status`, { status: 'COMPLETE' })).body.error.code).toBe('PACKING_ACCEPT_ONLY');
  expect((await api('get', '/departments/PACKING/send-form')).body.rows || []).toHaveLength(0);

  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.lots[0]).toMatchObject({ lotNo: lot.lotNo, thaanCount: 3, meters: 300 });
  expect(f.lots[0].thaans.map((t) => t.suggestedLines[0].grade)).toEqual(['A', 'B', 'A']);
  const [t1, t2, t3] = f.lots[0].thaans;
  let pl = (await api('post', '/departments/PACKING/packing-lists', {
    soCardId: card.id, description: 'MEN SHIRT', rateA: 50, rateB: 25,
    lines: [{ greyLotId: lot.id, thaanId: t1.thaanId, grade: 'A', meters: 99 }, { greyLotId: lot.id, thaanId: t2.thaanId, grade: 'B', meters: 120 }],
  })).body;
  expect(pl).toMatchObject({ listNo: 1, status: 'DRAFT', summary: { A: { thaans: 1, meters: 99, amount: 4950 }, B: { meters: 120, amount: 3000 }, total: { thaans: 2, meters: 219, amount: 7950 } } });
  expect(pl.lots[0].thaans[0]).toMatchObject({ thaanNo: 1, gradeText: 'A', rate: 50, amount: 4950 });
  const bad = (await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines: [{ greyLotId: lot.id, thaanId: t1.thaanId, grade: 'A', meters: 99 }] })).body;
  expect(bad.error.code).toBe('THAAN_ALREADY_PACKED');
  pl = (await api('put', `/departments/PACKING/packing-lists/${pl.id}`, { lines: [...pl.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: t.grade, meters: t.meters })), { greyLotId: lot.id, thaanId: t3.thaanId, grade: 'A', meters: 80 }] })).body;
  expect(pl.summary.total).toMatchObject({ thaans: 3, meters: 299, amount: 11950 });
  expect(pl.cloth).toMatchObject({ receivedMeters: 300, packedMeters: 299, leftToPack: 1 });
  pl = (await api('post', `/departments/PACKING/packing-lists/${pl.id}/final`)).body;
  expect(pl.status).toBe('FINAL');
  expect((await api('put', `/departments/PACKING/packing-lists/${pl.id}`, { rateA: 1 })).body.error.code).toBe('LIST_FINAL');
  expect((await api('get', '/departments/PACKING/packing-lists')).body.total).toBe(1);

  // gate pass (owner 2026-10-19): pre-filled form, then saved
  const gp0 = (await api('get', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`)).body;
  expect(gp0).toMatchObject({ saved: false, gatePassNo: null, customer: { name: 'AZ' }, totalThaans: 3, copies: ['Packing', 'Company guard', 'Driver'] });
  expect(gp0.lots).toEqual([{ lotNo: lot.lotNo, thaanNos: [1, 2, 3], thaanCount: 3 }]);
  expect(gp0.operatorName).toBeTruthy();
  const gp = (await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'Akram', vehicleNo: 'LEA-1234', destination: 'Lahore', passDate: '2030-01-01' })).body;
  expect(gp).toMatchObject({ saved: true, gatePassNo: 1, driverName: 'Akram', vehicleNo: 'LEA-1234', destination: 'Lahore', passDate: '2030-01-01' });
  const gp2 = (await api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { vehicleNo: 'LEB-9' })).body;
  expect(gp2).toMatchObject({ gatePassNo: 1, vehicleNo: 'LEB-9', driverName: 'Akram' });
  expect((await api('get', '/departments/PACKING/gate-passes?search=lahore')).body.total).toBe(1);
  expect((await api('get', '/departments/PACKING/gate-passes?search=nowhere')).body.total).toBe(0);
});
