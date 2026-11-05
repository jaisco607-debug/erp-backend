// The instalments (EMI) of an employee loan. Pure and exact: money in cents (BigInt).
//   Every instalment but the last is the amount divided by the months, rounded to the nearest whole rupee (half up); the LAST takes the difference,
//   so the instalments always add up to the loan:  10,000 over 3 months = 3,333 + 3,333 + 3,334;  50,000 over 3 months = 16,667 + 16,667 + 16,666.
//   When rounding up would leave the last instalment negative (a tiny loan over many months) the instalments are rounded down instead.
//   A loan of one month is paid in one piece, paisa and all.
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const RUPEE = 100n;

/** The instalments of `totalCents` over `months` as an array of cents. */
function emiCents(totalCents, months) {
  const n = BigInt(months);
  if (months === 1) return [totalCents];
  let emi = ((totalCents * 2n + n * RUPEE) / (n * RUPEE * 2n)) * RUPEE; // total / months, to the nearest rupee, half up
  if (emi * (n - 1n) > totalCents) emi = (totalCents / n / RUPEE) * RUPEE; // rounding up would overshoot: round down
  const out = Array(months - 1).fill(emi);
  out.push(totalCents - emi * (n - 1n));
  return out;
}

/** "2026-11" plus `plus` months: "2027-01". */
function addMonths(month, plus) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + plus;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** "2026-11" as "NOV-2026". */
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]}-${y}`;
}

/** "2026-11" as "112026" (the month and the year, the way the old screens write the deduction month). */
const monthCode = (month) => `${month.slice(5, 7)}${month.slice(0, 4)}`;

/** The whole schedule: [{ month: '2026-11', label: 'NOV-2026', cents }]. */
function schedule(totalCents, months, deductFrom) {
  return emiCents(totalCents, months).map((cents, i) => {
    const month = addMonths(deductFrom, i);
    return { month, label: monthLabel(month), cents };
  });
}

module.exports = { emiCents, addMonths, monthLabel, monthCode, schedule };
