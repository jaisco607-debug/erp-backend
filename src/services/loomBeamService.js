// Weaving > Looms > Loom Beam Entry: beams put on a loom.
//   One ENTRY = one K-ID (a running number of the company, never used again; a NEW one every time beams are put on a loom) with 1 or 2 beams of the beam stock (FULL beams, which come from the sizing batches),
//   the FACTOR (1 = single panna, 2 = double panna, 3 = triple panna), the loom RPM, the loom PICK, the REED SPACE (in), the start date and, when the loom is cut off, the end date.
//   A loom takes at most 2 beams at a time (over all its running entries).
//   put on a loom   beam FULL -> AT_LOOM (dated like the start date)         cut-off   beams AT_LOOM -> EMPTY (dated like the end date), the entry is CUT_OFF
//   An entry is saved NOT CONFIRMED (it can be deleted: the beams go back to the stock) and then confirmed (needs rpm, pick, reed space).  A cut-off needs a confirmed entry.
//   Net length = the length of one warp: the two beams of an entry run side by side, so net length = total beam length / number of beams.
// (The production register, produced / balance and half-cut come with the next step.)
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { unitsToMeters } = require('../utils/loomUnits');
const audit = require('./auditService');
const counters = require('./counterService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => (v == null ? null : Number(v));
const label = (n) => String(n).padStart(5, '0');
const FACTOR_TEXT = { 1: 'Single panna', 2: 'Double panna', 3: 'Triple panna' };
const STATUS_TEXT = { ACTIVE: 'Active', CUT_OFF: 'Cut off', HALF_CUT: 'Half cut' };
const BEAM_TEXT = { EMPTY: 'Empty', FULL: 'Full', AT_LOOM: 'At loom', AT_SIZING: 'At sizing' };
const MAX_BEAMS = 2;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

// a beam with where it came from: its latest sized beam receipt (batch, set, ends, count, quality, In Pass) — a beam without one is not from a batch
const BEAM_SQL = `SELECT b.id, b."beamNo", b.name, b.status, b.meters, b."halfCutM", to_char(b."statusDate", 'YYYY-MM-DD') AS "statusDate", b."weightKg",
    r."receiptNo", to_char(r."receiptDate", 'YYYY-MM-DD') AS "receiptDate", sb.id AS "batchId", sb."batchNo", sb."setNo", sb.ends, yc.name AS "yarnCount", COALESCE(wq.name, sb.quality) AS quality, wq.code AS "qualityCode"
  FROM yarn_beams b LEFT JOIN LATERAL (SELECT r2.* FROM sizing_receipt_beams rb JOIN sizing_receipts r2 ON r2.id = rb."receiptId" WHERE rb."beamId" = b.id ORDER BY r2."receiptDate" DESC, r2."receiptNo" DESC LIMIT 1) r ON true
  LEFT JOIN sizing_batches sb ON sb.id = r."batchId" LEFT JOIN yarn_counts yc ON yc.id = sb."yarnCountId" LEFT JOIN weaving_qualities wq ON wq.id = sb."qualityId"`;

const beamJson = (b, lengthM) => ({
  id: b.id, beamNo: b.beamNo, beamLabel: label(b.beamNo), name: b.name, status: b.status, statusText: BEAM_TEXT[b.status], statusDate: b.statusDate,
  lengthM: lengthM != null ? n2(lengthM) : num(b.meters) == null ? 0 : n2(b.meters), weightKg: num(b.weightKg),
  setNo: b.setNo || null, ends: b.ends || null, yarnCount: b.yarnCount || null, quality: b.quality || null, qualityCode: b.qualityCode ?? null, date: b.receiptDate || b.statusDate,
  batch: b.batchId ? { id: b.batchId, batchNo: b.batchNo, batchLabel: label(b.batchNo) } : null, inPassNo: b.receiptNo || null,
  // "os" = sized outside (it came back on a sizing batch receipt)
  type: b.batchId ? 'os' : null,
  // a beam that came back half cut from a loom: the estimated meters left (= lengthM)
  halfCut: b.halfCutM != null, halfCutM: num(b.halfCutM),
});

const FACTORS = [1, 2, 3].map((value) => ({ value, text: FACTOR_TEXT[value] }));

// ---- entries ----
async function entriesOf(where, replacements, transaction) {
  const rows = await q(`SELECT e.*, to_char(e."startDate", 'YYYY-MM-DD') AS "startDay", to_char(e."endDate", 'YYYY-MM-DD') AS "endDay", l."loomNo", l."isActive" AS "loomActive", d.id AS "deptId", d.code AS "deptCode", d.name AS "deptName"
    FROM loom_entries e JOIN looms l ON l.id = e."loomId" JOIN weaving_departments d ON d.id = l."departmentId" WHERE ${where} ORDER BY e."startDate" DESC, e."kId" DESC`, replacements, transaction);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const bs = await q(`SELECT eb."entryId", eb."lengthM" AS "entryLength", eb."leftM", x.* FROM loom_entry_beams eb JOIN (${BEAM_SQL}) x ON x.id = eb."beamId" WHERE eb."entryId" IN (:ids) ORDER BY x."beamNo"`, { ids }, transaction);
  // the production register: the units of the K-ID (1 unit = 1,000 picks) and the cloth made from them at the loom pick
  const pr = await q(`SELECT "entryId", SUM(units) AS units, COUNT(DISTINCT "workDate") FILTER (WHERE units > 0)::int AS days, to_char(MAX("workDate") FILTER (WHERE units > 0), 'YYYY-MM-DD') AS last FROM production_units WHERE "entryId" IN (:ids) GROUP BY "entryId"`, { ids }, transaction);
  return rows.map((e) => {
    const beams = bs.filter((b) => b.entryId === e.id).map((b) => ({ ...beamJson(b, b.entryLength), leftM: num(b.leftM) }));
    const lengthM = n2(beams.reduce((t, b) => t + b.lengthM, 0));
    const first = beams[0] || {};
    const same = (k) => new Set(beams.map((b) => b[k] || '')).size <= 1;
    // a half cut entry: the meters left on the beams and so the cloth made so far (net length of the warp - net length left). (A full cut-off: the production register comes later.)
    const halfCut = e.status === 'HALF_CUT';
    const leftTotal = halfCut ? n2(beams.reduce((t, b) => t + (b.leftM || 0), 0)) : null;
    const leftNet = halfCut && beams.length ? n2(leftTotal / beams.length) : null;
    const p = pr.find((x) => x.entryId === e.id);
    const units = p ? n2(p.units) : 0;
    const net = beams.length ? n2(lengthM / beams.length) : 0;
    const producedM = unitsToMeters(units, e.loomPick) || 0;
    const balanceM = Math.max(0, n2(net - producedM));
    const donePct = net ? Math.min(100, n2((producedM / net) * 100)) : 0;
    const daysRun = p ? p.days : 0;
    // metres per day: what the loom really made per working day; before any units, the plan of the loom (RPM x 1,440 minutes / (pick x 39.3701))
    const plannedPerDayM = e.loomRpm && e.loomPick ? n2((e.loomRpm * 1440) / (e.loomPick * 39.3701)) : null;
    const perDayM = daysRun ? n2(producedM / daysRun) : plannedPerDayM;
    let endsOn = null;
    if (e.status === 'ACTIVE' && perDayM > 0 && balanceM > 0) { const d = new Date(`${(p && p.last) || today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Math.ceil(balanceM / perDayM)); endsOn = d.toISOString().slice(0, 10); }
    const ready = { rpm: e.loomRpm != null, pick: e.loomPick != null, reedSpace: e.reedSpace != null };
    const active = e.status === 'ACTIVE';
    // the status list: when the units were last updated (never = since the start), stale = nothing for 3+ days, the days left at this pace, a loom without length / RPM / pick
    const ref = (p && p.last) || e.startDay;
    const staleDays = active ? Math.max(0, Math.round((new Date(`${today()}T00:00:00Z`) - new Date(`${ref}T00:00:00Z`)) / 86400000)) : null;
    const endsInDays = endsOn ? Math.round((new Date(`${endsOn}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 86400000) : null;
    return {
      id: e.id, kId: e.kId, kLabel: String(e.kId), loom: { id: e.loomId, loomNo: e.loomNo, department: { id: e.deptId, code: e.deptCode, name: e.deptName } }, loomId: e.loomId,
      factor: e.factor, factorText: FACTOR_TEXT[e.factor], loomRpm: e.loomRpm, loomPick: e.loomPick, reedSpace: num(e.reedSpace), startDate: e.startDay, endDate: e.endDay,
      status: e.status, statusText: STATUS_TEXT[e.status], isConfirmed: e.isConfirmed, confirmedAt: e.confirmedAt,
      beams, warps: beams.length, beamNos: beams.map((b) => b.name).join('|'), setNos: beams.map((b) => b.setNo || '-').join('|'),
      beamLengthM: lengthM, netLengthM: beams.length ? n2(lengthM / beams.length) : 0,
      leftM: leftTotal, leftNetM: leftNet, estimatedProducedM: halfCut && beams.length ? n2(lengthM / beams.length - leftNet) : null,
      // production register: units, cloth made (m), balance (m), % done / remaining, days run, metres per day, the day the beam is expected to finish
      units, producedM, balanceM, donePct, remainingPct: n2(100 - donePct), daysRun, perDayM, plannedPerDayM, perDayIsPlanned: !daysRun && perDayM != null, lastProductionDate: p ? p.last : null, endsOn, endsInDays,
      neverUpdated: active && !p, staleDays, isStale: active && staleDays >= 3, missingSetup: active && !(lengthM > 0 && e.loomRpm != null && e.loomPick != null),
      qualityCode: first.qualityCode ?? null, qualityText: first.quality ? (first.qualityCode != null ? `${first.quality} (${first.qualityCode})` : first.quality) : null,
      // what the beams are (from their batches); `mixed` = the two beams are not of the same count / ends / quality
      yarnCount: first.yarnCount || null, ends: first.ends || null, quality: first.quality || null, mixed: !same('yarnCount') || !same('ends') || !same('quality'),
      readiness: ready, canEdit: active, canConfirm: active && !e.isConfirmed && beams.length > 0 && Object.values(ready).every(Boolean), canAddBeams: active && beams.length < MAX_BEAMS, canRemoveBeams: active && !e.isConfirmed && beams.length > 0, canDelete: active && !e.isConfirmed, canCutOff: active && e.isConfirmed, canHalfCut: active && e.isConfirmed, canReopen: !active,
      createdAt: e.createdAt,
    };
  });
}

async function get(req, id) {
  const [e] = await entriesOf('e.id = :id AND e."companyId" = :companyId', { id, companyId: req.user.companyId });
  if (!e) throw AppError.notFound('Loom beam entry');
  return e;
}

async function list(req, { page, limit, search, status, loomId, departmentId, confirmed, dateFrom, dateTo }) {
  const r = { companyId: req.user.companyId };
  const f = ['e."companyId" = :companyId'];
  if (loomId) { f.push('e."loomId" = :loomId'); r.loomId = loomId; }
  if (departmentId) { f.push('l."departmentId" = :departmentId'); r.departmentId = departmentId; }
  if (confirmed !== undefined) { f.push('e."isConfirmed" = :confirmed'); r.confirmed = confirmed; }
  if (dateFrom) { f.push('e."startDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { f.push('e."startDate" <= :dateTo'); r.dateTo = dateTo; }
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; r.exact = String(Number(search) || '');
    f.push(`(l."loomNo" ILIKE :like OR e."kId"::text = :exact OR EXISTS (SELECT 1 FROM loom_entry_beams eb JOIN yarn_beams b ON b.id = eb."beamId" LEFT JOIN sizing_receipt_beams rb ON rb."beamId" = b.id
      LEFT JOIN sizing_receipts sr ON sr.id = rb."receiptId" LEFT JOIN sizing_batches sb ON sb.id = sr."batchId" WHERE eb."entryId" = e.id AND (b.name ILIKE :like OR sb."setNo" ILIKE :like)))`);
  }
  const from = `FROM loom_entries e JOIN looms l ON l.id = e."loomId" WHERE ${f.join(' AND ')}`;
  const st = { ...r, status: status || null };
  const ids = (await q(`SELECT e.id ${from} AND (:status::text IS NULL OR e.status = :status OR (:status = 'COMPLETED' AND e.status IN ('CUT_OFF', 'HALF_CUT'))) ORDER BY e."startDate" DESC, e."kId" DESC LIMIT :limit OFFSET :offset`, { ...st, limit, offset: (page - 1) * limit })).map((x) => x.id);
  const data = ids.length ? (await entriesOf('e.id IN (:ids)', { ids })) : [];
  const [t] = await q(`SELECT COUNT(*) FILTER (WHERE e.status = 'ACTIVE')::int AS active, COUNT(*) FILTER (WHERE e.status = 'CUT_OFF')::int AS "cutOff", COUNT(*) FILTER (WHERE e.status = 'HALF_CUT')::int AS "halfCut", COUNT(*) FILTER (WHERE e.status = 'ACTIVE' AND NOT e."isConfirmed")::int AS "notConfirmed",
    COUNT(*) FILTER (WHERE :status::text IS NULL OR e.status = :status OR (:status = 'COMPLETED' AND e.status IN ('CUT_OFF', 'HALF_CUT')))::int AS total, COUNT(*) FILTER (WHERE e.status IN ('CUT_OFF', 'HALF_CUT'))::int AS completed, COUNT(DISTINCT e."loomId") FILTER (WHERE e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM loom_entry_beams x WHERE x."entryId" = e.id))::int AS "loomsRunning",
    COALESCE((SELECT SUM(eb."lengthM") FROM loom_entry_beams eb JOIN loom_entries e2 ON e2.id = eb."entryId" AND e2.status = 'ACTIVE' WHERE e2.id IN (SELECT e.id ${from})), 0) AS len ${from}`, st);
  // the idle looms: switched-on looms with no running entry (of the department filter)
  const idle = await q(`SELECT l.id, l."loomNo", d.id AS "deptId", d.name AS "deptName" FROM looms l JOIN weaving_departments d ON d.id = l."departmentId" WHERE l."companyId" = :companyId AND l."deletedAt" IS NULL AND l."isActive"
    ${departmentId ? 'AND l."departmentId" = :departmentId' : ''} AND NOT EXISTS (SELECT 1 FROM loom_entries e WHERE e."loomId" = l.id AND e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM loom_entry_beams x WHERE x."entryId" = e.id)) ORDER BY d.name, l."loomNo"`, r);
  return { data, page, limit, total: t.total, counts: { active: t.active, completed: t.completed, cutOff: t.cutOff, halfCut: t.halfCut, notConfirmed: t.notConfirmed },
    totals: { loomsRunning: t.loomsRunning, idleLooms: idle.length, beamLengthM: n2(t.len), ...(await runningTotals(from, st)) },
    idleLooms: idle.map((l) => ({ id: l.id, loomNo: l.loomNo, department: { id: l.deptId, name: l.deptName } })) };
}

/** The pills and the footer of the status list: all running entries of the filter (not only the page): produced, left, not updated for 3+ days, without length / RPM / pick. */
async function runningTotals(from, st) {
  const ids = (await q(`SELECT e.id ${from} AND e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM loom_entry_beams x WHERE x."entryId" = e.id)`, st)).map((x) => x.id);
  const all = ids.length ? await entriesOf('e.id IN (:ids)', { ids }) : [];
  return { producedM: n2(all.reduce((t, e) => t + e.producedM, 0)), leftM: n2(all.reduce((t, e) => t + e.balanceM, 0)), netLengthM: n2(all.reduce((t, e) => t + e.netLengthM, 0)), units: n2(all.reduce((t, e) => t + e.units, 0)), notUpdated: all.filter((e) => e.isStale).length, missingSetup: all.filter((e) => e.missingSetup).length };
}

/** GET /loom-beams/quality-summary: the running looms grouped by quality (the Quality summary button). */
async function qualitySummary(req, { departmentId }) {
  const r = { companyId: req.user.companyId }; let dept = '';
  if (departmentId) { dept = ' AND l."departmentId" = :departmentId'; r.departmentId = departmentId; }
  const ids = (await q(`SELECT e.id FROM loom_entries e JOIN looms l ON l.id = e."loomId" WHERE e."companyId" = :companyId AND e.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM loom_entry_beams x WHERE x."entryId" = e.id)${dept}`, r)).map((x) => x.id);
  const all = ids.length ? await entriesOf('e.id IN (:ids)', { ids }) : [];
  const by = new Map();
  for (const e of all) {
    const k = e.qualityText || 'No quality';
    const g = by.get(k) || { quality: e.quality || 'No quality', qualityCode: e.qualityCode, qualityText: k, looms: 0, loomNos: [], beamLengthM: 0, netLengthM: 0, producedM: 0, leftM: 0 };
    g.looms += 1; g.loomNos.push(e.loom.loomNo); g.beamLengthM += e.beamLengthM; g.netLengthM += e.netLengthM; g.producedM += e.producedM; g.leftM += e.balanceM;
    by.set(k, g);
  }
  const data = [...by.values()].map((g) => ({ ...g, beamLengthM: n2(g.beamLengthM), netLengthM: n2(g.netLengthM), producedM: n2(g.producedM), leftM: n2(g.leftM) })).sort((a, b) => b.looms - a.looms);
  return { data, total: data.length, totals: { looms: all.length, beamLengthM: n2(data.reduce((t, g) => t + g.beamLengthM, 0)), producedM: n2(data.reduce((t, g) => t + g.producedM, 0)), leftM: n2(data.reduce((t, g) => t + g.leftM, 0)) } };
}

/** Dropdown help: the factors, today and the looms (switched on) with the room they have for beams. */
async function formData(req) {
  const looms = await q(`SELECT l.id, l."loomNo", d.id AS "deptId", d.name AS "deptName", (SELECT COUNT(*)::int FROM loom_entry_beams eb JOIN loom_entries e ON e.id = eb."entryId" WHERE e."loomId" = l.id AND e.status = 'ACTIVE') AS beams
    FROM looms l JOIN weaving_departments d ON d.id = l."departmentId" WHERE l."companyId" = :companyId AND l."deletedAt" IS NULL AND l."isActive" ORDER BY d.name, l."loomNo"`, { companyId: req.user.companyId });
  const departments = await q('SELECT id, code, name FROM weaving_departments WHERE "companyId" = :companyId AND "deletedAt" IS NULL AND "isActive" ORDER BY name', { companyId: req.user.companyId });
  return { date: today(), factors: FACTORS, defaultFactor: 1, maxBeams: MAX_BEAMS, departments,
    looms: looms.map((l) => ({ id: l.id, loomNo: l.loomNo, department: { id: l.deptId, name: l.deptName }, beamsOnLoom: l.beams, roomForBeams: MAX_BEAMS - l.beams, canTakeBeams: l.beams < MAX_BEAMS })) };
}

/** GET /loom-beams/available-beams : the free beams (FULL, switched on) of the beam stock, with their batch / set / count / ends / length. */
async function availableBeams(req, { search }) {
  let rows = await q(`SELECT * FROM (${BEAM_SQL}) x WHERE x.id IN (SELECT id FROM yarn_beams WHERE "companyId" = :companyId AND status = 'FULL' AND "isActive" AND "deletedAt" IS NULL) ORDER BY x."receiptDate" DESC NULLS LAST, x."beamNo"`, { companyId: req.user.companyId });
  if (search) {
    const s = search.trim().toLowerCase();
    rows = rows.filter((b) => b.name.toLowerCase().includes(s) || String(b.setNo || '').toLowerCase().includes(s) || String(b.yarnCount || '').toLowerCase().includes(s) || String(b.beamNo) === s);
  }
  return { data: rows.map((b) => beamJson(b)), total: rows.length, maxBeams: MAX_BEAMS };
}

// ---- change ----
async function beamsOnLoom(loomId, transaction, exceptEntryId) {
  const [r] = await q('SELECT COUNT(*)::int AS n FROM loom_entry_beams eb JOIN loom_entries e ON e.id = eb."entryId" WHERE e."loomId" = :loomId AND e.status = \'ACTIVE\' AND (:ex::uuid IS NULL OR e.id <> :ex::uuid)', { loomId, ex: exceptEntryId || null }, transaction);
  return r.n;
}
const roomError = (n, adding) => AppError.rule('LOOM_FULL', `A loom takes at most ${MAX_BEAMS} beams: it has ${n} now, ${adding} more cannot be put on it`, { beamsOnLoom: n, adding, max: MAX_BEAMS });

async function lockLoom(companyId, loomId, transaction) {
  const [l] = await q('SELECT id, "isActive" FROM looms WHERE id = :loomId AND "companyId" = :companyId AND "deletedAt" IS NULL FOR UPDATE', { loomId, companyId }, transaction);
  if (!l) throw AppError.rule('UNKNOWN_LOOM', 'This loom does not exist', { field: 'loomId' });
  return l;
}

// the beams to put on a loom: free (FULL) beams, room on the loom, and the beams of one entry are of the SAME length
async function pickBeams(companyId, loomId, beamIds, startDate, transaction, keepLengths = [], keepIds = []) {
  if (new Set(beamIds).size !== beamIds.length) throw AppError.rule('DUPLICATE_BEAM', 'The same beam is listed twice', { field: 'beamIds' });
  const onLoom = await beamsOnLoom(loomId, transaction);
  if (onLoom + beamIds.length > MAX_BEAMS) throw roomError(onLoom, beamIds.length);
  if (keepLengths.length + beamIds.length > MAX_BEAMS) throw AppError.rule('ENTRY_FULL', `An entry takes at most ${MAX_BEAMS} beams: it has ${keepLengths.length} now`, { beams: keepLengths.length, adding: beamIds.length, max: MAX_BEAMS });
  if (!beamIds.length) return [];
  const beams = await q('SELECT id, "beamNo", name, status, "isActive", meters, "halfCutM", to_char("statusDate", \'YYYY-MM-DD\') AS "statusDate" FROM yarn_beams WHERE id IN (:ids) AND "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY id FOR UPDATE', { ids: beamIds, companyId }, transaction);
  const lengths = [...keepLengths];
  for (const [i, id] of beamIds.entries()) {
    const b = beams.find((x) => x.id === id);
    if (!b) throw AppError.rule('UNKNOWN_BEAM', 'This beam does not exist', { line: i + 1, beamId: id });
    if (b.status !== 'FULL' || !b.isActive) throw AppError.rule('BEAM_NOT_FREE', `Beam ${b.beamNo} is not a free (full) beam of the beam stock (it is ${BEAM_TEXT[b.status].toLowerCase()})`, { line: i + 1, beamNo: b.beamNo, status: b.status });
    if (b.statusDate > startDate) throw AppError.rule('BEFORE_FULL', `Beam ${b.beamNo} came in full on ${b.statusDate}: it cannot go on a loom before that`, { line: i + 1, beamNo: b.beamNo, since: b.statusDate });
    lengths.push(n2(num(b.meters) || 0));
  }
  if (new Set(lengths).size > 1) throw AppError.rule('BEAM_LENGTH_MISMATCH', `The beams of one entry must have the same length (they are ${lengths.join(' m and ')} m)`, { lengths });
  // the beams of one entry are of the same count and the same quality too (from their sizing batches)
  const info = await q(`SELECT x."beamNo", x."yarnCount", x.quality FROM (${BEAM_SQL}) x WHERE x.id IN (:ids)`, { ids: [...keepIds, ...beamIds] }, transaction);
  const norm = (v) => String(v || '').trim().toLowerCase();
  for (const [key, code, name] of [['yarnCount', 'BEAM_COUNT_MISMATCH', 'yarn count'], ['quality', 'BEAM_QUALITY_MISMATCH', 'quality']]) {
    const vals = [...new Set(info.map((x) => norm(x[key])))];
    if (vals.length > 1) throw AppError.rule(code, `The beams of one entry must have the same ${name} (${info.map((x) => `beam ${x.beamNo}: ${x[key] || '-'}`).join(', ')})`, { beams: info.map((x) => ({ beamNo: x.beamNo, [key]: x[key] || null })) });
  }
  return beamIds.map((id) => beams.find((x) => x.id === id));
}
async function putBeams(entryId, beams, startDate, transaction) {
  for (const b of beams) {
    await exec('INSERT INTO loom_entry_beams (id, "entryId", "beamId", "lengthM", "prevStatusDate", "prevHalfCutM") VALUES (:id, :entryId, :beamId, :len, :prev, :half)', { id: crypto.randomUUID(), entryId, beamId: b.id, len: num(b.meters) || 0, prev: b.statusDate, half: num(b.halfCutM) }, transaction);
    await exec('UPDATE yarn_beams SET status = \'AT_LOOM\', "statusDate" = :d, "halfCutM" = NULL, "updatedAt" = now() WHERE id = :id', { d: startDate, id: b.id }, transaction);
  }
}

// A1.2 (owner 2026-11-24): a loom starts or is cut today or before, never on a day that has not come: a future start blocks cut-off, half-cut and the production register
function notFuture(date, field) {
  if (date && date > today()) throw AppError.rule('FUTURE_DATE', 'This date has not come yet; use today or an earlier day', { field });
}

/** The units of the loom that were entered on the days of this entry belong to it (and the days outside it do not), after the start or end date moved. */
async function relinkProduction(e, startDate, endDate, transaction) {
  await exec('UPDATE production_units SET "entryId" = NULL, "updatedAt" = now() WHERE "companyId" = :companyId AND "loomId" = :loomId AND "entryId" = :id AND ("workDate" < :startDate OR (CAST(:endDate AS date) IS NOT NULL AND "workDate" > :endDate))',
    { companyId: e.companyId, loomId: e.loomId, id: e.id, startDate, endDate: endDate || null }, transaction);
  await exec('UPDATE production_units SET "entryId" = :id, "updatedAt" = now() WHERE "companyId" = :companyId AND "loomId" = :loomId AND "entryId" IS NULL AND "workDate" >= :startDate AND (CAST(:endDate AS date) IS NULL OR "workDate" <= :endDate)',
    { companyId: e.companyId, loomId: e.loomId, id: e.id, startDate, endDate: endDate || null }, transaction);
}

async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const loom = await lockLoom(companyId, data.loomId, transaction);
    if (!loom.isActive) throw AppError.rule('LOOM_INACTIVE', 'This loom is switched off', { field: 'loomId' });
    const beamIds = data.beamIds || [];
    const startDate = data.startDate || today();
    notFuture(startDate, 'startDate');
    const beams = await pickBeams(companyId, data.loomId, beamIds, startDate, transaction);
    const kId = await counters.take(companyId, 'loom_k_id', async () => Number((await q('SELECT COALESCE(MAX("kId"), 0) + 1 AS n FROM loom_entries WHERE "companyId" = :companyId', { companyId }, transaction))[0].n), transaction);
    const id = crypto.randomUUID();
    await exec(`INSERT INTO loom_entries (id, "companyId", "kId", "loomId", factor, "loomRpm", "loomPick", "reedSpace", "startDate", "createdById")
      VALUES (:id, :companyId, :kId, :loomId, :factor, :loomRpm, :loomPick, :reedSpace, :startDate, :userId)`,
    { id, companyId, kId, loomId: data.loomId, factor: data.factor || 1, loomRpm: data.loomRpm || null, loomPick: data.loomPick || null, reedSpace: data.reedSpace || null, startDate, userId: req.user.id }, transaction);
    await putBeams(id, beams, startDate, transaction);
    const [out] = await entriesOf('e.id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_BEAMS_ADDED', entityType: 'LoomEntry', entityId: id, after: { kId, loom: out.loom.loomNo, beams: out.beamNos, factor: out.factor } }, { transaction });
    return out;
  });
}

