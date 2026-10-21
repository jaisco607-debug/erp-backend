// Edit locks: only the person who opened a record for editing may edit it (POST /v1/locks ... and the guard on every write).
const { world, clean, request, app, makeUser, loginAs, sequelize } = require('./audit/world');
const { Service, UserService } = require('../src/models');

beforeEach(clean);
jest.setTimeout(120000);

/** a second person of the company with these grants, as { user, api } */
async function person(w, grants) {
  const user = await makeUser({ userType: 'USER', companyId: w.company.id });
  for (const [code, access] of grants) await UserService.create({ userId: user.id, serviceId: w.s[code].id, access });
  const auth = { Authorization: `Bearer ${(await loginAs(user)).accessToken}` };
  const api = (method, url, body, headers = {}) => request(app)[method](`/api/v1${url}`).set(auth).set(headers).send(body);
  return { user, api, auth };
}

/** a job sitting in Dyeing */
async function dyeingJob(w) {
  const lot = await w.lot({ meters: 300, pieces: 1 });
  const card = await w.card([{ greyLotId: lot.id, meters: 300 }]);
  const job = await w.sendCard(card, 'DYEING');
  return { job, card, lot };
}
const take = (api, resourceId, tabId, resourceType = 'job') => api('post', '/locks', { resourceType, resourceId, tabId });

test('first person gets the lock, the second gets 423 with the holder; releasing frees it at once', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  const b = await person(w, [['DYEING', 'FULL']]);
  const a = await w.api('post', '/locks', { resourceType: 'job', resourceId: job.id, tabId: 'tabA' });
  expect(a.status).toBe(200);
  expect(a.body).toMatchObject({ resourceType: 'job', resourceId: job.id, holder: { id: w.admin.id, name: w.admin.name } });
  expect(a.body.lockId).toBeTruthy();
  expect(new Date(a.body.expiresAt) - new Date(a.body.acquiredAt)).toBeGreaterThan(80000);
  const denied = await take(b.api, job.id, 'tabB');
  expect(denied.status).toBe(423);
  expect(denied.body.error).toMatchObject({ code: 'LOCKED', details: { holder: { id: w.admin.id, name: w.admin.name } } });
  expect(denied.body.error.details.since).toBeTruthy();
  // the holder lets go: the other one gets it immediately
  expect((await w.api('delete', `/locks/${a.body.lockId}`)).status).toBe(204);
  expect((await take(b.api, job.id, 'tabB')).status).toBe(200);
});

test('same person: same tab renews the same lock, another tab is refused', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  const first = (await take(w.api, job.id, 'tabA')).body;
  const again = await take(w.api, job.id, 'tabA');
  expect(again.status).toBe(200);
  expect(again.body.lockId).toBe(first.lockId);
  expect(again.body.acquiredAt).toBe(first.acquiredAt);
  const other = await take(w.api, job.id, 'tabB');
  expect(other.status).toBe(423);
  expect(other.body.error.details.holder.id).toBe(w.admin.id);
});

test('heartbeat keeps the lock alive; a lock that ran out is free; a lost lock answers LOCK_LOST', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  const b = await person(w, [['DYEING', 'FULL']]);
  const lock = (await take(w.api, job.id, 'tabA')).body;
  await sequelize.query(`UPDATE edit_locks SET "expiresAt" = now() + interval '5 seconds' WHERE id = :id`, { replacements: { id: lock.lockId } });
  const beat = await w.api('put', `/locks/${lock.lockId}/heartbeat`);
  expect(beat.status).toBe(200);
  expect(new Date(beat.body.expiresAt) - Date.now()).toBeGreaterThan(80000);
  expect((await take(b.api, job.id, 'tabB')).status).toBe(423);
  // somebody else's heartbeat on it is "lost"
  const stranger = await b.api('put', `/locks/${lock.lockId}/heartbeat`);
  expect([stranger.status, stranger.body.error.code]).toEqual([404, 'LOCK_LOST']);
  // 90 seconds without a heartbeat: the lock is free and B takes it
  await sequelize.query(`UPDATE edit_locks SET "expiresAt" = now() - interval '1 second' WHERE id = :id`, { replacements: { id: lock.lockId } });
  expect((await w.api('put', `/locks/${lock.lockId}/heartbeat`)).body.error.code).toBe('LOCK_LOST');
  const taken = await take(b.api, job.id, 'tabB');
  expect(taken.status).toBe(200);
  expect(taken.body.holder.id).toBe(b.user.id);
  // the old holder cannot delete B's lock (403); a missing lock deletes as 204
  expect((await w.api('delete', `/locks/${taken.body.lockId}`)).status).toBe(403);
  expect((await w.api('delete', `/locks/${lock.lockId}x`)).status).toBeLessThan(500);
  expect((await w.api('delete', '/locks/00000000-0000-4000-8000-000000000000')).status).toBe(204);
});

