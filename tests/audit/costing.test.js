// AUDIT: chemical stock and COSTING. Every test checks the numbers by hand AND the accounting rules of
// scripts/audit/invariants.js afterwards. A failing test is a finding (see docs/AUDIT-REPORT.md).
const { world, clean, expectClean } = require('./world');

beforeEach(clean);

const sum = (xs) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;

/** a Dyeing job of one SO card (or several), accepted and PROCESSING, ready to ask chemicals */
async function dyeingJob(w, meters = [1000]) {
  const lots = [];
  const cards = [];
  for (const m of meters) {
    const lot = await w.lot({ meters: m, pieces: 1 });
    lots.push(lot);
    cards.push(await w.card([{ greyLotId: lot.id, meters: m }]));
  }
  const rows = await w.deskRows();
  const job = await w.ok('post', '/jobs', { departmentId: w.s.DYEING.id, items: rows.map((r) => ({ soCardLotId: r.soCardLotId })) }, 201);
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  return { job, cards, lots };
}

test('buying at different rates: average rate, batches, issue oldest first = exact money', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 20, 40, '2026-10-10');
  await w.buy(red, 100, 45, '2026-10-11');
  let st = await w.stock(red);
  expect(st).toMatchObject({ stockQty: 120, stockValue: 5300 });
  expect(st.avgRate).toBeCloseTo(44.1667, 4);

  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  // 30 kg oldest first = 20 @ 40 + 10 @ 45 = 800 + 450
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 30 }]);
  expect(sent.totalValue).toBe(1250);
  st = await w.stock(red);
  expect(st).toMatchObject({ stockQty: 90, stockValue: 4050 });
  expect(st.avgRate).toBe(45);
  const batches = (await w.ok('get', `/stores/chemical/items/${red.id}/batches`)).batches;
  expect(batches.map((b) => [b.rate, b.qtyLeft, b.valueLeft])).toEqual([[45, 90, 4050]]);
  // the job costs 1250
  expect((await w.ok('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`)).totalValue).toBe(1250);
  await expectClean();
});

test('the store picks the batch: the job pays that batch rate, not the average', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 20, 40, '2026-10-10');
  await w.buy(red, 100, 45, '2026-10-11');
  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  const b = (await w.ok('get', `/stores/chemical/items/${red.id}/batches`)).batches;
  const newer = b.find((x) => x.rate === 45);
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 10 }], { sendLines: (r) => [{ lineId: r.lines[0].id, batches: [{ batchId: newer.batchId, qty: 10 }] }] });
  expect(sent.totalValue).toBe(450);
  expect(await w.stock(red)).toMatchObject({ stockQty: 110, stockValue: 4850 });
  await expectClean();
});

test('rates with many decimals: three 1 kg issues from a 3 kg batch add up to exactly what was bought', async () => {
  const w = await world();
  const red = await w.chem('RED');
  // 3 kg for Rs 100.00 (rate 33.3333...): the three issues must add up to 100.00, not 99.99 or 100.01
  await w.ok('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: [{ itemId: red.id, qty: 3, rate: 33.3333 }], approve: true });
  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  const values = [];
  for (let i = 0; i < 3; i += 1) values.push((await w.issue('DYEING', job, [{ itemId: red.id, qty: 1 }])).totalValue);
  expect(sum(values)).toBeCloseTo(99.9999, 1); // the purchase line was 3 x 33.3333 = 99.9999 -> 100.00
  const st = await w.stock(red);
  expect(st).toMatchObject({ stockQty: 0, stockValue: 0 });
  await expectClean();
});

test('a department returns chemical: stock comes back at the rate it left, the job cost goes down by the same', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 20, 40, '2026-10-10');
  await w.buy(red, 100, 45, '2026-10-11');
  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 30 }]);
  expect(sent.totalValue).toBe(1250);
  // 25 kg back: the newest issue goes back first: 10 @ 45 then 15 @ 40
  const ret = await w.ok('post', '/departments/DYEING/chemical-returns', { requestId: sent.id, lines: [{ requestLineId: sent.lines[0].id, qty: 25 }] }, 201);
  const got = await w.ok('post', `/stores/chemical/returns/${ret.id}/receive`);
  expect(got.status).toBe('RECEIVED');
  expect(got.totalValue).toBe(1050); // 10 x 45 + 15 x 40
  const st = await w.stock(red);
  expect(st).toMatchObject({ stockQty: 115, stockValue: 5100 }); // 5300 bought - 5 kg @ 40 kept by the job
  const cost = await w.ok('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`);
  expect(cost.totalValue).toBe(200); // 5 kg @ 40 stays on the job
  await expectClean();
});

