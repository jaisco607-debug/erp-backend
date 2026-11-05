// Attendance (service PAYROLL_SALARY to change, any payroll service to read): punches in, a code for every employee and day out.
//   punches   come from an Excel / CSV file (the frontend reads the sheet and sends the rows) or, when the machine API exists, from its adapter:
//             both end in `importRows`, so a punch is stored the same way whichever road it took. Re-importing is safe (a moment is stored once per ID).
//   the ID    of a punch is the Employee ID (`code`) of the Employee Master. A punch whose ID has no employee is kept as "unmapped" and counts as soon
//             as the employee is created.
//   days      are worked out by utils/attendanceEngine from the punches, the employee's shift and the policy of the group; HR can correct a day by hand
//             (it is then never overwritten by a recalculation). Overtime is hours over the shift's duty hours, shown month-end in days.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today, dayStart, dayEnd } = require('../utils/dates');
const { parseRow } = require('../utils/punchParser');
const { computeDays, overtimeDays, payableDays, ymdOf, dayIndex } = require('../utils/attendanceEngine');
const audit = require('./auditService');
const { effectivePolicy } = require('./payrollPolicyService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const pad5 = (n) => String(n).padStart(5, '0');
const CODES = ['P', 'L', 'HD', 'A', 'R', 'AL'];
const LOCAL = (col) => `to_char(${col} AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD HH24:MI')`;
const LOCAL_DAY = (col) => `(${col} AT TIME ZONE 'Asia/Karachi')::date`;
const thisMonth = () => today().slice(0, 7);
const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString());
const round2 = (n) => Math.round(n * 100) / 100;

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dates = Array.from({ length: lastDay }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  return { first, last: dates[dates.length - 1], dates, fromTs: dayStart(first), toTs: dayStart(ymdOf(dayIndex(dates[dates.length - 1]) + 1)) };
}

// ---- reading and importing punches ----

/** Checks the rows and sorts them: the good ones, the refused ones (with the reason), the repeats and the ones already stored. Nothing is saved. */
async function prepare(companyId, rows, transaction) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicatesInFile = 0;
  rows.forEach((raw, i) => {
    const r = parseRow(raw);
    if (!r.ok) { invalid.push({ row: i + 1, reason: r.reason, data: raw }); return; }
    const key = `${r.empCode}|${r.ms}`;
    if (seen.has(key)) { duplicatesInFile += 1; return; }
    seen.add(key);
    valid.push(r);
  });
  const codes = [...new Set(valid.map((r) => r.empCode))];
  let known = new Set();
  let existing = new Set();
  if (codes.length) {
    known = new Set((await q('SELECT code FROM payroll_employees WHERE "companyId" = :companyId AND code IN (:codes)', { companyId, codes }, transaction)).map((r) => r.code));
    const times = valid.map((r) => r.ms);
    existing = new Set((await q('SELECT "empCode", "punchAt" FROM payroll_punches WHERE "companyId" = :companyId AND "empCode" IN (:codes) AND "punchAt" BETWEEN :min AND :max',
      { companyId, codes, min: new Date(Math.min(...times)), max: new Date(Math.max(...times)) }, transaction)).map((r) => `${r.empCode}|${new Date(r.punchAt).getTime()}`));
  }
  const fresh = valid.filter((r) => !existing.has(`${r.empCode}|${r.ms}`));
  const unknown = new Map();
  for (const r of valid) if (!known.has(r.empCode)) unknown.set(r.empCode, (unknown.get(r.empCode) || 0) + 1);
  const days = fresh.map((r) => new Date(r.ms + 5 * 3600 * 1000).toISOString().slice(0, 10)).sort();
  const report = {
    total: rows.length, valid: valid.length, invalid: invalid.length, invalidRows: invalid.slice(0, 200), duplicatesInFile, alreadyInSystem: valid.length - fresh.length,
    toImport: fresh.length, employees: new Set(fresh.filter((r) => known.has(r.empCode)).map((r) => r.empCode)).size,
    unknownIdCount: unknown.size, unknownIds: [...unknown].sort((a, b) => a[0] - b[0]).slice(0, 200).map(([employeeId, punches]) => ({ employeeId, punches })),
    devices: [...new Set(fresh.map((r) => r.device).filter(Boolean))].sort(), from: days[0] || null, to: days[days.length - 1] || null,
  };
  return { report, fresh };
}

/** What an import would do, without saving anything: the screen shows it before the user presses Import. */
async function preview(req, { rows }) {
  return (await prepare(req.user.companyId, rows)).report;
}

/**
 * Stores the punches of a file (or of the machine API) and works out the days they touch. `rows` are { employeeId, date, time | punchedAt, device?, mode? }.
 * This is the one door every source goes through; the machine API adapter calls it with source 'API'.
 */
