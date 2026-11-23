// Weaving Production Control > "Weaver wise & attendance billing" (service WEAVING_PRODUCTION). Read only, from the production register:
//   the weavers of each day / shift with their looms (production_weavers, production_weaver_looms) and the units of every loom shift (production_units).
// One 15 day period of one department:
//   * the weaver sheet: per weaver the shifts, the loom-shifts of his "6-loom" and "5-loom" shifts, the units by loom type (PU, P7100 ...), the total units and the stoppage
//   * the attendance of one weaver (day by day), the reconciliation with the entries, the loom-days with units but no weaver
//   * the sheet as PDF and Excel
// (the stoppage is the one of the production bill: see stoppages())
// Loom policy (per department): "looms per weaver" by loom number: ranges (loom 31 to 40 = 5 looms per weaver) and "all other looms" (6). The "N-loom" columns, the loom-shifts
// and the extra looms (looms a weaver runs above the looms per weaver of their group) follow it; past periods are re-grouped too. `stopBelowUnits`: a loom shift of a weaver with units
// below this (default 1 = no units at all) is a STOPPED loom. Bill rates (rate per day / shift, rate per unit of each loom type) are kept with the date they apply from (production_rates):
// a loom shift uses the rates in force on its date, so earlier periods keep the rates they had. Stoppage: see stoppages() (a loom of the weaver with no production in a shift is paid
// half the average units of his other looms in that shift, at the rate per unit of its own loom type).
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const { ZONE } = require('../utils/dates');
const audit = require('./auditService');
const { SHIFTS, periodOf, department, natural } = require('./weavingProductionService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const NO_TYPE = '';
const DEFAULT_LOOMS = 6;
const loomNumber = (no) => (/^\d+$/.test(String(no).trim()) ? Number(no) : null);
/** Looms per weaver of a loom: the range its number is in, else "all other looms". */
const perWeaverOf = (policy, loomNo) => {
  const n = loomNumber(loomNo);
  const r = n == null ? null : policy.ranges.find((x) => n >= x.from && n <= x.to);
  return r ? r.loomsPerWeaver : policy.otherLooms;
};
/** The rate per unit of a loom type that was in force on a date (0 when none was set yet). */
const rateAt = (policy, date, type) => {
  let v = null;
  for (const x of policy.versions) if (x.effectiveFrom <= date) v = x;
  return v ? Number(v.rates[type]) || 0 : 0;
};

async function policyOf(companyId, departmentId, transaction) {
  const [p] = await q('SELECT "defaultLooms", "stopBelowUnits", ranges FROM production_policies WHERE "companyId" = :companyId AND "departmentId" = :departmentId', { companyId, departmentId }, transaction);
  const versions = await q('SELECT "effectiveFrom"::text AS "effectiveFrom", "ratePerDay", rates FROM production_rates WHERE "companyId" = :companyId AND "departmentId" = :departmentId ORDER BY "effectiveFrom"', { companyId, departmentId }, transaction);
  return {
    otherLooms: p ? p.defaultLooms : DEFAULT_LOOMS, stopBelowUnits: p ? Number(p.stopBelowUnits) : 1,
    ranges: ((p && p.ranges) || []).map((r) => ({ from: Number(r.from), to: Number(r.to), loomsPerWeaver: Number(r.loomsPerWeaver) })).sort((a, b) => a.from - b.from),
    versions: versions.map((v) => ({ effectiveFrom: v.effectiveFrom, ratePerDay: v.ratePerDay == null ? null : Number(v.ratePerDay), rates: v.rates || {} })),
  };
}

/** GET /production/policy: the loom ranges, "all other looms", the rates in force today and the history of the rates (for the "Loom policy and rates" dialog). */
async function getPolicy(req, { departmentId }) {
  const { companyId } = req.user;
  const dept = await department(companyId, departmentId);
  const p = await policyOf(companyId, departmentId);
  const types = (await q('SELECT DISTINCT "loomType" FROM looms WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL AND "loomType" IS NOT NULL ORDER BY 1', { companyId, departmentId })).map((r) => r.loomType);
  const nowDate = new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
  const current = [...p.versions].reverse().find((v) => v.effectiveFrom <= nowDate) || null;
  return {
    department: dept, ranges: p.ranges, otherLooms: p.otherLooms, stopBelowUnits: p.stopBelowUnits,
    groups: [...new Set([...p.ranges.map((r) => r.loomsPerWeaver), p.otherLooms])].sort((a, b) => b - a),
    rates: { effectiveFrom: current ? current.effectiveFrom : null, ratePerDay: current ? current.ratePerDay : null,
      loomTypes: types.map((tp) => ({ loomType: tp, ratePerUnit: current && current.rates[tp] != null ? Number(current.rates[tp]) : null })) },
    rateHistory: p.versions,
  };
}

const checkRanges = (ranges) => {
  const list = [...ranges].sort((a, b) => a.from - b.from);
  for (const r of list) if (r.from > r.to) throw AppError.rule('BAD_RANGE', `Loom ${r.from} to ${r.to}: "from" is above "to"`, { field: 'ranges' });
  for (let i = 1; i < list.length; i += 1) if (list[i].from <= list[i - 1].to) throw AppError.rule('RANGE_OVERLAP', `The loom ranges ${list[i - 1].from}-${list[i - 1].to} and ${list[i].from}-${list[i].to} overlap`, { field: 'ranges' });
  return list;
};

async function setPolicy(req, { departmentId, ranges, otherLooms, stopBelowUnits, ratePerDay, rates, ratesFrom }) {
  const { companyId } = req.user;
  await department(companyId, departmentId);
  const before = await policyOf(companyId, departmentId);
  const nextRanges = ranges ? checkRanges(ranges) : before.ranges;
  const next = { otherLooms: otherLooms ?? before.otherLooms, stopBelowUnits: stopBelowUnits ?? before.stopBelowUnits, ranges: nextRanges };
  await sequelize.transaction(async (transaction) => {
    await exec(`INSERT INTO production_policies (id, "companyId", "departmentId", "defaultLooms", "stopBelowUnits", ranges, "updatedById", "updatedAt")
      VALUES (:id, :companyId, :departmentId, :otherLooms, :stopBelowUnits, :ranges::jsonb, :userId, now())
      ON CONFLICT ("companyId", "departmentId") DO UPDATE SET "defaultLooms" = :otherLooms, "stopBelowUnits" = :stopBelowUnits, ranges = :ranges::jsonb, "updatedById" = :userId, "updatedAt" = now()`,
    { id: crypto.randomUUID(), companyId, departmentId, otherLooms: next.otherLooms, stopBelowUnits: next.stopBelowUnits, ranges: JSON.stringify(next.ranges), userId: req.user.id }, transaction);
    if (ratePerDay !== undefined || rates !== undefined) {
      const from = ratesFrom || new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
      const last = [...before.versions].reverse().find((v) => v.effectiveFrom <= from) || before.versions[before.versions.length - 1] || null;
      const newRates = rates ? Object.fromEntries(Object.entries(rates).filter(([, v]) => v != null)) : (last ? last.rates : {});
      const perDay = ratePerDay !== undefined ? ratePerDay : (last ? last.ratePerDay : null);
      await exec(`INSERT INTO production_rates (id, "companyId", "departmentId", "effectiveFrom", "ratePerDay", rates, "updatedById", "updatedAt")
        VALUES (:id, :companyId, :departmentId, :from, :perDay, :rates::jsonb, :userId, now())
        ON CONFLICT ("companyId", "departmentId", "effectiveFrom") DO UPDATE SET "ratePerDay" = :perDay, rates = :rates::jsonb, "updatedById" = :userId, "updatedAt" = now()`,
      { id: crypto.randomUUID(), companyId, departmentId, from, perDay, rates: JSON.stringify(newRates), userId: req.user.id }, transaction);
    }
    await audit.log(req, { action: 'PRODUCTION_POLICY_SET', entityType: 'ProductionPolicy', entityId: departmentId, before, after: { ...next, ratePerDay: ratePerDay ?? null, rates: rates || null, ratesFrom: ratesFrom || null } }, { transaction });
  });
  return getPolicy(req, { departmentId });
}

// ---- the figures of a period ----
function bounds(from) {
  const p = periodOf(from);
  if (p.from !== from) throw AppError.rule('BAD_PERIOD', 'A period starts on the 1st or the 16th of a month', { field: 'from' });
  return p;
}

/** Everything the sheet, the attendance and the lists are made of: loom shifts with their weaver, the weaver shifts with their looms. */
async function gather(companyId, departmentId, p) {
  const rep = { companyId, departmentId, from: p.from, to: p.to };
  const units = await q(`SELECT u."workDate"::text AS d, u.shift, u."loomId", u.units::float AS units, l."loomNo", l."loomType" FROM production_units u JOIN looms l ON l.id = u."loomId"
    WHERE u."companyId" = :companyId AND u."departmentId" = :departmentId AND u."workDate" BETWEEN :from AND :to`, rep);
  const ws = await q(`SELECT pw.id, pw."workDate"::text AS d, pw.shift, pw."employeeId", e.code, e.name FROM production_weavers pw JOIN payroll_employees e ON e.id = pw."employeeId"
    WHERE pw."companyId" = :companyId AND pw."departmentId" = :departmentId AND pw."workDate" BETWEEN :from AND :to`, rep);
  const wl = await q(`SELECT wl."weaverId", wl."loomId", wl."workDate"::text AS d, wl.shift, l."loomNo", l."loomType" FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId"
    JOIN production_weavers pw ON pw.id = wl."weaverId" WHERE pw."companyId" = :companyId AND pw."departmentId" = :departmentId AND pw."workDate" BETWEEN :from AND :to`, rep);
  const looms = await q('SELECT id, code, "loomNo", "loomType" FROM looms WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL', rep);
  return { units, ws, wl, looms };
}

const labelOf = (code, name) => `${name} (${code})`;

/** The rate per day (shift) in force on a date (0 when none was set yet). */
const rateDayAt = (policy, date) => {
  let v = null;
  for (const x of policy.versions) if (x.effectiveFrom <= date) v = x;
  return v && v.ratePerDay != null ? Number(v.ratePerDay) : 0;
};

/**
 * The loom stoppage of a period: in a weaver shift a loom of the weaver with no production (no units cell, or units below `stopBelowUnits`) is a STOPPED loom; it is paid
 * half the average units of the weaver's other (running) looms in that shift, at the rate per unit of its own loom type. Nothing is paid when the weaver has no running loom in the shift.
 * One item per stopped loom shift, in the order of the detail list: weaver, date, shift, loom.
 */
function stoppages(g, policy) {
  const unitsAt = new Map(g.units.map((u) => [`${u.d}|${u.shift}|${u.loomId}`, u]));
  const byWeaver = new Map();
  for (const x of g.wl) byWeaver.set(x.weaverId, [...(byWeaver.get(x.weaverId) || []), x]);
  const items = [];
  for (const w of g.ws) {
    const info = (byWeaver.get(w.id) || []).map((x) => ({ x, u: unitsAt.get(`${w.d}|${w.shift}|${x.loomId}`) }));
    const running = info.filter((i) => i.u && i.u.units > 0 && i.u.units >= policy.stopBelowUnits);
    if (!running.length) continue;
    const avg = running.reduce((s, i) => s + i.u.units, 0) / running.length;
    for (const i of info) {
      if (running.includes(i)) continue;
      const type = i.x.loomType || NO_TYPE; const rate = rateAt(policy, w.d, type);
      items.push({ employeeId: w.employeeId, code: w.code, name: w.name, label: labelOf(w.code, w.name), date: w.d, shift: w.shift, loomId: i.x.loomId, loomNo: i.x.loomNo, type, runningLooms: running.length,
        avgUnits: avg, stoppageUnits: avg / 2, rate, amount: (avg / 2) * rate });
    }
  }
  return items.sort((a, b) => natural(a.name, b.name) || a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift) || natural(a.loomNo, b.loomNo));
}

