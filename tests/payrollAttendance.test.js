const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');

beforeEach(clean);

const PAYROLL = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };

async function setup() {
  const company = await makeCompany();
  for (const code of PAYROLL) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const day = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const night = await ok(api('post', '/payroll/shifts', { code: 'NIGHT', startTime: '20:00', endTime: '06:00', dutyHours: 10, isNight: true }), 201);
  const emp = (code, name, shift, extra = {}) => ok(api('post', '/payroll/employees', { code, name, groupId: factory.id, joiningDate: '2026-01-01', shiftId: shift.id, ...extra }), 201);
  const e593 = await emp(593, 'Abdul Ghani', day);
  const e594 = await emp(594, 'Night Guard', night);
  const e595 = await emp(595, 'Never Came', day);
  return { company, admin, api, factory, day, night, e593, e594, e595 };
}
// 2026-10-01 is a Thursday, 2026-10-04 a Sunday (the default weekly off day)
const rows = [
  { employeeId: 593, date: '2026-10-01', time: '08:05' }, { employeeId: 593, date: '2026-10-01', time: '18:00' }, // P, late 5, overtime 115
  { employeeId: 593, date: '2026-10-02', time: '08:20' }, { employeeId: 593, date: '2026-10-02', time: '16:00' }, // L
  { employeeId: 593, date: '2026-10-03', time: '10:30' }, { employeeId: 593, date: '2026-10-03', time: '16:00' }, // HD
  { employeeId: 593, date: '2026-10-04', time: '09:00' }, { employeeId: 593, date: '2026-10-04', time: '13:00' }, // Sunday: R, 240 overtime
  { employeeId: 594, date: '2026-10-01', time: '19:55', device: 'Boat Basin' }, { employeeId: 594, date: '2026-10-02', time: '06:10', device: 'Boat Basin' }, // night shift of the 1st
  { employeeId: 999, date: '2026-10-01', time: '08:00', device: 'Garden' }, // nobody has this ID yet
];