async function importRows(req, { rows, source = 'EXCEL', fileName = null }) {
  const { companyId } = req.user;
  let result;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-punches:${companyId}` }, transaction });
    const { report, fresh } = await prepare(companyId, rows, transaction);
    // nothing new (the same file again): no batch in the history and no days worked out again
    if (!fresh.length) {
      result = { batchId: null, source, total: report.total, inserted: 0, duplicates: report.total - report.invalid, invalid: report.invalid, invalidRows: report.invalidRows, unknownIdCount: report.unknownIdCount, unknownIds: report.unknownIds, from: report.from, to: report.to, processed: { employees: 0, days: 0 } };
      return;
    }
    const [batch] = await q(`INSERT INTO payroll_punch_batches ("companyId", source, "fileName", "totalRows", invalid, "fromDate", "toDate", "createdById")
      VALUES (:companyId, :source, :fileName, :total, :invalid, :from, :to, :userId) RETURNING id`,
    { companyId, source, fileName, total: report.total, invalid: report.invalid, from: report.from, to: report.to, userId: req.user.id }, transaction);
    const deviceIds = new Map();
    for (const name of report.devices) {
      const [d] = await q(`INSERT INTO payroll_devices ("companyId", code, name) VALUES (:companyId, :name, :name)
        ON CONFLICT ("companyId", code) DO UPDATE SET "updatedAt" = now() RETURNING id`, { companyId, name }, transaction);
      deviceIds.set(name, d.id);
    }
    let inserted = 0;
    for (let i = 0; i < fresh.length; i += 2000) {
      const chunk = fresh.slice(i, i + 2000).map((r) => ({ e: r.empCode, t: iso(r.ms), d: r.device ? deviceIds.get(r.device) : null, m: r.mode }));
      const done = await q(`INSERT INTO payroll_punches ("companyId", "empCode", "punchAt", "deviceId", mode, source, "batchId")
        SELECT CAST(:companyId AS uuid), x.e, x.t, x.d, x.m, :source, CAST(:batchId AS uuid)
        FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x(e int, t timestamptz, d uuid, m smallint)
        ON CONFLICT ("companyId", "empCode", "punchAt") DO NOTHING RETURNING id`, { companyId, source, batchId: batch.id, rows: JSON.stringify(chunk) }, transaction);
      inserted += done.length;
    }
    const duplicates = report.total - report.invalid - inserted;
    await run('UPDATE payroll_punch_batches SET inserted = :inserted, duplicates = :duplicates WHERE id = :id', { id: batch.id, inserted, duplicates }, transaction);
    let processed = { employees: 0, days: 0 };
    // the whole of the months the file touches, up to today: the rest days (weekly off, holidays) of those months get their R even where no file was uploaded
    if (inserted) processed = await processRange(companyId, importRange(report.from, report.to), transaction);
    await audit.log(req, { action: 'PAYROLL_PUNCHES_IMPORTED', entityType: 'PayrollPunchBatch', entityId: batch.id, after: { source, fileName, total: report.total, inserted, duplicates, invalid: report.invalid, from: report.from, to: report.to } }, { transaction });
    result = { batchId: batch.id, source, total: report.total, inserted, duplicates, invalid: report.invalid, invalidRows: report.invalidRows, unknownIdCount: report.unknownIdCount, unknownIds: report.unknownIds, from: report.from, to: report.to, processed };
  });
  return result;
}

/** From the day before the first day of the month of the file's first punch to the later of its last punch and today (at most 400 days). */
function importRange(from, to) {
  const end = to > today() ? to : today();
  const start = ymdOf(dayIndex(`${from.slice(0, 7)}-01`) - 1);
  const floor = ymdOf(dayIndex(end) - 400);
  return { from: start < floor ? floor : start, to: end };
}

/** The machine API is not connected yet: the screen keeps its button and gets this answer. When the API exists its adapter turns the response into rows and calls importRows. */
async function fetchFromApi() {
  throw AppError.rule('API_NOT_CONFIGURED', 'The attendance machine API is not connected yet: upload the Excel file instead');
}

// ---- working out the days ----

/**
 * (Re)works out the days of the employees in scope for a range of dates from their punches. Days HR set by hand are kept (`keepManual`, the default) or given
 * back to the machine (`keepManual: false`, what the Recalculate button does). A day nobody punched on
 * (the machine was off, the file does not reach it) is left empty instead of marking the whole company absent.
 */
async function processRange(companyId, { from, to, employeeIds = null, groupId = null, keepManual = true }, transaction) {
  if (employeeIds && !employeeIds.length) return { employees: 0, days: 0, manualReset: 0, from, to };
  const repl = { companyId, from, to };
  let extra = '';
  if (employeeIds) { extra += ' AND e.id IN (:employeeIds)'; repl.employeeIds = employeeIds; }
  if (groupId) { extra += ' AND e."groupId" = :groupId'; repl.groupId = groupId; }
  const emps = await q(`SELECT e.id, e.code, e."groupId", to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, to_char(e."leavingDate", 'YYYY-MM-DD') AS "leftOn",
      to_char(s."startTime", 'HH24:MI') AS "shiftStart", to_char(s."endTime", 'HH24:MI') AS "shiftEnd", s."dutyHours"::float AS duty
    FROM payroll_employees e LEFT JOIN payroll_shifts s ON s.id = e."shiftId"
    WHERE e."companyId" = :companyId AND e."joiningDate" <= :to AND (NOT e."isClosed" OR e."leavingDate" >= :from)${extra}`, repl, transaction);
  if (!emps.length) return { employees: 0, days: 0, manualReset: 0, from, to };

  const punchRows = await q('SELECT "empCode", "punchAt" FROM payroll_punches WHERE "companyId" = :companyId AND "empCode" IN (:codes) AND "punchAt" BETWEEN :lower AND :upper',
    { companyId, codes: emps.map((e) => e.code), lower: new Date(Date.parse(dayStart(from)) - 86400000), upper: new Date(Date.parse(dayEnd(to)) + 86400000) }, transaction);
  const punchesOf = new Map();
  for (const p of punchRows) {
    if (!punchesOf.has(p.empCode)) punchesOf.set(p.empCode, []);
    punchesOf.get(p.empCode).push(new Date(p.punchAt).getTime());
  }

  const holidayRows = await q(`SELECT to_char(h."holidayDate", 'YYYY-MM-DD') AS d, h."appliesToAll" AS "all", COALESCE(array_agg(hg."groupId") FILTER (WHERE hg."groupId" IS NOT NULL), '{}') AS groups
    FROM payroll_holidays h LEFT JOIN payroll_holiday_groups hg ON hg."holidayId" = h.id WHERE h."companyId" = :companyId AND h."holidayDate" BETWEEN :from AND :to GROUP BY h.id`, { companyId, from, to }, transaction);
  const holidays = new Map();
  for (const h of holidayRows) {
    if (!holidays.has(h.d)) holidays.set(h.d, { all: false, groups: new Set() });
    const e = holidays.get(h.d);
    e.all = e.all || h.all;
    for (const g of h.groups) e.groups.add(g);
  }

  const months = [...new Set(Array.from({ length: dayIndex(to) - dayIndex(from) + 1 }, (_, i) => ymdOf(dayIndex(from) + i).slice(0, 7)))];
  const policies = new Map();
  for (const g of new Set(emps.map((e) => e.groupId))) for (const m of months) policies.set(`${g}|${m}`, await effectivePolicy(companyId, g, m, transaction));

  // the days of approved leave: AL where nobody punched
  const leaveRows = await q(`SELECT d."employeeId", to_char(d."leaveDate", 'YYYY-MM-DD') AS day FROM payroll_leave_days d JOIN payroll_leaves l ON l.id = d."leaveId"
    WHERE d."companyId" = :companyId AND l.status = 'APPROVED' AND d."leaveDate" BETWEEN :from AND :to AND d."employeeId" IN (:ids)`, { companyId, from, to, ids: emps.map((e) => e.id) }, transaction);
  const leaveOf = new Map();
  for (const l of leaveRows) { if (!leaveOf.has(l.employeeId)) leaveOf.set(l.employeeId, new Set()); leaveOf.get(l.employeeId).add(l.day); }

  const until = today();
  const all = [];
  // a day has data when ANYBODY of the company punched on it (not only the employees being worked out now): otherwise an employee worked out alone would lose his absent days
  const withData = new Set((await q(`SELECT DISTINCT to_char(("punchAt" AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM-DD') AS d FROM payroll_punches WHERE "companyId" = :companyId AND "punchAt" BETWEEN :lower AND :upper`,
    { companyId, lower: new Date(Date.parse(dayStart(from)) - 86400000), upper: new Date(Date.parse(dayEnd(to)) + 86400000) }, transaction)).map((r) => r.d));
  for (const e of emps) {
    const rows = computeDays({
      punches: punchesOf.get(e.code) || [], shift: e.shiftStart ? { start: e.shiftStart, end: e.shiftEnd, dutyHours: e.duty } : null,
      policyFor: (ymd) => policies.get(`${e.groupId}|${ymd.slice(0, 7)}`), from, to, until, joiningDate: e.joined, leavingDate: e.leftOn,
      isHoliday: (ymd) => { const h = holidays.get(ymd); return Boolean(h && (h.all || h.groups.has(e.groupId))); },
      isLeave: (ymd) => Boolean(leaveOf.get(e.id) && leaveOf.get(e.id).has(ymd)),
    });
    for (const r of rows) { if (r.punches) withData.add(r.date); all.push({ employeeId: e.id, ...r }); }
  }
  const keep = all.filter((r) => r.code !== 'A' || withData.has(r.date));

  const removed = await q(`DELETE FROM payroll_attendance_days WHERE "companyId" = :companyId AND "employeeId" IN (:ids) AND "workDate" BETWEEN :from AND :to${keepManual ? ' AND NOT "isManual"' : ''} RETURNING "isManual"`,
    { companyId, ids: emps.map((e) => e.id), from, to }, transaction);
  for (let i = 0; i < keep.length; i += 2000) {
    const chunk = keep.slice(i, i + 2000).map((r) => ({ employeeId: r.employeeId, workDate: r.date, code: r.code, firstIn: iso(r.firstIn), lastOut: iso(r.lastOut), punches: r.punches,
      workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, overtimeMinutes: r.overtimeMinutes, dutyMinutes: r.dutyMinutes, incomplete: r.incomplete, restDay: r.restDay }));
    await run(`INSERT INTO payroll_attendance_days ("companyId", "employeeId", "workDate", code, "firstIn", "lastOut", punches, "workedMinutes", "lateMinutes", "overtimeMinutes", "dutyMinutes", incomplete, "restDay")
      SELECT CAST(:companyId AS uuid), x."employeeId", x."workDate", x.code, x."firstIn", x."lastOut", x.punches, x."workedMinutes", x."lateMinutes", x."overtimeMinutes", x."dutyMinutes", x.incomplete, x."restDay"
      FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x("employeeId" uuid, "workDate" date, code text, "firstIn" timestamptz, "lastOut" timestamptz, punches int, "workedMinutes" int, "lateMinutes" int, "overtimeMinutes" int, "dutyMinutes" int, incomplete boolean, "restDay" boolean)
      ON CONFLICT ("employeeId", "workDate") DO NOTHING`, { companyId, rows: JSON.stringify(chunk) }, transaction);
  }
  return { employees: emps.length, days: keep.length, manualReset: removed.filter((r) => r.isManual).length, from, to };
}

