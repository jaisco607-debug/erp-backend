// Keeps the attendance days in step with what they are worked out from. A holiday, a policy, a shift or an employee's shift / group / dates changes
// what a day is, so the days it touches are worked out again as soon as it is saved: nobody has to remember "Recalculate".
//   - Only days that have data behind them are touched: from the company's first punch to today (a company with no punches yet has nothing to redo).
//   - Days HR set by hand are kept (only the Recalculate button, `POST /attendance/process`, gives them back to the machine).
//   - It runs after the change is saved and never fails it: if it cannot finish, the change stays and the Recalculate button does the same work.
// The attendance service is loaded when needed (it reads the policies, and the policies call this file).
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const logger = require('../utils/logger');
const { today } = require('../utils/dates');
const { ymdOf, dayIndex } = require('../utils/attendanceEngine');

const MAX_DAYS = 400;
const POLICY_DAYS = 200;

async function firstPunchDay(companyId) {
  const [r] = await sequelize.query(`SELECT to_char(min(("punchAt" AT TIME ZONE 'Asia/Karachi')::date), 'YYYY-MM-DD') AS d FROM payroll_punches WHERE "companyId" = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT });
  return r.d;
}

/** Works the days out again for a range (cut to the days that can have data) for everyone, some employees or one group. */
async function refresh(companyId, { from = null, to = null, employeeIds = null, groupId = null, maxDays = MAX_DAYS } = {}) {
  try {
    const first = await firstPunchDay(companyId);
    if (!first) return null;
    const end = to && to < today() ? to : today();
    let start = from && from > first ? from : first;
    const floor = ymdOf(dayIndex(end) - maxDays);
    if (start < floor) start = floor;
    if (start > end) return null;
    const attendance = require('./payrollAttendanceService'); // eslint-disable-line global-require
    return await sequelize.transaction((transaction) => attendance.processRange(companyId, { from: start, to: end, employeeIds, groupId, keepManual: true }, transaction));
  } catch (e) {
    logger.warn({ err: e, companyId }, 'attendance refresh failed: use Recalculate');
    return null;
  }
}

/** A holiday or a shift of the masters was created, changed or deleted: `before` / `after` are their answers (null when there was none). */
async function masterChanged(companyId, kind, before, after) {
  if (kind === 'holiday') {
    for (const date of new Set([before && before.date, after && after.date].filter(Boolean))) await refresh(companyId, { from: date, to: date });
    return;
  }
  if (kind === 'shift') {
    const changed = !before || !after || ['startTime', 'endTime', 'dutyHours', 'isNight'].some((k) => before[k] !== after[k]);
    if (!changed) return;
    const id = (after || before).id;
    const ids = (await sequelize.query('SELECT id FROM payroll_employees WHERE "companyId" = :companyId AND "shiftId" = :id', { replacements: { companyId, id }, type: QueryTypes.SELECT })).map((r) => r.id);
    if (ids.length) await refresh(companyId, { employeeIds: ids, maxDays: POLICY_DAYS });
  }
}

/** A policy version of a group was created, changed or deleted: its months, from the version's month to today, are worked out again for the group. */
async function policyChanged(companyId, groupId, effectiveFrom) {
  await refresh(companyId, { from: `${effectiveFrom}-01`, groupId, maxDays: POLICY_DAYS });
}

/** An employee was created, got another shift / group / joining date, left or came back: his days are worked out again (this is also what picks up the punches that came before the employee existed). */
async function employeeChanged(companyId, employeeId, since = null) {
  const [e] = await sequelize.query(`SELECT to_char("joiningDate", 'YYYY-MM-DD') AS joined FROM payroll_employees WHERE id = :employeeId AND "companyId" = :companyId`,
    { replacements: { employeeId, companyId }, type: QueryTypes.SELECT });
  if (e) await refresh(companyId, { from: since && since < e.joined ? since : e.joined, employeeIds: [employeeId], maxDays: MAX_DAYS });
}

/** A leave was approved or cancelled: the AL days of that employee are worked out again for its dates. */
async function leaveChanged(companyId, employeeId, from, to) {
  await refresh(companyId, { from, to, employeeIds: [employeeId] });
}

module.exports = { refresh, masterChanged, policyChanged, employeeChanged, leaveChanged };
