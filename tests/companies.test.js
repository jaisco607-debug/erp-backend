const { app, request, sequelize, clean, makeUser, loginAs, PASSWORD } = require('./helpers');
const { Service, AuditLog } = require('../src/models');
const { superAdminCode } = require('../src/services/loginCodeService');

beforeEach(clean);
afterAll(() => sequelize.close());

async function asSuperAdmin() {
  const me = await makeUser();
  const { accessToken } = await loginAs(me);
  return { me, auth: { Authorization: `Bearer ${accessToken}` } };
}

const serviceIds = async (...codes) => (await Service.findAll({ where: { code: codes } })).map((s) => s.id);

/** Registers a company (no services) and then gives it services from the company side. */
async function register(auth, body = {}, services = ['DYEING', 'FOLDING']) {
  const res = await request(app).post('/api/v1/companies').set(auth).send({
    name: 'Waqas Textile',
    admin: { name: 'Waqas', email: 'waqas@test.com', password: 'Waqas-Pass-123' },
    ...body,
  });
  if (res.status !== 201 || !services.length) return res;
  return request(app).put(`/api/v1/companies/${res.body.id}/services`).set(auth).send({ serviceIds: await serviceIds(...services) });
}

const login = (body) => request(app).post('/api/v1/auth/login').send(body);

test('the services list is ready from the start', async () => {
  const { auth } = await asSuperAdmin();
  const res = await request(app).get('/api/v1/services').set(auth);
  expect(res.status).toBe(200);
  expect(res.body.data.map((s) => s.code)).toEqual(expect.arrayContaining(['GREY_STORE', 'DYEING', 'FOLDING', 'PRINTING', 'GATE_PASS']));
});

const CODE = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

test('registering a company makes a random code and its first client admin, with NO services', async () => {
  const { auth } = await asSuperAdmin();
  const res = await register(auth, {}, []);
  expect(res.status).toBe(201);
  expect(res.body.code).toMatch(CODE);
  expect(res.body.services.map((x) => x.code).sort()).toEqual([]);
  const withServices = await request(app).post('/api/v1/companies').set(auth)
    .send({ name: 'X Mills', serviceIds: [], admin: { name: 'Xx', email: 'x@test.com', password: 'Xxxxx-Pass-123' } });
  expect(withServices.status).toBe(400);
  expect(res.body.clientAdmins[0]).toMatchObject({ email: 'waqas@test.com', userType: 'CLIENT_ADMIN' });
  expect(JSON.stringify(res.body)).not.toMatch(/Waqas-Pass|\$2[aby]\$/);

  // same name again: another random code
  const second = await register(auth, { admin: { name: 'Other', email: 'other@test.com', password: 'Other-Pass-123' } }, []);
  expect(second.body.code).toMatch(CODE);
  expect(second.body.code).not.toBe(res.body.code);

  // the super admin cannot choose or edit the code
  expect((await register(auth, { name: 'Another', code: 'ABCD-EFGH' })).status).toBe(400);
  expect((await request(app).patch(`/api/v1/companies/${res.body.id}`).set(auth).send({ code: 'ABCD-EFGH' })).status).toBe(400);

  const actions = (await AuditLog.findAll()).map((a) => a.action);
  expect(actions).toEqual(expect.arrayContaining(['COMPANY_CREATED', 'CLIENT_ADMIN_CREATED']));
});