/** "Recalculate": works the days out again for a range (up to 93 days), for everyone or one group / employee. Days HR set by hand go back to what the machine says, unless `keepManual`. */
async function process(req, { from, to, groupId, employeeId, keepManual = false }) {
  if (to < from) throw AppError.rule('RANGE_BACKWARDS', 'The end date is before the start date');
  if (dayIndex(to) - dayIndex(from) > 92) throw AppError.rule('RANGE_TOO_LONG', 'Work out at most 93 days at a time');
  let result;
  await sequelize.transaction(async (transaction) => {
    result = await processRange(req.user.companyId, { from, to, groupId: groupId || null, employeeIds: employeeId ? [employeeId] : null, keepManual }, transaction);
    await audit.log(req, { action: 'PAYROLL_ATTENDANCE_PROCESSED', entityType: 'PayrollAttendance', after: { from, to, groupId: groupId || null, employeeId: employeeId || null, days: result.days, keepManual, manualReset: result.manualReset } }, { transaction });
  });
  return result;
}

// ---- the summary screen: devices, daily counts, details, unmapped ----

async function overview(req, { month }) {
  const { companyId } = req.user;
  const m = month || thisMonth();
  const { first, last, dates, fromTs, toTs } = monthBounds(m);
  const [totals] = await q(`SELECT count(*)::int AS punches, count(DISTINCT p."deviceId")::int AS "deviceCount",
      count(DISTINCT p."empCode") FILTER (WHERE e.id IS NOT NULL)::int AS employees,
      count(*) FILTER (WHERE e.id IS NULL)::int AS "unmappedPunches", count(DISTINCT p."empCode") FILTER (WHERE e.id IS NULL)::int AS "unmappedIds"
    FROM payroll_punches p LEFT JOIN payroll_employees e ON e."companyId" = p."companyId" AND e.code = p."empCode"
    WHERE p."companyId" = :companyId AND p."punchAt" >= :fromTs AND p."punchAt" < :toTs`, { companyId, fromTs, toTs });
  const [manual] = await q('SELECT count(*)::int AS n FROM payroll_attendance_days WHERE "companyId" = :companyId AND "workDate" BETWEEN :first AND :last AND "isManual"', { companyId, first, last });
  const [now] = await q(`SELECT count(DISTINCT "empCode")::int AS n FROM payroll_punches WHERE "companyId" = :companyId AND ${LOCAL_DAY('"punchAt"')} = :today`, { companyId, today: today() });
  const [sync] = await q(`SELECT b.id, b.source, b."fileName", b."totalRows", b.inserted, b.duplicates, b.invalid, to_char(b."fromDate", 'YYYY-MM-DD') AS "fromDate", to_char(b."toDate", 'YYYY-MM-DD') AS "toDate", b."createdAt", u.name AS "by"
    FROM payroll_punch_batches b LEFT JOIN users u ON u.id = b."createdById" WHERE b."companyId" = :companyId AND b."undoneAt" IS NULL ORDER BY b."createdAt" DESC LIMIT 1`, { companyId });
  const devRows = await q(`SELECT d.id, d.code, d.name, d."isActive", count(p.id) FILTER (WHERE p."punchAt" >= :fromTs AND p."punchAt" < :toTs)::int AS punches, ${LOCAL('max(p."punchAt")')} AS "lastRecord"
    FROM payroll_devices d LEFT JOIN payroll_punches p ON p."deviceId" = d.id WHERE d."companyId" = :companyId GROUP BY d.id ORDER BY lower(d.name)`, { companyId, fromTs, toTs });
  const seen = await q(`SELECT "deviceId", array_agg(DISTINCT to_char("punchAt" AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')) AS days FROM payroll_punches
    WHERE "companyId" = :companyId AND "deviceId" IS NOT NULL AND "punchAt" >= :fromTs AND "punchAt" < :toTs GROUP BY "deviceId"`, { companyId, fromTs, toTs });
  const seenBy = new Map(seen.map((s) => [s.deviceId, new Set(s.days)]));
  const upTo = today() < last ? today() : last;
  const daily = await q(`SELECT to_char(${LOCAL_DAY('"punchAt"')}, 'YYYY-MM-DD') AS date, count(*)::int AS punches, count(DISTINCT "empCode")::int AS employees FROM payroll_punches
    WHERE "companyId" = :companyId AND "punchAt" >= :fromTs AND "punchAt" < :toTs GROUP BY 1 ORDER BY 1 DESC`, { companyId, fromTs, toTs });
  return {
    month: m, ...totals, manualDays: manual.n, today: now.n, api: { configured: false },
    lastSync: sync ? { ...sync, label: `${sync.source === 'API' ? 'API' : 'File'}: ${sync.inserted} new punches, ${sync.duplicates} duplicates, ${sync.invalid} refused` } : null,
    devices: devRows.map((d) => ({
      id: d.id, code: d.code, name: d.name, isActive: d.isActive, punches: d.punches, lastRecord: d.lastRecord,
      missingDates: d.punches ? dates.filter((x) => x <= upTo && !seenBy.get(d.id).has(x)) : [],
    })),
    daily,
    firstDay: first, lastDay: last,
  };
}

