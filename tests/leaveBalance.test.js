const { earnedLeave, eligibleFrom, addMonthsToDate, datesBetween } = require('../src/utils/leaveBalance');
const { computeDays } = require('../src/utils/attendanceEngine');

const defaults = { leaveEarnedPerMonth: 2, maxLeavePerYear: 24, monthsBeforeLeave: 6 };
const earned = (o) => earnedLeave({ policyFor: () => defaults, ...o });

test('nothing is earned before the months of service are done; then the leave of each month is credited on the 1st', () => {
  // joined 2026-01-15: eligible from 2026-07-15, so the first credit is 2026-08-01
  expect(eligibleFrom('2026-01-15', 6)).toBe('2026-07-15');
  expect(earned({ joiningDate: '2026-01-15', asOf: '2026-07-31' }).earned).toBe(0);
  expect(earned({ joiningDate: '2026-01-15', asOf: '2026-08-01' }).earned).toBe(2);
  expect(earned({ joiningDate: '2026-01-15', asOf: '2026-10-05' }).earned).toBe(6); // Aug, Sep, Oct
  expect(earned({ joiningDate: '2026-01-01', asOf: '2026-07-01' }).earned).toBe(2); // eligible on the 1st: July counts
  expect(earned({ joiningDate: '2026-01-02', asOf: '2026-07-01' }).earned).toBe(0);
  expect(earned({ joiningDate: '2026-01-15', asOf: '2026-01-31' }).byYear).toEqual([]);
});

test('at most the yearly maximum is earned in a calendar year, and what is unused carries on to the next year', () => {
  const r = earned({ joiningDate: '2025-01-10', asOf: '2027-12-31' });
  // 2025: Aug to Dec = 5 months = 10; 2026: 12 months = 24; 2027: 24
  expect(r.byYear).toEqual([{ year: 2025, credited: 10, earned: 10 }, { year: 2026, credited: 24, earned: 24 }, { year: 2027, credited: 24, earned: 24 }]);
  expect(r.earned).toBe(58);
  const capped = earnedLeave({ joiningDate: '2025-01-10', asOf: '2026-12-31', policyFor: () => ({ leaveEarnedPerMonth: 3, maxLeavePerYear: 24, monthsBeforeLeave: 6 }) });
  expect(capped.byYear).toEqual([{ year: 2025, credited: 15, earned: 15 }, { year: 2026, credited: 36, earned: 24 }]);
  expect(capped.earned).toBe(39);
});

test('the policy of each month decides, nothing is earned after the employee left, and fractions are kept', () => {
  const policyFor = (month) => (month < '2026-03' ? defaults : { leaveEarnedPerMonth: 1.5, maxLeavePerYear: 24, monthsBeforeLeave: 0 });
  const r = earnedLeave({ joiningDate: '2025-06-01', asOf: '2026-04-30', policyFor });
  // eligible 2025-12-01 under the old policy: Dec 2025, Jan, Feb = 6; from March the new policy (no waiting): Mar, Apr = 3
  expect(r.earned).toBe(9);
  expect(earned({ joiningDate: '2025-01-10', leavingDate: '2025-10-20', asOf: '2026-12-31' }).earned).toBe(6); // Aug, Sep, Oct, then he left
  expect(earned({ joiningDate: '2026-10-05', asOf: '2026-10-31', policyFor: () => ({ ...defaults, monthsBeforeLeave: 0 }) }).earned).toBe(0); // the 1st of the month is before he joined
});

test('dates: adding months to a date, and the days of a range', () => {
  expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-02-28');
  expect(addMonthsToDate('2024-01-31', 1)).toBe('2024-02-29');
  expect(addMonthsToDate('2026-08-31', 6)).toBe('2027-02-28');
  expect(addMonthsToDate('2026-11-15', 0)).toBe('2026-11-15');
  expect(datesBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  expect(datesBetween('2026-10-05', '2026-10-05')).toEqual(['2026-10-05']);
});

test('attendance: a day of approved leave nobody punched on is AL; a rest day stays R; someone who came keeps the code of the day he worked', () => {
  const at = (ymd, hm) => { const [y, m, d] = ymd.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return Date.UTC(y, m - 1, d, h, mi) - 5 * 3600 * 1000; };
  const policy = { lateLimitMinutes: 15, halfDayLimitMinutes: 120, weeklyOffDay: 'SUNDAY' };
  const rows = computeDays({
    policyFor: () => policy, until: '2026-11-04', joiningDate: '2026-01-01', from: '2026-10-05', to: '2026-10-12', shift: { start: '08:00', end: '16:00', dutyHours: 8 },
    punches: [at('2026-10-07', '08:00'), at('2026-10-07', '16:00')], isLeave: (d) => d >= '2026-10-05' && d <= '2026-10-11',
  });
  const code = (d) => rows.find((r) => r.date === d).code;
  expect(code('2026-10-05')).toBe('AL');
  expect(code('2026-10-07')).toBe('P'); // he worked on a day of leave
  expect(code('2026-10-11')).toBe('R'); // Sunday
  expect(code('2026-10-12')).toBe('A');
  // today, nobody yet: leave counts, a plain day does not
  const live = computeDays({ policyFor: () => policy, until: '2026-10-05', joiningDate: '2026-01-01', from: '2026-10-05', to: '2026-10-05', shift: null, punches: [], isLeave: () => true });
  expect(live.map((r) => r.code)).toEqual(['AL']);
  expect(computeDays({ policyFor: () => policy, until: '2026-10-05', joiningDate: '2026-01-01', from: '2026-10-05', to: '2026-10-05', shift: null, punches: [] })).toEqual([]);
});
