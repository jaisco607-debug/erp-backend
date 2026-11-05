// The Store Management overview (one call for the whole screen): per store the last months of inwards and outwards, the stock position,
// the top vendors and the drafts waiting. Only the stores the person has a service for (Chemical Store / General Store) are answered.
// A few aggregated queries for all stores together, run side by side; money is returned as strings with 2 decimals.
//   inwards   approved store inwards by inward date; amount = billed (amount + sales tax)
//   outwards  the approved issues to departments (store moves of kind ISSUE) at the stock rate; the General Store has no outwards yet, so it is zero
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { today } = require('../utils/dates');
const { companyServices, userServices } = require('./accessService');

const STORES = [
  { store: 'CHEMICAL', service: 'CHEMICAL_STORE', name: 'Chemical Store' },
  { store: 'GENERAL', service: 'GENERAL_STORE', name: 'General Store' },
];
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** ['2026-05', ... '2026-10'] oldest -> newest, `months` of them ending with the month of `day` (YYYY-MM-DD, Pakistan date). */
function monthsBack(day, months) {
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7));
  const out = [];
  for (let i = 0; i < months; i += 1) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
const nextMonthStart = (month) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

async function overview(req, { months = 6 } = {}) {
  const asOf = today();
  const { companyId, userType } = req.user;
  if (!companyId) return { asOf, stores: [] };
  const have = new Set((await companyServices(companyId)).map((s) => s.code));
  const own = userType === 'CLIENT_ADMIN' ? null : new Set((await userServices(req.user)).map((g) => g.service.code));
  const allowed = STORES.filter((s) => have.has(s.service) && (!own || own.has(s.service)));
  if (!allowed.length) return { asOf, stores: [] };

  const keys = allowed.map((s) => s.store);
  const list = monthsBack(asOf, months);
  const r = { companyId, stores: keys, from: `${list[0]}-01`, to: nextMonthStart(list[list.length - 1]) };
  const inwardWhere = 'i."companyId" = :companyId AND i.store IN (:stores) AND i."isApproved" AND i."inwardDate" >= :from AND i."inwardDate" < :to';
  const [inwards, issues, stock, categories, vendors, draftInwards, pending] = await Promise.all([
    q(`SELECT i.store, to_char(i."inwardDate", 'YYYY-MM') AS month, round(SUM(i.amount + i."salesTax"), 2)::text AS amount, count(*)::int AS n
       FROM store_inwards i WHERE ${inwardWhere} GROUP BY i.store, month`, r),
    q(`SELECT mv.store, to_char(mv."moveDate", 'YYYY-MM') AS month, round(-SUM(mv.value), 2)::text AS amount, count(DISTINCT COALESCE(mv."requestId", mv.id))::int AS n
       FROM store_moves mv WHERE mv."companyId" = :companyId AND mv.store IN (:stores) AND mv.kind = 'ISSUE' AND mv."moveDate" >= :from AND mv."moveDate" < :to GROUP BY mv.store, month`, r),
    q(`SELECT it.store, round(COALESCE(SUM(it."stockValue"), 0), 2)::text AS value, count(*) FILTER (WHERE it."stockQty" > 0)::int AS items,
         count(*) FILTER (WHERE it."isActive" AND it."stockQty" > 0 AND it."reorderLevel" IS NOT NULL AND it."stockQty" <= it."reorderLevel")::int AS low,
         count(*) FILTER (WHERE it."isActive" AND it."stockQty" <= 0)::int AS out
       FROM store_items it WHERE it."companyId" = :companyId AND it.store IN (:stores) GROUP BY it.store`, r),
    q(`SELECT it.store, COALESCE(c.name, 'No category') AS category, round(SUM(it."stockValue"), 2)::text AS value, count(*) FILTER (WHERE it."stockQty" > 0)::int AS items
       FROM store_items it LEFT JOIN store_categories c ON c.id = it."categoryId" WHERE it."companyId" = :companyId AND it.store IN (:stores)
       GROUP BY it.store, c.id, c.name HAVING SUM(it."stockValue") > 0 ORDER BY it.store, SUM(it."stockValue") DESC`, r),
    q(`SELECT * FROM (SELECT i.store, v.id AS "vendorId", v.name, round(SUM(i.amount + i."salesTax"), 2)::text AS amount, count(*)::int AS n,
         row_number() OVER (PARTITION BY i.store ORDER BY SUM(i.amount + i."salesTax") DESC, v.name) AS rn
       FROM store_inwards i JOIN vendors v ON v.id = i."vendorId" WHERE ${inwardWhere} GROUP BY i.store, v.id, v.name) t WHERE rn <= 5 ORDER BY store, rn`, r),
    q('SELECT i.store, count(*)::int AS n FROM store_inwards i WHERE i."companyId" = :companyId AND i.store IN (:stores) AND NOT i."isApproved" GROUP BY i.store', r),
    // chemical requests the store has not sent yet (Queue and Process): the outwards still waiting
    keys.includes('CHEMICAL') ? q('SELECT count(*)::int AS n FROM chemical_requests WHERE "companyId" = :companyId AND status IN (\'PENDING\', \'ACCEPTED\')', r) : [],
  ]);

  const pick = (rows, store) => rows.filter((x) => x.store === store);
  return {
    asOf,
    stores: allowed.map(({ store, name }) => {
      const inn = new Map(pick(inwards, store).map((x) => [x.month, x]));
      const out = new Map(pick(issues, store).map((x) => [x.month, x]));
      const s = pick(stock, store)[0] || { value: '0.00', items: 0, low: 0, out: 0 };
      return {
        store, name,
        series: list.map((month) => ({
          month,
          inwardsAmount: inn.has(month) ? inn.get(month).amount : '0.00', inwardsCount: inn.has(month) ? inn.get(month).n : 0,
          outwardsAmount: out.has(month) ? out.get(month).amount : '0.00', outwardsCount: out.has(month) ? out.get(month).n : 0,
        })),
        stock: {
          value: s.value, itemCount: s.items, lowCount: s.low, outCount: s.out,
          byCategory: pick(categories, store).map((c) => ({ category: c.category, value: c.value, items: c.items })),
        },
        topVendors: pick(vendors, store).map((v) => ({ vendorId: v.vendorId, name: v.name, amount: v.amount, count: v.n })),
        drafts: { inwards: (pick(draftInwards, store)[0] || { n: 0 }).n, outwards: store === 'CHEMICAL' ? (pending[0] || { n: 0 }).n : 0 },
      };
    }),
  };
}

module.exports = { overview, monthsBack };