async function punches(req, f) {
  const { companyId } = req.user;
  const where = ['p."companyId" = :companyId'];
  const repl = { companyId };
  const from = f.date || f.from;
  const to = f.date || f.to;
  if (from) { where.push('p."punchAt" >= :fromTs'); repl.fromTs = dayStart(from); }
  if (to) { where.push('p."punchAt" <= :toTs'); repl.toTs = dayEnd(to); }
  if (f.employeeCode) { where.push('p."empCode" = :code'); repl.code = f.employeeCode; }
  if (f.deviceId) { where.push('p."deviceId" = :deviceId'); repl.deviceId = f.deviceId; }
  if (f.unmapped) where.push('e.id IS NULL');
  const limit = f.limit || 200;
  const page = f.page || 1;
  const from_ = `payroll_punches p LEFT JOIN payroll_employees e ON e."companyId" = p."companyId" AND e.code = p."empCode" LEFT JOIN payroll_devices d ON d.id = p."deviceId"`;
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${from_} WHERE ${where.join(' AND ')}`, repl);
  const rows = await q(`SELECT p.id, p."empCode", e.id AS "employeeId", e.name, d.id AS "deviceId", d.name AS "deviceName", p.mode, p.source, ${LOCAL('p."punchAt"').replace("'YYYY-MM-DD HH24:MI'", "'YYYY-MM-DD HH24:MI:SS'")} AS time, p."punchAt"
    FROM ${from_} WHERE ${where.join(' AND ')} ORDER BY p."punchAt", p."empCode" LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  return {
    data: rows.map((r) => ({ id: r.id, time: r.time, at: r.punchAt, employeeCode: r.empCode, employeeLabel: pad5(r.empCode), employee: r.employeeId ? { id: r.employeeId, name: r.name } : null,
      device: r.deviceId ? { id: r.deviceId, name: r.deviceName } : null, mode: r.mode, source: r.source, unmapped: !r.employeeId })),
    page, limit, total: n,
  };
}

