const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };

// 2026-10-05 is a Monday, 2026-10-11 a Sunday (the default weekly off day)
async function setup() {
  const company = await makeCompany();
  for (const code of PAYROLL) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Dishwash', fte: 0 }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = (code, name, joiningDate) => ok(api('post', '/payroll/employees', { code, name, groupId: factory.id, departmentId: dept.id, shiftId: shift.id, joiningDate }), 201);
  const vet = await emp(101, 'Veteran Ali', '2025-01-10'); // eligible from 2025-07-10: credited from 2025-08-01
  const mid = await emp(102, 'Mid Term', '2026-01-10'); // credited from 2026-08-01
  const newbie = await emp(103, 'Newbie Khan', '2026-06-01'); // eligible from 2026-12-01
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: hrUser.id, serviceId: (await Service.findOne({ where: { code: 'PAYROLL_APPLICATIONS' } })).id, access: 'FULL' });
  return { company, admin, api, hr: asUser(hrUser), factory, dept, shift, vet, mid, newbie };
}
const leave = (w, extra = {}) => ({ employeeId: w.vet.id, fromDate: '2026-10-05', toDate: '2026-10-11', reason: 'Family function', ...extra });
const approved = async (w, extra = {}) => {
  const a = await ok(w.hr('post', '/payroll/leaves', leave(w, extra)), 201);
  await ok(w.hr('post', `/payroll/leaves/${a.id}/submit`));
  return ok(w.api('post', `/payroll/leaves/${a.id}/approve`));
};

