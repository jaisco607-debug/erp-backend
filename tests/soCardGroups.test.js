const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

async function setup() {
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
  const red = (await api('post', '/colours', { name: 'RED' })).body;
  const blue = (await api('post', '/colours', { name: 'BLUE' })).body;
  const lot = async (thaans) => {
    const l = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans })).body;
    await api('post', `/grey-lots/${l.id}/approve`);
    return l;
  };
  return { s, api, red, blue, lot, cu };
}
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const base = { cardDate: '2026-10-15' };

test('one SO card with sub-categories (parts): thaans of one lot shared out between parts with a colour tag each; the rest stays in the grey store; the old way still works', async () => {
  const w = await setup();
  const lot = await w.lot([100, 100, 100, 100, 100, 100]);
  const made = await w.api('post', '/so-cards', { ...base, groups: [
    { label: 'Red part', colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] },
    { colourId: w.blue.id, remarks: 'for the border', lots: [{ greyLotId: lot.id, thaanNos: [3, 4] }] },
  ] });
  expect(made.status).toBe(201);
  const card = made.body;
  expect(card).toMatchObject({ hasGroups: true, totalMeters: 400, totalPieces: 4, status: 'NEW' });
  expect(card.groups).toHaveLength(2);
  expect(card.groups[0]).toMatchObject({ code: 'A', label: 'Red part', title: 'Red part', tag: `${card.cardLabel}-A`, colour: { name: 'RED' }, totalMeters: 200, totalThaans: 2, sentMeters: 0, leftMeters: 200, status: 'NOT_SENT', canSend: true });
  expect(card.groups[0].lots[0].thaans.map((t) => [t.thaanNo, t.meters])).toEqual([[1, 100], [2, 100]]);
  expect(card.groups[1]).toMatchObject({ code: 'B', label: null, title: 'Part B', colour: { name: 'BLUE' }, remarks: 'for the border', totalMeters: 200 });
  // the lot has two lines on the card (one per part), each knows its part
  expect(card.lots).toHaveLength(2);
  expect(card.lots.map((l) => [l.groupCode, l.meters, l.thaanNos])).toEqual([['A', 200, [1, 2]], ['B', 200, [3, 4]]]);
  // the grey lot: 4 thaans on the card, the other 2 stay in the store
  const g = (await w.api('get', `/grey-lots/${lot.id}`)).body;
  expect(g).toMatchObject({ outwardMeters: 400, balanceMeters: 200 });
  expect(g.thaans.map((t) => [t.thaanNo, t.status])).toEqual([[1, 'SO_CARD'], [2, 'SO_CARD'], [3, 'SO_CARD'], [4, 'SO_CARD'], [5, 'IN_STOCK'], [6, 'IN_STOCK']]);

  // the old way is untouched: no groups
  const other = await w.lot([50, 60]);
  const plain = (await w.api('post', '/so-cards', { ...base, lots: [{ greyLotId: other.id, thaanNos: [1, 2] }] })).body;
  expect(plain).toMatchObject({ hasGroups: false, groups: [], totalMeters: 110 });
  expect(plain.lots[0]).toMatchObject({ groupId: null, groupCode: null });

  // wrong requests
  err(await w.api('post', '/so-cards', { ...base, lots: [{ greyLotId: lot.id, thaanNos: [5] }], groups: [{ lots: [{ greyLotId: lot.id, thaanNos: [5] }] }] }), 400, 'VALIDATION_FAILED');
  err(await w.api('post', '/so-cards', { ...base }), 400, 'VALIDATION_FAILED');
  err(await w.api('post', '/so-cards', { ...base, groups: [{ colourId: '8f3c1a2e-1111-4222-8333-444455556666', lots: [{ greyLotId: lot.id, thaanNos: [5] }] }] }), 422, 'UNKNOWN_COLOUR');
  err(await w.api('post', '/so-cards', { ...base, groups: [{ label: 'Same', lots: [{ greyLotId: lot.id, thaanNos: [5] }] }, { label: 'same', lots: [{ greyLotId: lot.id, thaanNos: [6] }] }] }), 422, 'GROUP_LABEL_TAKEN');
  // a thaan cannot be taken whole by two parts
  err(await w.api('post', '/so-cards', { ...base, groups: [{ lots: [{ greyLotId: lot.id, thaanNos: [5] }] }, { lots: [{ greyLotId: lot.id, thaanNos: [5, 6] }] }] }), 422, 'THAAN_NOT_IN_STOCK');
  // nothing was taken by the refused ones
  expect((await w.api('get', `/grey-lots/${lot.id}`)).body.balanceMeters).toBe(200);
  // parts can take the rest of the lot: 5 and 6 each in its own part
  const rest = await w.api('post', '/so-cards', { ...base, groups: [{ colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [5] }] }, { colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [6] }] }] });
  expect(rest.status).toBe(201);
  expect((await w.api('get', `/grey-lots/${lot.id}`)).body.balanceMeters).toBe(0);
});