test('client admins log in with company code + email + password; super admins with their own code', async () => {
  const { me, auth } = await asSuperAdmin();
  const { code } = (await register(auth)).body;

  // typed in small letters, without the dash: still found
  const ok = await login({ companyCode: code.toLowerCase().replace('-', ''), email: 'waqas@test.com', password: 'Waqas-Pass-123' });
  expect(ok.status).toBe(200);
  expect(ok.body.user.userType).toBe('CLIENT_ADMIN');
  expect(ok.body.company).toMatchObject({ name: 'Waqas Textile', code });
  expect(ok.body.services).toEqual([
    expect.objectContaining({ code: 'DYEING', name: 'Dyeing', kind: 'PROCESS', access: 'FULL' }),
    expect.objectContaining({ code: 'FOLDING', name: 'Folding', kind: 'FOLDING', access: 'FULL' }),
  ]);

  // with a wrong code or the super admins' code: refused with the same message
  for (const body of [
    { companyCode: await superAdminCode(), email: 'waqas@test.com', password: 'Waqas-Pass-123' },
    { companyCode: 'ZZZZ-ZZZZ', email: 'waqas@test.com', password: 'Waqas-Pass-123' },
  ]) {
    const res = await login(body);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Company code, email or password is incorrect');
  }

  // a super admin cannot log in through a company code
  expect((await login({ companyCode: code, email: me.email, password: PASSWORD })).status).toBe(401);
  const sa = await login({ companyCode: await superAdminCode(), email: me.email, password: PASSWORD });
  expect(sa.status).toBe(200);
  expect(sa.body).toMatchObject({ company: null, services: [] });
});

test('the same email can be used in two companies and by a super admin', async () => {
  const { auth } = await asSuperAdmin();
  const alpha = (await register(auth, { name: 'Alpha Mills', admin: { name: 'Alpha Admin', email: 'same@test.com', password: 'Alpha-Pass-123' } })).body;
  const beta = (await register(auth, { name: 'Beta Mills', admin: { name: 'Beta Admin', email: 'same@test.com', password: 'Beta-Pass-1234' } })).body;
  const sameSa = await request(app).post('/api/v1/super-admins').set(auth).send({ name: 'Same', email: 'same@test.com', password: 'Super-Pass-123' });
  expect(sameSa.status).toBe(201);

  expect((await login({ companyCode: alpha.code, email: 'same@test.com', password: 'Alpha-Pass-123' })).body.company.name).toBe('Alpha Mills');
  expect((await login({ companyCode: beta.code, email: 'same@test.com', password: 'Beta-Pass-1234' })).body.company.name).toBe('Beta Mills');
  expect((await login({ companyCode: await superAdminCode(), email: 'same@test.com', password: 'Super-Pass-123' })).body.user.userType).toBe('SUPER_ADMIN');
});

test('changing a company\'s services changes what its client admin sees at once', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const admin = (await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).body;
  const adminAuth = { Authorization: `Bearer ${admin.accessToken}` };

  const res = await request(app).put(`/api/v1/companies/${company.id}/services`).set(auth).send({ serviceIds: await serviceIds('GREY_STORE', 'DYEING') });
  expect(res.status).toBe(200);
  const me = await request(app).get('/api/v1/auth/me').set(adminAuth);
  expect(me.body.services.map((s) => s.code)).toEqual(['GREY_STORE', 'DYEING']);

  const log = await AuditLog.findOne({ where: { action: 'COMPANY_SERVICES_CHANGED' }, order: [['id', 'DESC']] });
  expect(log.before.services).toEqual(['DYEING', 'FOLDING']);
  expect(log.after.services).toEqual(['DYEING', 'GREY_STORE']);

  const unknown = await request(app).put(`/api/v1/companies/${company.id}/services`).set(auth).send({ serviceIds: ['11111111-1111-4111-8111-111111111111'] });
  expect(unknown.status).toBe(422);
});