/** IDs the machine sent that no employee has: the list HR works through (create the employee with that ID). */
async function unmapped(req, { month }) {
  const m = month || thisMonth();
  const { fromTs, toTs } = monthBounds(m);
  const rows = await q(`SELECT p."empCode", count(*)::int AS punches, ${LOCAL('min(p."punchAt")')} AS "firstSeen", ${LOCAL('max(p."punchAt")')} AS "lastSeen",
      COALESCE(array_agg(DISTINCT d.name) FILTER (WHERE d.name IS NOT NULL), '{}') AS devices
    FROM payroll_punches p LEFT JOIN payroll_employees e ON e."companyId" = p."companyId" AND e.code = p."empCode" LEFT JOIN payroll_devices d ON d.id = p."deviceId"
    WHERE p."companyId" = :companyId AND e.id IS NULL AND p."punchAt" >= :fromTs AND p."punchAt" < :toTs GROUP BY p."empCode" ORDER BY p."empCode"`, { companyId: req.user.companyId, fromTs, toTs });
  return { month: m, total: rows.length, data: rows.map((r) => ({ employeeCode: r.empCode, employeeLabel: pad5(r.empCode), punches: r.punches, firstSeen: r.firstSeen, lastSeen: r.lastSeen, devices: r.devices })) };
}

// ---- imports and devices ----

