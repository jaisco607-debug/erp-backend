const { app, request, sequelize, clean, makeUser, loginAs, companyCodeOf, PASSWORD } = require('./helpers');
const { AuditLog, RefreshToken, User } = require('../src/models');

beforeEach(clean);
afterAll(() => sequelize.close());

describe('one login window', () => {
  test.each(['SUPER_ADMIN', 'CLIENT_ADMIN', 'USER'])('%s logs in at the same URL and gets its type back', async (userType) => {
    const user = await makeUser({ userType });
    const companyCode = await companyCodeOf(user);
    const res = await request(app).post('/api/v1/auth/login').send({ companyCode: companyCode.toLowerCase(), email: user.email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.userType).toBe(userType);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  test('wrong password, unknown email and inactive account give the same answer', async () => {
    const user = await makeUser();
    const off = await makeUser({ isActive: false });
    const companyCode = await companyCodeOf(user);
    const answers = await Promise.all([
      request(app).post('/api/v1/auth/login').send({ companyCode, email: user.email, password: 'Wrong-Pass-123' }),
      request(app).post('/api/v1/auth/login').send({ companyCode, email: 'nobody@test.com', password: PASSWORD }),
      request(app).post('/api/v1/auth/login').send({ companyCode, email: off.email, password: PASSWORD }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Company code, email or password is incorrect');
    }
    expect(await AuditLog.count({ where: { action: 'LOGIN_FAILED' } })).toBe(3);
  });

  test('account locks after 5 wrong passwords, even the right password is refused then', async () => {
    const user = await makeUser();
    const companyCode = await companyCodeOf(user);
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ companyCode, email: user.email, password: 'Wrong-Pass-123' });
    await user.reload();
    expect(user.lockedUntil > new Date()).toBe(true);
    const res = await request(app).post('/api/v1/auth/login').send({ companyCode, email: user.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test('super admins need their shared code too; a new code stops the old one', async () => {
    const me = await makeUser();
    const login = (body) => request(app).post('/api/v1/auth/login').send(body);
    const noCode = await login({ email: me.email, password: PASSWORD });
    expect(noCode.status).toBe(400);
    expect((await login({ companyCode: 'ZZZZ-ZZZZ', email: me.email, password: PASSWORD })).status).toBe(401);

    const { accessToken } = await loginAs(me);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const old = (await request(app).get('/api/v1/super-admins/login-code').set(auth)).body.code;
    expect(old).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);

    const fresh = await request(app).post('/api/v1/super-admins/login-code/new').set(auth);
    expect(fresh.status).toBe(200);
    expect(fresh.body.code).not.toBe(old);
    expect((await login({ companyCode: old, email: me.email, password: PASSWORD })).status).toBe(401);
    expect((await login({ companyCode: fresh.body.code, email: me.email, password: PASSWORD })).status).toBe(200);
    expect(await AuditLog.count({ where: { action: 'SUPER_ADMIN_CODE_CHANGED', actorId: me.id } })).toBe(1);

    // a company admin cannot see or change it
    const admin = await loginAs(await makeUser({ userType: 'CLIENT_ADMIN' }));
    expect((await request(app).get('/api/v1/super-admins/login-code').set({ Authorization: `Bearer ${admin.accessToken}` })).status).toBe(403);
  });

  test('unknown fields are refused', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ companyCode: 'ABCD-EFGH', email: 'a@test.com', password: 'x', userType: 'SUPER_ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('passwords never reach the audit log', async () => {
    const user = await makeUser();
    await loginAs(user);
    await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'Wrong-Pass-123' });
    const rows = await AuditLog.findAll({ raw: true });
    expect(JSON.stringify(rows)).not.toMatch(/Strong-Pass|Wrong-Pass|\$2[aby]\$/);
  });
});

describe('sessions', () => {
  test('me needs a valid token', async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer abc')).status).toBe(401);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  test('refresh gives a new pair; using an old refresh token again ends every session', async () => {
    const user = await makeUser();
    const first = await loginAs(user);
    const second = (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken })).body;
    expect(second.refreshToken).toBeTruthy();

    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    // the thief's copy and the real user's newer tokens are both dead now
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken })).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${second.accessToken}`)).status).toBe(401);
    expect(await AuditLog.count({ where: { action: 'SESSION_REUSE_DETECTED' } })).toBe(1);
  });

  test('refresh tokens are stored only as a hash', async () => {
    const user = await makeUser();
    const { refreshToken } = await loginAs(user);
    const rows = await RefreshToken.findAll({ raw: true });
    expect(JSON.stringify(rows)).not.toContain(refreshToken);
  });

  test('logout ends that session', async () => {
    const user = await makeUser();
    const { refreshToken } = await loginAs(user);
    expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken })).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
  });

  test('changing the password ends old sessions and the new password works', async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user);
    const auth = { Authorization: `Bearer ${accessToken}` };

    const weak = await request(app).post('/api/v1/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const wrong = await request(app).post('/api/v1/auth/change-password').set(auth).send({ currentPassword: 'Nope-1234567', newPassword: 'Another-Pass-456' });
    expect(wrong.status).toBe(422);

    const ok = await request(app).post('/api/v1/auth/change-password').set(auth).send({ currentPassword: PASSWORD, newPassword: 'Another-Pass-456' });
    expect(ok.status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set(auth)).status).toBe(401);
    expect((await loginAs(user, 'Another-Pass-456')).accessToken).toBeTruthy();
  });

  test('a deactivated user is thrown out at the next request', async () => {
    const user = await makeUser();
    const { accessToken } = await loginAs(user);
    await User.update({ isActive: false }, { where: { id: user.id } });
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`)).status).toBe(401);
  });
});

describe('audit log', () => {
  test('rows cannot be changed or deleted, even directly in the database', async () => {
    const user = await makeUser();
    await loginAs(user);
    await expect(sequelize.query('UPDATE audit_logs SET action = $1', { bind: ['HACKED'] })).rejects.toThrow(/append-only/);
    await expect(sequelize.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });
});