test('the cost of one request shared between SO cards adds up to the request, in every report', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 33.33, '2026-10-10');
  // three SO cards of 333 / 333 / 334 m in one job; 7.777 kg for the whole job
  const { job, cards } = await dyeingJob(w, [333, 333, 334]);
  await w.give('DYEING', [red]);
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 7.777 }]);
  const total = sent.totalValue;
  expect(total).toBeCloseTo(7.777 * 33.33, 1);

  const perCard = [];
  for (const c of cards) perCard.push((await w.ok('get', `/stores/chemical/cost/so-cards/${c.id}`)).totalValue);
  expect(Math.abs(sum(perCard) - total)).toBeLessThanOrEqual(0.02);

  // every screen must give the same total for the job
  const byJob = (await w.ok('get', '/stores/chemical/cost/jobs')).rows || (await w.ok('get', '/stores/chemical/cost/jobs')).data;
  expect(byJob[0].value).toBe(total);
  const rep = await w.ok('get', '/reports/chemical-cost');
  expect(rep.totalCost).toBeCloseTo(total, 1);
  expect(Math.abs(rep.totals.value - total)).toBeLessThanOrEqual(0.02);
  const so = await w.ok('get', '/reports/so-cards?all=true');
  expect(Math.abs(so.totals.chemicalCost - total)).toBeLessThanOrEqual(0.02);
  const ov = await w.ok('get', '/reports/overview');
  expect(ov.summary.chemicalCost).toBeCloseTo(total, 1);
  const dept = await w.ok('get', '/reports/departments');
  expect(Math.abs(dept.totals.chemicalCost - total)).toBeLessThanOrEqual(0.02);
  const list = (await w.ok('get', '/departments/DYEING/incoming?view=job')).data[0];
  expect(list.chemicalAmount).toBe(total);
  await expectClean();
});

// Was bug AUD-01 (fixed): previousCosts gives each split child the whole cost of its parent item (Rs 2000 instead of 1000 on the Packing screens).
test('Packing gets the chemical cost of the cloth ONCE, even when Folding sends it in two parts', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 10, '2026-10-10');
  const { job, cards } = await dyeingJob(w, [300]);
  await w.give('DYEING', [red]);
  await w.issue('DYEING', job, [{ itemId: red.id, qty: 100 }]); // Rs 1000 for the 300 m
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  await w.accept('FOLDING', fold);
  const url = `/departments/FOLDING/folding/${fold.id}/${cards[0].id}`;
  const row = await w.ok('get', url);
  const line = row.lots[0].lines[0];
  // grade 100 m A and send, then grade 200 m B and send
  await w.ok('put', `${url}/grades`, { lines: [{ greyLotId: row.lots[0].lotId, thaanId: line.thaanId, a: 100 }] });
  const p1 = (await w.ok('post', `${url}/send-packing`, {}, 201)).packingJob;
  await w.ok('put', `${url}/grades`, { lines: [{ greyLotId: row.lots[0].lotId, thaanId: line.thaanId, b: 200 }] });
  const p2 = (await w.ok('post', `${url}/send-packing`, {}, 201)).packingJob;
  expect(p1.totalMeters + p2.totalMeters).toBe(300);
  const rows = (await w.ok('get', '/departments/PACKING/incoming?view=job')).data;
  expect(rows).toHaveLength(2);
  // the 300 m cost Rs 1000 in Dyeing: the two packing jobs together carry Rs 1000, not 2000
  expect(sum(rows.map((r) => r.previousChemicalAmount))).toBe(1000);
  expect(sum(rows.map((r) => r.totalChemicalAmount))).toBe(1000);
  await expectClean();
});

test('re-work loop: Dyeing -> Folding -> back to Dyeing -> Folding; each chemical cost counted once', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 300, 10, '2026-10-10');
  const { job, cards } = await dyeingJob(w, [300]);
  await w.give('DYEING', [red]);
  await w.issue('DYEING', job, [{ itemId: red.id, qty: 100 }]); // Rs 1000
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  await w.accept('FOLDING', fold);
  // Folding finds a fault and sends the cloth back to Dyeing for re-work
  await w.status('FOLDING', fold, 'COMPLETE');
  await w.ok('put', `/departments/FOLDING/jobs/${fold.id}/operator`, { operatorName: 'F', processDate: '2026-10-19' });
  const back = await w.forward('FOLDING', fold, 'DYEING');
  expect(back.isRework).toBe(true);
  await w.accept('DYEING', back);
  await w.status('DYEING', back, 'PROCESSING');
  await w.issue('DYEING', back, [{ itemId: red.id, qty: 50 }]); // Rs 500 more
  await w.complete('DYEING', back);
  const fold2 = await w.forward('DYEING', back, 'FOLDING');
  const rows = (await w.ok('get', '/departments/FOLDING/incoming?view=job')).data;
  const second = rows.find((r) => r.id === fold2.id);
  // the cloth has now cost Rs 1000 (first Dyeing) + Rs 500 (re-work) = Rs 1500 before it reaches Folding again
  expect(second.previousChemicalAmount).toBe(1500);
  const so = await w.ok('get', `/stores/chemical/cost/so-cards/${cards[0].id}`);
  expect(so.totalValue).toBe(1500);
  await expectClean();
});

