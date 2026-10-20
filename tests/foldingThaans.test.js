const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

async function setup(lotBody, cardLots) {
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
  const lots = [];
  for (const b of lotBody) {
    const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, ...b })).body;
    await api('post', `/grey-lots/${lot.id}/approve`);
    lots.push(lot);
  }
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: cardLots(lots) })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const dye = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  await api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: form.rows.map((r) => ({ jobItemId: r.jobItemId })) })).body;
  return { api, card, lots, fold, dye };
}

test('folding v3: lot-wise thaans split into A / B / CP, gain / loss, send graded to packing, rest stays', async () => {
  const { api, card, lots, fold } = await setup(
    [{ thaans: [2000, 1000] }, { inwardMeters: 500, pieces: 1 }],
    (l) => [{ greyLotId: l[0].id, thaanNos: [1, 2] }, { greyLotId: l[1].id, meters: 500 }],
  );
  const url = `/departments/FOLDING/folding/${fold.id}/${card.id}`;
  let row = (await api('get', url)).body;
  expect(row.lots).toHaveLength(2);
  expect(row.lots[0]).toMatchObject({ lotNo: lots[0].lotNo, hasThaans: true, received: 3000 });
  expect(row.lots[0].lines.map((l) => l.label)).toEqual(['Thaan 1', 'Thaan 2']);
  expect(row.lots[1]).toMatchObject({ hasThaans: false, received: 500, lines: [{ label: 'Whole lot', received: 500 }] });
  const [t1, t2] = row.lots[0].lines;
  expect((await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: t1.thaanId, a: 1 }] })).body.error.code).toBe('NOT_ACCEPTED');
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);

  // thaan 1: 2000 m -> 1500 A + 300 B + 150 CP (50 m shrank); lot 2 grew: 510 m
  row = (await api('put', `${url}/grades`, { pageNo: '7', lines: [
    { greyLotId: lots[0].id, thaanId: t1.thaanId, a: 1500, b: 300, cp: 150 },
    { greyLotId: lots[1].id, thaanId: null, a: 510 },
  ] })).body;
  expect(row.lots[0].lines[0]).toMatchObject({ a: 1500, b: 300, cp: 150, folded: 1950, diff: 0, notGraded: 50 });
  expect(row.lots[1].lines[0]).toMatchObject({ folded: 510, diff: 10, notGraded: 0 });
  expect(row.totals).toMatchObject({ received: 3500, a: 2010, b: 300, cp: 150, folded: 2460, diff: 10, inFolding: 2460, notGraded: 1050 });
  expect(row.leftInFolding).toBe(3510);
  expect(row.pageNo).toBe('7');

  // send what is graded; thaan 2 is still here
  let r = (await api('post', `${url}/send-packing`, { keepRemaining: true })).body;
  expect(r.packingJob.totalMeters).toBe(2460);
  row = r.row;
  expect(row.totals).toMatchObject({ sent: 2460, inFolding: 0, notGraded: 1050 });
  expect(row.leftInFolding).toBe(1050);
  expect((await api('get', '/departments/FOLDING/folding?tab=open')).body.total).toBe(1);

  // thaan 2 later; then nothing more will come: close the row
  await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: t2.thaanId, a: 980 }] });
  r = (await api('post', `${url}/send-packing`, { keepRemaining: false, closeNote: 'shrinkage' })).body;
  expect(r.packingJob.totalMeters).toBe(980);
  expect(r.row).toMatchObject({ isClosed: true, leftInFolding: 0, closeNote: 'shrinkage', canGrade: false });
  expect((await api('get', '/departments/FOLDING/folding?tab=open')).body.total).toBe(0);
  expect((await api('post', `${url}/send-packing`, {})).body.error.code).toBe('NOTHING_TO_SEND');

  // packing gets both jobs; its form suggests lines per thaan and category
  const inc = (await api('get', '/departments/PACKING/incoming')).body;
  expect(inc.total).toBe(2);
  for (const j of inc.data) await api('post', `/departments/PACKING/jobs/${j.id}/accept`);
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.lots[0].thaans[0].suggestedLines).toEqual([{ grade: 'A', gradeText: 'A', meters: 1500 }, { grade: 'B', gradeText: 'B', meters: 300 }, { grade: 'CP', gradeText: 'Cut Piece', meters: 150 }]);
  expect(f.lots[1].thaans[0]).toMatchObject({ thaanId: null, folding: { a: 510 } });
  const pl = (await api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: [
    { greyLotId: lots[0].id, thaanId: t1.thaanId, grade: 'A', meters: 1500 },
    { greyLotId: lots[0].id, thaanId: t1.thaanId, grade: 'B', meters: 300 },
  ] })).body;
  expect(pl.summary.total).toMatchObject({ thaans: 2, meters: 1800, amount: 15000 });
});

