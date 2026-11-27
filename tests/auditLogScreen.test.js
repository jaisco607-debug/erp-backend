const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { AuditLog } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-A4: the client admin reads the audit log of his own company: a date range (at most 92 days), filters, one entry with before and after; read only
async function setup() {
  const company = await makeCompany();
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, admin, user, api: as(admin), userApi: as(user) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };
const day = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('audit log screen: a date range is needed, filters, paging, newest first; one entry shows before and after without secrets; read only', async () => {
  const w = await setup();
  const base = { companyId: w.company.id, actorId: w.admin.id, actorType: 'CLIENT_ADMIN', actorEmail: w.admin.email };
  await AuditLog.create({ ...base, action: 'VOUCHER_UPDATED', entityType: 'PaymentVoucher', entityId: 'v-1', before: { amount: 100, notes: 'a' }, after: { amount: 150, notes: 'a' } });
  await AuditLog.create({ ...base, action: 'EMPLOYEE_UPDATED', entityType: 'PayrollEmployee', entityId: 'e-1',
    before: { name: 'ALI', cnic: '4220112345671', password: 'secret-1', refreshToken: 'abc', bank: { token: 't', name: 'HBL' } }, after: { name: 'ALI KHAN', cnic: '4220112345671', tokenHash: 'zzz' } });
  await AuditLog.create({ ...base, action: 'VOUCHER_CREATED', entityType: 'PaymentVoucher', entityId: 'v-2', after: { amount: 5 } });

  // a range is required, at most 92 days, from before to
  await fails(w.api('get', '/audit-logs'), 422, 'DATE_RANGE_REQUIRED');
  await fails(w.api('get', `/audit-logs?from=${day(-1)}`), 422, 'DATE_RANGE_REQUIRED');
  await fails(w.api('get', `/audit-logs?from=${day(-100)}&to=${day(0)}`), 422, 'RANGE_TOO_LONG');
  await fails(w.api('get', `/audit-logs?from=${day(0)}&to=${day(-1)}`), 422, 'RANGE_INVALID');
  await ok(w.api('get', `/audit-logs?from=${day(-92)}&to=${day(0)}`));
  await fails(w.api('get', `/audit-logs?from=${day(-1)}&to=${day(0)}&limit=201`), 400, 'VALIDATION_FAILED');

  const range = `from=${day(-1)}&to=${day(1)}`;
  const all = await ok(w.api('get', `/audit-logs?${range}`));
  expect(all).toMatchObject({ page: 1, limit: 50, maxDays: 92 });
  expect(all.total).toBeGreaterThanOrEqual(3); // the three above and the logins of this test
  expect(all.data.map((r) => r.action).filter((a) => a !== 'LOGIN').slice(0, 3)).toEqual(['VOUCHER_CREATED', 'EMPLOYEE_UPDATED', 'VOUCHER_UPDATED']); // newest first
  const first = all.data.find((r) => r.entityId === 'v-2');
  expect(first).toMatchObject({ entityType: 'PaymentVoucher', entityId: 'v-2', user: { email: w.admin.email, type: 'CLIENT_ADMIN' }, hasChanges: true });
  expect(first.before).toBeUndefined(); // the list does not carry before / after
  // filters and paging
  expect((await ok(w.api('get', `/audit-logs?${range}&entityType=PaymentVoucher`))).total).toBe(2);
  expect((await ok(w.api('get', `/audit-logs?${range}&action=EMPLOYEE_UPDATED`))).total).toBe(1);
  expect((await ok(w.api('get', `/audit-logs?${range}&userId=${w.admin.id}&entityType=PaymentVoucher`))).total).toBe(2);
  expect((await ok(w.api('get', `/audit-logs?${range}&userId=${w.user.id}&entityType=PaymentVoucher`))).total).toBe(0);
  expect((await ok(w.api('get', `/audit-logs?${range}&search=employee`))).total).toBe(1);
  expect((await ok(w.api('get', `/audit-logs?${range}&entityType=PaymentVoucher&limit=1&page=2`))).data).toHaveLength(1);
  // the history of one record needs no range
  expect((await ok(w.api('get', '/audit-logs?entityId=v-1'))).data.map((r) => r.action)).toEqual(['VOUCHER_UPDATED']);
  // a day in the past holds nothing
  expect((await ok(w.api('get', `/audit-logs?from=${day(-30)}&to=${day(-20)}&entityType=PaymentVoucher`))).total).toBe(0);

  // one entry: before / after, the changed fields, no secrets, the CNIC with its last 4 digits
  const upd = all.data.find((r) => r.action === 'VOUCHER_UPDATED');
  const one = await ok(w.api('get', `/audit-logs/${upd.id}`));
  expect(one).toMatchObject({ action: 'VOUCHER_UPDATED', before: { amount: 100 }, after: { amount: 150 }, changedFields: ['amount'] });
  const emp = await ok(w.api('get', `/audit-logs/${all.data.find((r) => r.action === 'EMPLOYEE_UPDATED').id}`));
  expect(emp.before).toEqual({ name: 'ALI', cnic: '*********5671', bank: { name: 'HBL' } });
  expect(emp.after).toEqual({ name: 'ALI KHAN', cnic: '*********5671' });
  expect(emp.changedFields).toEqual(['bank', 'name']);
  expect(JSON.stringify(emp)).not.toMatch(/secret-1|refreshToken|tokenHash|4220112345671/);

  // the filters of the screen
  const opts = await ok(w.api('get', '/audit-logs/options'));
  expect(opts.entityTypes).toEqual(expect.arrayContaining(['PayrollEmployee', 'PaymentVoucher']));
  expect(opts.actions).toEqual(expect.arrayContaining(['EMPLOYEE_UPDATED', 'VOUCHER_CREATED', 'VOUCHER_UPDATED']));
  expect(opts.users.map((u) => u.email)).toEqual(expect.arrayContaining([w.admin.email, w.user.email]));

  // read only: nothing writes, the routes refuse it
  expect((await w.api('delete', `/audit-logs/${upd.id}`)).status).toBe(404);
  expect((await w.api('patch', `/audit-logs/${upd.id}`, { action: 'X' })).status).toBe(404);
  // a normal user cannot open any of it
  for (const url of [`/audit-logs?${range}`, '/audit-logs/options', `/audit-logs/${upd.id}`]) expect((await w.userApi('get', url)).status).toBe(403);
});

test('audit log screen: another company sees none of it', async () => {
  const w = await setup();
  const other = await setup();
  await AuditLog.create({ companyId: w.company.id, actorId: w.admin.id, actorType: 'CLIENT_ADMIN', actorEmail: w.admin.email, action: 'VOUCHER_CREATED', entityType: 'PaymentVoucher', entityId: 'v-9', after: { amount: 1 } });
  const mine = await ok(w.api('get', `/audit-logs?from=${day(-1)}&to=${day(1)}&entityType=PaymentVoucher`));
  expect(mine.total).toBe(1);
  expect((await ok(other.api('get', `/audit-logs?from=${day(-1)}&to=${day(1)}&entityType=PaymentVoucher`))).total).toBe(0);
  expect((await ok(other.api('get', '/audit-logs?entityId=v-9'))).total).toBe(0);
  await fails(other.api('get', `/audit-logs/${mine.data[0].id}`), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', '/audit-logs/options'))).actions).not.toContain('VOUCHER_CREATED');
});
