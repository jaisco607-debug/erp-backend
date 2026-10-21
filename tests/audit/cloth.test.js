// AUDIT: cloth (meters, thaans, yards) from grey inward to SO card, departments, folding, packing and gate pass.
// Every test checks the accounting rules of scripts/audit/invariants.js afterwards.
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(120000);

test('thaans with decimals: the lot is exactly the sum of its thaans; yards lots convert once', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [10.1, 20.2, 30.3, 0.01, 99.99] });
  expect(lot).toMatchObject({ inwardMeters: 160.6, pieces: 5 });
  const y = await w.lot({ thaans: [100.5, 200.25, 333.33], unit: 'YARD' });
  expect(y.unit).toBe('YARD');
  expect(y.thaans.map((t) => [t.meters, t.yards])).toEqual([[91.9, 100.5], [183.11, 200.25], [304.8, 333.33]]);
  expect(y.inwardMeters).toBe(579.81); // 91.9 + 183.11 + 304.8 (each thaan rounded once, the lot is their sum)
  const card = await w.card([{ greyLotId: y.id, thaanNos: [1, 2, 3] }]);
  expect(card.totalMeters).toBe(579.81);
  expect((await w.ok('get', `/grey-lots/${y.id}`)).balanceMeters).toBe(0);
  await expectClean();
});

test('a thaan can be shared by SO cards in parts, never over its length, and cancelling gives the part back', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100] });
  const a = await w.card([{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 40 }] }]);
  const b = await w.card([{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 60 }] }]);
  expect((await w.ok('get', `/grey-lots/${lot.id}`)).balanceMeters).toBe(0);
  expect(await w.err('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 0.01 }] }] })).toBe('THAAN_NOT_IN_STOCK');
  await w.ok('delete', `/so-cards/${a.id}`);
  const lotNow = await w.ok('get', `/grey-lots/${lot.id}`);
  expect(lotNow.balanceMeters).toBe(40);
  expect(lotNow.thaans[0]).toMatchObject({ takenMeters: 60, freeMeters: 40 });
  expect(await w.err('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 40.01 }] }] })).toBe('THAAN_SHORT');
  await w.card([{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 40 }] }]);
  expect(b.totalMeters).toBe(60);
  await expectClean();
});

test('editing an SO card again and again keeps every meter accounted for', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100, 100] });
  const lot2 = await w.lot({ meters: 500, pieces: 3 });
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [1, 2] }]);
  const steps = [
    [{ greyLotId: lot.id, thaanNos: [2, 3] }],
    [{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4] }, { greyLotId: lot2.id, meters: 250.5 }],
    [{ greyLotId: lot2.id, meters: 500 }],
    [{ greyLotId: lot.id, thaans: [{ thaanNo: 4, meters: 33.33 }] }],
  ];
  for (const lots of steps) {
    await w.ok('patch', `/so-cards/${card.id}`, { lots });
    await expectClean();
  }
  const after = await w.ok('get', `/so-cards/${card.id}`);
  expect(after.totalMeters).toBe(33.33);
  expect((await w.ok('get', `/grey-lots/${lot.id}`)).balanceMeters).toBe(366.67);
  expect((await w.ok('get', `/grey-lots/${lot2.id}`)).balanceMeters).toBe(500);
  // another card takes what the first let go
  await w.card([{ greyLotId: lot.id, thaanNos: [1, 2, 3] }]);
  await expectClean();
});

