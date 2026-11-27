// Fabric inspection (owner plan N-B1): quality control of cloth, thaan by thaan, with the 4-point system (utils/fourPoint.js). Its own person: the service INSPECTION.
//   - a thaan of a grey lot (grey checking) or a thaan a department made (after dyeing, printing ...) is inspected; it may be inspected again, the latest FINISHED one counts
//   - DRAFT: the defects are written (replaced as a list); every point and the grade are worked out here, never taken from the screen
//   - FINISH locks it with the rules of that moment (a later change of the settings does not change it); only the client admin reopens it, with a reason
//   - it changes NOTHING of the cloth: Folding and Packing only SHOW the grade (a suggestion)
// An inspection keeps a copy of the thaan, so a department that writes its thaans again is not blocked (the old inspection then says the thaan no longer exists).
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const counters = require('./counterService');
const rules4 = require('../utils/fourPoint');
const { today } = require('../utils/dates');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: 'SELECT', transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const COUNTER = 'inspection_no';
const label = (n) => `INS-${String(n).padStart(5, '0')}`;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
// what Folding calls the grades: A and B stay, C and REJECT are "CP" (a suggestion only, the folder chooses)
const FOLDING_OF = { A: 'a', B: 'b', C: 'cp', REJECT: 'cp' };

/* ---------------- settings and defect types ---------------- */

async function rulesOf(companyId, transaction) {
  const [r] = await q('SELECT "pointTable", "gradeLimits", basis, "maxPointsPerMeter" FROM inspection_settings WHERE "companyId" = :companyId', { companyId }, transaction);
  return r ? { pointTable: r.pointTable, gradeLimits: r.gradeLimits, basis: r.basis, maxPointsPerMeter: r.maxPointsPerMeter } : { ...rules4.STANDARD_RULES };
}

async function getSettings(req) {
  const rules = await rulesOf(req.user.companyId);
  return { ...rules, standard: rules4.STANDARD_RULES, grades: rules4.GRADES, note: 'A grade is the first limit the points per 100 fit in; above the last limit the cloth is REJECT. A finished inspection keeps the rules it was finished with.' };
}

async function saveSettings(req, input) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const before = await rulesOf(companyId, transaction);
    const next = { ...before, ...input };
    const limits = next.gradeLimits;
    if (limits.map((g) => g.grade).join() !== 'A,B,C') throw AppError.rule('GRADE_LIMITS', 'Give the limits of A, B and C in this order; anything above C is REJECT', { field: 'gradeLimits' });
    if (!(limits[0].maxPoints < limits[1].maxPoints && limits[1].maxPoints < limits[2].maxPoints)) throw AppError.rule('GRADE_LIMITS', 'The limits must grow: A below B, B below C', { field: 'gradeLimits' });
    if (new Set(next.pointTable.map((p) => p.key)).size !== next.pointTable.length) throw AppError.rule('POINT_TABLE', 'The same size is in the table twice', { field: 'pointTable' });
    await exec(`INSERT INTO inspection_settings ("companyId", "pointTable", "gradeLimits", basis, "maxPointsPerMeter", "updatedById")
      VALUES (:companyId, CAST(:pointTable AS jsonb), CAST(:gradeLimits AS jsonb), :basis, :cap, :userId)
      ON CONFLICT ("companyId") DO UPDATE SET "pointTable" = EXCLUDED."pointTable", "gradeLimits" = EXCLUDED."gradeLimits", basis = EXCLUDED.basis, "maxPointsPerMeter" = EXCLUDED."maxPointsPerMeter", "updatedById" = EXCLUDED."updatedById", "updatedAt" = now()`,
    { companyId, pointTable: JSON.stringify(next.pointTable), gradeLimits: JSON.stringify(limits), basis: next.basis, cap: next.maxPointsPerMeter, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'INSPECTION_SETTINGS_CHANGED', entityType: 'InspectionSettings', entityId: companyId, before, after: next }, { transaction });
  });
  return getSettings(req);
}