async function batches(req, { page = 1, limit = 50 } = {}) {
  const { companyId } = req.user;
  const [{ n }] = await q('SELECT count(*)::int AS n FROM payroll_punch_batches WHERE "companyId" = :companyId', { companyId });
  const rows = await q(`SELECT b.id, b.source, b."fileName", b."totalRows", b.inserted, b.duplicates, b.invalid, to_char(b."fromDate", 'YYYY-MM-DD') AS "fromDate", to_char(b."toDate", 'YYYY-MM-DD') AS "toDate",
      b."createdAt", u.name AS "by", b."undoneAt"
    FROM payroll_punch_batches b LEFT JOIN users u ON u.id = b."createdById" WHERE b."companyId" = :companyId ORDER BY b."createdAt" DESC LIMIT :limit OFFSET :offset`, { companyId, limit, offset: (page - 1) * limit });
  return { data: rows.map((b) => ({ ...b, isUndone: Boolean(b.undoneAt), canUndo: !b.undoneAt && b.inserted > 0 })), page, limit, total: n };
}

/** Takes an import back: its punches are removed and the days they touched are worked out again (days HR set by hand stay). */
async function undoBatch(req, id) {
  const { companyId } = req.user;
  let removed = 0;
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `payroll-punches:${companyId}` }, transaction });
    const [b] = await q(`SELECT id, "undoneAt", to_char("fromDate", 'YYYY-MM-DD') AS "fromDate", to_char("toDate", 'YYYY-MM-DD') AS "toDate", inserted, "fileName" FROM payroll_punch_batches WHERE id = :id AND "companyId" = :companyId FOR UPDATE`, { id, companyId }, transaction);
    if (!b) throw AppError.notFound('Import');
    if (b.undoneAt) throw AppError.rule('ALREADY_UNDONE', 'This import was already taken back');
    const gone = await q('DELETE FROM payroll_punches WHERE "batchId" = :id AND "companyId" = :companyId RETURNING id', { id, companyId }, transaction);
    removed = gone.length;
    await run('UPDATE payroll_punch_batches SET "undoneAt" = now(), "undoneById" = :userId WHERE id = :id', { id, userId: req.user.id }, transaction);
    if (b.fromDate) await processRange(companyId, importRange(b.fromDate, b.toDate), transaction);
    await audit.log(req, { action: 'PAYROLL_PUNCHES_UNDONE', entityType: 'PayrollPunchBatch', entityId: id, after: { fileName: b.fileName, removed } }, { transaction });
  });
  return { id, removed };
}

async function devices(req) {
  const rows = await q(`SELECT d.id, d.code, d.name, d."isActive", count(p.id)::int AS punches, ${LOCAL('max(p."punchAt")')} AS "lastRecord"
    FROM payroll_devices d LEFT JOIN payroll_punches p ON p."deviceId" = d.id WHERE d."companyId" = :companyId GROUP BY d.id ORDER BY lower(d.name)`, { companyId: req.user.companyId });
  return { data: rows };
}

async function updateDevice(req, id, changes) {
  const { companyId } = req.user;
  const sets = [];
  const repl = { id, companyId };
  if (changes.name !== undefined) { sets.push('name = :name'); repl.name = changes.name; }
  if (changes.isActive !== undefined) { sets.push('"isActive" = :isActive'); repl.isActive = changes.isActive; }
  const [row] = await q(`UPDATE payroll_devices SET ${sets.join(', ')}, "updatedAt" = now() WHERE id = :id AND "companyId" = :companyId RETURNING id, code, name, "isActive"`, repl);
  if (!row) throw AppError.notFound('Device');
  await audit.log(req, { action: 'PAYROLL_DEVICE_UPDATED', entityType: 'PayrollDevice', entityId: id, after: row });
  return row;
}

// ---- the days: month grid, month totals, one day ----

const dayJson = (d) => ({
  code: d.code, originalCode: d.originalCode, firstIn: d.firstIn, lastOut: d.lastOut, punches: d.punches, workedMinutes: d.workedMinutes, lateMinutes: d.lateMinutes, overtimeMinutes: d.overtimeMinutes,
  overtimeHours: round2(d.overtimeMinutes / 60), incomplete: d.incomplete, restDay: d.restDay, manual: d.isManual, note: d.note,
});
const employeeJson = (e) => ({
  id: e.id, code: e.code, label: pad5(e.code), name: e.name, group: { id: e.groupId, name: e.groupName }, department: e.departmentId ? { id: e.departmentId, name: e.departmentName } : null,
  shift: e.shiftCode ? { code: e.shiftCode, dutyHours: e.duty } : null, isClosed: e.isClosed,
});
const DAY_COLS = `to_char(d."workDate", 'YYYY-MM-DD') AS date, d."employeeId", d.code, ${LOCAL('d."firstIn"')} AS "firstIn", ${LOCAL('d."lastOut"')} AS "lastOut", d.punches, d."workedMinutes",
  d."lateMinutes", d."overtimeMinutes", d."dutyMinutes", d.incomplete, d."restDay", d."isManual", d."originalCode", d.note`;

