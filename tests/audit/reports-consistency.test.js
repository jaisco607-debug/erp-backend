// AUDIT: the reports must agree with the data and with each other.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** one party, cloth in many places at once */
async function scenario(w) {
  const az = await w.customer('AZ');
  const bb = await w.customer('BB');
  const q = await w.quality();
  const out = {};
  // 1. grey: given back, fabric return, SO cards
  const lotA = await w.lot({ customer: az, quality: q, thaans: [100, 100, 100, 100, 100, 100] });
  await w.ok('post', `/grey-lots/${lotA.id}/give-back`, { thaanNos: [6] });
  await w.ok('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lotA.id, thaanNos: [5] }] }, 201);
  const lotB = await w.lot({ customer: bb, quality: q, meters: 700, pieces: 3 });
  // 2. cards in different places
  out.notSent = await w.card([{ greyLotId: lotA.id, thaanNos: [1] }]);
  out.inDyeing = await w.card([{ greyLotId: lotA.id, thaanNos: [2] }]);
  out.inFolding = await w.card([{ greyLotId: lotA.id, thaanNos: [3] }]);
  out.dispatched = await w.card([{ greyLotId: lotA.id, thaanNos: [4] }]);
  out.bb = await w.card([{ greyLotId: lotB.id, meters: 300 }]);
  const dy = await w.sendCard(out.inDyeing, 'DYEING');
  await w.accept('DYEING', dy);
  await w.status('DYEING', dy, 'PROCESSING');
  // in folding: graded 40 m of 100 and sent; 60 stays
  const j3 = await w.sendCard(out.inFolding, 'DYEING');
  await w.accept('DYEING', j3);
  await w.complete('DYEING', j3);
  const f3 = await w.forward('DYEING', j3, 'FOLDING');
  await w.accept('FOLDING', f3);
  const u3 = `/departments/FOLDING/folding/${f3.id}/${out.inFolding.id}`;
  const row3 = await w.ok('get', u3);
  await w.ok('put', `${u3}/grades`, { lines: [{ greyLotId: lotA.id, thaanId: row3.lots[0].lines[0].thaanId, a: 40 }] });
  await w.ok('post', `${u3}/send-packing`, {}, 201);
  // dispatched: the whole way
  const j4 = await w.sendCard(out.dispatched, 'DYEING');
  await w.accept('DYEING', j4);
  await w.complete('DYEING', j4);
  const f4 = await w.forward('DYEING', j4, 'FOLDING');
  await w.accept('FOLDING', f4);
  const u4 = `/departments/FOLDING/folding/${f4.id}/${out.dispatched.id}`;
  const row4 = await w.ok('get', u4);
  await w.ok('put', `${u4}/grades`, { lines: [{ greyLotId: lotA.id, thaanId: row4.lots[0].lines[0].thaanId, a: 60, b: 40 }] });
  const p4 = (await w.ok('post', `${u4}/send-packing`, {}, 201)).packingJob;
  await w.accept('PACKING', p4);
  const form = await w.ok('get', `/departments/PACKING/packing/so-cards/${out.dispatched.id}/form`);
  const pl = await w.ok('post', '/departments/PACKING/packing-lists', { soCardId: out.dispatched.id, rateA: 10, rateB: 5, lines: form.lots[0].thaans.flatMap((t) => t.suggestedLines.map((s) => ({ greyLotId: lotA.id, thaanId: t.thaanId, grade: s.grade, meters: s.meters }))) }, 201);
  await w.ok('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await w.ok('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'D', vehicleNo: 'V-1', passDate: '2030-01-01' });
  // BB: rejected back and sent again
  const jb = await w.sendCard(out.bb, 'SINGEING');
  await w.accept('SINGEING', jb);
  await w.complete('SINGEING', jb);
  const bad = await w.forward('SINGEING', jb, 'DYEING');
  await w.ok('post', `/departments/DYEING/jobs/${bad.id}/reject`, { reason: 'x' });
  await w.ok('post', `/departments/SINGEING/jobs/${bad.id}/reject-answer`, { decision: 'ACCEPT' });
  const again = await w.forward('SINGEING', jb, 'FINISHING');
  await w.accept('FINISHING', again);
  out.lotA = lotA; out.lotB = lotB; out.az = az; out.bb2 = bb;
  return out;
}

test('every meter of every SO card is somewhere: what is in the departments and at Packing never passes the card meters', async () => {
  const w = await world();
  const s = await scenario(w);
  const rep = await w.ok('get', '/reports/so-cards?all=true');
  const rows = rep.sections[0].rows;
  const bad = [];
  for (const r of rows) {
    if (r.inProcessMeters + r.atPackingMeters > r.meters + 0.011) bad.push(`SO ${r.soNo}: ${r.meters} m on the card but ${r.inProcessMeters + r.atPackingMeters} m in departments and Packing`);
  }
  expect(bad).toEqual([]);
  const by = Object.fromEntries(rows.filter((r) => !r.tag).map((r) => [r.soNo, r]));
  expect(by[s.notSent.cardNo]).toMatchObject({ inProcessMeters: 0, atPackingMeters: 0 });
  expect(by[s.inDyeing.cardNo]).toMatchObject({ inProcessMeters: 100 });
  expect(by[s.inFolding.cardNo]).toMatchObject({ inProcessMeters: 60, atPackingMeters: 40 });
  expect(by[s.dispatched.cardNo]).toMatchObject({ inProcessMeters: 0 }); // dispatched cloth is counted with Packing
  expect(by[s.bb.cardNo]).toMatchObject({ inProcessMeters: 300 });
  await expectClean();
});

