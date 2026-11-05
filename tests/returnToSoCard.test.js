const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(180000);
beforeEach(clean);

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  // three SO cards of 100 m each (own grey lot each)
  const cards = [];
  for (let i = 0; i < 3; i += 1) {
    const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [60, 40] })).body;
    await api('post', `/grey-lots/${lot.id}/approve`);
    cards.push((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body);
  }
  return { company, s, api, cards };
}
const rowsOf = async (api) => (await api('get', '/jobs/form-data')).body.rows;
const send = async (api, s, cardIds, dep = 'DYEING') => {
  const rows = await rowsOf(api);
  const items = cardIds.map((id) => ({ soCardLotId: rows.find((r) => r.soCard.id === id).soCardLotId }));
  const r = await api('post', '/jobs', { departmentId: s[dep].id, items });
  expect(r.status).toBe(201);
  return r.body;
};
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

test('a department sends cloth that came from an SO card back to the SO card desk: the whole job, one of two SO cards, or none', async () => {
  const { s, api, cards } = await setup();
  const [c1, c2, c3] = cards;
  // card 1 and card 2 go together in one job; card 3 goes on its own
  const job = await send(api, s, [c1.id, c2.id]);
  const single = await send(api, s, [c3.id]);
  expect(job).toMatchObject({ status: 'IN_WAY', canReturnToSoCard: true, canReject: false, totalMeters: 200 });
  expect(await rowsOf(api)).toEqual([]); // everything is sent
  expect((await api('get', `/so-cards/${c1.id}`)).body.status).toBe('SENT');

  // return ONLY card 1: it moves to a job of its own (new Job#) which is marked returned; card 2 stays in the job
  const r = await api('post', `/departments/DYEING/jobs/${job.id}/return-to-so-card`, { soCardIds: [c1.id], reason: 'Wrong department' });
  expect(r.status).toBe(200);
  expect(r.body.returned).toEqual([expect.objectContaining({ jobId: job.id, whole: false, meters: 100, rows: 1 })]);
  expect(r.body.returned[0].returnedJobNo).toBeGreaterThan(single.jobNo);
  expect(r.body.soCards).toEqual([expect.objectContaining({ id: c1.id, status: 'NEW', backAtSoCard: true })]);
  const [stay, back] = r.body.jobs;
  expect(stay).toMatchObject({ id: job.id, status: 'IN_WAY', totalMeters: 100, canReturnToSoCard: true, returnedToSoCard: false });
  expect(stay.items.map((i) => i.soCard.id)).toEqual([c2.id]);
  expect(back).toMatchObject({ status: 'REJECTED', statusText: 'Returned to SO Card', returnedToSoCard: true, returnReason: 'Wrong department', returnedFromJobId: job.id, totalMeters: 100,
    canReturnToSoCard: false, canReject: false, canUndoReject: false, isRejected: false });
  expect(back.items.map((i) => i.soCard.id)).toEqual([c1.id]);
  // card 1 is back at the SO card desk: free to send again (to any department), card 2 and 3 are still with Dyeing
  expect((await rowsOf(api)).map((x) => x.soCard.id)).toEqual([c1.id]);
  expect((await api('get', `/so-cards/${c1.id}`)).body).toMatchObject({ status: 'NEW', deliveryText: 'Not sent to any department yet' });
  expect((await api('get', `/so-cards/${c2.id}`)).body.status).toBe('SENT');
  // the returned job is final and leaves the department's working list (it is under "sent")
  err(await api('put', `/departments/DYEING/jobs/${back.id}/status`, { status: 'QUEUE' }), 422, 'JOB_RETURNED');
  const active = (await api('get', '/departments/DYEING/incoming')).body.data.map((j) => j.id);
  expect(active).toEqual(expect.arrayContaining([job.id, single.id]));
  expect(active).not.toContain(back.id);
  expect((await api('get', '/departments/DYEING/incoming?show=sent')).body.data.map((j) => j.id)).toContain(back.id);
  // the SO card desk sees it in its sent list as returned
  expect((await api('get', '/jobs?side=out')).body.data.find((j) => j.id === back.id).statusText).toBe('Returned to SO Card');

  // send card 1 again to another department: it works like any card
  const again = await send(api, s, [c1.id], 'FOLDING');
  expect(again.status).toBe('IN_WAY');

  // return nothing: nothing changes (the department just accepts the job)
  expect((await api('post', `/departments/DYEING/jobs/${job.id}/accept`)).status).toBe(200);
  const j2 = (await api('get', `/departments/DYEING/jobs/${job.id}`)).body;
  expect(j2).toMatchObject({ status: 'PENDING', canReturnToSoCard: true });

  // return the rest of the job: the whole job is marked, no new job
  const all = await api('post', `/departments/DYEING/jobs/${job.id}/return-to-so-card`, { all: true });
  expect(all.status).toBe(200);
  expect(all.body.returned).toEqual([expect.objectContaining({ whole: true, jobId: job.id, returnedJobId: job.id, meters: 100 })]);
  expect(all.body.jobs).toHaveLength(1);
  expect(all.body.jobs[0]).toMatchObject({ status: 'REJECTED', returnedToSoCard: true, statusText: 'Returned to SO Card', returnReason: null });
  expect((await rowsOf(api)).map((x) => x.soCard.id)).toEqual([c2.id]);
  // the same job cannot be returned twice
  err(await api('post', `/departments/DYEING/jobs/${job.id}/return-to-so-card`, { all: true }), 422, 'CANNOT_RETURN');

  // several jobs at once, by rows: card 2 (free again, sent to Dyeing once more) and the single job of card 3
  const job3 = await send(api, s, [c2.id]);
  const bulk = await api('post', '/departments/DYEING/return-to-so-card', { jobItemIds: [job3.items[0].id, single.items[0].id], reason: 'Not needed' });
  expect(bulk.status).toBe(200);
  expect(bulk.body.returned.map((x) => x.whole)).toEqual([true, true]);
  expect(bulk.body.soCards.map((x) => x.backAtSoCard)).toEqual([true, true]);
  expect((await rowsOf(api)).map((x) => x.soCard.id).sort()).toEqual([c2.id, c3.id].sort());
  // a card that is back can be edited again (it is not "sent")
  expect((await api('get', `/so-cards/${c3.id}`)).body.status).toBe('NEW');
});

