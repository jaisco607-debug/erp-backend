const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, AuditLog } = require('../src/models');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); expect(r.body.error.code).toBe(code); return r.body.error; };

async function setup(codes = PAYROLL) {
  const company = await makeCompany();
  const s = {};
  for (const code of codes) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  return { company, s, admin, api: asUser(admin) };
}

test('groups: the four defaults are made for every company, can be renamed or switched off but never deleted; own groups can be added and deleted when unused', async () => {
  const w = await setup();
  const list = await ok(w.api('get', '/payroll/groups'));
  expect(list.data.map((g) => [g.name, g.systemKey, g.isDefault, g.canDelete])).toEqual([
    ['Factory', 'FACTORY', true, false], ['Outlet', 'OUTLET', true, false], ['Head Office', 'HEAD_OFFICE', true, false], ['Admin', 'ADMIN', true, false]]);
  expect(list.total).toBe(4);
  // asking again does not make them twice
  expect((await ok(w.api('get', '/payroll/groups'))).total).toBe(4);

  // own group
  const mine = await ok(w.api('post', '/payroll/groups', { name: ' Warehouse ' }), 201);
  expect(mine).toMatchObject({ name: 'Warehouse', isDefault: false, systemKey: null, isActive: true, sortOrder: 50, departments: 0, canDelete: true });
  await fails(w.api('post', '/payroll/groups', { name: 'warehouse' }), 422, 'NAME_TAKEN');
  await fails(w.api('post', '/payroll/groups', { name: 'FACTORY' }), 422, 'NAME_TAKEN');
  await fails(w.api('post', '/payroll/groups', { name: '' }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/groups', { name: 'X', systemKey: 'FACTORY' }), 400, 'VALIDATION_FAILED');

  // a default can be renamed (and stays default), switched off; never deleted
  const factory = list.data[0];
  expect(await ok(w.api('patch', `/payroll/groups/${factory.id}`, { name: 'Mill' }))).toMatchObject({ name: 'Mill', systemKey: 'FACTORY', isDefault: true });
  expect((await ok(w.api('get', '/payroll/groups'))).total).toBe(5); // renamed Factory is not made again
  expect(await ok(w.api('patch', `/payroll/groups/${factory.id}`, { isActive: false }))).toMatchObject({ isActive: false });
  await fails(w.api('delete', `/payroll/groups/${factory.id}`), 422, 'DEFAULT_GROUP');
  expect((await ok(w.api('get', '/payroll/groups?isActive=true'))).total).toBe(4);
  expect((await ok(w.api('get', '/payroll/groups?search=ware'))).data.map((g) => g.name)).toEqual(['Warehouse']);
  await fails(w.api('patch', `/payroll/groups/${mine.id}`, { name: 'Mill' }), 422, 'NAME_TAKEN');
  expect(await ok(w.api('patch', `/payroll/groups/${mine.id}`, { sortOrder: 5 }))).toMatchObject({ sortOrder: 5 });

  // an own group with a department cannot be deleted; empty it and it goes
  const dept = await ok(w.api('post', '/payroll/departments', { groupId: mine.id, name: 'Loading', fte: 4 }), 201);
  expect((await ok(w.api('get', `/payroll/groups/${mine.id}`)))).toMatchObject({ departments: 1, canDelete: false });
  const used = await fails(w.api('delete', `/payroll/groups/${mine.id}`), 422, 'IN_USE');
  expect(used.details).toEqual({ departments: 1, holidays: 0, employees: 0 });
  await ok(w.api('delete', `/payroll/departments/${dept.id}`), 204);
  await ok(w.api('delete', `/payroll/groups/${mine.id}`), 204);
  await fails(w.api('get', `/payroll/groups/${mine.id}`), 404, 'NOT_FOUND');
  // a group used by a holiday cannot be deleted either
  const g2 = await ok(w.api('post', '/payroll/groups', { name: 'Night Team' }), 201);
  const h = await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-12-25', name: 'Quaid Day', appliesToAll: false, groupIds: [g2.id] }), 201);
  expect((await fails(w.api('delete', `/payroll/groups/${g2.id}`), 422, 'IN_USE')).details).toEqual({ departments: 0, holidays: 1, employees: 0 });
  await ok(w.api('delete', `/payroll/holidays/${h.id}`), 204);
  await ok(w.api('delete', `/payroll/groups/${g2.id}`), 204);
  // the audit log has the changes
  expect(await AuditLog.count({ where: { entityType: 'PayrollGroup', action: 'PAYROLLGROUP_CREATED' } })).toBeGreaterThanOrEqual(2);
  expect(await AuditLog.count({ where: { entityType: 'PayrollGroup', action: 'PAYROLLGROUP_DELETED' } })).toBe(2);
});

test('departments: a group, a name and the approved head-count (fte); unique inside the group; filters', async () => {
  const w = await setup();
  const groups = (await ok(w.api('get', '/payroll/groups'))).data;
  const [factory, outlet] = groups;
  const d1 = await ok(w.api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte: 10 }), 201);
  expect(d1).toMatchObject({ name: 'Dishwash', fte: 10, isActive: true, group: { id: factory.id, name: 'Factory' }, canDelete: true });
  expect((await ok(w.api('post', '/payroll/departments', { groupId: factory.id, name: 'Packing' }), 201)).fte).toBe(0); // default 0
  await fails(w.api('post', '/payroll/departments', { groupId: factory.id, name: 'dishwash' }), 422, 'NAME_TAKEN'); // same group
  const other = await ok(w.api('post', '/payroll/departments', { groupId: outlet.id, name: 'Dishwash', fte: 2 }), 201); // same name, other group: fine
  expect(other.group.name).toBe('Outlet');
  for (const bad of [{ fte: -1 }, { fte: 1.5 }, { fte: '5' }, { name: '' }, { groupId: 'x' }]) await fails(w.api('post', '/payroll/departments', { groupId: factory.id, name: 'Z', ...bad }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/departments', { groupId: '3f2b8c1e-5d6a-4b7c-9e0f-1a2b3c4d5e6f', name: 'Ghost' }), 404, 'NOT_FOUND');

  expect(await ok(w.api('patch', `/payroll/departments/${d1.id}`, { fte: 12, name: 'Dish Wash' }))).toMatchObject({ fte: 12, name: 'Dish Wash' });
  await fails(w.api('patch', `/payroll/departments/${d1.id}`, { name: 'Packing' }), 422, 'NAME_TAKEN');
  expect(await ok(w.api('patch', `/payroll/departments/${d1.id}`, { groupId: outlet.id }))).toMatchObject({ group: { name: 'Outlet' } });
  await fails(w.api('patch', `/payroll/departments/${d1.id}`, { name: 'Dishwash' }), 422, 'NAME_TAKEN'); // the other Outlet one
  // a switched-off group takes no new department
  await ok(w.api('patch', `/payroll/groups/${outlet.id}`, { isActive: false }));
  await fails(w.api('post', '/payroll/departments', { groupId: outlet.id, name: 'New' }), 422, 'GROUP_INACTIVE');

  expect((await ok(w.api('get', `/payroll/departments?groupId=${factory.id}`))).data.map((d) => d.name)).toEqual(['Packing']);
  expect((await ok(w.api('get', '/payroll/departments?search=outlet'))).total).toBe(2); // the group name is searched too
  expect((await ok(w.api('get', '/payroll/departments?limit=1&page=2'))).data).toHaveLength(1);
  await ok(w.api('patch', `/payroll/departments/${other.id}`, { isActive: false }));
  expect((await ok(w.api('get', '/payroll/departments?isActive=false'))).data.map((d) => d.id)).toEqual([other.id]);
});

test('designations and banks: unique names, optional codes, search, delete', async () => {
  const w = await setup();
  const worker = await ok(w.api('post', '/payroll/designations', { name: 'Worker' }), 201);
  await ok(w.api('post', '/payroll/designations', { name: 'Floor Manager' }), 201);
  await fails(w.api('post', '/payroll/designations', { name: 'WORKER' }), 422, 'NAME_TAKEN');
  expect((await ok(w.api('get', '/payroll/designations'))).data.map((d) => d.name)).toEqual(['Floor Manager', 'Worker']);
  expect(await ok(w.api('patch', `/payroll/designations/${worker.id}`, { name: 'Senior Worker' }))).toMatchObject({ name: 'Senior Worker' });
  await ok(w.api('delete', `/payroll/designations/${worker.id}`), 204);
  expect((await ok(w.api('get', '/payroll/designations'))).total).toBe(1);

  const bank = await ok(w.api('post', '/payroll/banks', { name: 'Meezan Bank', shortName: 'MEZN', bankCode: '0110' }), 201);
  expect(bank).toMatchObject({ name: 'Meezan Bank', shortName: 'MEZN', bankCode: '0110', isActive: true });
  expect(await ok(w.api('post', '/payroll/banks', { name: 'HBL', shortName: '', bankCode: null }), 201)).toMatchObject({ shortName: null, bankCode: null });
  await fails(w.api('post', '/payroll/banks', { name: 'meezan bank' }), 422, 'NAME_TAKEN');
  await fails(w.api('post', '/payroll/banks', { name: 'X', shortName: 'x'.repeat(21) }), 400, 'VALIDATION_FAILED');
  expect((await ok(w.api('get', '/payroll/banks?search=0110'))).data.map((b) => b.name)).toEqual(['Meezan Bank']);
  expect((await ok(w.api('get', '/payroll/banks?search=mezn'))).total).toBe(1);
  expect(await ok(w.api('patch', `/payroll/banks/${bank.id}`, { bankCode: '' }))).toMatchObject({ bankCode: null });
  await ok(w.api('delete', `/payroll/banks/${bank.id}`), 204);
});

test('shifts: code, start, end, duty hours, night shift; the rules about midnight and the length of the shift', async () => {
  const w = await setup();
  const day = await ok(w.api('post', '/payroll/shifts', { code: '08a-06p', startTime: '08:00', endTime: '18:00', dutyHours: 10 }), 201);
  expect(day).toMatchObject({ code: '08A-06P', startTime: '08:00', endTime: '18:00', dutyHours: 10, isNight: false, spanHours: 10, crossesMidnight: false, label: '08A-06P (08:00-18:00, 10 hrs)' });
  const night = await ok(w.api('post', '/payroll/shifts', { code: 'N8', name: 'Night', startTime: '20:00', endTime: '04:00', dutyHours: 8, isNight: true }), 201);
  expect(night).toMatchObject({ spanHours: 8, crossesMidnight: true, isNight: true, name: 'Night' });
  await fails(w.api('post', '/payroll/shifts', { code: '08A-06P', startTime: '09:00', endTime: '17:00', dutyHours: 8 }), 422, 'NAME_TAKEN');
  await fails(w.api('post', '/payroll/shifts', { code: 'X1', startTime: '22:00', endTime: '06:00', dutyHours: 8 }), 422, 'SHIFT_CROSSES_MIDNIGHT'); // not marked night
  await fails(w.api('post', '/payroll/shifts', { code: 'X2', startTime: '08:00', endTime: '08:00', dutyHours: 8 }), 422, 'SHIFT_TIMES');
  const tooLong = await fails(w.api('post', '/payroll/shifts', { code: 'X3', startTime: '08:00', endTime: '12:00', dutyHours: 5 }), 422, 'DUTY_MORE_THAN_SHIFT');
  expect(tooLong.details).toEqual({ spanHours: 4 });
  for (const bad of [{ startTime: '8:00' }, { startTime: '24:00' }, { endTime: '12:60' }, { dutyHours: 0 }, { dutyHours: 25 }, { dutyHours: '8' }, { code: '' }]) {
    await fails(w.api('post', '/payroll/shifts', { code: 'B', startTime: '08:00', endTime: '17:00', dutyHours: 8, ...bad }), 400, 'VALIDATION_FAILED');
  }
  // an edit is checked against the whole shift, not only the changed field
  await fails(w.api('patch', `/payroll/shifts/${day.id}`, { dutyHours: 11 }), 422, 'DUTY_MORE_THAN_SHIFT');
  await fails(w.api('patch', `/payroll/shifts/${day.id}`, { endTime: '07:00' }), 422, 'SHIFT_CROSSES_MIDNIGHT');
  expect(await ok(w.api('patch', `/payroll/shifts/${day.id}`, { endTime: '17:00', dutyHours: 9 }))).toMatchObject({ endTime: '17:00', dutyHours: 9, spanHours: 9 });
  expect(await ok(w.api('patch', `/payroll/shifts/${night.id}`, { name: '' }))).toMatchObject({ name: null });
  expect((await ok(w.api('get', '/payroll/shifts'))).data.map((s) => s.code)).toEqual(['08A-06P', 'N8']); // by start time
  expect((await ok(w.api('get', '/payroll/shifts?search=n8'))).data.map((s) => s.code)).toEqual(['N8']);
  await ok(w.api('delete', `/payroll/shifts/${night.id}`), 204);
});

test('holidays: for every group or for chosen groups; filters by year, dates and group; unique per day and name', async () => {
  const w = await setup();
  const [factory, outlet, head] = (await ok(w.api('get', '/payroll/groups'))).data;
  const all = await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-08-14', name: 'Independence Day' }), 201);
  expect(all).toMatchObject({ date: '2026-08-14', weekday: 'Friday', name: 'Independence Day', appliesToAll: true, groups: [] });
  const some = await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-10-29', name: 'Factory Maintenance', appliesToAll: false, groupIds: [factory.id, outlet.id] }), 201);
  expect(some).toMatchObject({ appliesToAll: false, groups: [{ name: 'Factory' }, { name: 'Outlet' }] });
  await ok(w.api('post', '/payroll/holidays', { holidayDate: '2027-03-23', name: 'Pakistan Day' }), 201);
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-08-14', name: 'independence day' }), 422, 'NAME_TAKEN');
  await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-08-14', name: 'Another Event' }), 201); // two holidays on one day are fine
  // the rules about the groups
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-09-01', name: 'A', appliesToAll: false }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-09-01', name: 'A', appliesToAll: false, groupIds: [] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-09-01', name: 'A', groupIds: [factory.id] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-09-01', name: 'A', appliesToAll: false, groupIds: ['3f2b8c1e-5d6a-4b7c-9e0f-1a2b3c4d5e6f'] }), 404, 'NOT_FOUND');
  await fails(w.api('post', '/payroll/holidays', { holidayDate: '2026-02-30', name: 'A' }), 400, 'VALIDATION_FAILED');

  // filters
  const names = async (q) => (await ok(w.api('get', `/payroll/holidays?${q}`))).data.map((h) => h.name);
  expect((await ok(w.api('get', '/payroll/holidays'))).data.map((h) => h.date)).toEqual(['2026-08-14', '2026-08-14', '2026-10-29', '2027-03-23']);
  expect(await names('year=2027')).toEqual(['Pakistan Day']);
  expect(await names('dateFrom=2026-09-01&dateTo=2026-12-31')).toEqual(['Factory Maintenance']);
  expect(await names(`groupId=${head.id}`)).toEqual(['Another Event', 'Independence Day', 'Pakistan Day']); // the one for Factory and Outlet does not count for Head Office
  expect(await names(`groupId=${factory.id}&year=2026`)).toEqual(['Another Event', 'Independence Day', 'Factory Maintenance']);
  expect(await names('search=maint')).toEqual(['Factory Maintenance']);

  // changing the groups
  expect(await ok(w.api('patch', `/payroll/holidays/${some.id}`, { groupIds: [head.id] }))).toMatchObject({ appliesToAll: false, groups: [{ name: 'Head Office' }] });
  expect(await ok(w.api('patch', `/payroll/holidays/${some.id}`, { name: 'Maintenance Day', holidayDate: '2026-10-30' }))).toMatchObject({ name: 'Maintenance Day', date: '2026-10-30', weekday: 'Friday', groups: [{ name: 'Head Office' }] });
  expect(await ok(w.api('patch', `/payroll/holidays/${some.id}`, { appliesToAll: true }))).toMatchObject({ appliesToAll: true, groups: [] });
  await fails(w.api('patch', `/payroll/holidays/${some.id}`, { appliesToAll: false }), 422, 'GROUPS_REQUIRED'); // it has none left
  await fails(w.api('patch', `/payroll/holidays/${all.id}`, { groupIds: [factory.id] }), 422, 'GROUPS_NOT_ALLOWED');
  expect(await ok(w.api('patch', `/payroll/holidays/${all.id}`, { appliesToAll: false, groupIds: [factory.id] }))).toMatchObject({ appliesToAll: false, groups: [{ name: 'Factory' }] });
  await fails(w.api('patch', `/payroll/holidays/${all.id}`, { name: 'Another Event' }), 422, 'NAME_TAKEN');
  await ok(w.api('delete', `/payroll/holidays/${all.id}`), 204);
  expect((await ok(w.api('get', '/payroll/holidays'))).total).toBe(3);
});