test('switching a service off removes it from every company menu', async () => {
  const { auth } = await asSuperAdmin();
  const created = await request(app).post('/api/v1/services').set(auth).send({ code: 'test_wash', name: 'Washing' });
  expect(created.status).toBe(201);
  expect(created.body.code).toBe('TEST_WASH');

  const company = (await register(auth, {}, ['DYEING', 'TEST_WASH'])).body;
  const admin = (await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).body;
  expect(admin.services.map((s) => s.code)).toEqual(['DYEING', 'TEST_WASH']);

  await request(app).patch(`/api/v1/services/${created.body.id}`).set(auth).send({ isActive: false }).expect(200);
  const me = await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${admin.accessToken}` });
  expect(me.body.services.map((s) => s.code)).toEqual(['DYEING']);
});

test('switching a company off logs all its people out at once', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const admin = (await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).body;

  const off = await request(app).patch(`/api/v1/companies/${company.id}`).set(auth).send({ isActive: false });
  expect(off.body.isActive).toBe(false);
  expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${admin.accessToken}` })).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: admin.refreshToken })).status).toBe(401);
  expect((await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).status).toBe(401);

  await request(app).patch(`/api/v1/companies/${company.id}`).set(auth).send({ isActive: true }).expect(200);
  expect((await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).status).toBe(200);
});

test('a new code replaces the old one: the old code stops working', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const res = await request(app).post(`/api/v1/companies/${company.id}/new-code`).set(auth);
  expect(res.status).toBe(200);
  expect(res.body.code).toMatch(CODE);
  expect(res.body.code).not.toBe(company.code);
  expect((await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).status).toBe(401);
  expect((await login({ companyCode: res.body.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).status).toBe(200);
  const log = await AuditLog.findOne({ where: { action: 'COMPANY_CODE_CHANGED' } });
  expect(log.before.code).toBe(company.code);
  expect(log.after.code).toBe(res.body.code);
});

test('only super admins manage companies and services', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const admin = (await login({ companyCode: company.code, email: 'waqas@test.com', password: 'Waqas-Pass-123' })).body;
  const adminAuth = { Authorization: `Bearer ${admin.accessToken}` };
  expect((await request(app).get('/api/v1/companies').set(adminAuth)).status).toBe(403);
  expect((await request(app).post(`/api/v1/companies/${company.id}/new-code`).set(adminAuth)).status).toBe(403);
  expect((await request(app).put(`/api/v1/companies/${company.id}/services`).set(adminAuth).send({ serviceIds: [] })).status).toBe(403);
  expect((await request(app).post('/api/v1/services').set(adminAuth).send({ code: 'TEST_X', name: 'X x' })).status).toBe(403);
});

test('company list and details', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const list = await request(app).get('/api/v1/companies?search=waqas').set(auth);
  expect(list.body.total).toBe(1);
  expect(list.body.data[0]).toMatchObject({ code: company.code, serviceCount: 2, userCount: 1 }); // DYEING + FOLDING; the 5 modules are not counted;
  // the super admin can also search by code
  expect((await request(app).get(`/api/v1/companies?search=${company.code}`).set(auth)).body.total).toBe(1);
  const one = await request(app).get(`/api/v1/companies/${company.id}`).set(auth);
  expect(one.body).toMatchObject({ name: 'Waqas Textile', userCount: 1 });
});

