// Weaving Production Control (service WEAVING_PRODUCTION). One register per Weaving department (Sulzer, Airjet ...), every loom of the department in it.
//   WEAVERS   the weaver attendance of the looms (it is NOT the payroll attendance): per day and shift (A / B / C) the weavers who work and the looms given to each one.
//             The employees come from Payroll: confirmed employees whose payroll department is Weaving (the name has "weav" in it).
//   UNITS     per day, shift and loom the units from the loom counter (1 unit = 1,000 picks) and the K-ID (the loom beam entry that was running on the loom that day).
//             The cloth made follows from the Loom Pick of the K-ID: metres = units x 1000 / (pick x 39.3701)   (utils/loomUnits.js).
//   PERIODS   15 day periods (1-15, 16-end of month) with the days, the totals and the problems.
//   Uploads   weaver attendance + looms and units can be uploaded as CSV (or the same rows as JSON); every valid row is saved, the others are reported with their line.
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today, isRealDate } = require('../utils/dates');
const { unitsToMeters } = require('../utils/loomUnits');
const csv = require('../utils/csvRows');
const audit = require('./auditService');

const SHIFTS = ['A', 'B', 'C'];
const SHIFT_LIST = SHIFTS.map((code) => ({ code, text: `Shift ${code}` }));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const n1 = (v) => Math.round(Number(v) * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// ---- dates and periods ----
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function periodOf(date) {
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7)); const d = Number(date.slice(8, 10));
  const from = `${y}-${pad(m)}-${d <= 15 ? '01' : '16'}`;
  const to = `${y}-${pad(m)}-${d <= 15 ? '15' : pad(lastDay(y, m))}`;
  return { from, to, label: `${from.slice(8)}-${to.slice(8)} ${MONTHS[m - 1]}-${String(y).slice(2)}` };
}
function datesBetween(from, to) {
  const out = []; const d = new Date(`${from}T00:00:00Z`); const end = new Date(`${to}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const previousPeriodStart = (from) => { const y = Number(from.slice(0, 4)); const m = Number(from.slice(5, 7)); return from.endsWith('-16') ? `${y}-${pad(m)}-01` : (m === 1 ? `${y - 1}-12-16` : `${y}-${pad(m - 1)}-16`); };
const notFuture = (date) => { if (date > today()) throw AppError.rule('FUTURE_DATE', 'This date has not come yet', { field: 'date' }); };

async function department(companyId, departmentId, transaction) {
  const [d] = await q('SELECT id, code, name FROM weaving_departments WHERE id = :departmentId AND "companyId" = :companyId AND "deletedAt" IS NULL', { departmentId, companyId }, transaction);
  if (!d) throw AppError.rule('UNKNOWN_DEPARTMENT', 'This department does not exist', { field: 'departmentId' });
  return d;
}

const WEAVER_DEPT = "d.name ILIKE '%weav%'";
/** The employees who may work on the looms on `date`: confirmed, working that day, payroll department Weaving. */
const EMP_SQL = `SELECT e.id, e.code, e.name, d.name AS department FROM payroll_employees e JOIN payroll_departments d ON d.id = e."departmentId"
  WHERE e."companyId" = :companyId AND e.status = 'CONFIRMED' AND e."joiningDate" <= :date AND (e."leavingDate" IS NULL OR e."leavingDate" >= :date) AND ${WEAVER_DEPT}`;
const empJson = (r) => ({ id: r.id, code: r.code, name: r.name });

// ---- the form data ----
async function formData(req) {
  const departments = await q(`SELECT d.id, d.code, d.name, (SELECT COUNT(*)::int FROM looms l WHERE l."departmentId" = d.id AND l."deletedAt" IS NULL AND l."isActive") AS looms
    FROM weaving_departments d WHERE d."companyId" = :companyId AND d."deletedAt" IS NULL AND d."isActive" ORDER BY d.name`, { companyId: req.user.companyId });
  return { date: today(), shifts: SHIFT_LIST, departments,
    units: { perUnitPicks: 1000, text: '1 unit = 1,000 picks of the loom counter; metres = units x 1000 / (loom pick x 39.3701)' } };
}

// ---- loom helpers ----
async function loomsOf(companyId, departmentId, transaction) {
  return q('SELECT id, "loomNo", "isActive" FROM looms WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL', { companyId, departmentId }, transaction);
}
/** The K-ID (confirmed loom beam entry) that was running on each loom of the department on `date`. */
async function entriesOn(companyId, departmentId, date, transaction) {
  const rows = await q(`SELECT DISTINCT ON (e."loomId") e.id, e."kId", e."loomId", e."loomPick" FROM loom_entries e JOIN looms l ON l.id = e."loomId"
    WHERE e."companyId" = :companyId AND l."departmentId" = :departmentId AND e."isConfirmed" AND e."startDate" <= :date AND (e."endDate" IS NULL OR e."endDate" >= :date)
    ORDER BY e."loomId", e."startDate" DESC, e."kId" DESC`, { companyId, departmentId, date }, transaction);
  return new Map(rows.map((r) => [r.loomId, r]));
}

// ---- the weavers of a day ----
async function weaversOn(companyId, departmentId, date, transaction) {
  const rows = await q(`SELECT w.id, w.shift, e.id AS "employeeId", e.code, e.name FROM production_weavers w JOIN payroll_employees e ON e.id = w."employeeId"
    WHERE w."companyId" = :companyId AND w."departmentId" = :departmentId AND w."workDate" = :date ORDER BY e.name`, { companyId, departmentId, date }, transaction);
  const looms = rows.length ? await q('SELECT wl."weaverId", l.id, l."loomNo" FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId" WHERE wl."weaverId" IN (:ids)', { ids: rows.map((r) => r.id) }, transaction) : [];
  return rows.map((r) => {
    const mine = looms.filter((l) => l.weaverId === r.id).sort((a, b) => natural(a.loomNo, b.loomNo));
    return { id: r.id, shift: r.shift, employee: { id: r.employeeId, code: r.code, name: r.name }, looms: mine.map((l) => ({ id: l.id, loomNo: l.loomNo })), loomsText: mine.map((l) => l.loomNo).join(', '), loomCount: mine.length };
  });
}

async function weavers(req, { departmentId, date }, transaction) {
  const { companyId } = req.user;
  const dept = await department(companyId, departmentId, transaction);
  const all = await weaversOn(companyId, departmentId, date, transaction);
  const shifts = {}; for (const s of SHIFTS) { const list = all.filter((w) => w.shift === s); shifts[s] = { shift: s, text: `Shift ${s}`, weavers: list, weaverCount: list.length, loomCount: list.reduce((t, w) => t + w.loomCount, 0) }; }
  const doubled = new Map();
  for (const w of all) doubled.set(w.employee.id, [...(doubled.get(w.employee.id) || []), w.shift]);
  const entries = await entriesOn(companyId, departmentId, date, transaction);
  const given = new Set(all.flatMap((w) => w.looms.map((l) => l.id)));
  const loomList = (await loomsOf(companyId, departmentId, transaction)).filter((l) => entries.has(l.id) || given.has(l.id)).sort((a, b) => natural(a.loomNo, b.loomNo))
    .map((l) => ({ id: l.id, loomNo: l.loomNo, kId: entries.has(l.id) ? entries.get(l.id).kId : null }));
  return { date, department: dept, looms: loomList, shifts, totals: { weavers: all.length, looms: all.reduce((t, w) => t + w.loomCount, 0) },
    inTwoShifts: [...doubled.entries()].filter(([, s]) => s.length > 1).map(([employeeId, s]) => ({ employeeId, shifts: s })) };
}

/** The "List of employees" picker: the weaving employees working on `date`, with the shifts they already have that day. */
async function employees(req, { departmentId, date, search }) {
  const { companyId } = req.user;
  await department(companyId, departmentId);
  const rows = await q(`${EMP_SQL} ORDER BY e.name`, { companyId, date });
  const have = await q('SELECT "employeeId", shift FROM production_weavers WHERE "companyId" = :companyId AND "workDate" = :date', { companyId, date });
  const s = search ? search.trim().toLowerCase() : '';
  const data = rows.filter((r) => !s || r.name.toLowerCase().includes(s) || String(r.code) === s).map((r) => ({ id: r.id, code: r.code, name: r.name, department: r.department, shifts: have.filter((h) => h.employeeId === r.id).map((h) => h.shift) }));
  return { data, total: data.length };
}

async function addWeavers(req, { departmentId, date, shift, employeeIds }) {
  const { companyId } = req.user;
  notFuture(date);
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    const ok = await q(`${EMP_SQL} AND e.id IN (:ids)`, { companyId, date, ids: employeeIds }, transaction);
    const bad = employeeIds.filter((id) => !ok.find((e) => e.id === id));
    if (bad.length) throw AppError.rule('NOT_A_WEAVER', 'These employees are not confirmed weaving employees working on this date', { employeeIds: bad });
    let added = 0;
    for (const e of ok) {
      const [have] = await q('SELECT id FROM production_weavers WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "workDate" = :date AND shift = :shift AND "employeeId" = :employeeId', { companyId, departmentId, date, shift, employeeId: e.id }, transaction);
      if (have) continue;
      await exec('INSERT INTO production_weavers (id, "companyId", "departmentId", "workDate", shift, "employeeId", "createdById") VALUES (:id, :companyId, :departmentId, :date, :shift, :employeeId, :userId)',
        { id: crypto.randomUUID(), companyId, departmentId, date, shift, employeeId: e.id, userId: req.user.id }, transaction);
      added += 1;
    }
    await audit.log(req, { action: 'PRODUCTION_WEAVERS_ADDED', entityType: 'ProductionWeaver', entityId: departmentId, after: { date, shift, added } }, { transaction });
    return { added, ...(await weaversPayload(req, departmentId, date, transaction)) };
  });
}
const weaversPayload = (req, departmentId, date, transaction) => weavers(req, { departmentId, date }, transaction);

async function setLooms(req, id, { loomIds, move }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const [w] = await q('SELECT w.*, to_char(w."workDate", \'YYYY-MM-DD\') AS day FROM production_weavers w WHERE w.id = :id AND w."companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
    if (!w) throw AppError.notFound('Weaver');
    const ids = [...new Set(loomIds)];
    const looms = ids.length ? await q('SELECT id, "loomNo" FROM looms WHERE id IN (:ids) AND "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL', { ids, companyId, departmentId: w.departmentId }, transaction) : [];
    if (looms.length !== ids.length) throw AppError.rule('UNKNOWN_LOOM', 'A loom does not exist in this department', { field: 'loomIds' });
    if (ids.length) {
      const running = await entriesOn(companyId, w.departmentId, w.day, transaction);
      const had = new Set((await q('SELECT "loomId" FROM production_weaver_looms WHERE "weaverId" = :id', { id }, transaction)).map((x) => x.loomId));
      const empty = looms.filter((l) => !running.has(l.id) && !had.has(l.id));
      if (empty.length) throw AppError.rule('LOOM_EMPTY', `Loom ${empty.map((l) => l.loomNo).join(', ')} has no beam running on ${w.day}`, { looms: empty.map((l) => ({ loomId: l.id, loomNo: l.loomNo })) });
      const taken = await q(`SELECT wl.id, wl."loomId", l."loomNo", e.name FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId" JOIN production_weavers pw ON pw.id = wl."weaverId" JOIN payroll_employees e ON e.id = pw."employeeId"
        WHERE wl."companyId" = :companyId AND wl."workDate" = :day AND wl.shift = :shift AND wl."loomId" IN (:ids) AND wl."weaverId" <> :id`, { companyId, day: w.day, shift: w.shift, ids, id }, transaction);
      if (taken.length && !move) throw AppError.rule('LOOM_TAKEN', `${taken.map((t) => `Loom ${t.loomNo} (${t.name})`).join(', ')} already ${taken.length > 1 ? 'have' : 'has'} a weaver in shift ${w.shift}`, { looms: taken.map((t) => ({ loomId: t.loomId, loomNo: t.loomNo, weaver: t.name })) });
      if (taken.length) await exec('DELETE FROM production_weaver_looms WHERE id IN (:ids)', { ids: taken.map((t) => t.id) }, transaction);
    }
    await exec('DELETE FROM production_weaver_looms WHERE "weaverId" = :id', { id }, transaction);
    for (const l of looms) await exec('INSERT INTO production_weaver_looms (id, "weaverId", "companyId", "workDate", shift, "loomId") VALUES (:id, :weaverId, :companyId, :day, :shift, :loomId)', { id: crypto.randomUUID(), weaverId: id, companyId, day: w.day, shift: w.shift, loomId: l.id }, transaction);
    await audit.log(req, { action: 'PRODUCTION_WEAVER_LOOMS_SET', entityType: 'ProductionWeaver', entityId: id, after: { date: w.day, shift: w.shift, looms: looms.map((l) => l.loomNo) } }, { transaction });
    return (await weaversOn(companyId, w.departmentId, w.day, transaction)).find((x) => x.id === id);
  });
}

async function removeWeavers(req, { ids }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const rows = await q('SELECT id FROM production_weavers WHERE id IN (:ids) AND "companyId" = :companyId', { ids, companyId }, transaction);
    if (rows.length) await exec('DELETE FROM production_weavers WHERE id IN (:ids)', { ids: rows.map((r) => r.id) }, transaction);
    await audit.log(req, { action: 'PRODUCTION_WEAVERS_REMOVED', entityType: 'ProductionWeaver', entityId: null, after: { removed: rows.length } }, { transaction });
    return { removed: rows.length };
  });
}

/** Copy the weavers (and their looms) of one day to another day, for the shifts that have no weavers yet on the target day. */
async function copyWeavers(req, { departmentId, fromDate, toDate }) {
  const { companyId } = req.user;
  notFuture(toDate);
  if (fromDate === toDate) throw AppError.rule('SAME_DATE', 'Pick another day to copy from', { field: 'fromDate' });
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    const src = await weaversOn(companyId, departmentId, fromDate, transaction);
    if (!src.length) throw AppError.rule('NOTHING_TO_COPY', `There are no weavers on ${fromDate}`, { field: 'fromDate' });
    const have = new Set((await weaversOn(companyId, departmentId, toDate, transaction)).map((w) => w.shift));
    const okIds = new Set((await q(`${EMP_SQL}`, { companyId, date: toDate }, transaction)).map((e) => e.id));
    const copied = { A: 0, B: 0, C: 0 }; const skippedShifts = [...new Set(src.map((w) => w.shift))].filter((s) => have.has(s)); const left = []; const emptyLooms = new Set();
    const running = await entriesOn(companyId, departmentId, toDate, transaction); // only looms with a running beam on the target day
    for (const w of src.filter((x) => !have.has(x.shift))) {
      if (!okIds.has(w.employee.id)) { left.push(w.employee.name); continue; }
      const id = crypto.randomUUID();
      await exec('INSERT INTO production_weavers (id, "companyId", "departmentId", "workDate", shift, "employeeId", "createdById") VALUES (:id, :companyId, :departmentId, :toDate, :shift, :employeeId, :userId)', { id, companyId, departmentId, toDate, shift: w.shift, employeeId: w.employee.id, userId: req.user.id }, transaction);
      for (const l of w.looms) {
        if (!running.has(l.id)) { emptyLooms.add(l.loomNo); continue; }
        await exec('INSERT INTO production_weaver_looms (id, "weaverId", "companyId", "workDate", shift, "loomId") VALUES (:id, :weaverId, :companyId, :toDate, :shift, :loomId)', { id: crypto.randomUUID(), weaverId: id, companyId, toDate, shift: w.shift, loomId: l.id }, transaction);
      }
      copied[w.shift] += 1;
    }
    await audit.log(req, { action: 'PRODUCTION_WEAVERS_COPIED', entityType: 'ProductionWeaver', entityId: departmentId, after: { fromDate, toDate, copied } }, { transaction });
    return { copied, skippedShifts, notWorking: left, emptyLooms: [...emptyLooms].sort(natural), ...(await weavers(req, { departmentId, date: toDate }, transaction)) };
  });
}

// ---- the units of a day ----
async function upsertUnits(req, { departmentId, date, loomId, shift, units, entry }, transaction) {
  const { companyId } = req.user;
  if (units === null || units === undefined || units === '') {
    await exec('DELETE FROM production_units WHERE "companyId" = :companyId AND "workDate" = :date AND shift = :shift AND "loomId" = :loomId', { companyId, date, shift, loomId }, transaction);
    return;
  }
  await exec(`INSERT INTO production_units (id, "companyId", "departmentId", "workDate", shift, "loomId", units, "entryId", "createdById") VALUES (:id, :companyId, :departmentId, :date, :shift, :loomId, :units, :entryId, :userId)
    ON CONFLICT ("companyId", "workDate", shift, "loomId") DO UPDATE SET units = EXCLUDED.units, "entryId" = EXCLUDED."entryId", "departmentId" = EXCLUDED."departmentId", "updatedAt" = now()`,
  { id: crypto.randomUUID(), companyId, departmentId, date, shift, loomId, units, entryId: entry ? entry.id : null, userId: req.user.id }, transaction);
}

async function day(req, { departmentId, date }, transaction) {
  const { companyId } = req.user;
  const dept = await department(companyId, departmentId, transaction);
  const looms = await loomsOf(companyId, departmentId, transaction);
  const units = await q('SELECT "loomId", shift, units FROM production_units WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "workDate" = :date', { companyId, departmentId, date }, transaction);
  const entries = await entriesOn(companyId, departmentId, date, transaction);
  const ws = await weaversOn(companyId, departmentId, date, transaction);
  const owner = new Map(); // loomId|shift -> weaver
  for (const w of ws) for (const l of w.looms) owner.set(`${l.id}|${w.shift}`, w);
  const rows = looms.filter((l) => units.some((u) => u.loomId === l.id) || (l.isActive && (entries.has(l.id) || ws.some((w) => w.looms.some((x) => x.id === l.id))))).sort((a, b) => natural(a.loomNo, b.loomNo)).map((l) => {
    const e = entries.get(l.id);
    const shifts = {};
    let total = 0;
    for (const s of SHIFTS) {
      const u = units.find((x) => x.loomId === l.id && x.shift === s);
      const w = owner.get(`${l.id}|${s}`);
      if (u) total += Number(u.units);
      shifts[s] = { weaver: w ? { ...w.employee, weaverId: w.id } : null, units: u ? Number(u.units) : null, meters: u && e ? unitsToMeters(u.units, e.loomPick) : null };
    }
    return { loomId: l.id, loomNo: l.loomNo, kId: e ? e.kId : null, entryId: e ? e.id : null, pick: e ? e.loomPick : null, shifts, totalUnits: n1(total),
      totalMeters: e ? unitsToMeters(total, e.loomPick) : null };
  });
  const totals = { A: 0, B: 0, C: 0, total: 0 };
  for (const r of rows) for (const s of SHIFTS) { totals[s] += r.shifts[s].units || 0; }
  for (const s of SHIFTS) totals[s] = n1(totals[s]);
  totals.total = n1(totals.A + totals.B + totals.C);
  const check = checkRows(rows, ws);
  return { date, weekday: DAYS[weekday(date)], department: dept, loomCount: rows.length, rows, totals, weaverCount: ws.length, check: { problems: check.filter((c) => c.level === 'PROBLEM').length, warnings: check.filter((c) => c.level === 'WARNING').length, items: check } };
}

/** The checks of a day: problems (units with no weaver, a weaver in two shifts) and warnings (units on a loom with no K-ID, a weaver without looms). */
function checkRows(rows, ws) {
  const out = [];
  for (const r of rows) {
    for (const s of SHIFTS) {
      const c = r.shifts[s];
      if (c.units > 0 && !c.weaver) out.push({ level: 'PROBLEM', code: 'UNITS_NO_WEAVER', loomNo: r.loomNo, shift: s, message: `Loom ${r.loomNo} shift ${s}: ${c.units} units produced but no weaver assigned` });
      if (c.units > 0 && !r.kId) out.push({ level: 'WARNING', code: 'UNITS_NO_KID', loomNo: r.loomNo, shift: s, message: `Loom ${r.loomNo} shift ${s}: ${c.units} units but no running K-ID on this loom` });
    }
  }
  const byEmp = new Map();
  for (const w of ws) { const e = byEmp.get(w.employee.id) || { employee: w.employee, roster: new Set(), assigned: new Set() }; e.roster.add(w.shift); if (w.loomCount) e.assigned.add(w.shift); byEmp.set(w.employee.id, e); }
  for (const e of byEmp.values()) {
    const label = `${e.employee.name} (${e.employee.code})`;
    if (e.assigned.size > 1) out.push({ level: 'PROBLEM', code: 'WEAVER_LOOMS_TWO_SHIFTS', employee: e.employee, shifts: [...e.assigned].sort(), message: `${label} is assigned in shifts ${[...e.assigned].sort().join(', ')} on the same day` });
  }
  for (const e of byEmp.values()) {
    const label = `${e.employee.name} (${e.employee.code})`;
    if (e.roster.size > 1) out.push({ level: 'PROBLEM', code: 'WEAVER_TWO_SHIFTS', employee: e.employee, shifts: [...e.roster].sort(), message: `${label} is on the roster of more than one shift (${[...e.roster].sort().join(', ')})` });
  }
  for (const w of ws) if (!w.loomCount) out.push({ level: 'WARNING', code: 'WEAVER_NO_LOOMS', employee: w.employee, shift: w.shift, message: `${w.employee.name} (${w.employee.code}) is in shift ${w.shift} but has no looms` });
  return out;
}

async function saveDay(req, { departmentId, date, rows }) {
  const { companyId } = req.user;
  notFuture(date);
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    const looms = new Map((await loomsOf(companyId, departmentId, transaction)).map((l) => [l.id, l]));
    const entries = await entriesOn(companyId, departmentId, date, transaction);
    for (const [i, r] of rows.entries()) {
      if (!looms.has(r.loomId)) throw AppError.rule('UNKNOWN_LOOM', 'A loom does not belong to this department', { line: i + 1, loomId: r.loomId });
      await upsertUnits(req, { departmentId, date, loomId: r.loomId, shift: r.shift, units: r.units, entry: entries.get(r.loomId) }, transaction);
    }
    await audit.log(req, { action: 'PRODUCTION_UNITS_SAVED', entityType: 'ProductionUnits', entityId: departmentId, after: { date, rows: rows.length } }, { transaction });
    return day(req, { departmentId, date }, transaction);
  });
}

/** "Delete ticked": the units of the ticked looms of the day (all shifts, or the shift given). */
async function clearDay(req, { departmentId, date, loomIds, shift }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    await exec(`DELETE FROM production_units WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "workDate" = :date AND "loomId" IN (:loomIds) ${shift ? 'AND shift = :shift' : ''}`, { companyId, departmentId, date, loomIds, shift: shift || null }, transaction);
    await audit.log(req, { action: 'PRODUCTION_UNITS_CLEARED', entityType: 'ProductionUnits', entityId: departmentId, after: { date, looms: loomIds.length, shift: shift || null } }, { transaction });
    return day(req, { departmentId, date }, transaction);
  });
}

const check = async (req, p) => (await day(req, p)).check;

// ---- periods ----
async function periods(req, { departmentId, limit }) {
  const { companyId } = req.user;
  await department(companyId, departmentId);
  const [first] = await q(`SELECT LEAST((SELECT MIN("workDate") FROM production_units WHERE "companyId" = :companyId AND "departmentId" = :departmentId),
    (SELECT MIN("workDate") FROM production_weavers WHERE "companyId" = :companyId AND "departmentId" = :departmentId))::text AS d`, { companyId, departmentId });
  const now = periodOf(today());
  const startFrom = first.d ? periodOf(first.d).from : now.from;
  const sums = await q(`SELECT (CASE WHEN extract(day FROM "workDate") <= 15 THEN date_trunc('month', "workDate")::date ELSE date_trunc('month', "workDate")::date + 15 END)::text AS pf, SUM(units) AS total, COUNT(DISTINCT "workDate") FILTER (WHERE units > 0)::int AS days
    FROM production_units WHERE "companyId" = :companyId AND "departmentId" = :departmentId GROUP BY 1`, { companyId, departmentId });
  const data = [];
  for (let from = now.from; from >= startFrom && data.length < limit; from = previousPeriodStart(from)) {
    const p = periodOf(from); const s = sums.find((x) => x.pf === from);
    data.push({ from: p.from, to: p.to, label: p.label, days: datesBetween(p.from, p.to).length, daysWithUnits: s ? s.days : 0, totalUnits: s ? n1(s.total) : 0, isCurrent: p.from === now.from });
  }
  return { data, total: data.length };
}

async function period(req, { departmentId, from }) {
  const { companyId } = req.user;
  const dept = await department(companyId, departmentId);
  const p = periodOf(from);
  if (p.from !== from) throw AppError.rule('BAD_PERIOD', 'A period starts on the 1st or the 16th of a month', { field: 'from' });
  const r = { companyId, departmentId, from: p.from, to: p.to };
  const units = await q('SELECT "workDate"::text AS d, shift, SUM(units) AS units, COUNT(*)::int AS looms FROM production_units WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "workDate" BETWEEN :from AND :to GROUP BY 1, 2', r);
  const withWeaver = await q('SELECT wl."workDate"::text AS d, wl.shift, COUNT(DISTINCT wl."loomId")::int AS looms FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId" WHERE wl."companyId" = :companyId AND l."departmentId" = :departmentId AND wl."workDate" BETWEEN :from AND :to GROUP BY 1, 2', r);
  const noWeaverSql = `FROM production_units u JOIN looms l ON l.id = u."loomId" WHERE u."companyId" = :companyId AND u."departmentId" = :departmentId AND u."workDate" BETWEEN :from AND :to AND u.units > 0
    AND NOT EXISTS (SELECT 1 FROM production_weaver_looms wl WHERE wl."companyId" = u."companyId" AND wl."workDate" = u."workDate" AND wl.shift = u.shift AND wl."loomId" = u."loomId")`;
  const [{ n: noWeaverCount }] = await q(`SELECT COUNT(*)::int AS n ${noWeaverSql}`, r);
  const noWeaver = await q(`SELECT u."workDate"::text AS date, u.shift, l."loomNo", u.units ${noWeaverSql} ORDER BY u."workDate", u.shift LIMIT 500`, r);
  const days = datesBetween(p.from, p.to).map((date) => {
    const shifts = {}; let total = 0; let registerLooms = 0;
    for (const s of SHIFTS) {
      const u = units.find((x) => x.d === date && x.shift === s);
      const w = withWeaver.find((x) => x.d === date && x.shift === s);
      shifts[s] = { units: u ? n1(u.units) : 0, looms: w ? w.looms : 0, loomRows: u ? u.looms : 0 };
      total += shifts[s].units; registerLooms = Math.max(registerLooms, shifts[s].loomRows);
    }
    for (const s of SHIFTS) shifts[s].short = registerLooms > 0 && shifts[s].looms < registerLooms;
    return { date, weekday: DAYS[weekday(date)], isSunday: weekday(date) === 0, shifts, registerLooms, totalUnits: n1(total), hasUnits: total > 0 };
  });
  const shiftTotals = {}; for (const s of SHIFTS) shiftTotals[s] = n1(days.reduce((t, d) => t + d.shifts[s].units, 0));
  const totalUnits = n1(days.reduce((t, d) => t + d.totalUnits, 0));
  const worked = days.filter((d) => d.hasUnits);
  const best = worked.reduce((b, d) => (!b || d.totalUnits > b.totalUnits ? d : b), null);
  return { from: p.from, to: p.to, label: p.label, department: dept, dayCount: days.length, days, totalUnits, shiftTotals,
    daysWithUnits: worked.length, daysWithoutUnits: days.length - worked.length, averagePerDay: worked.length ? n1(totalUnits / worked.length) : 0,
    bestDay: best ? { date: best.date, weekday: best.weekday, units: best.totalUnits } : null, noWeaver: { count: noWeaverCount, items: noWeaver } };
}

// ---- CSV: samples, export, import ----
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const sampleWeavers = () => ({ fileName: 'weaver-attendance-sample.csv', text: 'date,shift,employee_id,looms\n2026-11-16,A,129,1 2 3 4 5 6\n2026-11-16,A,261,7 8\n2026-11-16,B,28,1 2 3 4 5 6\n2026-11-16,C,110,1 2 3 4 5 6\n' });
const sampleUnits = () => ({ fileName: 'units-sample.csv', text: 'date,shift,loom_no,units,k_id\n2026-11-16,A,01,79,338\n2026-11-16,B,01,96,338\n2026-11-16,C,01,107,338\n2026-11-16,A,02,91,\n' });
async function dayCsv(req, p) {
  const d = await day(req, p);
  const lines = ['date,shift,loom_no,weaver_id,weaver,units,k_id'];
  for (const r of d.rows) for (const s of SHIFTS) { const c = r.shifts[s]; lines.push([p.date, s, r.loomNo, c.weaver ? c.weaver.code : '', c.weaver ? c.weaver.name : '', c.units == null ? '' : c.units, r.kId || ''].map(cell).join(',')); }
  return { fileName: `units-${d.department.name}-${p.date}.csv`.replace(/\s+/g, '-'), text: `${lines.join('\n')}\n` };
}

const readInput = ({ csv: text, rows }) => {
  if (text !== undefined) return csv.parse(text);
  return csv.fromObjects(rows || []);
};
function parseDate(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isRealDate(`${m[1]}-${pad(m[2])}-${pad(m[3])}`) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return isRealDate(`${m[3]}-${pad(m[2])}-${pad(m[1])}`) ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  return null;
}
function parseShift(v) {
  const s = String(v || '').trim().toUpperCase().replace(/^SHIFT\s*/, '');
  if (SHIFTS.includes(s)) return s;
  return { 1: 'A', 2: 'B', 3: 'C' }[s] || null;
}
const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
const fail = (errors, r, message) => errors.push({ line: r.line, message });

/** Upload of units: date, shift, loom_no, units [, k_id]. The weaver comes from the day's weavers; the K-ID is found from the loom and the date (a k_id in the file must match it). */
async function importUnits(req, { departmentId, input }) {
  const { companyId } = req.user;
  const { headers, rows } = readInput(input);
  for (const need of [['date'], ['shift'], ['loomno', 'loom'], ['units', 'unit']]) if (!need.some((n) => headers.includes(n))) throw AppError.rule('BAD_FILE', `The file needs a "${need[0]}" column`, { missing: need[0], expected: 'date, shift, loom_no, units, k_id (optional)' });
  if (!rows.length) throw AppError.rule('BAD_FILE', 'The file has no rows');
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    const looms = new Map((await loomsOf(companyId, departmentId, transaction)).map((l) => [String(l.loomNo).toLowerCase(), l]));
    const entryCache = new Map();
    const errors = []; let saved = 0; const dates = new Set();
    for (const r of rows) {
      const date = parseDate(r.date || input.date); const shift = parseShift(r.shift);
      const loomNo = String(pick(r, 'loomno', 'loom')).trim(); const unitsRaw = pick(r, 'units', 'unit');
      if (!date) { fail(errors, r, `"${r.date}" is not a date (use 2026-11-16 or 16/11/2026)`); continue; }
      if (date > today()) { fail(errors, r, `${date} has not come yet`); continue; }
      if (!shift) { fail(errors, r, `"${r.shift}" is not a shift (A, B or C)`); continue; }
      const loom = looms.get(loomNo.toLowerCase()) || looms.get(loomNo.replace(/^0+/, '').toLowerCase()) || [...looms.values()].find((l) => String(l.loomNo).replace(/^0+/, '') === loomNo.replace(/^0+/, ''));
      if (!loom) { fail(errors, r, `Loom "${loomNo}" is not a loom of this department`); continue; }
      const units = unitsRaw === '' ? null : Number(unitsRaw);
      if (units !== null && (!Number.isFinite(units) || units < 0 || units > 99999999)) { fail(errors, r, `"${unitsRaw}" is not a valid number of units`); continue; }
      if (!entryCache.has(date)) entryCache.set(date, await entriesOn(companyId, departmentId, date, transaction));
      const entry = entryCache.get(date).get(loom.id);
      const k = pick(r, 'kid', 'k', 'kno');
      if (k !== '' && (!entry || String(entry.kId) !== String(Number(k)))) { fail(errors, r, entry ? `K-ID ${k} does not match the K-ID running on loom ${loom.loomNo} on ${date} (${entry.kId})` : `K-ID ${k} given but no K-ID is running on loom ${loom.loomNo} on ${date}`); continue; }
      if (!entry && units !== null) { fail(errors, r, `Loom ${loom.loomNo} has no beam running on ${date}`); continue; }
      await upsertUnits(req, { departmentId, date, loomId: loom.id, shift, units, entry }, transaction);
      saved += 1; dates.add(date);
    }
    await audit.log(req, { action: 'PRODUCTION_UNITS_IMPORTED', entityType: 'ProductionUnits', entityId: departmentId, after: { saved, errors: errors.length, dates: [...dates].sort() } }, { transaction });
    return { saved, skipped: errors.length, errors, dates: [...dates].sort(), rows: rows.length };
  });
}

/** Upload of the weaver attendance: date, shift, employee_id (the payroll employee ID) [, looms: "1 2 3" or "1;2;3"]. Rows of one weaver / shift / day are joined; the looms listed replace the weaver's looms. */
async function importWeavers(req, { departmentId, input }) {
  const { companyId } = req.user;
  const { headers, rows } = readInput(input);
  for (const need of [['date'], ['shift'], ['employeeid', 'empid', 'employee', 'id', 'code']]) if (!need.some((n) => headers.includes(n))) throw AppError.rule('BAD_FILE', `The file needs a "${need[0]}" column`, { missing: need[0], expected: 'date, shift, employee_id, looms (optional)' });
  if (!rows.length) throw AppError.rule('BAD_FILE', 'The file has no rows');
  return sequelize.transaction(async (transaction) => {
    await department(companyId, departmentId, transaction);
    const looms = await loomsOf(companyId, departmentId, transaction);
    const errors = []; const groups = new Map(); const entryCache = new Map();
    for (const r of rows) {
      const date = parseDate(r.date || input.date); const shift = parseShift(r.shift); const code = Number(pick(r, 'employeeid', 'empid', 'employee', 'id', 'code'));
      if (!date) { fail(errors, r, `"${r.date}" is not a date (use 2026-11-16 or 16/11/2026)`); continue; }
      if (date > today()) { fail(errors, r, `${date} has not come yet`); continue; }
      if (!shift) { fail(errors, r, `"${r.shift}" is not a shift (A, B or C)`); continue; }
      if (!Number.isInteger(code) || code <= 0) { fail(errors, r, 'The employee ID is not a number'); continue; }
      const nos = String(pick(r, 'looms', 'loom', 'loomno', 'loomnos')).split(/[\s;|,]+/).filter(Boolean);
      const found = []; let bad = null;
      for (const no of nos) {
        const l = looms.find((x) => String(x.loomNo).toLowerCase() === no.toLowerCase()) || looms.find((x) => String(x.loomNo).replace(/^0+/, '') === no.replace(/^0+/, ''));
        if (!l) { bad = no; break; }
        found.push(l);
      }
      if (bad) { fail(errors, r, `Loom "${bad}" is not a loom of this department`); continue; }
      if (found.length) {
        if (!entryCache.has(date)) entryCache.set(date, await entriesOn(companyId, departmentId, date, transaction));
        const empty = found.filter((l) => !entryCache.get(date).has(l.id));
        if (empty.length) { fail(errors, r, `Loom ${empty.map((l) => l.loomNo).join(', ')} has no beam running on ${date}`); continue; }
      }
      const key = `${date}|${shift}|${code}`;
      const g = groups.get(key) || { date, shift, code, looms: new Map(), line: r.line, hasLooms: false };
      for (const l of found) g.looms.set(l.id, l);
      if (found.length) g.hasLooms = true;
      groups.set(key, g);
    }
    let saved = 0; let withLooms = 0;
    for (const g of groups.values()) {
      const [emp] = await q(`${EMP_SQL} AND e.code = :code`, { companyId, date: g.date, code: g.code }, transaction);
      if (!emp) { errors.push({ line: g.line, message: `Employee ${g.code} is not a confirmed weaving employee working on ${g.date}` }); continue; }
      let [w] = await q('SELECT id FROM production_weavers WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "workDate" = :date AND shift = :shift AND "employeeId" = :employeeId', { companyId, departmentId, date: g.date, shift: g.shift, employeeId: emp.id }, transaction);
      if (!w) {
        w = { id: crypto.randomUUID() };
        await exec('INSERT INTO production_weavers (id, "companyId", "departmentId", "workDate", shift, "employeeId", "createdById") VALUES (:id, :companyId, :departmentId, :date, :shift, :employeeId, :userId)', { id: w.id, companyId, departmentId, date: g.date, shift: g.shift, employeeId: emp.id, userId: req.user.id }, transaction);
      }
      if (g.hasLooms) {
        const ids = [...g.looms.keys()];
        const taken = await q(`SELECT l."loomNo", e.name FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId" JOIN production_weavers pw ON pw.id = wl."weaverId" JOIN payroll_employees e ON e.id = pw."employeeId"
          WHERE wl."companyId" = :companyId AND wl."workDate" = :date AND wl.shift = :shift AND wl."loomId" IN (:ids) AND wl."weaverId" <> :id`, { companyId, date: g.date, shift: g.shift, ids, id: w.id }, transaction);
        if (taken.length) { errors.push({ line: g.line, message: `${taken.map((t) => `Loom ${t.loomNo} (${t.name})`).join(', ')} already ${taken.length > 1 ? 'have' : 'has'} a weaver in shift ${g.shift} on ${g.date}` }); continue; }
        await exec('DELETE FROM production_weaver_looms WHERE "weaverId" = :id', { id: w.id }, transaction);
        for (const l of g.looms.values()) await exec('INSERT INTO production_weaver_looms (id, "weaverId", "companyId", "workDate", shift, "loomId") VALUES (:id, :weaverId, :companyId, :date, :shift, :loomId)', { id: crypto.randomUUID(), weaverId: w.id, companyId, date: g.date, shift: g.shift, loomId: l.id }, transaction);
        withLooms += 1;
      }
      saved += 1;
    }
    await audit.log(req, { action: 'PRODUCTION_WEAVERS_IMPORTED', entityType: 'ProductionWeaver', entityId: departmentId, after: { saved, errors: errors.length } }, { transaction });
    return { saved, withLooms, skipped: errors.length, errors, rows: rows.length };
  });
}

/** The units of a loom beam entry (K-ID): the production register rows shown on the loom entry screen. */
async function entryRegister(req, entryId) {
  const { companyId } = req.user;
  const [e] = await q('SELECT e.id, e."kId", e."loomPick", l."loomNo" FROM loom_entries e JOIN looms l ON l.id = e."loomId" WHERE e.id = :entryId AND e."companyId" = :companyId', { entryId, companyId });
  if (!e) throw AppError.notFound('Loom beam entry');
  const rows = await q(`SELECT u."workDate"::text AS date, u.shift, u.units, pe.name AS weaver, pe.code AS "weaverCode" FROM production_units u
    LEFT JOIN production_weaver_looms wl ON wl."companyId" = u."companyId" AND wl."workDate" = u."workDate" AND wl.shift = u.shift AND wl."loomId" = u."loomId"
    LEFT JOIN production_weavers pw ON pw.id = wl."weaverId" LEFT JOIN payroll_employees pe ON pe.id = pw."employeeId"
    WHERE u."entryId" = :entryId ORDER BY u."workDate", u.shift`, { entryId });
  const total = rows.reduce((t, r) => t + Number(r.units), 0);
  return { entryId, kId: e.kId, loomNo: e.loomNo, pick: e.loomPick, totalUnits: n1(total), producedM: unitsToMeters(total, e.loomPick),
    data: rows.map((r) => ({ loomNo: e.loomNo, date: r.date, shift: r.shift, units: Number(r.units), meters: unitsToMeters(r.units, e.loomPick), kId: e.kId, weaver: r.weaver ? { name: r.weaver, code: r.weaverCode } : null })) };
}

module.exports = { SHIFTS, formData, periods, period, day, saveDay, clearDay, check, weavers, employees, addWeavers, setLooms, removeWeavers, copyWeavers, sampleWeavers, sampleUnits, dayCsv, importUnits, importWeavers, entryRegister };
