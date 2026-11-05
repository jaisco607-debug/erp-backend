const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const { gapOf, serviceText } = require('../src/services/payrollResignationService');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };

async function setup() {
  const company = await makeCompany();
  for (const code of PAYROLL) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = (code, name, extra = {}) => ok(api('post', '/payroll/employees', { code, name, fatherName: 'Ali Baig', cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id,
    designationId: worker.id, shiftId: shift.id, joiningDate: '2026-07-06', basicSalary: 25000, ...extra }), 201);
  const mumtaz = await emp(760, 'Mumtaz Ali');
  const nadeem = await emp(798, 'Nadeem');
  const mushtaq = await emp(737, 'Mushtaq Ali');
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: hrUser.id, serviceId: (await Service.findOne({ where: { code: 'PAYROLL_APPLICATIONS' } })).id, access: 'FULL' });
  return { company, admin, api, hrUser, hr: asUser(hrUser), factory, dept, worker, shift, mumtaz, nadeem, mushtaq };
}
const form = (w, extra = {}) => ({ employeeId: w.mumtaz.id, applicationDate: '2026-10-29', lastWorkingDay: '2026-10-12', reason: 'Employee resigned without notice', ...extra });

test('the gap line and the service text', () => {
  expect(gapOf('2026-10-29', '2026-10-12')).toEqual({ days: 17, text: 'Left 17 days before the application date' });
  expect(gapOf('2026-10-29', '2026-10-28')).toEqual({ days: 1, text: 'Left 1 day before the application date' });
  expect(gapOf('2026-10-29', '2026-11-03')).toEqual({ days: -5, text: 'Leaves 5 days after the application date' });
  expect(gapOf('2026-10-29', '2026-10-29').text).toBe('Last working day is the application date');
  expect(serviceText('2026-07-06', '2026-10-12')).toBe('0y 3m');
  expect(serviceText('2022-04-26', '2026-10-30')).toBe('4y 6m');
});

test('create: the application with the employee card; wrong data is refused; one open resignation per employee; list, search and the tabs', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/resignations', form(w, { refNo: '5256' })), 201);
  expect(a).toMatchObject({ code: 1, appId: '00001', label: 'RES-0001', status: 'DRAFT', statusText: 'Draft', posted: false, applicationDate: '2026-10-29', lastWorkingDay: '2026-10-12',
    gapDays: 17, gapText: 'Left 17 days before the application date', reason: 'Employee resigned without notice', refNo: '5256', hasLeft: false,
    canEdit: true, canSubmit: true, canDelete: true, canWithdraw: false, canApprove: false,
    employee: { code: 760, label: '00760', name: 'MUMTAZ ALI', fatherName: 'ALI BAIG', department: { name: 'Dishwash' }, designation: 'Worker', joiningDate: '2026-07-06', basicSalary: '25000.00', service: '0y 3m', isClosed: false, hasPhoto: false } });
  await fails(w.hr('post', '/payroll/resignations', form(w)), 422, 'RESIGNATION_EXISTS');
  await fails(w.hr('post', '/payroll/resignations', form(w, { employeeId: w.nadeem.id, lastWorkingDay: '2026-07-05' })), 422, 'LAST_DAY_BEFORE_JOINING');
  await fails(w.hr('post', '/payroll/resignations', form(w, { employeeId: w.nadeem.id, applicationDate: '2999-01-01' })), 422, 'DATE_IN_FUTURE');
  await fails(w.hr('post', '/payroll/resignations', form(w, { employeeId: w.nadeem.id, reason: 'x' })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/resignations', { employeeId: w.nadeem.id }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/resignations', form(w, { employeeId: '8f3c1a2e-1111-4222-8333-444455556666' })), 404, 'NOT_FOUND');
  // leaving after the application date
  const b = await ok(w.hr('post', '/payroll/resignations', form(w, { employeeId: w.nadeem.id, lastWorkingDay: '2026-11-03' })), 201);
  expect(b).toMatchObject({ code: 2, gapDays: -5, gapText: 'Leaves 5 days after the application date' });
  const p = await ok(w.hr('patch', `/payroll/resignations/${b.id}`, { reason: 'Better job', refNo: '', lastWorkingDay: '2026-10-31' }));
  expect(p).toMatchObject({ reason: 'Better job', refNo: null, lastWorkingDay: '2026-10-31', gapDays: -2 });
  await fails(w.hr('patch', `/payroll/resignations/${b.id}`, { employeeId: w.mumtaz.id }), 422, 'RESIGNATION_EXISTS');
  expect(await ok(w.api('get', '/payroll/resignations/summary'))).toEqual({ total: 2, draft: 2, inReview: 0, approved: 0, rejected: 0 });
  expect((await ok(w.api('get', '/payroll/resignations'))).data.map((r) => r.code)).toEqual([2, 1]);
  for (const [query, n] of [['search=mumtaz', 1], ['search=5256', 1], ['search=760', 1], ['search=1', 1], ['search=dishwash', 2], ['search=better', 1], [`departmentId=${w.dept.id}`, 2], ['status=IN_REVIEW', 0], [`employeeId=${w.nadeem.id}`, 1], ['from=2026-10-30', 0]]) {
    expect([query, (await ok(w.api('get', `/payroll/resignations?${query}`))).total]).toEqual([query, n]);
  }
  await ok(w.hr('delete', `/payroll/resignations/${b.id}`), 204);
  await fails(w.api('get', `/payroll/resignations/${b.id}`), 404, 'NOT_FOUND');
  await fails(w.api('delete', `/payroll/employees/${w.mumtaz.id}`), 422, 'IN_USE');
});