test('what cannot be returned: cloth from another department, cloth already in processing, wrong rows, wrong department', async () => {
  const { s, api, cards } = await setup();
  const [c1, c2, c3] = cards;
  const a = await send(api, s, [c1.id]);
  const b = await send(api, s, [c2.id]);
  // in processing: no
  await api('post', `/departments/DYEING/jobs/${a.id}/accept`);
  expect((await api('put', `/departments/DYEING/jobs/${a.id}/status`, { status: 'PROCESSING' })).status).toBe(200);
  err(await api('post', `/departments/DYEING/jobs/${a.id}/return-to-so-card`, { all: true }), 422, 'CANNOT_RETURN');
  expect((await api('get', `/departments/DYEING/jobs/${a.id}`)).body.canReturnToSoCard).toBe(false);
  // cloth that came from Dyeing is not SO card cloth: Folding cannot return it (it rejects it instead)
  await api('put', `/departments/DYEING/jobs/${a.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/DYEING/jobs/${a.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' });
  const form = (await api('get', '/departments/DYEING/send-form')).body;
  const fold = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  expect(fold.canReturnToSoCard).toBe(false);
  err(await api('post', `/departments/FOLDING/jobs/${fold.id}/return-to-so-card`, { all: true }), 422, 'NOT_FROM_SO_CARD');
  // a row of another job / department
  err(await api('post', `/departments/DYEING/jobs/${b.id}/return-to-so-card`, { jobItemIds: [a.items[0].id] }), 422, 'NOT_IN_JOB');
  err(await api('post', `/departments/DYEING/jobs/${b.id}/return-to-so-card`, { soCardIds: [c1.id] }), 422, 'ROWS_REQUIRED');
  err(await api('post', '/departments/FOLDING/return-to-so-card', { jobItemIds: [b.items[0].id] }), 422, 'JOB_WRONG_DEPARTMENT');
  // the body must say what to return
  expect((await api('post', `/departments/DYEING/jobs/${b.id}/return-to-so-card`, {})).status).toBe(400);
  // card 2 is still with Dyeing, untouched
  expect((await api('get', `/so-cards/${c2.id}`)).body.status).toBe('SENT');
  expect((await rowsOf(api)).map((x) => x.soCard.id)).toEqual([c3.id]); // only the card never sent
});
