const { computeDays, overtimeDays, payableDays, workDay } = require('../src/utils/attendanceEngine');
const { parseDate, parseTime, parseRow } = require('../src/utils/punchParser');

// a moment on the Pakistan clock (UTC+5) as epoch milliseconds
const at = (ymd, hm) => { const [y, m, d] = ymd.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - 5 * 3600 * 1000; };
const policy = { lateLimitMinutes: 15, halfDayLimitMinutes: 120, weeklyOffDay: 'SUNDAY' };
const DAY8 = { start: '08:00', end: '16:00', dutyHours: 8 };
const run = (o) => computeDays({ policyFor: () => policy, until: '2026-11-01', joiningDate: '2026-01-01', ...o });
const one = (rows, date) => rows.find((r) => r.date === date);

// 2026-10-01 is a Thursday, 2026-10-04 a Sunday
test('a working day: on time is P, late is L, very late is HD, no punch is A; overtime is the hours over the duty hours', () => {
  const rows = run({
    shift: DAY8, from: '2026-10-01', to: '2026-10-05',
    punches: [
      at('2026-10-01', '08:05'), at('2026-10-01', '18:00'), // 5 late, worked 595 min, duty 480 -> 115 overtime
      at('2026-10-02', '08:15'), at('2026-10-02', '16:00'), // exactly the late limit: still P
      at('2026-10-03', '08:16'), at('2026-10-03', '16:30'), // 16 late: L
    ],
  });
  expect(one(rows, '2026-10-01')).toMatchObject({ code: 'P', lateMinutes: 5, workedMinutes: 595, overtimeMinutes: 115, dutyMinutes: 480, incomplete: false, restDay: false });
  expect(one(rows, '2026-10-02')).toMatchObject({ code: 'P', lateMinutes: 15, overtimeMinutes: 0 });
  expect(one(rows, '2026-10-03')).toMatchObject({ code: 'L', lateMinutes: 16 });
  expect(one(rows, '2026-10-05')).toMatchObject({ code: 'A', punches: 0, restDay: false });
  const half = run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '10:00'), at('2026-10-01', '16:00'), at('2026-10-02', '10:01')] });
  expect(half[0]).toMatchObject({ code: 'L', lateMinutes: 120 }); // exactly the half-day limit: still L
  expect(run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '10:01'), at('2026-10-01', '16:00')] })[0]).toMatchObject({ code: 'HD', lateMinutes: 121 });
});

test('coming late and leaving on time is no overtime; a short stay is only overtime over the duty hours, never negative', () => {
  const rows = run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '09:00'), at('2026-10-01', '17:30')] });
  expect(rows[0]).toMatchObject({ code: 'L', workedMinutes: 510, overtimeMinutes: 30 });
  const short = run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '08:00'), at('2026-10-01', '14:00')] });
  expect(short[0]).toMatchObject({ code: 'P', workedMinutes: 360, overtimeMinutes: 0 });
});

test('a single swipe is incomplete: coded from the "in", no overtime, for HR to complete', () => {
  expect(run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '08:03')] })[0]).toMatchObject({ code: 'P', incomplete: true, workedMinutes: 0, overtimeMinutes: 0 });
  expect(run({ shift: DAY8, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '08:03'), at('2026-10-01', '08:04')] })[0].incomplete).toBe(true); // a double swipe
});

test('a night shift belongs to the day it started; its morning punches are not the next day', () => {
  const night = { start: '20:00', end: '06:00', dutyHours: 10 };
  const rows = run({
    shift: night, from: '2026-10-01', to: '2026-10-03',
    punches: [at('2026-10-01', '19:55'), at('2026-10-02', '06:10'), at('2026-10-02', '20:20'), at('2026-10-03', '06:00')],
  });
  expect(one(rows, '2026-10-01')).toMatchObject({ code: 'P', lateMinutes: 0, workedMinutes: 615, overtimeMinutes: 15, dutyMinutes: 600, firstIn: at('2026-10-01', '19:55'), lastOut: at('2026-10-02', '06:10') });
  expect(one(rows, '2026-10-02')).toMatchObject({ code: 'L', lateMinutes: 20, workedMinutes: 580, overtimeMinutes: 0 });
  expect(workDay(at('2026-10-02', '12:59'), night)).toBe(workDay(at('2026-10-01', '20:00'), night));
  expect(workDay(at('2026-10-02', '13:01'), night)).toBe(workDay(at('2026-10-02', '20:00'), night));
});

