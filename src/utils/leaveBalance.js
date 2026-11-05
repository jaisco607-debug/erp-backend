// Annual leave earned, worked out from the dates and the policy of the group. Pure: no database.
//   An employee starts earning once he has served `monthsBeforeLeave` months (joining date + that many months, the same day of the month, or the last day of a shorter month).
//   From then on the leave of a month (`leaveEarnedPerMonth`) is credited on the 1st of every month; the leave earned in one calendar year is never more than
//   `maxLeavePerYear`. The policy of each month decides (a policy can change from a month on). Nothing is earned after the month the employee left.
//   Unused leave carries on from year to year (the balance is not reset in January).
const { dayIndex, ymdOf } = require('./attendanceEngine');

const round2 = (n) => Math.round(n * 100) / 100;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "2026-01-31" plus one month = "2026-02-28". */
function addMonthsToDate(ymd, plus) {
  const [y, m, d] = ymd.split('-').map(Number);
  const index = y * 12 + (m - 1) + plus;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDayOfMonth(year, month))).padStart(2, '0')}`;
}

const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * @param joiningDate @param leavingDate (or null) @param asOf   YYYY-MM-DD: the leave credited up to and including this day
 * @param policyFor  (month 'YYYY-MM') => { leaveEarnedPerMonth, maxLeavePerYear, monthsBeforeLeave }
 * @returns { earned, byYear: [{ year, credited, earned }] }   credited = before the yearly cap, earned = after it
 */
function earnedLeave({ joiningDate, leavingDate = null, asOf, policyFor }) {
  const end = leavingDate && leavingDate < asOf ? leavingDate : asOf;
  const byYear = new Map();
  for (let month = joiningDate.slice(0, 7); month <= end.slice(0, 7); month = nextMonth(month)) {
    const first = `${month}-01`;
    if (first > end) break;
    const policy = policyFor(month);
    if (first < addMonthsToDate(joiningDate, policy.monthsBeforeLeave)) continue;
    const year = month.slice(0, 4);
    const row = byYear.get(year) || { credited: 0, cap: policy.maxLeavePerYear };
    row.credited += Number(policy.leaveEarnedPerMonth);
    row.cap = Number(policy.maxLeavePerYear);
    byYear.set(year, row);
  }
  const rows = [...byYear].map(([year, v]) => ({ year: Number(year), credited: round2(v.credited), earned: round2(Math.min(v.credited, v.cap)) }));
  return { earned: round2(rows.reduce((t, r) => t + r.earned, 0)), byYear: rows };
}

/** The first day the employee earns leave under a policy: joining date + the months before leave. */
const eligibleFrom = (joiningDate, monthsBeforeLeave) => addMonthsToDate(joiningDate, monthsBeforeLeave);

/** The dates of a range (YYYY-MM-DD, both ends included). */
function datesBetween(from, to) {
  const out = [];
  for (let k = dayIndex(from); k <= dayIndex(to); k += 1) out.push(ymdOf(k));
  return out;
}

module.exports = { earnedLeave, eligibleFrom, addMonthsToDate, datesBetween, round2 };