function totalsOf(days) {
  const t = { P: 0, L: 0, HD: 0, A: 0, R: 0, AL: 0 };
  let worked = 0; let late = 0; let overtime = 0; let incomplete = 0; let manual = 0;
  for (const d of days) {
    t[d.code] += 1; worked += d.workedMinutes; late += d.lateMinutes; overtime += d.overtimeMinutes;
    if (d.incomplete) incomplete += 1;
    if (d.isManual) manual += 1;
  }
  return { ...t, marked: days.length, workedMinutes: worked, lateMinutes: late, overtimeMinutes: overtime, overtimeHours: round2(overtime / 60), overtimeDays: overtimeDays(days), incompleteDays: incomplete, manualDays: manual };
}

/** The employees of a month's screen (one page) with their day rows. */
async function loadMonth(req, f) {
  const { companyId } = req.user;
  const month = f.month || thisMonth();
  const { first, last, dates } = monthBounds(month);
  const where = ['e."companyId" = :companyId', 'e."joiningDate" <= :last'];
  const repl = { companyId, first, last };
  if (f.closed !== 'all') where.push('(NOT e."isClosed" OR e."leavingDate" >= :first)');
  for (const k of ['groupId', 'departmentId', 'designationId']) if (f[k]) { where.push(`e."${k}" = :${k}`); repl[k] = f[k]; }
  if (f.employeeId) { where.push('e.id = :employeeId'); repl.employeeId = f.employeeId; }
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR e.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(e.name ILIKE :like OR e.cnic ILIKE :like${numeric})`);
  }
  const limit = f.limit || 100;
  const page = f.page || 1;
  const from = `payroll_employees e JOIN payroll_groups g ON g.id = e."groupId" LEFT JOIN payroll_departments dp ON dp.id = e."departmentId" LEFT JOIN payroll_shifts s ON s.id = e."shiftId"`;
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${from} WHERE ${where.join(' AND ')}`, repl);
  const emps = await q(`SELECT e.id, e.code, e.name, e."groupId", g.name AS "groupName", e."departmentId", dp.name AS "departmentName", s.code AS "shiftCode", s."dutyHours"::float AS duty, e."isClosed"
    FROM ${from} WHERE ${where.join(' AND ')} ORDER BY e.code LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const byEmp = new Map(emps.map((e) => [e.id, []]));
  if (emps.length) {
    const rows = await q(`SELECT ${DAY_COLS} FROM payroll_attendance_days d WHERE d."companyId" = :companyId AND d."employeeId" IN (:ids) AND d."workDate" BETWEEN :first AND :last ORDER BY d."workDate"`,
      { companyId, ids: emps.map((e) => e.id), first, last });
    for (const r of rows) byEmp.get(r.employeeId).push(r);
  }
  return { month, dates, emps, byEmp, page, limit, total: n };
}

/** The month grid: one row per employee with a day object for every date that has a result, and the totals. */
async function days(req, f) {
  const m = await loadMonth(req, f);
  return {
    month: m.month, dates: m.dates, page: m.page, limit: m.limit, total: m.total,
    data: m.emps.map((e) => {
      const rows = m.byEmp.get(e.id);
      return { employee: employeeJson(e), days: Object.fromEntries(rows.map((r) => [r.date, dayJson(r)])), totals: totalsOf(rows) };
    }),
  };
}

/** The month's totals per employee: what the payroll will read (counts, late and overtime, overtime in days, payable days). */
async function summary(req, f) {
  const { companyId } = req.user;
  const m = await loadMonth(req, f);
  const latesPer = new Map();
  for (const e of m.emps) if (!latesPer.has(e.groupId)) latesPer.set(e.groupId, (await effectivePolicy(companyId, e.groupId, m.month)).latesPerHalfDay);
  return {
    month: m.month, page: m.page, limit: m.limit, total: m.total,
    data: m.emps.map((e) => {
      const t = totalsOf(m.byEmp.get(e.id));
      const n = latesPer.get(e.groupId);
      return { employee: employeeJson(e), ...t, lateDeductionDays: n > 0 ? Math.floor(t.L / n) * 0.5 : 0, payableDays: payableDays(t, n) };
    }),
  };
}

/** Daily P / L / HD / A / R: the counts of one date and who is in each. */
async function daily(req, { date, code }) {
  const { companyId } = req.user;
  const rows = await q(`SELECT ${DAY_COLS}, e.id, e.code AS ecode, e.name, e."groupId", g.name AS "groupName", e."departmentId", dp.name AS "departmentName", s.code AS "shiftCode", s."dutyHours"::float AS duty, e."isClosed"
    FROM payroll_attendance_days d JOIN payroll_employees e ON e.id = d."employeeId" JOIN payroll_groups g ON g.id = e."groupId"
    LEFT JOIN payroll_departments dp ON dp.id = e."departmentId" LEFT JOIN payroll_shifts s ON s.id = e."shiftId"
    WHERE d."companyId" = :companyId AND d."workDate" = :date ORDER BY e.code`, { companyId, date });
  const counts = { P: 0, L: 0, HD: 0, A: 0, R: 0, AL: 0 };
  for (const r of rows) counts[r.code] += 1;
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM payroll_punches WHERE "companyId" = :companyId AND ${LOCAL_DAY('"punchAt"')} = :date`, { companyId, date });
  return {
    date, counts, total: rows.length, punches: n, noData: n === 0 && !rows.length,
    data: rows.filter((r) => !code || r.code === code).map((r) => ({ employee: employeeJson({ ...r, code: r.ecode }), ...dayJson(r) })),
  };
}

