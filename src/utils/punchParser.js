// Reads the rows of a punch file or of the machine API: an employee ID with a date and a time (or one date-time). Strict: a date is YYYY-MM-DD and a time is HH:MM or HH:MM:SS (24 hours). The clock is the Pakistan clock (UTC+5).
const { isRealDate, today } = require('./dates');

const OFFSET_MS = 5 * 3600 * 1000;

/** The date of a row: exactly YYYY-MM-DD, a real calendar date, year 2000 to 2100; else null. (A sheet's other ways of writing a date are turned into this by the screen.) */
function parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return null;
  return isRealDate(s) ? s : null;
}

/** Seconds since midnight from "HH:MM" or "HH:MM:SS", 24 hours, two digits each; else null. */
function parseTime(v) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
}

const localMs = (ymd, seconds) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) + seconds * 1000 - OFFSET_MS;
};

/**
 * One row -> { ok: true, empCode, ms, device, mode } or { ok: false, reason }.
 * The row has `employeeId` (the Employee ID of the Employee Master) and either `date` + `time` or one `punchedAt`; `device` and `mode` are optional.
 */
function parseRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, reason: 'The row is not an object' };
  const idText = String(row.employeeId == null ? '' : row.employeeId).trim();
  if (!/^\d{1,8}$/.test(idText) || Number(idText) < 1) return { ok: false, reason: 'Employee ID must be a number (1 to 8 digits)' };
  let ms;
  const stamp = row.punchedAt;
  if (stamp != null && String(stamp).trim() !== '') {
    const text = String(stamp).trim();
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(text) && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
      ms = Date.parse(text);
      if (Number.isNaN(ms)) return { ok: false, reason: 'The date and time are not valid' };
    } else {
      const parts = text.split(/[T ]+/);
      const date = parseDate(parts[0]);
      const time = parseTime(parts.slice(1).join(' '));
      if (!date) return { ok: false, reason: 'Date must be YYYY-MM-DD' };
      if (time == null) return { ok: false, reason: 'Time must be HH:MM or HH:MM:SS' };
      ms = localMs(date, time);
    }
  } else {
    const date = parseDate(row.date);
    if (!date) return { ok: false, reason: 'Date must be YYYY-MM-DD' };
    const time = parseTime(row.time);
    if (time == null) return { ok: false, reason: 'Time must be HH:MM or HH:MM:SS' };
    ms = localMs(date, time);
  }
  const day = new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
  if (day < '2000-01-01') return { ok: false, reason: 'The date is too old' };
  if (day > new Date(Date.parse(`${today()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) return { ok: false, reason: 'The date is in the future' };
  const device = row.device == null ? '' : String(row.device).trim().slice(0, 60);
  let mode = null;
  if (row.mode != null && String(row.mode).trim() !== '') {
    mode = Number(row.mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 32767) return { ok: false, reason: 'The mode must be a whole number' };
  }
  return { ok: true, empCode: Number(idText), ms, device: device || null, mode };
}

module.exports = { parseDate, parseTime, parseRow };
