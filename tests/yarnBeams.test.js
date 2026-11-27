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

test('beams: add with the next number or a typed one, name and date (default today); change; delete; unique number', async () => {
  const w = await setup();
  const nx = (await w.api('get', '/weaving/beams/next')).body;
  expect(nx.beamNo).toBe(1);
  expect(nx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const a = await w.api('post', '/weaving/beams', { name: '  Beam   A ', beamDate: '2026-11-10' });
  expect(a.status).toBe(201);
  expect(a.body).toMatchObject({ beamNo: 1, beamLabel: '00001', name: 'Beam A', beamDate: '2026-11-10', isActive: true });
  const b = await w.api('post', '/weaving/beams', { name: 'Beam B' }); // number and date automatic
  expect([b.body.beamNo, b.body.beamDate]).toEqual([2, nx.date]);
  const c = await w.api('post', '/weaving/beams', { beamNo: 50, name: 'Typed number', beamDate: '2026-11-11' });
  expect(c.body.beamNo).toBe(50);
  expect((await w.api('get', '/weaving/beams/next')).body.beamNo).toBe(51);
  // a typed number that is used
  const dup = await w.api('post', '/weaving/beams', { beamNo: 2, name: 'Again' });
  err(dup, 422, 'BEAM_NO_TAKEN');
  expect(dup.body.error.details).toEqual({ field: 'beamNo' });
  // the same name is fine (the number is the identity)
  expect((await w.api('post', '/weaving/beams', { name: 'beam a' })).status).toBe(201);

  // validation
  expect((await w.api('post', '/weaving/beams', {})).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: '   ' })).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: 'x'.repeat(81) })).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: 'N', beamNo: 0 })).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: 'N', beamDate: '2026-13-40' })).status).toBe(400);

  // update: name, date, number (its own number again is fine, another beam's is not), switch
  const u = await w.api('patch', `/weaving/beams/${a.body.id}`, { name: 'Beam A1', beamDate: '2026-11-20', beamNo: 1 });
  expect(u.body).toMatchObject({ beamNo: 1, name: 'Beam A1', beamDate: '2026-11-20' });
  err(await w.api('patch', `/weaving/beams/${a.body.id}`, { beamNo: 2 }), 422, 'BEAM_NO_TAKEN');
  expect((await w.api('patch', `/weaving/beams/${a.body.id}`, { beamNo: 7 })).body.beamNo).toBe(7);
  expect((await w.api('patch', `/weaving/beams/${b.body.id}`, { isActive: false })).body.isActive).toBe(false);
  expect((await w.api('patch', `/weaving/beams/${b.body.id}`, {})).status).toBe(400);

  // list, search, filters
  const all = (await w.api('get', '/weaving/beams')).body;
  expect(all.data.map((x) => x.beamNo)).toEqual([2, 7, 50, 51]);
  expect(all.total).toBe(4);
  expect((await w.api('get', '/weaving/beams?search=typed')).body.data.map((x) => x.beamNo)).toEqual([50]);
  expect((await w.api('get', '/weaving/beams?search=50')).body.data.map((x) => x.beamNo)).toEqual([50]);
  expect((await w.api('get', '/weaving/beams?isActive=false')).body.data.map((x) => x.beamNo)).toEqual([2]);
  expect((await w.api('get', '/weaving/beams?dateFrom=2026-11-15&dateTo=2026-11-24')).body.data.map((x) => x.beamNo)).toEqual([7]);
  expect((await w.viewer('get', `/weaving/beams/${c.body.id}`)).body.name).toBe('Typed number');
  expect((await w.viewer('post', '/weaving/beams', { name: 'V' })).status).toBe(403);
  expect((await w.viewer('delete', `/weaving/beams/${c.body.id}`)).status).toBe(403);

  // delete: hidden, the number can be typed again, the automatic number does not go back
  expect((await w.api('delete', `/weaving/beams/${c.body.id}`)).body.deleted).toBe(true);
  err(await w.api('get', `/weaving/beams/${c.body.id}`), 404, 'NOT_FOUND');
  expect((await w.api('post', '/weaving/beams', { beamNo: 50, name: 'Back' })).status).toBe(201);
  expect((await w.api('get', '/weaving/beams/next')).body.beamNo).toBe(52);
});

test('beams: two people adding at the same moment get different numbers; another company has its own beams', async () => {
  const w = await setup();
  const rs = await Promise.all([1, 2, 3, 4].map((i) => w.api('post', '/weaving/beams', { name: `B${i}` })));
  expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
  expect(rs.map((r) => r.body.beamNo).sort()).toEqual([1, 2, 3, 4]);
  const a = (await w.api('get', '/weaving/beams')).body.data[0];
  const other = await makeCompany();
  await CompanyService.create({ companyId: other.id, serviceId: w.svc.id });
  const oa = call(await makeUser({ userType: 'CLIENT_ADMIN', companyId: other.id }));
  expect((await oa('get', '/weaving/beams')).body.total).toBe(0);
  expect((await oa('post', '/weaving/beams', { name: 'Mine', beamNo: 1 })).body.beamNo).toBe(1);
  err(await oa('get', `/weaving/beams/${a.id}`), 404, 'NOT_FOUND');
  err(await oa('patch', `/weaving/beams/${a.id}`, { name: 'x' }), 404, 'NOT_FOUND');
  err(await oa('delete', `/weaving/beams/${a.id}`), 404, 'NOT_FOUND');
});