test('one service can be given to many companies at once, and taken back', async () => {
  const { auth } = await asSuperAdmin();
  const a = (await register(auth, { name: 'Alpha Mills', admin: { name: 'Alpha Admin', email: 'a@test.com', password: 'Alpha-Pass-123' } }, [])).body;
  const b = (await register(auth, { name: 'Beta Mills', admin: { name: 'Beta Admin', email: 'b@test.com', password: 'Beta-Pass-1234' } }, ['DYEING'])).body;
  const [printing] = await serviceIds('PRINTING');

  const give = await request(app).put(`/api/v1/services/${printing}/companies`).set(auth).send({ companyIds: [a.id, b.id] });
  expect(give.status).toBe(200);
  expect(give.body.companies.map((c) => c.name)).toEqual(['Alpha Mills', 'Beta Mills']);

  const betaAdmin = (await login({ companyCode: b.code, email: 'b@test.com', password: 'Beta-Pass-1234' })).body;
  expect(betaAdmin.services.map((s) => s.code)).toEqual(['DYEING', 'PRINTING']);

  const takeBack = await request(app).put(`/api/v1/services/${printing}/companies`).set(auth).send({ companyIds: [] });
  expect(takeBack.body.companies).toEqual([]);
  const me = await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${betaAdmin.accessToken}` });
  expect(me.body.services.map((s) => s.code)).toEqual(['DYEING']);
  expect((await request(app).get(`/api/v1/services/${printing}/companies`).set(auth)).body.companies).toEqual([]);

  // a switched-off service cannot be given
  await request(app).patch(`/api/v1/services/${printing}`).set(auth).send({ isActive: false }).expect(200);
  const off = await request(app).put(`/api/v1/services/${printing}/companies`).set(auth).send({ companyIds: [a.id] });
  expect(off.status).toBe(422);
  expect(off.body.error.code).toBe('SERVICE_INACTIVE');
  expect(await AuditLog.count({ where: { action: 'SERVICE_COMPANIES_CHANGED' } })).toBe(2);
});

test('a company\'s services can be emptied', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const res = await request(app).put(`/api/v1/companies/${company.id}/services`).set(auth).send({ serviceIds: [] });
  expect(res.body.services).toEqual([]);
});

test('one toggle gives or takes one service', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth, {}, [])).body;
  const [dyeing, grey] = await serviceIds('DYEING', 'GREY_STORE').then(async () => [
    (await Service.findOne({ where: { code: 'DYEING' } })).id, (await Service.findOne({ where: { code: 'GREY_STORE' } })).id]);
  const on = await request(app).put(`/api/v1/companies/${company.id}/services/${dyeing}`).set(auth).send({ enabled: true });
  expect(on.status).toBe(200);
  expect(on.body.services.map((x) => x.code)).toContain('DYEING');
  const again = await request(app).put(`/api/v1/companies/${company.id}/services/${dyeing}`).set(auth).send({ enabled: true });
  expect(again.body.services.length).toBe(on.body.services.length);
  const off = await request(app).put(`/api/v1/companies/${company.id}/services/${grey}`).set(auth).send({ enabled: false });
  expect(off.body.services.map((x) => x.code)).not.toContain('GREY_STORE');
  expect(off.body.services.map((x) => x.code)).toContain('DYEING');
  expect((await request(app).put(`/api/v1/companies/${company.id}/services/${dyeing}`).set(auth).send({})).status).toBe(400);
});

test('the services list can leave out modules', async () => {
  const { auth } = await asSuperAdmin();
  const res = await request(app).get('/api/v1/services?kind=PROCESS,FOLDING').set(auth);
  expect(res.status).toBe(200);
  expect(res.body.data.length).toBeGreaterThan(5);
  expect(res.body.data.every((s) => s.kind !== 'MODULE')).toBe(true);
  expect((await request(app).get('/api/v1/services?kind=PROCESS&kind=FOLDING').set(auth)).body.data.length).toBe(res.body.data.length);
  expect((await request(app).get('/api/v1/services?kind=XYZ').set(auth)).status).toBe(400);
});

test('super admin edits a client admin, resets the password, and deletes a company', async () => {
  const { auth } = await asSuperAdmin();
  const company = (await register(auth)).body;
  const adminId = company.clientAdmins[0].id;
  const ed = await request(app).patch(`/api/v1/companies/${company.id}/admins/${adminId}`).set(auth).send({ name: 'Waqas Owais', email: 'new@test.com' });
  expect(ed.status).toBe(200);
  expect(ed.body).toMatchObject({ name: 'Waqas Owais', email: 'new@test.com' });
  await request(app).post(`/api/v1/companies/${company.id}/admins/${adminId}/reset-password`).set(auth).send({ newPassword: 'Fresh-Pass-123' }).expect(204);
  const session = await login({ companyCode: company.code, email: 'new@test.com', password: 'Fresh-Pass-123' });
  expect(session.status).toBe(200);

  await request(app).delete(`/api/v1/companies/${company.id}`).set(auth).expect(204);
  expect((await request(app).get(`/api/v1/companies/${company.id}`).set(auth)).status).toBe(404);
  expect((await request(app).get('/api/v1/companies').set(auth)).body.total).toBe(0);
  expect((await login({ companyCode: company.code, email: 'new@test.com', password: 'Fresh-Pass-123' })).status).toBe(401);
  expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${session.body.accessToken}` })).status).toBe(401);
  expect(await AuditLog.count({ where: { action: 'COMPANY_DELETED' } })).toBe(1);
});