test('masters in one call for the dropdowns: only the active ones', async () => {
  const w = await setup();
  const groups = (await ok(w.api('get', '/payroll/groups'))).data;
  const d = await ok(w.api('post', '/payroll/departments', { groupId: groups[0].id, name: 'Dishwash', fte: 10 }), 201);
  const off = await ok(w.api('post', '/payroll/departments', { groupId: groups[0].id, name: 'Old' }), 201);
  await ok(w.api('patch', `/payroll/departments/${off.id}`, { isActive: false }));
  await ok(w.api('post', '/payroll/designations', { name: 'Worker' }), 201);
  await ok(w.api('post', '/payroll/shifts', { code: 'D', startTime: '08:00', endTime: '17:00', dutyHours: 8 }), 201);
  await ok(w.api('post', '/payroll/banks', { name: 'HBL' }), 201);
  const m = await ok(w.api('get', '/payroll/masters'));
  expect(m.groups.map((g) => g.name)).toEqual(['Factory', 'Outlet', 'Head Office', 'Admin']);
  expect(m.departments).toEqual([{ id: d.id, name: 'Dishwash', groupId: groups[0].id, fte: 10 }]);
  expect(m.designations.map((x) => x.name)).toEqual(['Worker']);
  expect(m.shifts).toEqual([expect.objectContaining({ code: 'D', label: 'D (08:00-17:00, 8 hrs)', dutyHours: 8, isNight: false })]);
  expect(m.banks.map((x) => x.name)).toEqual(['HBL']);
});