test('review and approval: HR cannot approve; approving posts it: the employee card is closed with the last working day and his later attendance days go', async () => {
  const w = await setup();
  const rows = [];
  for (const d of ['01', '02', '03', '04']) rows.push({ employeeId: 760, date: `2026-10-${d}`, time: '08:00' }, { employeeId: 760, date: `2026-10-${d}`, time: '16:00' });
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const days = async () => Object.keys((await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${w.mumtaz.id}`))).data[0].days);
  expect((await days()).filter((d) => d <= '2026-10-04')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);

  const a = await ok(w.hr('post', '/payroll/resignations', form(w, { lastWorkingDay: '2026-10-02' })), 201);
  expect(await ok(w.hr('post', `/payroll/resignations/${a.id}/submit`))).toMatchObject({ status: 'IN_REVIEW', statusText: 'In review', canEdit: false, canWithdraw: true, canApprove: false, submittedBy: expect.any(String) });
  await fails(w.hr('post', `/payroll/resignations/${a.id}/approve`), 403);
  await fails(w.hr('patch', `/payroll/resignations/${a.id}/review`, { reason: 'changed' }), 403);
  await fails(w.hr('patch', `/payroll/resignations/${a.id}`, { reason: 'changed' }), 422, 'RESIGNATION_IN_REVIEW');
  await fails(w.hr('delete', `/payroll/resignations/${a.id}`), 422, 'RESIGNATION_IN_REVIEW');
  await fails(w.hr('post', `/payroll/resignations/${a.id}/submit`), 422, 'ALREADY_IN_REVIEW');
  expect(await ok(w.api('get', `/payroll/resignations/${a.id}`))).toMatchObject({ canApprove: true, canReject: true, canReviewEdit: true });
  expect(await ok(w.api('get', '/payroll/resignations/summary'))).toMatchObject({ total: 1, draft: 0, inReview: 1 });
  // the reviewer corrects the last working day (an empty reason is not accepted)
  await fails(w.api('patch', `/payroll/resignations/${a.id}/review`, { lastWorkingDay: '2026-07-05' }), 422, 'LAST_DAY_BEFORE_JOINING');
  await fails(w.api('patch', `/payroll/resignations/${a.id}/review`, { employeeId: w.nadeem.id }), 400, 'VALIDATION_FAILED');
  expect(await ok(w.api('patch', `/payroll/resignations/${a.id}/review`, { lastWorkingDay: '2026-10-03' }))).toMatchObject({ lastWorkingDay: '2026-10-03', gapDays: 26 });

  const done = await ok(w.api('post', `/payroll/resignations/${a.id}/approve`));
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', posted: true, hasLeft: true, canApprove: false, canEdit: false, canWithdraw: false, canReopen: false,
    approval: { by: expect.any(String) }, employee: { isClosed: true, leavingDate: '2026-10-03' } });
  const emp = await ok(w.api('get', `/payroll/employees/${w.mumtaz.id}`));
  expect(emp).toMatchObject({ isClosed: true, state: 'CLOSED', leavingDate: '2026-10-03' });
  expect((await ok(w.api('get', '/payroll/employees'))).data.map((e) => e.code)).not.toContain(760);
  expect((await days()).filter((d) => d <= '2026-10-31')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']); // the 4th (Sunday) is after he left
  await fails(w.api('post', `/payroll/resignations/${a.id}/approve`), 422, 'NOT_IN_REVIEW');
  await fails(w.hr('patch', `/payroll/resignations/${a.id}`, { reason: 'x yz' }), 422, 'RESIGNATION_CLOSED');
  await fails(w.hr('delete', `/payroll/resignations/${a.id}`), 422, 'RESIGNATION_CLOSED');
  await fails(w.hr('post', `/payroll/resignations/${a.id}/submit`), 422, 'RESIGNATION_CLOSED');
  await fails(w.hr('post', '/payroll/resignations', form(w)), 422, 'EMPLOYEE_CLOSED');
  expect(await ok(w.api('get', '/payroll/resignations/summary'))).toMatchObject({ total: 1, approved: 1, inReview: 0 });
  // the employee card can be re-opened as before, and he may resign again
  await ok(w.api('post', `/payroll/employees/${w.mumtaz.id}/reopen`));
  await ok(w.hr('post', '/payroll/resignations', form(w, { reason: 'Second time' })), 201);
});

test('a last working day still to come can be sent and reviewed but only approved from that day', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/resignations', form(w, { applicationDate: TODAY, lastWorkingDay: '2999-12-31' })), 201);
  expect(a.gapDays).toBeLessThan(0);
  await ok(w.hr('post', `/payroll/resignations/${a.id}/submit`));
  const e = await fails(w.api('post', `/payroll/resignations/${a.id}/approve`), 422, 'LAST_DAY_IN_FUTURE');
  expect(e.details).toEqual({ lastWorkingDay: '2999-12-31' });
  expect((await ok(w.api('get', `/payroll/employees/${w.mumtaz.id}`))).isClosed).toBe(false);
  await ok(w.api('patch', `/payroll/resignations/${a.id}/review`, { lastWorkingDay: TODAY }));
  expect((await ok(w.api('post', `/payroll/resignations/${a.id}/approve`))).posted).toBe(true);
  expect((await ok(w.api('get', `/payroll/employees/${w.mumtaz.id}`))).leavingDate).toBe(TODAY);
});

test('reject needs a reason; HR re-opens a rejected application and sends it again; withdraw takes it back from the review', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/resignations', form(w)), 201);
  await ok(w.hr('post', `/payroll/resignations/${a.id}/submit`));
  await fails(w.hr('post', `/payroll/resignations/${a.id}/reject`, { reason: 'Not mine to reject' }), 403);
  await fails(w.api('post', `/payroll/resignations/${a.id}/reject`, {}), 400, 'VALIDATION_FAILED');
  const r = await ok(w.api('post', `/payroll/resignations/${a.id}/reject`, { reason: 'Notice period not served' }));
  expect(r).toMatchObject({ status: 'REJECTED', statusText: 'Rejected', approval: { reason: 'Notice period not served' }, canReopen: true, canEdit: false });
  expect((await ok(w.api('get', '/payroll/employees/' + w.mumtaz.id))).isClosed).toBe(false);
  await fails(w.hr('post', `/payroll/resignations/${a.id}/withdraw`), 422, 'NOT_IN_REVIEW');
  // while it is rejected the employee can get another application; then this one cannot be re-opened
  const other = await ok(w.hr('post', '/payroll/resignations', form(w, { reason: 'A new one' })), 201);
  await fails(w.hr('post', `/payroll/resignations/${a.id}/reopen`), 422, 'RESIGNATION_EXISTS');
  await ok(w.hr('delete', `/payroll/resignations/${other.id}`), 204);
  expect(await ok(w.hr('post', `/payroll/resignations/${a.id}/reopen`))).toMatchObject({ status: 'DRAFT', approval: null, canEdit: true });
  await fails(w.hr('post', `/payroll/resignations/${a.id}/reopen`), 422, 'NOT_REJECTED');
  await ok(w.hr('post', `/payroll/resignations/${a.id}/submit`));
  expect(await ok(w.hr('post', `/payroll/resignations/${a.id}/withdraw`))).toMatchObject({ status: 'DRAFT', canEdit: true });
});

test('employees who stopped coming: no punch for N days up to the latest day the machine has data for; the last day he came is suggested', async () => {
  const w = await setup();
  expect(await ok(w.api('get', '/payroll/resignations/absentees?days=10'))).toMatchObject({ asOf: null, total: 0, data: [] });
  const punch = (code, date) => [{ employeeId: code, date, time: '08:00' }, { employeeId: code, date, time: '16:00' }];
  // Mumtaz came until the 1st, Nadeem until the 20th (the machine's latest day), Mushtaq never
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows: [...punch(760, '2026-10-01'), ...punch(798, '2026-10-20')] }), 201);
  const r = await ok(w.api('get', '/payroll/resignations/absentees?days=10'));
  expect(r).toMatchObject({ asOf: '2026-10-20', days: 10, total: 2 });
  expect(r.data.map((x) => x.employee.code)).toEqual([737, 760]); // the longest away first
  expect(r.data[0]).toMatchObject({ neverPunched: true, lastPunchDate: null, suggestedLastWorkingDay: null, daysSincePunch: 106 });
  expect(r.data[1]).toMatchObject({ employee: { name: 'MUMTAZ ALI', department: { name: 'Dishwash' } }, neverPunched: false, lastPunchDate: '2026-10-01', suggestedLastWorkingDay: '2026-10-01', daysSincePunch: 19 });
  expect((await ok(w.api('get', '/payroll/resignations/absentees?days=20'))).data.map((x) => x.employee.code)).toEqual([737]);
  expect((await ok(w.api('get', '/payroll/resignations/absentees?days=19'))).total).toBe(2);
  // an open resignation takes him off the list
  await ok(w.hr('post', '/payroll/resignations', form(w, { lastWorkingDay: '2026-10-01' })), 201);
  expect((await ok(w.api('get', '/payroll/resignations/absentees?days=10'))).data.map((x) => x.employee.code)).toEqual([737]);
});

test('access: reading needs any payroll service, writing needs PAYROLL_APPLICATIONS with FULL; another company sees nothing', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/resignations', form(w)), 201);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'PAYROLL_REPORTS' } })).id, access: 'VIEW' });
  const v = asUser(viewer);
  await ok(v('get', `/payroll/resignations/${a.id}`));
  await ok(v('get', '/payroll/resignations/absentees'));
  for (const [m, url, body] of [['post', '/payroll/resignations', form(w)], ['patch', `/payroll/resignations/${a.id}`, { reason: 'abc' }], ['post', `/payroll/resignations/${a.id}/submit`, {}]]) expect((await v(m, url, body)).status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/resignations/${a.id}`), 404, 'NOT_FOUND');
  await fails(other.hr('post', '/payroll/resignations', form(w)), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', '/payroll/resignations'))).total).toBe(0);
});

test('month filter on the application date: from / to, alone or together, with status; a wrong order is refused', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/resignations', form(w, { applicationDate: '2026-10-29' })), 201);
  const b = await ok(w.hr('post', '/payroll/resignations', form(w, { employeeId: w.nadeem.id, applicationDate: '2026-10-05', lastWorkingDay: '2026-10-01' })), 201);
  const codes = async (q) => (await ok(w.api('get', `/payroll/resignations?${q}`))).data.map((r) => r.id).sort();
  const sorted = (...x) => x.map((r) => r.id).sort();
  const oct = await ok(w.api('get', '/payroll/resignations?from=2026-10-01&to=2026-10-31&page=1&limit=15'));
  expect([oct.total, oct.limit]).toEqual([2, 15]);
  expect(await codes('from=2026-10-06&to=2026-10-31')).toEqual(sorted(a));
  expect(await codes('to=2026-10-05')).toEqual(sorted(b));
  expect(await codes('from=2026-11-01&to=2026-11-30')).toEqual([]);
  expect(await codes('from=2026-10-01&to=2026-10-31&status=DRAFT')).toEqual(sorted(a, b));
  expect(await codes('from=2026-10-01&to=2026-10-31&status=APPROVED')).toEqual([]);
  expect((await ok(w.api('get', '/payroll/resignations/summary'))).draft).toBe(2);
  for (const q of ['from=2026-10-31&to=2026-10-01', 'from=nope', 'to=2026-02-30']) {
    const r = await w.api('get', `/payroll/resignations?${q}`);
    expect([r.status, r.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
  }
});