const typeJson = (t) => ({ id: t.id, code: t.code, name: t.name, fixedPoints: t.fixedPoints, isActive: t.isActive });
async function listDefectTypes(req, { all } = {}) {
  const rows = await q(`SELECT id, code, name, "fixedPoints", "isActive" FROM defect_types WHERE "companyId" = :companyId${all ? '' : ' AND "isActive"'} ORDER BY name`, { companyId: req.user.companyId });
  return { data: rows.map(typeJson) };
}

const duplicate = (e) => (e.original && e.original.code === '23505') || (e.parent && e.parent.code === '23505') || e.name === 'SequelizeUniqueConstraintError';

async function createDefectType(req, data) {
  try {
    const [row] = await q(`INSERT INTO defect_types ("companyId", code, name, "fixedPoints", "createdById") VALUES (:companyId, :code, :name, :fixedPoints, :userId) RETURNING id, code, name, "fixedPoints", "isActive"`,
      { companyId: req.user.companyId, code: data.code.toUpperCase(), name: data.name, fixedPoints: data.fixedPoints || null, userId: req.user.id });
    await audit.log(req, { action: 'DEFECT_TYPE_CREATED', entityType: 'DefectType', entityId: row.id, after: typeJson(row) });
    return typeJson(row);
  } catch (e) {
    if (duplicate(e)) throw AppError.rule('NAME_TAKEN', 'A defect with this name or code already exists');
    throw e;
  }
}

async function updateDefectType(req, id, changes) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      const [before] = await q('SELECT id, code, name, "fixedPoints", "isActive" FROM defect_types WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
      if (!before) throw AppError.notFound('Defect type');
      const next = { ...before, ...changes, code: (changes.code || before.code).toUpperCase() };
      await exec('UPDATE defect_types SET code = :code, name = :name, "fixedPoints" = :fixedPoints, "isActive" = :isActive, "updatedAt" = now() WHERE id = :id', { id, code: next.code, name: next.name, fixedPoints: next.fixedPoints || null, isActive: next.isActive }, transaction);
      await audit.log(req, { action: 'DEFECT_TYPE_UPDATED', entityType: 'DefectType', entityId: id, before: typeJson(before), after: typeJson(next) }, { transaction });
      return typeJson({ ...next, id });
    });
  } catch (e) {
    if (duplicate(e)) throw AppError.rule('NAME_TAKEN', 'A defect with this name or code already exists');
    throw e;
  }
}

/** A defect that was never found can be deleted; one that is on an inspection is switched off instead. */
async function removeDefectType(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const [t] = await q('SELECT id, name FROM defect_types WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
    if (!t) throw AppError.notFound('Defect type');
    const [used] = await q('SELECT 1 AS x FROM inspection_defects WHERE "defectTypeId" = :id LIMIT 1', { id }, transaction);
    if (used) throw AppError.rule('IN_USE', 'This defect is on an inspection; switch it off instead of deleting');
    await exec('DELETE FROM defect_types WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'DEFECT_TYPE_DELETED', entityType: 'DefectType', entityId: id, before: { name: t.name } }, { transaction });
  });
}

/** Adds the usual textile defects that the company does not have yet (nothing existing is changed). */
async function loadStandardDefects(req) {
  const { companyId } = req.user;
  let added = 0;
  await sequelize.transaction(async (transaction) => {
    const have = await q('SELECT lower(name) AS n, lower(code) AS c FROM defect_types WHERE "companyId" = :companyId', { companyId }, transaction);
    for (const d of rules4.STANDARD_DEFECTS) {
      if (have.some((h) => h.n === d.name.toLowerCase() || h.c === d.code.toLowerCase())) continue;
      await exec('INSERT INTO defect_types ("companyId", code, name, "fixedPoints", "createdById") VALUES (:companyId, :code, :name, :fixedPoints, :userId)', { companyId, ...d, userId: req.user.id }, transaction);
      added += 1;
    }
    if (added) await audit.log(req, { action: 'DEFECT_TYPES_STANDARD_LOADED', entityType: 'DefectType', entityId: companyId, after: { added } }, { transaction });
  });
  return { added, ...(await listDefectTypes(req, { all: true })) };
}

/* ---------------- the thaans that can be inspected ---------------- */