test('party report: inward = on SO cards + fabric return + given back + still in grey store; and rows add up to totals', async () => {
  const w = await world();
  await scenario(w);
  const rep = (await w.ok('get', '/reports/grey/parties')).sections[0];
  for (const r of rep.rows) {
    const sum = r2(r.soCardMeters + r.fabricReturnMeters + r.givenBackMeters + r.inStoreMeters);
    expect([r.party, sum]).toEqual([r.party, r.inwardMeters]);
    // what is not sent yet + in departments + at Packing (dispatched cloth included) = what left the grey store for SO cards and fabric returns
    const where = r2(r.notSentMeters + r.inProcessMeters + r.atPackingMeters);
    expect([r.party, where]).toEqual([r.party, r2(r.soCardMeters + r.fabricReturnMeters)]);
  }
  expect(rep.totals.inwardMeters).toBe(r2(rep.rows.reduce((t, r) => t + r.inwardMeters, 0)));
  const lots = (await w.ok('get', '/reports/grey/lots?all=true')).sections[0];
  for (const l of lots.rows) expect([l.lotNo, r2(l.onSoCardMeters + l.fabricReturnMeters + l.givenBackMeters + l.inStoreMeters)]).toEqual([l.lotNo, l.inwardMeters]);
  const ov = Object.fromEntries((await w.ok('get', '/reports/overview')).sections.find((s) => s.key === 'summary').rows.map((r) => [r.metric, r.value]));
  expect(ov['Grey received']).toBe(rep.totals.inwardMeters);
  expect(ov['Grey in store']).toBe(rep.totals.inStoreMeters);
});

test('paging, all=true and filters never lose or repeat a row; totals cover all rows', async () => {
  const w = await world();
  await scenario(w);
  for (const url of ['/reports/so-cards', '/reports/grey/lots', '/reports/departments/jobs', '/reports/folding', '/reports/packing-lists']) {
    const all = await w.ok('get', `${url}?all=true`);
    const seen = [];
    for (let p = 1; p <= all.total; p += 1) {
      const page = await w.ok('get', `${url}?limit=1&page=${p}`);
      expect(page.total).toBe(all.total);
      seen.push(JSON.stringify(page.sections[0].rows[0]));
    }
    expect(seen).toEqual(all.sections[0].rows.map((r) => JSON.stringify(r)));
    const pageOne = await w.ok('get', `${url}?limit=1&page=1`);
    expect(pageOne.sections[0].totals).toEqual(all.sections[0].totals);
  }
});

test('active fabric: by party, by SO card, by department and in detail give the same cloth', async () => {
  const w = await world();
  await scenario(w);
  const views = {};
  for (const by of ['party', 'so-card', 'department', 'detail']) views[by] = (await w.ok('get', `/reports/active-fabric?by=${by}&all=true`)).sections[0];
  for (const by of Object.keys(views)) {
    expect(views[by].totals.meters).toBe(views.party.totals.meters);
    expect(r2(views[by].rows.reduce((t, r) => t + r.meters, 0))).toBe(views[by].totals.meters);
  }
  // the cloth that is in a department or at Packing is part of it (the rest is in the grey store / on the SO desk)
  const parties = (await w.ok('get', '/reports/grey/parties')).sections[0].totals;
  expect(views.party.totals.meters).toBeGreaterThanOrEqual(r2(parties.inProcessMeters + parties.atPackingMeters));
});

// Was bug AUD-13 (fixed): list total (48.35) differs from the sum of the rounded line amounts (48.37); the two packing reports disagree too.
test('packing list money: the total equals the sum of its line amounts, in the list, the reports and the paper', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [10.01, 10.01, 10.01, 33.33, 33.33] });
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4, 5] }]);
  const job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  await w.accept('FOLDING', fold);
  const url = `/departments/FOLDING/folding/${fold.id}/${card.id}`;
  const row = await w.ok('get', url);
  await w.ok('put', `${url}/grades`, { lines: row.lots[0].lines.map((l) => ({ greyLotId: lot.id, thaanId: l.thaanId, a: l.received })) });
  const pack = (await w.ok('post', `${url}/send-packing`, {}, 201)).packingJob;
  await w.accept('PACKING', pack);
  const form = await w.ok('get', `/departments/PACKING/packing/so-cards/${card.id}/form`);
  const pl = await w.ok('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 0.5, lines: form.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters })) }, 201);
  const lineSum = r2(pl.lots.flatMap((l) => l.thaans).reduce((t, x) => t + x.amount, 0));
  expect([pl.summary.total.amount, lineSum]).toEqual([lineSum, lineSum]); // the list total = the sum of the lines
  expect(pl.summary.total.amount).toBe(48.37); // five lines, each rounded to the paisa: 5.01 x3 + 16.67 x2
  const rep = await w.ok('get', '/reports/packing-lists');
  const lines = await w.ok('get', '/reports/packing-lists/lines');
  expect(rep.sections[0].rows[0].amount).toBe(lines.sections[0].totals.amount);
});