async function lockEntry(companyId, id, transaction) {
  const [e] = await q('SELECT *, to_char("startDate", \'YYYY-MM-DD\') AS "startDay", to_char("endDate", \'YYYY-MM-DD\') AS "endDay" FROM loom_entries WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
  if (!e) throw AppError.notFound('Loom beam entry');
  return e;
}
const needActive = (e) => {
  if (e.status !== 'ACTIVE') throw AppError.rule('ENTRY_CUT_OFF', 'This entry is cut off: reopen it to change it');
};
const beamRows = (entryId, transaction) => q('SELECT eb."beamId", eb."lengthM", eb."prevStatusDate", eb."prevHalfCutM", b."beamNo", b.status FROM loom_entry_beams eb JOIN yarn_beams b ON b.id = eb."beamId" WHERE eb."entryId" = :entryId', { entryId }, transaction);

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    const [before] = await entriesOf('e.id = :id', { id }, transaction);
    const set = {};
    for (const f of ['factor', 'loomRpm', 'loomPick', 'reedSpace']) if (changes[f] !== undefined) set[f] = changes[f];
    if (changes.startDate) {
      notFuture(changes.startDate, 'startDate');
      const rows = await beamRows(id, transaction);
      const since = rows.reduce((m, r) => (String(r.prevStatusDate) > m ? String(r.prevStatusDate) : m), '');
      if (changes.startDate < since) throw AppError.rule('BEFORE_FULL', `The beams came in full on ${since}: the start date cannot be before that`, { since });
      set.startDate = changes.startDate;
      await relinkProduction(e, changes.startDate, e.endDay, transaction);
      await exec('UPDATE yarn_beams SET "statusDate" = :d, "updatedAt" = now() WHERE id IN (SELECT "beamId" FROM loom_entry_beams WHERE "entryId" = :id)', { d: changes.startDate, id }, transaction);
    }
    const keys = Object.keys(set);
    if (keys.length) await exec(`UPDATE loom_entries SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { ...set, id }, transaction);
    const [out] = await entriesOf('e.id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_ENTRY_UPDATED', entityType: 'LoomEntry', entityId: id, before: { factor: before.factor, loomRpm: before.loomRpm, loomPick: before.loomPick, reedSpace: before.reedSpace, startDate: before.startDate }, after: { factor: out.factor, loomRpm: out.loomRpm, loomPick: out.loomPick, reedSpace: out.reedSpace, startDate: out.startDate } }, { transaction });
    return out;
  });
}

async function confirm(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    // a half cut entry: the meters left on the beams and so the cloth made so far (net length of the warp - net length left). (A full cut-off: the production register comes later.)
    const halfCut = e.status === 'HALF_CUT';
    const leftTotal = halfCut ? n2(beams.reduce((t, b) => t + (b.leftM || 0), 0)) : null;
    const leftNet = halfCut && beams.length ? n2(leftTotal / beams.length) : null;
    const ready = { rpm: e.loomRpm != null, pick: e.loomPick != null, reedSpace: e.reedSpace != null };
    if (!(await beamRows(id, transaction)).length) throw AppError.rule('NO_BEAMS', 'Add the beams to this entry before confirming it', { missing: ['beams'] });
    const missing = Object.keys(ready).filter((k) => !ready[k]);
    if (missing.length) throw AppError.rule('NOT_READY', `The entry cannot be confirmed yet: it needs ${missing.map((k) => ({ rpm: 'the loom RPM', pick: 'the loom pick', reedSpace: 'the reed space' }[k])).join(', ')}`, { missing, readiness: ready });
    if (!e.isConfirmed) {
      await exec('UPDATE loom_entries SET "isConfirmed" = true, "confirmedAt" = now(), "updatedAt" = now() WHERE id = :id', { id }, transaction);
      await audit.log(req, { action: 'LOOM_ENTRY_CONFIRMED', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId } }, { transaction });
    }
    return (await entriesOf('e.id = :id', { id }, transaction))[0];
  });
}

/** Add beams to an entry (a loom set up without beams, or one beam on it): free beams only, 2 per entry / loom, of the same length. */
async function addBeams(req, id, { beamIds }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    await lockLoom(companyId, e.loomId, transaction);
    const have = await beamRows(id, transaction);
    const beams = await pickBeams(companyId, e.loomId, beamIds, e.startDay, transaction, have.map((x) => n2(num(x.lengthM) || 0)), have.map((x) => x.beamId));
    await putBeams(id, beams, e.startDay, transaction);
    const [out] = await entriesOf('e.id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_BEAMS_ADDED', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId, beams: out.beamNos } }, { transaction });
    return out;
  });
}

/** Take a beam off an entry that is not confirmed yet: it goes back to the beam stock as FULL. */
async function removeBeam(req, id, beamId) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    if (e.isConfirmed) throw AppError.rule('ENTRY_CONFIRMED', 'This entry is confirmed: cut the loom off instead of taking a beam off');
    const b = (await beamRows(id, transaction)).find((x) => x.beamId === beamId);
    if (!b) throw AppError.notFound('Beam on this entry');
    if (b.status !== 'AT_LOOM') throw AppError.rule('BEAM_MOVED_ON', `Beam ${b.beamNo} is not at the loom any more (it is ${BEAM_TEXT[b.status].toLowerCase()})`, { beamNo: b.beamNo, status: b.status });
    await exec('UPDATE yarn_beams SET status = \'FULL\', "statusDate" = :d, meters = :m, "halfCutM" = :h, "updatedAt" = now() WHERE id = :id', { d: b.prevStatusDate, m: num(b.lengthM) || null, h: num(b.prevHalfCutM), id: beamId }, transaction);
    await exec('DELETE FROM loom_entry_beams WHERE "entryId" = :id AND "beamId" = :beamId', { id, beamId }, transaction);
    await audit.log(req, { action: 'LOOM_BEAM_REMOVED', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId, beamNo: b.beamNo } }, { transaction });
    return (await entriesOf('e.id = :id', { id }, transaction))[0];
  });
}

/** Loom cut-off: the beams are finished (AT_LOOM -> EMPTY, dated like the end date) and the entry is CUT_OFF. */
async function cutOff(req, id, { endDate }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    if (!e.isConfirmed) throw AppError.rule('NOT_CONFIRMED', 'Confirm the entry before cutting the loom off');
    const date = endDate || today();
    notFuture(date, 'endDate');
    if (date < e.startDay) throw AppError.rule('END_BEFORE_START', `The loom started on ${e.startDay}: the end date cannot be before that`, { startDate: e.startDay });
    for (const b of await beamRows(id, transaction)) {
      if (b.status !== 'AT_LOOM') throw AppError.rule('BEAM_MOVED_ON', `Beam ${b.beamNo} is not at the loom any more (it is ${BEAM_TEXT[b.status].toLowerCase()})`, { beamNo: b.beamNo, status: b.status });
      await exec('UPDATE yarn_beams SET status = \'EMPTY\', "statusDate" = :d, meters = NULL, "updatedAt" = now() WHERE id = :id', { d: date, id: b.beamId }, transaction);
    }
    await exec('UPDATE loom_entries SET status = \'CUT_OFF\', "endDate" = :d, "updatedAt" = now() WHERE id = :id', { d: date, id }, transaction);
    await audit.log(req, { action: 'LOOM_CUT_OFF', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId, endDate: date } }, { transaction });
    return (await entriesOf('e.id = :id', { id }, transaction))[0];
  });
}

/** Beam half cut: the beams come off the loom before they are finished and go back to the beam stock as FULL with the estimated meters left (badge "Half cut"); the entry is HALF_CUT and the loom is free. */
async function halfCut(req, id, { endDate, leftM, beams: given }) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    if (!e.isConfirmed) throw AppError.rule('NOT_CONFIRMED', 'Confirm the entry before taking the beams off the loom');
    const date = endDate || today();
    notFuture(date, 'endDate');
    if (date < e.startDay) throw AppError.rule('END_BEFORE_START', `The loom started on ${e.startDay}: the date cannot be before that`, { startDate: e.startDay });
    const rows = await beamRows(id, transaction);
    if (!rows.length) throw AppError.rule('NO_BEAMS', 'This entry has no beams');
    for (const b of rows) {
      const g = (given || []).find((x) => x.beamId === b.beamId);
      const left = n2(g ? g.leftM : leftM);
      if (!(left > 0)) throw AppError.rule('LEFT_REQUIRED', `Enter the meters left on beam ${b.beamNo}`, { beamNo: b.beamNo, field: 'leftM' });
      if (left > num(b.lengthM)) throw AppError.rule('LEFT_TOO_LONG', `Beam ${b.beamNo} went on the loom with ${n2(b.lengthM)} m: it cannot have ${left} m left`, { beamNo: b.beamNo, lengthM: n2(b.lengthM), leftM: left });
      if (b.status !== 'AT_LOOM') throw AppError.rule('BEAM_MOVED_ON', `Beam ${b.beamNo} is not at the loom any more (it is ${BEAM_TEXT[b.status].toLowerCase()})`, { beamNo: b.beamNo, status: b.status });
      await exec('UPDATE yarn_beams SET status = \'FULL\', "statusDate" = :d, meters = :m, "halfCutM" = :m, "updatedAt" = now() WHERE id = :id', { d: date, m: left, id: b.beamId }, transaction);
      await exec('UPDATE loom_entry_beams SET "leftM" = :m WHERE "entryId" = :id AND "beamId" = :beamId', { m: left, id, beamId: b.beamId }, transaction);
    }
    await exec('UPDATE loom_entries SET status = \'HALF_CUT\', "endDate" = :d, "updatedAt" = now() WHERE id = :id', { d: date, id }, transaction);
    await audit.log(req, { action: 'LOOM_BEAM_HALF_CUT', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId, date } }, { transaction });
    return (await entriesOf('e.id = :id', { id }, transaction))[0];
  });
}

/** Undo a cut-off: the beams go back to the loom (only while they are still empty) and the entry is ACTIVE again. */
async function reopen(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    if (e.status === 'ACTIVE') return (await entriesOf('e.id = :id', { id }, transaction))[0];
    await lockLoom(companyId, e.loomId, transaction);
    const rows = await beamRows(id, transaction);
    const onLoom = await beamsOnLoom(e.loomId, transaction);
    if (onLoom + rows.length > MAX_BEAMS) throw roomError(onLoom, rows.length);
    for (const b of rows) {
      const back = e.status === 'HALF_CUT' ? 'FULL' : 'EMPTY';
      if (b.status !== back) throw AppError.rule('BEAM_MOVED_ON', `Beam ${b.beamNo} is not ${back === 'FULL' ? 'in the stock as full' : 'empty'} any more (it is ${BEAM_TEXT[b.status].toLowerCase()}): this ${e.status === 'HALF_CUT' ? 'half cut' : 'cut-off'} cannot be undone`, { beamNo: b.beamNo, status: b.status });
      await exec('UPDATE yarn_beams SET status = \'AT_LOOM\', "statusDate" = :d, meters = :m, "halfCutM" = NULL, "updatedAt" = now() WHERE id = :id', { d: e.startDay, m: num(b.lengthM) || null, id: b.beamId }, transaction);
    }
    await exec('UPDATE loom_entry_beams SET "leftM" = NULL WHERE "entryId" = :id', { id }, transaction);
    await exec('UPDATE loom_entries SET status = \'ACTIVE\', "endDate" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_CUT_OFF_UNDONE', entityType: 'LoomEntry', entityId: id, after: { kId: e.kId } }, { transaction });
    return (await entriesOf('e.id = :id', { id }, transaction))[0];
  });
}

/** An entry that is not confirmed yet can be deleted: the beams go back to the beam stock as FULL (with their old date and meters). */
async function remove(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const e = await lockEntry(companyId, id, transaction);
    needActive(e);
    if (e.isConfirmed) throw AppError.rule('ENTRY_CONFIRMED', 'This entry is confirmed: cut the loom off instead of deleting it');
    for (const b of await beamRows(id, transaction)) {
      if (b.status !== 'AT_LOOM') throw AppError.rule('BEAM_MOVED_ON', `Beam ${b.beamNo} is not at the loom any more (it is ${BEAM_TEXT[b.status].toLowerCase()})`, { beamNo: b.beamNo, status: b.status });
      await exec('UPDATE yarn_beams SET status = \'FULL\', "statusDate" = :d, meters = :m, "halfCutM" = :h, "updatedAt" = now() WHERE id = :id', { d: b.prevStatusDate, m: num(b.lengthM) || null, h: num(b.prevHalfCutM), id: b.beamId }, transaction);
    }
    await exec('DELETE FROM loom_entries WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_ENTRY_DELETED', entityType: 'LoomEntry', entityId: id, before: { kId: e.kId } }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { entriesOf, list, get, create, update, confirm, cutOff, reopen, halfCut, remove, addBeams, removeBeam, formData, availableBeams, qualitySummary, MAX_BEAMS };