test('one thaan cut into parts by meters, and the meters of a lot without thaans, are counted across the parts', async () => {
  const w = await setup();
  const lot = await w.lot([1000, 500]);
  // thaan 1 (1000 m) is cut 400 + 600; the 500 m thaan goes with the second part
  const ok = await w.api('post', '/so-cards', { ...base, groups: [
    { colourId: w.red.id, lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 400 }] }] },
    { colourId: w.blue.id, lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 600 }, { thaanNo: 2 }] }] },
  ] });
  expect(ok.status).toBe(201);
  expect(ok.body.groups.map((x) => [x.code, x.totalMeters, x.totalThaans])).toEqual([['A', 400, 1], ['B', 1100, 2]]);
  expect(ok.body.groups[1].lots[0].thaans.map((t) => [t.thaanNo, t.meters, t.thaanMeters])).toEqual([[1, 600, 1000], [2, 500, 500]]);
  const g = (await w.api('get', `/grey-lots/${lot.id}`)).body;
  expect(g.thaans.map((t) => [t.thaanNo, t.takenMeters, t.status])).toEqual([[1, 1000, 'SO_CARD'], [2, 500, 'SO_CARD']]);
  // asking more than the thaan has across the parts is refused with what is free
  const lot2 = await w.lot([1000]);
  const short = await w.api('post', '/so-cards', { ...base, groups: [{ lots: [{ greyLotId: lot2.id, thaans: [{ thaanNo: 1, meters: 700 }] }] }, { lots: [{ greyLotId: lot2.id, thaans: [{ thaanNo: 1, meters: 700 }] }] }] });
  err(short, 422, 'THAAN_SHORT');
  expect(short.body.error.details).toMatchObject({ thaanNo: 1, freeMeters: 300 });
  expect((await w.api('get', `/grey-lots/${lot2.id}`)).body.thaans[0].takenMeters).toBe(0);
});

