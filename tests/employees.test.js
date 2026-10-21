const { app, request, clean, makeUser, loginAs } = require('./helpers');
const { Service, User } = require('../src/models');

beforeEach(clean);

const idsOf = async (...codes) => Object.fromEntries((await Service.findAll({ where: { code: codes } })).map((s) => [s.code, s.id]));
const EMP_PASS = 'Employee-Pass-123';

async function setup(services = ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'GENERAL_STORE', 'STORE_REPORTS', 'REPORT_GREY', 'DYEING']) {
  const sa = await makeUser();
  const saAuth = { Authorization: `Bearer ${(await loginAs(sa)).accessToken}` };
  const sup = (m, url, body) => request(app)[m](`/api/v1${url}`).set(saAuth).send(body);
  const company = (await sup('post', '/companies', { name: 'Mills', admin: { name: 'Boss', email: 'boss@test.com', password: 'Boss-Pass-123' } })).body;
  const ids = await idsOf(...services);
  await sup('put', `/companies/${company.id}/services`, { serviceIds: Object.values(ids) });
  const login = async (email, password) => (await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email, password })).body;
  const boss = await login('boss@test.com', 'Boss-Pass-123');
  const bossAuth = { Authorization: `Bearer ${boss.accessToken}` };
  const adm = (m, url, body) => request(app)[m](`/api/v1${url}`).set(bossAuth).send(body);
  return { sa, sup, company, ids, login, adm, boss };
}

const as = (token) => (url) => request(app).get(`/api/v1${url}`).set({ Authorization: `Bearer ${token}` });

test('client admin makes an employee with email + password + some services; the employee logs in and sees only those', async () => {
  const { company, ids, login, adm } = await setup();

  // what the client admin can give: the company's services only, grouped by tab; reports are VIEW only
  const options = (await adm('get', '/users/service-options')).body.data;
  expect(options.map((s) => s.code).sort()).toEqual(['CHEMICAL_STORE', 'DYEING', 'GENERAL_STORE', 'GREY_STORE', 'REPORT_GREY', 'SO_CARD', 'STORE_REPORTS']);
  expect(options.find((s) => s.code === 'GREY_STORE')).toMatchObject({ menuGroup: 'PRODUCTION', accessLevels: ['VIEW', 'FULL'] });
  expect(options.find((s) => s.code === 'REPORT_GREY')).toMatchObject({ kind: 'REPORT', accessLevels: ['VIEW'] });

  const made = await adm('post', '/users', {
    name: 'Aslam', email: 'Aslam@Test.com', phone: '0300-1234567', password: EMP_PASS,
    services: [{ serviceId: ids.CHEMICAL_STORE, access: 'FULL' }, { serviceId: ids.REPORT_GREY, access: 'FULL' }],
  });
  expect(made.status).toBe(201);
  expect(made.body).toMatchObject({ name: 'Aslam', email: 'aslam@test.com', phone: '0300-1234567', userType: 'USER', isActive: true, serviceCount: 2 });
  expect(JSON.stringify(made.body)).not.toMatch(/passwordHash|\$2[aby]\$|Employee-Pass/);
  // a report service is stored as VIEW even when FULL was asked
  expect(made.body.services.map((s) => [s.code, s.access]).sort()).toEqual([['CHEMICAL_STORE', 'FULL'], ['REPORT_GREY', 'VIEW']]);

  // the employee logs in with the COMPANY's code and their own email + password
  const emp = await login('aslam@test.com', EMP_PASS);
  expect(emp.user).toMatchObject({ userType: 'USER', companyId: company.id });
  expect(emp.company.code).toBe(company.code);
  expect(emp.services.map((s) => s.code).sort()).toEqual(['CHEMICAL_STORE', 'REPORT_GREY']);
  expect(emp.services.find((s) => s.code === 'CHEMICAL_STORE')).toMatchObject({ access: 'FULL', menuGroup: 'STORE' });

  // and the API gives them only that: chemical store yes, general store / grey store / store reports no
  const get = as(emp.accessToken);
  expect((await get('/stores/chemical/items')).status).toBe(200);
  expect((await get('/stores/general/items')).status).toBe(403);
  expect((await get('/grey-lots')).status).toBe(403);
  expect((await get('/stores/chemical/cost/jobs')).status).toBe(403);
  expect((await get('/reports/grey/parties')).status).toBe(200);
  expect((await get('/reports/folding')).status).toBe(403);
  // an employee cannot manage employees
  expect((await get('/users')).status).toBe(403);

  // the client admin changes the list: all the company's services at once (read-only ones as VIEW)
  const all = await adm('put', `/users/${made.body.id}/services`, { services: options.map((s) => ({ serviceId: s.id, access: s.kind === 'REPORT' ? 'VIEW' : 'FULL' })) });
  expect(all.body.serviceCount).toBe(7);
  expect((await get('/stores/general/items')).status).toBe(200);
  expect((await get('/stores/chemical/cost/jobs')).status).toBe(200);
  // ... or part of one tab: only the general store
  await adm('put', `/users/${made.body.id}/services`, { services: [{ serviceId: ids.GENERAL_STORE, access: 'VIEW' }] });
  expect((await get('/stores/general/items')).status).toBe(200);
  expect((await get('/stores/chemical/items')).status).toBe(403);
  expect((await get('/stores/general/inwards/form-data')).status).toBe(200);
  expect((await request(app).post('/api/v1/stores/general/items').set({ Authorization: `Bearer ${emp.accessToken}` }).send({ name: 'X', unit: 'PCS' })).status).toBe(403);
  // ... or nothing
  await adm('put', `/users/${made.body.id}/services`, { services: [] });
  expect((await get('/stores/general/items')).status).toBe(403);
  expect((await login('aslam@test.com', EMP_PASS)).services).toEqual([]);

  // a service the company does not have cannot be given
  const other = (await idsOf('PRINTING')).PRINTING;
  expect((await adm('put', `/users/${made.body.id}/services`, { services: [{ serviceId: other, access: 'VIEW' }] })).body.error.code).toBe('SERVICE_NOT_IN_COMPANY');
});

