const { app, request, sequelize, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, AuditLog } = require('../src/models');

beforeEach(clean);
afterAll(() => sequelize.close());

const ids = async (...codes) => Object.fromEntries((await Service.findAll({ where: { code: codes } })).map((s) => [s.code, s.id]));

/** A company with DYEING + FOLDING, its client admin logged in. */
async function setup() {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const s = await ids('DYEING', 'FOLDING', 'PRINTING');
  await CompanyService.bulkCreate([{ companyId: company.id, serviceId: s.DYEING }, { companyId: company.id, serviceId: s.FOLDING }]);
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const { accessToken } = await loginAs(admin);
  return { company, admin, s, auth: { Authorization: `Bearer ${accessToken}` } };
}

const login = (body) => request(app).post('/api/v1/auth/login').send(body);

test('client admin adds a user who logs in with the company code and sees only the services given', async () => {
  const { company, s, auth } = await setup();
  const res = await request(app).post('/api/v1/users').set(auth).send({
    name: 'Ali Operator', email: 'Ali@Test.com', password: 'Ali-Pass-12345',
    services: [{ serviceId: s.FOLDING, access: 'view' }, { serviceId: s.DYEING, access: 'FULL' }],
  });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ name: 'Ali Operator', email: 'ali@test.com', userType: 'USER', companyId: company.id });
  expect(res.body.services.map((x) => [x.code, x.access])).toEqual([['DYEING', 'FULL'], ['FOLDING', 'VIEW']]);
  expect(JSON.stringify(res.body)).not.toMatch(/Ali-Pass|\$2[aby]\$/);

  const me = await login({ companyCode: company.code, email: 'ali@test.com', password: 'Ali-Pass-12345' });
  expect(me.status).toBe(200);
  expect(me.body.user.userType).toBe('USER');
  expect(me.body.company.code).toBe(company.code);
  expect(me.body.services).toEqual([
    expect.objectContaining({ code: 'DYEING', name: 'Dyeing', kind: 'PROCESS', access: 'FULL' }),
    expect.objectContaining({ code: 'FOLDING', name: 'Folding', kind: 'FOLDING', access: 'VIEW' }),
  ]);

  const log = await AuditLog.findOne({ where: { action: 'COMPANY_USER_CREATED' } });
  expect(log.companyId).toBe(company.id);
  expect(log.after.services).toEqual(['DYEING:FULL', 'FOLDING:VIEW']);
});

test('a user cannot get a service the company does not have', async () => {
  const { s, auth } = await setup();
  const res = await request(app).post('/api/v1/users').set(auth).send({
    name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345', services: [{ serviceId: s.PRINTING, access: 'FULL' }],
  });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('SERVICE_NOT_IN_COMPANY');
  const bad = await request(app).post('/api/v1/users').set(auth).send({
    name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345', services: [{ serviceId: s.DYEING, access: 'ADMIN' }],
  });
  expect(bad.status).toBe(400);
});

