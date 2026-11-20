// Weaving > Beam Stock. Every active beam is in one place: EMPTY, FULL, AT_LOOM or AT_SIZING (yarn_beams.status, since yarn_beams.statusDate).
//   summary  the count of each place and the total
//   details  the beams of one place (click on a count): number, name, date, and since when they are there (the day they went to sizing, for AT_SIZING)
// Switched-off and deleted beams are not in the stock.
const { Op } = require('sequelize');
const { sequelize, YarnBeam, WeavingDepartment } = require('../models');
const { STATUSES, STATUS_TEXT } = require('../models/YarnBeam');
const { today } = require('../utils/dates');

const days = (from, to) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));

const kg = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * The count of each place, the total and the weight (kg, of the beams that have one), and the same per DEPARTMENT:
 *   departments: [{ department: { id, code, name } | null (beams with no department), total, weightKg, statuses: [{ status, text, count, weightKg }] }]
 * Every switched-on department is listed (also with 0 beams); a switched-off one only while it has beams.
 */
async function summary(req) {
  const companyId = req.user.companyId;
  const rows = await sequelize.query('SELECT status, "departmentId", count(*)::int AS n, COALESCE(SUM("weightKg"), 0)::float AS kg FROM yarn_beams WHERE "companyId" = :companyId AND "isActive" AND "deletedAt" IS NULL GROUP BY status, "departmentId"',
    { replacements: { companyId }, type: sequelize.QueryTypes.SELECT });
  const places = (list) => STATUSES.map((s) => ({ status: s, text: STATUS_TEXT[s], count: list.filter((r) => r.status === s).reduce((t, r) => t + r.n, 0), weightKg: kg(list.filter((r) => r.status === s).reduce((t, r) => t + r.kg, 0)) }));
  const statuses = places(rows);
  const depts = await sequelize.query('SELECT id, code, name, "isActive" FROM weaving_departments WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY name', { replacements: { companyId }, type: sequelize.QueryTypes.SELECT });
  const known = new Set(depts.map((d) => d.id));
  // a deleted department that still has beams cannot exist (it cannot be deleted while it has beams), so every beam with a department is under a listed one
  const each = depts.map((d) => {
    const mine = rows.filter((r) => r.departmentId === d.id);
    const st = places(mine);
    return { department: { id: d.id, code: d.code, name: d.name }, isActive: d.isActive, total: st.reduce((t, s) => t + s.count, 0), weightKg: kg(st.reduce((t, s) => t + s.weightKg, 0)), statuses: st };
  }).filter((d) => d.isActive || d.total > 0);
  const none = rows.filter((r) => !r.departmentId || !known.has(r.departmentId));
  if (none.length) {
    const st = places(none);
    each.push({ department: null, isActive: true, total: st.reduce((t, s) => t + s.count, 0), weightKg: kg(st.reduce((t, s) => t + s.weightKg, 0)), statuses: st });
  }
  return { total: statuses.reduce((t, s) => t + s.count, 0), totalWeightKg: kg(statuses.reduce((t, s) => t + s.weightKg, 0)), statuses, departments: each, asOf: today() };
}

async function details(req, status, { search, departmentId, noDepartment }) {
  const where = { companyId: req.user.companyId, isActive: true, status };
  if (departmentId) where.departmentId = departmentId;
  if (noDepartment) where.departmentId = null;
  if (search) {
    const or = [{ name: { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` } }];
    if (/^\d+$/.test(search)) or.push({ beamNo: Number(search) });
    where[Op.or] = or;
  }
  const rows = await YarnBeam.findAll({ where, include: [{ model: WeavingDepartment, as: 'department', required: false, paranoid: false }], order: [['statusDate', 'ASC'], ['beamNo', 'ASC']] });
  const now = today();
  // beams at sizing: the challan they went on and the party
  const sent = new Map();
  if (status === 'AT_SIZING' && rows.length) {
    const ch = await sequelize.query(`SELECT x."beamId", o.id, o."challanNo", COALESCE(v.name, '') AS party FROM yarn_outward_beams x JOIN yarn_outwards o ON o.id = x."outwardId" AND o."deletedAt" IS NULL LEFT JOIN vendors v ON v.id = o."vendorId" WHERE x."beamId" IN (:ids) AND NOT EXISTS (SELECT 1 FROM yarn_sizing_inward_beams ib JOIN yarn_sizing_inwards i ON i.id = ib."inwardId" AND i."deletedAt" IS NULL WHERE ib."beamId" = x."beamId" AND i."outwardId" = x."outwardId")`,
      { replacements: { ids: rows.map((b) => b.id) }, type: sequelize.QueryTypes.SELECT });
    for (const r of ch) sent.set(r.beamId, { challanId: r.id, challanNo: r.challanNo, challanText: String(r.challanNo).padStart(5, '0'), partyName: r.party });
  }
  return {
    status, text: STATUS_TEXT[status], count: rows.length, weightKg: kg(rows.reduce((t, b) => t + (Number(b.weightKg) || 0), 0)),
    data: rows.map((b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: String(b.beamNo).padStart(5, '0'), name: b.name, beamDate: b.beamDate, status: b.status, statusText: STATUS_TEXT[b.status], statusDate: b.statusDate, meters: b.meters == null ? null : Number(b.meters), halfCut: b.halfCutM != null, halfCutM: b.halfCutM == null ? null : Number(b.halfCutM), weightKg: b.weightKg == null ? null : Number(b.weightKg), department: b.department ? { id: b.department.id, code: b.department.code, name: b.department.name } : null, daysInStatus: days(b.statusDate, now), ...(status === 'AT_SIZING' ? { sizing: sent.get(b.id) || null } : {}) })),
  };
}

module.exports = { summary, details };