test('parts are sent on by themselves or together; the colour tag goes with the cloth and Dyeing can change it per part; parts of one thaan travel in separate jobs', async () => {
  const w = await setup();
  const lot = await w.lot([100, 100, 100, 100]);
  const card = (await w.api('post', '/so-cards', { ...base, groups: [
    { label: 'Red', colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] },
    { label: 'Blue', colourId: w.blue.id, lots: [{ greyLotId: lot.id, thaanNos: [3] }] },
    { label: 'Plain', lots: [{ greyLotId: lot.id, thaanNos: [4] }] },
  ] })).body;
  // the send screen knows the parts and their colour tag
  const rows = (await w.api('get', '/jobs/form-data')).body.rows;
  expect(rows.map((r) => [r.group.code, r.group.title, r.group.tag, r.colour && r.colour.name, r.meters])).toEqual([
    ['A', 'Red', `${card.cardLabel}-A`, 'RED', 200], ['B', 'Blue', `${card.cardLabel}-B`, 'BLUE', 100], ['C', 'Plain', `${card.cardLabel}-C`, null, 100]]);
  // send ONLY the red part to Dyeing (the normal send call, the row of the part): the job carries the colour tag and the part
  const j1 = await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: rows[0].soCardLotId }] });
  expect(j1.status).toBe(201);
  expect(j1.body.items[0]).toMatchObject({ meters: 200, colour: { name: 'RED' }, group: { code: 'A', title: 'Red', tag: `${card.cardLabel}-A`, colour: { name: 'RED' } } });
  expect(j1.body.items[0].thaans.map((t) => t.thaanNo)).toEqual([1, 2]);
  let c = (await w.api('get', `/so-cards/${card.id}`)).body;
  expect(c.groups.map((x) => [x.code, x.status, x.sentMeters, x.leftMeters, x.canSend, x.department && x.department.code])).toEqual([['A', 'SENT', 200, 0, false, 'DYEING'], ['B', 'NOT_SENT', 0, 100, true, null], ['C', 'NOT_SENT', 0, 100, true, null]]);
  expect(c.lots.find((l) => l.groupCode === 'A')).toMatchObject({ sentMeters: 200, leftMeters: 0 });
  // send the blue part by the card call, and then "the rest of the card" (no parts named = everything that is left)
  const s2 = await w.api('post', `/so-cards/${card.id}/send-groups`, { departmentId: w.s.DYEING.id, groupIds: [c.groups[1].id] });
  expect(s2.status).toBe(200);
  expect(s2.body).toMatchObject({ jobCount: 1, sentMeters: 100 });
  expect(s2.body.jobs[0].items[0]).toMatchObject({ colour: { name: 'BLUE' }, group: { code: 'B' } });
  err(await w.api('post', `/so-cards/${card.id}/send-groups`, { departmentId: w.s.DYEING.id, groupIds: [c.groups[1].id] }), 422, 'NOTHING_LEFT');
  err(await w.api('post', `/so-cards/${card.id}/send-groups`, { departmentId: w.s.DYEING.id, groupIds: ['8f3c1a2e-1111-4222-8333-444455556666'] }), 422, 'UNKNOWN_GROUP');
  const s3 = await w.api('post', `/so-cards/${card.id}/send-groups`, { departmentId: w.s.FOLDING.id });
  expect(s3.body).toMatchObject({ jobCount: 1, sentMeters: 100 });
  expect(s3.body.jobs[0].items[0]).toMatchObject({ colour: null, group: { code: 'C' } });
  c = (await w.api('get', `/so-cards/${card.id}`)).body;
  expect(c.groups.map((x) => x.status)).toEqual(['SENT', 'SENT', 'SENT']);
  expect(await w.api('get', '/jobs/form-data').then((r) => r.body.rows)).toEqual([]);

  // Dyeing accepts and changes the colour of ONE part (a row), not the whole SO card
  const jobId = j1.body.id;
  await w.api('post', `/departments/DYEING/jobs/${jobId}/accept`);
  const both = (await w.api('post', '/so-cards/send-many', { soCardIds: [], departmentId: w.s.DYEING.id })).status; // refused: nothing sent here
  expect(both).toBe(400);
  const green = (await w.api('post', '/colours', { name: 'GREEN' })).body;
  const changed = await w.api('put', `/departments/DYEING/jobs/${jobId}/colour`, { colourId: green.id, jobItemId: j1.body.items[0].id });
  expect(changed.status).toBe(200);
  expect(changed.body.items[0].colour.name).toBe('GREEN');
  expect(changed.body.items[0].group.colour.name).toBe('RED'); // the tag made at the SO card stays as it was
  err(await w.api('put', `/departments/DYEING/jobs/${jobId}/colour`, { colourId: green.id, jobItemId: '8f3c1a2e-1111-4222-8333-444455556666' }), 422, 'SO_NOT_IN_JOB');
  expect((await w.api('put', `/departments/DYEING/jobs/${jobId}/colour`, { colourId: green.id, jobItemId: j1.body.items[0].id, soCardId: card.id })).status).toBe(400);
});

