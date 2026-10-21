// AUDIT: concurrency. Many people press the same button at the same moment; the numbers must stay exact.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

const statuses = (results) => results.map((r) => r.status).sort();
const count = (results, status) => results.filter((r) => r.status === status).length;

test('8 SO cards at once from one 100 m lot: exactly 3 of 30 m succeed, the rest are refused, no meter is created or lost', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const results = await Promise.all(Array.from({ length: 8 }, () => w.api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 30 }] })));
  expect(count(results, 201)).toBe(3);
  expect(results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'NOT_ENOUGH_METERS')).toBe(true);
  const nos = results.filter((r) => r.status === 201).map((r) => r.body.cardNo).sort();
  expect(nos).toEqual([1, 2, 3]);
  expect((await w.ok('get', `/grey-lots/${lot.id}`)).balanceMeters).toBe(10);
  await expectClean();
});

test('the same thaan taken by 5 SO cards at once: one wins', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100] });
  const results = await Promise.all(Array.from({ length: 5 }, () => w.api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1] }] })));
  expect(count(results, 201)).toBe(1);
  await expectClean();
});

test('the same SO desk row sent 6 times at once: only what the card holds goes out', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const row = (await w.deskRows())[0];
  const results = await Promise.all(Array.from({ length: 6 }, () => w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: row.soCardLotId, meters: 60 }] })));
  expect(count(results, 201)).toBe(1);
  expect(card.totalMeters).toBe(100);
  const jobNos = results.filter((r) => r.status === 201).map((r) => r.body.jobNo);
  expect(jobNos).toEqual([1]);
  await expectClean();
});

test('one finished job sent on to 4 departments at once: only one gets the cloth', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'SINGEING');
  await w.accept('SINGEING', job);
  await w.complete('SINGEING', job);
  const row = (await w.ok('get', '/departments/SINGEING/send-form')).rows[0];
  const results = await Promise.all(['DYEING', 'DRYER', 'FINISHING', 'PRINTING'].map((to) => w.api('post', '/departments/SINGEING/send', { toDepartmentCode: to, items: [{ jobItemId: row.jobItemId }] })));
  expect(count(results, 201)).toBe(1);
  await expectClean();
});

test('the same purchase approved 4 times at once: stock goes up once, one IP number', async () => {
  const w = await world();
  const red = await w.chem('RED');
  const draft = await w.ok('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'V', lines: [{ itemId: red.id, qty: 10, rate: 10 }] }, 201);
  const results = await Promise.all(Array.from({ length: 4 }, () => w.api('post', `/stores/chemical/inwards/${draft.id}/approve`)));
  expect(count(results, 200)).toBe(1);
  expect(await w.stock(red)).toMatchObject({ stockQty: 10, stockValue: 100 });
  await expectClean();
});

test('20 purchases of one chemical at once: the stock is exactly their sum', async () => {
  const w = await world();
  const red = await w.chem('RED');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => w.api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'V', lines: [{ itemId: red.id, qty: 1.5, rate: 10 + i }], approve: true })));
  expect(count(results, 201)).toBe(20);
  const value = Array.from({ length: 20 }, (_, i) => 1.5 * (10 + i)).reduce((t, x) => t + x, 0);
  expect(await w.stock(red)).toMatchObject({ stockQty: 30, stockValue: value });
  const ips = results.map((r) => r.body.ipNo).sort((a, b) => a - b);
  expect(ips).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  await expectClean();
});

test('3 requests ask 4 kg each of 10 kg; the store sends all at once: two succeed, stock is 2 kg, never negative', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10);
  await w.give('DYEING', [red]);
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  const reqs = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await w.ok('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 4 }] }, 201);
    await w.ok('post', `/stores/chemical/requests/${r.id}/accept`);
    reqs.push(r);
  }
  const results = await Promise.all(reqs.map((r) => w.api('post', `/stores/chemical/requests/${r.id}/send`, {})));
  expect(count(results, 200)).toBe(2);
  expect(await w.stock(red)).toMatchObject({ stockQty: 2, stockValue: 20 });
  await expectClean();
});

