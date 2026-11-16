// How many bags of yarn inward entries went out already (lines of outwards that are not deleted).
const { sequelize } = require('../models');

/** Map inwardId -> bags out. `excludeOutwardId`: leave one challan out (when it is being changed). */
async function usedBags(ids, { transaction, excludeOutwardId } = {}) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sequelize.query(`SELECT l."inwardId", SUM(l.bags)::int AS bags FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" AND o."deletedAt" IS NULL
    WHERE l."inwardId" IN (:ids)${excludeOutwardId ? ' AND o.id <> :ex' : ''} GROUP BY l."inwardId"`,
  { replacements: { ids, ex: excludeOutwardId }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const r of rows) map.set(r.inwardId, r.bags);
  return map;
}

module.exports = { usedBags };