/** The weaver sheet of a period (rows, totals, types, reconciliation, the loom-days without a weaver). */
async function sheet(req, { departmentId, from }) {
  const { companyId } = req.user;
  const p = bounds(from);
  const dept = await department(companyId, departmentId);
  const policy = await policyOf(companyId, departmentId);
  const g = await gather(companyId, departmentId, p);
  const typeOf = new Map(g.looms.map((l) => [l.id, l.loomType || NO_TYPE]));
  // the loom types in the order their first loom was made (the order of the columns)
  const types = [...new Set([...g.looms].sort((a, b) => a.code - b.code).map((l) => l.loomType).filter(Boolean))];
  const hasUntyped = g.units.some((u) => u.units > 0 && !(typeOf.get(u.loomId)));
  const typeKeys = hasUntyped ? [...types, NO_TYPE] : types;

  const weaverOf = new Map(); // d|shift|loomId -> weaver row (the weaver shift)
  const byId = new Map(g.ws.map((w) => [w.id, w]));
  for (const x of g.wl) weaverOf.set(`${x.d}|${x.shift}|${x.loomId}`, byId.get(x.weaverId));
  const unitsAt = new Map(g.units.map((u) => [`${u.d}|${u.shift}|${u.loomId}`, u]));

  const rows = new Map();
  const rowFor = (key, code, name, employeeId) => {
    if (!rows.has(key)) rows.set(key, { employeeId, code, name, label: employeeId ? labelOf(code, name) : 'NO WEAVER', noWeaver: !employeeId, shiftSet: new Set(), groups: {}, extra: 0, byType: {}, byShift: { A: 0, B: 0, C: 0 }, totalUnits: 0, stoppedLooms: 0, stoppageUnits: 0, stoppageAmount: 0 });
    return rows.get(key);
  };
  const NO_KEY = '__none__';
  // weaver shifts: every loom-shift goes to the column of its group (looms per weaver of the loom: 6-loom, 5-loom ...); looms above the group's number are extra looms
  const looms = new Map(); // weaverId -> [loom]
  for (const x of g.wl) looms.set(x.weaverId, [...(looms.get(x.weaverId) || []), x]);
  for (const w of g.ws) {
    const r = rowFor(w.employeeId, w.code, w.name, w.employeeId);
    r.shiftSet.add(`${w.d}|${w.shift}`);
    const perGroup = {};
    for (const x of looms.get(w.id) || []) { const gr = perWeaverOf(policy, x.loomNo); perGroup[gr] = (perGroup[gr] || 0) + 1; r.groups[gr] = (r.groups[gr] || 0) + 1; }
    for (const [gr, n] of Object.entries(perGroup)) r.extra += Math.max(0, n - Number(gr));
  }
  // the units
  const noWeaverDays = new Map(); // d|loomId -> { A, B, C }
  for (const u of g.units) {
    const w = weaverOf.get(`${u.d}|${u.shift}|${u.loomId}`);
    const type = typeOf.get(u.loomId);
    let r;
    if (w) r = rowFor(w.employeeId, w.code, w.name, w.employeeId);
    else if (u.units > 0) {
      r = rowFor(NO_KEY, null, null, null);
      const gr = perWeaverOf(policy, u.loomNo); r.groups[gr] = (r.groups[gr] || 0) + 1; // a loom shift with units and no weaver, in its group
      const k = `${u.d}|${u.loomId}`; const dd = noWeaverDays.get(k) || { date: u.d, loomId: u.loomId, loomNo: u.loomNo, A: null, B: null, C: null, missing: [] };
      dd.missing.push(u.shift); noWeaverDays.set(k, dd);
    } else continue;
    r.totalUnits += u.units; r.byType[type] = (r.byType[type] || 0) + u.units; r.byShift[u.shift] += u.units;
  }
  // stoppage (the same list as the production bill): a loom of a weaver with no production in a shift is paid half the average units of his other looms in that shift
  for (const s of stoppages(g, policy)) { const r = rowFor(s.employeeId, s.code, s.name, s.employeeId); r.stoppedLooms += 1; r.stoppageUnits += s.stoppageUnits; r.stoppageAmount += s.amount; }

  const groups = [...new Set([...policy.ranges.map((r) => r.loomsPerWeaver), policy.otherLooms])].sort((a, b) => b - a);
  const named = [...rows.values()].filter((r) => !r.noWeaver).sort((a, b) => natural(a.name, b.name));
  const none = rows.get(NO_KEY);
  const out = [...(none ? [none] : []), ...named].map((r) => ({
    employeeId: r.employeeId, code: r.code, name: r.name || 'NO WEAVER', label: r.label, noWeaver: r.noWeaver, shifts: r.shiftSet.size, loomShifts: Object.fromEntries(groups.map((gr) => [gr, r.groups[gr] || 0])), loomShifts6: r.groups[6] || 0, loomShifts5: r.groups[5] || 0, extraLooms: r.extra,
    unitsByType: Object.fromEntries(typeKeys.map((t) => [t || 'OTHER', n2(r.byType[t] || 0)])), totalUnits: n2(r.totalUnits),
    stoppedLooms: r.stoppedLooms, stoppageUnits: Math.round(r.stoppageUnits), stoppageAmount: Math.round(r.stoppageAmount),
  }));
  const sum = (k) => out.reduce((t, r) => t + (r[k] || 0), 0);
  const totals = { loomShifts: Object.fromEntries(groups.map((gr) => [gr, out.reduce((s, r) => s + (r.loomShifts[gr] || 0), 0)])), loomShifts6: sum('loomShifts6'), loomShifts5: sum('loomShifts5'), extraLooms: sum('extraLooms'), totalUnits: n2(sum('totalUnits')), stoppedLooms: sum('stoppedLooms'), stoppageUnits: sum('stoppageUnits'), stoppageAmount: sum('stoppageAmount'),
    unitsByType: Object.fromEntries(typeKeys.map((t) => [t || 'OTHER', n2(out.reduce((s, r) => s + (r.unitsByType[t || 'OTHER'] || 0), 0))])) };

  // the reconciliation: what the entries hold against what the sheet adds up to
  const entriesUnits = n2(g.units.reduce((t, u) => t + u.units, 0));
  const entryShift = (s) => n2(g.units.filter((u) => u.shift === s).reduce((t, u) => t + u.units, 0));
  const billShift = (s) => n2([...rows.values()].reduce((t, r) => t + r.byShift[s], 0));
  const namedUnits = n2(named.reduce((t, r) => t + r.totalUnits, 0));
  const noWeaverUnits = none ? n2(none.totalUnits) : 0;
  const typeSum = n2(Object.values(totals.unitsByType).reduce((t, v) => t + v, 0));
  const line = (label, entries, billing) => ({ label, entries, billing, diff: n2(entries - billing), ok: Math.abs(entries - billing) < 0.005 });
  const reconciliation = [
    line('Total units', entriesUnits, n2(totals.totalUnits)),
    ...SHIFTS.map((s) => line(`Shift ${s} units`, entryShift(s), billShift(s))),
    line(`${typeKeys.map((t) => t || 'Other').join(' + ')} loom units`, entriesUnits, typeSum),
    line('Loom-shifts with a weaver', g.wl.length, named.reduce((t, r) => t + [...Object.values(r.groups)].reduce((s, v) => s + v, 0), 0)),
    { label: 'Units to named weavers', entries: null, billing: namedUnits, diff: null, ok: null },
    { label: 'Units with no weaver', entries: null, billing: noWeaverUnits, diff: null, ok: noWeaverUnits === 0 },
  ];
  const ties = reconciliation.every((x) => x.ok !== false);
  // show all the units of the loom day (the shift that has no weaver is the one in `missing`)
  for (const d of noWeaverDays.values()) for (const u of g.units) if (u.d === d.date && u.loomId === d.loomId) d[u.shift] = u.units;
  const noWeaver = [...noWeaverDays.values()].sort((a, b) => a.date.localeCompare(b.date) || natural(a.loomNo, b.loomNo))
    .map((d) => ({ date: d.date, loomId: d.loomId, loomNo: d.loomNo, A: d.A, B: d.B, C: d.C, missing: d.missing.join(', ') }));
  return {
    department: dept, from: p.from, to: p.to, label: p.label, policy: { otherLooms: policy.otherLooms, ranges: policy.ranges, stopBelowUnits: policy.stopBelowUnits }, groups: groups.map((gr) => ({ looms: gr, label: `${gr}-LOOM` })), weavers: out.filter((r) => !r.noWeaver).length,
    types: typeKeys.map((t) => ({ key: t || 'OTHER', label: t || 'Other' })), rows: out, totals, reconciliation, ties,
    tieMessage: ties ? null : 'does not tie with the entries — see right', noWeaverList: { count: noWeaver.length, units: noWeaverUnits, items: noWeaver },
  };
}

