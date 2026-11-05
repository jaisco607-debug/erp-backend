const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

jest.setTimeout(180000);
beforeEach(clean);

async function setup({ store = true } = {}) {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', ...(store ? ['CHEMICAL_STORE'] : [])]) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  if (store) await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const dyer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: dyer.id, serviceId: s.DYEING.id, access: 'FULL' });
  const folder = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: folder.id, serviceId: s.FOLDING.id, access: 'FULL' });
  const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, s, api: call(admin), dyer: call(dyer), folder: call(folder) };
}
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const CHEM = /chemical|costPerMeter/i;
const chemKeys = (v, found = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => chemKeys(x, found));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (CHEM.test(k) || k === 'cost') found.add(k); chemKeys(x, found); }
  return found;
};

test('the client admin decides which departments may request chemicals: a department without it has no chemical screens and no chemical field', async () => {
  const w = await setup();
  // a job in Dyeing and one in Folding
  const cu = (await w.api('post', '/customers', { name: 'AZ' })).body;
  const q = (await w.api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await w.api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [60, 40] })).body;
  await w.api('post', `/grey-lots/${lot.id}/approve`);
  const card = (await w.api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const fd = (await w.api('get', '/jobs/form-data')).body;
  const job = (await w.api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await w.api('post', `/departments/DYEING/jobs/${job.id}/accept`);

  // the settings page of the client admin
  const s0 = (await w.api('get', '/department-settings')).body;
  expect(s0.chemicalStore).toBe(true);
  expect(s0.data.map((d) => [d.code, d.chemicalRequests, d.chemicalEnabled])).toEqual([['DYEING', true, true], ['FOLDING', true, true]]);
  // by default nothing changes: Dyeing has its chemical screens and fields
  expect((await w.dyer('get', '/departments/DYEING/chemicals')).status).toBe(200);
  expect((await w.dyer('get', '/departments/DYEING/chemical-requests')).status).toBe(200);
  const before = (await w.dyer('get', '/departments/DYEING/incoming')).body;
  expect(chemKeys(before.data).size).toBeGreaterThan(0);
  const me0 = (await w.dyer('get', '/auth/me')).body;
  expect(me0.services.find((x) => x.code === 'DYEING')).toMatchObject({ chemicalRequests: true });

  // only the client admin can change it
  err(await w.dyer('patch', '/department-settings/DYEING', { chemicalRequests: false }), 403, 'FORBIDDEN');
  expect((await w.dyer('get', '/department-settings')).status).toBe(403);
  expect((await w.api('patch', '/department-settings/DYEING', { chemicalRequests: 'no' })).status).toBe(400);
  err(await w.api('patch', '/department-settings/NOPE', { chemicalRequests: false }), 404, 'NOT_FOUND');
  const off = (await w.api('patch', '/department-settings/dyeing', { chemicalRequests: false })).body;
  expect(off.data.map((d) => [d.code, d.chemicalRequests, d.chemicalEnabled])).toEqual([['DYEING', false, false], ['FOLDING', true, true]]);

  // Dyeing: no chemical screens ...
  err(await w.dyer('get', '/departments/DYEING/chemicals'), 403, 'CHEMICAL_NOT_ALLOWED');
  err(await w.dyer('get', '/departments/DYEING/chemical-requests'), 403, 'CHEMICAL_NOT_ALLOWED');
  err(await w.dyer('get', '/departments/DYEING/chemical-requests/form-data'), 403, 'CHEMICAL_NOT_ALLOWED');
  err(await w.dyer('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [] }), 400, 'VALIDATION_FAILED');
  err(await w.dyer('get', '/departments/DYEING/chemical-returns'), 403, 'CHEMICAL_NOT_ALLOWED');
  err(await w.dyer('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`), 403, 'CHEMICAL_NOT_ALLOWED');
  // ... and no chemical field with its jobs and SO cards (lists, one job, the actions)
  for (const url of ['/departments/DYEING/incoming', '/departments/DYEING/sent', `/departments/DYEING/jobs/${job.id}`, '/departments/DYEING/incoming?view=so']) {
    const r = await w.dyer('get', url);
    expect([url, r.status]).toEqual([url, 200]);
    expect([url, [...chemKeys(r.body)]]).toEqual([url, []]);
  }
  const acted = await w.dyer('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'PROCESSING' });
  expect(acted.status).toBe(200);
  expect([...chemKeys(acted.body)]).toEqual([]);
  // the job itself is the same: only the chemical fields are missing
  expect((await w.dyer('get', `/departments/DYEING/jobs/${job.id}`)).body).toMatchObject({ id: job.id, jobNo: job.jobNo, status: 'PROCESSING', totalMeters: 100 });
  // the login answer tells the menu
  expect((await w.dyer('get', '/auth/me')).body.services.find((x) => x.code === 'DYEING')).toMatchObject({ chemicalRequests: false });
  // the client admin still sees everything (he is not the department), and Folding is not affected
  expect(chemKeys((await w.api('get', '/departments/DYEING/incoming')).body.data).size).toBeGreaterThan(0);
  expect((await w.folder('get', '/departments/FOLDING/chemicals')).status).toBe(200);
  expect((await w.api('get', '/auth/me')).body.services.find((x) => x.code === 'FOLDING')).toMatchObject({ chemicalRequests: true });

  // switched on again: everything is back; the bulk call works too
  const bulk = (await w.api('put', '/department-settings', { departments: [{ code: 'DYEING', chemicalRequests: true }, { code: 'FOLDING', chemicalRequests: false }] })).body;
  expect(bulk.data.map((d) => [d.code, d.chemicalRequests])).toEqual([['DYEING', true], ['FOLDING', false]]);
  expect((await w.dyer('get', '/departments/DYEING/chemicals')).status).toBe(200);
  expect(chemKeys((await w.dyer('get', '/departments/DYEING/incoming')).body.data).size).toBeGreaterThan(0);
  err(await w.folder('get', '/departments/FOLDING/chemicals'), 403, 'CHEMICAL_NOT_ALLOWED');
  // the change is in the audit log
  const [n] = await sequelize.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DEPARTMENT_CHEMICAL_REQUESTS_CHANGED'`, { type: sequelize.QueryTypes.SELECT });
  expect(n.n).toBe(3);
  expect(card.id).toBeTruthy();
});

test('a company without the Chemical Store (the super admin did not give it) has nothing to switch and no department can request chemicals', async () => {
  const w = await setup({ store: false });
  const s = (await w.api('get', '/department-settings')).body;
  expect(s.chemicalStore).toBe(false);
  expect(s.data.map((d) => [d.code, d.chemicalRequests, d.chemicalEnabled])).toEqual([['DYEING', true, false], ['FOLDING', true, false]]);
  err(await w.api('patch', '/department-settings/DYEING', { chemicalRequests: false }), 422, 'NO_CHEMICAL_STORE');
  expect((await w.dyer('get', '/auth/me')).body.services.find((x) => x.code === 'DYEING')).toMatchObject({ chemicalRequests: false });
  err(await w.dyer('get', '/departments/DYEING/chemicals'), 403, 'CHEMICAL_NOT_ALLOWED');
});