const GREY_SQL = `SELECT 'GREY' AS source, t.id AS "thaanId", gl.id AS "greyLotId", gl."lotNo", t."thaanNo", t.meters::float AS meters, COALESCE(t.width, gl.width)::float AS width,
    gl."customerId", cu.name AS "customerName", gl."qualityId", qu.name AS "qualityName", NULL::uuid AS "departmentId", NULL::text AS "departmentName", NULL::uuid AS "jobId", NULL::int AS "jobNo", NULL::int AS "soNo", NULL::text AS "operatorName", NULL::text AS machines
  FROM grey_lot_thaans t JOIN grey_lots gl ON gl.id = t."lotId" AND gl."companyId" = :companyId AND gl."deletedAt" IS NULL
  JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId"`;

const DEPT_SQL = `SELECT 'DEPARTMENT' AS source, t.id AS "thaanId", gl.id AS "greyLotId", gl."lotNo", t."thaanNo", t.meters::float AS meters, gl.width::float AS width,
    gl."customerId", cu.name AS "customerName", COALESCE(sc."qualityId", gl."qualityId") AS "qualityId", qu.name AS "qualityName", j."departmentId", svc_name(s.id, j."companyId", s.name) AS "departmentName",
    j.id AS "jobId", j."jobNo", sc."cardNo" AS "soNo", j."operatorName",
    (SELECT left(string_agg(DISTINCT m.name, ', '), 300) FROM machine_runs mr JOIN machines m ON m.id = mr."machineId" WHERE mr."jobId" = j.id) AS machines
  FROM job_item_thaans t JOIN job_items ji ON ji.id = t."jobItemId" JOIN jobs j ON j.id = ji."jobId" AND j."companyId" = :companyId AND j.status <> 'REJECTED'
  JOIN services s ON s.id = j."departmentId" JOIN so_cards sc ON sc.id = ji."soCardId" AND sc."companyId" = :companyId
  JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId" AND gl."companyId" = :companyId
  JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = COALESCE(sc."qualityId", gl."qualityId")
  WHERE t."companyId" = :companyId`;

/** The latest inspection of each of these thaans (a finished one counts; a draft is reported beside it). */
async function latestOf(companyId, thaanIds) {
  const out = new Map();
  if (!thaanIds.length) return out;
  const rows = await q(`SELECT id, "thaanId", "inspectionNo", status, grade, "pointsPer100"::float AS "pointsPer100", "finishedAt" FROM inspections
    WHERE "companyId" = :companyId AND "thaanId" IN (:thaanIds) AND "deletedAt" IS NULL ORDER BY "finishedAt" DESC NULLS LAST, "inspectionNo" DESC`, { companyId, thaanIds });
  for (const r of rows) {
    const x = out.get(r.thaanId) || { finished: null, draft: null };
    if (r.status === 'FINISHED' && !x.finished) x.finished = r;
    if (r.status === 'DRAFT' && !x.draft) x.draft = r;
    out.set(r.thaanId, x);
  }
  return out;
}

/** What Folding and Packing show next to a thaan: the grade of its latest finished inspection. */
const badge = (r) => ({ inspectionId: r.id, inspectionNo: r.inspectionNo, label: label(r.inspectionNo), grade: r.grade, pointsPer100: r.pointsPer100, suggestedFoldingGrade: FOLDING_OF[r.grade] || null });

/** Adds `inspection` to every line that has a thaan with a finished inspection (nothing is added to the others). */
async function attachGrades(companyId, lines, idKey = 'thaanId') {
  const latest = await latestOf(companyId, [...new Set(lines.map((l) => l[idKey]).filter(Boolean))]);
  for (const l of lines) {
    const x = l[idKey] && latest.get(l[idKey]);
    if (x && x.finished) l.inspection = badge(x.finished);
  }
}

/** GET /inspections/thaans?lotNo= : the thaans of one lot (grey ones, and what the departments made of it), each with its latest inspection. */
async function thaanPicker(req, { lotNo, source }) {
  const { companyId } = req.user;
  const rows = [
    ...(source === 'DEPARTMENT' ? [] : await q(`${GREY_SQL} WHERE gl."lotNo" = :lotNo ORDER BY t."thaanNo"`, { companyId, lotNo })),
    ...(source === 'GREY' ? [] : await q(`${DEPT_SQL} AND gl."lotNo" = :lotNo ORDER BY j."jobNo", t."thaanNo"`, { companyId, lotNo })),
  ];
  const latest = await latestOf(companyId, rows.map((r) => r.thaanId));
  return {
    lotNo,
    data: rows.map((r) => {
      const x = latest.get(r.thaanId) || {};
      return { ...r, latest: x.finished ? badge(x.finished) : null, draft: x.draft ? { inspectionId: x.draft.id, label: label(x.draft.inspectionNo) } : null };
    }),
  };
}