test('parts cut from one thaan: not in one job (separate jobs), the whole card goes as several jobs, and Packing sees the thaan once with all its meters', async () => {
  const w = await setup();
  const lot = await w.lot([1000]);
  const card = (await w.api('post', '/so-cards', { ...base, groups: [
    { colourId: w.red.id, lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 400 }] }] },
    { colourId: w.blue.id, lots: [{ greyLotId: lot.id, thaans: [{ thaanNo: 1, meters: 600 }] }] },
  ] })).body;
  const rows = (await w.api('get', '/jobs/form-data')).body.rows;
  // both parts in one job: refused with the thaan
  const both = await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: rows.map((r) => ({ soCardLotId: r.soCardLotId })) });
  err(both, 422, 'SPLIT_THAAN_IN_ONE_JOB');
  expect(both.body.error.details.thaans[0]).toMatchObject({ thaanNo: 1 });
  // the card call sends both, as two jobs
  const sent = await w.api('post', `/so-cards/${card.id}/send-groups`, { departmentId: w.s.DYEING.id });
  expect(sent.body).toMatchObject({ jobCount: 2, sentMeters: 1000 });
  expect(sent.body.jobs.map((j) => [j.items[0].group.code, j.items[0].meters, j.items[0].colour.name])).toEqual([['A', 400, 'RED'], ['B', 600, 'BLUE']]);
  expect(sent.body.jobs[0].jobNo).not.toBe(sent.body.jobs[1].jobNo);

  // each job goes on to Folding and Packing like any job
  for (const job of sent.body.jobs) {
    await w.api('post', `/departments/DYEING/jobs/${job.id}/accept`);
    await w.api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' });
    await w.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  }
  const form = (await w.api('get', '/departments/DYEING/send-form')).body;
  expect(form.rows).toHaveLength(2);
  // one Folding job per Dyeing job (separate jobs again, the parts are never in one job)
  const folds = [];
  for (const row of form.rows) folds.push((await w.api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: row.jobItemId }] })).body);
  const packJobs = [];
  for (const fold of folds) {
    await w.api('post', `/departments/FOLDING/jobs/${fold.id}/accept`);
    const frow = (await w.api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`)).body;
    const line = frow.lots[0].lines[0];
    expect(line.received).toBe(fold.items[0].meters);
    const graded = await w.api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [{ greyLotId: lot.id, thaanId: line.thaanId, a: line.received }] });
    expect(graded.status).toBe(200);
    const pack = await w.api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false });
    expect(pack.status).toBe(201);
    packJobs.push(pack.body.packingJob);
  }
  for (const p of packJobs) await w.api('post', `/departments/PACKING/jobs/${p.id}/accept`);
  // Packing: the thaan is ONE thaan with all its 1000 m and what Folding sent for both parts
  const f = (await w.api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`)).body;
  expect(f.lots[0]).toMatchObject({ thaanCount: 1, meters: 1000 });
  expect(f.lots[0].thaans).toHaveLength(1);
  expect(f.lots[0].thaans[0]).toMatchObject({ thaanNo: 1, meters: 1000, folding: { a: 1000, b: 0, cp: 0 } });
  expect(f.lots[0].thaans[0].suggestedLines).toEqual([expect.objectContaining({ grade: 'A', meters: 1000 })]);

  // sending a whole card with parts from the create call: the parts of one thaan become two jobs, the rest one
  const lot2 = await w.lot([100, 100, 100]);
  const made = await w.api('post', '/so-cards', { ...base, departmentId: w.s.DYEING.id, groups: [
    { colourId: w.red.id, lots: [{ greyLotId: lot2.id, thaans: [{ thaanNo: 1, meters: 40 }, { thaanNo: 2 }] }] },
    { colourId: w.blue.id, lots: [{ greyLotId: lot2.id, thaans: [{ thaanNo: 1, meters: 60 }, { thaanNo: 3 }] }] },
  ] });
  expect(made.status).toBe(201);
  const jobs = (await w.api('get', '/departments/DYEING/incoming')).body.data.filter((j) => j.items.some((i) => i.soCard.id === made.body.id));
  expect(jobs).toHaveLength(2);
  expect(jobs.map((j) => j.totalMeters).sort((a, b) => a - b)).toEqual([140, 160]);
});