test('the same request sent 3 times at once: stock goes out once', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10);
  await w.give('DYEING', [red]);
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  const r = await w.ok('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 4 }] }, 201);
  await w.ok('post', `/stores/chemical/requests/${r.id}/accept`);
  const results = await Promise.all(Array.from({ length: 3 }, () => w.api('post', `/stores/chemical/requests/${r.id}/send`, {})));
  expect(count(results, 200)).toBe(1);
  expect(await w.stock(red)).toMatchObject({ stockQty: 6, stockValue: 60 });
  await expectClean();
});

test('the same return received 3 times at once: stock comes back once', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10);
  await w.give('DYEING', [red]);
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 6 }]);
  const ret = await w.ok('post', '/departments/DYEING/chemical-returns', { requestId: sent.id, lines: [{ requestLineId: sent.lines[0].id, qty: 2 }] }, 201);
  const results = await Promise.all(Array.from({ length: 3 }, () => w.api('post', `/stores/chemical/returns/${ret.id}/receive`)));
  expect(count(results, 200)).toBe(1);
  expect(await w.stock(red)).toMatchObject({ stockQty: 6, stockValue: 60 });
  await expectClean();
});

test('5 stock adjustments (out 3 kg) at once on 10 kg: three succeed', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10);
  const results = await Promise.all(Array.from({ length: 5 }, () => w.api('post', '/stores/chemical/adjustments', { reason: 'LOST', lines: [{ itemId: red.id, mode: 'OUT', qty: 3 }] })));
  expect(count(results, 201)).toBe(3);
  expect(await w.stock(red)).toMatchObject({ stockQty: 1, stockValue: 10 });
  await expectClean();
});

test('10 lots, 10 SO cards and 10 jobs created at once get unique numbers', async () => {
  const w = await world();
  const cu = await w.customer();
  const q = await w.quality();
  const lots = await Promise.all(Array.from({ length: 10 }, () => w.api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 100, pieces: 1 })));
  expect(count(lots, 201)).toBe(10);
  expect(new Set(lots.map((r) => r.body.lotNo)).size).toBe(10);
  expect(new Set(lots.map((r) => r.body.typeNo)).size).toBe(10);
  await Promise.all(lots.map((l) => w.api('post', `/grey-lots/${l.body.id}/approve`)));
  const cards = await Promise.all(lots.map((l) => w.api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: l.body.id, meters: 100 }] })));
  expect(count(cards, 201)).toBe(10);
  expect(new Set(cards.map((r) => r.body.cardNo)).size).toBe(10);
  const rows = await w.deskRows();
  const jobs = await Promise.all(rows.map((r) => w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: r.soCardLotId }] })));
  expect(count(jobs, 201)).toBe(10);
  expect(new Set(jobs.map((r) => r.body.jobNo)).size).toBe(10);
  await expectClean();
});

test('one thaan put on 3 packing lists at once: one list gets it; the gate pass is saved 3 times at once: one pass', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100] });
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [1, 2] }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  await w.accept('FOLDING', fold);
  const url = `/departments/FOLDING/folding/${fold.id}/${card.id}`;
  const row = await w.ok('get', url);
  await w.ok('put', `${url}/grades`, { lines: row.lots[0].lines.map((l) => ({ greyLotId: row.lots[0].lotId, thaanId: l.thaanId, a: l.received })) });
  const pack = (await w.ok('post', `${url}/send-packing`, {}, 201)).packingJob;
  await w.accept('PACKING', pack);
  const form = await w.ok('get', `/departments/PACKING/packing/so-cards/${card.id}/form`);
  const t1 = form.lots[0].thaans[0];
  const body = { soCardId: card.id, rateA: 10, lines: [{ greyLotId: lot.id, thaanId: t1.thaanId, grade: 'A', meters: t1.meters }] };
  const lists = await Promise.all(Array.from({ length: 3 }, () => w.api('post', '/departments/PACKING/packing-lists', body)));
  expect(count(lists, 201)).toBe(1);
  const pl = lists.find((r) => r.status === 201).body;
  await w.ok('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  const gps = await Promise.all(Array.from({ length: 3 }, () => w.api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'D', vehicleNo: 'V-1' })));
  expect(count(gps, 200)).toBe(3);
  expect(new Set(gps.map((r) => r.body.gatePassNo)).size).toBe(1);
  expect((await w.ok('get', '/departments/PACKING/gate-passes')).total).toBe(1);
  await expectClean();
});