async function thaanOr404(companyId, source, thaanId, transaction) {
  const [t] = source === 'GREY'
    ? await q(`${GREY_SQL} WHERE t.id = :thaanId`, { companyId, thaanId }, transaction)
    : await q(`${DEPT_SQL} AND t.id = :thaanId`, { companyId, thaanId }, transaction);
  if (!t) throw AppError.notFound('Thaan');
  return t;
}

/* ---------------- inspections ---------------- */

const COLS = `i.*, to_char(i."inspectionDate", 'YYYY-MM-DD') AS "day", u.name AS "inspectorName", f.name AS "finishedByName", rb.name AS "reopenedByName",
  CASE WHEN i.source = 'GREY' THEN EXISTS (SELECT 1 FROM grey_lot_thaans x WHERE x.id = i."thaanId") ELSE EXISTS (SELECT 1 FROM job_item_thaans x WHERE x.id = i."thaanId") END AS "thaanExists"`;
const FROM = 'FROM inspections i LEFT JOIN users u ON u.id = i."inspectorId" LEFT JOIN users f ON f.id = i."finishedById" LEFT JOIN users rb ON rb.id = i."reopenedById"';

async function rowOr404(companyId, id, transaction, lock = false) {
  const [r] = await q(`SELECT ${COLS} ${FROM} WHERE i.id = :id AND i."companyId" = :companyId AND i."deletedAt" IS NULL${lock ? ' FOR UPDATE OF i' : ''}`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Inspection');
  return r;
}

const defectsOf = (id, transaction) => q(`SELECT d."lineNo", d."defectTypeId", t.code, t.name, d."atMeter"::float AS "atMeter", d."sizeClass", d.points, d.note
  FROM inspection_defects d JOIN defect_types t ON t.id = d."defectTypeId" WHERE d."inspectionId" = :id ORDER BY d."atMeter", d."lineNo"`, { id }, transaction);

const head = (r) => ({
  id: r.id, inspectionNo: r.inspectionNo, label: label(r.inspectionNo), inspectionDate: r.day, source: r.source, status: r.status, statusText: r.status === 'FINISHED' ? 'Finished' : 'Draft',
  thaanId: r.thaanId, thaanExists: r.thaanExists, lotNo: r.lotNo, greyLotId: r.greyLotId, thaanNo: r.thaanNo, meters: num(r.meters), widthInches: num(r.widthInches),
  customer: r.customerId ? { id: r.customerId, name: r.customerName } : null, quality: r.qualityId ? { id: r.qualityId, name: r.qualityName } : null,
  department: r.departmentId ? { id: r.departmentId, name: r.departmentName } : null, jobId: r.jobId, jobNo: r.jobNo, soNo: r.soNo, operatorName: r.operatorName, machines: r.machines,
  inspector: r.inspectorId ? { id: r.inspectorId, name: r.inspectorName } : null, remarks: r.remarks,
});

async function view(companyId, r, transaction) {
  const defects = await defectsOf(r.id, transaction);
  const done = r.status === 'FINISHED';
  // a finished one keeps the rules and figures it was finished with; a draft is worked out with today's rules (a preview)
  const rules = done ? r.rules : await rulesOf(companyId, transaction);
  const figures = done ? { rawPoints: r.rawPoints, totalPoints: r.totalPoints, pointsPer100: num(r.pointsPer100), grade: r.grade } : rules4.evaluate(rules, defects, num(r.meters), num(r.widthInches));
  return {
    ...head(r), ...figures, preview: !done, rules, defects, defectCount: defects.length, suggestedFoldingGrade: figures.grade ? FOLDING_OF[figures.grade] : null,
    finishedAt: iso(r.finishedAt), finishedBy: r.finishedAt ? { name: r.finishedByName } : null,
    reopened: r.reopenedAt ? { at: iso(r.reopenedAt), by: r.reopenedByName, reason: r.reopenReason } : null,
    canEdit: !done, canFinish: !done, canDelete: !done, canReopen: done,
  };
}

async function get(req, id) {
  return view(req.user.companyId, await rowOr404(req.user.companyId, id));
}

async function list(req, { page, limit, search, status, grade, lotNo, thaanNo, customerId, qualityId, departmentId, source, dateFrom, dateTo }) {
  const where = ['i."companyId" = :companyId', 'i."deletedAt" IS NULL'];
  const rep = { companyId: req.user.companyId };
  const add = (cond, key, value) => { if (value !== undefined && value !== '') { where.push(cond); rep[key] = value; } };
  add('i.status = :status', 'status', status); add('i.grade = :grade', 'grade', grade); add('i."lotNo" = :lotNo', 'lotNo', lotNo); add('i."thaanNo" = :thaanNo', 'thaanNo', thaanNo);
  add('i."customerId" = :customerId', 'customerId', customerId); add('i."qualityId" = :qualityId', 'qualityId', qualityId); add('i."departmentId" = :departmentId', 'departmentId', departmentId);
  add('i.source = :source', 'source', source); add('i."inspectionDate" >= :dateFrom', 'dateFrom', dateFrom); add('i."inspectionDate" <= :dateTo', 'dateTo', dateTo);
  if (search) {
    rep.like = `%${search.trim()}%`;
    const n = /^\d+$/.test(search.trim()) ? ' OR i."lotNo" = :n OR i."inspectionNo" = :n' : '';
    if (n) rep.n = Number(search.trim());
    where.push(`(i."customerName" ILIKE :like OR i."qualityName" ILIKE :like OR i."operatorName" ILIKE :like${n})`);
  }
  const w = where.join(' AND ');
  const [{ total }] = await q(`SELECT count(*)::int AS total FROM inspections i WHERE ${w}`, rep);
  const rows = await q(`SELECT ${COLS}, (SELECT count(*)::int FROM inspection_defects d WHERE d."inspectionId" = i.id) AS "defectCount" ${FROM} WHERE ${w} ORDER BY i."inspectionNo" DESC LIMIT :limit OFFSET :offset`, { ...rep, limit, offset: (page - 1) * limit });
  return {
    data: rows.map((r) => ({ ...head(r), defectCount: r.defectCount, totalPoints: r.totalPoints, pointsPer100: num(r.pointsPer100), grade: r.grade, finishedAt: iso(r.finishedAt) })),
    page, limit, total,
  };
}

const draftExists = (e) => duplicate(e) && JSON.stringify([e.original && e.original.constraint, e.parent && e.parent.constraint]).includes('inspections_one_draft');

/** Opens a new inspection of a thaan. One draft per thaan at a time. */
async function create(req, { source, thaanId, inspectionDate, widthInches, remarks }) {
  const { companyId } = req.user;
  try {
    const id = await sequelize.transaction(async (transaction) => {
      const t = await thaanOr404(companyId, source, thaanId, transaction);
      const [open] = await q('SELECT "inspectionNo" FROM inspections WHERE "companyId" = :companyId AND "thaanId" = :thaanId AND status = \'DRAFT\' AND "deletedAt" IS NULL', { companyId, thaanId }, transaction);
      if (open) throw AppError.rule('DRAFT_EXISTS', `This thaan already has the draft ${label(open.inspectionNo)}: finish or delete it first`);
      const no = await counters.take(companyId, COUNTER, async () => Number((await q('SELECT COALESCE(MAX("inspectionNo"), 0) + 1 AS n FROM inspections WHERE "companyId" = :companyId', { companyId }, transaction))[0].n), transaction);
      const [row] = await q(`INSERT INTO inspections ("companyId", "inspectionNo", "inspectionDate", source, "thaanId", "greyLotId", "lotNo", "thaanNo", meters, "widthInches", "customerId", "customerName", "qualityId", "qualityName",
          "departmentId", "departmentName", "jobId", "jobNo", "soNo", "operatorName", machines, "inspectorId", remarks)
        VALUES (:companyId, :no, :day, :source, :thaanId, :greyLotId, :lotNo, :thaanNo, :meters, :width, :customerId, :customerName, :qualityId, :qualityName,
          :departmentId, :departmentName, :jobId, :jobNo, :soNo, :operatorName, :machines, :userId, :remarks) RETURNING id`,
      { ...t, companyId, no, day: inspectionDate || today(), source, width: widthInches ?? t.width ?? null, userId: req.user.id, remarks: remarks || null }, transaction);
      await audit.log(req, { action: 'INSPECTION_CREATED', entityType: 'Inspection', entityId: row.id, after: { inspectionNo: no, lotNo: t.lotNo, thaanNo: t.thaanNo, source, meters: t.meters } }, { transaction });
      return row.id;
    });
    return get(req, id);
  } catch (e) {
    if (draftExists(e)) throw AppError.rule('DRAFT_EXISTS', 'This thaan already has a draft inspection');
    throw e;
  }
}

/** Locks a draft for a change (a finished one is refused). */
async function draftOf(companyId, id, transaction) {
  const r = await rowOr404(companyId, id, transaction, true);
  if (r.status === 'FINISHED') throw AppError.rule('INSPECTION_FINISHED', `${label(r.inspectionNo)} is finished: the client admin can reopen it`);
  return r;
}

async function update(req, id, { inspectionDate, widthInches, remarks }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const r = await draftOf(companyId, id, transaction);
    await exec('UPDATE inspections SET "inspectionDate" = :day, "widthInches" = :width, remarks = :remarks, "updatedAt" = now() WHERE id = :id',
      { id, day: inspectionDate || r.day, width: widthInches === undefined ? r.widthInches : widthInches, remarks: remarks === undefined ? r.remarks : (remarks || null) }, transaction);
    await audit.log(req, { action: 'INSPECTION_UPDATED', entityType: 'Inspection', entityId: id, before: { inspectionDate: r.day, widthInches: num(r.widthInches), remarks: r.remarks }, after: { inspectionDate, widthInches, remarks } }, { transaction });
  });
  return get(req, id);
}

