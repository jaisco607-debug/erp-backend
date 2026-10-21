// The mill is in Pakistan (UTC+5, no daylight saving). A "day" always means the Pakistan day, never the UTC day:
// at 02:30 on 21 October in Karachi it is still 20 October in UTC.
const Joi = require('joi');

const ZONE = 'Asia/Karachi';
const OFFSET = '+05:00';

/** Today's date (YYYY-MM-DD) in Pakistan. */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONE });

/** true for a real calendar date written YYYY-MM-DD (2026-02-30 and month 13 are not). */
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) && Number(m[1]) >= 1900;
}

/** The first and last instant of a Pakistan day, for filters on timestamp columns. */
const dayStart = (ymd) => `${ymd}T00:00:00.000${OFFSET}`;
const dayEnd = (ymd) => `${ymd}T23:59:59.999${OFFSET}`;

/** Joi: a real date like 2026-10-13. */
const ymdDate = () => Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((v, h) => (isRealDate(v) ? v : h.error('date.real')))
  .messages({ 'string.pattern.base': 'date must look like 2026-10-13', 'date.real': 'this is not a real date' });

module.exports = { ZONE, today, isRealDate, dayStart, dayEnd, ymdDate };
