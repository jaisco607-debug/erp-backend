// Weaving > Yarn Stock. One row per item card AND lbs per bag (the bags of one row all weigh the same): what came in, what went out, the balance.
//   inward  = the yarn inward entries (not deleted);  outward = the lines of the yarn outward challans (not deleted: weft now, sale and sizing later);  balance = inward - outward.
//   PURCHASE yarn (from vendors) and OVERHEAD yarn (the customers' own) are both in the stock; `type` shows one kind only.
const { sequelize } = require('../models');

const f2 = (v) => Math.round(Number(v || 0) * 100) / 100;

async function list(req, { search, yarnCountId, brandId, itemId, type, dateTo, showZero }) {
  const rep = { companyId: req.user.companyId };
  const where = ['i."companyId" = :companyId', 'i."deletedAt" IS NULL'];
  if (type === 'PURCHASE') where.push('i."vendorId" IS NOT NULL');
  if (type === 'OVERHEAD') where.push('i."customerId" IS NOT NULL');
  if (itemId) { where.push('i."itemId" = :itemId'); rep.itemId = itemId; }
  if (yarnCountId) { where.push('yi."yarnCountId" = :yarnCountId'); rep.yarnCountId = yarnCountId; }
  if (brandId) { where.push('yi."brandId" = :brandId'); rep.brandId = brandId; }
  if (dateTo) { where.push('i."inwardDate" <= :dateTo'); rep.dateTo = dateTo; }
  if (search) { where.push('(yc.name ILIKE :like OR yb.name ILIKE :like)'); rep.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; }
  const dateOut = dateTo ? ' AND o."outwardDate" <= :dateTo' : '';
  const dateBack = dateTo ? ' AND sr."returnDate" <= :dateTo' : '';
  const rows = await sequelize.query(`
    SELECT yi.id AS "itemId", yi.code AS "itemCode", yc.id AS "yarnCountId", yc.name AS "yarnCount", yb.id AS "brandId", yb.name AS brand, yi.packing, yi.bags AS "cardBags",
           i."lbsPerBag"::float AS "lbsPerBag", SUM(i.bags)::int AS "inwardBags", SUM(i."totalLbs")::float AS "inwardLbs",
           (COALESCE(SUM(x.bags), 0) - COALESCE(SUM(rt.bags), 0))::int AS "outwardBags", (COALESCE(SUM(x.lbs), 0) - COALESCE(SUM(rt.lbs), 0))::float AS "outwardLbs"
    FROM yarn_inwards i
    LEFT JOIN LATERAL (SELECT SUM(l.bags) AS bags, SUM(l.lbs) AS lbs FROM yarn_outward_lines l JOIN yarn_outwards o ON o.id = l."outwardId" AND o."deletedAt" IS NULL${dateOut} WHERE l."inwardId" = i.id) x ON true
    LEFT JOIN LATERAL (SELECT SUM(ry.bags) AS bags, SUM(ry.lbs) AS lbs FROM sizing_return_yarns ry JOIN sizing_returns sr ON sr.id = ry."returnId"${dateBack} WHERE ry."inwardId" = i.id) rt ON true JOIN yarn_items yi ON yi.id = i."itemId" JOIN yarn_counts yc ON yc.id = yi."yarnCountId" JOIN yarn_brands yb ON yb.id = yi."brandId"
    WHERE ${where.join(' AND ')}
    GROUP BY yi.id, yi.code, yc.id, yc.name, yb.id, yb.name, yi.packing, yi.bags, i."lbsPerBag"
    ORDER BY yc.name, yb.name, yi.packing, i."lbsPerBag"`, { replacements: rep, type: sequelize.QueryTypes.SELECT });
  const data = rows.map((r) => {
    const { outwardBags } = r;
    const outwardLbs = f2(r.outwardLbs);
    return {
      itemId: r.itemId, itemCode: r.itemCode,
      name: `${r.yarnCount} - ${r.brand} - ${r.packing} - ${r.cardBags}`,
      yarnCount: { id: r.yarnCountId, name: r.yarnCount }, brand: { id: r.brandId, name: r.brand }, packing: r.packing, lbsPerBag: r.lbsPerBag,
      inwardBags: r.inwardBags, inwardLbs: f2(r.inwardLbs), outwardBags, outwardLbs,
      balanceBags: r.inwardBags - outwardBags, balanceLbs: f2(r.inwardLbs - outwardLbs),
    };
  }).filter((r) => showZero || r.balanceBags !== 0 || r.balanceLbs !== 0);
  const sum = (k) => data.reduce((t, r) => t + r[k], 0);
  return {
    data,
    totals: { inwardBags: sum('inwardBags'), inwardLbs: f2(sum('inwardLbs')), outwardBags: sum('outwardBags'), outwardLbs: f2(sum('outwardLbs')), balanceBags: sum('balanceBags'), balanceLbs: f2(sum('balanceLbs')) },
    total: data.length,
  };
}

module.exports = { list };