test('employee rules: email unique inside the company, client admins cannot be made by a client admin, edit, switch off', async () => {
  const { sup, company, login, adm } = await setup();
  const a = await adm('post', '/users', { name: 'Aslam', email: 'aslam@test.com', password: EMP_PASS });
  expect(a.status).toBe(201);
  expect(a.body.serviceCount).toBe(0);
  const dup = await adm('post', '/users', { name: 'Other', email: 'ASLAM@test.com', password: EMP_PASS });
  expect(dup.status).toBe(409);
  expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  expect((await adm('post', '/users', { name: 'Weak', email: 'weak@test.com', password: 'short' })).status).toBe(400);
  // only the super admin makes client admins: a client admin cannot choose the type
  expect((await adm('post', '/users', { name: 'Sneaky', email: 's@test.com', password: EMP_PASS, userType: 'CLIENT_ADMIN' })).status).toBe(400);
  // the same email may exist in another company
  const c2 = (await sup('post', '/companies', { name: 'Other Mills', admin: { name: 'Boss2', email: 'boss2@test.com', password: 'Boss-Pass-123' } })).body;
  const boss2 = (await request(app).post('/api/v1/auth/login').send({ companyCode: c2.code, email: 'boss2@test.com', password: 'Boss-Pass-123' })).body;
  expect((await request(app).post('/api/v1/users').set({ Authorization: `Bearer ${boss2.accessToken}` }).send({ name: 'Aslam', email: 'aslam@test.com', password: EMP_PASS })).status).toBe(201);
  // and another company's employee is "not found" for this client admin
  const theirs = (await request(app).get('/api/v1/users').set({ Authorization: `Bearer ${boss2.accessToken}` })).body.data[0];
  expect((await adm('get', `/users/${theirs.id}`)).status).toBe(404);

  // edit: name, phone and a new email (the old email stops working at once)
  const edited = await adm('patch', `/users/${a.body.id}`, { name: 'Aslam Khan', phone: '0321-0000000', email: 'aslam.khan@test.com' });
  expect(edited.body).toMatchObject({ name: 'Aslam Khan', phone: '0321-0000000', email: 'aslam.khan@test.com' });
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'aslam@test.com', password: EMP_PASS })).status).toBe(401);
  const emp = await login('aslam.khan@test.com', EMP_PASS);
  expect(emp.accessToken).toBeTruthy();

  // list and search (name / email / phone)
  expect((await adm('get', '/users?search=0321')).body.total).toBe(1);
  expect((await adm('get', '/users?search=khan')).body.data[0]).toMatchObject({ serviceCount: 0 });

  // switch off: the old session and the refresh token stop; password reset: old password fails
  await adm('patch', `/users/${a.body.id}`, { isActive: false });
  expect((await as(emp.accessToken)('/auth/me')).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: emp.refreshToken })).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'aslam.khan@test.com', password: EMP_PASS })).status).toBe(401);
  await adm('patch', `/users/${a.body.id}`, { isActive: true });
  await adm('post', `/users/${a.body.id}/reset-password`, { newPassword: 'Brand-New-Pass-1' });
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'aslam.khan@test.com', password: EMP_PASS })).status).toBe(401);
  expect((await login('aslam.khan@test.com', 'Brand-New-Pass-1')).accessToken).toBeTruthy();
});

