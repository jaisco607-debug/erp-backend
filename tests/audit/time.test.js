// AUDIT: dates. The mill is in Pakistan (UTC+5). At 02:30 on 21 October in Pakistan it is still 20 October 21:30 in UTC.
// Every default date of a new entry must be the PAKISTAN day.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

const ONLY_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];

afterEach(() => jest.useRealTimers());

// Was bug AUD-14 (fixed): default dates are the UTC day, not the Pakistan day.
test('entries made at 02:30 Pakistan time (21 October) get the date 2026-10-21, not 2026-10-20', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 300, pieces: 1, date: '2026-10-10' });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  jest.useFakeTimers({ now: new Date('2026-10-20T21:30:00Z'), doNotFake: ONLY_DATE });
  // a job without a typed date
  const job = await w.sendCard(card, 'DYEING');
  expect(job.jobDate).toBe('2026-10-21');
  // a stock adjustment, a give-back, a fabric return without a typed date
  const red = await w.chem('RED');
  await w.buy(red, 10, 10, '2026-10-10');
  const adj = await w.ok('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: red.id, mode: 'IN', qty: 1, rate: 5 }] }, 201);
  expect(adj.adjDate).toBe('2026-10-21');
  const lot2 = await w.lot({ thaans: [10, 10], date: '2026-10-10' });
  const back = await w.ok('post', `/grey-lots/${lot2.id}/give-back`, { thaanNos: [1] });
  expect(back.returns[0].returnDate).toBe('2026-10-21');
  const fr = await w.ok('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot2.id, thaanNos: [2] }] }, 201);
  expect(fr.cardDate).toBe('2026-10-21');
  await expectClean();
});

// Was bug AUD-14 (fixed): day filters use UTC day boundaries.
test('a day filter on reports means a Pakistan day (a request made at 01:00 on the 21st shows on the 21st)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 10, '2026-10-10');
  const lot = await w.lot({ meters: 300, pieces: 1, date: '2026-10-10' });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  await w.give('DYEING', [red]);
  jest.useFakeTimers({ now: new Date('2026-10-20T20:00:00Z'), doNotFake: ONLY_DATE }); // 01:00 on 21 October in Pakistan
  await w.issue('DYEING', job, [{ itemId: red.id, qty: 10 }]);
  jest.useRealTimers();
  const on21 = await w.ok('get', '/reports/chemical-cost?dateFrom=2026-10-21&dateTo=2026-10-21');
  expect(on21.total).toBe(1);
});
