const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog } = require('../src/models');
const { DEFAULTS, summary } = require('../src/services/payrollPolicyService');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of PAYROLL) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory, outlet, head, adminGroup] = (await ok(api('get', '/payroll/groups'))).data;
  return { company, s, admin, api, factory, outlet, head, adminGroup };
}
const eff = (w, group, month) => ok(w.api('get', `/payroll/policies/effective?groupId=${group.id}&month=${month}`));

test('defaults: a group with no policy uses the built-in rules; the summary line of the payroll sheet', async () => {
  const w = await setup();
  const res = await ok(w.api('get', '/payroll/policies/by-group?month=2026-10'));
  expect(res.month).toBe('2026-10');
  expect(res.defaults).toMatchObject({ lateLimitMinutes: 15, halfDayLimitMinutes: 120, latesPerHalfDay: 3, weeklyOffDay: 'SUNDAY', overtimeFactor: 1, leaveEarnedPerMonth: 2, maxLeavePerYear: 24, monthsBeforeLeave: 6 });
  expect(res.data.map((d) => [d.group.name, d.group.isDefault, d.policy.source, d.policy.id])).toEqual([['Factory', true, 'DEFAULT', null], ['Outlet', true, 'DEFAULT', null], ['Head Office', true, 'DEFAULT', null], ['Admin', true, 'DEFAULT', null]]);
  expect(res.data[0].policy).toMatchObject({ ...DEFAULTS, effectiveFrom: null, month: '2026-10', summary: 'Late 15m, half-day 120m, 3 lates = half a day, off Sunday, overtime x1, leave 2/mo, max 24/yr, after 6 mo' });
  expect(await eff(w, w.factory, '2026-10')).toMatchObject({ source: 'DEFAULT', group: { name: 'Factory' }, ...DEFAULTS });
  expect((await ok(w.api('get', '/payroll/policies'))).total).toBe(0);
  // no month = this month
  expect((await ok(w.api('get', '/payroll/policies/by-group'))).month).toMatch(/^\d{4}-\d{2}$/);
  expect(summary({ ...DEFAULTS, latesPerHalfDay: 0, weeklyOffDay: null, overtimeFactor: 1.5 })).toBe('Late 15m, half-day 120m, lates not penalised, off none, overtime x1.5, leave 2/mo, max 24/yr, after 6 mo');
});