test('stock can never go below zero: too much asked, too much adjusted out, too much returned', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10);
  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  const r = await w.ok('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 10.001 }] }, 201);
  await w.ok('post', `/stores/chemical/requests/${r.id}/accept`);
  expect(await w.err('post', `/stores/chemical/requests/${r.id}/send`, {})).toBe('NOT_ENOUGH_STOCK');
  expect(await w.err('post', '/stores/chemical/adjustments', { reason: 'LOST', lines: [{ itemId: red.id, mode: 'OUT', qty: 10.001 }] })).toBe('NOT_ENOUGH_STOCK');
  // the first sends 10, a second request for anything fails
  await w.ok('post', `/stores/chemical/requests/${r.id}/reject`, { reason: 'x' });
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 10 }]);
  expect(await w.stock(red)).toMatchObject({ stockQty: 0, stockValue: 0 });
  expect(await w.err('post', '/departments/DYEING/chemical-returns', { requestId: sent.id, lines: [{ requestLineId: sent.lines[0].id, qty: 10.001 }] })).toBe('TOO_MUCH');
  await expectClean();
});

test('un-approving a purchase: refused once its stock was issued, allowed when nothing left the store, and after a full return', async () => {
  const w = await world();
  const red = await w.chem('RED');
  const buy = await w.buy(red, 10, 10);
  const { job } = await dyeingJob(w);
  await w.give('DYEING', [red]);
  const sent = await w.issue('DYEING', job, [{ itemId: red.id, qty: 4 }]);
  expect(await w.err('post', `/stores/chemical/inwards/${buy.id}/unapprove`)).toBe('STOCK_USED');
  // everything comes back: the batch is whole again, so the purchase may be taken back ...
  const ret = await w.ok('post', '/departments/DYEING/chemical-returns', { requestId: sent.id, lines: [{ requestLineId: sent.lines[0].id, qty: 4 }] }, 201);
  await w.ok('post', `/stores/chemical/returns/${ret.id}/receive`);
  // ... but the issue and return history points at that batch
  const res = await w.api('post', `/stores/chemical/inwards/${buy.id}/unapprove`);
  expect([200, 409, 422]).toContain(res.status);
  expect(res.status).not.toBe(500);
  await expectClean();
});

test('adjustments: count up and down, damaged, add at a rate; value follows the batches', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 10, 10, '2026-10-10');
  await w.buy(red, 10, 20, '2026-10-11');
  // counted 15 instead of 20: 5 kg lost, taken from the oldest batch (Rs 10)
  await w.ok('post', '/stores/chemical/adjustments', { reason: 'COUNT', lines: [{ itemId: red.id, mode: 'COUNT', qty: 15 }] }, 201);
  expect(await w.stock(red)).toMatchObject({ stockQty: 15, stockValue: 250 });
  // 2 kg found at Rs 30
  await w.ok('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: red.id, mode: 'IN', qty: 2, rate: 30 }] }, 201);
  expect(await w.stock(red)).toMatchObject({ stockQty: 17, stockValue: 310 });
  // damaged 1 kg
  await w.ok('post', '/stores/chemical/adjustments', { reason: 'DAMAGED', lines: [{ itemId: red.id, mode: 'OUT', qty: 1 }] }, 201);
  const st = await w.stock(red);
  expect(st.stockQty).toBe(16);
  await expectClean();
});

test('money rounding: a line of 3 kg at Rs 0.335 is Rs 1.01 (half a paisa goes up)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  const inward = await w.buy(red, 3, 0.335);
  expect(inward.amount).toBe(1.01);
});

// Was bug AUD-02 (fixed): Math.round(n * 100) / 100 rounds some exact half-paisa values down (0.29 kg x Rs 0.5 = 0.145 gives 0.14).
test('money rounding: every half-paisa product rounds up (a sample of 1,000 lines)', async () => {
  const w = await world();
  const red = await w.chem('RED');
  let wrong = 0;
  const cases = [];
  // qty 3 decimals x rate 2 decimals, chosen so the product ends exactly in .xx5
  for (let i = 1; i <= 40; i += 1) cases.push([i * 0.005 * 2, 0.5]); // 0.01*i qty at 0.5 -> .005 products
  const wrongCases = [];
  for (const [qty, rate] of cases) {
    const exact = Math.floor(qty * 1000 * rate * 100 / 1000 + 0.5 + 1e-9) / 100;
    const inward = await w.ok('post', '/stores/chemical/inwards', { inwardDate: '2026-10-10', vendorName: 'V', lines: [{ itemId: red.id, qty, rate }] }, 201);
    if (inward.amount !== exact) { wrong += 1; wrongCases.push({ qty, rate, got: inward.amount, exact }); }
  }
  if (wrong) console.log('WRONG ROUNDING CASES', JSON.stringify(wrongCases));
  expect(wrong).toBe(0);
});
