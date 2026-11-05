// Attendance engine: from the punches of ONE employee to a code for every day (P, L, HD, A, R), the late minutes and the overtime. Pure: no database.
//
// Time: the mill is in Pakistan (UTC+5, no daylight saving). All "minutes" below are minutes of the Pakistan clock since 1970-01-01 00:00.
//
// Which day does a punch belong to? The day of the SHIFT it falls in, so a night shift (20:00 to 06:00) belongs to the day it STARTED.
//   Each shift of a day owns the 24 hours around its middle point: the boundary between two days' shifts is half way through the gap between
//   the end of one shift and the start of the next. A day shift 08:00-19:00 owns 01:30 of its day up to 01:30 of the next day;
//   a night shift 20:00-06:00 owns 13:00 of its day up to 13:00 of the next day. An employee with no shift owns the calendar day.
// The first punch of the shift's day is the "in", the last one is the "out" (the machine's in / out mode is not trusted).
//   Less than MIN_WORK_MINUTES between them (a single swipe, or a double swipe) = INCOMPLETE: the day is coded from the "in" and HR completes it.
// Code of a working day, from the minutes the "in" is after the shift start and the policy of the group:
//   up to lateLimitMinutes  P (present)    up to halfDayLimitMinutes  L (late)    more  HD (half day)    no punch  A (absent)
// A day of approved leave nobody punched on is AL (annual leave) instead of A. Someone who came to work on a day of leave keeps the code of the day he worked.
// Rest day (the weekly off day of the policy, or a holiday of the group): R, whether or not the person came.
//   Hours worked on a rest day are ALL overtime (there are no duty hours to complete on that day).
// Overtime of a working day = the hours worked (last punch - first punch) less the duty hours of the shift, never below 0. Month-end it is turned into days
//   by dividing by the duty hours (20 hours of overtime on an 8 hour shift = 2.5 days): see overtimeDays.
const DAY = 1440;
const OFFSET = 300; // Pakistan is UTC+5
const MIN_WORK_MINUTES = 60;
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const dayIndex = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const ymdOf = (k) => new Date(k * 86400000).toISOString().slice(0, 10);
const localMinute = (ms) => Math.floor(ms / 60000) + OFFSET;

/** The start (minute of the day) and the length of a shift; a shift that ends at or before its start crosses midnight. */
function span(shift) {
  const s = hm(shift.start);
  return { s, len: (((hm(shift.end) - s) % DAY) + DAY) % DAY || DAY };
}

/** The day index (days since 1970-01-01) a punch belongs to. */
function workDay(ms, shift) {
  const L = localMinute(ms);
  if (!shift) return Math.floor(L / DAY);
  const { s, len } = span(shift);
  return Math.floor((L - s - len / 2 + DAY / 2) / DAY);
}

/**
 * @param {number[]} punches    the punch instants (epoch milliseconds), any order, including a day before and after the range
 * @param {{start:string,end:string,dutyHours:number}|null} shift   'HH:MM' times; null = the employee has no shift
 * @param {(ymd:string)=>{lateLimitMinutes:number,halfDayLimitMinutes:number,weeklyOffDay:string|null}} policyFor  the policy in force on a date
 * @param {string} from @param {string} to          the dates to give an answer for (YYYY-MM-DD)
 * @param {string} until   the last date that may get an answer (today): a day with no punch yet today is not absent
 * @param {string} joiningDate @param {string|null} leavingDate   no answer outside the employment
 * @param {(ymd:string)=>boolean} isHoliday  a holiday for this employee's group
 * @param {(ymd:string)=>boolean} isLeave    a day of approved leave of this employee
 * @returns one row per date: { date, code, firstIn, lastOut (epoch ms or null), punches, workedMinutes, lateMinutes, overtimeMinutes, dutyMinutes, incomplete, restDay }
 */
function computeDays({ punches, shift, policyFor, from, to, until, joiningDate, leavingDate = null, isHoliday = () => false, isLeave = () => false }) {
  const byDay = new Map();
  for (const ms of [...punches].sort((a, b) => a - b)) {
    const k = workDay(ms, shift);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(ms);
  }
  const first = Math.max(dayIndex(from), dayIndex(joiningDate));
  const last = Math.min(dayIndex(to), dayIndex(until), leavingDate ? dayIndex(leavingDate) : Infinity);
  const duty = shift ? Math.round(Number(shift.dutyHours) * 60) : null;
  const startMinute = shift ? span(shift).s : 0;
  const rows = [];
  for (let k = first; k <= last; k++) {
    const date = ymdOf(k);
    const policy = policyFor(date);
    const list = byDay.get(k) || [];
    const rest = WEEKDAYS[new Date(k * 86400000).getUTCDay()] === policy.weeklyOffDay || isHoliday(date);
    const row = { date, code: null, firstIn: null, lastOut: null, punches: list.length, workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0, dutyMinutes: duty, incomplete: false, restDay: rest };
    if (!list.length) {
      if (k === dayIndex(until) && !rest && !isLeave(date)) continue; // today, nobody has come yet: not absent so far
      row.code = rest ? 'R' : isLeave(date) ? 'AL' : 'A';
      rows.push(row);
      continue;
    }
    row.firstIn = list[0];
    row.lastOut = list[list.length - 1];
    row.workedMinutes = Math.floor((row.lastOut - row.firstIn) / 60000);
    row.incomplete = row.workedMinutes < MIN_WORK_MINUTES;
    if (rest) {
      row.code = 'R';
      row.overtimeMinutes = row.incomplete ? 0 : row.workedMinutes;
    } else {
      row.lateMinutes = shift ? Math.max(0, localMinute(row.firstIn) - (k * DAY + startMinute)) : 0;
      row.code = row.lateMinutes <= policy.lateLimitMinutes ? 'P' : row.lateMinutes <= policy.halfDayLimitMinutes ? 'L' : 'HD';
      row.overtimeMinutes = row.incomplete || duty == null ? 0 : Math.max(0, row.workedMinutes - duty);
    }
    rows.push(row);
  }
  return rows;
}

/** Overtime in days: every day's overtime over the duty hours of its shift, added up (20 hours on an 8 hour shift = 2.5). Two decimals. */
function overtimeDays(days) {
  const total = days.reduce((sum, d) => (d.dutyMinutes ? sum + d.overtimeMinutes / d.dutyMinutes : sum), 0);
  return Math.round(total * 100) / 100;
}

/** Days to pay for the month from the counts: P + L + R + AL + half of HD, less half a day for every `latesPerHalfDay` lates (0 = never). */
function payableDays({ P = 0, L = 0, HD = 0, R = 0, AL = 0 }, latesPerHalfDay) {
  const penalty = latesPerHalfDay > 0 ? Math.floor(L / latesPerHalfDay) * 0.5 : 0;
  return Math.max(0, P + L + R + AL + HD * 0.5 - penalty);
}

module.exports = { computeDays, overtimeDays, payableDays, workDay, dayIndex, ymdOf, MIN_WORK_MINUTES, WEEKDAYS, OFFSET };