test('super admin only SEES the client admins, their employees and the services each employee has', async () => {
  const { sa, sup, company, ids, adm } = await setup();
  await adm('post', '/users', { name: 'Aslam', email: 'aslam@test.com', phone: '0300-1', password: EMP_PASS, services: [{ serviceId: ids.GREY_STORE, access: 'FULL' }, { serviceId: ids.REPORT_GREY, access: 'VIEW' }] });
  await adm('post', '/users', { name: 'Bilal', email: 'bilal@test.com', password: EMP_PASS });
  const c2 = (await sup('post', '/companies', { name: 'Other Mills', admin: { name: 'Boss2', email: 'boss2@test.com', password: 'Boss-Pass-123' } })).body;

  const all = (await sup('get', '/admin/users')).body;
  expect(all).toMatchObject({ page: 1, limit: 20, total: 5, summary: { total: 5, superAdmins: 1, clientAdmins: 2, users: 2, active: 5, inactive: 0 } });
  const aslam = all.data.find((u) => u.email === 'aslam@test.com');
  expect(aslam).toMatchObject({ userType: 'USER', serviceCount: 2, employeeCount: null, phone: '0300-1', company: { id: company.id, name: 'Mills', code: company.code } });
  expect(JSON.stringify(all)).not.toMatch(/passwordHash|\$2[aby]\$/);
  expect(all.data.find((u) => u.userType === 'SUPER_ADMIN').company).toBeNull();
  expect(all.data.find((u) => u.email === 'boss@test.com')).toMatchObject({ userType: 'CLIENT_ADMIN', employeeCount: 2, serviceCount: null });

  // filters
  expect((await sup('get', `/admin/users?companyId=${company.id}&userType=USER`)).body.data.map((u) => u.name).sort()).toEqual(['Aslam', 'Bilal']);
  expect((await sup('get', `/admin/users?companyId=${c2.id}`)).body.total).toBe(1);
  expect((await sup('get', '/admin/users?search=aslam')).body.total).toBe(1);
  expect((await sup('get', '/admin/users?search=0300')).body.total).toBe(1);
  expect((await sup('get', '/admin/users?limit=2&page=2')).body).toMatchObject({ page: 2, limit: 2, total: 5 });
  expect((await sup('get', '/admin/users?limit=500')).status).toBe(400);

  // one employee: with the services they have
  const one = (await sup('get', `/admin/users/${aslam.id}`)).body;
  expect(one.services.map((s) => [s.code, s.access, s.menuGroup]).sort()).toEqual([['GREY_STORE', 'FULL', 'PRODUCTION'], ['REPORT_GREY', 'VIEW', 'REPORTS']]);
  // one client admin: with the company's employees and what each can use
  const bossRow = all.data.find((u) => u.email === 'boss@test.com');
  const boss = (await sup('get', `/admin/users/${bossRow.id}`)).body;
  expect(boss.services).toHaveLength(7);
  expect(boss.employees.map((e) => [e.name, e.serviceCount]).sort()).toEqual([['Aslam', 2], ['Bilal', 0]]);
  expect(boss.employees.find((e) => e.name === 'Aslam').services.map((s) => s.code).sort()).toEqual(['GREY_STORE', 'REPORT_GREY']);
  expect((await sup('get', '/admin/users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  expect((await sup('get', '/admin/users/not-a-uuid')).status).toBe(400);

  // READ ONLY: the super admin cannot make or change an employee
  expect((await sup('post', '/admin/users', { name: 'X', email: 'x@test.com', password: EMP_PASS })).status).toBe(404);
  expect((await sup('patch', `/admin/users/${aslam.id}`, { isActive: false })).status).toBe(404);
  expect((await sup('post', `/admin/users/${aslam.id}/reset-password`, { password: EMP_PASS })).status).toBe(404);
  expect((await sup('put', `/admin/users/${aslam.id}/services`, { services: [] })).status).toBe(404);
  expect((await sup('post', '/users', { name: 'X', email: 'x@test.com', password: EMP_PASS })).status).toBe(403);
  // a client admin and an employee cannot use these endpoints
  expect((await adm('get', '/admin/users')).status).toBe(403);
  expect(sa).toBeTruthy();
});

test('switching off or deleting the client admin locks out all his employees at once', async () => {
  const { sup, company, ids, login, adm } = await setup();
  const made = (await adm('post', '/users', { name: 'Aslam', email: 'aslam@test.com', password: EMP_PASS, services: [{ serviceId: ids.GREY_STORE, access: 'FULL' }] })).body;
  const emp = await login('aslam@test.com', EMP_PASS);
  expect((await as(emp.accessToken)('/grey-lots')).status).toBe(200);
  const bossId = (await sup('get', `/companies/${company.id}`)).body.clientAdmins[0].id;

  // switch the (only) client admin off: the employee's open session, refresh token and login all stop
  const off = await sup('patch', `/companies/${company.id}/admins/${bossId}`, { isActive: false });
  expect(off.body).toMatchObject({ isActive: false, effect: { activeAdmins: 0, employees: 1, employeesBlocked: true } });
  expect((await as(emp.accessToken)('/grey-lots')).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: emp.refreshToken })).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'aslam@test.com', password: EMP_PASS })).status).toBe(401);
  // the employee is still listed (nothing is lost), just locked out
  expect((await sup('get', `/admin/users?companyId=${company.id}&userType=USER`)).body.data[0]).toMatchObject({ id: made.id, isActive: true });

  // switch on again: the employee works again
  const on = await sup('patch', `/companies/${company.id}/admins/${bossId}`, { isActive: true });
  expect(on.body.effect).toMatchObject({ activeAdmins: 1, employeesBlocked: false });
  expect((await login('aslam@test.com', EMP_PASS)).accessToken).toBeTruthy();

  // a second client admin: switching one off does not lock the employees out
  const second = await sup('post', `/companies/${company.id}/admins`, { name: 'Boss Two', email: 'boss.two@test.com', phone: '0300-9', password: 'Boss-Pass-123' });
  expect(second.status).toBe(201);
  expect(second.body).toMatchObject({ userType: 'CLIENT_ADMIN', companyId: company.id, effect: { activeAdmins: 2 } });
  expect((await sup('post', `/companies/${company.id}/admins`, { name: 'Dup', email: 'BOSS.two@test.com', password: 'Boss-Pass-123' })).body.error.code).toBe('EMAIL_TAKEN');
  const e2 = await login('aslam@test.com', EMP_PASS);
  const offOne = await sup('patch', `/companies/${company.id}/admins/${bossId}`, { isActive: false });
  expect(offOne.body.effect).toMatchObject({ activeAdmins: 1, employeesBlocked: false });
  expect((await as(e2.accessToken)('/grey-lots')).status).toBe(200);

  // delete the last active client admin: the employees are locked out for good, the email can be used again
  const del = await sup('delete', `/companies/${company.id}/admins/${second.body.id}`);
  expect(del.status).toBe(200);
  expect(del.body).toMatchObject({ deleted: true, id: second.body.id, effect: { activeAdmins: 0, employees: 1, employeesBlocked: true } });
  expect((await as(e2.accessToken)('/grey-lots')).status).toBe(401);
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'boss.two@test.com', password: 'Boss-Pass-123' })).status).toBe(401);
  expect((await sup('get', `/admin/users/${second.body.id}`)).status).toBe(404);
  expect((await sup('get', `/admin/users?companyId=${company.id}&userType=CLIENT_ADMIN`)).body.data.map((u) => u.email)).toEqual(['boss@test.com']);
  expect((await sup('get', `/companies/${company.id}`)).body.clientAdmins.map((a) => a.email)).toEqual(['boss@test.com']);
  expect(await User.count({ where: { email: 'boss.two@test.com' }, paranoid: false })).toBe(1);
  const again = await sup('post', `/companies/${company.id}/admins`, { name: 'Boss Two again', email: 'boss.two@test.com', password: 'Boss-Pass-123' });
  expect(again.status).toBe(201);
  expect((await sup('delete', `/companies/${company.id}/admins/${second.body.id}`)).status).toBe(404);
  expect((await sup('delete', `/companies/${company.id}/admins/${made.id}`)).status).toBe(404);

  // the company switched off or deleted locks everybody out too (as before)
  await sup('patch', `/companies/${company.id}`, { isActive: false });
  expect((await request(app).post('/api/v1/auth/login').send({ companyCode: company.code, email: 'boss@test.com', password: 'Boss-Pass-123' })).status).toBe(401);
});
