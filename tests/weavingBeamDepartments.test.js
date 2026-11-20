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
  return { company, api: call(admin), viewer: call(viewer) };
}

test('Department master: a unique name per company, running code, switch off, delete only when no beam uses it', async () => {
  const w = await setup();
  const a = await w.api('post', '/weaving/departments', { name: '  Weaving   A ' });
  expect([a.status, a.body.code, a.body.name, a.body.isActive]).toEqual([201, 1, 'Weaving A', true]);
  const b = await w.api('post', '/weaving/departments', { name: 'Sizing Shed' });
  expect(b.body.code).toBe(2);
  err(await w.api('post', '/weaving/departments', { name: 'weaving a' }), 422, 'DUPLICATE_ENTRY');
  expect((await w.api('get', '/weaving/departments')).body.data.map((d) => d.name)).toEqual(['Weaving A', 'Sizing Shed']);
  expect((await w.api('get', '/weaving/departments?search=shed')).body.total).toBe(1);
  expect((await w.api('patch', `/weaving/departments/${b.body.id}`, { name: 'Sizing' })).body.name).toBe('Sizing');
  err(await w.api('patch', `/weaving/departments/${b.body.id}`, { name: 'WEAVING A' }), 422, 'DUPLICATE_ENTRY');
  expect((await w.viewer('get', '/weaving/departments')).status).toBe(200);
  expect((await w.viewer('post', '/weaving/departments', { name: 'Zed' })).status).toBe(403);
  // a department with a beam cannot be deleted; without it can; a deleted name is free again
  const beam = (await w.api('post', '/weaving/beams', { name: 'B1', departmentId: a.body.id })).body;
  const used = await w.api('delete', `/weaving/departments/${a.body.id}`);
  err(used, 422, 'IN_USE');
  expect(used.body.error.details).toMatchObject({ beams: 1 });
  expect((await w.api('patch', `/weaving/departments/${a.body.id}`, { isActive: false })).body.isActive).toBe(false);
  await w.api('delete', `/weaving/beams/${beam.id}`);
  expect((await w.api('delete', `/weaving/departments/${a.body.id}`)).body.deleted).toBe(true);
  expect((await w.api('post', '/weaving/departments', { name: 'Weaving A' })).status).toBe(201);
  // another company has its own list
  const o = await setup();
  expect((await o.api('get', '/weaving/departments')).body.total).toBe(0);
});

test('beam: weight in kg and a department picked from the master; filters', async () => {
  const w = await setup();
  const d1 = (await w.api('post', '/weaving/departments', { name: 'Weaving A' })).body;
  const d2 = (await w.api('post', '/weaving/departments', { name: 'Weaving B' })).body;
  const off = (await w.api('post', '/weaving/departments', { name: 'Old shed', isActive: false })).body;
  const a = await w.api('post', '/weaving/beams', { name: 'Wrap Beam 1', beamDate: '2026-11-10', weightKg: 52.5, departmentId: d1.id });
  expect(a.status).toBe(201);
  expect(a.body).toMatchObject({ beamNo: 1, weightKg: 52.5, departmentId: d1.id, department: { id: d1.id, code: 1, name: 'Weaving A' } });
  // both are optional
  const plain = (await w.api('post', '/weaving/beams', { name: 'Plain' })).body;
  expect([plain.weightKg, plain.departmentId, plain.department]).toEqual([null, null, null]);
  // rules
  err(await w.api('post', '/weaving/beams', { name: 'X', departmentId: '11111111-1111-4111-8111-111111111111' }), 422, 'UNKNOWN_DEPARTMENT');
  err(await w.api('post', '/weaving/beams', { name: 'X', departmentId: off.id }), 422, 'DEPARTMENT_INACTIVE');
  expect((await w.api('post', '/weaving/beams', { name: 'X', weightKg: 0 })).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: 'X', weightKg: -3 })).status).toBe(400);
  expect((await w.api('post', '/weaving/beams', { name: 'X', departmentId: 'abc' })).status).toBe(400);
  const other = await setup();
  const od = (await other.api('post', '/weaving/departments', { name: 'Theirs' })).body;
  err(await w.api('post', '/weaving/beams', { name: 'X', departmentId: od.id }), 422, 'UNKNOWN_DEPARTMENT'); // another company's department
  // change and clear
  const e1 = await w.api('patch', `/weaving/beams/${a.body.id}`, { departmentId: d2.id, weightKg: 60 });
  expect([e1.body.department.name, e1.body.weightKg]).toEqual(['Weaving B', 60]);
  const e2 = await w.api('patch', `/weaving/beams/${a.body.id}`, { departmentId: null, weightKg: null });
  expect([e2.body.department, e2.body.departmentId, e2.body.weightKg]).toEqual([null, null, null]);
  await w.api('patch', `/weaving/beams/${a.body.id}`, { departmentId: d1.id });
  // a beam of a department switched off later still shows it; it can stay on the beam
  await w.api('patch', `/weaving/departments/${d1.id}`, { isActive: false });
  expect((await w.api('get', `/weaving/beams/${a.body.id}`)).body.department.name).toBe('Weaving A');
  expect((await w.api('patch', `/weaving/beams/${a.body.id}`, { name: 'Renamed' })).body.department.name).toBe('Weaving A');
  err(await w.api('patch', `/weaving/beams/${plain.id}`, { departmentId: d1.id }), 422, 'DEPARTMENT_INACTIVE');
  // list: shows department and weight, filters by department / no department
  const list = (await w.api('get', '/weaving/beams')).body;
  expect(list.data.map((b) => [b.beamNo, b.department && b.department.name, b.weightKg])).toEqual([[1, 'Weaving A', null], [2, null, null]]);
  expect((await w.api('get', `/weaving/beams?departmentId=${d1.id}`)).body.data.map((b) => b.beamNo)).toEqual([1]);
  expect((await w.api('get', '/weaving/beams?noDepartment=true')).body.data.map((b) => b.beamNo)).toEqual([2]);
});

