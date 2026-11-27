// Inspection summary (owner plan N-B1): the grade split, the top defects, by quality, and by department / operator. Read only.
// Only FINISHED inspections count, and of a thaan inspected again only the latest one (owner: "the latest one counts").
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('./accessService');
const { _x } = require('./reportService');
const { GRADES } = require('../utils/fourPoint');

const { q, round, col, section, respond } = _x;
const ROW_CAP = 50000;
const GRADE_TEXT = { A: 'A', B: 'B', C: 'C', REJECT: 'Reject' };

async function needAccess(req) {
  const { user } = req;
  if (!user || !user.companyId) throw AppError.forbidden();
  const have = user.userType === 'CLIENT_ADMIN' ? await companyServices(user.companyId) : (await userServices(user)).map((g) => g.service);
  if (!have.some((s) => s.code === 'INSPECTION')) throw AppError.forbidden('You do not have the Fabric Inspection service');
}

async function summary(req, f) {
  await needAccess(req);
  const where = [];
  const rep = { companyId: req.user.companyId, cap: ROW_CAP + 1 };
  const add = (cond, key, value) => { if (value) { where.push(cond); rep[key] = value; } };
  add('x."inspectionDate" >= :dateFrom', 'dateFrom', f.dateFrom); add('x."inspectionDate" <= :dateTo', 'dateTo', f.dateTo);
  add('x."customerId" = :customerId', 'customerId', f.customerId); add('x."qualityId" = :qualityId', 'qualityId', f.qualityId); add('x."departmentId" = :departmentId', 'departmentId', f.departmentId);
  const rows = await q(`
    SELECT x.* FROM (
      SELECT DISTINCT ON (i."thaanId") i.id, i."thaanId", i."inspectionDate", i."customerId", i."qualityId", i."qualityName", i."departmentId", i."departmentName", i."operatorName", i.machines,
             i.meters::float AS meters, i."totalPoints", i."pointsPer100"::float AS "pointsPer100", i.grade
      FROM inspections i WHERE i."companyId" = :companyId AND i.status = 'FINISHED' AND i."deletedAt" IS NULL ORDER BY i."thaanId", i."finishedAt" DESC
    ) x ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT :cap`, rep);
  if (rows.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', 'Too many inspections: choose a shorter period or a filter', { cap: ROW_CAP });

  const totalMeters = rows.reduce((t, r) => t + r.meters, 0);
  const pct = (part, whole) => (whole ? round((part / whole) * 100, 2) : 0);
  // the average of points per 100 is weighted by the meters of each thaan
  const avg = (list) => { const m = list.reduce((t, r) => t + r.meters, 0); return m ? round(list.reduce((t, r) => t + r.pointsPer100 * r.meters, 0) / m, 2) : 0; };

  const grades = GRADES.map((g) => {
    const mine = rows.filter((r) => r.grade === g);
    return { grade: GRADE_TEXT[g], thaans: mine.length, meters: round(mine.reduce((t, r) => t + r.meters, 0)), thaanPercent: pct(mine.length, rows.length), meterPercent: pct(mine.reduce((t, r) => t + r.meters, 0), totalMeters) };
  });

  const ids = rows.map((r) => r.id);
  const defects = ids.length ? await q(`SELECT t.name AS defect, count(*)::int AS count, SUM(d.points)::int AS points, count(DISTINCT d."inspectionId")::int AS thaans
    FROM inspection_defects d JOIN defect_types t ON t.id = d."defectTypeId" WHERE d."companyId" = :companyId AND d."inspectionId" IN (:ids) GROUP BY t.name ORDER BY points DESC, count DESC, t.name`, { companyId: req.user.companyId, ids }) : [];
  const allPoints = defects.reduce((t, d) => t + d.points, 0);
  const defectRows = defects.map((d) => ({ ...d, pointPercent: pct(d.points, allPoints) }));

  const grouped = (keyOf, labelOf) => {
    const m = new Map();
    for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.values()].map((list) => ({
      ...labelOf(list[0]), thaans: list.length, meters: round(list.reduce((t, r) => t + r.meters, 0)), points: list.reduce((t, r) => t + r.totalPoints, 0), avgPointsPer100: avg(list),
      gradeA: list.filter((r) => r.grade === 'A').length, gradeB: list.filter((r) => r.grade === 'B').length, gradeC: list.filter((r) => r.grade === 'C').length, reject: list.filter((r) => r.grade === 'REJECT').length,
    })).sort((a, b) => b.avgPointsPer100 - a.avgPointsPer100);
  };
  const qualities = grouped((r) => r.qualityId || 'none', (r) => ({ quality: r.qualityName || 'No quality' }));
  const makers = grouped((r) => `${r.departmentId || 'grey'}|${r.operatorName || ''}|${r.machines || ''}`, (r) => ({ department: r.departmentName || 'Grey cloth', operator: r.operatorName || '', machines: r.machines || '' }));

  const split = (...keys) => keys.map(([k, t, type = 'number']) => col(k, t, type));
  const counts = split(['thaans', 'Thaans'], ['meters', 'Meters'], ['points', 'Points'], ['avgPointsPer100', 'Points / 100'], ['gradeA', 'A'], ['gradeB', 'B'], ['gradeC', 'C'], ['reject', 'Reject']);
  const sections = [
    section('grades', 'Grade split', [col('grade', 'Grade', 'tag'), ...split(['thaans', 'Thaans'], ['thaanPercent', 'Thaans %'], ['meters', 'Meters'], ['meterPercent', 'Meters %'])], grades, ['thaans', 'meters']),
    section('defects', 'Top defects', [col('defect', 'Defect'), ...split(['count', 'Times'], ['thaans', 'Thaans'], ['points', 'Points'], ['pointPercent', 'Points %'])], defectRows, ['count', 'points']),
    section('qualities', 'By quality', [col('quality', 'Quality'), ...counts], qualities, ['thaans', 'meters', 'points']),
    section('makers', 'By department, operator and machine', [col('department', 'Department'), col('operator', 'Operator'), col('machines', 'Machines'), ...counts], makers, ['thaans', 'meters', 'points']),
  ];
  const out = respond('Fabric inspection summary', f, sections, f);
  out.total = rows.length;
  out.overall = { thaans: rows.length, meters: round(totalMeters), avgPointsPer100: avg(rows) };
  return out;
}

module.exports = { summary };