test('access: reading needs any payroll service, changing needs Payroll Employees with FULL; another company sees nothing', async () => {
  const w = await setup();
  const groups = (await ok(w.api('get', '/payroll/groups'))).data;
  const dept = await ok(w.api('post', '/payroll/departments', { groupId: groups[0].id, name: 'Dishwash', fte: 3 }), 201);

  const person = async (grants) => {
    const u = await makeUser({ userType: 'USER', companyId: w.company.id });
    for (const [code, access] of grants) await UserService.create({ userId: u.id, serviceId: w.s[code].id, access });
    return asUser(u);
  };
  const nobody = await person([]);
  const salaryView = await person([['PAYROLL_SALARY', 'VIEW']]);
  const employeesView = await person([['PAYROLL_EMPLOYEES', 'VIEW']]);
  const employeesFull = await person([['PAYROLL_EMPLOYEES', 'FULL']]);
  const salaryFull = await person([['PAYROLL_SALARY', 'FULL']]);

  await fails(nobody('get', '/payroll/groups'), 403, 'FORBIDDEN');
  await fails(nobody('get', '/payroll/masters'), 403, 'FORBIDDEN');
  for (const p of [salaryView, employeesView, employeesFull, salaryFull]) { // any payroll service reads (the salary screens need the dropdowns)
    expect((await ok(p('get', '/payroll/departments'))).total).toBe(1);
    await ok(p('get', '/payroll/masters'));
  }
  for (const p of [salaryView, employeesView, salaryFull]) { // only Payroll Employees FULL changes
    await fails(p('post', '/payroll/designations', { name: 'X' }), 403, 'FORBIDDEN');
    await fails(p('patch', `/payroll/departments/${dept.id}`, { fte: 9 }), 403, 'FORBIDDEN');
    await fails(p('delete', `/payroll/departments/${dept.id}`), 403, 'FORBIDDEN');
  }
  expect((await ok(employeesFull('patch', `/payroll/departments/${dept.id}`, { fte: 9 }))).fte).toBe(9);
  expect((await request(app).get('/api/v1/payroll/groups')).status).toBe(401);

  // a company without any payroll service: refused; another company has its own masters (its own four groups, none of ours)
  const plain = await setup(['GREY_STORE']);
  await fails(plain.api('get', '/payroll/groups'), 403, 'FORBIDDEN');
  const other = await setup();
  const theirs = await ok(other.api('get', '/payroll/groups'));
  expect(theirs.data.map((g) => g.id).some((id) => groups.some((g) => g.id === id))).toBe(false);
  expect((await ok(other.api('get', '/payroll/departments'))).total).toBe(0);
  await fails(other.api('get', `/payroll/departments/${dept.id}`), 404, 'NOT_FOUND');
  await fails(other.api('patch', `/payroll/departments/${dept.id}`, { fte: 1 }), 404, 'NOT_FOUND');
  await fails(other.api('delete', `/payroll/departments/${dept.id}`), 404, 'NOT_FOUND');
  await fails(other.api('post', '/payroll/departments', { groupId: groups[0].id, name: 'Steal' }), 404, 'NOT_FOUND'); // our group id
  expect(await sequelize.query('SELECT count(*)::int AS n FROM payroll_groups', { type: sequelize.QueryTypes.SELECT })).toEqual([{ n: 8 }]);
});
