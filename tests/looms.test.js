const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, YarnBeam } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  for (const code of ['WEAVING_MASTERS', 'SIZING']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'SIZING' } })).id, access: 'VIEW' });
  const api = call(admin);
  const sulzer = (await api('post', '/weaving/departments', { name: 'Sulzer' })).body;
  const airjet = (await api('post', '/weaving/departments', { name: 'Airjet' })).body;
  const beams = [];
  for (let i = 1; i <= 5; i += 1) beams.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  // four of them are full (sized beams of 4,050 m); the fifth stays empty
  await YarnBeam.update({ status: 'FULL', meters: 4050, statusDate: '2026-11-10' }, { where: { id: beams.slice(0, 4).map((b) => b.id) } });
  return { api, viewer: call(viewer), sulzer, airjet, beams };
}
const beamStock = async (w) => (await w.api('get', '/weaving/beam-stock')).body.statuses.map((s) => s.count);

test('loom master (weaving): add / edit / delete rules', async () => {
  const w = await setup();
  const l1 = await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.sulzer.id });
  expect(l1.status).toBe(201);
  expect(l1.body).toMatchObject({ code: 1, loomNo: '001', isActive: true, running: false, beamsOnLoom: 0, canTakeBeams: true, department: { name: 'Sulzer' } });
  err(await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.airjet.id }), 422, 'DUPLICATE_ENTRY');
  err(await w.api('post', '/weaving/looms', { loomNo: '2', departmentId: w.beams[0].id }), 422, 'UNKNOWN_DEPARTMENT');
  const l2 = (await w.api('post', '/weaving/looms', { loomNo: '101', departmentId: w.airjet.id })).body;
  expect((await w.api('get', `/weaving/looms?departmentId=${w.airjet.id}`)).body.data.map((l) => l.loomNo)).toEqual(['101']);
  expect((await w.api('get', '/weaving/looms?search=sulz')).body.total).toBe(1);
  expect((await w.api('patch', `/weaving/looms/${l2.id}`, { departmentId: w.sulzer.id, loomNo: '002' })).body).toMatchObject({ loomNo: '002', department: { name: 'Sulzer' } });
  // a department with looms cannot be deleted
  err(await w.api('delete', `/weaving/departments/${w.sulzer.id}`), 422, 'IN_USE');
  expect((await w.api('delete', `/weaving/looms/${l1.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.sulzer.id })).status).toBe(201); // the number is free again
  expect((await w.viewer('post', '/weaving/looms', { loomNo: '9', departmentId: w.sulzer.id })).status).toBe(403);
});

test('loom beam entry (sizing): K-ID, 2 beams per loom, factor, confirm, cut-off, reopen, delete', async () => {
  const w = await setup();
  const a = (await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.sulzer.id })).body;
  const b = (await w.api('post', '/weaving/looms', { loomNo: '101', departmentId: w.airjet.id })).body;
  const fd = (await w.api('get', '/sizing/loom-beams/form-data')).body;
  expect(fd.factors.map((f) => [f.value, f.text])).toEqual([[1, 'Single panna'], [2, 'Double panna'], [3, 'Triple panna']]);
  expect(fd).toMatchObject({ maxBeams: 2, defaultFactor: 1 });
  expect(fd.looms.map((l) => [l.loomNo, l.roomForBeams])).toEqual([['101', 2], ['001', 2]]);
  const av = (await w.api('get', '/sizing/loom-beams/available-beams')).body;
  expect(av.total).toBe(4); // the empty beam is not offered
  expect(av.data[0]).toMatchObject({ lengthM: 4050, status: 'FULL' });
  expect((await w.api('get', '/sizing/loom-beams/available-beams?search=S2')).body.total).toBe(1);

  // two beams on loom 001, double panna: K-ID 1, not confirmed
  const e = await w.api('post', '/sizing/loom-beams', { loomId: a.id, beamIds: [w.beams[0].id, w.beams[1].id], factor: 2, startDate: '2026-11-12' });
  expect(e.status).toBe(201);
  expect(e.body).toMatchObject({ kId: 1, factor: 2, factorText: 'Double panna', status: 'ACTIVE', isConfirmed: false, warps: 2, beamNos: 'S1|S2', beamLengthM: 8100, netLengthM: 4050, startDate: '2026-11-12', endDate: null,
    loom: { loomNo: '001', department: { name: 'Sulzer' } }, canConfirm: false, canDelete: true, canCutOff: false });
  expect(e.body.readiness).toEqual({ rpm: false, pick: false, reedSpace: false });
  expect(await beamStock(w)).toEqual([1, 2, 2, 0]); // 2 beams are at the loom now
  expect((await w.api('get', `/weaving/looms/${a.id}`)).body).toMatchObject({ running: true, beamsOnLoom: 2, canTakeBeams: false, activeKIds: [1] });
  // a loom takes at most 2 beams; only free (full) beams
  err(await w.api('post', '/sizing/loom-beams', { loomId: a.id, beamIds: [w.beams[2].id] }), 422, 'LOOM_FULL');
  err(await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[4].id] }), 422, 'BEAM_NOT_FREE');
  err(await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[0].id] }), 422, 'BEAM_NOT_FREE'); // already on a loom
  err(await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[2].id], startDate: '2026-11-01' }), 422, 'BEFORE_FULL');
  expect((await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[2].id, w.beams[3].id, w.beams[0].id] })).status).toBe(400); // 3 beams

  const id = e.body.id;
  const url = (s = '') => `/sizing/loom-beams/${id}${s}`;
  // confirm needs rpm, pick and reed space
  err(await w.api('post', url('/confirm')), 422, 'NOT_READY');
  err(await w.api('post', url('/cut-off'), {}), 422, 'NOT_CONFIRMED');
  expect((await w.api('patch', url(), { factor: 1 })).body.factor).toBe(1);
  const p = (await w.api('patch', url(), { factor: 3, loomRpm: 410, loomPick: 60, reedSpace: 61 })).body;
  expect(p).toMatchObject({ factor: 3, factorText: 'Triple panna', loomRpm: 410, loomPick: 60, reedSpace: 61, canConfirm: true });
  expect((await w.api('post', url('/confirm'))).body).toMatchObject({ isConfirmed: true, canDelete: false, canCutOff: true });
  err(await w.api('delete', url()), 422, 'ENTRY_CONFIRMED');
  // the loom cannot be switched off / deleted while it runs or has entries
  err(await w.api('patch', `/weaving/looms/${a.id}`, { isActive: false }), 422, 'LOOM_RUNNING');
  err(await w.api('delete', `/weaving/looms/${a.id}`), 422, 'IN_USE');

  // a second entry on the other loom: a NEW K-ID; one beam only
  const e2 = (await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[2].id], startDate: '2026-11-14', loomRpm: 250, loomPick: 52, reedSpace: 60.5 })).body;
  expect(e2).toMatchObject({ kId: 2, warps: 1, netLengthM: 4050, beamLengthM: 4050, factor: 1 });
  expect((await w.api('delete', `/sizing/loom-beams/${e2.id}`)).body.deleted).toBe(true); // not confirmed: the beam goes back to the stock
  expect(await beamStock(w)).toEqual([1, 2, 2, 0]);
  const e3 = (await w.api('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[2].id, w.beams[3].id] })).body;
  expect(e3.kId).toBe(3); // K-IDs are never used again
  expect((await w.api('get', '/sizing/loom-beams/form-data')).body.looms.map((l) => [l.loomNo, l.canTakeBeams])).toEqual([['101', false], ['001', false]]);

  // lists: counts, totals, idle looms
  const l = (await w.api('get', '/sizing/loom-beams')).body;
  expect(l).toMatchObject({ total: 2, counts: { active: 2, cutOff: 0, notConfirmed: 1 }, totals: { loomsRunning: 2, idleLooms: 0, beamLengthM: 16200 } });
  expect((await w.api('get', `/sizing/loom-beams?departmentId=${w.sulzer.id}`)).body.data.map((x) => x.kId)).toEqual([1]);
  expect((await w.api('get', '/sizing/loom-beams?search=S4')).body.data.map((x) => x.kId)).toEqual([3]);

  // loom cut-off: the beams are empty, the loom idle; undo; cut off again
  err(await w.api('post', url('/cut-off'), { endDate: '2026-11-01' }), 422, 'END_BEFORE_START');
  const c = await w.api('post', url('/cut-off'), { endDate: '2026-11-30' });
  expect(c.body).toMatchObject({ status: 'CUT_OFF', statusText: 'Cut off', endDate: '2026-11-30', canReopen: true, canEdit: false });
  expect(await beamStock(w)).toEqual([3, 0, 2, 0]);
  expect((await w.api('get', '/sizing/loom-beams?status=CUT_OFF')).body).toMatchObject({ total: 1, counts: { active: 1, cutOff: 1 } });
  expect((await w.api('get', '/sizing/loom-beams?status=ACTIVE')).body.idleLooms.map((x) => x.loomNo)).toEqual(['001']);
  err(await w.api('patch', url(), { loomRpm: 1 }), 422, 'ENTRY_CUT_OFF');
  const r = await w.api('post', url('/reopen'));
  expect([r.body.status, r.body.endDate]).toEqual(['ACTIVE', null]);
  expect(await beamStock(w)).toEqual([1, 0, 4, 0]);
  await w.api('post', url('/cut-off'), { endDate: '2026-11-30' });
  expect((await w.api('get', `/weaving/looms/${a.id}`)).body).toMatchObject({ running: false, canTakeBeams: true });
  expect((await w.api('patch', `/weaving/looms/${a.id}`, { isActive: false })).body.isActive).toBe(false);

  // the viewer reads, cannot write
  expect((await w.viewer('get', '/sizing/loom-beams')).body.total).toBe(2);
  expect((await w.viewer('post', '/sizing/loom-beams', { loomId: b.id, beamIds: [w.beams[4].id] })).status).toBe(403);
});

test('loom beam entry: same length per entry, entry without beams, add / take off beams, second entry on a loom', async () => {
  const w = await setup();
  await YarnBeam.update({ status: 'FULL', meters: 3000, statusDate: '2026-11-10' }, { where: { id: w.beams[4].id } }); // a 3,000 m beam
  const a = (await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.sulzer.id })).body;
  const post = (body) => w.api('post', '/sizing/loom-beams', body);
  // two beams of different lengths cannot go together
  err(await post({ loomId: a.id, beamIds: [w.beams[0].id, w.beams[4].id] }), 422, 'BEAM_LENGTH_MISMATCH');
  // the loom is set up without beams first
  const e = await post({ loomId: a.id, factor: 2, loomRpm: 400, loomPick: 50, reedSpace: 60, startDate: '2026-11-12' });
  expect(e.status).toBe(201);
  expect(e.body).toMatchObject({ warps: 0, beamLengthM: 0, canConfirm: false, canAddBeams: true, canRemoveBeams: false });
  expect((await w.api('get', '/sizing/loom-beams')).body.totals.loomsRunning).toBe(0);
  err(await w.api('post', `/sizing/loom-beams/${e.body.id}/confirm`), 422, 'NO_BEAMS');
  const url = (s = '') => `/sizing/loom-beams/${e.body.id}${s}`;
  // beams are added later: one, then a second of the same length; a different length is refused
  expect((await w.api('post', url('/beams'), { beamIds: [w.beams[0].id] })).body).toMatchObject({ warps: 1, beamLengthM: 4050, canConfirm: true });
  err(await w.api('post', url('/beams'), { beamIds: [w.beams[4].id] }), 422, 'BEAM_LENGTH_MISMATCH');
  expect((await w.api('post', url('/beams'), { beamIds: [w.beams[1].id] })).body).toMatchObject({ warps: 2, beamLengthM: 8100, netLengthM: 4050, canAddBeams: false });
  err(await w.api('post', url('/beams'), { beamIds: [w.beams[2].id] }), 422, 'LOOM_FULL');
  // a beam taken off goes back to the stock; a confirmed entry keeps its beams
  expect((await w.api('delete', url(`/beams/${w.beams[1].id}`))).body.warps).toBe(1);
  expect(await beamStock(w)).toEqual([0, 4, 1, 0]);
  // one beam on the loom: a NEW entry (new K-ID) with another beam is possible too
  const e2 = await post({ loomId: a.id, beamIds: [w.beams[2].id], startDate: '2026-11-13' });
  expect(e2.body).toMatchObject({ kId: 2, warps: 1 });
  expect((await w.api('get', '/sizing/loom-beams?loomId=' + a.id)).body.total).toBe(2);
  await w.api('post', url('/confirm'));
  err(await w.api('delete', url(`/beams/${w.beams[0].id}`)), 422, 'ENTRY_CONFIRMED');
});

test('beam half cut: beams back to the stock as full with the meters left, loom free, undo, put on a loom again', async () => {
  const w = await setup();
  const a = (await w.api('post', '/weaving/looms', { loomNo: '001', departmentId: w.sulzer.id })).body;
  const post = (body) => w.api('post', '/sizing/loom-beams', body);
  const e = (await post({ loomId: a.id, beamIds: [w.beams[0].id, w.beams[1].id], loomRpm: 400, loomPick: 50, reedSpace: 60, startDate: '2026-11-12' })).body;
  const url = (s = '') => `/sizing/loom-beams/${e.id}${s}`;
  err(await w.api('post', url('/half-cut'), { leftM: 1000 }), 422, 'NOT_CONFIRMED');
  await w.api('post', url('/confirm'));
  err(await w.api('post', url('/half-cut'), {}), 422, 'LEFT_REQUIRED');
  err(await w.api('post', url('/half-cut'), { leftM: 5000 }), 422, 'LEFT_TOO_LONG');
  err(await w.api('post', url('/half-cut'), { leftM: 1000, endDate: '2026-11-01' }), 422, 'END_BEFORE_START');
  const h = await w.api('post', url('/half-cut'), { endDate: '2026-11-20', beams: [{ beamId: w.beams[0].id, leftM: 1200 }, { beamId: w.beams[1].id, leftM: 1000.5 }] });
  expect(h.body).toMatchObject({ status: 'HALF_CUT', statusText: 'Half cut', endDate: '2026-11-20', canReopen: true, canCutOff: false, canHalfCut: false });
  expect(h.body.beams.map((b) => [b.leftM, b.status])).toEqual([[1200, 'FULL'], [1000.5, 'FULL']]);
  expect(h.body).toMatchObject({ netLengthM: 4050, leftM: 2200.5, leftNetM: 1100.25, estimatedProducedM: 2949.75 }); // the cloth made from the half cut beams
  const done = (await w.api('get', '/sizing/loom-beams?status=COMPLETED')).body;
  expect([done.total, done.counts.completed, done.data[0].estimatedProducedM]).toEqual([1, 1, 2949.75]);
  expect(await beamStock(w)).toEqual([1, 4, 0, 0]); // all back as full beams
  const st = (await w.api('get', '/weaving/beam-stock/FULL')).body.data.find((b) => b.id === w.beams[0].id);
  expect(st).toMatchObject({ halfCut: true, halfCutM: 1200, meters: 1200 });
  expect((await w.api('get', '/sizing/loom-beams/available-beams')).body.data.find((b) => b.id === w.beams[0].id)).toMatchObject({ halfCut: true, lengthM: 1200 });
  expect((await w.api('get', `/weaving/looms/${a.id}`)).body).toMatchObject({ running: false, canTakeBeams: true });
  expect((await w.api('get', '/sizing/loom-beams')).body.counts).toMatchObject({ active: 0, halfCut: 1 });
  // undo: back on the loom with the full length
  expect((await w.api('post', url('/reopen'))).body).toMatchObject({ status: 'ACTIVE', beamLengthM: 8100 });
  expect((await w.api('get', '/weaving/beam-stock/FULL')).body.data.find((b) => b.id === w.beams[2].id).halfCut).toBe(false);
  await w.api('post', url('/half-cut'), { leftM: 900 });
  // a half cut beam goes on a loom again (new K-ID); the badge goes
  const e2 = await post({ loomId: a.id, beamIds: [w.beams[0].id, w.beams[1].id] });
  expect(e2.body).toMatchObject({ kId: 2, beamLengthM: 1800 });
  expect((await w.api('get', '/weaving/beam-stock/AT_LOOM')).body.data.every((b) => !b.halfCut)).toBe(true);
  // deleting that new (not confirmed) entry gives the badge back
  await w.api('delete', `/sizing/loom-beams/${e2.body.id}`);
  expect((await w.api('get', '/weaving/beam-stock/FULL')).body.data.find((b) => b.id === w.beams[0].id)).toMatchObject({ halfCut: true, halfCutM: 900 });
});