test('same email twice in one company is refused, in another company it is fine', async () => {
  const { auth } = await setup();
  const body = { name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345' };
  expect((await request(app).post('/api/v1/users').set(auth).send(body)).status).toBe(201);
  expect((await request(app).post('/api/v1/users').set(auth).send(body)).status).toBe(409);
  const other = await setup();
  expect((await request(app).post('/api/v1/users').set(other.auth).send(body)).status).toBe(201);
});

test('changing services, switching off and resetting the password', async () => {
  const { company, s, auth } = await setup();
  const user = (await request(app).post('/api/v1/users').set(auth).send({
    name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345', services: [{ serviceId: s.DYEING, access: 'VIEW' }],
  })).body;
  const session = (await login({ companyCode: company.code, email: 'ali@test.com', password: 'Ali-Pass-12345' })).body;
  const userAuth = { Authorization: `Bearer ${session.accessToken}` };

  const changed = await request(app).put(`/api/v1/users/${user.id}/services`).set(auth).send({ services: [{ serviceId: s.FOLDING, access: 'FULL' }] });
  expect(changed.body.services.map((x) => x.code)).toEqual(['FOLDING']);
  expect((await request(app).get('/api/v1/auth/me').set(userAuth)).body.services).toEqual([expect.objectContaining({ code: 'FOLDING', name: 'Folding', kind: 'FOLDING', access: 'FULL' })]);
  const log = await AuditLog.findOne({ where: { action: 'USER_SERVICES_CHANGED' } });
  expect(log.before.services).toEqual(['DYEING:VIEW']);
  expect(log.after.services).toEqual(['FOLDING:FULL']);

  await request(app).post(`/api/v1/users/${user.id}/reset-password`).set(auth).send({ newPassword: 'Ali-New-Pass-1' }).expect(204);
  expect((await request(app).get('/api/v1/auth/me').set(userAuth)).status).toBe(401);
  expect((await login({ companyCode: company.code, email: 'ali@test.com', password: 'Ali-New-Pass-1' })).status).toBe(200);

  const off = await request(app).patch(`/api/v1/users/${user.id}`).set(auth).send({ isActive: false });
  expect(off.body.isActive).toBe(false);
  expect((await login({ companyCode: company.code, email: 'ali@test.com', password: 'Ali-New-Pass-1' })).status).toBe(401);

  const list = await request(app).get('/api/v1/users?search=ali').set(auth);
  expect(list.body.total).toBe(1);
  expect((await request(app).get(`/api/v1/users/${user.id}`).set(auth)).body.services[0].code).toBe('FOLDING');
});

test('when the company loses a service, its users lose it too', async () => {
  const { company, s, auth } = await setup();
  const user = (await request(app).post('/api/v1/users').set(auth).send({
    name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345',
    services: [{ serviceId: s.DYEING, access: 'FULL' }, { serviceId: s.FOLDING, access: 'VIEW' }],
  })).body;
  const sa = await loginAs(await makeUser());
  const saAuth = { Authorization: `Bearer ${sa.accessToken}` };

  await request(app).put(`/api/v1/companies/${company.id}/services`).set(saAuth).send({ serviceIds: [s.FOLDING] }).expect(200);
  expect((await request(app).get(`/api/v1/users/${user.id}`).set(auth)).body.services.map((x) => x.code)).toEqual(['FOLDING']);

  await request(app).put(`/api/v1/services/${s.FOLDING}/companies`).set(saAuth).send({ companyIds: [] }).expect(200);
  // given back to the company later: the user does not get it back by itself
  await request(app).put(`/api/v1/companies/${company.id}/services`).set(saAuth).send({ serviceIds: [s.DYEING, s.FOLDING] }).expect(200);
  expect((await request(app).get(`/api/v1/users/${user.id}`).set(auth)).body.services).toEqual([]);
});

test('a client admin only sees and changes their own company\'s users', async () => {
  const a = await setup();
  const b = await setup();
  const userOfB = (await request(app).post('/api/v1/users').set(b.auth).send({ name: 'Bilal', email: 'b@test.com', password: 'Bilal-Pass-123' })).body;
  expect((await request(app).get(`/api/v1/users/${userOfB.id}`).set(a.auth)).status).toBe(404);
  expect((await request(app).patch(`/api/v1/users/${userOfB.id}`).set(a.auth).send({ isActive: false })).status).toBe(404);
  expect((await request(app).get('/api/v1/users').set(a.auth)).body.total).toBe(0);
  // nor can it touch its own client admin account through these APIs
  expect((await request(app).patch(`/api/v1/users/${a.admin.id}`).set(a.auth).send({ isActive: false })).status).toBe(404);
});

test('only client admins use these APIs', async () => {
  const { company, auth } = await setup();
  const user = (await request(app).post('/api/v1/users').set(auth).send({ name: 'Ali', email: 'ali@test.com', password: 'Ali-Pass-12345' })).body;
  const userSession = (await login({ companyCode: company.code, email: 'ali@test.com', password: 'Ali-Pass-12345' })).body;
  expect((await request(app).get('/api/v1/users').set({ Authorization: `Bearer ${userSession.accessToken}` })).status).toBe(403);
  const sa = await loginAs(await makeUser());
  expect((await request(app).get('/api/v1/users').set({ Authorization: `Bearer ${sa.accessToken}` })).status).toBe(403);
  expect(user.id).toBeTruthy();
});
