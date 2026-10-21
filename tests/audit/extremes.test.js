// AUDIT: extreme numbers and the General Items Store.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

// Was bug AUD-16 (fixed): qty x rate above the column size (numeric(16,2)) gives a 500.
test('huge quantity x huge rate is refused with a clear 4xx, never a database overflow (500)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  const big = { qty: 999999999, rate: 999999999 };
  const res = await w.api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: [{ itemId: red.id, ...big }], approve: true });
  expect(res.status).toBeLessThan(500);
  expect(res.status).toBeGreaterThanOrEqual(400);
  const adj = await w.api('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: red.id, mode: 'IN', ...big }] });
  expect(adj.status).toBeLessThan(500);
  // many big lines: the total amount must not overflow either
  const lines = Array.from({ length: 200 }, () => ({ itemId: red.id, qty: 999999999, rate: 99999 }));
  const many = await w.api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: lines.map((l, i) => ({ ...l, itemName: undefined })), approve: false });
  expect(many.status).toBeLessThan(500);
  await expectClean();
});

// Was bug AUD-16 (fixed): the same overflow when stock value grows.
test('stock value of an item can reach its limit without a crash (many big purchases)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  let crashed = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await w.api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: [{ itemId: red.id, qty: 900000000, rate: 900000 }], approve: true });
    if (res.status >= 500) crashed += 1;
  }
  expect(crashed).toBe(0);
  await expectClean();
});

test('General Items Store: purchase, average, adjustment; same exact money as the chemical store', async () => {
  const w = await world();
  const bolt = await w.ok('post', '/stores/general/items', { name: 'BOLT', unit: 'PCS' });
  await w.ok('post', '/stores/general/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: [{ itemId: bolt.id, qty: 100, rate: 2.5 }], approve: true }, 201);
  await w.ok('post', '/stores/general/inwards', { inwardDate: '2026-10-11', vendorName: 'V', lines: [{ itemId: bolt.id, qty: 50, rate: 3 }], approve: true }, 201);
  let st = (await w.ok('get', '/stores/general/stock')).data.find((i) => i.id === bolt.id);
  expect(st).toMatchObject({ stockQty: 150, stockValue: 400 });
  await w.ok('post', '/stores/general/adjustments', { reason: 'DAMAGED', lines: [{ itemId: bolt.id, mode: 'OUT', qty: 120 }] }, 201); // oldest first: 100 @ 2.5 + 20 @ 3
  st = (await w.ok('get', '/stores/general/stock')).data.find((i) => i.id === bolt.id);
  expect(st).toMatchObject({ stockQty: 30, stockValue: 90 });
  // a chemical-store user cannot touch the general store and the other way round
  const emp = await w.employee([['CHEMICAL_STORE', 'FULL']]);
  expect((await emp('get', '/stores/general/stock')).status).toBe(403);
  await expectClean();
});

// Was bug AUD-15 (fixed): the store can send any quantity above the request; the job pays for it.
test('the store sends more than the department asked for (the job is charged for it)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 10);
  await w.give('DYEING', [red]);
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  const r = await w.ok('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 4 }] }, 201);
  await w.ok('post', `/stores/chemical/requests/${r.id}/accept`);
  const res = await w.api('post', `/stores/chemical/requests/${r.id}/send`, { lines: [{ lineId: r.lines[0].id, qty: 90 }] });
  // 90 kg for a 4 kg request = Rs 900 on the job: must be refused, or at least limited
  expect(res.status).toBeGreaterThanOrEqual(400);
});