test('give back and undo: a given-back thaan cannot go on a card, and coming back makes it free again', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100, 100, 100] });
  const back = await w.ok('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [5] });
  expect(back).toMatchObject({ returnedMeters: 100, balanceMeters: 400 });
  expect(await w.err('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [5] }] })).toBe('THAAN_NOT_IN_STOCK');
  expect(await w.err('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [5] })).toBe('THAAN_RETURNED');
  await w.card([{ greyLotId: lot.id, thaanNos: [1, 2] }]);
  expect(await w.err('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [1] })).toBe('THAAN_ON_SO_CARD');
  const returnId = back.returns[0].id;
  await w.ok('delete', `/grey-lots/${lot.id}/give-back/${returnId}`);
  expect((await w.ok('get', `/grey-lots/${lot.id}`)).balanceMeters).toBe(300);
  await w.card([{ greyLotId: lot.id, thaanNos: [3, 4, 5] }]);
  expect((await w.ok('get', `/grey-lots/${lot.id}`)).balanceMeters).toBe(0);
  // a fabric return takes nothing that is gone
  await expectClean();
});

test('take the approval of a lot back after cloth left it: its thaans and quantities cannot be rewritten', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100] });
  await w.card([{ greyLotId: lot.id, thaanNos: [1] }]);
  await w.ok('post', `/grey-lots/${lot.id}/unapprove`);
  // thaan 1 is on a card: it cannot change length or disappear
  expect(await w.err('patch', `/grey-lots/${lot.id}`, { thaans: [150, 100, 100] })).toBe('THAAN_ON_SO_CARD');
  // below what went out
  expect(await w.err('patch', `/grey-lots/${lot.id}`, { inwardMeters: 50, pieces: 1 })).toMatch(/BELOW_OUTWARD|THAAN|VALIDATION|QTY/);
  // an untouched thaan may change
  const ok = await w.ok('patch', `/grey-lots/${lot.id}`, { thaans: [100, 120, 80] });
  expect(ok.inwardMeters).toBe(300);
  expect(await w.err('patch', `/grey-lots/${lot.id}`, { customerId: (await w.customer('Other')).id })).toBe('LOT_IN_USE');
  expect(await w.err('delete', `/grey-lots/${lot.id}`)).toBe('LOT_IN_USE');
  await expectClean();
});

test('the same cloth cannot be sent twice from the SO desk, and meters cannot exceed what is left', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 1000, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 1000 }]);
  const row = (await w.deskRows()).find((r) => r.soCard.id === card.id);
  const send = (meters) => w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: row.soCardLotId, meters }] });
  expect((await send(600)).status).toBe(201);
  expect((await send(400.01)).body.error.code).toBe('NOT_ENOUGH_METERS');
  expect((await send(0)).status).toBe(400);
  expect((await send(-5)).status).toBe(400);
  expect((await send(400)).status).toBe(201);
  expect((await send(0.01)).body.error.code).toBe('NOTHING_LEFT');
  await expectClean();
});

test('status machine: what a department can and cannot do', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 100, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 100 }]);
  const job = await w.sendCard(card, 'DYEING');
  // cloth that came from the SO desk can never be rejected
  expect(await w.err('post', `/departments/DYEING/jobs/${job.id}/reject`, { reason: 'no' })).toBe('REJECT_NOT_ALLOWED');
  expect(await w.err('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'IN_WAY' })).toMatch(/VALIDATION|BAD_STATUS/);
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  await w.status('DYEING', job, 'COMPLETE');
  // sending on needs the operator and the process date
  expect(await w.err('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: (await w.ok('get', '/departments/DYEING/send-form')).rows[0].jobItemId }] })).toBe('OPERATOR_REQUIRED');
  await w.complete('DYEING', job);
  const fold = await w.forward('DYEING', job, 'FOLDING');
  // after it was sent on, Dyeing can no longer change its status, operator or colour
  expect(await w.err('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'PENDING' })).toBe('ALREADY_SENT_ON');
  expect(await w.err('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'X' })).toBe('ALREADY_SENT_ON');
  // a job from another department cannot be touched through the wrong department URL
  expect(await w.err('put', `/departments/DYEING/jobs/${fold.id}/status`, { status: 'COMPLETE' })).toBe('JOB_WRONG_DEPARTMENT');
  await expectClean();
});

// Was bug AUD-03 (fixed): COMPLETE -> PENDING -> REJECTED is allowed; processed cloth with chemicals goes back to the sender.
test('LOOPHOLE: a department steps a finished job back to Pending and rejects it, after chemicals were used', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 10);
  const lot = await w.lot({ meters: 300, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  const job1 = await w.sendCard(card, 'SINGEING');
  await w.accept('SINGEING', job1);
  await w.complete('SINGEING', job1);
  const job = await w.forward('SINGEING', job1, 'DYEING');
  await w.accept('DYEING', job);
  await w.status('DYEING', job, 'PROCESSING');
  await w.give('DYEING', [red]);
  await w.issue('DYEING', job, [{ itemId: red.id, qty: 100 }]); // Rs 1000 of chemicals on this cloth
  await w.status('DYEING', job, 'COMPLETE');
  // COMPLETE -> PENDING is allowed by the dropdown ...
  const back = await w.api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'PENDING' });
  // ... and then REJECTED would send processed cloth back to Singeing, with the chemical cost lost from the cloth's trail
  const rej = back.status === 200 ? await w.api('post', `/departments/DYEING/jobs/${job.id}/reject`, { reason: 'changed my mind' }) : null;
  expect(rej && rej.status === 200).toBeFalsy(); // a job that used chemicals / was completed must not be rejectable
});

test('reject and answers: accepted rejection frees the cloth for the sender; a disputed one returns to the receiver; meters never change', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 500, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 500 }]);
  const j1 = await w.sendCard(card, 'SINGEING');
  await w.accept('SINGEING', j1);
  await w.complete('SINGEING', j1);
  const j2 = await w.forward('SINGEING', j1, 'DYEING');
  // Dyeing rejects before accepting; Singeing accepts the rejection and sends to Finishing instead
  await w.ok('post', `/departments/DYEING/jobs/${j2.id}/reject`, { reason: 'wrong cloth' });
  await w.ok('post', `/departments/SINGEING/jobs/${j2.id}/reject-answer`, { decision: 'ACCEPT' });
  const j3 = await w.forward('SINGEING', j1, 'FINISHING');
  expect(j3.totalMeters).toBe(500);
  // the rejected job cannot be answered twice, and the cloth cannot be sent a third time while j3 lives
  expect(await w.err('post', `/departments/SINGEING/jobs/${j2.id}/reject-answer`, { decision: 'ACCEPT' })).toBe('ALREADY_ANSWERED');
  await w.accept('FINISHING', j3);
  await w.ok('post', `/departments/FINISHING/jobs/${j3.id}/reject`, { reason: 'x' }).catch(() => null);
  await expectClean();
});