test('a day shift that is worked late into the night: the punches after midnight stay with that day until half way to the next shift', () => {
  const longDay = { start: '08:00', end: '19:00', dutyHours: 11 };
  expect(workDay(at('2026-10-02', '00:30'), longDay)).toBe(workDay(at('2026-10-01', '08:00'), longDay));
  expect(workDay(at('2026-10-02', '02:00'), longDay)).toBe(workDay(at('2026-10-02', '08:00'), longDay));
  const rows = run({ shift: longDay, from: '2026-10-01', to: '2026-10-01', punches: [at('2026-10-01', '08:00'), at('2026-10-02', '00:30')] });
  expect(rows[0]).toMatchObject({ code: 'P', workedMinutes: 990, overtimeMinutes: 330 });
});

test('rest days: the weekly off day and the holidays are R; hours worked on them are all overtime', () => {
  const rows = run({
    shift: DAY8, from: '2026-10-04', to: '2026-10-07', isHoliday: (d) => d === '2026-10-06',
    punches: [at('2026-10-04', '09:00'), at('2026-10-04', '13:00'), at('2026-10-05', '08:00'), at('2026-10-05', '16:00')],
  });
  expect(one(rows, '2026-10-04')).toMatchObject({ code: 'R', restDay: true, workedMinutes: 240, overtimeMinutes: 240, lateMinutes: 0 });
  expect(one(rows, '2026-10-05')).toMatchObject({ code: 'P' });
  expect(one(rows, '2026-10-06')).toMatchObject({ code: 'R', restDay: true, punches: 0, overtimeMinutes: 0 });
  expect(one(rows, '2026-10-07')).toMatchObject({ code: 'A' });
  expect(run({ shift: DAY8, from: '2026-10-04', to: '2026-10-04', punches: [] })[0].code).toBe('R'); // not coming on the weekly off day is not absence
  const noOff = computeDays({ policyFor: () => ({ ...policy, weeklyOffDay: null }), shift: DAY8, from: '2026-10-04', to: '2026-10-04', until: '2026-11-01', joiningDate: '2026-01-01', punches: [] });
  expect(noOff[0].code).toBe('A');
});