test('service screen: checkbox list marks companies that already have the service, and adding skips them', async () => {
  const { auth } = await asSuperAdmin();
  const a = (await register(auth, { name: 'Alpha Mills', admin: { name: 'Alpha Admin', email: 'a@test.com', password: 'Alpha-Pass-123' } }, [])).body;
  const b = (await register(auth, { name: 'Beta Mills', admin: { name: 'Beta Admin', email: 'b@test.com', password: 'Beta-Pass-1234' } }, [])).body;
  const [printing] = await serviceIds('PRINTING');
  const [grey] = await serviceIds('GREY_STORE');
  await request(app).put(`/api/v1/companies/${a.id}/services/${printing}`).set(auth).send({ enabled: true });

  const opts = await request(app).get(`/api/v1/services/${printing}/company-options`).set(auth);
  expect(opts.status).toBe(200);
  expect(opts.body.companies.map((c) => [c.name, c.hasService])).toEqual([['Alpha Mills', true], ['Beta Mills', false]]);

  const add = await request(app).post(`/api/v1/services/${printing}/companies`).set(auth).send({ companyIds: [a.id, b.id] });
  expect(add.status).toBe(200);
  expect(add.body.added).toEqual([b.id]);
  expect(add.body.alreadyGiven).toEqual([a.id]);
  expect(add.body.companies.map((c) => c.name)).toEqual(['Alpha Mills', 'Beta Mills']);

  const mod = await request(app).post(`/api/v1/services/${grey}/companies`).set(auth).send({ companyIds: [b.id] });
  // modules are given like any other service now (nothing is given automatically)
  expect(mod.status).toBe(200);
  expect(mod.body.added).toEqual([b.id]);
});

test('super admin can delete a service; companies lose it, built-in modules cannot be deleted', async () => {
  const { auth } = await asSuperAdmin();
  const make = await request(app).post('/api/v1/services').set(auth).send({ code: 'WASHING', name: 'Washing' });
  const a = (await register(auth, { name: 'Alpha Mills', admin: { name: 'Alpha Admin', email: 'a@test.com', password: 'Alpha-Pass-123' } }, [])).body;
  await request(app).post(`/api/v1/services/${make.body.id}/companies`).set(auth).send({ companyIds: [a.id] });

  const del = await request(app).delete(`/api/v1/services/${make.body.id}`).set(auth);
  expect(del.status).toBe(200);
  expect(del.body).toMatchObject({ deleted: true, removedFromCompanies: 1 });
  expect((await request(app).get(`/api/v1/services/${make.body.id}/companies`).set(auth)).status).toBe(404);
  const codes = (await request(app).get('/api/v1/services').set(auth)).body.data.map((s) => s.code);
  expect(codes).not.toContain('WASHING');

  const [grey] = await serviceIds('GREY_STORE');
  expect((await request(app).delete(`/api/v1/services/${grey}`).set(auth)).status).toBe(422);

  // a module the super admin added can be deleted
  const mod = await request(app).post('/api/v1/services').set(auth).send({ code: 'EXTRA_MODULE', name: 'Extra Module', kind: 'MODULE' });
  expect((await request(app).delete(`/api/v1/services/${mod.body.id}`).set(auth)).status).toBe(200);
});