/** PUT: the whole list of defects of a draft (replaced). The points are worked out here. */
async function setDefects(req, id, { defects }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const r = await draftOf(companyId, id, transaction);
    const meters = num(r.meters);
    const rules = await rulesOf(companyId, transaction);
    const ids = [...new Set(defects.map((d) => d.defectTypeId))];
    const types = new Map((ids.length ? await q('SELECT id, name, "fixedPoints", "isActive" FROM defect_types WHERE "companyId" = :companyId AND id IN (:ids)', { companyId, ids }, transaction) : []).map((t) => [t.id, t]));
    const rows = defects.map((d, i) => {
      const type = types.get(d.defectTypeId);
      if (!type) throw AppError.notFound('Defect type');
      if (!type.isActive) throw AppError.rule('DEFECT_INACTIVE', `${type.name} is switched off`, { line: i + 1 });
      if (d.atMeter > meters) throw AppError.rule('BEYOND_THAAN', `Line ${i + 1}: the thaan is ${meters} m long; a defect cannot be at ${d.atMeter} m`, { line: i + 1, field: 'atMeter', meters });
      const points = rules4.pointsOf(rules, type, d.sizeClass);
      if (points === null) throw AppError.rule('UNKNOWN_SIZE', `Line ${i + 1}: "${d.sizeClass}" is not a size of the point table`, { line: i + 1, field: 'sizeClass' });
      return { lineNo: i + 1, defectTypeId: d.defectTypeId, atMeter: d.atMeter, sizeClass: d.sizeClass, points, note: d.note || null };
    });
    await exec('DELETE FROM inspection_defects WHERE "inspectionId" = :id', { id }, transaction);
    for (const row of rows) {
      await exec('INSERT INTO inspection_defects ("inspectionId", "companyId", "lineNo", "defectTypeId", "atMeter", "sizeClass", points, note) VALUES (:id, :companyId, :lineNo, :defectTypeId, :atMeter, :sizeClass, :points, :note)', { id, companyId, ...row }, transaction);
    }
    await exec('UPDATE inspections SET "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'INSPECTION_DEFECTS_SAVED', entityType: 'Inspection', entityId: id, after: { defects: rows.length } }, { transaction });
  });
  return get(req, id);
}