test('versions: a policy holds from its month until the next one; a new version starts from the one in force; each group has its own', async () => {
  const w = await setup();
  const v1 = await ok(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-07', lateLimitMinutes: 10 }), 201);
  expect(v1).toMatchObject({ source: 'POLICY', group: { name: 'Factory' }, effectiveFrom: '2026-07', lateLimitMinutes: 10, halfDayLimitMinutes: 120, latesPerHalfDay: 3, weeklyOffDay: 'SUNDAY', overtimeFactor: 1 });
  expect(v1.id).toBeTruthy();
  // only what is sent changes: the rest comes from the version in force that month (here v1, not the defaults)
  const v2 = await ok(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-10', weeklyOffDay: 'FRIDAY', overtimeFactor: 1.5 }), 201);
  expect(v2).toMatchObject({ effectiveFrom: '2026-10', lateLimitMinutes: 10, weeklyOffDay: 'FRIDAY', overtimeFactor: 1.5, summary: expect.stringContaining('off Friday, overtime x1.5') });
  // a version in between starts from the earlier one
  const mid = await ok(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-08', maxLeavePerYear: 30 }), 201);
  expect(mid).toMatchObject({ lateLimitMinutes: 10, weeklyOffDay: 'SUNDAY', maxLeavePerYear: 30 });

  expect(await eff(w, w.factory, '2026-06')).toMatchObject({ source: 'DEFAULT', lateLimitMinutes: 15 }); // before the first version
  expect(await eff(w, w.factory, '2026-07')).toMatchObject({ source: 'POLICY', id: v1.id, lateLimitMinutes: 10, maxLeavePerYear: 24 });
  expect(await eff(w, w.factory, '2026-09')).toMatchObject({ id: mid.id, maxLeavePerYear: 30 });
  expect(await eff(w, w.factory, '2026-10')).toMatchObject({ id: v2.id, weeklyOffDay: 'FRIDAY' });
  expect(await eff(w, w.factory, '2031-01')).toMatchObject({ id: v2.id }); // holds until a newer one
  expect(await eff(w, w.outlet, '2026-10')).toMatchObject({ source: 'DEFAULT', weeklyOffDay: 'SUNDAY' }); // another group is not touched

  const by = await ok(w.api('get', '/payroll/policies/by-group?month=2026-09'));
  expect(by.data.map((d) => [d.group.name, d.policy.source, d.policy.effectiveFrom])).toEqual([['Factory', 'POLICY', '2026-08'], ['Outlet', 'DEFAULT', null], ['Head Office', 'DEFAULT', null], ['Admin', 'DEFAULT', null]]);
  // a switched-off group is not in the table
  await ok(w.api('patch', `/payroll/groups/${w.adminGroup.id}`, { isActive: false }));
  expect((await ok(w.api('get', '/payroll/policies/by-group'))).data.map((d) => d.group.name)).toEqual(['Factory', 'Outlet', 'Head Office']);

  // the list: newest first inside a group
  expect((await ok(w.api('get', '/payroll/policies'))).data.map((p) => p.effectiveFrom)).toEqual(['2026-10', '2026-08', '2026-07']);
  expect((await ok(w.api('get', `/payroll/policies?groupId=${w.outlet.id}`))).total).toBe(0);
  expect((await ok(w.api('get', '/payroll/policies?limit=1&page=2'))).data.map((p) => p.effectiveFrom)).toEqual(['2026-08']);
  expect(await ok(w.api('get', `/payroll/policies/${v1.id}`))).toMatchObject({ id: v1.id, effectiveFrom: '2026-07' });

  // one version per group and month
  await fails(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-10', lateLimitMinutes: 5 }), 422, 'POLICY_EXISTS');
  expect(await ok(w.api('post', '/payroll/policies', { groupId: w.outlet.id, effectiveFrom: '2026-10' }), 201)).toMatchObject({ effectiveFrom: '2026-10', ...DEFAULTS }); // the same month for another group is fine

  // delete: the months it covered fall back to the version before it
  await ok(w.api('delete', `/payroll/policies/${v2.id}`), 204);
  expect(await eff(w, w.factory, '2026-10')).toMatchObject({ id: mid.id, weeklyOffDay: 'SUNDAY' });
  await fails(w.api('get', `/payroll/policies/${v2.id}`), 404, 'NOT_FOUND');
  await fails(w.api('delete', `/payroll/policies/${v2.id}`), 404, 'NOT_FOUND');
  expect(await AuditLog.count({ where: { action: 'PAYROLL_POLICY_CREATED' } })).toBe(4);
  expect(await AuditLog.count({ where: { action: 'PAYROLL_POLICY_DELETED' } })).toBe(1);
});

test('rules: the half-day limit is more than the late limit; ranges; no weekly off; lates not penalised; edit', async () => {
  const w = await setup();
  const base = { groupId: w.factory.id, effectiveFrom: '2026-10' };
  // the half-day limit must be more than the late limit (also with the defaults filled in)
  const e = await fails(w.api('post', '/payroll/policies', { ...base, lateLimitMinutes: 120 }), 422, 'HALF_DAY_NOT_MORE_THAN_LATE');
  expect(e.details).toEqual({ lateLimitMinutes: 120, halfDayLimitMinutes: 120 });
  await fails(w.api('post', '/payroll/policies', { ...base, lateLimitMinutes: 60, halfDayLimitMinutes: 45 }), 422, 'HALF_DAY_NOT_MORE_THAN_LATE');
  for (const bad of [{ lateLimitMinutes: -1 }, { lateLimitMinutes: 601 }, { lateLimitMinutes: 1.5 }, { lateLimitMinutes: '10' }, { halfDayLimitMinutes: 0 }, { halfDayLimitMinutes: 1441 }, { latesPerHalfDay: 32 }, { latesPerHalfDay: -1 },
    { weeklyOffDay: 'FUNDAY' }, { weeklyOffDay: 'sunday' }, { overtimeFactor: 11 }, { overtimeFactor: 1.234 }, { overtimeFactor: -1 }, { leaveEarnedPerMonth: 32 }, { maxLeavePerYear: 367 }, { monthsBeforeLeave: 121 },
    { effectiveFrom: '2026-13' }, { effectiveFrom: '2026-1' }, { effectiveFrom: '2026-10-01' }, { effectiveFrom: '1999-12' }, { effectiveFrom: undefined }, { groupId: undefined }, { groupId: 'x' }, { name: 'x' }]) {
    await fails(w.api('post', '/payroll/policies', { ...base, ...bad }), 400, 'VALIDATION_FAILED');
  }
  // special values
  const odd = await ok(w.api('post', '/payroll/policies', { ...base, weeklyOffDay: null, latesPerHalfDay: 0, overtimeFactor: 0, leaveEarnedPerMonth: 1.5, monthsBeforeLeave: 0, lateLimitMinutes: 0 }), 201);
  expect(odd).toMatchObject({ weeklyOffDay: null, latesPerHalfDay: 0, overtimeFactor: 0, leaveEarnedPerMonth: 1.5, monthsBeforeLeave: 0, lateLimitMinutes: 0 });
  expect(odd.summary).toBe('Late 0m, half-day 120m, lates not penalised, off none, overtime x0, leave 1.5/mo, max 24/yr, after 0 mo');

  // edit: the check looks at the whole policy; the month and the group cannot change
  await fails(w.api('patch', `/payroll/policies/${odd.id}`, { lateLimitMinutes: 130 }), 422, 'HALF_DAY_NOT_MORE_THAN_LATE');
  await fails(w.api('patch', `/payroll/policies/${odd.id}`, { halfDayLimitMinutes: 0 }), 400, 'VALIDATION_FAILED');
  expect(await ok(w.api('patch', `/payroll/policies/${odd.id}`, { lateLimitMinutes: 130, halfDayLimitMinutes: 200 }))).toMatchObject({ lateLimitMinutes: 130, halfDayLimitMinutes: 200 });
  expect(await ok(w.api('patch', `/payroll/policies/${odd.id}`, { weeklyOffDay: 'SATURDAY' }))).toMatchObject({ weeklyOffDay: 'SATURDAY', lateLimitMinutes: 130 });
  await fails(w.api('patch', `/payroll/policies/${odd.id}`, { effectiveFrom: '2026-11' }), 400, 'VALIDATION_FAILED');
  await fails(w.api('patch', `/payroll/policies/${odd.id}`, { groupId: w.outlet.id }), 400, 'VALIDATION_FAILED');
  await fails(w.api('patch', `/payroll/policies/${odd.id}`, {}), 400, 'VALIDATION_FAILED');
  expect(await AuditLog.count({ where: { action: 'PAYROLL_POLICY_UPDATED', entityId: odd.id } })).toBe(2);
  // the policy in force follows the edit
  expect(await eff(w, w.factory, '2026-12')).toMatchObject({ lateLimitMinutes: 130, weeklyOffDay: 'SATURDAY' });
  await fails(w.api('get', '/payroll/policies/effective'), 400, 'VALIDATION_FAILED'); // a group is needed
  await fails(w.api('get', '/payroll/policies/effective?groupId=3f2b8c1e-5d6a-4b7c-9e0f-1a2b3c4d5e6f'), 404, 'NOT_FOUND');
});

test('access: any payroll service reads, Payroll Employees FULL changes; another company has its own policies', async () => {
  const w = await setup();
  const v = await ok(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-10', lateLimitMinutes: 20 }), 201);
  const person = async (grants) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    for (const [code, access] of grants) await UserService.create({ userId: u.id, serviceId: w.s[code].id, access });
    return asUser(u);
  };
  const nobody = await person([]);
  const salaryView = await person([['PAYROLL_SALARY', 'VIEW']]);
  const employeesFull = await person([['PAYROLL_EMPLOYEES', 'FULL']]);
  await fails(nobody('get', '/payroll/policies'), 403, 'FORBIDDEN');
  await fails(nobody('get', '/payroll/policies/by-group'), 403, 'FORBIDDEN');
  for (const p of [salaryView, employeesFull]) {
    expect((await ok(p('get', '/payroll/policies'))).total).toBe(1);
    expect((await ok(p('get', '/payroll/policies/by-group?month=2026-10'))).data[0].policy.lateLimitMinutes).toBe(20);
    await ok(p('get', `/payroll/policies/effective?groupId=${w.factory.id}&month=2026-10`));
  }
  await fails(salaryView('post', '/payroll/policies', { groupId: w.outlet.id, effectiveFrom: '2026-10' }), 403, 'FORBIDDEN');
  await fails(salaryView('patch', `/payroll/policies/${v.id}`, { lateLimitMinutes: 5 }), 403, 'FORBIDDEN');
  await fails(salaryView('delete', `/payroll/policies/${v.id}`), 403, 'FORBIDDEN');
  expect((await ok(employeesFull('patch', `/payroll/policies/${v.id}`, { lateLimitMinutes: 25 }))).lateLimitMinutes).toBe(25);
  expect((await request(app).get('/api/v1/payroll/policies')).status).toBe(401);

  const other = await setup();
  expect((await ok(other.api('get', '/payroll/policies'))).total).toBe(0);
  expect((await ok(other.api('get', '/payroll/policies/by-group?month=2026-10'))).data[0].policy.source).toBe('DEFAULT');
  await fails(other.api('get', `/payroll/policies/${v.id}`), 404, 'NOT_FOUND');
  await fails(other.api('patch', `/payroll/policies/${v.id}`, { lateLimitMinutes: 1 }), 404, 'NOT_FOUND');
  await fails(other.api('delete', `/payroll/policies/${v.id}`), 404, 'NOT_FOUND');
  await fails(other.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-10' }), 404, 'NOT_FOUND'); // our group
  await fails(other.api('get', `/payroll/policies/effective?groupId=${w.factory.id}&month=2026-10`), 404, 'NOT_FOUND');
});
