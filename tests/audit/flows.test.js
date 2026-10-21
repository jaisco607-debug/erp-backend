// AUDIT: harder flows: several SO cards in one job (cost sharing), reject / undo / dispute paths.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

const sum = (xs) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;

test('one Dyeing job holds 3 SO cards of 3 parties: chemical cost is shared by meters and follows each card into Folding', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 33.33);
  await w.give('DYEING', [red]);
  const q = await w.quality();
  const cards = [];
  for (const [name, m] of [['AZ', 333], ['BB', 333], ['CC', 334]]) {
    const lot = await w.lot({ customer: await w.customer(name), quality: q, meters: m, pieces: 1 });
    cards.push(await w.card([{ greyLotId: lot.id, meters: m }]));
  }
  const rows = await w.deskRows();
  const job = await w.ok('post', '/jobs', { departmentId: w.s.DYEING.id, items: rows.map((r) => ({ soCardLotId: r.soCardLotId })) }, 201);
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 7.777 }]);
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  const list = (await w.ok('get', '/departments/FOLDING/folding')).data;
  expect(list).toHaveLength(3);
  // what Folding shows per card adds up to what the job paid, to the paisa (within 2 paisa of rounding)
  const perCard = list.map((r) => r.cost.totalCost);
  expect(Math.abs(sum(perCard) - sent.totalValue)).toBeLessThanOrEqual(0.02);
  // and it equals the store's own SO card cost screen
  for (const c of cards) {
    const store = await w.ok('get', `/stores/chemical/cost/so-cards/${c.id}`);
    const row = list.find((r) => r.soCard.id === c.id);
    expect(Math.abs(store.totalValue - row.cost.totalCost)).toBeLessThanOrEqual(0.011);
  }
  expect(fold.totalMeters).toBe(1000);
  await expectClean();
});

test('rejection paths: unanswered reject can be undone by the receiver unless the sender sent the cloth again; a disputed reject returns to the receiver', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 300, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  const j1 = await w.sendCard(card, 'SINGEING');
  await w.accept('SINGEING', j1);
  await w.complete('SINGEING', j1);

  // 1. rejected, undone by the receiver (the cloth turned up), still one piece of cloth
  const a = await w.forward('SINGEING', j1, 'DYEING');
  await w.ok('post', `/departments/DYEING/jobs/${a.id}/reject`, { reason: 'wrong' });
  await w.status('DYEING', a, 'PENDING');
  await expectClean();
  expect((await w.ok('get', '/departments/SINGEING/send-form')).rows).toHaveLength(0); // it is at Dyeing again
  await w.status('DYEING', a, 'PROCESSING');
  await w.status('DYEING', a, 'COMPLETE');

  // 2. a second card: rejected, sender sends it again elsewhere, then the receiver tries to undo
  const lot2 = await w.lot({ meters: 200, pieces: 1 });
  const card2 = await w.card([{ greyLotId: lot2.id, meters: 200 }]);
  const k1 = await w.sendCard(card2, 'SINGEING');
  await w.accept('SINGEING', k1);
  await w.complete('SINGEING', k1);
  const b = await w.forward('SINGEING', k1, 'DYEING');
  await w.ok('post', `/departments/DYEING/jobs/${b.id}/reject`, { reason: 'wrong' });
  const resent = await w.forward('SINGEING', k1, 'FINISHING');
  expect(await w.err('put', `/departments/DYEING/jobs/${b.id}/status`, { status: 'PENDING' })).toBe('ALREADY_RESENT');
  expect(resent.totalMeters).toBe(200);
  await expectClean();

  // 3. a third card: rejected, the sender disputes: it goes back to the receiver, who cannot reject it again
  const lot3 = await w.lot({ meters: 100, pieces: 1 });
  const card3 = await w.card([{ greyLotId: lot3.id, meters: 100 }]);
  const m1 = await w.sendCard(card3, 'SINGEING');
  await w.accept('SINGEING', m1);
  await w.complete('SINGEING', m1);
  const c = await w.forward('SINGEING', m1, 'DYEING');
  await w.ok('post', `/departments/DYEING/jobs/${c.id}/reject`, { reason: 'dirty' });
  await w.ok('post', `/departments/SINGEING/jobs/${c.id}/reject-answer`, { decision: 'DISPUTE', reason: 'it is clean' });
  expect(await w.err('post', `/departments/DYEING/jobs/${c.id}/reject`, { reason: 'again' })).toBe('REJECT_DISPUTED');
  expect((await w.ok('get', `/departments/DYEING/jobs/${c.id}`)).status).toBe('QUEUE');
  await expectClean();
});

test('a department cannot take the cloth of another department, and the SO desk cannot send cloth that was already sent', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const j = await w.sendCard(card, 'DYEING');
  const singer = await w.employee([['SINGEING', 'FULL']]);
  expect((await singer('put', `/departments/SINGEING/jobs/${j.id}/status`, { status: 'COMPLETE' })).status).toBeGreaterThanOrEqual(400);
  expect((await singer('post', `/departments/DYEING/jobs/${j.id}/accept`)).status).toBe(403);
  expect((await singer('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: j.items[0].id }] })).status).toBeGreaterThanOrEqual(400);
  await expectClean();
});
