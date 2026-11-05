// The payroll engine: one employee's month, from the counts of his days to his net salary. Pure: no database. Money is in cents (BigInt), days in half days (integers),
// so the same inputs always give exactly the same answer (a recalculation can never move a rupee).
//
//   Days of the month (from the attendance): P present, L late, HD half day, A absent, R rest day (weekly off or holiday), AL annual leave.
//   1. paid AL     AL days are paid up to the leave balance (`alBalance`); the AL days over the balance are unpaid, like absences.
//   2. late        every `latesPerHalfDay` lates cost half a day (0 = lates are never penalised).
//   3. paid days   P + L + R + paid AL + half of HD - the late penalty.
//   4. basic       MONTHLY: basic / days of the month x paid days.   DAILY: the daily wage x paid days.   FIXED: the basic, whatever the attendance.
//   5. overtime    overtime hours / duty hours x the daily rate x the overtime factor (the daily rate of a DAILY employee is his wage).
//   6. gross       basic earned + overtime, each rounded to the whole rupee (half up).
//   7. additions   food, maintenance, mobile and others;   deductions: loan, advance, EOBI, income tax and others.
//   8. net         gross + additions - deductions.
// The "contribution" is the value of the days lost to lates and half days (late penalty + half days), shown on the sheet; it is not deducted a second time.
// Worked example (the payroll document): basic 30,000 in a 31 day month, P 22, L 4, R 4, HD 1: paid days 22 + 4 + 4 + 0.5 - 0.5 = 30, basic 29,032;
// overtime 10 hours on an 8 hour duty = 1.25 days = 1,210; gross 30,242; additions 4,000; deductions 2,370; net 31,872.
const RUPEE = 100n;

/** The fraction num / den of cents, rounded to the whole rupee (half up), as cents. */
const rupees = (num, den) => ((num * 2n + den * RUPEE) / (2n * den * RUPEE)) * RUPEE;

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`payrollEngine: ${name} must be a number of 0 or more`);
  return n;
};

/**
 * @param {object} i
 * @param {'MONTHLY'|'FIXED'|'DAILY'} i.salaryType
 * @param {bigint} i.basicCents
 * @param {number} i.daysInMonth
 * @param {{P:number,L:number,HD:number,A:number,R:number,AL:number}} i.counts
 * @param {number} i.alBalance           days of annual leave the employee can still be paid for
 * @param {number} i.latesPerHalfDay      0 = lates are never penalised
 * @param {number} i.dutyMinutes          the duty hours of his shift in minutes (0 = no overtime pay)
 * @param {number} i.overtimeMinutes      overtime worked, in minutes
 * @param {number} i.overtimeFactor       1 = normal rate
 * @param {{food:bigint,maintenance:bigint,mobile:bigint,others:bigint}} i.additions
 * @param {{loan:bigint,eobi:bigint,tax:bigint,others:bigint}} i.deductions
 */
function calculate(i) {
  const dim = BigInt(toInt(i.daysInMonth, 'daysInMonth'));
  if (dim < 28n || dim > 31n) throw new Error('payrollEngine: a month has 28 to 31 days');
  const c = i.counts;
  for (const k of ['P', 'L', 'HD', 'A', 'R', 'AL']) toInt(c[k], k);
  const salaryType = i.salaryType || 'MONTHLY';
  if (!['MONTHLY', 'FIXED', 'DAILY'].includes(salaryType)) throw new Error('payrollEngine: unknown salary type');

  // 1. annual leave: paid up to the balance (in half days)
  const alPaidHalf = Math.min(c.AL * 2, Math.max(0, Math.floor(toInt(i.alBalance, 'alBalance') * 2)));
  // 2. the late penalty, in half days
  const n = toInt(i.latesPerHalfDay, 'latesPerHalfDay');
  const lateHalf = n > 0 ? Math.floor(c.L / n) : 0;
  // 3. paid days, in half days
  const payableHalf = salaryType === 'FIXED' ? Number(dim) * 2 : Math.max(0, c.P * 2 + c.L * 2 + c.R * 2 + c.HD + alPaidHalf - lateHalf);
  const half = BigInt(payableHalf);

  // 4. the basic earned
  let earned;
  if (salaryType === 'FIXED') earned = rupees(i.basicCents, 1n);
  else if (salaryType === 'DAILY') earned = rupees(i.basicCents * half, 2n);
  else earned = rupees(i.basicCents * half, 2n * dim);

  // 5. overtime
  const dutyMinutes = BigInt(toInt(i.dutyMinutes, 'dutyMinutes'));
  const otMinutes = BigInt(toInt(i.overtimeMinutes, 'overtimeMinutes'));
  const factor100 = BigInt(Math.round(toInt(i.overtimeFactor, 'overtimeFactor') * 100));
  const perDay = salaryType === 'DAILY' ? 1n : dim; // the daily rate is basic / days of the month, or the wage itself
  const overtime = dutyMinutes > 0n && otMinutes > 0n ? rupees(i.basicCents * otMinutes * factor100, 100n * perDay * dutyMinutes) : 0n;

  // 6 - 8. gross, additions, deductions, net
  const gross = earned + overtime;
  const a = i.additions;
  const d = i.deductions;
  const additions = a.food + a.maintenance + a.mobile + a.others;
  const deductions = d.loan + (d.advance || 0n) + d.eobi + d.tax + d.others;
  const net = gross + additions - deductions;

  // the value of the days lost to lates and half days (not deducted again)
  const lateOnly = salaryType === 'FIXED' ? 0n : rupees(i.basicCents * BigInt(lateHalf), 2n * (salaryType === 'DAILY' ? 1n : dim));
  const halfDayOnly = salaryType === 'FIXED' ? 0n : rupees(i.basicCents * BigInt(c.HD), 2n * (salaryType === 'DAILY' ? 1n : dim));

  return {
    salaryType, daysInMonth: Number(dim), counts: { ...c },
    alBalance: Number(i.alBalance), alPaid: alPaidHalf / 2, alUnpaid: c.AL - alPaidHalf / 2,
    lateDeductionDays: lateHalf / 2, halfDayDays: c.HD / 2, absentDays: c.A,
    payableDays: payableHalf / 2,
    dailyRateCents: salaryType === 'DAILY' ? i.basicCents : i.basicCents / dim, // for display only: the money is worked out from the fractions above
    overtimeMinutes: Number(otMinutes), overtimeDays: dutyMinutes > 0n ? Number(otMinutes) / Number(dutyMinutes) : 0, overtimeFactor: Number(factor100) / 100,
    earned, overtime, gross, additions, deductions, net,
    contribution: lateOnly + halfDayOnly, contributionParts: { late: lateOnly, halfDay: halfDayOnly, penalty: 0n },
  };
}

module.exports = { calculate, rupees };