test('preview and balance: the working days (the weekly off day and holidays are not counted) and what the policy has given the employee', async () => {
  const w = await setup();
  const p = await ok(w.api('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-10-05&toDate=2026-10-11`));
  expect(p).toMatchObject({ days: 6, dates: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], restDays: [{ date: '2026-10-11', reason: 'Weekly off' }], enough: true,
    balance: { earned: 30, taken: 0, pending: 0, available: 30, eligibleFrom: '2025-07-10' } }); // 2025: Aug to Dec = 10, 2026: Jan to Oct = 20
  await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-10-07', name: 'Special day', appliesToAll: true }), 201);
  const h = await ok(w.api('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-10-05&toDate=2026-10-11`));
  expect(h).toMatchObject({ days: 5, restDays: [{ date: '2026-10-07', reason: 'Special day' }, { date: '2026-10-11', reason: 'Weekly off' }] });
  const m = await ok(w.api('get', `/payroll/leaves/preview?employeeId=${w.mid.id}&fromDate=2026-10-05&toDate=2026-10-05`));
  expect(m).toMatchObject({ days: 1, enough: true, balance: { earned: 6, available: 6, eligibleFrom: '2026-07-10' } });
  const n = await ok(w.api('get', `/payroll/leaves/preview?employeeId=${w.newbie.id}&fromDate=2026-10-05&toDate=2026-10-05`));
  expect(n).toMatchObject({ days: 1, enough: false, balance: { earned: 0, available: 0, eligibleFrom: '2026-12-01' } });
  expect(await ok(w.api('get', `/payroll/leaves/balance?employeeId=${w.vet.id}&date=2025-12-31`))).toMatchObject({ earned: 10, taken: 0, available: 10, employee: { code: 101, label: '00101' },
    byYear: [{ year: 2025, credited: 10, earned: 10 }], policy: { leaveEarnedPerMonth: 2, maxLeavePerYear: 24, monthsBeforeLeave: 6 } });
  await fails(w.api('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-10-09&toDate=2026-10-05`), 422, 'TO_BEFORE_FROM');
  await fails(w.api('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-10-05`), 400, 'VALIDATION_FAILED');
});

test('create: dates, reason and overlap are checked; the application shows its working days, rest days and balance', async () => {
  const w = await setup();
  await fails(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2026-10-11', toDate: '2026-10-11' })), 422, 'NO_WORKING_DAYS');
  await fails(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2026-10-09', toDate: '2026-10-05' })), 422, 'TO_BEFORE_FROM');
  await fails(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2024-12-30', toDate: '2025-01-02' })), 422, 'LEAVE_BEFORE_JOINING');
  await fails(w.hr('post', '/payroll/leaves', leave(w, { reason: 'x' })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/leaves', leave(w, { applicationDate: '2999-01-01' })), 422, 'DATE_IN_FUTURE');
  await fails(w.hr('post', '/payroll/leaves', { employeeId: w.vet.id }), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/leaves', leave(w, { employeeId: '8f3c1a2e-1111-4222-8333-444455556666' })), 404, 'NOT_FOUND');
  const a = await ok(w.hr('post', '/payroll/leaves', leave(w)), 201);
  expect(a).toMatchObject({ code: 1, appId: '00001', label: 'LV-0001', status: 'DRAFT', statusText: 'Draft', leaveType: 'ANNUAL', leaveTypeText: 'Annual leave', fromDate: '2026-10-05', toDate: '2026-10-11', days: 6,
    dates: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], restDays: [{ date: '2026-10-11', reason: 'Weekly off' }], applicationDate: TODAY, reason: 'Family function',
    employee: { code: 101, name: 'VETERAN ALI', department: { name: 'Dishwash' }, group: { name: 'Factory' } }, balance: { earned: 30, taken: 0, pending: 0, available: 30, requested: 6, enough: true },
    previousLeaves: [], canEdit: true, canSubmit: true, canApprove: false, canCancel: false });
  await fails(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2026-10-09', toDate: '2026-10-14' })), 422, 'LEAVE_OVERLAP');
  const edited = await ok(w.hr('patch', `/payroll/leaves/${a.id}`, { toDate: '2026-10-07', reason: 'Wedding' }));
  expect(edited).toMatchObject({ days: 3, toDate: '2026-10-07', reason: 'Wedding', dates: ['2026-10-05', '2026-10-06', '2026-10-07'] });
  // another employee is not in the way
  await ok(w.hr('post', '/payroll/leaves', leave(w, { employeeId: w.mid.id })), 201);
  const b = await ok(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2026-10-12', toDate: '2026-10-12' })), 201);
  expect(b.previousLeaves).toEqual([expect.objectContaining({ appId: '00001', days: 3, status: 'DRAFT' })]);
  expect(await ok(w.api('get', '/payroll/leaves/summary'))).toEqual({ total: 3, draft: 3, inReview: 0, approved: 0, rejected: 0, cancelled: 0 });
  for (const [query, n] of [['search=veteran', 2], ['search=101', 2], ['search=wedding', 1], ['search=dishwash', 3], ['status=APPROVED', 0], [`employeeId=${w.mid.id}`, 1], ['from=2999-01-01', 0]]) {
    expect([query, (await ok(w.api('get', `/payroll/leaves?${query}`))).total]).toEqual([query, n]);
  }
  await ok(w.hr('delete', `/payroll/leaves/${b.id}`), 204);
  await fails(w.api('delete', `/payroll/employees/${w.vet.id}`), 422, 'IN_USE');
});

test('send and approve: the balance is checked and reserved, HR cannot approve, the reviewer approves and the balance falls', async () => {
  const w = await setup();
  const low = await ok(w.hr('post', '/payroll/leaves', leave(w, { employeeId: w.newbie.id, fromDate: '2026-10-05', toDate: '2026-10-05' })), 201);
  expect(low.balance).toMatchObject({ available: 0, requested: 1, enough: false, eligibleFrom: '2026-12-01' });
  const e = await fails(w.hr('post', `/payroll/leaves/${low.id}/submit`), 422, 'LEAVE_BALANCE_LOW');
  expect(e.details).toMatchObject({ available: 0, requested: 1, earned: 0, eligibleFrom: '2026-12-01' });

  // 6 days are available to Mid Term on 2026-10-05: 4 are reserved by the first application, so the second (3 days) does not fit
  const a = await ok(w.hr('post', '/payroll/leaves', leave(w, { employeeId: w.mid.id, fromDate: '2026-10-05', toDate: '2026-10-08' })), 201);
  const b = await ok(w.hr('post', '/payroll/leaves', leave(w, { employeeId: w.mid.id, fromDate: '2026-10-26', toDate: '2026-10-28' })), 201);
  expect(await ok(w.hr('post', `/payroll/leaves/${a.id}/submit`))).toMatchObject({ status: 'IN_REVIEW', statusText: 'In review', canEdit: false, canWithdraw: true, submittedBy: expect.any(String) });
  const e2 = await fails(w.hr('post', `/payroll/leaves/${b.id}/submit`), 422, 'LEAVE_BALANCE_LOW');
  expect(e2.details).toMatchObject({ available: 2, requested: 3, pending: 4 });
  await fails(w.hr('post', `/payroll/leaves/${a.id}/approve`), 403);
  await fails(w.hr('patch', `/payroll/leaves/${a.id}/review`, { reason: 'changed' }), 403);
  await fails(w.hr('patch', `/payroll/leaves/${a.id}`, { reason: 'changed' }), 422, 'LEAVE_IN_REVIEW');
  await fails(w.hr('delete', `/payroll/leaves/${a.id}`), 422, 'LEAVE_IN_REVIEW');
  await fails(w.hr('post', `/payroll/leaves/${a.id}/submit`), 422, 'ALREADY_IN_REVIEW');
  expect(await ok(w.api('get', `/payroll/leaves/${a.id}`))).toMatchObject({ canApprove: true, canReject: true, canReviewEdit: true, canCancel: false });
  // the reviewer shortens it to 2 days; that leaves 4 for the second application
  expect(await ok(w.api('patch', `/payroll/leaves/${a.id}/review`, { toDate: '2026-10-06' }))).toMatchObject({ days: 2, toDate: '2026-10-06' });
  await fails(w.api('patch', `/payroll/leaves/${a.id}/review`, { toDate: '2026-10-24' }), 422, 'LEAVE_BALANCE_LOW');
  await fails(w.api('patch', `/payroll/leaves/${a.id}/review`, { employeeId: w.vet.id }), 400, 'VALIDATION_FAILED');
  const done = await ok(w.api('post', `/payroll/leaves/${a.id}/approve`));
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', days: 2, approval: { by: expect.any(String) }, canApprove: false, canCancel: true, canEdit: false, canWithdraw: false,
    dates: ['2026-10-05', '2026-10-06'], balance: { earned: 6, taken: 2, available: 4, enough: true } });
  await ok(w.hr('post', `/payroll/leaves/${b.id}/submit`));
  await fails(w.api('post', `/payroll/leaves/${a.id}/approve`), 422, 'NOT_IN_REVIEW');
  await fails(w.hr('patch', `/payroll/leaves/${a.id}`, { reason: 'later' }), 422, 'LEAVE_CLOSED');
  await fails(w.hr('delete', `/payroll/leaves/${a.id}`), 422, 'LEAVE_CLOSED');
  expect(await ok(w.hr('post', `/payroll/leaves/${b.id}/withdraw`))).toMatchObject({ status: 'DRAFT' });
  await fails(w.hr('post', `/payroll/leaves/${b.id}/withdraw`), 422, 'NOT_IN_REVIEW');
  expect(await ok(w.api('get', '/payroll/leaves/summary'))).toMatchObject({ total: 3, draft: 2, approved: 1 });
});

test('reject needs a reason; HR re-opens a rejected application and sends it again', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/leaves', leave(w)), 201);
  await ok(w.hr('post', `/payroll/leaves/${a.id}/submit`));
  await fails(w.api('post', `/payroll/leaves/${a.id}/reject`, {}), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', `/payroll/leaves/${a.id}/reject`, { reason: 'Not mine to reject' }), 403);
  const r = await ok(w.api('post', `/payroll/leaves/${a.id}/reject`, { reason: 'Production rush that week' }));
  expect(r).toMatchObject({ status: 'REJECTED', statusText: 'Rejected', approval: { reason: 'Production rush that week' }, canReopen: true, canEdit: false });
  await fails(w.hr('post', `/payroll/leaves/${a.id}/withdraw`), 422, 'NOT_IN_REVIEW');
  expect(await ok(w.hr('post', `/payroll/leaves/${a.id}/reopen`))).toMatchObject({ status: 'DRAFT', approval: null, canEdit: true });
  await fails(w.hr('post', `/payroll/leaves/${a.id}/reopen`), 422, 'NOT_REJECTED');
  // a rejected application does not hold the dates or the balance
  expect((await ok(w.api('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-10-05&toDate=2026-10-09`))).balance.pending).toBe(0);
});

test('approved leave shows as AL in the attendance on the days nobody punched on; cancelling it brings the days and the balance back', async () => {
  const w = await setup();
  // somebody has punches for the week, so the days have data behind them
  const rows = [];
  for (const d of ['05', '06', '07', '08', '09']) rows.push({ employeeId: 102, date: `2026-10-${d}`, time: '08:00' }, { employeeId: 102, date: `2026-10-${d}`, time: '16:00' });
  rows.push({ employeeId: 101, date: '2026-10-07', time: '08:00' }, { employeeId: 101, date: '2026-10-07', time: '16:00' }); // the veteran works on one day of his leave
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const days = async () => (await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${w.vet.id}`))).data[0].days;
  expect(Object.entries(await days()).filter(([d]) => d >= '2026-10-05' && d <= '2026-10-09').map(([, x]) => x.code)).toEqual(['A', 'A', 'P', 'A', 'A']);

  const a = await approved(w);
  expect(a.days).toBe(6);
  expect(Object.entries(await days()).filter(([d]) => d >= '2026-10-05' && d <= '2026-10-09').map(([, x]) => x.code)).toEqual(['AL', 'AL', 'P', 'AL', 'AL']);
  expect((await ok(w.api('get', `/payroll/attendance/summary?month=2026-10&employeeId=${w.vet.id}`))).data[0]).toMatchObject({ AL: 5, P: 1 }); // the 5th, 6th, 8th, 9th and the Saturday

  await fails(w.hr('post', `/payroll/leaves/${a.id}/cancel`, { reason: 'Not needed' }), 403);
  await fails(w.api('post', `/payroll/leaves/${a.id}/cancel`, {}), 400, 'VALIDATION_FAILED');
  const c = await ok(w.api('post', `/payroll/leaves/${a.id}/cancel`, { reason: 'He did not go' }));
  expect(c).toMatchObject({ status: 'CANCELLED', statusText: 'Cancelled', approval: { reason: 'He did not go', by: expect.any(String) }, canCancel: false, canEdit: false });
  await fails(w.api('post', `/payroll/leaves/${a.id}/cancel`, { reason: 'Again' }), 422, 'NOT_APPROVED');
  expect(Object.entries(await days()).filter(([d]) => d >= '2026-10-05' && d <= '2026-10-09').map(([, x]) => x.code)).toEqual(['A', 'A', 'P', 'A', 'A']);
  expect((await ok(w.api('get', `/payroll/leaves/balance?employeeId=${w.vet.id}&date=2026-10-05`))).taken).toBe(0);
  // the dates are free again
  await ok(w.hr('post', '/payroll/leaves', leave(w)), 201);
});

test('the Annual Leaves report: carried from the years before, earned, taken, waiting and left; one employee\'s statement month by month', async () => {
  const w = await setup();
  const a = await approved(w, { fromDate: '2025-12-01', toDate: '2025-12-05', reason: 'Winter break' });
  expect(a).toMatchObject({ days: 5, balance: { earned: 10, taken: 5, available: 5 } });
  const pending = await ok(w.hr('post', '/payroll/leaves', leave(w, { fromDate: '2025-12-15', toDate: '2025-12-16' })), 201);
  await ok(w.hr('post', `/payroll/leaves/${pending.id}/submit`));

  const r25 = await ok(w.api('get', '/payroll/reports/annual-leaves?year=2025'));
  expect(r25).toMatchObject({ year: 2025, asOf: '2025-12-31', total: 1, totals: { opening: 0, earned: 10, taken: 5, pending: 2, balance: 5 } }); // only the employee who had joined by 2025
  expect(r25.data.map((x) => x.employee.code)).toEqual([101]);
  expect(r25.data[0]).toMatchObject({ employee: { code: 101, label: '00101', name: 'VETERAN ALI', department: { name: 'Dishwash' } }, eligibleFrom: '2025-07-10', opening: 0, earned: 10, taken: 5, pending: 2, balance: 5, available: 3 });

  // 2026: what was left of 2025 is carried on
  const r26 = await ok(w.api('get', '/payroll/reports/annual-leaves?year=2026'));
  const months = TODAY.startsWith('2026') ? Number(TODAY.slice(5, 7)) : 12; // the running year is credited up to today, a year gone by in full
  const vet = r26.data.find((x) => x.employee.code === 101);
  expect(vet).toMatchObject({ opening: 5, earned: Math.min(months * 2, 24), taken: 0, pending: 0 });
  expect(vet.balance).toBe(5 + Math.min(months * 2, 24));
  const mid = r26.data.find((x) => x.employee.code === 102);
  expect(mid).toMatchObject({ opening: 0, eligibleFrom: '2026-07-10' });
  expect(r26.data.find((x) => x.employee.code === 103)).toMatchObject({ eligibleFrom: '2026-12-01' });
  expect((await ok(w.api('get', '/payroll/reports/annual-leaves?year=2026&search=mid'))).total).toBe(1);
  expect((await ok(w.api('get', `/payroll/reports/annual-leaves?year=2026&departmentId=${w.dept.id}`))).total).toBe(3);

  const s = await ok(w.api('get', `/payroll/reports/annual-leaves/${w.vet.id}?year=2025`));
  expect(s).toMatchObject({ year: 2025, employee: { code: 101, group: 'Factory' }, eligibleFrom: '2025-07-10', opening: 0, earned: 10, taken: 5, pending: 2, balance: 5, available: 3 });
  expect(s.months.map((m) => m.credited)).toEqual([0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2]);
  expect(s.months.map((m) => m.taken)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
  expect(s.months[11].pending).toBe(2);
  expect(s.leaves.map((l) => [l.label, l.status, l.days])).toEqual([['LV-0001', 'APPROVED', 5], ['LV-0002', 'IN_REVIEW', 2]]);
  await fails(w.api('get', `/payroll/reports/annual-leaves/${w.vet.id}?year=1999`), 400, 'VALIDATION_FAILED');
});

test('access: reading needs a payroll service, HR writes, only a reviewer approves, another company sees nothing', async () => {
  const w = await setup();
  const a = await approved(w);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'PAYROLL_REPORTS' } })).id, access: 'VIEW' });
  const v = asUser(viewer);
  await ok(v('get', `/payroll/leaves/${a.id}`));
  await ok(v('get', '/payroll/reports/annual-leaves'));
  await ok(v('get', `/payroll/leaves/preview?employeeId=${w.vet.id}&fromDate=2026-11-02&toDate=2026-11-02`));
  expect((await v('post', '/payroll/leaves', leave(w, { fromDate: '2026-11-02', toDate: '2026-11-02' }))).status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/leaves/${a.id}`), 404, 'NOT_FOUND');
  await fails(other.hr('post', '/payroll/leaves', leave(w, { fromDate: '2026-11-02', toDate: '2026-11-02' })), 404, 'NOT_FOUND');
  await fails(other.api('get', `/payroll/reports/annual-leaves/${w.vet.id}`), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', '/payroll/leaves'))).total).toBe(0);
  const left = await sequelize.query('SELECT count(*)::int AS n FROM payroll_leave_days', { type: sequelize.QueryTypes.SELECT });
  expect(left[0].n).toBe(6);
});