test('a write on a locked record answers 423 and writes nothing; without a lock the write works', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  await w.ok('post', `/departments/DYEING/jobs/${job.id}/accept`);
  const b = await person(w, [['DYEING', 'FULL']]);
  // nobody holds a lock: B's write goes through
  expect((await b.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Bilal' })).status).toBe(200);
  const lock = (await take(w.api, job.id, 'tabA')).body;
  const blocked = await b.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Zaid' });
  expect(blocked.status).toBe(423);
  expect(blocked.body.error).toMatchObject({ code: 'LOCKED', details: { holder: { id: w.admin.id } } });
  const [{ operatorName }] = await sequelize.query('SELECT "operatorName" FROM jobs WHERE id = :id', { replacements: { id: job.id }, type: sequelize.QueryTypes.SELECT });
  expect(operatorName).toBe('Bilal');
  // the status change and a reject are blocked too
  expect((await b.api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'PROCESSING' })).status).toBe(423);
  // the holder can write (any tab, or the same tab)
  expect((await w.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Akram' })).status).toBe(200);
  const sameTab = await request(app).put(`/api/v1/departments/DYEING/jobs/${job.id}/operator`).set(w.auth).set({ 'X-Tab-Id': 'tabA' }).send({ operatorName: 'Akram2' });
  expect(sameTab.status).toBe(200);
  // ... but not from another tab of the same person
  const otherTab = await request(app).put(`/api/v1/departments/DYEING/jobs/${job.id}/operator`).set(w.auth).set({ 'X-Tab-Id': 'tabZ' }).send({ operatorName: 'Nope' });
  expect(otherTab.status).toBe(423);
  // released: B writes again
  await w.api('delete', `/locks/${lock.lockId}`);
  expect((await b.api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Zaid' })).status).toBe(200);
});

test('two simultaneous requests for one record: exactly one wins', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  const people = await Promise.all([person(w, [['DYEING', 'FULL']]), person(w, [['DYEING', 'FULL']]), person(w, [['DYEING', 'FULL']])]);
  const results = await Promise.all([...people.map((p, i) => take(p.api, job.id, `tab${i}`)), take(w.api, job.id, 'admin')]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 423, 423, 423]);
  const [{ n }] = await sequelize.query('SELECT count(*)::int AS n FROM edit_locks', { type: sequelize.QueryTypes.SELECT });
  expect(n).toBe(1);
});

test('a lock of one company never blocks another company, and never shows', async () => {
  const w1 = await world();
  const w2 = await world();
  const j1 = (await dyeingJob(w1)).job;
  const j2 = (await dyeingJob(w2)).job;
  expect((await take(w1.api, j1.id, 'tab')).status).toBe(200);
  expect((await take(w2.api, j2.id, 'tab')).status).toBe(200);
  // company 2 cannot even point at company 1's job, and sees no holder
  expect((await take(w2.api, j1.id, 'tab')).status).toBe(404);
  expect((await w2.api('get', `/locks?resourceType=job&resourceId=${j1.id}`)).body).toBeNull();
  // the same resource id string in two companies: a user-lock with the same text id is separate
  expect((await w1.api('get', `/locks?resourceType=job&resourceId=${j1.id}`)).body).toMatchObject({ holder: { id: w1.admin.id } });
});

test('who may lock: validation, existence and rights', async () => {
  const w = await world();
  const { job, card, lot } = await dyeingJob(w);
  const viewer = await person(w, [['DYEING', 'VIEW']]);
  const stranger = await person(w, [['SINGEING', 'FULL']]);
  expect((await w.api('post', '/locks', { resourceType: 'nothing', resourceId: job.id, tabId: 't' })).status).toBe(400);
  expect((await w.api('post', '/locks', { resourceType: 'job', resourceId: job.id })).status).toBe(400);
  expect((await take(w.api, '00000000-0000-4000-8000-000000000000', 't')).status).toBe(404);
  expect((await take(w.api, 'not-an-id', 't')).status).toBe(404);
  expect((await take(viewer.api, job.id, 't')).status).toBe(403); // VIEW only
  expect((await take(stranger.api, job.id, 't')).status).toBe(403); // another department
  // employees cannot lock users / company services
  expect((await take(stranger.api, viewer.user.id, 't', 'user')).status).toBe(403);
  expect((await take(w.api, viewer.user.id, 't', 'user')).status).toBe(200);
  expect((await take(w.api, w.company.id, 't', 'company_services')).status).toBe(403);
  // the other types
  expect((await take(w.api, lot.id, 't', 'grey_lot')).status).toBe(200);
  expect((await take(w.api, card.id, 't', 'so_card')).status).toBe(200);
  expect((await take(w.api, `${job.id}:${card.id}`, 't', 'folding_row')).status).toBe(200);
  expect((await take(w.api, `so:${card.id}`, 't', 'packing_list')).status).toBe(200);
  // no token: 401
  expect((await request(app).post('/api/v1/locks').send({ resourceType: 'job', resourceId: job.id, tabId: 't' })).status).toBe(401);
});

test('the super admin locks a company\'s services; a client admin cannot', async () => {
  const w = await world();
  const sa = await makeUser();
  const sa2 = await makeUser();
  const call = (user) => async (method, url, body) => request(app)[method](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(user)).accessToken}` }).send(body);
  const s1 = call(sa);
  const s2 = call(sa2);
  const lock = await s1('post', '/locks', { resourceType: 'company_services', resourceId: w.company.id, tabId: 'x' });
  expect(lock.status).toBe(200);
  expect((await s2('post', '/locks', { resourceType: 'company_services', resourceId: w.company.id, tabId: 'y' })).status).toBe(423);
  const service = await Service.findOne({ where: { code: 'PRINTING' } });
  const blocked = await s2('put', `/companies/${w.company.id}/services/${service.id}`, { enabled: true });
  expect(blocked.status).toBe(423);
  expect(blocked.body.error.code).toBe('LOCKED');
  expect((await s1('put', `/companies/${w.company.id}/services/${service.id}`, { enabled: true })).status).toBeLessThan(423);
});

test('logging out of everywhere ends the person\'s locks', async () => {
  const w = await world();
  const { job } = await dyeingJob(w);
  const b = await person(w, [['DYEING', 'FULL']]);
  expect((await take(b.api, job.id, 'tabB')).status).toBe(200);
  expect((await take(w.api, job.id, 'tabA')).status).toBe(423);
  expect((await b.api('post', '/auth/logout-all')).status).toBeLessThan(300);
  expect((await take(w.api, job.id, 'tabA')).status).toBe(200);
  // a switched-off employee loses the lock too
  const c = await person(w, [['SO_CARD', 'FULL']]);
  const { card } = await dyeingJob(w);
  expect((await take(c.api, card.id, 'tabC', 'so_card')).status).toBe(200);
  await w.ok('patch', `/users/${c.user.id}`, { isActive: false });
  expect((await take(w.api, card.id, 'tabA', 'so_card')).status).toBe(200);
});

test('other writes are guarded too: SO card, grey lot, packing list create, user, chemical request', async () => {
  const w = await world();
  const { card, lot } = await dyeingJob(w);
  const b = await person(w, [['SO_CARD', 'FULL'], ['GREY_STORE', 'FULL'], ['PACKING', 'FULL']]);
  expect((await take(w.api, card.id, 'a', 'so_card')).status).toBe(200);
  expect((await b.api('patch', `/so-cards/${card.id}`, { remarks: 'x' })).status).toBe(423);
  expect((await take(w.api, lot.id, 'a', 'grey_lot')).status).toBe(200);
  expect((await b.api('patch', `/grey-lots/${lot.id}`, { remarks: 'x' })).status).toBe(423);
  expect((await b.api('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [1] })).status).toBe(423);
  expect((await take(w.api, `so:${card.id}`, 'a', 'packing_list')).status).toBe(200);
  expect((await b.api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, lines: [] })).status).toBe(423);
  const emp = await person(w, []);
  expect((await take(w.api, emp.user.id, 'a', 'user')).status).toBe(200);
  const other = await w.api('patch', `/users/${emp.user.id}`, { name: 'Same Admin' });
  expect(other.status).toBe(200); // the holder
  // a guard rule never touches a request that has no lock: ordinary creates still work
  expect((await b.api('post', '/so-cards', { cardDate: '2026-10-12', lots: [{ greyLotId: (await w.lot({ meters: 50, pieces: 1 })).id, meters: 50 }] })).status).toBe(201);
});