test('preview shows what an import would do and saves nothing; bad rows, repeats and unknown IDs are reported', async () => {
  const w = await setup();
  const bad = [...rows, rows[0], { employeeId: 593, date: '2026-13-01', time: '08:00' }, { employeeId: 'x', date: '2026-10-01', time: '08:00' }, { employeeId: 593, date: '2026-10-01', time: '8' }];
  const p = await ok(w.api('post', '/payroll/attendance/punches/preview', { rows: bad }));
  expect(p).toMatchObject({ total: 15, valid: 11, invalid: 3, duplicatesInFile: 1, alreadyInSystem: 0, toImport: 11, employees: 2, unknownIdCount: 1, unknownIds: [{ employeeId: 999, punches: 1 }],
    devices: ['Boat Basin', 'Garden'], from: '2026-10-01', to: '2026-10-04' });
  expect(p.invalidRows.map((r) => r.row)).toEqual([13, 14, 15]);
  expect(p.invalidRows[0].reason).toMatch(/date/i);
  expect((await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'))).punches).toBe(0);
  await fails(w.api('post', '/payroll/attendance/punches/preview', { rows: [] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/attendance/punches/preview', { rows: Array.from({ length: 5001 }, () => ({})) }), 400, 'VALIDATION_FAILED');
});

test('import: punches are stored, the days are worked out from the shift and the policy, repeating the file changes nothing', async () => {
  const w = await setup();
  const r = await ok(w.api('post', '/payroll/attendance/punches/import', { rows, source: 'EXCEL', fileName: 'oct-1-4.xlsx' }), 201);
  expect(r).toMatchObject({ source: 'EXCEL', total: 11, inserted: 11, duplicates: 0, invalid: 0, unknownIdCount: 1, from: '2026-10-01', to: '2026-10-04' });
  expect(r.processed.days).toBeGreaterThan(0);

  const grid = await ok(w.api('get', '/payroll/attendance/days?month=2026-10'));
  const by = (code) => grid.data.find((x) => x.employee.code === code);
  const a = by(593).days;
  expect(a['2026-10-01']).toMatchObject({ code: 'P', lateMinutes: 5, workedMinutes: 595, overtimeMinutes: 115, firstIn: '2026-10-01 08:05', lastOut: '2026-10-01 18:00', manual: false, incomplete: false });
  expect(a['2026-10-02']).toMatchObject({ code: 'L', lateMinutes: 20 });
  expect(a['2026-10-03']).toMatchObject({ code: 'HD', lateMinutes: 150 });
  expect(a['2026-10-04']).toMatchObject({ code: 'R', restDay: true, overtimeMinutes: 240 });
  // only the days the data covers, and the rest days of the month up to today even though no file reached them: the 5th to the 10th have no punch from anybody, so no result
  expect(Object.keys(a)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
  expect(a['2026-10-18']).toMatchObject({ code: 'R', punches: 0, restDay: true, overtimeMinutes: 0 });
  // night shift: both punches belong to the 1st
  expect(by(594).days['2026-10-01']).toMatchObject({ code: 'P', workedMinutes: 615, overtimeMinutes: 15, firstIn: '2026-10-01 19:55', lastOut: '2026-10-02 06:10' });
  expect(by(594).days['2026-10-02']).toMatchObject({ code: 'A', punches: 0 }); // nothing on the 2nd: absent, not a leftover of the night before
  // the one who never came: absent on working days, rest on Sunday
  expect(Object.entries(by(595).days).filter(([d]) => d <= '2026-10-04').map(([, d]) => d.code)).toEqual(['A', 'A', 'A', 'R']);
  expect(by(593).totals).toMatchObject({ P: 1, L: 1, HD: 1, R: 4, A: 0, overtimeMinutes: 355, overtimeHours: 5.92, overtimeDays: 0.74 });

  const again = await ok(w.api('post', '/payroll/attendance/punches/import', { rows, fileName: 'oct-1-4.xlsx' }), 200);
  expect(again).toMatchObject({ inserted: 0, duplicates: 11, processed: { days: 0 } });
  const pre = await ok(w.api('post', '/payroll/attendance/punches/preview', { rows }));
  expect(pre).toMatchObject({ alreadyInSystem: 11, toImport: 0 });
  expect((await ok(w.api('get', '/payroll/attendance/days?month=2026-10'))).data.length).toBe(3);
});

test('the summary screen: month figures, devices with missing dates, daily counts, details, unmapped IDs, last import', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows, fileName: 'a.xlsx' }), 201);
  const o = await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'));
  expect(o).toMatchObject({ month: '2026-10', punches: 11, employees: 2, deviceCount: 2, unmappedPunches: 1, unmappedIds: 1, today: 0, api: { configured: false } });
  expect(o.lastSync).toMatchObject({ source: 'EXCEL', fileName: 'a.xlsx', inserted: 11, duplicates: 0 });
  const boat = o.devices.find((d) => d.name === 'Boat Basin');
  expect(boat).toMatchObject({ punches: 2, lastRecord: '2026-10-02 06:10' });
  expect(boat.missingDates).toContain('2026-10-03');
  expect(boat.missingDates).not.toContain('2026-10-01');
  expect(o.daily.find((d) => d.date === '2026-10-01')).toMatchObject({ punches: 4, employees: 3 }); // the night guard's morning punch is on the 2nd
  expect(o.daily.map((d) => d.date)).toEqual(['2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);

  const day = await ok(w.api('get', '/payroll/attendance/punches?date=2026-10-01'));
  expect(day.total).toBe(4);
  expect(day.data[0]).toMatchObject({ time: '2026-10-01 08:00:00', employeeCode: 999, unmapped: true, employee: null, device: { name: 'Garden' } });
  expect(day.data.find((p) => p.employeeCode === 593)).toMatchObject({ employee: { name: 'ABDUL GHANI' }, unmapped: false });
  expect((await ok(w.api('get', '/payroll/attendance/punches?unmapped=true'))).total).toBe(1);
  expect((await ok(w.api('get', '/payroll/attendance/punches?employeeCode=593&from=2026-10-02&to=2026-10-03'))).total).toBe(4);
  const un = await ok(w.api('get', '/payroll/attendance/unmapped?month=2026-10'));
  expect(un).toMatchObject({ total: 1, data: [{ employeeCode: 999, employeeLabel: '00999', punches: 1, devices: ['Garden'] }] });
  // creating the employee with that ID picks the punch up: no import again
  const g999 = await ok(w.api('post', '/payroll/employees', { code: 999, name: 'Garden Guard', groupId: w.factory.id, joiningDate: '2026-01-01', shiftId: w.day.id }), 201);
  // his days are there at once (no import, no Recalculate): the 08:00 punch is on time but alone, so incomplete
  expect((await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${g999.id}`))).data[0].days['2026-10-01']).toMatchObject({ code: 'P', incomplete: true, punches: 1 });
  expect((await ok(w.api('get', '/payroll/attendance/unmapped?month=2026-10'))).total).toBe(0);
  expect((await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'))).employees).toBe(3);

  const daily = await ok(w.api('get', '/payroll/attendance/daily?date=2026-10-01'));
  expect(daily).toMatchObject({ date: '2026-10-01', counts: { P: 3, A: 1 }, noData: false, punches: 4 });
  expect((await ok(w.api('get', '/payroll/attendance/daily?date=2026-10-01&code=A'))).data.map((d) => d.employee.name)).toEqual(['NEVER CAME']);
  expect(await ok(w.api('get', '/payroll/attendance/daily?date=2026-10-20'))).toMatchObject({ noData: true, total: 0 });
  const devs = await ok(w.api('get', '/payroll/attendance/devices'));
  const g = devs.data.find((d) => d.name === 'Garden');
  expect(await ok(w.api('patch', `/payroll/attendance/devices/${g.id}`, { name: 'Garden (new)', isActive: false }))).toMatchObject({ name: 'Garden (new)', isActive: false });
});

test('month totals: overtime in days (20 hours on an 8 hour shift = 2.5 days) and the days to pay', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const id = w.e593.id;
  // HR records 20 hours of overtime in all on top of the machine's 355 minutes: 1200 minutes on one day
  const e = await ok(w.api('patch', `/payroll/attendance/days/${id}/2026-10-02`, { code: 'P', overtimeMinutes: 1200, note: 'Dyeing rush' }));
  expect(e.day).toMatchObject({ code: 'P', manual: true, overtimeMinutes: 1200, overtimeHours: 20, note: 'Dyeing rush' });
  const s = await ok(w.api('get', `/payroll/attendance/summary?month=2026-10&employeeId=${id}`));
  expect(s.data[0]).toMatchObject({ P: 2, L: 0, HD: 1, R: 4, overtimeMinutes: 1555, overtimeDays: 3.24, manualDays: 1, lateDeductionDays: 0, payableDays: 6.5 }); // 2 P + 4 R + half of the HD
  // the machine's own answer is kept; an automatic recalculation keeps the hand-set day; the Recalculate button gives it back to the machine
  expect(e.day.originalCode).toBe('L');
  expect((await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'))).manualDays).toBe(1);
  const mine = async () => (await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${id}`))).data[0].days['2026-10-02'];
  expect(await ok(w.api('post', '/payroll/attendance/process', { from: '2026-10-01', to: '2026-10-04', keepManual: true }))).toMatchObject({ manualReset: 0 });
  expect(await mine()).toMatchObject({ code: 'P', manual: true, originalCode: 'L', overtimeMinutes: 1200 });
  expect(await ok(w.api('post', '/payroll/attendance/process', { from: '2026-10-01', to: '2026-10-04' }))).toMatchObject({ manualReset: 1 });
  expect(await mine()).toMatchObject({ code: 'L', manual: false, originalCode: null, overtimeMinutes: 0 });
  // one day can also be given back on its own
  await ok(w.api('patch', `/payroll/attendance/days/${id}/2026-10-02`, { code: 'A', note: 'left early' }));
  expect(await mine()).toMatchObject({ code: 'A', manual: true, originalCode: 'L' });
  const back = await ok(w.api('delete', `/payroll/attendance/days/${id}/2026-10-02`));
  expect(back.day).toMatchObject({ code: 'L', manual: false, overtimeMinutes: 0 });
  await fails(w.api('delete', `/payroll/attendance/days/${id}/2026-10-02`), 422, 'NOT_MANUAL');
  // leave by hand, and the limits of a hand-set day
  expect((await ok(w.api('patch', `/payroll/attendance/days/${w.e595.id}/2026-10-01`, { code: 'AL' }))).day).toMatchObject({ code: 'AL', manual: true });
  await fails(w.api('patch', `/payroll/attendance/days/${id}/2999-01-01`, { code: 'P' }), 422, 'DATE_IN_FUTURE');
  await fails(w.api('patch', `/payroll/attendance/days/${id}/2025-12-31`, { code: 'P' }), 422, 'BEFORE_JOINING');
  await fails(w.api('patch', `/payroll/attendance/days/${id}/2026-10-02`, { code: 'X' }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', '/payroll/attendance/process', { from: '2026-10-05', to: '2026-10-01' }), 422, 'RANGE_BACKWARDS');
  await fails(w.api('post', '/payroll/attendance/process', { from: '2026-01-01', to: '2026-12-31' }), 422, 'RANGE_TOO_LONG');
});

test('lates cost days: the policy of the group decides how many lates make half a day', async () => {
  const w = await setup();
  const late = [];
  for (const d of ['01', '02', '05', '06', '07', '08']) late.push({ employeeId: 593, date: `2026-10-${d}`, time: '08:30' }, { employeeId: 593, date: `2026-10-${d}`, time: '16:00' });
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows: late }), 201);
  const s = await ok(w.api('get', `/payroll/attendance/summary?month=2026-10&employeeId=${w.e593.id}`));
  // 6 lates at 3 lates = half a day: 2 x 0.5 off; Sunday is R; Saturday the 3rd has no punch from anybody, so no result
  expect(s.data[0]).toMatchObject({ L: 6, R: 4, A: 0, lateDeductionDays: 1, payableDays: 9 });
  await ok(w.api('post', '/payroll/policies', { groupId: w.factory.id, effectiveFrom: '2026-10', lateLimitMinutes: 45 }), 201);
  // no Recalculate needed: the new policy is applied to the days by itself
  expect((await ok(w.api('get', `/payroll/attendance/summary?month=2026-10&employeeId=${w.e593.id}`))).data[0]).toMatchObject({ P: 6, L: 0, lateDeductionDays: 0 });
});

test('a holiday is a rest day for its group; the machine being off for a day does not mark everyone absent', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-10-02', name: 'Special day', appliesToAll: true }), 201);
  const two = [{ employeeId: 593, date: '2026-10-01', time: '08:00' }, { employeeId: 593, date: '2026-10-01', time: '16:00' }, { employeeId: 593, date: '2026-10-05', time: '08:00' }, { employeeId: 593, date: '2026-10-05', time: '16:00' }];
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows: two }), 201);
  const d = (await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${w.e595.id}`))).data[0].days;
  expect(d['2026-10-02']).toMatchObject({ code: 'R', restDay: true }); // the holiday
  expect(d['2026-10-03']).toBeUndefined(); // Saturday: no punch from anybody, no data (not 'absent')
  expect(d['2026-10-04']).toMatchObject({ code: 'R' }); // Sunday
  expect(d['2026-10-01']).toMatchObject({ code: 'A' });
});

test('undo an import: its punches go, the days are worked out again, hand-set days stay; the machine API is not connected yet', async () => {
  const w = await setup();
  const r = await ok(w.api('post', '/payroll/attendance/punches/import', { rows, fileName: 'wrong.xlsx' }), 201);
  await ok(w.api('patch', `/payroll/attendance/days/${w.e593.id}/2026-10-01`, { code: 'AL' }));
  const list = await ok(w.api('get', '/payroll/attendance/batches'));
  expect(list.data[0]).toMatchObject({ id: r.batchId, fileName: 'wrong.xlsx', inserted: 11, canUndo: true, isUndone: false });
  expect(await ok(w.api('delete', `/payroll/attendance/batches/${r.batchId}`))).toEqual({ id: r.batchId, removed: 11 });
  await fails(w.api('delete', `/payroll/attendance/batches/${r.batchId}`), 422, 'ALREADY_UNDONE');
  expect((await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'))).punches).toBe(0);
  const grid = (await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${w.e593.id}`))).data[0].days;
  expect(Object.keys(grid)).toEqual(['2026-10-01', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']); // the hand-set day and the Sundays; every day that needed punches is gone
  expect(grid['2026-10-01']).toMatchObject({ code: 'AL', manual: true });
  expect(grid['2026-10-04']).toMatchObject({ code: 'R', punches: 0, overtimeMinutes: 0 });
  expect((await ok(w.api('get', '/payroll/attendance/overview?month=2026-10'))).lastSync).toBeNull();
  await fails(w.api('post', '/payroll/attendance/fetch', { from: '2026-10-01', to: '2026-10-02' }), 422, 'API_NOT_CONFIGURED');
});