test('beam stock: how many beams each department has, in every place, with the weight; details by department', async () => {
  const w = await setup();
  const d1 = (await w.api('post', '/weaving/departments', { name: 'Weaving A' })).body;
  const d2 = (await w.api('post', '/weaving/departments', { name: 'Weaving B' })).body;
  const empty = (await w.api('post', '/weaving/departments', { name: 'Empty shed' })).body;
  const mk = async (name, extra) => (await w.api('post', '/weaving/beams', { name, beamDate: '2026-11-01', ...extra })).body;
  const b1 = await mk('A1', { departmentId: d1.id, weightKg: 50 });
  const b2 = await mk('A2', { departmentId: d1.id, weightKg: 52.5 });
  const b3 = await mk('A3', { departmentId: d1.id });
  const b4 = await mk('B1', { departmentId: d2.id, weightKg: 40 });
  await mk('N1', { weightKg: 10 }); // no department
  await w.api('patch', `/weaving/beams/${b2.id}`, { status: 'FULL' });
  await w.api('patch', `/weaving/beams/${b3.id}`, { status: 'AT_LOOM' });
  await w.api('patch', `/weaving/beams/${b4.id}`, { isActive: false }); // switched off: not in the stock
  const st = (await w.api('get', '/weaving/beam-stock')).body;
  expect(st).toMatchObject({ total: 4, totalWeightKg: 112.5 });
  expect(st.statuses.map((s) => [s.status, s.count, s.weightKg])).toEqual([['EMPTY', 2, 60], ['FULL', 1, 52.5], ['AT_LOOM', 1, 0], ['AT_SIZING', 0, 0]]);
  expect(st.departments.map((d) => [d.department && d.department.name, d.total, d.weightKg])).toEqual([['Empty shed', 0, 0], ['Weaving A', 3, 102.5], ['Weaving B', 0, 0], [null, 1, 10]]);
  const a = st.departments.find((d) => d.department && d.department.name === 'Weaving A');
  expect(a.statuses.map((s) => [s.status, s.count])).toEqual([['EMPTY', 1], ['FULL', 1], ['AT_LOOM', 1], ['AT_SIZING', 0]]);
  expect(a.department).toMatchObject({ id: d1.id, code: 1 });
  // details: the beams of one place, with department and weight; filtered by department / no department
  const full = (await w.api('get', '/weaving/beam-stock/FULL')).body;
  expect(full).toMatchObject({ count: 1, weightKg: 52.5 });
  expect(full.data[0]).toMatchObject({ beamNo: b2.beamNo, weightKg: 52.5, department: { name: 'Weaving A' } });
  expect((await w.api('get', `/weaving/beam-stock/EMPTY?departmentId=${d1.id}`)).body.data.map((b) => b.name)).toEqual(['A1']);
  expect((await w.api('get', '/weaving/beam-stock/EMPTY?noDepartment=true')).body.data.map((b) => [b.name, b.department])).toEqual([['N1', null]]);
  expect((await w.api('get', `/weaving/beam-stock/EMPTY?departmentId=${d2.id}`)).body.count).toBe(0);
  // the empty beams that can go to sizing show their department too
  expect((await w.api('get', '/weaving/yarn-sizing/beams')).body.data.find((b) => b.id === b1.id).department.name).toBe('Weaving A');
  // a switched-off department with beams is still listed
  await w.api('patch', `/weaving/departments/${empty.id}`, { isActive: false });
  await w.api('patch', `/weaving/departments/${d2.id}`, { isActive: false });
  const after = (await w.api('get', '/weaving/beam-stock')).body.departments.map((d) => d.department && d.department.name);
  expect(after).toEqual(['Weaving A', null]); // the two switched-off ones have no (active) beams
  expect((await w.viewer('get', '/weaving/beam-stock')).status).toBe(200);
});