test('no answer before joining, after leaving, in the future, or for today while nobody has come', () => {
  const rows = run({ shift: DAY8, from: '2026-10-01', to: '2026-10-10', joiningDate: '2026-10-03', leavingDate: '2026-10-08', punches: [] });
  expect(rows.map((r) => r.date)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  const live = run({ shift: DAY8, from: '2026-10-29', to: '2026-11-05', until: '2026-10-31', punches: [at('2026-10-31', '08:02')] });
  expect(live.map((r) => r.date)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']);
  expect(one(live, '2026-10-31')).toMatchObject({ code: 'P', incomplete: true });
  const waiting = run({ shift: DAY8, from: '2026-10-29', to: '2026-11-05', until: '2026-10-31', punches: [] });
  expect(waiting.map((r) => r.date)).toEqual(['2026-10-29', '2026-10-30']); // 31st is a Saturday, nobody yet: not absent so far
});

test('an employee with no shift: present or absent only, no late and no overtime', () => {
  const rows = run({ shift: null, from: '2026-10-01', to: '2026-10-02', punches: [at('2026-10-01', '11:00'), at('2026-10-01', '23:00')] });
  expect(rows[0]).toMatchObject({ code: 'P', lateMinutes: 0, overtimeMinutes: 0, dutyMinutes: null });
  expect(rows[1].code).toBe('A');
});

test('overtime in days: 20 hours over an 8 hour shift is 2.5 days; payable days follow the policy', () => {
  expect(overtimeDays([{ overtimeMinutes: 600, dutyMinutes: 480 }, { overtimeMinutes: 600, dutyMinutes: 480 }])).toBe(2.5);
  expect(overtimeDays([{ overtimeMinutes: 120, dutyMinutes: 480 }, { overtimeMinutes: 0, dutyMinutes: 480 }, { overtimeMinutes: 60, dutyMinutes: null }])).toBe(0.25);
  expect(overtimeDays([])).toBe(0);
  // 20 P + 4 L + 2 HD + 4 R + 1 AL, 4 lates at 3 lates = half a day: 20 + 4 + 1 + 4 + 1 - 0.5
  expect(payableDays({ P: 20, L: 4, HD: 2, R: 4, AL: 1 }, 3)).toBe(29.5);
  expect(payableDays({ P: 20, L: 4, HD: 2, R: 4, AL: 1 }, 0)).toBe(30);
  expect(payableDays({ P: 0, L: 3, HD: 0, R: 0, AL: 0 }, 1)).toBe(1.5); // 3 lates paid, each late costs half a day
});

test('punch rows: dates and times as a sheet writes them, the Pakistan clock, and clear reasons for a bad row', () => {
  expect(parseDate('2026-10-30')).toBe('2026-10-30');
  // only YYYY-MM-DD and HH:MM / HH:MM:SS (24 hours): the ambiguous ways of writing them are refused
  for (const bad of ['30/10/2026', '3-1-2026', '2026-10-30T00:00:00.000Z', '2026-1-3', '31/02/2026', '2026-02-30', '1999-12-31', '2101-01-01']) expect(parseDate(bad)).toBeNull();
  expect(parseDate('2000-01-01')).toBe('2000-01-01');
  expect(parseTime('08:05')).toBe(8 * 3600 + 300);
  expect(parseTime('08:05:30')).toBe(8 * 3600 + 330);
  expect(parseTime('14:30:00')).toBe(14 * 3600 + 1800);
  for (const bad of ['8:05', '8:05 PM', '12:30 AM', '08:60', '08:05:61']) expect(parseTime(bad)).toBeNull();
  expect(parseTime('24:00')).toBeNull();
  expect(parseTime('8')).toBeNull();
  expect(parseRow({ employeeId: '00593', date: '2026-10-30', time: '08:05' })).toMatchObject({ ok: true, empCode: 593, ms: at('2026-10-30', '08:05') });
  expect(parseRow({ employeeId: 593, punchedAt: '2026-10-30 08:05:30' })).toMatchObject({ ok: true, ms: at('2026-10-30', '08:05') + 30000 });
  expect(parseRow({ employeeId: 593, punchedAt: '2026-10-30T03:05:00Z' })).toMatchObject({ ok: true, ms: at('2026-10-30', '08:05') });
  expect(parseRow({ employeeId: 593, date: '2026-10-30', time: '14:15', device: ' Boat Basin ', mode: '8' })).toMatchObject({ ok: true, device: 'Boat Basin', mode: 8 });
  for (const bad of [{ date: '2026-10-30', time: '08:05' }, { employeeId: 'abc', date: '2026-10-30', time: '08:05' }, { employeeId: 0, date: '2026-10-30', time: '08:05' },
    { employeeId: 5, date: 'x', time: '08:05' }, { employeeId: 5, date: '30/10/2026', time: '08:05' }, { employeeId: 5, date: '2026-10-30', time: '8:05 PM' }, { employeeId: 5, date: '2026-10-30', time: '8' }, { employeeId: 5, date: '2999-01-01', time: '08:05' },
    { employeeId: 5, date: '1999-01-01', time: '08:05' }, { employeeId: 5, date: '2026-10-30', time: '08:05', mode: 'x' }, null, 'text']) {
    expect(parseRow(bad).ok).toBe(false);
    expect(parseRow(bad).reason).toBeTruthy();
  }
});