test('access: reading needs any payroll service, importing and correcting needs PAYROLL_SALARY with FULL; another company sees nothing', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'PAYROLL_REPORTS' } })).id, access: 'VIEW' });
  const v = asUser(viewer);
  await ok(v('get', '/payroll/attendance/overview?month=2026-10'));
  await ok(v('get', '/payroll/attendance/days?month=2026-10'));
  for (const [m, url, body] of [['post', '/payroll/attendance/punches/import', { rows }], ['post', '/payroll/attendance/process', { from: '2026-10-01', to: '2026-10-02' }],
    ['patch', `/payroll/attendance/days/${w.e593.id}/2026-10-01`, { code: 'AL' }], ['post', '/payroll/attendance/fetch', {}]]) expect((await v(m, url, body)).status).toBe(403);
  const other = await setup();
  expect((await ok(other.api('get', '/payroll/attendance/overview?month=2026-10'))).punches).toBe(0);
  expect((await ok(other.api('get', '/payroll/attendance/days?month=2026-10'))).data.every((x) => Object.keys(x.days).length === 0)).toBe(true);
  await fails(other.api('patch', `/payroll/attendance/days/${w.e593.id}/2026-10-01`, { code: 'AL' }), 404, 'NOT_FOUND');
});

test('holidays, shifts and employees change the days by themselves; hand-set days stay', async () => {
  const w = await setup();
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const day = async (date, id = w.e593.id) => (await ok(w.api('get', `/payroll/attendance/days?month=2026-10&employeeId=${id}`))).data[0].days[date];
  expect(await day('2026-10-01')).toMatchObject({ code: 'P', overtimeMinutes: 115 });
  // a holiday added after the file: that day is a rest day now, and all the hours worked on it are overtime
  const h = await ok(w.api('post', '/payroll/holidays', { holidayDate: '2026-10-01', name: 'Founders day', appliesToAll: true }), 201);
  expect(await day('2026-10-01')).toMatchObject({ code: 'R', restDay: true, overtimeMinutes: 595, lateMinutes: 0 });
  expect(await day('2026-10-01', w.e595.id)).toMatchObject({ code: 'R' });
  // a day HR set stays through the automatic recalculation; the holiday going away brings the machine's answer back for the rest
  await ok(w.api('patch', `/payroll/attendance/days/${w.e593.id}/2026-10-02`, { code: 'P' }));
  await ok(w.api('delete', `/payroll/holidays/${h.id}`), 204);
  expect(await day('2026-10-01')).toMatchObject({ code: 'P', overtimeMinutes: 115 });
  expect(await day('2026-10-01', w.e595.id)).toMatchObject({ code: 'A' });
  expect(await day('2026-10-02')).toMatchObject({ code: 'P', manual: true, originalCode: 'L' });
  // the shift of the employees moves an hour later: the 10:30 arrival is 90 minutes late, not 150
  expect(await day('2026-10-03')).toMatchObject({ code: 'HD', lateMinutes: 150 });
  await ok(w.api('patch', `/payroll/shifts/${w.day.id}`, { startTime: '09:00', endTime: '17:00' }));
  expect(await day('2026-10-03')).toMatchObject({ code: 'L', lateMinutes: 90 });
  // another shift for one employee: 10:30 on a 10:00 shift is 30 minutes late
  const evening = await ok(w.api('post', '/payroll/shifts', { code: 'LATE', startTime: '10:00', endTime: '18:00', dutyHours: 8 }), 201);
  await ok(w.api('patch', `/payroll/employees/${w.e593.id}`, { shiftId: evening.id }));
  expect(await day('2026-10-03')).toMatchObject({ code: 'L', lateMinutes: 30 });
  expect(await day('2026-10-01', w.e595.id)).toMatchObject({ code: 'A' });
});

