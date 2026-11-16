const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

jest.setTimeout(180000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const svc = await Service.findOne({ where: { code: 'WEAVING_MASTERS' } });
  await CompanyService.create({ companyId: company.id, serviceId: svc.id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: svc.id, access: 'VIEW' });
  return { company, svc, api: call(admin), viewer: call(viewer) };
}

test('beam stock: 30 beams in four places; counts; click a place for its beams with the dates; places are set on the beam form', async () => {
  const w = await setup();
  // a new beam is empty, since its own date
  const e = await w.api('post', '/weaving/beams', { name: 'New one', beamDate: '2026-10-01' });
  expect(e.body).toMatchObject({ status: 'EMPTY', statusText: 'Empty', statusDate: '2026-10-01' });

  // the unit's beams: 20 at loom, 3 more empty (4 with the first), 4 full, 2 at sizing (sent on different days)
  for (let i = 0; i < 20; i += 1) await w.api('post', '/weaving/beams', { name: `L${i + 1}`, beamDate: '2026-09-01', status: 'AT_LOOM', statusDate: '2026-09-05' });
  for (let i = 0; i < 3; i += 1) await w.api('post', '/weaving/beams', { name: `E${i + 1}`, beamDate: '2026-09-01' });
  for (let i = 0; i < 4; i += 1) await w.api('post', '/weaving/beams', { name: `F${i + 1}`, beamDate: '2026-09-01', status: 'FULL' });
  const s1 = (await w.api('post', '/weaving/beams', { beamNo: 101, name: 'Sizing A', beamDate: '2026-09-01', status: 'AT_SIZING', statusDate: '2026-11-03' })).body;
  const s2 = (await w.api('post', '/weaving/beams', { beamNo: 102, name: 'Sizing B', beamDate: '2026-09-01', status: 'AT_SIZING', statusDate: '2026-11-01' })).body;

  const st = (await w.api('get', '/weaving/beam-stock')).body;
  expect(st.total).toBe(30);
  expect(st.statuses).toEqual([
    { status: 'EMPTY', text: 'Empty', count: 4 }, { status: 'FULL', text: 'Full', count: 4 },
    { status: 'AT_LOOM', text: 'At loom', count: 20 }, { status: 'AT_SIZING', text: 'At sizing', count: 2 }]);

  // click "at sizing": which beams, their number and name, and since when (oldest first)
  const sz = (await w.api('get', '/weaving/beam-stock/AT_SIZING')).body;
  expect(sz).toMatchObject({ status: 'AT_SIZING', text: 'At sizing', count: 2 });
  expect(sz.data.map((b) => [b.beamNo, b.beamLabel, b.name, b.statusDate])).toEqual([[102, '00102', 'Sizing B', '2026-11-01'], [101, '00101', 'Sizing A', '2026-11-03']]);
  expect(sz.data[0]).toMatchObject({ id: s2.id, beamDate: '2026-09-01', status: 'AT_SIZING', statusText: 'At sizing' });
  expect(typeof sz.data[0].daysInStatus).toBe('number');
  // click "empty": the 4 empty beams
  const em = (await w.api('get', '/weaving/beam-stock/EMPTY')).body;
  expect(em.count).toBe(4);
  expect(em.data.map((b) => b.name).sort()).toEqual(['E1', 'E2', 'E3', 'New one']);
  expect((await w.api('get', '/weaving/beam-stock/EMPTY?search=e2')).body.data.map((b) => b.name)).toEqual(['E2']);
  expect((await w.api('get', '/weaving/beam-stock/at_loom')).body.count).toBe(20);
  expect((await w.api('get', '/weaving/beam-stock/BROKEN')).status).toBe(400);
  expect((await w.viewer('get', '/weaving/beam-stock')).status).toBe(200);

  // the master list can filter by place too
  expect((await w.api('get', '/weaving/beams?status=FULL&limit=50')).body.total).toBe(4);

  // moving a beam on the form: a new place without a date is since today; the stock follows
  const moved = await w.api('patch', `/weaving/beams/${s1.id}`, { status: 'FULL' });
  expect(moved.body.status).toBe('FULL');
  expect(moved.body.statusDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const st2 = (await w.api('get', '/weaving/beam-stock')).body;
  expect(st2.statuses.map((x) => x.count)).toEqual([4, 5, 20, 1]);
  // the same place keeps its date; a date can be corrected
  expect((await w.api('patch', `/weaving/beams/${s2.id}`, { name: 'Sizing B2' })).body.statusDate).toBe('2026-11-01');
  expect((await w.api('patch', `/weaving/beams/${s2.id}`, { statusDate: '2026-11-02' })).body.statusDate).toBe('2026-11-02');
  // a date before the beam itself is refused
  err(await w.api('patch', `/weaving/beams/${s2.id}`, { statusDate: '2026-08-01' }), 422, 'STATUS_BEFORE_BEAM');
  err(await w.api('post', '/weaving/beams', { name: 'X', beamDate: '2026-11-05', statusDate: '2026-11-01' }), 422, 'STATUS_BEFORE_BEAM');
  expect((await w.api('post', '/weaving/beams', { name: 'X', status: 'LOST' })).status).toBe(400);

  // a switched-off or deleted beam is not in the stock
  await w.api('patch', `/weaving/beams/${s2.id}`, { isActive: false });
  expect((await w.api('get', '/weaving/beam-stock')).body.total).toBe(29);
  await w.api('delete', `/weaving/beams/${e.body.id}`);
  const st3 = (await w.api('get', '/weaving/beam-stock')).body;
  expect([st3.total, st3.statuses[0].count, st3.statuses[3].count]).toEqual([28, 3, 0]);
  expect((await w.api('get', '/weaving/beam-stock/AT_SIZING')).body).toMatchObject({ count: 0, data: [] });

  // another company has its own stock
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/beam-stock')).body.total).toBe(0);
  expect((await oa('get', '/weaving/beam-stock/AT_LOOM')).body.count).toBe(0);
});
