const { emiCents, addMonths, monthLabel, monthCode, schedule } = require('../src/utils/loanSchedule');

const rs = (...n) => n.map((x) => BigInt(Math.round(x * 100)));
const sum = (a) => a.reduce((t, x) => t + x, 0n);

test('instalments: rounded to the rupee, the last one takes the difference, they always add up to the loan', () => {
  expect(emiCents(1000000n, 3)).toEqual(rs(3333, 3333, 3334)); // 10,000 over 3 months
  expect(emiCents(5000000n, 3)).toEqual(rs(16667, 16667, 16666)); // 50,000 over 3 months
  expect(emiCents(3000000n, 3)).toEqual(rs(10000, 10000, 10000));
  expect(emiCents(5000000n, 1)).toEqual(rs(50000));
  expect(emiCents(5000050n, 1)).toEqual([5000050n]); // one month: paisa and all
  expect(emiCents(1000000n, 12)).toEqual([...rs(...Array(11).fill(833)), 1000000n - 11n * 83300n]); // 833 x 11 + 837
  expect(emiCents(1000050n, 4)).toEqual([250000n, 250000n, 250000n, 250050n]); // 10,000.50: the paisa is in the last one
});

test('a tiny loan over many months rounds down instead of leaving a negative last instalment', () => {
  const e = emiCents(1200n, 12); // Rs 12 over 12 months
  expect(e).toEqual(Array(12).fill(100n));
  const t = emiCents(2000n, 12); // Rs 20 over 12 months: 1.67 would round to 2 and overshoot
  expect(sum(t)).toBe(2000n);
  expect(t.every((x) => x >= 100n)).toBe(true);
  for (let months = 1; months <= 12; months += 1) {
    for (const total of [100n * BigInt(months), 123456n, 99999n * 100n, 1n + 100n * BigInt(months) * 7n]) {
      const rows = emiCents(total, months);
      expect(rows.length).toBe(months);
      expect(sum(rows)).toBe(total);
      expect(rows.every((x) => x >= 0n)).toBe(true);
    }
  }
});

test('months: adding months across a year, names and the old MMYYYY code', () => {
  expect(addMonths('2026-11', 0)).toBe('2026-11');
  expect(addMonths('2026-11', 2)).toBe('2027-01');
  expect(addMonths('2026-12', 1)).toBe('2027-01');
  expect(addMonths('2026-01', 11)).toBe('2026-12');
  expect(addMonths('2026-03', 24)).toBe('2028-03');
  expect(monthLabel('2026-11')).toBe('NOV-2026');
  expect(monthLabel('2027-01')).toBe('JAN-2027');
  expect(monthCode('2026-11')).toBe('112026');
  expect(monthCode('2027-01')).toBe('012027');
  expect(schedule(5000000n, 3, '2026-11')).toEqual([
    { month: '2026-11', label: 'NOV-2026', cents: 1666700n }, { month: '2026-12', label: 'DEC-2026', cents: 1666700n }, { month: '2027-01', label: 'JAN-2027', cents: 1666600n },
  ]);
});