test('the same file again, or with a few new rows: only the new punches are stored, no empty batch; device and mode are optional; bad formats are invalid rows', async () => {
  const w = await setup();
  const base = [{ employeeId: 593, date: '2026-10-01', time: '08:05:00' }, { employeeId: 593, date: '2026-10-01', time: '18:00:00' }, { employeeId: 593, date: '2026-10-02', time: '08:00:00', device: 'Boat Basin', mode: 8 }];
  const first = await ok(w.api('post', '/payroll/attendance/punches/import', { rows: base, source: 'EXCEL', fileName: 'a.xlsx' }), 201);
  expect(first).toMatchObject({ total: 3, inserted: 3, duplicates: 0 });
  const batches = async () => (await ok(w.api('get', '/payroll/attendance/batches'))).data.length;
  expect(await batches()).toBe(1);
  // device and mode left out: stored as null (no "Unknown" device is made)
  const list = (await ok(w.api('get', '/payroll/attendance/punches?date=2026-10-01'))).data;
  expect(list.map((p) => [p.device, p.mode])).toEqual([[null, null], [null, null]]);
  expect((await ok(w.api('get', '/payroll/attendance/punches?date=2026-10-02'))).data[0]).toMatchObject({ device: { name: 'Boat Basin' }, mode: 8 });
  expect((await ok(w.api('get', '/payroll/attendance/devices'))).data.map((d) => d.name)).toEqual(['Boat Basin']);
  // the same file again: preview says nothing to import; the import answers 200 with nothing stored and no new batch
  const pre = await ok(w.api('post', '/payroll/attendance/punches/preview', { rows: base }));
  expect(pre).toMatchObject({ toImport: 0, alreadyInSystem: 3 });
  const again = await ok(w.api('post', '/payroll/attendance/punches/import', { rows: base, source: 'EXCEL', fileName: 'a.xlsx' }), 200);
  expect(again).toMatchObject({ inserted: 0, duplicates: 3, batchId: null, processed: { days: 0 } });
  expect(await batches()).toBe(1);
  // 08:05 is the same moment as an earlier 08:05:00; three new rows are the only ones stored
  const more = [{ employeeId: 593, date: '2026-10-01', time: '08:05' }, ...base, { employeeId: 593, date: '2026-10-03', time: '08:00:00' }, { employeeId: 593, date: '2026-10-03', time: '16:00:00' }, { employeeId: 593, date: '2026-10-05', time: '08:00:00' }];
  const second = await ok(w.api('post', '/payroll/attendance/punches/import', { rows: more, source: 'EXCEL', fileName: 'a2.xlsx' }), 201);
  expect(second).toMatchObject({ inserted: 3, duplicates: 4, invalid: 0 });
  expect(await batches()).toBe(2);
  // formats other than YYYY-MM-DD and HH:MM[:SS] are invalid rows with a clear reason, never a 500
  const bad = await ok(w.api('post', '/payroll/attendance/punches/preview', { rows: [{ employeeId: 593, date: '30/10/2026', time: '08:00' }, { employeeId: 593, date: '2026-10-30', time: '8:00 PM' }] }));
  expect(bad.invalidRows.map((r) => r.reason)).toEqual(['Date must be YYYY-MM-DD', 'Time must be HH:MM or HH:MM:SS']);
});