/** FINISH: the points and the grade are fixed, with the rules of this moment. */
async function finish(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const r = await draftOf(companyId, id, transaction);
    const rules = await rulesOf(companyId, transaction);
    const stored = await defectsOf(id, transaction);
    const types = new Map((await q('SELECT id, "fixedPoints" FROM defect_types WHERE "companyId" = :companyId', { companyId }, transaction)).map((t) => [t.id, t]));
    // the points again, with the rules of the moment of finishing
    const defects = stored.map((d) => {
      const points = rules4.pointsOf(rules, types.get(d.defectTypeId), d.sizeClass);
      if (points === null) throw AppError.rule('UNKNOWN_SIZE', `A defect has the size "${d.sizeClass}" that is no longer in the point table: save the defects again`);
      return { ...d, points };
    });
    for (const d of defects) await exec('UPDATE inspection_defects SET points = :points WHERE "inspectionId" = :id AND "lineNo" = :lineNo', { id, lineNo: d.lineNo, points: d.points }, transaction);
    const f = rules4.evaluate(rules, defects, num(r.meters), num(r.widthInches));
    if (f.pointsPer100 === null) throw AppError.rule('WIDTH_REQUIRED', 'The company counts per square yard: give the width of the cloth in inches', { field: 'widthInches' });
    await exec(`UPDATE inspections SET status = 'FINISHED', "totalPoints" = :totalPoints, "rawPoints" = :rawPoints, "pointsPer100" = :pointsPer100, grade = :grade, rules = CAST(:rules AS jsonb),
      "finishedAt" = now(), "finishedById" = :userId, "updatedAt" = now() WHERE id = :id`, { id, ...f, rules: JSON.stringify(rules), userId: req.user.id }, transaction);
    await audit.log(req, { action: 'INSPECTION_FINISHED', entityType: 'Inspection', entityId: id, after: { inspectionNo: r.inspectionNo, ...f, defects: defects.length } }, { transaction });
  });
  return get(req, id);
}

