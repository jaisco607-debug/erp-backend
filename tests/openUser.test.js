const jwt = require('jsonwebtoken');
const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, AuditLog, User } = require('../src/models');

beforeEach(clean);

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test('a client admin opens one of their employees: a 4 hour token with the employee\'s own services, no refresh token, audit logged', async () => {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const folding = await Service.findOne({ where: { code: 'FOLDING' } });
  const dyeing = await Service.findOne({ where: { code: 'DYEING' } });
  await CompanyService.bulkCreate([{ companyId: company.id, serviceId: folding.id }, { companyId: company.id, serviceId: dyeing.id }]);
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = bearer((await loginAs(admin)).accessToken);
  const created = await request(app).post('/api/v1/users').set(auth).send({ name: 'Ali Operator', email: 'ali@test.com', password: 'Ali-Pass-12345', services: [{ serviceId: folding.id, access: 'VIEW' }] });
  expect(created.status).toBe(201);
  const open = () => request(app).post(`/api/v1/users/${created.body.id}/open`).set(auth);

  const res = await open();
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: '4h', user: { id: created.body.id, email: 'ali@test.com', userType: 'USER' }, company: { id: company.id, name: 'Waqas Textile' } });
  expect(res.body.services.map((s) => [s.code, s.access])).toEqual([['FOLDING', 'VIEW']]); // the employee's, not the admin's
  expect(res.body.refreshToken).toBeUndefined();
  const claims = jwt.decode(res.body.accessToken);
  expect(claims.exp - claims.iat).toBe(4 * 3600);
  expect(claims.sub).toBe(created.body.id);

  // the token is the employee's: it sees the employee's account and cannot do what only a client admin can
  const as = bearer(res.body.accessToken);
  expect((await request(app).get('/api/v1/auth/me').set(as)).body).toMatchObject({ user: { id: created.body.id } });
  expect((await request(app).get('/api/v1/users').set(as)).status).toBe(403);
  const pw = await request(app).post('/api/v1/auth/change-password').set(as).send({ currentPassword: 'Ali-Pass-12345', newPassword: 'New-Pass-123456' });
  expect(pw.status).toBe(422);
  expect(pw.body.error.code).toBe('ACCOUNT_OPENED_BY_ADMIN');

  // audit: who opened whom
  const log = await AuditLog.findOne({ where: { action: 'USER_OPENED' } });
  expect(log).toMatchObject({ actorId: admin.id, actorEmail: admin.email, entityId: created.body.id, companyId: company.id });
  expect(log.after).toMatchObject({ employeeEmail: 'ali@test.com', validFor: '4h' });

  // the session dies with the admin's: logging the admin out everywhere ends the opened token too
  expect((await request(app).post('/api/v1/auth/logout-all').set(auth)).status).toBeLessThan(300);
  expect((await request(app).get('/api/v1/auth/me').set(as)).status).toBe(401);
});

test('open account: only a client admin, only an active employee of the same company, never yourself', async () => {
  const company = await makeCompany({ name: 'Waqas Textile' });
  const other = await makeCompany({ name: 'Other Mills' });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const admin2 = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const emp = await makeUser({ userType: 'USER', companyId: company.id });
  const emp2 = await makeUser({ userType: 'USER', companyId: company.id });
  const alien = await makeUser({ userType: 'USER', companyId: other.id });
  const auth = bearer((await loginAs(admin)).accessToken);
  const open = (id, a = auth) => request(app).post(`/api/v1/users/${id}/open`).set(a);

  expect((await open(emp.id, bearer((await loginAs(emp2)).accessToken))).status).toBe(403); // a normal user
  expect((await request(app).post(`/api/v1/users/${emp.id}/open`)).status).toBe(401);
  for (const id of [alien.id, '3f2b8c1e-5d6a-4b7c-9e0f-1a2b3c4d5e6f', admin2.id]) expect((await open(id)).status).toBe(404); // other company, unknown, another client admin
  const self = await open(admin.id);
  expect(self.status).toBe(422);
  expect(self.body.error.code).toBe('CANNOT_OPEN_SELF');
  await User.update({ isActive: false }, { where: { id: emp.id } });
  const off = await open(emp.id);
  expect(off.status).toBe(422);
  expect(off.body.error.code).toBe('USER_INACTIVE');
  expect(await AuditLog.count({ where: { action: 'USER_OPENED' } })).toBe(0);
});
