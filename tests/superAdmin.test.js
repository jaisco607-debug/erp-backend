const { app, request, sequelize, clean, makeUser, loginAs } = require('./helpers');
const { superAdminCode } = require('../src/services/loginCodeService');

beforeEach(clean);
afterAll(() => sequelize.close());

async function asSuperAdmin() {
  const me = await makeUser();
  const { accessToken } = await loginAs(me);
  return { me, auth: { Authorization: `Bearer ${accessToken}` } };
}

test('only super admins can manage super admins and read the audit log', async () => {
  const clientAdmin = await makeUser({ userType: 'CLIENT_ADMIN' });
  const { accessToken } = await loginAs(clientAdmin);
  const auth = { Authorization: `Bearer ${accessToken}` };
  expect((await request(app).get('/api/v1/super-admins').set(auth)).status).toBe(403);
  expect((await request(app).get('/api/v1/audit-logs').set(auth)).status).toBe(403);
});

test('create, list, rename, switch off, reset password, all audited', async () => {
  const { auth } = await asSuperAdmin();

  const created = await request(app).post('/api/v1/super-admins').set(auth)
    .send({ name: 'Second Admin', email: 'Second@Test.com', password: 'Second-Pass-123' });
  expect(created.status).toBe(201);
  expect(created.body.email).toBe('second@test.com');
  expect(created.body.passwordHash).toBeUndefined();

  const dup = await request(app).post('/api/v1/super-admins').set(auth)
    .send({ name: 'Again', email: 'second@test.com', password: 'Second-Pass-123' });
  expect(dup.status).toBe(409);

  const list = await request(app).get('/api/v1/super-admins?search=second').set(auth);
  expect(list.body.total).toBe(1);

  const id = created.body.id;
  const renamed = await request(app).patch(`/api/v1/super-admins/${id}`).set(auth).send({ name: 'Renamed' });
  expect(renamed.body.name).toBe('Renamed');

  const theirSession = await request(app).post('/api/v1/auth/login').send({ companyCode: await superAdminCode(), email: 'second@test.com', password: 'Second-Pass-123' });
  expect((await request(app).patch(`/api/v1/super-admins/${id}`).set(auth).send({ isActive: false })).status).toBe(200);
  expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${theirSession.body.accessToken}`)).status).toBe(401);

  expect((await request(app).post(`/api/v1/super-admins/${id}/reset-password`).set(auth).send({ newPassword: 'Reset-Pass-789' })).status).toBe(204);

  const log = await request(app).get('/api/v1/audit-logs?entityId=' + id).set(auth);
  const actions = log.body.data.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining(['SUPER_ADMIN_CREATED', 'SUPER_ADMIN_UPDATED', 'PASSWORD_RESET', 'LOGIN']));
  expect(JSON.stringify(log.body)).not.toMatch(/Second-Pass|Reset-Pass|\$2[aby]\$/);
});

test('a super admin cannot switch themselves off', async () => {
  const { me, auth } = await asSuperAdmin();
  const res = await request(app).patch(`/api/v1/super-admins/${me.id}`).set(auth).send({ isActive: false });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('CANNOT_DEACTIVATE_SELF');
});

test('a client admin id is not found through the super admin routes', async () => {
  const { auth } = await asSuperAdmin();
  const other = await makeUser({ userType: 'USER' });
  expect((await request(app).patch(`/api/v1/super-admins/${other.id}`).set(auth).send({ name: 'x y' })).status).toBe(404);
});
