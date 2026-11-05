const { calculate, rupees } = require('../src/utils/payrollEngine');

const rs = (n) => BigInt(Math.round(n * 100));
const base = (o = {}) => ({
  salaryType: 'MONTHLY', basicCents: rs(30000), daysInMonth: 31, counts: { P: 0, L: 0, HD: 0, A: 0, R: 0, AL: 0 }, alBalance: 0, latesPerHalfDay: 3, dutyMinutes: 480, overtimeMinutes: 0, overtimeFactor: 1,
  additions: { food: 0n, maintenance: 0n, mobile: 0n, others: 0n }, deductions: { loan: 0n, eobi: 0n, tax: 0n, others: 0n }, ...o,
});

test('the example of the payroll document: net 31,872', () => {
  const r = calculate(base({
    counts: { P: 22, L: 4, HD: 1, A: 0, R: 4, AL: 0 }, overtimeMinutes: 600,
    additions: { food: rs(3000), maintenance: 0n, mobile: rs(1000), others: 0n }, deductions: { loan: rs(2000), eobi: rs(370), tax: 0n, others: 0n },
  }));
  expect(r.payableDays).toBe(30); // 22 + 4 + 4 + 0.5 - 0.5 (4 lates: one set of three = half a day)
  expect(r.lateDeductionDays).toBe(0.5);
  expect(r.earned).toBe(rs(29032));
  expect(r.overtimeDays).toBe(1.25);
  expect(r.overtime).toBe(rs(1210));
  expect(r.gross).toBe(rs(30242));
  expect(r.additions).toBe(rs(4000));
  expect(r.deductions).toBe(rs(2370));
  expect(r.net).toBe(rs(31872));
});

test('the same input always gives the same answer (a recalculation moves nothing)', () => {
  const input = base({ counts: { P: 17, L: 8, HD: 0, A: 0, R: 4, AL: 2 }, alBalance: 3, basicCents: rs(40500) });
  const first = calculate(input);
  for (let i = 0; i < 5; i += 1) expect(calculate(input)).toEqual(first);
  expect(calculate({ ...input })).toEqual(first);
});

test('the sheet of the old system: Rizwan (17 P, 8 L, 4 R, 2 AL on 40,500) and Zamin (4 P, 12 L, 3 R, 1 HD, 11 A on 30,000)', () => {
  const riz = calculate(base({ basicCents: rs(40500), counts: { P: 17, L: 8, HD: 0, A: 0, R: 4, AL: 2 }, alBalance: 3, deductions: { loan: 0n, eobi: rs(407), tax: 0n, others: 0n } }));
  expect(riz).toMatchObject({ alPaid: 2, alUnpaid: 0, lateDeductionDays: 1, payableDays: 30 }); // 8 lates = two sets of three = 1 day off
  expect(riz.earned).toBe(rs(39194)); // 40,500 / 31 x 30 = 39,193.55
  expect(riz.contribution).toBe(rs(1306)); // the value of the one day lost to lates
  expect(riz.net).toBe(rs(38787));
  const zam = calculate(base({ basicCents: rs(30000), counts: { P: 4, L: 12, HD: 1, A: 11, R: 3, AL: 0 }, deductions: { loan: rs(5000), eobi: 0n, tax: 0n, others: 0n } }));
  expect(zam).toMatchObject({ lateDeductionDays: 2, halfDayDays: 0.5, payableDays: 17.5 });
  expect(zam.earned).toBe(rs(16935)); // 30,000 / 31 x 17.5 = 16,935.48
  expect(zam.contribution).toBe(rs(2419)); // lates 2 days + the half day = 2.5 days
  expect(zam.net).toBe(rs(11935));
});