test('a long re-work chain (six hops) keeps the meters and the colour; nothing is created or lost', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 800, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 800 }]);
  let job = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', job);
  const navy = await w.ok('post', '/colours', { name: 'NAVY' });
  await w.ok('put', `/departments/DYEING/jobs/${job.id}/colour`, { colourId: navy.id });
  await w.complete('DYEING', job);
  const route = ['FOLDING', 'DYEING', 'FOLDING', 'DYEING', 'FOLDING'];
  let from = 'DYEING';
  for (const to of route) {
    const next = await w.forward(from, job, to);
    await w.accept(to, next);
    if (to !== 'FOLDING' || next !== null) await w.status(to, next, 'PROCESSING').catch(() => null);
    await w.ok('put', `/departments/${to}/jobs/${next.id}/operator`, { operatorName: 'Op', processDate: '2026-10-18' });
    await w.status(to, next, 'COMPLETE');
    job = next; from = to;
    await expectClean();
  }
  const last = await w.ok('get', `/departments/${from}/jobs/${job.id}`);
  expect(last.totalMeters).toBe(800);
  expect(last.colours).toEqual(['NAVY']);
});

// KNOWN BUG AUD-04: no limit on gain: 200 m received can be graded as 5000 m.
test.failing('Folding: grading more than received is accepted without any limit (business decision)', async () => {
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
  // 200 m received, 5000 m graded
  const res = await w.api('put', `${url}/grades`, { lines: [{ greyLotId: row.lots[0].lotId, thaanId: row.lots[0].lines[0].thaanId, a: 5000 }] });
  expect(res.status).toBeGreaterThanOrEqual(400); // grading 5000 m out of 200 m received must be refused or limited
});

// Was bug AUD-05 (fixed): a packing list line can be any number of meters (5000 m on a 100 m thaan).
test('Packing list cannot hold more cloth than Folding sent', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100] });
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [1, 2, 3] }]);
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
  // thaan 1 is 100 m; a list line of 5000 m must be refused
  const res = await w.api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: [{ greyLotId: lot.id, thaanId: t1.thaanId, grade: 'A', meters: 5000 }] });
  expect(res.status).toBeGreaterThanOrEqual(400);
});