test('folding v3: cloth can go back to a department for RE-WORK', async () => {
  const { api, card, fold } = await setup([{ thaans: [100] }], (l) => [{ greyLotId: l[0].id, thaanNos: [1] }]);
  await api('put', `/departments/FOLDING/jobs/${fold.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/FOLDING/jobs/${fold.id}/operator`, { operatorName: 'Bilal', processDate: '2026-10-19' });
  const form = (await api('get', '/departments/FOLDING/send-form')).body;
  const re = (await api('post', '/departments/FOLDING/send', { toDepartmentCode: 'DYEING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  expect(re).toMatchObject({ isRework: true });
  const row = (await api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
  expect(row).toMatchObject({ sentForRework: true, sentBackTo: 'Dyeing', canGrade: false });
});

// owner 2026-10-19: lot of 5000 m, 4700 sent (A 4500, B 200), 300 kept in Folding
async function fiveThousand() {
  const ctx = await setup([{ inwardMeters: 5000, pieces: 1 }], (l) => [{ greyLotId: l[0].id, meters: 5000 }]);
  const { api, card, lots, fold } = ctx;
  const url = `/departments/FOLDING/folding/${fold.id}/${card.id}`;
  await api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
  let row = (await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: null, a: 4500, b: 200 }] })).body;
  expect(row.lots[0].lines[0]).toMatchObject({ folded: 4700, diff: 0, notGraded: 300, remaining: 5000 });
  const r = (await api('post', `${url}/send-packing`, { keepRemaining: true })).body;
  expect(r.packingJob.totalMeters).toBe(4700);
  row = r.row;
  expect(row.lots[0].lines[0]).toMatchObject({ remaining: 300, inFolding: { total: 0 }, sent: { total: 4700 } });
  expect(row).toMatchObject({ leftInFolding: 300, canSendPacking: false, canGrade: true });
  return { ...ctx, url };
}

test('folding 5000 m: the 300 m kept in Folding is graded and sent alone (not 5000 again)', async () => {
  const { api, card, lots, url } = await fiveThousand();
  // grade only this batch: 250 A + 40 B (10 m shrank)
  let row = (await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: null, a: 250, b: 40 }] })).body;
  expect(row.lots[0].lines[0]).toMatchObject({ a: 4750, b: 240, folded: 4990, inFolding: { a: 250, b: 40, total: 290 }, notGraded: 10 });
  const r = (await api('post', `${url}/send-packing`, { keepRemaining: false, closeNote: 'shrinkage' })).body;
  expect(r.packingJob.totalMeters).toBe(290);
  expect(r.row).toMatchObject({ isClosed: true, leftInFolding: 0, totals: { sent: 4990, diff: -10 } });
  expect((await api('post', `${url}/send-packing`, {})).body.error.code).toBe('NOTHING_TO_SEND');

  const inc = (await api('get', '/departments/PACKING/incoming')).body;
  expect(inc.data.map((j) => Number(j.totalMeters)).sort((a, b) => a - b)).toEqual([290, 4700]);
  for (const j of inc.data) await api('post', `/departments/PACKING/jobs/${j.id}/accept`);
  const f = (await api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.lots[0].thaans[0].folding).toMatchObject({ a: 4750, b: 240, cp: 0 });
  expect(f.cloth).toMatchObject({ soCardMeters: 5000, fromFoldingMeters: 4990, receivedMeters: 4990 });
});

test('folding 5000 m: all sent, keep nothing (300 m lost in shrinkage)', async () => {
  const { api, url } = await fiveThousand();
  const row = (await api('put', `${url}/close`, { isClosed: true, closeNote: 'shrinkage' })).body;
  expect(row).toMatchObject({ isClosed: true, leftInFolding: 0, totals: { diff: -300, sent: 4700 } });
  expect((await api('get', '/departments/FOLDING/folding?tab=open')).body.total).toBe(0);
});

test('folding 5000 m: 300 m kept, sent in two more batches', async () => {
  const { api, lots, url } = await fiveThousand();
  await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: null, a: 100 }] });
  expect((await api('post', `${url}/send-packing`, { keepRemaining: true })).body.packingJob.totalMeters).toBe(100);
  await api('put', `${url}/grades`, { lines: [{ greyLotId: lots[0].id, thaanId: null, b: 200 }] });
  const r = (await api('post', `${url}/send-packing`, { keepRemaining: true })).body;
  expect(r.packingJob.totalMeters).toBe(200);
  expect(r.row).toMatchObject({ leftInFolding: 0, totals: { a: 4600, b: 400, sent: 5000, diff: 0 } });
});