test('annual leave is paid up to the balance, the rest is unpaid; lates are never penalised when the policy says 0', () => {
  const r = calculate(base({ counts: { P: 20, L: 0, HD: 0, A: 0, R: 4, AL: 5 }, alBalance: 2.5 }));
  expect(r).toMatchObject({ alPaid: 2.5, alUnpaid: 2.5, payableDays: 26.5 });
  expect(calculate(base({ counts: { P: 20, L: 0, HD: 0, A: 0, R: 4, AL: 5 }, alBalance: 0 }))).toMatchObject({ alPaid: 0, alUnpaid: 5, payableDays: 24 });
  expect(calculate(base({ counts: { P: 20, L: 9, HD: 0, A: 0, R: 2, AL: 0 }, latesPerHalfDay: 0 }))).toMatchObject({ lateDeductionDays: 0, payableDays: 31 });
  expect(calculate(base({ counts: { P: 20, L: 9, HD: 0, A: 0, R: 2, AL: 0 }, latesPerHalfDay: 3 }))).toMatchObject({ lateDeductionDays: 1.5, payableDays: 29.5 });
  expect(calculate(base({ counts: { P: 20, L: 2, HD: 0, A: 0, R: 2, AL: 0 }, latesPerHalfDay: 3 })).lateDeductionDays).toBe(0); // fewer than three lates cost nothing
});

test('salary types: monthly, daily wage and fixed', () => {
  const counts = { P: 20, L: 0, HD: 2, A: 5, R: 4, AL: 0 };
  expect(calculate(base({ counts, basicCents: rs(31000) })).earned).toBe(rs(25000)); // 31,000 / 31 x 25
  const daily = calculate(base({ salaryType: 'DAILY', basicCents: rs(1200), counts }));
  expect(daily.earned).toBe(rs(30000)); // 1,200 x 25 days
  expect(daily.dailyRateCents).toBe(rs(1200));
  const fixed = calculate(base({ salaryType: 'FIXED', basicCents: rs(45000), counts: { P: 3, L: 0, HD: 0, A: 28, R: 0, AL: 0 } }));
  expect(fixed.earned).toBe(rs(45000)); // whatever the attendance
  expect(fixed.payableDays).toBe(31);
  expect(fixed.contribution).toBe(0n);
});

test('overtime: hours over the duty hours x the daily rate x the factor; none without duty hours; a daily wage is its own rate', () => {
  expect(calculate(base({ overtimeMinutes: 1200, counts: { P: 31, L: 0, HD: 0, A: 0, R: 0, AL: 0 } })).overtime).toBe(rs(2419)); // 20 h / 8 h = 2.5 days x 967.74
  expect(calculate(base({ overtimeMinutes: 1200, overtimeFactor: 1.5 })).overtime).toBe(rs(3629)); // x 1.5 = 3,629.03
  expect(calculate(base({ overtimeMinutes: 1200, dutyMinutes: 0 })).overtime).toBe(0n);
  expect(calculate(base({ overtimeMinutes: 1200, overtimeFactor: 0 })).overtime).toBe(0n);
  expect(calculate(base({ salaryType: 'DAILY', basicCents: rs(1200), overtimeMinutes: 240 })).overtime).toBe(rs(600)); // 4 h / 8 h = half a wage
});

test('the net can be negative (the screen refuses to send it on); rounding is half up to the rupee', () => {
  const r = calculate(base({ counts: { P: 1, L: 0, HD: 0, A: 30, R: 0, AL: 0 }, deductions: { loan: rs(5000), eobi: 0n, tax: 0n, others: 0n } }));
  expect(r.gross).toBe(rs(968)); // 967.74
  expect(r.net).toBe(rs(968) - rs(5000));
  expect(r.net < 0n).toBe(true);
  expect(rupees(49n, 1n)).toBe(0n);
  expect(rupees(50n, 1n)).toBe(100n); // 0.50 goes up
  expect(rupees(149n, 1n)).toBe(100n);
  expect(rupees(150n, 1n)).toBe(200n);
  expect(rupees(3000000n, 31n)).toBe(96800n); // 30,000 / 31 = 967.74
  expect(() => calculate(base({ daysInMonth: 32 }))).toThrow();
  expect(() => calculate(base({ salaryType: 'WEEKLY' }))).toThrow();
});