// Was bug AUD-06 (fixed): a list with a gate pass can be reopened.
test('a packing list that already has a gate pass cannot be reopened, changed or deleted (the gate pass would vanish)', async () => {
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
  const pl = await w.ok('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: form.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters })) }, 201);
  await w.ok('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await w.ok('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'D', vehicleNo: 'V-1', passDate: '2030-01-01' });
  // the cloth has left: the list must be frozen
  const reopen = await w.api('post', `/departments/PACKING/packing-lists/${pl.id}/reopen`);
  expect(reopen.status).toBeGreaterThanOrEqual(400);
  const del = await w.api('delete', `/departments/PACKING/packing-lists/${pl.id}`);
  expect(del.status).toBeGreaterThanOrEqual(400);
  expect((await w.ok('get', '/departments/PACKING/gate-passes')).total).toBe(1);
});

test('fabric return and give-back never take the same thaan; numbers of the two series are independent', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100, 100] });
  const ret = await w.ok('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] }, 201);
  expect(ret.cardLabel).toBe('FR-1');
  expect(await w.err('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [1] })).toBe('THAAN_ON_SO_CARD');
  expect(await w.err('post', '/grey-lots/fabric-return', { lots: [{ greyLotId: lot.id, thaanNos: [2, 3] }] })).toBe('THAAN_NOT_IN_STOCK');
  await w.ok('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [3] });
  const card = await w.card([{ greyLotId: lot.id, thaanNos: [4] }]);
  expect(card.cardLabel).toBe('1');
  await expectClean();
});

test('input edges: zero, negative, tiny, huge, text and empty values are refused with a clear error, never a crash', async () => {
  const w = await world();
  const base = { inwardDate: '2026-10-10', customerId: (await w.customer()).id, qualityId: (await w.quality()).id };
  const post = (b) => w.api('post', '/grey-lots', { ...base, ...b });
  const bad = [
    { inwardMeters: 0, pieces: 1 }, { inwardMeters: -5, pieces: 1 }, { inwardMeters: 'abc', pieces: 1 }, { inwardMeters: 1e12, pieces: 1 },
    { inwardMeters: 100, pieces: -1 }, { inwardMeters: 100, pieces: 1.5 }, { thaans: [] }, { thaans: [0] }, { thaans: [-1, 5] }, { thaans: ['x'] },
    { thaans: Array(2001).fill(1) }, { inwardMeters: 100 }, { inwardMeters: null, pieces: null },
    { inwardMeters: 100, pieces: 1, inwardDate: 'yesterday' }, { inwardMeters: 100, pieces: 1, customerId: 'not-a-uuid' }, { inwardMeters: 100, pieces: 1, evil: 'x' },
  ];
  for (const b of bad) {
    const res = await post(b);
    expect([400, 422]).toContain(res.status);
    expect(res.status).not.toBe(500);
  }
  // tiny meters round to zero: must not create a lot of 0 m
  const tiny = await post({ inwardMeters: 0.004, pieces: 1 });
  expect(tiny.status).toBeGreaterThanOrEqual(400);
  await expectClean();
});

// Was bug AUD-07 (fixed): an impossible date passes validation and the database answers with a 500.
test('impossible dates (2026-02-30, month 13, 0000-00-00) are refused with 400, not a server crash', async () => {
  const w = await world();
  const base = { customerId: (await w.customer()).id, qualityId: (await w.quality()).id, inwardMeters: 100, pieces: 1 };
  for (const d of ['2026-02-30', '2026-13-01', '0000-00-00', '2026-00-10', '2026-04-31']) {
    const res = await w.api('post', '/grey-lots', { ...base, inwardDate: d });
    expect([d, res.status]).toEqual([d, 400]);
  }
  // the same on a date filter
  const res = await w.api('get', '/grey-lots?dateFrom=2026-02-30');
  expect(res.status).toBe(400);
});

// Was bug AUD-08 (fixed): a thaan lot can be edited to a plain total; lot meters then differ from the sum of its thaans.
test('a lot with thaans cannot be edited into a plain total (lot meters would stop matching its thaans)', async () => {
  const w = await world();
  const lot = await w.lot({ thaans: [100, 100, 100], approve: false });
  await w.api('patch', `/grey-lots/${lot.id}`, { inwardMeters: 999, pieces: 3 });
  await expectClean();
});

// Was bug AUD-06 (fixed): reopen + delete removes the list and its gate pass (ON DELETE CASCADE).
test('after the gate pass is made, reopening and deleting the packing list must not erase the gate pass', async () => {
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
  const pl = await w.ok('post', '/departments/PACKING/packing-lists', { soCardId: card.id, rateA: 10, lines: form.lots[0].thaans.map((t) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade: 'A', meters: t.meters })) }, 201);
  await w.ok('post', `/departments/PACKING/packing-lists/${pl.id}/final`);
  await w.ok('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { driverName: 'D', vehicleNo: 'V-1', passDate: '2030-01-01' });
  await w.api('post', `/departments/PACKING/packing-lists/${pl.id}/reopen`);
  await w.api('delete', `/departments/PACKING/packing-lists/${pl.id}`);
  expect((await w.ok('get', '/departments/PACKING/gate-passes')).total).toBe(1);
});

// Was bug AUD-03 (fixed): after such a rejection the cloth trail shows Rs 0 while the store cost screen shows Rs 1000.
test('LOOPHOLE (consequence): chemical cost of a rejected processed job drops out of the cloth cost trail', async () => {
  const w = await world();
  const red = await w.chem('RED');
  await w.buy(red, 100, 10);
  const lot = await w.lot({ meters: 300, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  const j1 = await w.sendCard(card, 'SINGEING');
  await w.accept('SINGEING', j1);
  await w.complete('SINGEING', j1);
  const dy = await w.forward('SINGEING', j1, 'DYEING');
  await w.accept('DYEING', dy);
  await w.status('DYEING', dy, 'PROCESSING');
  await w.give('DYEING', [red]);
  await w.issue('DYEING', dy, [{ itemId: red.id, qty: 100 }]); // Rs 1000 on this cloth
  await w.status('DYEING', dy, 'COMPLETE');
  const step = await w.api('put', `/departments/DYEING/jobs/${dy.id}/status`, { status: 'PENDING' });
  if (step.status !== 200) return; // refused: good
  const rej = await w.api('post', `/departments/DYEING/jobs/${dy.id}/reject`, { reason: 'x' });
  if (rej.status !== 200) return; // refused: good
  await w.ok('post', `/departments/SINGEING/jobs/${dy.id}/reject-answer`, { decision: 'ACCEPT' });
  const again = await w.forward('SINGEING', j1, 'FINISHING');
  await w.accept('FINISHING', again);
  const so = await w.ok('get', `/stores/chemical/cost/so-cards/${card.id}`);
  const rows = (await w.ok('get', '/departments/FINISHING/incoming?view=job')).data;
  // the SO card cost Rs 1000 (stock left the store); the cloth's own trail must show it too
  expect(so.totalValue).toBe(1000);
  expect(rows[0].totalChemicalAmount).toBe(1000);
});

// Was bug AUD-12 (fixed): SO card status / currentDepartment stay at the first department after the cloth moved on.
test('the SO card shows where its cloth is now (status and department follow the jobs)', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 400, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 400 }]);
  expect((await w.ok('get', `/so-cards/${card.id}`)).deliveryText).toBe('Not sent to any department yet');
  const dy = await w.sendCard(card, 'DYEING');
  await w.accept('DYEING', dy);
  await w.complete('DYEING', dy);
  const fold = await w.forward('DYEING', dy, 'FOLDING');
  await w.accept('FOLDING', fold);
  const now = await w.ok('get', `/so-cards/${card.id}`);
  // the cloth is in Folding (accepted): the card must say so, not "Sent to Dyeing (waiting for accept)"
  expect(now.currentDepartment && now.currentDepartment.code).toBe('FOLDING');
  expect(now.deliveryText).toBe('Delivered to Folding');
});

// Was bug AUD-11 (fixed): POST /so-cards/:id/accept answers 500 for a SENT card that has no move record.
test('the old SO card accept call does not crash for a card sent through the job flow', async () => {
  const w = await world();
  const lot = await w.lot({ meters: 400, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 400 }]);
  await w.sendCard(card, 'DYEING');
  const res = await w.api('post', `/so-cards/${card.id}/accept`, {});
  expect(res.status).toBeLessThan(500);
});