test('a card with parts can be changed while it is new (parts replaced, or back to plain lots) and cancelled: every thaan goes back to the grey store', async () => {
  const w = await setup();
  const lot = await w.lot([100, 100, 100, 100]);
  const card = (await w.api('post', '/so-cards', { ...base, groups: [
    { colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] },
    { colourId: w.blue.id, lots: [{ greyLotId: lot.id, thaanNos: [3] }] },
  ] })).body;
  expect((await w.api('get', `/so-cards/${card.id}/edit-data`)).body.card.groups).toHaveLength(2);
  // new parts: thaan 4 and thaan 1 in one part each; the old parts and their thaans are replaced
  const edited = await w.api('patch', `/so-cards/${card.id}`, { groups: [
    { label: 'First', colourId: w.blue.id, lots: [{ greyLotId: lot.id, thaanNos: [1] }] },
    { label: 'Second', colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [4] }] },
  ] });
  expect(edited.status).toBe(200);
  expect(edited.body.groups.map((x) => [x.code, x.title, x.totalMeters, x.colour.name])).toEqual([['A', 'First', 100, 'BLUE'], ['B', 'Second', 100, 'RED']]);
  expect(edited.body.totalMeters).toBe(200);
  expect((await w.api('get', `/grey-lots/${lot.id}`)).body.thaans.map((t) => t.status)).toEqual(['SO_CARD', 'IN_STOCK', 'IN_STOCK', 'SO_CARD']);
  err(await w.api('patch', `/so-cards/${card.id}`, { lots: [{ greyLotId: lot.id, thaanNos: [2] }], groups: [{ lots: [{ greyLotId: lot.id, thaanNos: [2] }] }] }), 400, 'VALIDATION_FAILED');
  // back to a plain card
  const plain = await w.api('patch', `/so-cards/${card.id}`, { lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] });
  expect(plain.body).toMatchObject({ hasGroups: false, groups: [], totalMeters: 200 });
  expect(plain.body.lots[0].groupId).toBeNull();
  // and to parts again
  const again = await w.api('patch', `/so-cards/${card.id}`, { groups: [{ colourId: w.red.id, lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4] }] }] });
  expect(again.body.groups).toHaveLength(1);
  expect((await w.api('get', `/grey-lots/${lot.id}`)).body.balanceMeters).toBe(0);
  // a part sent on locks the card (meters cannot change any more), as before
  const rows = (await w.api('get', '/jobs/form-data')).body.rows;
  await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: rows[0].soCardLotId }] });
  err(await w.api('patch', `/so-cards/${card.id}`, { groups: [{ lots: [{ greyLotId: lot.id, thaanNos: [1] }] }] }), 422, 'CARD_SENT');

  // cancel a new card with parts: everything is free again
  const lot2 = await w.lot([100, 100]);
  const c2 = (await w.api('post', '/so-cards', { ...base, groups: [{ lots: [{ greyLotId: lot2.id, thaanNos: [1] }] }, { lots: [{ greyLotId: lot2.id, thaanNos: [2] }] }] })).body;
  expect((await w.api('get', `/grey-lots/${lot2.id}`)).body.balanceMeters).toBe(0);
  expect((await w.api('delete', `/so-cards/${c2.id}`)).status).toBe(204);
  const after = (await w.api('get', `/grey-lots/${lot2.id}`)).body;
  expect(after.balanceMeters).toBe(200);
  expect(after.thaans.map((t) => t.status)).toEqual(['IN_STOCK', 'IN_STOCK']);
});