/** The attendance of one weaver (payroll employee) in the period: day by day, with the looms, the units of each shift and the extra looms. */
async function attendance(req, { departmentId, from, employeeId }) {
  const { companyId } = req.user;
  const p = bounds(from);
  await department(companyId, departmentId);
  const policy = await policyOf(companyId, departmentId);
  const rep = { companyId, departmentId, from: p.from, to: p.to, employeeId };
  const loomRows = await q(`SELECT wl."weaverId", l."loomNo" FROM production_weaver_looms wl JOIN looms l ON l.id = wl."loomId" JOIN production_weavers pw ON pw.id = wl."weaverId"
    WHERE pw."companyId" = :companyId AND pw."departmentId" = :departmentId AND pw."employeeId" = :employeeId AND pw."workDate" BETWEEN :from AND :to`, rep);
  const [emp] = await q('SELECT id, code, name FROM payroll_employees WHERE id = :employeeId AND "companyId" = :companyId', rep);
  if (!emp) throw AppError.notFound('Employee');
  const shifts = await q(`SELECT pw.id, pw."workDate"::text AS d, pw.shift, (SELECT COUNT(*)::int FROM production_weaver_looms wl WHERE wl."weaverId" = pw.id) AS looms,
      COALESCE((SELECT SUM(u.units) FROM production_weaver_looms wl JOIN production_units u ON u."loomId" = wl."loomId" AND u."workDate" = wl."workDate" AND u.shift = wl.shift AND u."companyId" = wl."companyId" WHERE wl."weaverId" = pw.id), 0)::float AS units
    FROM production_weavers pw WHERE pw."companyId" = :companyId AND pw."departmentId" = :departmentId AND pw."employeeId" = :employeeId AND pw."workDate" BETWEEN :from AND :to ORDER BY pw."workDate", pw.shift`, rep);
  const extraOf = (weaverId) => { const per = {}; for (const x of loomRows) if (x.weaverId === weaverId) { const gr = perWeaverOf(policy, x.loomNo); per[gr] = (per[gr] || 0) + 1; } return Object.entries(per).reduce((t, [gr, n]) => t + Math.max(0, n - Number(gr)), 0); };
  const days = new Map();
  for (const s of shifts) {
    const d = days.get(s.d) || { date: s.d, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${s.d}T00:00:00Z`).getUTCDay()], looms: 0, A: null, B: null, C: null, units: 0, extra: 0 };
    d.looms += s.looms; d[s.shift] = (d[s.shift] || 0) + s.units; d.units += s.units; d.extra += extraOf(s.id);
    days.set(s.d, d);
  }
  const rows = [...days.values()].map((d) => ({ ...d, units: n2(d.units), A: d.A == null ? null : n2(d.A), B: d.B == null ? null : n2(d.B), C: d.C == null ? null : n2(d.C) }));
  const total = { looms: 0, A: 0, B: 0, C: 0, units: 0, extra: 0 };
  for (const r of rows) { total.looms += r.looms; total.A += r.A || 0; total.B += r.B || 0; total.C += r.C || 0; total.units += r.units; total.extra += r.extra; }
  return { employee: { id: emp.id, code: emp.code, name: emp.name, label: labelOf(emp.code, emp.name) }, from: p.from, to: p.to, days: rows.length, shifts: shifts.length, units: n2(total.units), extraLooms: total.extra,
    rows, total: { ...total, A: n2(total.A), B: n2(total.B), C: n2(total.C), units: n2(total.units) } };
}

// ---- PDF and Excel ----
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
function columns(s) {
  const cols = [{ key: 'label', label: 'Weaver', w: 22, align: 'left' }, { key: 'shifts', label: 'Shifts', w: 6 }, ...s.groups.map((gr) => ({ key: `g:${gr.looms}`, label: `${gr.looms}-loom shifts`, w: 9, group: gr.looms }))];
  for (const t of s.types) cols.push({ key: `t:${t.key}`, label: `${t.label} units`, w: 9, type: t.key });
  cols.push({ key: 'totalUnits', label: 'Total units', w: 9 }, { key: 'stoppedLooms', label: 'Stopped looms', w: 9 }, { key: 'stoppageUnits', label: 'Stoppage units', w: 9 }, { key: 'stoppageAmount', label: 'Stoppage amnt', w: 9 });
  return cols;
}
const cellValue = (c, r) => (c.type ? r.unitsByType[c.type] : c.group != null ? r.loomShifts[c.group] : r[c.key]);

function stamp() {
  const t = new Date().toLocaleString('en-GB', { timeZone: ZONE, hour12: false }).replace(',', '');
  const [d, h] = t.split(' '); const [dd, mm, yy] = d.split('/');
  return `${dd}-${mm}-${yy} ${h.slice(0, 5)}`;
}

async function pdf(req, { departmentId, from }) {
  const s = await sheet(req, { departmentId, from });
  const company = await Company.findByPk(req.user.companyId);
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  const chunks = []; const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const W = doc.page.width - 72; const PURPLE = '#85567a';
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(14).fillColor(PURPLE).text(`${s.department.name.toUpperCase()} UNITS - WEAVER WISE`, 36, 32);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Period: ${s.label} (${s.from} to ${s.to})${company ? ` | ${company.name}` : ''}`, 36, doc.y);
    doc.y = 64;
  };
  header();
  const cols = columns(s); const total = cols.reduce((t, c) => t + c.w, 0); const widths = cols.map((c) => (c.w / total) * W);
  const put = (cells, { head = false, bold = false, band = false } = {}) => {
    const y = doc.y; const h = 14;
    if (y + h > doc.page.height - 50) { doc.addPage(); header(); return put(cells, { head, bold, band }); }
    if (head) doc.rect(36, y, W, h).fillColor(PURPLE).fill(); else if (band) doc.rect(36, y, W, h).fillColor('#f3eaf1').fill();
    doc.font(head || bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(head ? '#fff' : '#000');
    let x = 36; cells.forEach((t, i) => { doc.text(String(t), x + 3, y + 3.5, { width: widths[i] - 6, align: i === 0 ? 'left' : head ? 'center' : 'right', lineBreak: false }); x += widths[i]; });
    doc.y = y + h; return null;
  };
  put(cols.map((c) => c.label), { head: true });
  s.rows.forEach((r, i) => put(cols.map((c, ci) => (ci === 0 ? r.label : n0(cellValue(c, r)))), { band: i % 2 === 1 }));
  put(cols.map((c, ci) => (ci === 0 ? 'TOTAL' : (c.key === 'shifts' || c.group != null) ? '' : n0(c.type ? s.totals.unitsByType[c.type] : s.totals[c.key] ?? ''))), { bold: true });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(`| printed ${stamp()}`, 36, doc.page.height - 28, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1}`, 36 + W / 2, doc.page.height - 28, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return { buffer: await done, fileName: `${slug(s.department.name)}-weaver-${s.label.replace(/\s/g, '')}.pdf` };
}

async function xlsx(req, { departmentId, from }) {
  const s = await sheet(req, { departmentId, from });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Weaver wise');
  ws.addRow([`${s.department.name.toUpperCase()} UNITS - WEAVER WISE`]).font = { bold: true, size: 13 };
  ws.addRow([`Period: ${s.label} (${s.from} to ${s.to})`]);
  ws.addRow([]);
  const cols = columns(s);
  const head = ws.addRow(cols.map((c) => c.label));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF85567A' } }; c.alignment = { horizontal: 'center' }; });
  for (const r of s.rows) ws.addRow(cols.map((c) => cellValue(c, r)));
  const t = ws.addRow(cols.map((c, i) => (i === 0 ? 'TOTAL' : (c.key === 'shifts' || c.group != null) ? null : c.type ? s.totals.unitsByType[c.type] : s.totals[c.key] ?? null)));
  t.font = { bold: true };
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = i === 0 ? 30 : 14; if (i > 0) ws.getColumn(i + 1).numFmt = '#,##0'; });
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, fileName: `${slug(s.department.name)}-weaver-${s.label.replace(/\s/g, '')}.xlsx` };
}

const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';

module.exports = { sheet, attendance, pdf, xlsx, getPolicy, setPolicy, policyOf, gather, bounds, perWeaverOf, rateAt, rateDayAt, stoppages, labelOf, NO_TYPE };