// ---- HR corrects a day ----

async function employeeOr404(companyId, id, transaction) {
  const [e] = await q(`SELECT e.id, e.code, e.name, to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, to_char(e."leavingDate", 'YYYY-MM-DD') AS "leftOn", s."dutyHours"::float AS duty
    FROM payroll_employees e LEFT JOIN payroll_shifts s ON s.id = e."shiftId" WHERE e.id = :id AND e."companyId" = :companyId`, { id, companyId }, transaction);
  if (!e) throw AppError.notFound('Employee');
  return e;
}
async function dayRow(companyId, employeeId, date, transaction) {
  const [r] = await q(`SELECT ${DAY_COLS} FROM payroll_attendance_days d WHERE d."companyId" = :companyId AND d."employeeId" = :employeeId AND d."workDate" = :date`, { companyId, employeeId, date }, transaction);
  return r ? dayJson(r) : null;
}

/** Sets the code of a day by hand (e.g. approved leave AL, or a day the machine missed) and optionally its overtime minutes; the day is then kept through every recalculation. */
async function editDay(req, employeeId, date, { code, overtimeMinutes, note }) {
  const { companyId } = req.user;
  if (date > today()) throw AppError.rule('DATE_IN_FUTURE', 'A day that has not come yet cannot be set');
  await sequelize.transaction(async (transaction) => {
    const e = await employeeOr404(companyId, employeeId, transaction);
    if (date < e.joined) throw AppError.rule('BEFORE_JOINING', `The employee joined on ${e.joined}`);
    if (e.leftOn && date > e.leftOn) throw AppError.rule('AFTER_LEAVING', `The employee left on ${e.leftOn}`);
    const before = await dayRow(companyId, employeeId, date, transaction);
    // what the machine worked out, kept so the screen can show it and Recalculate can give it back
    const original = before ? (before.manual ? before.originalCode : before.code) : null;
    const keepOvertime = before && ['P', 'L', 'HD', 'R'].includes(code) ? before.overtimeMinutes : 0;
    const overtime = overtimeMinutes !== undefined ? overtimeMinutes : keepOvertime;
    const late = before && ['L', 'HD'].includes(code) ? before.lateMinutes : 0;
    const duty = e.duty ? Math.round(e.duty * 60) : null;
    await run(`INSERT INTO payroll_attendance_days ("companyId", "employeeId", "workDate", code, "overtimeMinutes", "lateMinutes", "dutyMinutes", "restDay", "isManual", "originalCode", note, "editedById", "editedAt")
      VALUES (:companyId, :employeeId, :date, :code, :overtime, :late, :duty, :rest, true, :original, :note, :userId, now())
      ON CONFLICT ("employeeId", "workDate") DO UPDATE SET code = EXCLUDED.code, "overtimeMinutes" = EXCLUDED."overtimeMinutes", "lateMinutes" = EXCLUDED."lateMinutes",
        "dutyMinutes" = COALESCE(payroll_attendance_days."dutyMinutes", EXCLUDED."dutyMinutes"), "isManual" = true, "originalCode" = EXCLUDED."originalCode", note = EXCLUDED.note, "editedById" = EXCLUDED."editedById", "editedAt" = now(), "updatedAt" = now()`,
    { companyId, employeeId, date, code, overtime, late, duty, rest: code === 'R', original, note: note || null, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_ATTENDANCE_DAY_EDITED', entityType: 'PayrollAttendanceDay', entityId: employeeId, before: { date, ...(before || {}) }, after: { date, code, overtimeMinutes: overtime, note: note || null } }, { transaction });
  });
  return { employeeId, date, day: await dayRow(companyId, employeeId, date) };
}

/** Gives a hand-set day back to the machine: it is worked out again from the punches. */
async function resetDay(req, employeeId, date) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await employeeOr404(companyId, employeeId, transaction);
    const gone = await q('DELETE FROM payroll_attendance_days WHERE "companyId" = :companyId AND "employeeId" = :employeeId AND "workDate" = :date AND "isManual" RETURNING id', { companyId, employeeId, date }, transaction);
    if (!gone.length) throw AppError.rule('NOT_MANUAL', 'This day was not set by hand');
    await processRange(companyId, { from: date, to: date, employeeIds: [employeeId] }, transaction);
    await audit.log(req, { action: 'PAYROLL_ATTENDANCE_DAY_RESET', entityType: 'PayrollAttendanceDay', entityId: employeeId, after: { date } }, { transaction });
  });
  return { employeeId, date, day: await dayRow(companyId, employeeId, date) };
}

module.exports = { preview, importRows, fetchFromApi, process, processRange, overview, punches, unmapped, batches, undoBatch, devices, updateDevice, days, summary, daily, editDay, resetDay, CODES, loadMonth, totalsOf, employeeJson, dayJson, monthBounds, DAY_COLS, employeeOr404 };
