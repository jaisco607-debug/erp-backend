// Weaving > Beam Stock. Every active beam is in one place: EMPTY, FULL, AT_LOOM or AT_SIZING (yarn_beams.status, since yarn_beams.statusDate).
//   summary  the count of each place and the total
//   details  the beams of one place (click on a count): number, name, date, and since when they are there (the day they went to sizing, for AT_SIZING)
// Switched-off and deleted beams are not in the stock.
const { Op } = require('sequelize');
const { sequelize, YarnBeam } = require('../models');
const { STATUSES, STATUS_TEXT } = require('../models/YarnBeam');
const { today } = require('../utils/dates');

const days = (from, to) => Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));

async function summary(req) {
  const rows = await sequelize.query('SELECT status, count(*)::int AS n FROM yarn_beams WHERE "companyId" = :companyId AND "isActive" AND "deletedAt" IS NULL GROUP BY status',
    { replacements: { companyId: req.user.companyId }, type: sequelize.QueryTypes.SELECT });
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const statuses = STATUSES.map((s) => ({ status: s, text: STATUS_TEXT[s], count: by[s] || 0 }));
  return { total: statuses.reduce((t, s) => t + s.count, 0), statuses, asOf: today() };
}

async function details(req, status, { search }) {
  const where = { companyId: req.user.companyId, isActive: true, status };
  if (search) {
    const or = [{ name: { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` } }];
    if (/^\d+$/.test(search)) or.push({ beamNo: Number(search) });
    where[Op.or] = or;
  }
  const rows = await YarnBeam.findAll({ where, order: [['statusDate', 'ASC'], ['beamNo', 'ASC']] });
  const now = today();
  // beams at sizing: the challan they went on and the party
  const sent = new Map();
  if (status === 'AT_SIZING' && rows.length) {
    const ch = await sequelize.query(`SELECT x."beamId", o.id, o."challanNo", COALESCE(v.name, '') AS party FROM yarn_outward_beams x JOIN yarn_outwards o ON o.id = x."outwardId" AND o."deletedAt" IS NULL LEFT JOIN vendors v ON v.id = o."vendorId" WHERE x."beamId" IN (:ids) AND NOT EXISTS (SELECT 1 FROM yarn_sizing_inward_beams ib JOIN yarn_sizing_inwards i ON i.id = ib."inwardId" AND i."deletedAt" IS NULL WHERE ib."beamId" = x."beamId" AND i."outwardId" = x."outwardId")`,
      { replacements: { ids: rows.map((b) => b.id) }, type: sequelize.QueryTypes.SELECT });
    for (const r of ch) sent.set(r.beamId, { challanId: r.id, challanNo: r.challanNo, challanText: String(r.challanNo).padStart(5, '0'), partyName: r.party });
  }
  return {
    status, text: STATUS_TEXT[status], count: rows.length,
    data: rows.map((b) => ({ id: b.id, beamNo: b.beamNo, beamLabel: String(b.beamNo).padStart(5, '0'), name: b.name, beamDate: b.beamDate, status: b.status, statusText: STATUS_TEXT[b.status], statusDate: b.statusDate, meters: b.meters == null ? null : Number(b.meters), daysInStatus: days(b.statusDate, now), ...(status === 'AT_SIZING' ? { sizing: sent.get(b.id) || null } : {}) })),
  };
}

module.exports = { summary, details };