/** REOPEN (client admin, with a reason): back to draft. */
async function reopen(req, id, { reason }) {
  const { companyId } = req.user;
  try {
    await sequelize.transaction(async (transaction) => {
      const r = await rowOr404(companyId, id, transaction, true);
      if (r.status !== 'FINISHED') throw AppError.rule('NOT_FINISHED', 'Only a finished inspection can be reopened');
      await exec(`UPDATE inspections SET status = 'DRAFT', "totalPoints" = NULL, "rawPoints" = NULL, "pointsPer100" = NULL, grade = NULL, rules = NULL, "finishedAt" = NULL, "finishedById" = NULL,
        "reopenedAt" = now(), "reopenedById" = :userId, "reopenReason" = :reason, "updatedAt" = now() WHERE id = :id`, { id, userId: req.user.id, reason }, transaction);
      await audit.log(req, { action: 'INSPECTION_REOPENED', entityType: 'Inspection', entityId: id, before: { grade: r.grade, pointsPer100: num(r.pointsPer100), totalPoints: r.totalPoints }, after: { reason } }, { transaction });
    });
  } catch (e) {
    if (draftExists(e)) throw AppError.rule('DRAFT_EXISTS', 'This thaan already has another draft inspection: finish or delete that one first');
    throw e;
  }
  return get(req, id);
}

/** Only a draft is deleted, with a reason; it stays in the database and its number is never used again. */
async function remove(req, id, reason) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const r = await draftOf(companyId, id, transaction);
    await exec('UPDATE inspections SET "deletedAt" = now(), "deletedById" = :userId, "deleteReason" = :reason WHERE id = :id', { id, userId: req.user.id, reason }, transaction);
    await audit.log(req, { action: 'INSPECTION_DELETED', entityType: 'Inspection', entityId: id, before: { inspectionNo: r.inspectionNo, lotNo: r.lotNo, thaanNo: r.thaanNo }, after: { reason } }, { transaction });
  });
}

module.exports = {
  getSettings, saveSettings, listDefectTypes, createDefectType, updateDefectType, removeDefectType, loadStandardDefects, thaanPicker, list, get, create, update, setDefects, finish, reopen, remove, attachGrades, latestOf,
};