test('month reports: attendance report (code + in / out) and punch report (every punch), all employees, one employee, filters, Excel', async () => {
  const w = await setup();
  const dept = await ok(w.api('post', '/payroll/departments', { groupId: w.factory.id, name: 'Assembly', fte: 0 }), 201);
  await ok(w.api('patch', `/payroll/employees/${w.e593.id}`, { departmentId: dept.id }));
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows, source: 'EXCEL' }), 201);
  const bin = (url) => { const r = request(app).get(`/api/v1${url}`); return loginAs(w.admin).then((t) => { r.set({ Authorization: `Bearer ${t.accessToken}` }); r.buffer(true); r.parse((res, done) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => done(null, Buffer.concat(c))); }); return r; }); };

  // attendance report: everybody of the month on one sheet
  const r = await ok(w.api('get', '/payroll/attendance/report?month=2026-10'));
  expect(r).toMatchObject({ month: '2026-10', monthLabel: 'October 2026', total: 3 });
  expect(r.dates).toHaveLength(31);
  expect(r.dates[0]).toEqual({ date: '2026-10-01', day: 1, weekday: 'Thu' });
  expect(r.data.map((x) => [x.sr, x.employee.code, x.employee.label])).toEqual([[1, 593, '00593'], [2, 594, '00594'], [3, 595, '00595']]);
  const a = r.data[0];
  expect(a.employee).toMatchObject({ name: 'ABDUL GHANI', department: { name: 'Assembly' } });
  expect(a.days).toHaveLength(31);
  expect(a.days[0]).toMatchObject({ date: '2026-10-01', code: 'P', in: '08:05', out: '18:00', lateMinutes: 5, outNextDay: false });
  expect(a.days[1]).toMatchObject({ code: 'L', in: '08:20', out: '16:00' });
  expect(a.days[2]).toMatchObject({ code: 'HD' });
  expect(a.days[3]).toMatchObject({ code: 'R', in: '09:00', out: '13:00' });
  expect(a.totals).toMatchObject({ P: 1, L: 1, HD: 1, R: 4 });
  expect(r.data[1].days[0]).toMatchObject({ code: 'P', in: '19:55', out: '06:10', outNextDay: true }); // the night shift ends the next morning
  expect(r.data[2].days[0]).toMatchObject({ code: 'A', in: null, out: null });
  expect(r.summary).toMatchObject({ employees: 3 });
  // filters: department, one employee, search
  expect((await ok(w.api('get', `/payroll/attendance/report?month=2026-10&departmentId=${dept.id}`))).data.map((x) => x.employee.code)).toEqual([593]);
  expect((await ok(w.api('get', `/payroll/attendance/report?month=2026-10&employeeId=${w.e595.id}`))).data.map((x) => x.employee.code)).toEqual([595]);
  expect((await ok(w.api('get', '/payroll/attendance/report?month=2026-10&search=night'))).data.map((x) => x.employee.code)).toEqual([594]);
  expect((await ok(w.api('get', '/payroll/attendance/report?month=2026-10&limit=2&page=2'))).data.map((x) => x.sr)).toEqual([3]);
  // one employee: every date of the month with the details
  const d = await ok(w.api('get', `/payroll/attendance/report/employees/${w.e593.id}?month=2026-10`));
  expect(d.employee).toMatchObject({ code: 593, name: 'ABDUL GHANI', joiningDate: '2026-01-01' });
  expect(d.data).toHaveLength(31);
  expect(d.data[0]).toMatchObject({ date: '2026-10-01', weekday: 'Thu', status: 'Present', code: 'P', in: '08:05', out: '18:00', worked: '9h 55m', workedMinutes: 595, lateMinutes: 5, overtimeMinutes: 115, punches: 2 });
  expect(d.data[1]).toMatchObject({ status: 'Late', lateMinutes: 20 });
  expect(d.data[3]).toMatchObject({ status: 'Rest day', code: 'R' });
  expect(d.totals).toMatchObject({ P: 1, L: 1, HD: 1, R: 4, worked: expect.any(String) });
  expect((await w.api('get', '/payroll/attendance/report/employees/8f3c1a2e-1111-4222-8333-444455556666?month=2026-10')).status).toBe(404);
  expect((await w.api('get', '/payroll/attendance/report?month=2026-13')).status).toBe(400);

  // punch report: only the punches, as they came
  const p = await ok(w.api('get', '/payroll/attendance/punch-report?month=2026-10'));
  expect(p.data.map((x) => [x.employee.code, x.totalPunches, x.daysWithPunches])).toEqual([[593, 8, 4], [594, 2, 2], [595, 0, 0]]);
  expect(p.data[0].days[0]).toEqual({ date: '2026-10-01', times: ['08:05:00', '18:00:00'] });
  expect(p.data[1].days[1]).toEqual({ date: '2026-10-02', times: ['06:10:00'] }); // by the calendar date of the punch
  expect(p.summary).toMatchObject({ employees: 3, punches: 10 }); // the punch of ID 999 belongs to nobody
  expect((await ok(w.api('get', `/payroll/attendance/punch-report?month=2026-10&departmentId=${dept.id}`))).data.map((x) => x.employee.code)).toEqual([593]);
  const pd = await ok(w.api('get', `/payroll/attendance/punch-report/employees/${w.e594.id}?month=2026-10`));
  expect(pd.employee).toMatchObject({ code: 594 });
  expect(pd.totals).toEqual({ punches: 2, daysWithPunches: 2 });
  expect(pd.data[0]).toMatchObject({ date: '2026-10-01', count: 1, punches: [{ time: '19:55:00', device: 'Boat Basin', mode: null, source: 'EXCEL' }] });

  // Excel
  const ExcelJS = require('exceljs');
  const load = async (url) => { const res = await bin(url); expect(res.status).toBe(200); expect(res.body.subarray(0, 2).toString()).toBe('PK'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.body); return wb.worksheets[0]; };
  const ws1 = await load('/payroll/attendance/report?month=2026-10&format=xlsx');
  expect(ws1.getCell(2, 1).value).toBe('Attendance Report - October 2026');
  expect(ws1.getCell(6, 3).value).toBe('ABDUL GHANI');
  expect(ws1.getCell(6, 5).value).toBe('P\n08:05-18:00');
  const ws2 = await load(`/payroll/attendance/report/employees/${w.e593.id}?month=2026-10&format=xlsx`);
  expect(ws2.getCell(6, 5).value).toBe('08:05');
  const ws3 = await load('/payroll/attendance/punch-report?month=2026-10&format=xlsx');
  expect(ws3.getCell(6, 5).value).toBe('08:05:00\n18:00:00');
  const ws4 = await load(`/payroll/attendance/punch-report/employees/${w.e593.id}?month=2026-10&format=xlsx`);
  expect(ws4.getCell(6, 3).value).toBe('08:05:00');

  // access
  const nobody = await makeUser({ userType: 'USER', companyId: w.company.id });
  expect((await asUser(nobody)('get', '/payroll/attendance/report?month=2026-10')).status).toBe(403);
  const other = await setup();
  expect((await other.api('get', `/payroll/attendance/report/employees/${w.e593.id}?month=2026-10`)).status).toBe(404);
});
